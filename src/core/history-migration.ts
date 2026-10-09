import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { decodeBytes, decodeText, encodeBytes, encodeText, registerHistoryFunctions } from "./history-codec.js";
import { HISTORY_V2_COPY_TABLES } from "./history-schema-v2.js";
import { HISTORY_BATCH_MS, HISTORY_COPY_BYTES, HISTORY_COPY_ROWS, HISTORY_IO_BYTES_PER_SECOND, HISTORY_STORE_VERSION, type HistoryMigrationProgress } from "./history-store.js";
import { fastSnapshot } from "./sqlite-fast-snapshot.js";

type Row = Record<string, SQLInputValue>;
type State = { snapshot: string; status: string; manifest: string | null; source: string | null };
type CopyState = { table_name: string; source_rows: number; after_rowid: number | null; copied_rows: number; copy_sha256: string; verify_after: number | null; verified_rows: number; verify_sha256: string; done: number; verified: number };
export interface HistoryMigrationOptions { ioBytesPerSecond?: number; onProgress?: (progress: HistoryMigrationProgress) => void; snapshot?: typeof fastSnapshot; transient?: (err: unknown) => boolean }
/** v1 tables kept inside history.db by the v1→v2 upgrade carry this prefix. */
export const HISTORY_V1_PREFIX = "v1_";
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
const failure = (detail: string) => Object.assign(new Error(`History migration verification failed: ${detail}; all originals and snapshots preserved; explicit retry required`), { code: "HISTORY_VERIFICATION_FAILED" });

/** Must stay identical to history.ts folded(): legacy folded columns were produced by it. */
export function foldedText(text: string): string { return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase(); }

function digestRows(rows: Row[], names: readonly string[]): string {
  const hash = createHash("sha256");
  for (const row of rows) for (const key of names) {
    const value = row[key] ?? null;
    const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
    hash.update(`${key.length}:${key}:${value === null ? "null" : value instanceof Uint8Array ? "blob" : typeof value}:${bytes.length}:`); hash.update(bytes);
  }
  return hash.digest("hex");
}
/** Chained per row, so the result does not depend on how a pass cut the rows into batches. */
export function chainRows(previous: string, rows: Row[], names: readonly string[]): string {
  let hash = previous;
  for (const row of rows) hash = createHash("sha256").update(hash).update(digestRows([row], names)).digest("hex");
  return hash;
}
function rowBytes(row: Row): number { return Object.values(row).reduce<number>((n, v) => n + (v instanceof Uint8Array ? v.byteLength : typeof v === "string" ? Buffer.byteLength(v) : 8), 0); }

/** Legacy row → v2 row. Lossless: anything that cannot be reproduced exactly is stored as-is. */
export function encodeHistoryRow(table: string, row: Row, fts: boolean): Row {
  if (table === "conversation_records") {
    const raw = row.raw instanceof Uint8Array ? Buffer.from(row.raw) : Buffer.from(String(row.raw ?? ""), "utf8");
    const encoded = encodeBytes(raw);
    const body = row.body === null || row.body === undefined ? null : String(row.body);
    return { ...row, raw: encoded.value, raw_codec: encoded.codec, body: body !== null && body === raw.toString("utf8") ? null : body };
  }
  if (table === "history_documents") {
    const body = String(row.body ?? "");
    const encoded = encodeText(body);
    const folded = row.folded === null || row.folded === undefined ? null : String(row.folded);
    return { ...row, body: encoded.value, body_codec: encoded.codec, folded: fts && folded !== null && folded === foldedText(body) ? null : folded };
  }
  return row;
}

/** v2 row → the exact legacy row (for verification, mirrors and the viewer's export). */
export function decodeHistoryRow(table: string, row: Row): Row {
  if (table === "conversation_records") {
    const raw = decodeBytes(row.raw, row.raw_codec);
    const { raw_codec: _codec, ...rest } = row;
    return { ...rest, raw, body: row.body === null || row.body === undefined ? raw.toString("utf8") : row.body };
  }
  if (table === "history_documents") {
    const body = decodeText(row.body, row.body_codec);
    const { body_codec: _codec, ...rest } = row;
    return { ...rest, body, folded: row.folded === null || row.folded === undefined ? foldedText(body) : row.folded };
  }
  return row;
}

function sourceColumns(db: DatabaseSync, table: string): string[] { return db.prepare(`PRAGMA table_info(${q(table)})`).all().map(r => String(r.name)); }

