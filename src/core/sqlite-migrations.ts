import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { backupPath, retainBackups } from "./json-store.js";
import type { Logger } from "./logger.js";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite-maintenance.js";
import { migrationLock } from "./migration-lock.js";
import { assertStoreUpgrade } from "./store-compatibility.js";

export interface SqliteMigration { version: number; sql: string; backupTables?: readonly string[] }
const MAX_SNAPSHOT_ATTEMPTS = 10;

/** Additive migrations may explicitly preserve only the metadata they read/change.
 * These protected snapshots are labeled separately and never offered as full DB restores.
 */
function metadataSnapshot(db: DatabaseSync, path: string, tables: string[], version: number, target: number): void {
  const snapshot = new DatabaseSync(path);
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const digest = (row: Record<string, unknown>) => JSON.stringify(row, (_, value) => typeof value === "bigint" ? { bigint: String(value) } : value);
  const manifest: { version: number; kind: string; sourceVersion: number; targetVersion: number; schema: unknown[]; tables: { name: string; rows: number; sha256: string }[] } = {
    version: 1, kind: "sqlite-migration-metadata", sourceVersion: version, targetVersion: target,
    schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(), tables: [],
  };
  try {
    snapshot.exec("BEGIN");
    for (const table of tables) {
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!schema || typeof schema.sql !== "string") throw new Error(`Missing migration snapshot table: ${table}`);
      snapshot.exec(schema.sql);
      const source = db.prepare(`SELECT rowid AS __migration_rowid__, * FROM ${quote(table)} ORDER BY rowid`);
      source.setReadBigInts(true);
      const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => String(row.name));
      const insert = snapshot.prepare(`INSERT INTO ${quote(table)} (rowid,${columns.map(quote).join(",")}) VALUES (${["rowid", ...columns].map(() => "?").join(",")})`);
      const expected = createHash("sha256");
      let rows = 0;
      for (const row of source.iterate()) {
        insert.run(row.__migration_rowid__!, ...columns.map(name => row[name]!));
        expected.update(digest(row)); rows++;
      }
      const actual = createHash("sha256");
      const verify = snapshot.prepare(`SELECT rowid AS __migration_rowid__, * FROM ${quote(table)} ORDER BY rowid`);
      verify.setReadBigInts(true);
      let verified = 0;
      for (const row of verify.iterate()) { actual.update(digest(row)); verified++; }
      const sha256 = expected.digest("hex");
      if (rows !== verified || actual.digest("hex") !== sha256) throw new Error(`Migration metadata snapshot verification failed: ${table}`);
      manifest.tables.push({ name: table, rows, sha256 });
    }
    snapshot.exec(`PRAGMA user_version=${version}; COMMIT`);
    if (snapshot.prepare("PRAGMA integrity_check").all().some(row => row.integrity_check !== "ok")) throw new Error(`Invalid metadata migration snapshot: ${path}`);
    writeFileSync(`${path}.manifest.json`, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const manifestFile = openSync(`${path}.manifest.json`, "r+");
    try { fsyncSync(manifestFile); } finally { closeSync(manifestFile); }
  } finally { snapshot.close(); }
}

/** Every change is versioned. Keep the writer lock through recovery from the pre-migration backup. */
export function migrateSqlite(db: DatabaseSync, file: string, existed: boolean, target: number, migrations: readonly SqliteMigration[], log: Logger): void {
  // Already current: nothing to migrate, so never block the event loop on another process's migration lock (AB-223).
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  if (Number(db.prepare("PRAGMA user_version").get()!.user_version) === target) return;
  const release = migrationLock(file);
  try { migrateLocked(db, file, existed, target, migrations, log); } finally { release(); }
}

