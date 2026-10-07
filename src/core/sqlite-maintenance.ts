import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateSqlite } from "./sqlite-migrations.js";
import { nullLogger } from "./logger.js";
import { configureSqlite } from "./sqlite-policy.js";
export { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite-policy.js";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite-policy.js";

export const ARCHIVE_DB_NAME = "archive.db";
export const ARCHIVE_STORE_VERSION = 1;

export function checkDatabase(db: DatabaseSync): string[] {
  const integrity = db.prepare("PRAGMA integrity_check").all().map((r) => String(r.integrity_check));
  const foreign = db.prepare("PRAGMA foreign_key_check").all();
  return [...integrity.filter((s) => s !== "ok"), ...foreign.map((r) => `foreign key: ${JSON.stringify(r)}`)];
}

/** VACUUM INTO works on Node 22.13 and includes committed WAL pages. Publish only verified copies. */
export function snapshotDatabase(source: string, target: string): void {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    db.prepare("VACUUM INTO ?").run(target);
  } finally { db.close(); }
  const copy = new DatabaseSync(target, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    const findings = checkDatabase(copy);
    if (findings.length) throw new Error(`invalid database backup: ${findings.join(", ")}`);
  } finally { copy.close(); }
}

const ARCHIVE_SCHEMA = `
CREATE TABLE messages (
  id TEXT NOT NULL, recipient TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL,
  from_agent TEXT NOT NULL, to_target TEXT NOT NULL, conversation_id TEXT NOT NULL, reply_to TEXT,
  hop INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
  archive_reason TEXT NOT NULL, archived_at INTEGER NOT NULL,
  PRIMARY KEY (id, recipient)
);
CREATE INDEX idx_archive_created ON messages(created_at);
PRAGMA user_version = 1;
`;

/** Archive schema has its own version sequence; primary migrations belong to MessageStore. */
export function openArchive(path: string): DatabaseSync {
  const existed = existsSync(path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    migrateSqlite(db, path, existed, ARCHIVE_STORE_VERSION, [{ version: 1, sql: ARCHIVE_SCHEMA }], nullLogger);
    configureSqlite(db);
    return db;
  } catch (err) { db.close(); throw err; }
}

export function archiveDbPath(file: string): string {
  return file === ":memory:" ? ":memory:" : join(dirname(file), ARCHIVE_DB_NAME);
}

/** Copy commits first. A crash can leave duplicate rows, but can never leave neither copy. */
export function archiveMessages(source: DatabaseSync, archive: DatabaseSync, where: string, args: (string | number)[], reason: string, table: "messages" | "archived_messages" = "messages"): number {
  source.exec("BEGIN IMMEDIATE");
  try {
    const rows = source.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...args);
    archive.exec("BEGIN IMMEDIATE");
    try {
      const insert = archive.prepare("INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const r of rows) {
        const existing = archive.prepare("SELECT * FROM messages WHERE id = ? AND recipient = ?").get(r.id!, r.recipient!);
        if (existing && Object.entries(r).some(([key, value]) => !["read_at", "archive_reason", "archived_at"].includes(key) && existing[key] !== value)) throw new Error("archive identity conflict; original message preserved");
        insert.run(r.id!, r.recipient!, r.from_id!, r.from_name!, r.from_agent!, r.to_target!, r.conversation_id!, r.reply_to!, r.hop!, r.body!, r.created_at!, r.read_at!, r.archive_reason ?? reason, r.archived_at ?? Date.now());
        if (existing && r.read_at !== null) archive.prepare("UPDATE messages SET read_at = COALESCE(read_at, ?) WHERE id = ? AND recipient = ?").run(r.read_at!, r.id!, r.recipient!);
      }
      archive.exec("COMMIT");
    } catch (err) { archive.exec("ROLLBACK"); throw err; }
    const count = Number(source.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...args).changes);
    source.exec("COMMIT");
    return count;
  } catch (err) { source.exec("ROLLBACK"); throw err; }
}