/** Cold-start read only. Callers cache the result; request handlers never use it. */
export function readHistoryMigrationProgress(target: DatabaseSync, ioBytesPerSecond = HISTORY_IO_BYTES_PER_SECOND): HistoryMigrationProgress {
  const result: HistoryMigrationProgress = { phase: "starting", percent: 0, etaSeconds: null, paused: false, completedRows: 0, totalRows: 0, snapshot: null, ioBytesPerSecond, error: null };
  if (!target.prepare("SELECT name FROM sqlite_master WHERE name='history_migration'").get()) return result;
  const state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION) as State | undefined;
  if (!state) return result;
  result.snapshot = state.snapshot;
  if (state.status === "verified") return { ...result, phase: "verified", percent: 100, etaSeconds: 0 };
  if (state.status === "failed") {
    let error = "History migration failed; explicit retry required";
    try { error = String(JSON.parse(state.manifest!).error); } catch { /* Keep the persisted failure latched. */ }
    return { ...result, phase: "failed", error };
  }
  if (state.status === "snapshotting") return { ...result, phase: "snapshot" };
  const totals = target.prepare("SELECT coalesce(sum(copied_rows+verified_rows),0) done,coalesce(sum(source_rows),0)*2 total,coalesce(sum(done=0),0) copying FROM history_copy_state").get()!;
  result.completedRows = Number(totals.done); result.totalRows = Math.max(result.completedRows, Number(totals.total));
  result.percent = result.totalRows ? Math.min(99.99, 100 * result.completedRows / result.totalRows) : 0;
  result.phase = Number(totals.copying) ? "copy" : "verify";
  return result;
}

/** Free space for the source snapshot plus the compressed copy, with headroom. Never latches a failure. */
function assertDiskSpace(source: string, folder: string): void {
  const needed = statSync(source).size * 1.5 + 1024 ** 3;
  const fs = statfsSync(folder);
  const free = fs.bavail * fs.bsize;
  if (free < needed) throw Object.assign(new Error(`History migration needs about ${Math.ceil(needed / 1024 ** 3)} GiB free next to ${folder}; ${Math.floor(free / 1024 ** 3)} GiB available. Nothing changed; it resumes when space is available.`), { code: "HISTORY_DISK_SPACE" });
}

/** v2 migration, run only in the elected history worker:
 * 1. a consistent snapshot of the legacy store (bridge.db, or history.db for a verified v1 store) in seconds;
 * 2. copy in bounded batches, each encoded, read back, decoded and compared byte-for-byte before its cursor commits
 *    in the same transaction (resumable after a crash or kill at any point; no duplicates, no gaps);
 * 3. a full second verification pass against the snapshot;
 * 4. only then the store is marked verified and readers switch. The legacy store and the snapshot are retained. */
