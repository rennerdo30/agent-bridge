import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { historySchema } from "./history-schema.js";
import { CONVERSATION_SCHEMA } from "./conversation-schema.js";
import { configureSqlite, isSqliteBusy } from "./sqlite-policy.js";
import { migrationLock } from "./migration-lock.js";
import { resumableHistoryMigration, type HistoryMigrationOptions } from "./history-migration.js";
export type { HistoryMigrationOptions } from "./history-migration.js";

export const HISTORY_DB_NAME = "history.db";
export const HISTORY_STORE_VERSION = 1;
export const HISTORY_COPY_ROWS = 32;
export const HISTORY_BATCH_MS = 50;
export const HISTORY_COPY_BYTES = 512 * 1024;
// Payload pacing is shared by snapshot, copy, and verification; SQLite's own page
// and index overhead is additional. Pressure pauses further reduce actual I/O.
export const HISTORY_IO_BYTES_PER_SECOND = 8 * 1024 * 1024;
export interface HistoryMigrationProgress {
  phase: "starting" | "snapshot" | "copy" | "verify" | "paused" | "failed" | "verified";
  percent: number;
  etaSeconds: number | null;
  paused: boolean;
  completedRows: number;
  totalRows: number;
  snapshot: string | null;
  ioBytesPerSecond: number;
  error: string | null;
}
export const HISTORY_TABLES = ["history_documents", "history_cursors", "history_files", "history_tags", "history_sessions", "history_pending", "conversations", "conversation_sources", "conversation_records", "conversation_parts", "conversation_projects", "conversation_memberships", "conversation_bindings", "conversation_envelopes"] as const;
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

export function historyDbPath(bridge: string): string {
  return bridge === ":memory:" ? bridge : join(dirname(bridge), HISTORY_DB_NAME);
}
export function historyReady(db: DatabaseSync): boolean {
  if (Number(db.prepare("PRAGMA user_version").get()!.user_version) !== HISTORY_STORE_VERSION) return false;
  return !!db.prepare("SELECT name FROM sqlite_master WHERE name='history_migration'").get() &&
    db.prepare("SELECT status FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION)?.status === "verified";
}
/** Readers stay on preserved legacy rows until the complete copy has been verified. */
export function historyReadPath(file: string): string {
  if (basename(file) !== "bridge.db") return file;
  const path = historyDbPath(file);
  if (!existsSync(path)) return file;
  const db = new DatabaseSync(path, { readOnly: true, timeout: 100 });
  try { return historyReady(db) ? path : file; } finally { db.close(); }
}

/** Independent version sequence. No broker tables, triggers, or attached writable databases. */
export function openHistoryStore(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { timeout: 3000 });
  try {
    db.exec("PRAGMA busy_timeout=3000");
    const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (version > HISTORY_STORE_VERSION) throw new Error(`unsupported history store version: ${version}`);
    configureSqlite(db);
    if (version === HISTORY_STORE_VERSION) return db;
    const release = migrationLock(file);
    try {
      if (Number(db.prepare("PRAGMA user_version").get()!.user_version) === HISTORY_STORE_VERSION) return db;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(historySchema().replace(/CREATE TRIGGER history_message_(?:insert|claim)[\s\S]*?END;/g, "").replace(/PRAGMA user_version = 4;/, ""));
        db.exec(CONVERSATION_SCHEMA.slice(0, CONVERSATION_SCHEMA.indexOf("INSERT OR IGNORE INTO conversation_envelopes")));
        db.exec(`CREATE TABLE history_migration(version INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, status TEXT NOT NULL, manifest TEXT);
          CREATE TABLE history_legacy_tail(source_id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL);
          PRAGMA user_version=${HISTORY_STORE_VERSION}; COMMIT`);
      } catch (err) { db.exec("ROLLBACK"); throw err; }
    } finally { release(); }
    return db;
  } catch (err) { db.close(); throw err; }
}

/** Durable snapshot/copy/verification chunks run only in the elected worker.
 * Legacy rows and every interrupted snapshot generation are retained. */
