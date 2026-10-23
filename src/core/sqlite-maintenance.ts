import { existsSync } from "node:fs";
import { assertBootstrapAccess } from "./store-bootstrap-journal.js";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateSqlite } from "./sqlite-migrations.js";
import { nullLogger, type Logger } from "./logger.js";
import { configureSqlite } from "./sqlite-policy.js";
import { admissionSqliteBusy, storageAdmissionRemaining, storageAdmissionTimeout } from "./storage-admission.js";
export { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite-policy.js";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite-policy.js";
import { openPreservedReader, preserveArchiveTarget } from "./storage-preservation.js";

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
    db.exec(`PRAGMA busy_timeout = ${storageAdmissionTimeout(SQLITE_BUSY_TIMEOUT_MS)}`);
    db.prepare("VACUUM INTO ?").run(target);
  } finally { db.close(); }
  const copy = new DatabaseSync(target, { readOnly: true, timeout: storageAdmissionTimeout(SQLITE_BUSY_TIMEOUT_MS) });
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
type ArchiveInitialization = { readonly identity: symbol; db?: DatabaseSync; readonly file: string;
  construction: "attempted_unconfirmed" | "returned" | "unknown";
  state: "initializing" | "returned" | "failed"; close: "not_attempted" | "attempted" | "returned" | "unknown" };
const archiveInitializations = new WeakMap<DatabaseSync, ArchiveInitialization>();
const retainedArchiveInitializations = new Set<ArchiveInitialization>();
/** Internal non-authorizing observation of this exact opener's historical native
 * capture/outcome. It steps no SQLite SQL, exports no native resource or permission,
 * and cannot certify a parent owner, current closure, consumer drain or retirement. */
export function archiveInitializationObservation(db: DatabaseSync): Readonly<{
  captured: boolean; initialization: ArchiveInitialization["state"] | "unavailable";
  close: ArchiveInitialization["close"]; retained: boolean; overflow: boolean;
  ownerBound: false; ownershipReleased: false;
}> {
  const record = archiveInitializations.get(db);
  return Object.freeze({ captured: !!record, initialization: record?.state ?? "unavailable", close: record?.close ?? "not_attempted",
    retained: !!record && retainedArchiveInitializations.has(record), overflow: retainedArchiveInitializations.size > 128,
    ownerBound: false, ownershipReleased: false });
}
export function openArchive(path: string, options: { migrate?: boolean; home?: string } = {}): DatabaseSync {
  if (path !== ":memory:") assertBootstrapAccess(options.home ?? dirname(path));
  storageAdmissionRemaining();
  const existed = existsSync(path);
  let admitted: ReturnType<typeof preserveArchiveTarget> | undefined;
  let original: DatabaseSync | undefined;
  let db: DatabaseSync | undefined;
  let record: ArchiveInitialization | undefined;
  try {
    if (options.migrate === false) {
      if (!options.home) throw new Error("Storage absorb archive home is unavailable; all originals are retained.");
      admitted = preserveArchiveTarget(path, options.home);
      path = admitted.path;
      if (!admitted.created) {
        admitted.check();
        original = openPreservedReader(path);
        admitted.check();
        if (Number(original.prepare("PRAGMA user_version").get()!.user_version) !== ARCHIVE_STORE_VERSION)
          throw new Error("Storage absorb requires a current archive.db; archive migration is disabled and all originals are retained.");
      }
    }
    admitted?.check();
    record = { identity: Symbol(), file: path, construction: "attempted_unconfirmed", state: "initializing", close: "not_attempted" };
    retainedArchiveInitializations.add(record); // Register BEFORE native construction; an unreturned attempt remains unknown.
    db = new DatabaseSync(path);
    record.db = db; record.construction = "returned";
    archiveInitializations.set(db, record); // Capture the actual returned writer BEFORE checks or page SQL.
    admitted?.check();
    admissionSqliteBusy(db,SQLITE_BUSY_TIMEOUT_MS,true);
    if (options.migrate === false) {
      if (admitted?.created) db.exec(ARCHIVE_SCHEMA);
      else if (Number(db.prepare("PRAGMA user_version").get()!.user_version) !== ARCHIVE_STORE_VERSION)
        throw new Error("Storage absorb requires a current archive.db; archive migration is disabled and all originals are retained.");
    } else migrateSqlite(db, path, existed, ARCHIVE_STORE_VERSION, [{ version: 1, sql: ARCHIVE_SCHEMA }], nullLogger);
    admitted?.check();
    configureSqlite(db);
    admitted?.check();
    record.state = "returned"; return db;
  } catch (err) {
    if (record) {
      record.state = "failed"; retainedArchiveInitializations.add(record);
      if (record.construction === "attempted_unconfirmed") record.construction = "unknown";
      if (db) record.close = "attempted";
    }
    try { db?.close(); if (db && record) record.close = "returned"; }
    catch (closeError) { if (record) record.close = "unknown"; throw closeError; } // Preserve released close-error precedence.
    throw err;
  } finally {
    try { original?.close(); admitted?.close(); }
    catch (cleanupError) {
      // A cleanup throw can prevent delivery of the initialized writer. Retain
      // that exact capture without adding cleanup, SQL or closure authority.
      if (record) { record.state = "failed"; retainedArchiveInitializations.add(record); }
      throw cleanupError;
    }
    if (record?.state === "returned") retainedArchiveInitializations.delete(record);
  }
}

