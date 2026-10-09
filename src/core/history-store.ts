import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONVERSATION_RECORDS_VIEW, historyStoreV2Schema, HISTORY_V2_COPY_TABLES } from "./history-schema-v2.js";
import { registerHistoryFunctions } from "./history-codec.js";
import { configureSqlite, isSqliteBusy } from "./sqlite-policy.js";
import { migrationLock } from "./migration-lock.js";
import { liveStorePeers, refreshStorePeerIdentities } from "./store-compatibility.js";
import { encodeHistoryRow, decodeHistoryRow, HISTORY_V1_PREFIX, resumableHistoryMigration, type HistoryMigrationOptions } from "./history-migration.js";
export type { HistoryMigrationOptions } from "./history-migration.js";

export const HISTORY_DB_NAME = "history.db";
/** v2: large text stored compressed (history-codec.ts); v1 tables are retained as v1_* inside the file. */
export const HISTORY_STORE_VERSION = 2;
export const HISTORY_COPY_ROWS = 64;
export const HISTORY_BATCH_MS = 50;
export const HISTORY_COPY_BYTES = 2 * 1024 * 1024;
// Payload pacing for copy and verification; pressure pauses further reduce actual I/O.
export const HISTORY_IO_BYTES_PER_SECOND = 64 * 1024 * 1024;
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
  /** Legacy tail rows retained in history_legacy_conflicts instead of being copied (AB-226). */
  legacyConflicts?: number;
}
export const HISTORY_TABLES = HISTORY_V2_COPY_TABLES;
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

export function historyDbPath(bridge: string): string {
  return bridge === ":memory:" ? bridge : join(dirname(bridge), HISTORY_DB_NAME);
}
export function historyReady(db: DatabaseSync): boolean {
  if (Number(db.prepare("PRAGMA user_version").get()!.user_version) !== HISTORY_STORE_VERSION) return false;
  return !!db.prepare("SELECT name FROM sqlite_master WHERE name='history_migration'").get() &&
    db.prepare("SELECT status FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION)?.status === "verified";
}
/** Where history readers read from, and why (AB-224). */
export interface HistoryReadStatus {
  path: string;
  /** Present only while readers are served from the legacy store because the history store is not verified yet. */
  migration?: { ready: false; readsFrom: "legacy"; phase: string; percent: number; error: string | null; notice: string };
}
/** Readers stay on preserved legacy rows until the complete copy has been verified; never on a partial copy. */
export function historyReadPath(file: string): string { return historyReadStatus(file).path; }
export function historyReadStatus(file: string): HistoryReadStatus {
  if (basename(file) !== "bridge.db") return { path: file };
  const path = historyDbPath(file);
  if (!existsSync(path)) return { path: file };
  const db = new DatabaseSync(path, { readOnly: true, timeout: 100 });
  try {
    if (historyReady(db) || historyV1Readable(db)) return { path };
    const migration = legacyReadNotice(db);
    return migration ? { path: file, migration } : { path: file };
  } finally { db.close(); }
}
/** A verified v1 store whose in-place upgrade is deferred (AB-225) still holds the current history under its own names. */
export function historyV1Readable(db: DatabaseSync): boolean {
  return Number(db.prepare("PRAGMA user_version").get()!.user_version) === 1 &&
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='history_migration'").get() &&
    db.prepare("SELECT status FROM history_migration WHERE version=1").get()?.status === "verified";
}
/** Why readers are on the legacy store right now, for API responses (AB-224). */
export function legacyReadNotice(db: DatabaseSync): HistoryReadStatus["migration"] {
  if (historyReady(db) || historyV1Readable(db)) return undefined;
  const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
  const has = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);
  const v1 = version === 1 ? has("history_migration") && db.prepare("SELECT status FROM history_migration WHERE version=1").get()?.status === "verified"
    : has(`${HISTORY_V1_PREFIX}history_migration`) && db.prepare(`SELECT status FROM ${quote(`${HISTORY_V1_PREFIX}history_migration`)} WHERE version=1`).get()?.status === "verified";
  let phase = "starting", percent = 0, error: string | null = null;
  if (version === HISTORY_STORE_VERSION && has("history_migration")) {
    const state = db.prepare("SELECT status,manifest FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
    if (state) {
      phase = String(state.status);
      if (phase === "failed") { try { error = String(JSON.parse(String(state.manifest)).error); } catch { error = "History migration failed; explicit retry required"; } }
      const totals = has("history_copy_state") ? db.prepare("SELECT coalesce(sum(copied_rows+verified_rows),0) done,coalesce(sum(source_rows),0)*2 total FROM history_copy_state").get()! : { done: 0, total: 0 };
      percent = Number(totals.total) ? Math.min(99.99, Math.round(10000 * Number(totals.done) / Number(totals.total)) / 100) : 0;
    }
  }
  const notice = phase === "failed"
    ? `History store migration failed (${error}); results come from the legacy store (bridge.db) and may miss recent history. Run agent-bridge reindex to retry; nothing was deleted.`
    : `History store migration in progress (${phase}, ${percent}%); results come from the legacy store (bridge.db)${v1 ? " and miss history captured by 0.30.0–0.30.3, which stays retained and becomes searchable when the migration finishes" : " and may miss the newest history until the migration finishes"}.`;
  return { ready: false, readsFrom: "legacy", phase, percent, error, notice };
}
/** Read-only connection for history readers: v2 text is decoded by ab_text() inside SQL (FTS snippets, views). */
export function openHistoryReader(file: string, timeout = 100): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: true, timeout });
  try { registerHistoryFunctions(db); return db; } catch (err) { db.close(); throw err; }
}

