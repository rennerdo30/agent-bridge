import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { DB_FILE_NAME } from "./constants.js";
import { ABSORBED_FILES, ABSORBED_ROWS, candidateFiles, fileSha256, hasTable, isSqlite, logicalTable, proveFile, provableTables, tableClassifier, type LiveDb } from "./finalize-proof.js";
import { historyDbPath } from "./history-store.js";
import { ARCHIVE_DB_NAME, openArchive } from "./sqlite-maintenance.js";
import { maintenanceLock } from "./storage-lock.js";
import { fileCandidates, historyIsVerified, LEGACY_BRIDGE_TABLES } from "./storage-finalize.js";

/** Lossless absorb (owner decision 2026-10-09): before finalize proves old backups and snapshots redundant, every
 * row in them that exists nowhere live is imported into archive.db, so the proof can succeed without losing anything.
 * - each such row is stored exactly (every column, type-tagged, integers as exact decimals) in absorbed_rows, keyed by
 *   its table and a digest of its decoded values, so identical rows from many backups are stored once;
 * - messages are also inserted into archive.db messages (the existing retention schema), so archive readers see them;
 * - a row whose key exists live with different immutable content is a conflict: nothing is written, the backup stays;
 * - non-database files in pending backups are stored byte-exact in absorbed_files (content-addressed);
 * - bounded batches, each one transaction with its resume cursor; re-running never duplicates (INSERT OR IGNORE).
 * Live rows are never updated or deleted. */

export interface AbsorbSource { path: string; rows: number; files: number; conflicts: number; problems: string[] }
export interface AbsorbResult { applied: boolean; blockers: string[]; sources: AbsorbSource[]; rows: number; files: number; conflicts: number }
export interface AbsorbOptions { apply?: boolean; report?: (line: string) => void; batchRows?: number; now?: number }

/** Files bigger than this are not absorbed as bytes (they stay, and are reported). */
export const MAX_ABSORB_FILE_BYTES = 256 * 1024 * 1024;
const BATCH_ROWS = 500;
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
type Row = Record<string, SQLInputValue>;

const ABSORB_SCHEMA = `
CREATE TABLE IF NOT EXISTS ${ABSORBED_ROWS} (source_table TEXT NOT NULL, digest TEXT NOT NULL, row TEXT NOT NULL, origin TEXT NOT NULL, absorbed_at INTEGER NOT NULL, PRIMARY KEY(source_table, digest));
CREATE TABLE IF NOT EXISTS ${ABSORBED_FILES} (sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL, size INTEGER NOT NULL, origin TEXT NOT NULL, absorbed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS absorb_progress (source TEXT NOT NULL, table_name TEXT NOT NULL, after_rowid INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(source, table_name));`;

/** Exact, type-tagged JSON of every column: {"columns":[...],"values":[null | {"i":"<int>"} | {"r":<real>} | {"t":"<text>"} | {"b":"<base64>"}]}. */
export function encodeAbsorbedRow(row: Row, columns: readonly string[]): string {
  return JSON.stringify({
    columns,
    values: columns.map(c => {
      const v = row[c] ?? null;
      if (v === null) return null;
      if (typeof v === "bigint") return { i: v.toString() };
      if (typeof v === "number") return Number.isInteger(v) ? { i: String(v) } : { r: v };
      if (typeof v === "string") return { t: v };
      return { b: Buffer.from(v as Uint8Array).toString("base64") };
    }),
  });
}

/** The exact row back (integers as bigint, blobs as Buffer). */
export function decodeAbsorbedRow(json: string): Record<string, bigint | number | string | Buffer | null> {
  const value = JSON.parse(json) as { columns: string[]; values: ({ i?: string; r?: number; t?: string; b?: string } | null)[] };
  return Object.fromEntries(value.columns.map((c, n) => {
    const v = value.values[n];
    return [c, v === null || v === undefined ? null : v.i !== undefined ? BigInt(v.i) : v.r !== undefined ? v.r : v.t !== undefined ? v.t : Buffer.from(v.b!, "base64")];
  }));
}

function signature(path: string): string {
  const st = lstatSync(path);
  return `${path}|${st.size}|${Math.trunc(st.mtimeMs)}`;
}

/** Inserts an absorbed message into archive.db messages without ever replacing a row. Columns an old schema lacks get
 * the archive's neutral defaults; the exact original row is in absorbed_rows either way. */