export function archiveDbPath(file: string): string {
  return file === ":memory:" ? ":memory:" : join(dirname(file), ARCHIVE_DB_NAME);
}

// Keep this list explicit: receipt and archival timestamps are mutable metadata.
const MESSAGE_IDENTITY_FIELDS = ["id", "recipient", "from_id", "from_name", "from_agent", "to_target",
  "conversation_id", "reply_to", "hop", "body", "created_at"] as const;

/** Additive retention bookkeeping, independent of the message schema version.
 * The evidence row IS the marker: one source transaction publishes both or neither.
 * Raw messages remain unchanged and readable to offline inspection tools.
 */
export function ensureMessageQuarantine(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS message_archive_conflicts (
    source_table TEXT NOT NULL, id TEXT NOT NULL, recipient TEXT NOT NULL,
    source_hash TEXT NOT NULL, archive_hash TEXT NOT NULL,
    source_json TEXT NOT NULL, archive_json TEXT NOT NULL,
    source_db TEXT NOT NULL, archive_db TEXT NOT NULL, source_rowid TEXT NOT NULL,
    reason TEXT NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    encounters INTEGER NOT NULL,
    PRIMARY KEY (source_table, id, recipient, source_hash)
  )`);
  db.exec(`CREATE TEMP VIEW IF NOT EXISTS deliverable_messages AS
    SELECT * FROM messages WHERE ${unquarantined("messages")}`);
}

/** Quarantine is permanent until an explicit reviewed recovery, never a TTL retry. */
export function unquarantined(table: "messages" | "archived_messages"): string {
  // Rowids are provenance only: VACUUM/snapshots may renumber them. Exact content
  // matching also prevents one legacy variant's evidence from hiding another.
  return `NOT EXISTS (SELECT 1 FROM message_archive_conflicts q
    WHERE q.source_table='${table}' AND q.id=${table}.id AND q.recipient=${table}.recipient
      AND ${MESSAGE_IDENTITY_FIELDS.slice(2).map(key => `json_extract(q.source_json, '$.${key}') IS ${table}.${key}`).join(" AND ")})`;
}

function contentHash(row: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(MESSAGE_IDENTITY_FIELDS.map(key => row[key]))).digest("hex");
}
function databaseFile(db: DatabaseSync): string {
  return String(db.prepare("PRAGMA database_list").all().find(row => row.name === "main")?.file || ":memory:");
}

/** Copy commits first. A crash can leave duplicate rows, but can never leave neither copy.
 * Returns newly archived or quarantined source rows. encounters counts source rows
 * first observed with this immutable variant (legacy tables may contain duplicates);
 * subsequent expiry, hello and restart scans skip it without changing evidence or logging.
 */
export function archiveMessages(source: DatabaseSync, archive: DatabaseSync, where: string, args: (string | number)[], reason: string, table: "messages" | "archived_messages" = "messages", log: Logger = nullLogger): number {
  ensureMessageQuarantine(source);
  // The same predicate fences selection and removal, including legacy/offline paths.
  where = `(${where}) AND ${unquarantined(table)}`;
  source.exec("BEGIN IMMEDIATE");
  try {
    const rows = source.prepare(`SELECT rowid AS __archive_rowid, * FROM ${table} WHERE ${where}`).all(...args);
    let conflicts = 0;
    archive.exec("BEGIN IMMEDIATE");
    try {
      const insert = archive.prepare("INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const { __archive_rowid, ...r } of rows) {
        const existing = archive.prepare("SELECT * FROM messages WHERE id = ? AND recipient = ?").get(r.id!, r.recipient!);
        if (existing && MESSAGE_IDENTITY_FIELDS.some(key => existing[key] !== r[key])) {
          // archive identity conflict; original message preserved, never overwritten or removed.
          // Both full variants, hashes and provenance publish atomically with the exclusion marker.
          const now = Date.now();
          source.prepare(`INSERT INTO message_archive_conflicts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(source_table,id,recipient,source_hash) DO UPDATE SET
              encounters=encounters+1, last_seen=excluded.last_seen`)
            .run(table, r.id!, r.recipient!, contentHash(r), contentHash(existing), JSON.stringify(r), JSON.stringify(existing),
              databaseFile(source), databaseFile(archive), String(__archive_rowid), reason, now, now, 1);
          conflicts++;
          continue;
        }
        insert.run(r.id!, r.recipient!, r.from_id!, r.from_name!, r.from_agent!, r.to_target!, r.conversation_id!, r.reply_to!, r.hop!, r.body!, r.created_at!, r.read_at!, r.archive_reason ?? reason, r.archived_at ?? Date.now());
        if (existing && r.read_at !== null) archive.prepare("UPDATE messages SET read_at = COALESCE(read_at, ?) WHERE id = ? AND recipient = ?").run(r.read_at!, r.id!, r.recipient!);
      }
      archive.exec("COMMIT");
    } catch (err) { archive.exec("ROLLBACK"); throw err; }
    const count = Number(source.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...args).changes);
    source.exec("COMMIT");
    // One bounded summary per committed chunk; durable markers prevent retry/restart floods.
    if (conflicts) log.warn("quarantined archive identity conflicts; original messages preserved", { table, reason, count: conflicts });
    return count + conflicts;
  } catch (err) { source.exec("ROLLBACK"); throw err; }
}
