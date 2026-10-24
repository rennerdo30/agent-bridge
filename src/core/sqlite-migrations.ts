import { admissionSqliteBusy, storageAdmissionRemaining, storageAdmissionTimeout } from "./storage-admission.js";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { backupPath, retainBackups } from "./json-store.js";
import type { Logger } from "./logger.js";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite-maintenance.js";
import { migrationLock } from "./migration-lock.js";
import { assertStoreUpgrade } from "./store-compatibility.js";
import { assertCompatibleMailboxReaders, hasMaintenanceExclusion, maintenanceLock, withMaintenanceExclusion } from "./storage-lock.js";
import { offlineMetadataAdmitted } from "./mailbox-layout.js";

export interface SqliteMigration { version: number; sql: string; backupTables?: readonly string[] }
const MAX_SNAPSHOT_ATTEMPTS = 10;

/** Additive migrations may explicitly preserve only the metadata they read/change.
 * These protected snapshots are labeled separately and never offered as full DB restores.
 */
function metadataSnapshot(db: DatabaseSync, path: string, tables: string[], version: number, target: number): void {
  storageAdmissionRemaining();
  const snapshot = new DatabaseSync(path);
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const digest = (row: Record<string, unknown>) => JSON.stringify(row, (_, value) => typeof value === "bigint" ? { bigint: String(value) } : value);
  try {
  const manifest: { version: number; kind: string; sourceVersion: number; targetVersion: number; schema: unknown[]; tables: { name: string; rows: number; sha256: string }[] } = {
    version: 1, kind: "sqlite-migration-metadata", sourceVersion: version, targetVersion: target,
    schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(), tables: [],
  };
    storageAdmissionRemaining(); snapshot.exec("BEGIN");
    for (const table of tables) {
      storageAdmissionRemaining();
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!schema || typeof schema.sql !== "string") throw new Error(`Missing migration snapshot table: ${table}`);
      storageAdmissionRemaining(); snapshot.exec(schema.sql);
      const source = db.prepare(`SELECT rowid AS __migration_rowid__, * FROM ${quote(table)} ORDER BY rowid`);
      source.setReadBigInts(true);
      const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => String(row.name));
      const insert = snapshot.prepare(`INSERT INTO ${quote(table)} (rowid,${columns.map(quote).join(",")}) VALUES (${["rowid", ...columns].map(() => "?").join(",")})`);
      const expected = createHash("sha256");
      let rows = 0;
      for (const row of source.iterate()) {
        storageAdmissionRemaining();
        insert.run(row.__migration_rowid__!, ...columns.map(name => row[name]!));
        expected.update(digest(row)); rows++;
      }
      const actual = createHash("sha256");
      storageAdmissionRemaining(); const verify = snapshot.prepare(`SELECT rowid AS __migration_rowid__, * FROM ${quote(table)} ORDER BY rowid`);
      verify.setReadBigInts(true);
      let verified = 0;
      for (const row of verify.iterate()) { storageAdmissionRemaining(); actual.update(digest(row)); verified++; }
      const sha256 = expected.digest("hex");
      if (rows !== verified || actual.digest("hex") !== sha256) throw new Error(`Migration metadata snapshot verification failed: ${table}`);
      manifest.tables.push({ name: table, rows, sha256 });
    }
    storageAdmissionRemaining(); snapshot.exec(`PRAGMA user_version=${version}`);
    storageAdmissionRemaining(); snapshot.exec("COMMIT");
    storageAdmissionRemaining(); if (snapshot.prepare("PRAGMA integrity_check").all().some(row => row.integrity_check !== "ok")) throw new Error(`Invalid metadata migration snapshot: ${path}`);
    storageAdmissionRemaining(); writeFileSync(`${path}.manifest.json`, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const manifestFile = openSync(`${path}.manifest.json`, "r+");
    try { fsyncSync(manifestFile); } finally { closeSync(manifestFile); }
  } finally { snapshot.close(); }
}