function archiveMessage(archive: DatabaseSync, row: Row, origin: string, now: number): void {
  const cols = archive.prepare("PRAGMA table_info(messages)").all();
  const values = cols.map(col => {
    const name = String(col.name);
    if (row[name] !== undefined && row[name] !== null) return row[name]!;
    if (name === "archive_reason") return `absorbed from ${origin}`;
    if (name === "archived_at") return now;
    if (!Number(col.notnull)) return null;
    return /INT/i.test(String(col.type)) ? 0 : "";
  });
  if (row.id === null || row.id === undefined || row.recipient === null || row.recipient === undefined) return;
  archive.prepare(`INSERT OR IGNORE INTO messages(${cols.map(c => q(String(c.name))).join(",")}) VALUES(${cols.map(() => "?").join(",")})`).run(...values);
}

function absorbDatabase(path: string, live: readonly LiveDb[], archive: DatabaseSync | undefined, source: AbsorbSource, options: Required<Pick<AbsorbOptions, "batchRows" | "now">> & AbsorbOptions): void {
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: true, timeout: 1000 }); }
  catch (err) { source.problems.push(`${basename(path)} cannot be opened (${(err as Error).message})`); return; }
  try {
    const sig = signature(path), origin = basename(path);
    for (const table of provableTables(db)) {
      const c = tableClassifier(db, table, live);
      if (!c.total) continue;
      const all = db.prepare(`PRAGMA table_info(${q(table)})`).all().map(r => String(r.name));
      const progress = archive?.prepare("SELECT after_rowid, done FROM absorb_progress WHERE source=? AND table_name=?").get(sig, table);
      if (progress?.done) continue;
      let after = Number(progress?.after_rowid ?? -1), rowid = true;
      const conflictsBefore = source.conflicts;
      const page = (from: number, offset: number): Row[] => {
        if (rowid) {
          try {
            const s = db.prepare(`SELECT rowid AS "__absorb_rowid", * FROM ${q(table)} WHERE rowid>? ORDER BY rowid LIMIT ?`);
            s.setReadBigInts(true);
            return s.all(from, options.batchRows) as Row[];
          } catch { rowid = false; }
        }
        const s = db.prepare(`SELECT * FROM ${q(table)} LIMIT ? OFFSET ?`);
        s.setReadBigInts(true);
        return s.all(options.batchRows, offset) as Row[];
      };
      for (let offset = 0; ;) {
        const rows = page(after, offset);
        if (!rows.length) break;
        offset += rows.length;
        if (rowid) after = Number(rows.at(-1)!.__absorb_rowid);
        if (archive) archive.exec("BEGIN IMMEDIATE");
        try {
          for (const row of rows) {
            const status = c.classify(row);
            if (status === "conflict") { source.conflicts++; continue; }
            if (status !== "missing") continue;
            source.rows++;
            if (!archive) continue;
            archive.prepare(`INSERT OR IGNORE INTO ${ABSORBED_ROWS}(source_table,digest,row,origin,absorbed_at) VALUES(?,?,?,?,?)`)
              .run(c.logical, c.digest(row), encodeAbsorbedRow(row, all), origin, options.now);
            if (c.logical === "messages" || c.logical === "archived_messages") archiveMessage(archive, row, origin, options.now);
          }
          if (archive) {
            archive.prepare("INSERT INTO absorb_progress(source,table_name,after_rowid) VALUES(?,?,?) ON CONFLICT(source,table_name) DO UPDATE SET after_rowid=excluded.after_rowid")
              .run(sig, table, rowid ? after : -1);
            archive.exec("COMMIT");
          }
        } catch (err) {
          if (archive?.isTransaction) archive.exec("ROLLBACK");
          // A failed write stops the run (its batch rolled back, the cursor kept); only unreadable sources are skipped.
          throw Object.assign(err as Error, { absorbWrite: true });
        }
      }
      // A table with conflicts is scanned again on every run, so each run reports them.
      if (source.conflicts === conflictsBefore) archive?.prepare("INSERT INTO absorb_progress(source,table_name,after_rowid,done) VALUES(?,?,?,1) ON CONFLICT(source,table_name) DO UPDATE SET done=1")
        .run(sig, table, after);
      else archive?.prepare("DELETE FROM absorb_progress WHERE source=? AND table_name=?").run(sig, table);
    }
  } catch (err) {
    if ((err as { absorbWrite?: boolean }).absorbWrite) throw err;
    source.problems.push(`${basename(path)} cannot be read completely (${(err as Error).message})`);
  } finally { db.close(); }
}