/** 0.30.0–0.30.3 keep history.db v1 open for writing; renaming its tables under them would send their inserts
 * into the new v2 tables (AB-225). Unknown live readers are treated as old, like assertMetadataAdmission. */
export function liveHistoryV1Writers(home: string): string[] {
  return liveStorePeers(home).filter(peer => /^0\.30\.[0-3]$/.test(peer.version) || peer.version === "unknown")
    .map(peer => `${peer.name} (v${peer.version}, pid ${peer.pid})`);
}
function deferUpgrade(writers: string[]): never {
  throw Object.assign(new Error(`Waiting to upgrade history store 1→${HISTORY_STORE_VERSION}: ${writers.join(", ")} still write history v1. Reads stay on the legacy store; retry when they finish naturally.`), { code: "STORE_UPGRADE_DEFERRED" });
}

/** Independent version sequence. No broker tables, triggers, or attached writable databases.
 * v1 → v2 keeps every v1 table inside the file, renamed v1_*, and copies from it (or from bridge.db) verified.
 * The in-place v1 rename waits while a v1 writer is alive; the store then stays v1 until upgradeHistoryStore. */
export function openHistoryStore(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { timeout: 3000 });
  try {
    db.exec("PRAGMA busy_timeout=3000");
    registerHistoryFunctions(db);
    const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (version > HISTORY_STORE_VERSION) throw new Error(`unsupported history store version: ${version}`);
    configureSqlite(db);
    if (version === HISTORY_STORE_VERSION) { refreshHistoryViews(db); return db; }
    if (version === 1 && file !== ":memory:" && liveHistoryV1Writers(dirname(file)).length) return db;
    upgradeHistoryStore(db, file);
    return db;
  } catch (err) { db.close(); throw err; }
}

/** Views are derived; a store created by an earlier build gets the current definition. Best effort: a busy store
 * is retried on the next open. */
function refreshHistoryViews(db: DatabaseSync): void {
  const current = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='v_conversation_records'").get();
  if (!current || String(current.sql).includes("ab_body(")) return;
  try {
    db.exec("BEGIN IMMEDIATE");
    try { db.exec("DROP VIEW IF EXISTS v_conversation_records"); db.exec(CONVERSATION_RECORDS_VIEW); db.exec("COMMIT"); }
    catch (err) { db.exec("ROLLBACK"); throw err; }
  } catch (err) { if (!isSqliteBusy(err)) throw err; }
}

/** v1 (or empty) → v2 schema, under the migration lock; refuses while a v1 writer is alive. */
export function upgradeHistoryStore(db: DatabaseSync, file: string): void {
  if (Number(db.prepare("PRAGMA user_version").get()!.user_version) === HISTORY_STORE_VERSION) return;
  const release = migrationLock(file);
  try {
    const current = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (current === HISTORY_STORE_VERSION) return;
    if (current === 1 && file !== ":memory:") { const writers = liveHistoryV1Writers(dirname(file)); if (writers.length) deferUpgrade(writers); }
    db.exec("BEGIN IMMEDIATE");
    try {
      if (current === 1) {
        // Keep every v1 object. FTS shadow tables follow their virtual table's rename.
        for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) db.exec(`DROP TRIGGER ${quote(String(row.name))}`);
        const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        const virtual = tables.filter(row => /^CREATE VIRTUAL TABLE/i.test(String(row.sql))).map(row => String(row.name));
        for (const row of tables) {
          const name = String(row.name);
          if (virtual.some(v => name !== v && name.startsWith(`${v}_`))) continue;
          db.exec(`ALTER TABLE ${quote(name)} RENAME TO ${quote(HISTORY_V1_PREFIX + name)}`);
        }
        // Index names must not collide with v2's; v1 indexes keep working under v1_ names.
        for (const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all()) {
          const name = String(row.name);
          if (name.startsWith(HISTORY_V1_PREFIX)) continue;
          db.exec(`DROP INDEX ${quote(name)}`);
          db.exec(String(row.sql).replace(/^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?"?([^"\s(]+)"?/i, (_m, unique = "", ifne = "") => `CREATE ${unique}INDEX ${ifne}${quote(HISTORY_V1_PREFIX + name)}`));
        }
      }
      db.exec(historyStoreV2Schema());
      db.exec(`PRAGMA user_version=${HISTORY_STORE_VERSION}`);
      db.exec("COMMIT");
    } catch (err) { db.exec("ROLLBACK"); throw err; }
  } finally { release(); }
}