/** Every change is versioned. Keep the writer lock through recovery from the pre-migration backup. */
export function migrateSqlite(db: DatabaseSync, file: string, existed: boolean, target: number, migrations: readonly SqliteMigration[], log: Logger, beforeCommit?: () => void): void {
  // Already current: nothing to migrate, so never block the event loop on another process's migration lock (AB-223).
  admissionSqliteBusy(db, SQLITE_BUSY_TIMEOUT_MS);
  if (Number(db.prepare("PRAGMA user_version").get()!.user_version) === target) return;
  // Under bounded ordinary admission, use the common exclusion instead of the
  // historical independently blocking five-second lock acquisition.
  if (storageAdmissionRemaining() !== undefined && file !== ':memory:') {
    const home = dirname(file);
    assertCompatibleMailboxReaders(home);
    if (hasMaintenanceExclusion(home)) { migrateLocked(db,file,existed,target,migrations,log,beforeCommit); return; }
    const release = maintenanceLock(home,true,true);
    try { withMaintenanceExclusion(release, () => storageAdmissionRemaining()!, () => migrateLocked(db,file,existed,target,migrations,log,beforeCommit)); }
    finally { release(); }
    return;
  }
  const release = migrationLock(file);
  try { migrateLocked(db, file, existed, target, migrations, log,beforeCommit); } finally { release(); }
}

