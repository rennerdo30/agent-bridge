import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { backupPath, retainBackups } from "./json-store.js";
import type { Logger } from "./logger.js";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite-maintenance.js";
import { migrationLock } from "./migration-lock.js";
import { assertStoreUpgrade } from "./store-compatibility.js";

export interface SqliteMigration { version: number; sql: string }
const MAX_SNAPSHOT_ATTEMPTS = 10;

/** Every change is versioned. Keep the writer lock through recovery from the pre-migration backup. */
export function migrateSqlite(db: DatabaseSync, file: string, existed: boolean, target: number, migrations: readonly SqliteMigration[], log: Logger): void {
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
      backup = join(protectedDir, `${basename(legacyBackup)}-v${version}-to-v${target}`);
      db.prepare("VACUUM INTO ?").run(backup);
      const snapshot = new DatabaseSync(backup, { readOnly: true });
      try {
        if (snapshot.prepare("PRAGMA integrity_check").all().some((row) => row.integrity_check !== "ok")) throw new Error(`invalid pre-migration snapshot: ${backup}`);
      } finally { snapshot.close(); }
      // Preserve the established discovery path for existing tooling. Recovery
      // uses the protected original, which is never automatically rotated.
      copyFileSync(backup, legacyBackup);
      retainBackups(file);
      log.info("backed up store before migration", { file, backup, version });
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
      const original = new DatabaseSync(backup, { readOnly: true });
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