export async function resumableHistoryMigration(bridge: string, target: DatabaseSync, paused: () => boolean, stopped: () => boolean, options: HistoryMigrationOptions = {}): Promise<void> {
  const limit = options.ioBytesPerSecond ?? HISTORY_IO_BYTES_PER_SECOND;
  const transient = options.transient ?? ((err: unknown) => (err as { code?: string }).code === "HISTORY_DISK_SPACE");
  if (!Number.isFinite(limit) || limit < 64 * 1024 || limit > 1024 * 1024 * 1024) throw new Error("History migration I/O limit must be between 64 KiB/s and 1 GiB/s");
  registerHistoryFunctions(target);
  const fts = !!target.prepare("SELECT name FROM sqlite_master WHERE name='history_fts'").get();
  let state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION) as State | undefined;
  let nextAt = 0, pressureSince = 0, source: DatabaseSync | undefined;
  let progress: HistoryMigrationProgress = { ...readHistoryMigrationProgress(target, limit), paused: false };
  let start = Date.now(), startRows = progress.completedRows;
  const emit = (changes: Partial<HistoryMigrationProgress> = {}) => {
    const current = readHistoryMigrationProgress(target, limit);
    const work = current.completedRows - startRows;
    progress = { ...current, etaSeconds: work > 0 ? Math.ceil((Date.now() - start) / 1000 / work * (current.totalRows - current.completedRows)) : null, ...changes };
    options.onProgress?.({ ...progress });
  };
  const gap = async () => {
    await delay(5);
    for (;;) {
      if (stopped()) throw Object.assign(new Error("History migration stopped; snapshot and durable copy cursors preserved"), { code: "HISTORY_MIGRATION_STOPPED" });
      if (paused()) {
        if (!pressureSince) { pressureSince = Date.now(); emit({ paused: true }); }
        await delay(100); continue;
      }
      if (pressureSince) { pressureSince = 0; emit({ paused: false }); }
      const remaining = nextAt - Date.now();
      if (remaining <= 0) return;
      await delay(Math.min(100, remaining));
    }
  };
  const pace = (bytes: number, since: number) => { nextAt = since + Math.ceil(bytes * 1000 / limit); };
  const table = (name: string) => target.prepare("SELECT * FROM history_copy_state WHERE table_name=?").get(name) as unknown as CopyState | undefined;
  try {
    await gap();
    if (!state) {
      const v1 = target.prepare("SELECT name FROM sqlite_master WHERE name=?").get(`${HISTORY_V1_PREFIX}history_migration`)
        ? target.prepare(`SELECT status FROM ${q(`${HISTORY_V1_PREFIX}history_migration`)} WHERE version=1`).get() : undefined;
      const kind = v1?.status === "verified" ? "history-v1" : "bridge";
      const folder = join(dirname(bridge), ".migration-snapshots"); mkdirSync(folder, { recursive: true, mode: 0o700 });
      state = { snapshot: join(folder, `history-v2-source-${randomUUID()}.db`), status: "snapshotting", manifest: null, source: kind };
      target.prepare("INSERT INTO history_migration(version,snapshot,status,manifest,source) VALUES(?,?,'snapshotting',NULL,?)").run(HISTORY_STORE_VERSION, state.snapshot, kind);
    }
    const sourceFile = state.source === "history-v1" ? join(dirname(bridge), "history.db") : bridge;
    const prefix = state.source === "history-v1" ? HISTORY_V1_PREFIX : "";
    if (state.status === "snapshotting") {
      emit({ phase: "snapshot" });
      assertDiskSpace(sourceFile, dirname(state.snapshot));
      // An interrupted snapshot is never trusted or overwritten; it is kept beside the new one.
      if (existsSync(state.snapshot)) renameSync(state.snapshot, `${state.snapshot}.interrupted-${Date.now()}`);
      await (options.snapshot ?? fastSnapshot)(sourceFile, state.snapshot, { method: "copy", allowCheckpoint: true });
      source = new DatabaseSync(state.snapshot, { readOnly: true });
      target.exec("BEGIN IMMEDIATE");
      try {
        for (const name of HISTORY_V2_COPY_TABLES) {
          if (!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(prefix + name)) continue;
          const max = Number(source.prepare(`SELECT coalesce(max(rowid),0) n FROM ${q(prefix + name)}`).get()!.n);
          target.prepare("INSERT OR IGNORE INTO history_copy_state(table_name,source_rows) VALUES(?,?)").run(name, max);
        }
        target.prepare("UPDATE history_migration SET status='copying' WHERE version=?").run(HISTORY_STORE_VERSION);
        target.exec("COMMIT");
      } catch (err) { target.exec("ROLLBACK"); throw err; }
      state.status = "copying";
    }
    source ??= new DatabaseSync(state.snapshot, { readOnly: true });
    source.exec("PRAGMA query_only=ON; PRAGMA cache_size=-8192");
    start = Date.now(); startRows = readHistoryMigrationProgress(target, limit).completedRows;
    emit({ phase: "copy" });
    const read = (name: string, after: number | null) => {
      const rows: Row[] = []; let bytes = 0; const began = Date.now();
      for (const value of source!.prepare(`SELECT rowid AS __rowid,* FROM ${q(prefix + name)} WHERE rowid>? ORDER BY rowid LIMIT ?`).iterate(after ?? -1, HISTORY_COPY_ROWS)) {
        rows.push(value as Row); bytes += rowBytes(value as Row);
        if (bytes >= HISTORY_COPY_BYTES || Date.now() - began >= HISTORY_BATCH_MS) break;
      }
      return { rows, bytes };
    };
    const targetRange = (name: string, first: number, last: number, count: number) =>
      target.prepare(`SELECT rowid AS __rowid,* FROM ${q(name)} WHERE rowid>=? AND rowid<=? ORDER BY rowid LIMIT ?`).all(first, last, count + 1) as Row[];
    for (const name of HISTORY_V2_COPY_TABLES) {
      let current = table(name); if (!current) continue;
      const names = sourceColumns(source, prefix + name), digestNames = ["__rowid", ...names];
      const columns = Object.keys(encodeHistoryRow(name, Object.fromEntries(names.map(n => [n, null])) as Row, fts));
      const insert = target.prepare(`INSERT INTO ${q(name)}(rowid,${columns.map(q).join(",")}) VALUES(?,${columns.map(() => "?").join(",")})`);
      while (!current.done) {
        await gap();
        const since = Date.now(), { rows, bytes } = read(name, current.after_rowid);
        if (!rows.length) { target.prepare("UPDATE history_copy_state SET done=1 WHERE table_name=?").run(name); break; }
        const expected = digestRows(rows, digestNames);
        target.exec("BEGIN IMMEDIATE");
        try {
          for (const row of rows) {
            const { __rowid, ...plain } = row;
            const encoded = encodeHistoryRow(name, plain, fts);
            insert.run(__rowid!, ...columns.map(column => encoded[column] ?? null));
          }
          const copied = targetRange(name, Number(rows[0]!.__rowid), Number(rows.at(-1)!.__rowid), rows.length).map(row => decodeHistoryRow(name, row));
          if (copied.length !== rows.length || digestRows(copied, digestNames) !== expected) throw failure(`${name} rows after ${current.after_rowid ?? 0}`);
          target.prepare("UPDATE history_copy_state SET after_rowid=?,copied_rows=copied_rows+?,copy_sha256=? WHERE table_name=?").run(Number(rows.at(-1)!.__rowid), rows.length, chainRows(current.copy_sha256, rows, digestNames), name);
          target.exec("COMMIT");
        } catch (err) { target.exec("ROLLBACK"); throw err; }
        pace(bytes * 2, since); current = table(name)!; emit({ phase: "copy" });
      }
    }
    emit({ phase: "verify" });
    const manifest: Record<string, { rows: number; sha256: string }> = {};
    for (const name of HISTORY_V2_COPY_TABLES) {
      let current = table(name); if (!current) continue;
      const names = sourceColumns(source, prefix + name), digestNames = ["__rowid", ...names];
      while (!current.verified) {
        await gap();
        const since = Date.now(), { rows, bytes } = read(name, current.verify_after);
        if (!rows.length) {
          const total = Number(target.prepare(`SELECT count(*) n FROM ${q(name)}`).get()!.n);
          if (total !== current.copied_rows || current.verified_rows !== current.copied_rows || current.verify_sha256 !== current.copy_sha256) throw failure(`${name} totals`);
          target.prepare("UPDATE history_copy_state SET verified=1 WHERE table_name=?").run(name); break;
        }
        const expected = digestRows(rows, digestNames);
        const copied = targetRange(name, Number(rows[0]!.__rowid), Number(rows.at(-1)!.__rowid), rows.length).map(row => decodeHistoryRow(name, row));
        if (copied.length !== rows.length || digestRows(copied, digestNames) !== expected) throw failure(`${name} verification after ${current.verify_after ?? 0}`);
        target.prepare("UPDATE history_copy_state SET verify_after=?,verified_rows=verified_rows+?,verify_sha256=? WHERE table_name=?").run(Number(rows.at(-1)!.__rowid), rows.length, chainRows(current.verify_sha256, rows, digestNames), name);
        pace(bytes * 2, since); current = table(name)!; emit({ phase: "verify" });
      }
      // An empty table still gets a stable digest (of no rows).
      manifest[name] = { rows: current.verified_rows, sha256: current.verify_sha256 || createHash("sha256").digest("hex") };
    }
    await gap();
    target.exec("BEGIN IMMEDIATE");
    try {
      if (state.source === "history-v1") {
        // The legacy tail reads bridge.db ids. v1's own cursor (copied with history_cursors) is already in that id
        // space; v1 record ids are not, so they must never become the cursor. Without a v1 cursor the tail starts
        // at 0 and replays bridge.db idempotently by natural key. v1's remapped rows keep their mappings (AB-216).
        if (source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(`${prefix}history_legacy_tail`)) {
          const map = target.prepare("INSERT OR IGNORE INTO history_legacy_tail(source_id,target_id) VALUES(?,?)");
          for (const row of source.prepare(`SELECT source_id,target_id FROM ${q(`${prefix}history_legacy_tail`)}`).iterate()) map.run(row.source_id!, row.target_id!);
        }
      } else {
        const max = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(`${prefix}conversation_records`)
          ? Number(source.prepare(`SELECT coalesce(max(id),0) n FROM ${q(`${prefix}conversation_records`)}`).get()!.n) : 0;
        target.prepare("INSERT INTO history_cursors VALUES('legacy-record-tail',?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(String(max));
      }
      target.prepare("UPDATE history_migration SET status='verified',manifest=? WHERE version=?").run(JSON.stringify(manifest), HISTORY_STORE_VERSION);
      target.exec("COMMIT");
    } catch (err) { target.exec("ROLLBACK"); throw err; }
    emit({ phase: "verified", percent: 100, etaSeconds: 0, paused: false });
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Environment errors pause and retry; they are reported, never latched as a failed migration (AB-238).
    emit(code === "HISTORY_MIGRATION_STOPPED" ? { paused: true, error: null } : transient(err) ? { paused: true, error: String((err as Error).message ?? err) } : { phase: "failed", error: String(err), etaSeconds: null });
    throw err;
  } finally { source?.close(); }
}