function migrateLocked(db: DatabaseSync, file: string, existed: boolean, target: number, migrations: readonly SqliteMigration[], log: Logger, beforeCommit?: () => void): void {
  storageAdmissionRemaining();
  admissionSqliteBusy(db, SQLITE_BUSY_TIMEOUT_MS);
  const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
  if (version > target) throw new Error(`unsupported SQLite store version: ${version}`);
  if (version === target) return;
  if (basename(file) === "bridge.db" && !offlineMetadataAdmitted(dirname(file))) assertStoreUpgrade(dirname(file), "sqlite", version, target);
  let backup: string | null = null;
  // A commit between snapshot and lock acquisition must not disappear on recovery.
  let transaction = false;
  let committing = false;
  try {
  for (let attempt = 0; ; attempt++) {
    storageAdmissionRemaining();
    if (attempt >= MAX_SNAPSHOT_ATTEMPTS) throw Object.assign(new Error("database kept changing before migration; waiting to retry while sessions continue"), { code: "EBUSY" });
    const before = db.prepare("PRAGMA data_version").get()!.data_version;
    if (existed) {
      // Keep the recovery snapshot outside the legacy rotation namespace. Another
      // mixed-version candidate may archive root backups while this writer waits.
      const protectedDir = join(dirname(file), ".migration-snapshots");
      mkdirSync(protectedDir, { recursive: true, mode: 0o700 });
      const legacyBackup = backupPath(file);
      const pending = migrations.filter(migration => migration.version > version);
      const scoped = pending.length > 0 && pending.every(migration => migration.backupTables !== undefined);
      if (scoped) {
        backup = join(protectedDir, `${basename(file)}.metadata-v${version}-to-v${target}-${randomUUID()}.db`);
        metadataSnapshot(db, backup, [...new Set(pending.flatMap(migration => [...migration.backupTables!]))], version, target);
      } else {
        storageAdmissionRemaining();
        backup = join(protectedDir, `${basename(legacyBackup)}-v${version}-to-v${target}`);
        db.prepare("VACUUM INTO ?").run(backup);
        storageAdmissionRemaining();
        const snapshot = new DatabaseSync(backup, { readOnly: true });
        try {
          if (snapshot.prepare("PRAGMA integrity_check").all().some((row) => row.integrity_check !== "ok")) throw new Error(`invalid pre-migration snapshot: ${backup}`);
        } finally { snapshot.close(); }
      }
      // Preserve the established discovery path for existing tooling. Recovery
      // uses the protected original, which is never automatically rotated.
      storageAdmissionRemaining();
      if (!scoped) { copyFileSync(backup, legacyBackup); retainBackups(file); }
      log.info("backed up store before migration", { file, backup, version, scope: scoped ? "metadata and schema only" : "whole database" });
    }
    storageAdmissionRemaining();
    db.exec("BEGIN IMMEDIATE"); transaction = true;
    storageAdmissionRemaining();
    if (before === db.prepare("PRAGMA data_version").get()!.data_version) break;
    db.exec("ROLLBACK"); transaction = false;
  }
  storageAdmissionRemaining();
  db.exec("SAVEPOINT schema_migration");
  try {
    const current = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (current > target) throw new Error(`unsupported SQLite store version: ${current}`);
    for (const migration of migrations) if (migration.version > current) {
      storageAdmissionRemaining(); db.exec(migration.sql); storageAdmissionRemaining();
    }
    if (Number(db.prepare("PRAGMA user_version").get()!.user_version) !== target) throw new Error("migration did not reach expected schema version");
    storageAdmissionRemaining(); beforeCommit?.(); storageAdmissionRemaining();
    storageAdmissionRemaining();
    db.exec("RELEASE schema_migration");
    storageAdmissionRemaining(); committing = true; db.exec("COMMIT"); transaction = false; committing = false;
  } catch (err) {
    if (committing) throw Object.assign(new Error('Migration COMMIT outcome unknown; snapshots retained. Explicit same-attempt inspection required.'), { cause: err, code: 'STORE_COMMIT_UNKNOWN' });
    // Expired/cancelled admission may roll back owned work, but cannot start a
    // fresh backup-restoration transaction or phase after the original deadline.
    storageAdmissionRemaining();
    db.exec("ROLLBACK TO schema_migration");
    // The savepoint restores schema first. Restore original table contents from the verified snapshot,
    // under the same writer lock, without replacing a database another reader has open.
    if (backup) {
      const original = new DatabaseSync(backup, { readOnly: true, timeout: storageAdmissionTimeout(SQLITE_BUSY_TIMEOUT_MS) });
      try {
        // Virtual tables and their shadows were restored by the savepoint. Never rewrite FTS internals.
        const tables = original.prepare("PRAGMA table_list").all().filter((r) => r.schema === "main" && r.type === "table" && !String(r.name).startsWith("sqlite_"));
        const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
        for (const row of tables) {
          storageAdmissionRemaining();
          const name = String(row.name);
          const quoted = quote(name);
          const columns = original.prepare(`PRAGMA table_xinfo(${quoted})`).all().filter((r) => r.hidden === 0).map((r) => String(r.name));
          let rowidAlias = "__bridge_backup_rowid";
          while (columns.includes(rowidAlias)) rowidAlias += "_";
          const rowid = ["rowid", "_rowid_", "oid"].find((s) => !columns.includes(s));
          const hasRowid = row.wr === 0 && rowid !== undefined;
          const select = original.prepare(`SELECT ${hasRowid ? `${quote(rowid)} AS ${quote(rowidAlias)}, ` : ""}${columns.map(quote).join(", ")} FROM ${quoted}`);
          select.setReadBigInts(true);
          // Append-only guards (conversation_records) would abort the restore (AB-235). Lift every trigger on the
          // table for the restore and recreate it from its own SQL inside this same transaction.
          const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND sql IS NOT NULL").all(name);
          for (const trigger of triggers) { storageAdmissionRemaining(); db.exec(`DROP TRIGGER ${quote(String(trigger.name))}`); }
          storageAdmissionRemaining(); db.exec(`DELETE FROM ${quoted}`);
          const insertColumns = hasRowid ? [rowid, ...columns] : columns;
          const insert = db.prepare(`INSERT INTO ${quoted} (${insertColumns.map(quote).join(", ")}) VALUES (${insertColumns.map(() => "?").join(", ")})`);
          // Stream rows; a large store never materializes a whole table in memory.
          for (const data of select.iterate()) { storageAdmissionRemaining(); insert.run(...(hasRowid ? [data[rowidAlias]!, ...columns.map((s) => data[s]!)] : columns.map((s) => data[s]!))); }
          for (const trigger of triggers) { storageAdmissionRemaining(); db.exec(String(trigger.sql)); }
        }
        storageAdmissionRemaining();
        db.exec(`PRAGMA user_version = ${Number(original.prepare("PRAGMA user_version").get()!.user_version)}`);
        storageAdmissionRemaining();
        db.exec("RELEASE schema_migration");
        storageAdmissionRemaining(); committing = true; db.exec("COMMIT"); transaction = false; committing = false;
        log.warn("failed migration restored its backup", { file, backup });
      } catch (recoveryError) {
        db.exec("ROLLBACK"); transaction = false;
        throw new AggregateError([err, recoveryError], `migration failed; transaction rolled back and backup preserved at ${backup}`);
      } finally { original.close(); }
    } else { db.exec("ROLLBACK"); transaction = false; }
    throw err;
  }
  } catch (error) {
    if (transaction && !committing) {
      try { db.exec("ROLLBACK"); }
      catch (rollback) { throw new AggregateError([error, rollback], "Migration admission failed; rollback is unconfirmed and original snapshots are retained."); }
    }
    throw error;
  }
}