function absorbFile(path: string, root: string, copies: readonly string[], live: readonly LiveDb[], archive: DatabaseSync | undefined, source: AbsorbSource, now: number): void {
  if (!proveFile(path, live, copies, root).length) return;
  const st = lstatSync(path);
  if (!st.isFile()) { source.problems.push(`${basename(path)} is not a regular file`); return; }
  if (st.size > MAX_ABSORB_FILE_BYTES) { source.problems.push(`${basename(path)} is larger than ${MAX_ABSORB_FILE_BYTES / 1024 ** 2} MiB and is not absorbed`); return; }
  source.files++;
  if (!archive) return;
  const bytes = readFileSync(path), sha = fileSha256(path);
  archive.prepare(`INSERT OR IGNORE INTO ${ABSORBED_FILES}(sha256,bytes,size,origin,absorbed_at) VALUES(?,?,?,?,?)`).run(sha, bytes, bytes.length, path, now);
}

/** Dry run without `apply`: counts what would be imported and the conflicts. With `apply`, imports under the
 * maintenance lock (no bridge process may be writing). */
export function runAbsorb(home: string, options: AbsorbOptions = {}): AbsorbResult {
  const result: AbsorbResult = { applied: !!options.apply, blockers: [], sources: [], rows: 0, files: 0, conflicts: 0 };
  if (!historyIsVerified(home)) { result.blockers.push("History store v2 is not verified yet; old copies are compared against it, so absorb waits."); return result; }
  const release = options.apply ? maintenanceLock(home) : () => {};
  const opened: DatabaseSync[] = [];
  try {
    const bridge = join(home, DB_FILE_NAME), history = historyDbPath(bridge), archivePath = join(home, ARCHIVE_DB_NAME);
    const open = (path: string) => { const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 }); opened.push(db); return db; };
    let archive: DatabaseSync | undefined;
    if (options.apply) {
      archive = openArchive(archivePath); opened.push(archive);
      archive.exec(ABSORB_SCHEMA);
    }
    const live: LiveDb[] = [{ label: "bridge.db", db: open(bridge), exclude: new Set(LEGACY_BRIDGE_TABLES) }, { label: "history.db", db: open(history) }];
    const archiveLive = archive ?? (lstatOrNull(archivePath) ? open(archivePath) : undefined);
    if (archiveLive) live.splice(1, 0, { label: "archive.db", db: archiveLive });
    const settings = { ...options, batchRows: options.batchRows ?? BATCH_ROWS, now: options.now ?? Date.now() };
    for (const { item, copies } of fileCandidates(home)) {
      const source: AbsorbSource = { path: item.path, rows: 0, files: 0, conflicts: 0, problems: [] };
      options.report?.(`${options.apply ? "absorbing" : "checking"} ${item.path}…`);
      for (const file of candidateFiles(item.path)) {
        if (lstatSync(file).isSymbolicLink()) { source.problems.push(`${basename(file)} is a symbolic link`); continue; }
        if (isSqlite(file)) absorbDatabase(file, live, archive, source, settings);
        else absorbFile(file, item.path, copies, live, archive, source, settings.now);
      }
      options.report?.(`  ${source.rows} rows and ${source.files} files ${options.apply ? "absorbed" : "to absorb"}, ${source.conflicts} conflicts${source.problems.length ? `; ${source.problems.join("; ")}` : ""}`);
      result.sources.push(source);
      result.rows += source.rows; result.files += source.files; result.conflicts += source.conflicts;
    }
    return result;
  } finally {
    for (const db of opened.reverse()) db.close();
    release();
  }
}

function lstatOrNull(path: string) { try { return lstatSync(path); } catch { return null; } }

/** Rows absorbed for one table, decoded exactly (for readers and tests). */
export function readAbsorbedRows(home: string, table: string): Record<string, bigint | number | string | Buffer | null>[] {
  const db = new DatabaseSync(join(home, ARCHIVE_DB_NAME), { readOnly: true });
  try {
    if (!hasTable(db, ABSORBED_ROWS)) return [];
    return db.prepare(`SELECT row FROM ${ABSORBED_ROWS} WHERE source_table=? ORDER BY absorbed_at, digest`).all(logicalTable(table)).map(r => decodeAbsorbedRow(String(r.row)));
  } finally { db.close(); }
}