function migrateLocked(db: DatabaseSync, file: string, existed: boolean, target: number, migrations: readonly SqliteMigration[], log: Logger): void {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
  if (version > target) throw new Error(`unsupported SQLite store version: ${version}`);
  if (version === target) return;
  if (basename(file) === "bridge.db") assertStoreUpgrade(dirname(file), "sqlite", version, target);
  let backup: string | null = null;
  // A commit between snapshot and lock acquisition must not disappear on recovery.
  for (let attempt = 0; ; attempt++) {
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
        backup = join(protectedDir, `${basename(legacyBackup)}-v${version}-to-v${target}`);
        db.prepare("VACUUM INTO ?").run(backup);
        const snapshot = new DatabaseSync(backup, { readOnly: true });
        try {
          if (snapshot.prepare("PRAGMA integrity_check").all().some((row) => row.integrity_check !== "ok")) throw new Error(`invalid pre-migration snapshot: ${backup}`);
        } finally { snapshot.close(); }
      }
      // Preserve the established discovery path for existing tooling. Recovery
      // uses the protected original, which is never automatically rotated.
      if (!scoped) { copyFileSync(backup, legacyBackup); retainBackups(file); }
      log.info("backed up store before migration", { file, backup, version, scope: scoped ? "metadata and schema only" : "whole database" });
    }
    db.exec("BEGIN IMMEDIATE");
    if (before === db.prepare("PRAGMA data_version").get()!.data_version) break;
    db.exec("ROLLBACK");
  }
  db.exec("SAVEPOINT schema_migration");
  try {
    const current = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (current > target) throw new Error(`unsupported SQLite store version: ${current}`);
    for (const migration of migrations) if (migration.version > current) db.exec(migration.sql);
    if (Number(db.prepare("PRAGMA user_version").get()!.user_version) !== target) throw new Error("migration did not reach expected schema version");
    db.exec("RELEASE schema_migration; COMMIT");
  } catch (err) {
    db.exec("ROLLBACK TO schema_migration");
    // The savepoint restores schema first. Restore original table contents from the verified snapshot,
    // under the same writer lock, without replacing a database another reader has open.
    if (backup) {
      const original = new DatabaseSync(backup, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
      try {
        // Virtual tables and their shadows were restored by the savepoint. Never rewrite FTS internals.
        const tables = original.prepare("PRAGMA table_list").all().filter((r) => r.schema === "main" && r.type === "table" && !String(r.name).startsWith("sqlite_"));
        for (const row of tables) {
          const name = String(row.name);
          const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
          const quoted = quote(name);
          const columns = original.prepare(`PRAGMA table_xinfo(${quoted})`).all().filter((r) => r.hidden === 0).map((r) => String(r.name));
          let rowidAlias = "__bridge_backup_rowid";
          while (columns.includes(rowidAlias)) rowidAlias += "_";
          const rowid = ["rowid", "_rowid_", "oid"].find((s) => !columns.includes(s));
          const hasRowid = row.wr === 0 && rowid !== undefined;
          const select = original.prepare(`SELECT ${hasRowid ? `${quote(rowid)} AS ${quote(rowidAlias)}, ` : ""}${columns.map(quote).join(", ")} FROM ${quoted}`);
          select.setReadBigInts(true);
          const rows = select.all();
          db.exec(`DELETE FROM ${quoted}`);
          for (const data of rows) {
            const insertColumns = hasRowid ? [rowid, ...columns] : columns;
            const values = hasRowid ? [data[rowidAlias]!, ...columns.map((s) => data[s]!)] : columns.map((s) => data[s]!);
            db.prepare(`INSERT INTO ${quoted} (${insertColumns.map(quote).join(", ")}) VALUES (${values.map(() => "?").join(", ")})`).run(...values);
          }
        }
        db.exec(`PRAGMA user_version = ${Number(original.prepare("PRAGMA user_version").get()!.user_version)}`);
        db.exec("RELEASE schema_migration; COMMIT");
        log.warn("failed migration restored its backup", { file, backup });
      } catch (recoveryError) {
        db.exec("ROLLBACK");
        throw new AggregateError([err, recoveryError], `migration failed; transaction rolled back and backup preserved at ${backup}`);
      } finally { original.close(); }
    } else db.exec("ROLLBACK");
    throw err;
  }
}