/** Durable snapshot/copy/verification chunks run only in the elected worker.
 * The legacy store and every snapshot are retained. */
export async function migrateHistoryStore(bridge: string, target: DatabaseSync, shouldPause: () => boolean = () => false, stopped: () => boolean = () => false, onLease?: (owner: string | null) => void, retryFailed = false, options: HistoryMigrationOptions = {}): Promise<void> {
  if (Number(target.prepare("PRAGMA user_version").get()!.user_version) !== HISTORY_STORE_VERSION) {
    // A deferred in-place upgrade (AB-225) runs here, in the elected worker, once no v1 writer is alive.
    await refreshStorePeerIdentities(dirname(bridge)).catch(() => {});
    upgradeHistoryStore(target, historyDbPath(bridge));
  }
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
      // A retry starts a fresh copy from a fresh snapshot; earlier partial copies are kept under renamed tables.
      retainFailedAttempt(target);
    }
    await resumableHistoryMigration(bridge, target, shouldPause, stopped, { transient: isTransientHistoryError, ...options });
  } catch (err) {
    const state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
    if (state && state.status !== "failed" && !isTransientHistoryError(err)) {
      target.prepare("UPDATE history_migration SET status='failed',manifest=? WHERE version=?").run(JSON.stringify({ error: String(err), resumeStatus: state.status }), HISTORY_STORE_VERSION);
    }
    throw err;
  } finally { release(); onLease?.(null); }
}

/** Environment errors pause and retry; only evidence that the data disagrees latches a failure (AB-238). */
const TRANSIENT_CODES = new Set(["HISTORY_MIGRATION_STOPPED", "HISTORY_DISK_SPACE", "HISTORY_SNAPSHOT_PAUSED", "STORE_UPGRADE_DEFERRED",
  "EBUSY", "EPERM", "EACCES", "ENOSPC", "EMFILE", "ENFILE", "EAGAIN", "EIO", "ETIMEDOUT", "EDQUOT", "ENOLCK"]);
export function isTransientHistoryError(err: unknown): boolean {
  if (isSqliteBusy(err)) return true;
  const value = err as { code?: unknown; errcode?: unknown; message?: unknown };
  if (TRANSIENT_CODES.has(String(value?.code))) return true;
  // SQLITE_IOERR (10), SQLITE_FULL (13), SQLITE_CANTOPEN (14) are environment conditions, not data disagreements.
  const primary = typeof value?.errcode === "number" ? value.errcode & 0xff : undefined;
  return primary === 10 || primary === 13 || primary === 14;
}

/** A failed copy is never erased: its rows move to retained_* tables and a fresh attempt starts. */
function retainFailedAttempt(target: DatabaseSync): void {
  const stamp = Date.now();
  target.exec("BEGIN IMMEDIATE");
  try {
    for (const name of HISTORY_V2_COPY_TABLES) {
      if (!Number(target.prepare(`SELECT count(*) n FROM ${quote(name)}`).get()!.n)) continue;
      target.exec(`CREATE TABLE ${quote(`retained_${stamp}_${name}`)} AS SELECT rowid AS retained_rowid,* FROM ${quote(name)}`);
      if (name === "conversation_records") target.exec("DROP TRIGGER IF EXISTS conversation_records_no_delete");
      if (name === "history_documents") clearHistoryDocuments(target);
      else target.exec(`DELETE FROM ${quote(name)}`);
    }
    target.exec(`CREATE TRIGGER IF NOT EXISTS conversation_records_no_delete BEFORE DELETE ON conversation_records BEGIN
 SELECT RAISE(ABORT,'conversation records are append-only'); END`);
    target.exec(`CREATE TABLE ${quote(`retained_${stamp}_history_migration`)} AS SELECT * FROM history_migration; DELETE FROM history_migration;`);
    target.exec(`CREATE TABLE ${quote(`retained_${stamp}_history_copy_state`)} AS SELECT * FROM history_copy_state; DELETE FROM history_copy_state;`);
    target.exec("COMMIT");
  } catch (err) { target.exec("ROLLBACK"); throw err; }
}

