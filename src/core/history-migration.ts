import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { HISTORY_BATCH_MS, HISTORY_COPY_BYTES, HISTORY_COPY_ROWS, HISTORY_IO_BYTES_PER_SECOND, HISTORY_STORE_VERSION, HISTORY_TABLES, type HistoryMigrationProgress } from "./history-store.js";

type Row = Record<string, SQLInputValue>;
type Phase = "snapshot" | "copy" | "verify";
type State = { snapshot: string; status: string; manifest: string | null };
type TableState = { table_name: string; generation: number; upper_rowid: number | null; source_sql: string; estimate: number; snapshot_after: number | null; snapshot_done: number; snapshot_rows: number; snapshot_bytes: number; snapshot_verify_after: number | null; snapshot_verify_done: number; snapshot_verify_rows: number; copy_after: number | null; copy_done: number; copy_rows: number; verify_after: number | null; verify_done: number; verify_rows: number };
type Chunk = { after_rowid: number; first_after: number | null; row_count: number; sha256: string; bytes: number };
export interface HistoryMigrationOptions { ioBytesPerSecond?: number; onProgress?: (progress: HistoryMigrationProgress) => void }
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
const failure = (table: string) => Object.assign(new Error(`History migration verification failed: ${table}; all originals and snapshots preserved; explicit retry required`), { code: "HISTORY_VERIFICATION_FAILED" });
function digest(rows: Row[]): string {
  const hash = createHash("sha256");
  for (const row of rows) for (const [key, value] of Object.entries(row)) {
    const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
    hash.update(`${key.length}:${key}:${value === null ? "null" : value instanceof Uint8Array ? "blob" : typeof value}:${bytes.length}:`); hash.update(bytes);
  }
  return hash.digest("hex");
}
function reader(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 100 });
  try { db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100; PRAGMA cache_size=-2048; PRAGMA mmap_size=0"); return db; }
  catch (err) { db.close(); throw err; }
}
function columns(db: DatabaseSync, table: string): string[] { return db.prepare(`PRAGMA table_info(${q(table)})`).all().map(r => String(r.name)); }
function inputChunk(db: DatabaseSync, table: string, after: number | null, upper: number | null): Row[] {
  if (upper === null) return [];
  const query = db.prepare(`SELECT rowid AS __copy_rowid,* FROM ${q(table)} WHERE ${after === null ? "" : "rowid>? AND "}rowid<=? ORDER BY rowid LIMIT ?`);
  const args = after === null ? [upper, HISTORY_COPY_ROWS] : [after, upper, HISTORY_COPY_ROWS];
  const rows: Row[] = []; let bytes = 0; const start = Date.now();
  for (const value of query.iterate(...args)) {
    const row = value as Row; rows.push(row); bytes += rowBytes(row);
    if (bytes >= HISTORY_COPY_BYTES || Date.now() - start >= HISTORY_BATCH_MS) break;
  }
  return rows;
}
function rowBytes(row: Row): number { return Object.values(row).reduce<number>((n, v) => n + (v instanceof Uint8Array ? v.byteLength : typeof v === "string" ? Buffer.byteLength(v) : 8), 0); }
function rangeRows(db: DatabaseSync, table: string, chunk: Chunk): Row[] {
  // One persisted chunk is bounded by the original row/byte budget. LIMIT detects
  // an unexpected extra row without materializing a mutated table.
  const query = db.prepare(`SELECT rowid AS __copy_rowid,* FROM ${q(table)} WHERE ${chunk.first_after === null ? "" : "rowid>? AND "}rowid<=? ORDER BY rowid LIMIT ?`);
  return query.all(...(chunk.first_after === null ? [chunk.after_rowid, chunk.row_count + 1] : [chunk.first_after, chunk.after_rowid, chunk.row_count + 1])) as Row[];
}
function checkChunk(db: DatabaseSync, table: string, chunk: Chunk): void {
  const rows = rangeRows(db, table, chunk);
  if (rows.length !== chunk.row_count || digest(rows) !== chunk.sha256) throw failure(table);
}
function insertRows(db: DatabaseSync, table: string, rows: Row[], names: string[]): void {
  const insert = db.prepare(`INSERT OR IGNORE INTO ${q(table)}(${["rowid", ...names].map(q).join(",")}) VALUES(${["rowid", ...names].map(() => "?").join(",")})`);
  for (const row of rows) insert.run(row.__copy_rowid!, ...names.map(name => row[name]!));
}
const SCHEMA = `CREATE TABLE table_state (
 table_name TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,upper_rowid INTEGER,source_sql TEXT NOT NULL,estimate INTEGER NOT NULL,
 snapshot_after INTEGER,snapshot_done INTEGER NOT NULL DEFAULT 0,snapshot_rows INTEGER NOT NULL DEFAULT 0,snapshot_bytes INTEGER NOT NULL DEFAULT 0,
 snapshot_verify_after INTEGER,snapshot_verify_done INTEGER NOT NULL DEFAULT 0,snapshot_verify_rows INTEGER NOT NULL DEFAULT 0,
 copy_after INTEGER,copy_done INTEGER NOT NULL DEFAULT 0,copy_rows INTEGER NOT NULL DEFAULT 0,
 verify_after INTEGER,verify_done INTEGER NOT NULL DEFAULT 0,verify_rows INTEGER NOT NULL DEFAULT 0);
CREATE TABLE chunks(table_name TEXT NOT NULL,generation INTEGER NOT NULL,first_after INTEGER,after_rowid INTEGER NOT NULL,row_count INTEGER NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(table_name,generation,after_rowid));
CREATE TABLE artifacts(table_name TEXT NOT NULL,generation INTEGER NOT NULL,archived_table TEXT NOT NULL,PRIMARY KEY(table_name,generation));
PRAGMA user_version=1;`;

