import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { setTimeout as yieldBatch } from "node:timers/promises";
import { historySchema } from "./history-schema.js";
import { CONVERSATION_SCHEMA } from "./conversation-schema.js";
import { configureSqlite } from "./sqlite-policy.js";
import { migrationLock } from "./migration-lock.js";
import { snapshotDatabase } from "./sqlite-maintenance.js";

export const HISTORY_DB_NAME = "history.db";
export const HISTORY_STORE_VERSION = 1;
export const HISTORY_COPY_ROWS = 32;
export const HISTORY_BATCH_MS = 50;
export const HISTORY_COPY_BYTES = 512 * 1024;
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

type Row = Record<string, SQLInputValue>;
function digestRow(hash: ReturnType<typeof createHash>, row: Row): void {
  for (const [key, value] of Object.entries(row)) {
    const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
    hash.update(`${key.length}:${key}:${value === null ? "null" : value instanceof Uint8Array ? "blob" : typeof value}:${bytes.length}:`);
    hash.update(bytes);
  }
}
/** Copy from a protected WAL-inclusive snapshot, then compare every row and its SHA-256.
 * Never remove/rewrite legacy rows. Interrupted copies resume against the same snapshot.
 * Only the worker calls this: multi-GB snapshot/checksum I/O cannot block broker dispatch.
 */
export async function migrateHistoryStore(bridge: string, target: DatabaseSync, shouldPause: () => boolean = () => false, stopped: () => boolean = () => false, onLease?: (owner: string | null) => void): Promise<void> {
  if (historyReady(target)) return;
  const release = migrationLock(historyDbPath(bridge));
  let source: DatabaseSync | undefined;
  try {
    onLease?.(readFileSync(`${historyDbPath(bridge)}.migration-lock`,"utf8"));
    if (historyReady(target)) return;
    let state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
    if (!state) {
      const folder = join(dirname(bridge), ".migration-snapshots");
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const snapshot = join(folder, `bridge-history-v1-${randomUUID()}.db`);
      snapshotDatabase(bridge, snapshot);
      target.prepare("INSERT INTO history_migration VALUES(?,?,'copying',NULL)").run(HISTORY_STORE_VERSION, snapshot);
      state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION)!;
    }
    source = new DatabaseSync(String(state.snapshot), { readOnly: true, timeout: 3000 });
    const manifest: Record<string, { rows: number; sha256: string }> = {};
    const yieldTurn = async () => {
      await yieldBatch(10);
      while (shouldPause() && !stopped()) await yieldBatch(250);
      if (stopped()) throw new Error("History migration stopped; snapshot and partial copy preserved");
    };
    for (const table of HISTORY_TABLES) {
      if (!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const columns = source.prepare(`PRAGMA table_info(${quote(table)})`).all().map(r => String(r.name));
      const names = ["rowid", ...columns].map(quote).join(",");
      const insert = target.prepare(`INSERT OR IGNORE INTO ${quote(table)}(${names}) VALUES(${["rowid", ...columns].map(() => "?").join(",")})`);
      const expected = createHash("sha256"), actual = createHash("sha256");
      let after = 0, count = 0;
      for (;;) {
        await yieldTurn();
        // Keyset iteration also bounds memory for unusually large legacy records.
        const input = source.prepare(`SELECT rowid AS __copy_rowid,* FROM ${quote(table)} WHERE rowid>? ORDER BY rowid LIMIT ?`).iterate(after, HISTORY_COPY_ROWS);
        let batchRows = 0, bytes = 0;
        const started = Date.now();
        target.exec("BEGIN IMMEDIATE");
        try {
          for (const item of input) {
            const row = item as Row;
            insert.run(row.__copy_rowid!, ...columns.map(c => row[c]!));
            const copied = target.prepare(`SELECT rowid AS __copy_rowid,* FROM ${quote(table)} WHERE rowid=?`).get(row.__copy_rowid!) as Row;
            digestRow(expected, row); digestRow(actual, copied);
            after = Number(row.__copy_rowid); count++; batchRows++;
            bytes += Object.values(row).reduce<number>((n, v) => n + (v instanceof Uint8Array ? v.byteLength : typeof v === "string" ? Buffer.byteLength(v) : 8), 0);
            if (bytes >= HISTORY_COPY_BYTES || Date.now() - started >= HISTORY_BATCH_MS) break;
          }
          target.exec("COMMIT");
        } catch (err) { target.exec("ROLLBACK"); throw err; }
        if (!batchRows) break;
      }
      const sha256 = expected.digest("hex");
      const sourceCount = Number(source.prepare(`SELECT count(*) n FROM ${quote(table)}`).get()!.n);
      const targetCount = Number(target.prepare(`SELECT count(*) n FROM ${quote(table)}`).get()!.n);
      if (count !== sourceCount || targetCount !== sourceCount || sha256 !== actual.digest("hex")) throw new Error(`History migration verification failed: ${table}; legacy database and backup preserved`);
      manifest[table] = { rows: count, sha256 };
    }
    // Triggers built FTS as the bounded document copies committed; verify its index too.
    if (target.prepare("SELECT name FROM sqlite_master WHERE name='history_fts'").get()) target.exec("INSERT INTO history_fts(history_fts,rank) VALUES('integrity-check',1)");
    target.exec("BEGIN IMMEDIATE");
    try {
      const max = Number(source.prepare("SELECT coalesce(max(id),0) n FROM conversation_records").get()!.n);
      target.prepare("INSERT INTO history_cursors VALUES('legacy-record-tail',?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(String(max));
      target.prepare("UPDATE history_migration SET status='verified',manifest=? WHERE version=?").run(JSON.stringify(manifest), HISTORY_STORE_VERSION);
      target.exec("COMMIT");
    } catch (err) { target.exec("ROLLBACK"); throw err; }
  } finally { source?.close(); release(); onLease?.(null); }
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