export function historyMigrationFailure(db: DatabaseSync): string | null {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='history_migration'").get()) return null;
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

const LEGACY_CONFLICTS = `CREATE TABLE IF NOT EXISTS history_legacy_conflicts(source_id INTEGER PRIMARY KEY, reason TEXT NOT NULL,
 source TEXT, generation INTEGER, offset INTEGER, conversation TEXT, at INTEGER, raw BLOB, body TEXT, part TEXT, recorded_at INTEGER NOT NULL)`;
export function legacyTailConflicts(db: DatabaseSync): number {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_legacy_conflicts'").get()
    ? Number(db.prepare("SELECT count(*) n FROM history_legacy_conflicts").get()!.n) : 0;
}

/** Old pinned writers may append to bridge.db after the snapshot. Retain their bytes by natural key,
 * remapping numeric ids so concurrent native ingestion can never overwrite a legacy row.
 * Cursor publication follows a committed record, and replay validates its raw bytes.
 * A row that conflicts with a native copy, or has no conversation, is retained verbatim in
 * history_legacy_conflicts and the tail moves on: one bad row never stops ingestion (AB-226, AB-240).
 * Its original also stays in bridge.db, and finalize stays blocked while conflicts exist. */
export function copyLegacyConversationTail(source: DatabaseSync, target: DatabaseSync): number {
  if (!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_records'").get()) return 0;
  const fts = !!target.prepare("SELECT name FROM sqlite_master WHERE name='history_fts'").get();
  const v2 = !!target.prepare("SELECT 1 FROM pragma_table_info('conversation_records') WHERE name='raw_codec'").get();
  const after = Number(target.prepare("SELECT cursor FROM history_cursors WHERE source='legacy-record-tail'").get()?.cursor ?? 0);
  const deadline = Date.now() + HISTORY_BATCH_MS;
  let work = 0;
  for (const row of source.prepare("SELECT * FROM conversation_records WHERE id>? ORDER BY id LIMIT ?").iterate(after, HISTORY_COPY_ROWS)) {
    const conversation = source.prepare("SELECT * FROM conversations WHERE id=?").get(row.conversation!);
    target.exec("BEGIN IMMEDIATE");
    try {
      const retain = (reason: "conflict" | "orphan") => {
        target.exec(LEGACY_CONFLICTS);
        target.prepare("INSERT OR IGNORE INTO history_legacy_conflicts VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .run(row.id!, reason, row.source ?? null, row.generation ?? null, row.offset ?? null, row.conversation ?? null, row.at ?? null, row.raw ?? null, row.body ?? null, row.part ?? null, Date.now());
      };
      if (!conversation) retain("orphan");
      else {
        const columns = Object.keys(conversation);
        target.prepare(`INSERT OR IGNORE INTO conversations(${columns.map(quote).join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(conversation));
        let copied = target.prepare("SELECT * FROM conversation_records WHERE source=? AND generation=? AND offset=?").get(row.source!, row.generation!, row.offset!);
        if (!copied) {
          const { id: _id, ...plain } = row;
          const encoded = v2 ? encodeHistoryRow("conversation_records", plain, fts) : plain;
          const names = ["source", "generation", "offset", "conversation", "at", "raw", ...(v2 ? ["raw_codec"] : []), "body", "part"];
          target.prepare(`INSERT INTO conversation_records(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`).run(...names.map(name => encoded[name] ?? null));
          copied = target.prepare("SELECT * FROM conversation_records WHERE source=? AND generation=? AND offset=?").get(row.source!, row.generation!, row.offset!)!;
        }
        const decoded = v2 ? decodeHistoryRow("conversation_records", copied) : copied;
        if (decoded.conversation !== row.conversation || !Buffer.from(decoded.raw as Uint8Array).equals(Buffer.from(row.raw as Uint8Array))) retain("conflict");
        else target.prepare("INSERT OR IGNORE INTO history_legacy_tail VALUES(?,?)").run(row.id!, copied.id!);
      }
      target.prepare("INSERT INTO history_cursors VALUES('legacy-record-tail',?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(String(row.id));
      target.exec("COMMIT");
    } catch (err) { target.exec("ROLLBACK"); throw err; }
    work++;
    if (Date.now() >= deadline) break;
  }
  return work;
}

/** Empty history_documents without the per-row FTS delete trigger: in v2 that trigger decodes every body
 * through a JavaScript function, and node:sqlite keeps those results alive until the statement ends, which
 * exhausts the heap on a real history. FTS5's own delete-all clears the index instead. Call inside a transaction. */
export function clearHistoryDocuments(db: DatabaseSync): void {
  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='history_delete'").get();
  if (!trigger) { db.exec("DELETE FROM history_documents"); return; }
  db.exec("DROP TRIGGER history_delete");
  db.exec("DELETE FROM history_documents");
  db.exec("INSERT INTO history_fts(history_fts) VALUES('delete-all')");
  db.exec(String(trigger.sql));
}