/** Cold-start read only. Callers cache the result; request handlers never use it. */
export function readHistoryMigrationProgress(target: DatabaseSync, ioBytesPerSecond = HISTORY_IO_BYTES_PER_SECOND): HistoryMigrationProgress {
  const state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION) as State | undefined;
  const result: HistoryMigrationProgress = { phase: "starting", percent: 0, etaSeconds: null, paused: false, completedRows: 0, totalRows: 0, snapshot: state?.snapshot ?? null, ioBytesPerSecond, error: null };
  if (!state) return result;
  if (state.status === "verified") return { ...result, phase: "verified", percent: 100, etaSeconds: 0 };
  if (state.status === "failed") {
    let error = "History migration failed; explicit retry required";
    try { error = String(JSON.parse(state.manifest!).error); } catch { /* Keep the persisted failure latched. */ }
    return { ...result, phase: "failed", error };
  }
  result.phase = state.status === "snapshotting" ? "snapshot" : "copy";
  const file = `${state.snapshot}.progress.db`;
  if (!existsSync(file)) return result;
  const meta = reader(file);
  try {
    if (Number(meta.prepare("PRAGMA user_version").get()!.user_version) !== 1) return result;
    const totals = meta.prepare("SELECT coalesce(sum(snapshot_rows+snapshot_verify_rows+copy_rows+verify_rows),0) done,coalesce(sum(estimate),0)*4 total,coalesce(sum(snapshot_done=0 OR snapshot_verify_done=0),0) snapshot,coalesce(sum(copy_done=0),0) copy FROM table_state").get()!;
    result.completedRows = Number(totals.done); result.totalRows = Math.max(result.completedRows, Number(totals.total));
    result.percent = result.totalRows ? Math.min(99.99, 100 * result.completedRows / result.totalRows) : 0;
    result.phase = Number(totals.snapshot) ? "snapshot" : Number(totals.copy) ? "copy" : "verify";
    return result;
  } finally { meta.close(); }
}

/** All data movement is performed in the elected history worker. Checkpoints live
 * beside their retained snapshot; snapshot data and cursors commit atomically using
 * SQLite's attached rollback-journal transaction. Target commits precede checkpoints,
 * so a crash can only cause idempotent, byte-verified replay of the last chunk. */