export async function migrateHistoryStore(bridge: string, target: DatabaseSync, shouldPause: () => boolean = () => false, stopped: () => boolean = () => false, onLease?: (owner: string | null) => void, retryFailed = false, options: HistoryMigrationOptions = {}): Promise<void> {
  if (historyReady(target)) {
    options.onProgress?.({ phase: "verified", percent: 100, etaSeconds: 0, paused: false, completedRows: 0, totalRows: 0, snapshot: null, ioBytesPerSecond: options.ioBytesPerSecond ?? HISTORY_IO_BYTES_PER_SECOND, error: null });
    return;
  }
  const release = migrationLock(historyDbPath(bridge));
  try {
    onLease?.(readFileSync(`${historyDbPath(bridge)}.migration-lock`, "utf8"));
    if (historyReady(target)) return;
    const state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
    if (state?.status === "failed") {
      if (!retryFailed) throw Object.assign(new Error("History migration verification failed previously; all originals and snapshots preserved; use agent-bridge reindex for an explicit retry"), { code: "HISTORY_VERIFICATION_FAILED" });
      const failure = JSON.parse(String(state.manifest));
      target.prepare("UPDATE history_migration SET status=?,manifest=? WHERE version=?").run(failure.resumeStatus, failure.snapshotManifest, HISTORY_STORE_VERSION);
    }
    await resumableHistoryMigration(bridge, target, shouldPause, stopped, options);
  } catch (err) {
    const state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
    const code = (err as { code?: string }).code;
    if (state && state.status !== "failed" && !isSqliteBusy(err) && code !== "HISTORY_MIGRATION_STOPPED" && code !== "HISTORY_SNAPSHOT_PAUSED") {
      target.prepare("UPDATE history_migration SET status='failed',manifest=? WHERE version=?").run(JSON.stringify({ error: String(err), resumeStatus: state.status, snapshotManifest: state.manifest }), HISTORY_STORE_VERSION);
    }
    throw err;
  } finally { release(); onLease?.(null); }
}

export function historyMigrationFailure(db: DatabaseSync): string | null {
  const state = db.prepare("SELECT status,manifest FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
  if (state?.status !== "failed") return null;
  try { return String(JSON.parse(String(state.manifest)).error); }
  catch { return "History migration failed; protected backup preserved; explicit retry required"; }
}
/** A terminated worker shares its parent's PID. Release only its exact recorded nonce,
 * after worker exit; PID-only dead-process recovery cannot detect a dead thread. */
export function releaseExitedHistoryLease(bridge: string, owner: string): void {
  const path = `${historyDbPath(bridge)}.migration-lock`;
  if (JSON.parse(owner).pid !== process.pid) return;
  if (existsSync(path) && readFileSync(path,"utf8") === owner) rmSync(path);
}

/** Old pinned writers may append after the backup. Retain their bytes by natural key,
 * remapping numeric ids so concurrent native ingestion can never overwrite a legacy row.
 * Cursor publication follows a committed record, and replay validates its raw bytes.
 */
export function copyLegacyConversationTail(source: DatabaseSync, target: DatabaseSync): number {
  if (!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_records'").get()) return 0;
  const after = Number(target.prepare("SELECT cursor FROM history_cursors WHERE source='legacy-record-tail'").get()?.cursor ?? 0);
  const deadline = Date.now() + HISTORY_BATCH_MS;
  let work = 0;
  for (const row of source.prepare("SELECT * FROM conversation_records WHERE id>? ORDER BY id LIMIT ?").iterate(after, HISTORY_COPY_ROWS)) {
    const conversation = source.prepare("SELECT * FROM conversations WHERE id=?").get(row.conversation!);
    if (!conversation) throw new Error("Legacy record has no conversation; original retained");
    target.exec("BEGIN IMMEDIATE");
    try {
      const columns = Object.keys(conversation);
      target.prepare(`INSERT OR IGNORE INTO conversations(${columns.map(quote).join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(conversation));
      let copied = target.prepare("SELECT * FROM conversation_records WHERE source=? AND generation=? AND offset=?").get(row.source!, row.generation!, row.offset!);
      if (!copied) {
        target.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body,part) VALUES(?,?,?,?,?,?,?,?)")
          .run(row.source!, row.generation!, row.offset!, row.conversation!, row.at!, row.raw!, row.body!, row.part!);
        copied = target.prepare("SELECT * FROM conversation_records WHERE source=? AND generation=? AND offset=?").get(row.source!, row.generation!, row.offset!)!;
      }
      if (copied.conversation !== row.conversation || !Buffer.from(copied.raw as Uint8Array).equals(Buffer.from(row.raw as Uint8Array))) throw new Error("Legacy transcript conflict; both originals retained, tail deferred");
      target.prepare("INSERT OR IGNORE INTO history_legacy_tail VALUES(?,?)").run(row.id!, copied.id!);
      target.prepare("INSERT INTO history_cursors VALUES('legacy-record-tail',?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(String(row.id));
      target.exec("COMMIT");
    } catch (err) { target.exec("ROLLBACK"); throw err; }
    work++;
    if (Date.now() >= deadline) break;
  }
  return work;
}
