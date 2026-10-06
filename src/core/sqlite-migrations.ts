import { DatabaseSync } from "node:sqlite";
import { backupPath, retainBackups } from "./json-store.js";
import type { Logger } from "./logger.js";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite-maintenance.js";

export interface SqliteMigration { version: number; sql: string }
const MAX_SNAPSHOT_ATTEMPTS = 10;

/** Every change is versioned. Keep the writer lock through recovery from the pre-migration backup. */
export function migrateSqlite(db: DatabaseSync, file: string, existed: boolean, target: number, migrations: readonly SqliteMigration[], log: Logger): void {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
  if (version > target) throw new Error(`unsupported SQLite store version: ${version}`);
  if (version === target) return;
  let backup: string | null = null;
  // A commit between snapshot and lock acquisition must not disappear on recovery.
  for (let attempt = 0; ; attempt++) {
    if (attempt >= MAX_SNAPSHOT_ATTEMPTS) throw new Error("database kept changing before migration; retry with bridge stopped");
    const before = db.prepare("PRAGMA data_version").get()!.data_version;
    if (existed) {
      backup = backupPath(file);
      db.prepare("VACUUM INTO ?").run(backup);
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
        const tables = original.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
        for (const row of tables) {
          const name = String(row.name);
          const quoted = `"${name.replaceAll('"', '""')}"`;
          const rows = original.prepare(`SELECT * FROM ${quoted}`).all();
          db.exec(`DELETE FROM ${quoted}`);
          for (const data of rows) {
            const columns = Object.keys(data).map((s) => `"${s.replaceAll('"', '""')}"`).join(", ");
            db.prepare(`INSERT INTO ${quoted} (${columns}) VALUES (${Object.keys(data).map(() => "?").join(", ")})`).run(...Object.values(data));
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