export async function resumableHistoryMigration(bridge: string, target: DatabaseSync, paused: () => boolean, stopped: () => boolean, options: HistoryMigrationOptions = {}): Promise<void> {
  const limit = options.ioBytesPerSecond ?? HISTORY_IO_BYTES_PER_SECOND;
  if (!Number.isFinite(limit) || limit < 64 * 1024 || limit > 256 * 1024 * 1024) throw new Error("History migration I/O limit must be between 64 KiB/s and 256 MiB/s");
  let state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION) as State | undefined;
  let phase: Phase = state?.status === "copying" ? "copy" : "snapshot";
  let pinned = false, nextAt = 0, pressureSince = 0;
  let meta: DatabaseSync | undefined, source: DatabaseSync | undefined, backup: DatabaseSync | undefined;
  let progress: HistoryMigrationProgress = { phase, percent: 0, etaSeconds: null, paused: false, completedRows: 0, totalRows: 0, snapshot: state?.snapshot ?? null, ioBytesPerSecond: limit, error: null };
  const start = Date.now(); let startRows = 0;
  const emit = (changes: Partial<HistoryMigrationProgress> = {}) => {
    if (meta) {
      const totals = meta.prepare("SELECT coalesce(sum(snapshot_rows+snapshot_verify_rows+copy_rows+verify_rows),0) done,coalesce(sum(estimate),0)*4 total FROM table_state").get()!;
      progress.completedRows = Number(totals.done); progress.totalRows = Math.max(progress.completedRows, Number(totals.total));
      progress.percent = progress.totalRows ? Math.min(99.99, 100 * progress.completedRows / progress.totalRows) : 0;
      const work = progress.completedRows - startRows;
      progress.etaSeconds = work > 0 ? Math.ceil((Date.now() - start) / 1000 / work * (progress.totalRows - progress.completedRows)) : null;
    }
    progress = { ...progress, phase, ...changes }; options.onProgress?.({ ...progress });
  };
  const gap = async () => {
    await delay(10);
    for (;;) {
      if (stopped()) throw Object.assign(new Error("History migration stopped; snapshot and durable chunk cursors preserved"), { code: "HISTORY_MIGRATION_STOPPED" });
      if (paused()) {
        if (!pressureSince) { pressureSince = Date.now(); emit({ paused: true }); }
        // Ending a pinned read view does not abandon its completed chunks. The next
        // idle gap revalidates mutable prefixes against one new consistent view.
        if (pinned && Date.now() - pressureSince >= 2000) throw Object.assign(new Error("History snapshot paused; durable chunks preserved"), { code: "HISTORY_SNAPSHOT_PAUSED" });
        await delay(100); continue;
      }
      if (pressureSince) { pressureSince = 0; emit({ paused: false }); }
      const remaining = nextAt - Date.now();
      if (remaining <= 0) return;
      await delay(Math.min(100, remaining));
    }
  };
  const pace = (bytes: number, since: number) => { nextAt = since + Math.ceil(bytes * 1000 / limit); };
  const tables = () => meta!.prepare("SELECT * FROM table_state ORDER BY rowid").all() as unknown as TableState[];
  const current = (name: string) => meta!.prepare("SELECT * FROM table_state WHERE table_name=?").get(name) as unknown as TableState;
  const nextChunk = (table: TableState, after: number | null) => meta!.prepare(`SELECT * FROM chunks WHERE table_name=? AND generation=? ${after === null ? "" : "AND after_rowid>?"} ORDER BY after_rowid LIMIT 1`).get(...(after === null ? [table.table_name, table.generation] : [table.table_name, table.generation, after])) as Chunk | undefined;
  try {
    await gap();
    if (!state) {
      const folder = join(dirname(bridge), ".migration-snapshots"); mkdirSync(folder, { recursive: true, mode: 0o700 });
      const snapshot = join(folder, `bridge-history-v1-${randomUUID()}.db`);
      state = { snapshot, status: "snapshotting", manifest: null };
      target.prepare("INSERT INTO history_migration VALUES(?,?,'snapshotting',NULL)").run(HISTORY_STORE_VERSION, snapshot);
    }
    progress.snapshot = state.snapshot;
    const progressFile = `${state.snapshot}.progress.db`;
    meta = new DatabaseSync(progressFile, { timeout: 100 });
    meta.exec("PRAGMA busy_timeout=100; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048");
    const version = Number(meta.prepare("PRAGMA user_version").get()!.user_version);
    if (version > 1) throw new Error(`unsupported history migration checkpoint version: ${version}`);
    if (!version) { meta.exec("BEGIN IMMEDIATE"); try { meta.exec(SCHEMA); meta.exec("COMMIT"); } catch (err) { meta.exec("ROLLBACK"); throw err; } }
    const legacySnapshot = state.status === "copying" && (!meta.prepare("SELECT 1 FROM table_state LIMIT 1").get() || !!meta.prepare("SELECT 1 FROM table_state WHERE snapshot_done=0 OR snapshot_verify_done=0 LIMIT 1").get());
    if (state.status === "snapshotting" || legacySnapshot) {
      phase = "snapshot"; emit(); await gap();
      source = reader(legacySnapshot ? state.snapshot : bridge);
      source.exec("BEGIN"); pinned = !legacySnapshot;
      const schemas = source.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all();
      for (const name of HISTORY_TABLES) {
        const schema = schemas.find(row => row.name === name); if (!schema) continue;
        const max = source.prepare(`SELECT max(rowid) n FROM ${q(name)}`).get()!.n as number | null;
        meta.prepare("INSERT OR IGNORE INTO table_state(table_name,upper_rowid,source_sql,estimate) VALUES(?,?,?,?)").run(name, max, schema.sql!, Math.max(0, max ?? 0));
      }
      backup = legacySnapshot ? undefined : new DatabaseSync(state.snapshot, { timeout: 100 });
      if (backup) {
        backup.exec("PRAGMA busy_timeout=100; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA mmap_size=0");
        backup.prepare("ATTACH DATABASE ? AS progress").run(progressFile);
      }
      startRows = tables().reduce((n, table) => n + table.snapshot_rows + table.snapshot_verify_rows + table.copy_rows + table.verify_rows, 0);
      for (let table of tables()) {
        await gap();
        // A new read view must include every retained mutable prefix unchanged. Raw
        // records with both append-only guards can safely retain their initial fence.
        const guards = table.table_name === "conversation_records" && source.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name IN ('conversation_records_no_delete','conversation_records_no_update')").get()!.n === 2;
        let changed = false;
        if (!legacySnapshot && table.snapshot_after !== null && !guards) {
          let after: number | null = null;
          for (;;) {
            const chunk = nextChunk(table, after); if (!chunk) break;
            await gap(); const since = Date.now();
            try { checkChunk(source, table.table_name, chunk); } catch (err) { if ((err as { code?: string }).code !== "HISTORY_VERIFICATION_FAILED") throw err; changed = true; break; }
            pace(chunk.bytes, since); after = chunk.after_rowid;
          }
        }
        const max = source.prepare(`SELECT max(rowid) n FROM ${q(table.table_name)}`).get()!.n as number | null;
        if (!legacySnapshot && !guards && ((table.upper_rowid ?? 0) > (max ?? 0) || table.source_sql !== String(schemas.find(row => row.name === table.table_name)?.sql))) changed = true;
        if (changed) {
          // Archive the entire old table generation inside the retained snapshot.
          // Data and generation bookkeeping commit together; no row is deleted.
          const archived = `retained_${table.table_name}_${randomUUID().replaceAll("-", "")}`;
          backup!.exec("BEGIN IMMEDIATE");
          try {
            backup!.exec(`ALTER TABLE ${q(table.table_name)} RENAME TO ${q(archived)}`);
            const sql = String(schemas.find(row => row.name === table.table_name)!.sql);
            backup!.exec(sql);
            backup!.prepare("INSERT INTO progress.artifacts VALUES(?,?,?)").run(table.table_name, table.generation, archived);
            backup!.prepare("UPDATE progress.table_state SET generation=generation+1,upper_rowid=?,source_sql=?,estimate=?,snapshot_after=NULL,snapshot_done=0,snapshot_rows=0,snapshot_bytes=0,snapshot_verify_after=NULL,snapshot_verify_done=0,snapshot_verify_rows=0,copy_after=NULL,copy_done=0,copy_rows=0,verify_after=NULL,verify_done=0,verify_rows=0 WHERE table_name=?").run(max, sql, Math.max(0, max ?? 0), table.table_name);
            backup!.exec("COMMIT");
          } catch (err) { backup!.exec("ROLLBACK"); throw err; }
          table = current(table.table_name);
        } else if (!legacySnapshot && !guards && table.upper_rowid !== max) {
          meta.prepare("UPDATE table_state SET upper_rowid=?,estimate=?,snapshot_done=0,snapshot_verify_done=0 WHERE table_name=?").run(max, Math.max(table.snapshot_rows, max ?? 0), table.table_name);
          table = current(table.table_name);
        }
        if (backup && !backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table.table_name)) backup.exec(table.source_sql);
        const names = columns(source, table.table_name);
        while (!table.snapshot_done) {
          await gap(); const since = Date.now(), rows = inputChunk(source, table.table_name, table.snapshot_after, table.upper_rowid);
          if (!rows.length) {
            meta.prepare("UPDATE table_state SET snapshot_done=1,estimate=snapshot_rows WHERE table_name=?").run(table.table_name); break;
          }
          const chunk: Chunk = { first_after: table.snapshot_after, after_rowid: Number(rows.at(-1)!.__copy_rowid), row_count: rows.length, sha256: digest(rows), bytes: rows.reduce((n, row) => n + rowBytes(row), 0) };
          const writer = backup ?? meta, prefix = backup ? "progress." : "";
          writer.exec("BEGIN IMMEDIATE");
          try {
            if (backup) { insertRows(backup, table.table_name, rows, names); checkChunk(backup, table.table_name, chunk); }
            writer.prepare(`INSERT OR IGNORE INTO ${prefix}chunks VALUES(?,?,?,?,?,?,?)`).run(table.table_name, table.generation, chunk.first_after, chunk.after_rowid, chunk.row_count, chunk.sha256, chunk.bytes);
            writer.prepare(`UPDATE ${prefix}table_state SET snapshot_after=?,snapshot_rows=snapshot_rows+?,snapshot_bytes=snapshot_bytes+? WHERE table_name=?`).run(chunk.after_rowid, chunk.row_count, chunk.bytes, table.table_name);
            writer.exec("COMMIT");
          } catch (err) { writer.exec("ROLLBACK"); throw err; }
          pace(chunk.bytes * 3, since); table = current(table.table_name); emit();
        }
      }
      source.exec("ROLLBACK"); source.close(); source = undefined; pinned = false;
      backup?.close(); backup = undefined;
      source = reader(state.snapshot);
      // Snapshot verification has its own durable cursor and runs from a fresh
      // reader. Completed verification chunks survive pressure pauses and restarts.
      for (let table of tables()) while (!table.snapshot_verify_done) {
        await gap(); const chunk = nextChunk(table, table.snapshot_verify_after);
        if (!chunk) { meta.prepare("UPDATE table_state SET snapshot_verify_done=1 WHERE table_name=?").run(table.table_name); break; }
        const since = Date.now(); checkChunk(source, table.table_name, chunk); pace(chunk.bytes, since);
        meta.prepare("UPDATE table_state SET snapshot_verify_after=?,snapshot_verify_rows=snapshot_verify_rows+? WHERE table_name=?").run(chunk.after_rowid, chunk.row_count, table.table_name);
        table = current(table.table_name); emit();
      }
      source.close(); source = undefined;
      target.prepare("UPDATE history_migration SET status='copying' WHERE version=?").run(HISTORY_STORE_VERSION); state.status = "copying";
    }
    source = reader(state.snapshot);
    const manifest: Record<string, { rows: number; sha256: string }> = {};
    phase = "copy"; emit();
    for (let table of tables()) {
      const names = columns(source, table.table_name);
      while (!table.copy_done) {
        await gap(); const chunk = nextChunk(table, table.copy_after);
        if (!chunk) { meta.prepare("UPDATE table_state SET copy_done=1 WHERE table_name=?").run(table.table_name); break; }
        const since = Date.now(), rows = rangeRows(source, table.table_name, chunk);
        if (rows.length !== chunk.row_count || digest(rows) !== chunk.sha256) throw failure(`snapshot ${table.table_name}`);
        target.exec("BEGIN IMMEDIATE");
        try { insertRows(target, table.table_name, rows, names); checkChunk(target, table.table_name, chunk); target.exec("COMMIT"); }
        catch (err) { target.exec("ROLLBACK"); throw err; }
        meta.prepare("UPDATE table_state SET copy_after=?,copy_rows=copy_rows+? WHERE table_name=?").run(chunk.after_rowid, chunk.row_count, table.table_name);
        pace(chunk.bytes * 3, since); table = current(table.table_name); emit();
      }
    }
    phase = "verify"; emit();
    for (let table of tables()) {
      while (!table.verify_done) {
        await gap(); const chunk = nextChunk(table, table.verify_after);
        if (!chunk) {
          const extra = table.snapshot_after === null ? target.prepare(`SELECT rowid FROM ${q(table.table_name)} LIMIT 1`).get() : target.prepare(`SELECT rowid FROM ${q(table.table_name)} WHERE rowid>? LIMIT 1`).get(table.snapshot_after);
          if (extra) throw failure(`extra rows in ${table.table_name}`);
          meta.prepare("UPDATE table_state SET verify_done=1 WHERE table_name=?").run(table.table_name); break;
        }
        const since = Date.now(); checkChunk(target, table.table_name, chunk); pace(chunk.bytes, since);
        meta.prepare("UPDATE table_state SET verify_after=?,verify_rows=verify_rows+? WHERE table_name=?").run(chunk.after_rowid, chunk.row_count, table.table_name);
        table = current(table.table_name); emit();
      }
      const hash = createHash("sha256");
      // A streaming manifest of verified chunk hashes is independent of process
      // hash-state and can be reconstructed without rereading retained payloads.
      let manifestRows = 0;
      for (const chunk of meta.prepare("SELECT * FROM chunks WHERE table_name=? AND generation=? ORDER BY after_rowid").iterate(table.table_name, table.generation)) {
        hash.update(`${chunk.after_rowid}:${chunk.row_count}:${chunk.sha256};`);
        if (++manifestRows % 128 === 0) await gap();
      }
      manifest[table.table_name] = { rows: table.snapshot_rows, sha256: hash.digest("hex") };
    }
    await gap();
    target.exec("BEGIN IMMEDIATE");
    try {
      const hasRecords = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_records'").get();
      const max = hasRecords ? Number(source.prepare("SELECT coalesce(max(id),0) n FROM conversation_records").get()!.n) : 0;
      target.prepare("INSERT INTO history_cursors VALUES('legacy-record-tail',?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(String(max));
      target.prepare("UPDATE history_migration SET status='verified',manifest=? WHERE version=?").run(JSON.stringify(manifest), HISTORY_STORE_VERSION); target.exec("COMMIT");
    } catch (err) { target.exec("ROLLBACK"); throw err; }
    emit({ phase: "verified", percent: 100, etaSeconds: 0, paused: false });
  } catch (err) {
    const code = (err as { code?: string }).code;
    emit(code === "HISTORY_MIGRATION_STOPPED" || code === "HISTORY_SNAPSHOT_PAUSED" ? { paused: true } : { phase: "failed", error: String(err), etaSeconds: null });
    throw err;
  } finally { source?.close(); backup?.close(); meta?.close(); }
}
