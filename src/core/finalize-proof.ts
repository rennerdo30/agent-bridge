import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { decodeBytes, decodeText } from "./history-codec.js";
import { chainRows } from "./history-migration.js";
import { HISTORY_V2_COPY_TABLES } from "./history-schema-v2.js";

/** Row-level proof that old data is redundant (owner rule: storage finalize may delete something only when every
 * row in it still exists in the live databases, checked at deletion time). Anything unproven is kept and reported.
 * Rows that exist nowhere else can first be absorbed into archive.db (storage-absorb.ts); absorbed rows count as
 * present when they are byte-identical.
 *
 * Cost (owner requirement: a 20 GB snapshot in minutes, never hours): reads are sequential.
 * - The snapshot the verified v2 migration copied from is proven by that migration's manifest: its history tables
 *   are re-hashed sequentially with the migration's own chained row digest and must match row count and sha256.
 * - Other history copies (bridge.db legacy tables, old snapshots and backups, v1_* and retained_* tables) are compared
 *   with the live v2 table in rowid order, because the v2 copy kept every rowid. Two sequential scans, no lookups.
 * - Only rows that do not match at their rowid, and small tables, use indexed lookups, batched by 500 keys.
 * - Compressed values are decoded only when content must be compared and the stored bytes differ. */

type Row = Record<string, SQLInputValue>;
/** A live database and the tables in it that do not count as a copy (for example, ones about to be dropped). */
export interface LiveDb { label: string; db: DatabaseSync; exclude?: ReadonlySet<string> }

/** The source snapshot of the verified history migration and its manifest of per-table row counts and chained sha256. */
export interface ReferenceSnapshot { path: string; prefix: string; manifest: Record<string, { rows: number; sha256: string }> }

export interface ProofProgress { add(rows: number): void; note(text: string): void }

export interface ProofContext {
  live: readonly LiveDb[];
  /** Live history.db v2, for rowid-aligned comparison of history copies. */
  history?: DatabaseSync;
  reference?: ReferenceSnapshot;
  progress?: ProofProgress;
}

/** Natural keys and immutable content for tables whose ids differ between copies or whose rows must match byte for byte. */
const KNOWN: Record<string, { key: string[]; same: string[] }> = {
  messages: { key: ["id", "recipient"], same: ["body"] },
  archived_messages: { key: ["id", "recipient"], same: ["body"] },
  conversation_records: { key: ["source", "generation", "offset"], same: ["conversation", "raw"] },
};
/** Messages move between bridge.db messages, bridge.db archived_messages and archive.db messages. */
const ALIASES: Record<string, string[]> = { messages: ["messages", "archived_messages"], archived_messages: ["archived_messages", "messages"] };
/** Bookkeeping columns added by the copy itself. */
const IGNORED_COLUMNS = new Set(["retained_rowid"]);
/** Keyless tables are compared by whole-row digest sets; above this the comparison is not attempted. */
const MAX_DIGEST_ROWS = 2_000_000;
const CHUNK_ROWS = 500;
/** A rowid gap larger than this re-seeks the aligned scan instead of reading through it. */
const RESEEK_GAP = 10_000n;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
/** archive.db tables written by storage absorb. Additive: older readers ignore them. */
export const ABSORBED_ROWS = "absorbed_rows";
export const ABSORBED_FILES = "absorbed_files";
const COPY_TABLES = new Set<string>(HISTORY_V2_COPY_TABLES);
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** retained_<stamp>_<table> and v1_<table> hold rows of <table>. */
export function logicalTable(name: string): string { return name.replace(/^retained_\d+_/, "").replace(/^v1_/, ""); }

interface Column { name: string; pk: number }
function columns(db: DatabaseSync, table: string): Column[] {
  return db.prepare(`PRAGMA table_info(${q(table)})`).all().map(row => ({ name: String(row.name), pk: Number(row.pk) }));
}
export function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
const primaryKey = (cols: Column[]) => cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);

/** Virtual tables (search indexes) and their shadow tables hold derived data only. */
export function derivedTables(db: DatabaseSync): Set<string> {
  const all = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all();
  const virtual = all.filter(row => /^CREATE VIRTUAL TABLE/i.test(String(row.sql ?? ""))).map(row => String(row.name));
  return new Set(all.map(row => String(row.name)).filter(name => virtual.some(v => name === v || name.startsWith(`${v}_`))));
}

/** Plain tables of a candidate database whose rows must be proven (search indexes are derived). */
export function provableTables(db: DatabaseSync): string[] {
  const derived = derivedTables(db);
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all()
    .map(row => String(row.name)).filter(name => !derived.has(name));
}

/** v2 stores some columns encoded next to a <column>_codec column; compare decoded values. */
function value(row: Row, column: string): SQLInputValue {
  const v = row[column] ?? null;
  const codec = row[`${column}_codec`];
  if (codec === undefined || v === null) return v;
  return column === "raw" ? decodeBytes(v, codec) : decodeText(v, codec);
}

function sameValue(a: SQLInputValue, b: SQLInputValue): boolean {
  a ??= null; b ??= null;
  if (a === null || b === null) return a === b;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    const bytes = (x: SQLInputValue) => x instanceof Uint8Array ? Buffer.from(x.buffer, x.byteOffset, x.byteLength) : Buffer.from(String(x), "utf8");
    return bytes(a).equals(bytes(b));
  }
  if ((typeof a === "number" || typeof a === "bigint") && (typeof b === "number" || typeof b === "bigint")) return String(a) === String(b);
  return a === b;
}

/** Same content of one column; identically encoded values are compared without decoding. */
function sameColumn(a: Row, b: Row, column: string): boolean {
  const ca = a[`${column}_codec`], cb = b[`${column}_codec`];
  if (ca !== undefined && cb !== undefined && String(ca) === String(cb) && sameValue(a[column] ?? null, b[column] ?? null)) return true;
  return sameValue(value(a, column), value(b, column));
}

/** Stable identity of a row's decoded values over `names` (integers as exact decimal strings). */
export function rowDigest(row: Row, names: readonly string[]): string {
  const hash = createHash("sha256");
  for (const name of names) {
    const v = value(row, name);
    const type = v === null ? "null" : v instanceof Uint8Array ? "blob" : typeof v === "bigint" || (typeof v === "number" && Number.isInteger(v)) ? "int" : typeof v;
    const bytes = v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(String(v), "utf8");
    hash.update(`${name.length}:${name}:${type}:${bytes.length}:`).update(bytes);
  }
  return hash.digest("hex");
}

/** SQLite's ORDER BY order for BINARY collation: NULL < numbers < text (by UTF-8 bytes) < blobs. */
function compareSql(a: SQLInputValue, b: SQLInputValue): number {
  const rank = (v: SQLInputValue) => v === null || v === undefined ? 0 : typeof v === "number" || typeof v === "bigint" ? 1 : typeof v === "string" ? 2 : 3;
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) return (a as number | bigint) < (b as number | bigint) ? -1 : (a as number | bigint) > (b as number | bigint) ? 1 : 0;
  const bytes = (v: SQLInputValue) => typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v as Uint8Array);
  return Buffer.compare(bytes(a), bytes(b));
}
const compareKeys = (a: SQLInputValue[], b: SQLInputValue[]) => { for (let i = 0; i < a.length; i++) { const c = compareSql(a[i]!, b[i]!); if (c) return c; } return 0; };

/** True when an index (or the rowid) orders the table by exactly these columns with BINARY collation, so
 * `ORDER BY key` is a sequential walk of a small index instead of a sort of the whole table. */
function indexedBy(db: DatabaseSync, table: string, key: readonly string[]): boolean {
  const info = db.prepare(`PRAGMA table_info(${q(table)})`).all();
  if (key.length === 1 && info.some(c => c.name === key[0] && Number(c.pk) === 1 && /^INTEGER$/i.test(String(c.type))) && info.filter(c => Number(c.pk) > 0).length === 1) return true;
  for (const index of db.prepare(`PRAGMA index_list(${q(table)})`).all()) {
    const cols = db.prepare(`PRAGMA index_xinfo(${q(String(index.name))})`).all().filter(c => Number(c.key) === 1);
    if (cols.length >= key.length && key.every((k, n) => cols[n]!.name === k && String(cols[n]!.coll ?? "BINARY").toUpperCase() === "BINARY" && !Number(cols[n]!.desc))) return true;
  }
  return false;
}

/** Lookup identity of key values, consistent for integers read as number or bigint. */
function keyOf(values: SQLInputValue[]): string {
  return values.map(v => v === null || v === undefined ? "n" : v instanceof Uint8Array ? `b${Buffer.from(v).toString("base64")}` : typeof v === "bigint" || typeof v === "number" ? `i${String(v)}` : `t${v}`).join("\u0000");
}

/** present: a live copy exists (by key with identical immutable content, or as an identical row);
 * absorbed: an identical row was absorbed into archive.db; conflict: the key exists live with different immutable
 * content (never overwritten, so the old copy must stay); missing: nowhere else. */
export type RowStatus = "present" | "absorbed" | "missing" | "conflict";
export interface ChunkResult {
  /** rowid of the last candidate row in this chunk (null for tables without rowid). */
  last: bigint | null;
  /** Rows that are missing or in conflict; present and absorbed rows are only counted. */
  rows: { row: Row; status: "missing" | "conflict" }[];
  present: number; absorbed: number;
}
export interface TableProof {
  table: string; logical: string; total: number;
  /** Sorted columns that identify an absorbed row. */
  columns: string[];
  /** All candidate columns, in table order (absorb stores every one of them). */
  allColumns: string[];
  where: string;
  problem?: string;
  digest(row: Row): string;
  chunks(after?: bigint): Generator<ChunkResult>;
}

/** Plans the cheapest complete proof of one candidate table. Nothing is read until `chunks()` runs. */
export function tableProof(candidate: DatabaseSync, table: string, ctx: ProofContext, aligned?: { db: DatabaseSync; table: string; by?: string }, chunkRows = CHUNK_ROWS): TableProof {
  const logical = logicalTable(table);
  const own = columns(candidate, table);
  const allColumns = own.map(c => c.name);
  const cols = allColumns.filter(c => !IGNORED_COLUMNS.has(c));
  const sorted = [...cols].sort();
  const total = Number(candidate.prepare(`SELECT count(*) n FROM ${q(table)}`).get()!.n);
  const names = ALIASES[logical] ?? [logical];
  const targets = ctx.live.flatMap(l => names.filter(n => !l.exclude?.has(n) && hasTable(l.db, n)).map(name => ({ l, name, cols: columns(l.db, name) })));
  const where = [...new Set(targets.map(t => t.l.label))].join(", ");
  const absorbedDb = ctx.live.find(l => hasTable(l.db, ABSORBED_ROWS))?.db;
  const digest = (row: Row) => rowDigest(row, sorted);
  const has = (t: { cols: Column[] }, wanted: readonly string[]) => wanted.every(w => t.cols.some(c => c.name === w));
  let key = KNOWN[logical]?.key ?? (primaryKey(own).length ? primaryKey(own) : undefined);
  if (!key) for (const t of targets) { const pk = primaryKey(t.cols); if (pk.length && pk.every(k => cols.includes(k))) { key = pk; break; } }
  if (key && !key.every(k => cols.includes(k))) key = undefined;
  const sameCols = KNOWN[logical]?.same ?? [];
  const keyed = key ? targets.filter(t => has(t, key!) && has(t, sameCols)) : [];
  const full = key ? [] : targets.filter(t => has(t, cols));
  let problem: string | undefined;
  if (!targets.length) problem = `no live database has a ${logical} table`;
  else if (key && !keyed.length) problem = `no live ${logical} table has the key ${key.join(",")}`;
  else if (!key && !full.length) problem = `rows without a key, and no live ${logical} table can be compared row by row`;
  /** Content equality under this table's rule: key plus immutable columns, or the whole row. */
  const matches = (candidateRow: Row, liveRow: Row) => key
    ? key.every(k => sameValue(candidateRow[k] ?? null, liveRow[k] ?? null)) && sameCols.every(c => sameColumn(candidateRow, liveRow, c))
    : cols.every(c => sameColumn(candidateRow, liveRow, c));

  /** Only the columns the rule compares are read (plus their codec columns), so large payloads stay on disk. */
  const projection = (available: readonly string[], wanted: readonly string[]) =>
    [...new Set(wanted.flatMap(c => available.includes(`${c}_codec`) ? [c, `${c}_codec`] : [c]))].filter(c => available.includes(c)).map(q).join(",");
  const needed = key ? [...key, ...sameCols] : cols;

  let digestSets: Set<string>[] | undefined;
  const fullSets = () => digestSets ??= full.flatMap(t => {
    if (Number(t.l.db.prepare(`SELECT count(*) n FROM ${q(t.name)}`).get()!.n) > MAX_DIGEST_ROWS) return [];
    const set = new Set<string>(), all = t.l.db.prepare(`SELECT * FROM ${q(t.name)}`);
    all.setReadBigInts(true);
    for (const row of all.iterate()) set.add(digest(row as Row));
    return [set];
  });

  /** Batched indexed lookups for rows that the aligned scan did not match. */
  const lookup = (rows: Row[]): RowStatus[] => {
    if (problem || (!key && !fullSets().length)) return rows.map(() => "missing");
    if (!key) { const sets = fullSets(); return rows.map(row => sets.some(s => s.has(digest(row))) ? "present" : "missing"); }
    const found = new Map<string, Row[]>();
    const withNull = rows.filter(row => key!.some(k => row[k] === null || row[k] === undefined));
    const plain = rows.filter(row => !withNull.includes(row));
    for (const t of keyed) {
      if (plain.length) {
        const tuple = key!.length === 1 ? q(key![0]!) : `(${key!.map(q).join(",")})`;
        const values = plain.map(() => key!.length === 1 ? "?" : `(${key!.map(() => "?").join(",")})`).join(",");
        const s = t.l.db.prepare(`SELECT ${projection(t.cols.map(c => c.name), needed)} FROM ${q(t.name)} WHERE ${tuple} IN (${key!.length === 1 ? values : `VALUES ${values}`})`);
        s.setReadBigInts(true);
        for (const match of s.all(...plain.flatMap(row => key!.map(k => row[k]!))) as Row[]) {
          const id = keyOf(key!.map(k => match[k]!));
          (found.get(id) ?? found.set(id, []).get(id)!).push(match);
        }
      }
      if (withNull.length) {
        const s = t.l.db.prepare(`SELECT ${projection(t.cols.map(c => c.name), needed)} FROM ${q(t.name)} WHERE ${key!.map(k => `${q(k)} IS ?`).join(" AND ")}`);
        s.setReadBigInts(true);
        for (const row of withNull) for (const match of s.all(...key!.map(k => row[k] ?? null)) as Row[]) {
          const id = keyOf(key!.map(k => match[k]!));
          (found.get(id) ?? found.set(id, []).get(id)!).push(match);
        }
      }
    }
    return rows.map(row => {
      const candidates = found.get(keyOf(key!.map(k => row[k] ?? null)));
      if (!candidates?.length) return "missing";
      return candidates.some(match => sameCols.every(c => sameColumn(row, match, c))) ? "present" : "conflict";
    });
  };

  const absorbed = (rows: Row[]): Set<Row> => {
    const out = new Set<Row>();
    if (!absorbedDb || !rows.length) return out;
    const digests = rows.map(digest);
    const s = absorbedDb.prepare(`SELECT digest FROM ${ABSORBED_ROWS} WHERE source_table=? AND digest IN (${digests.map(() => "?").join(",")})`);
    const known = new Set(s.all(logical, ...digests).map(r => String(r.digest)));
    rows.forEach((row, n) => { if (known.has(digests[n]!)) out.add(row); });
    return out;
  };

  function* chunks(after = -1n): Generator<ChunkResult> {
    let rowid = true;
    let source: Iterator<Row>;
    // Key-only rule with an index on both sides: walk both indexes in key order (small, sequential). Any row this
    // merge does not find still goes through the indexed lookup below, so an ordering surprise only costs time.
    const keyList = key ? key.map(q).join(",") : "";
    const merging = key && !sameCols.length && after === -1n && indexedBy(candidate, table, key)
      ? keyed.filter(t => indexedBy(t.l.db, t.name, key!)) : [];
    const mergeCursors = merging.map(t => {
      const s = t.l.db.prepare(`SELECT ${keyList} FROM ${q(t.name)} ORDER BY ${keyList}`);
      s.setReadBigInts(true);
      const it = s.iterate() as Iterator<Row>;
      const first = it.next();
      return { it, current: first.done ? undefined : key!.map(k => first.value[k] ?? null) };
    });
    const merged = (row: Row): boolean => {
      const wanted = key!.map(k => row[k] ?? null);
      let hit = false;
      for (const c of mergeCursors) {
        while (c.current && compareKeys(c.current, wanted) < 0) { const next = c.it.next(); c.current = next.done ? undefined : key!.map(k => next.value[k] ?? null); }
        if (c.current && compareKeys(c.current, wanted) === 0) hit = true;
      }
      return hit;
    };
    if (mergeCursors.length) {
      try {
        const s = candidate.prepare(`SELECT rowid AS "__cid", ${keyList} FROM ${q(table)} ORDER BY ${keyList}`);
        s.setReadBigInts(true);
        source = s.iterate() as Iterator<Row>;
      } catch {
        rowid = false;
        const s = candidate.prepare(`SELECT * FROM ${q(table)} ORDER BY ${keyList}`);
        s.setReadBigInts(true);
        source = s.iterate() as Iterator<Row>;
      }
    } else try {
      const s = candidate.prepare(`SELECT rowid AS "__cid", ${projection(allColumns, [...needed, ...(aligned?.by ? [aligned.by] : [])])} FROM ${q(table)} WHERE rowid>? ORDER BY rowid`);
      s.setReadBigInts(true);
      source = s.iterate(after) as Iterator<Row>;
    } catch {
      rowid = false;
      const s = candidate.prepare(`SELECT * FROM ${q(table)}`);
      s.setReadBigInts(true);
      source = s.iterate() as Iterator<Row>;
    }
    // Rowid-aligned scan of the live copy (sequential); a candidate row matches the live row with the same rowid.
    let cursor: Iterator<Row> | undefined, current: Row | undefined;
    const targetColumns = aligned ? projection(columns(aligned.db, aligned.table).map(c => c.name), needed) : "";
    /** Rows reported as missing or in conflict are returned whole (absorb stores every column). */
    const whole = (rows: Row[]): Row[] => {
      if (!rowid || !rows.length) return rows;
      const s = candidate.prepare(`SELECT rowid AS "__cid", * FROM ${q(table)} WHERE rowid IN (${rows.map(() => "?").join(",")})`);
      s.setReadBigInts(true);
      const byId = new Map((s.all(...rows.map(r => r.__cid!)) as Row[]).map(r => [String(r.__cid), r]));
      return rows.map(r => byId.get(String(r.__cid)) ?? r);
    };
    const point = aligned && aligned.db.prepare(`SELECT rowid AS "__tid", ${targetColumns} FROM ${q(aligned.table)} WHERE rowid=?`);
    point?.setReadBigInts(true);
    const seek = (id: bigint) => {
      cursor?.return?.();
      const s = aligned!.db.prepare(`SELECT rowid AS "__tid", ${targetColumns} FROM ${q(aligned!.table)} WHERE rowid>=? ORDER BY rowid`);
      s.setReadBigInts(true);
      cursor = s.iterate(id) as Iterator<Row>;
      const next = cursor.next(); current = next.done ? undefined : next.value;
    };
    const alignedRow = (id: bigint): Row | undefined => {
      if (!cursor) seek(id);
      // Behind the scan, or past its end: one indexed rowid lookup.
      else if (!current || id < (current.__tid as bigint)) return point!.get(id) as Row | undefined;
      else if (id - (current.__tid as bigint) > RESEEK_GAP) seek(id);
      while (current && (current.__tid as bigint) < id) { const next = cursor!.next(); current = next.done ? undefined : next.value; }
      return current && current.__tid === id ? current : undefined;
    };
    try {
      for (;;) {
        const batch: Row[] = [];
        for (let next = source.next(); !next.done; next = source.next()) { batch.push(next.value); if (batch.length >= chunkRows) break; }
        if (!batch.length) return;
        // A key-ordered walk has no rowid resume point; a resumed absorb starts it again (its writes are idempotent).
        const result: ChunkResult = { last: rowid && !mergeCursors.length ? batch.at(-1)!.__cid as bigint : null, rows: [], present: 0, absorbed: 0 };
        let rest = batch;
        if (mergeCursors.length) {
          rest = [];
          for (const row of batch) if (merged(row)) result.present++; else rest.push(row);
        } else if (aligned) {
          rest = [];
          for (const row of batch) {
            const id = aligned.by ? row[aligned.by] : row.__cid;
            const match = typeof id === "bigint" ? alignedRow(id) : undefined;
            if (match && matches(row, match)) result.present++; else rest.push(row);
          }
        }
        const statuses = lookup(rest);
        const open = rest.filter((_, n) => statuses[n] !== "present");
        const fetched = whole(open);
        const full = new Map(open.map((row, n) => [row, fetched[n]!]));
        const known = absorbed(rest.filter((_, n) => statuses[n] === "missing").map(row => full.get(row)!));
        rest.forEach((row, n) => {
          const status = statuses[n]!;
          if (status === "present") { result.present++; return; }
          const complete = full.get(row)!;
          if (status === "missing" && known.has(complete)) result.absorbed++;
          else result.rows.push({ row: complete, status: status as "missing" | "conflict" });
        });
        ctx.progress?.add(batch.length);
        yield result;
        if (batch.length < chunkRows) return;
      }
    } finally { cursor?.return?.(); source.return?.(); for (const c of mergeCursors) c.it.return?.(); }
  }
  return { table, logical, total, columns: sorted, allColumns, where, problem, digest, chunks };
}

/** The live v2 table a history copy can be compared with in rowid order (the v2 copy kept every rowid). */
export function alignedTarget(table: string, ctx: ProofContext, sameDb?: boolean): { db: DatabaseSync; table: string; by?: string } | undefined {
  const logical = logicalTable(table);
  if (!ctx.history || !COPY_TABLES.has(logical) || !hasTable(ctx.history, logical)) return undefined;
  if (sameDb && table === logical) return undefined;
  return { db: ctx.history, table: logical, by: table.startsWith("retained_") ? "retained_rowid" : undefined };
}

function reasonsOf(p: TableProof, missing: number, conflicts: number): string[] {
  const reasons: string[] = [];
  if (missing) reasons.push(p.problem ? `${p.table}: ${missing} of ${p.total} rows, and ${p.problem}` : `${p.table}: ${missing} of ${p.total} rows are not in ${p.where}`);
  if (conflicts) reasons.push(`${p.table}: ${conflicts} rows conflict with different content in ${p.where}`);
  return reasons;
}

/** null when every row of `table` exists in a live database or was absorbed; otherwise the reason it must be kept. */
export function proveTable(candidate: DatabaseSync, table: string, ctx: ProofContext, aligned = alignedTarget(table, ctx)): string | null {
  const p = tableProof(candidate, table, ctx, aligned);
  if (!p.total) return null;
  let missing = 0, conflicts = 0;
  for (const chunk of p.chunks()) for (const { status } of chunk.rows) status === "missing" ? missing++ : conflicts++;
  const reasons = reasonsOf(p, missing, conflicts);
  return reasons.length ? reasons.join("; ") : null;
}

/** The verified migration's source snapshot is proven by its manifest: every history table is re-hashed in one
 * sequential pass with the migration's own chained row digest and must match the recorded row count and sha256. */
export function proveByManifest(db: DatabaseSync, reference: ReferenceSnapshot, progress?: ProofProgress): { proven: Set<string>; reasons: string[] } {
  const proven = new Set<string>(), reasons: string[] = [];
  for (const [name, expected] of Object.entries(reference.manifest)) {
    const table = reference.prefix + name;
    if (!hasTable(db, table)) { if (expected.rows) reasons.push(`${table}: missing, but the migration manifest lists ${expected.rows} rows`); continue; }
    progress?.note(`checking ${table} against the verified migration manifest…`);
    const names = ["__rowid", ...columns(db, table).map(c => c.name)];
    let chain = "", rows = 0;
    for (const row of db.prepare(`SELECT rowid AS __rowid,* FROM ${q(table)} ORDER BY rowid`).iterate()) {
      chain = chainRows(chain, [row as Row], names);
      if (++rows % CHUNK_ROWS === 0) progress?.add(CHUNK_ROWS);
    }
    progress?.add(rows % CHUNK_ROWS);
    const sha = chain || createHash("sha256").digest("hex");
    if (rows !== expected.rows || sha !== expected.sha256) reasons.push(`${table}: ${rows} rows with sha256 ${sha.slice(0, 12)}…, but the verified migration copied ${expected.rows} rows with ${expected.sha256.slice(0, 12)}…`);
    else proven.add(table);
  }
  return { proven, reasons };
}

/** Rows of a candidate table, read with exact integers. */
export function candidateRows(db: DatabaseSync, table: string): Iterable<Row> {
  const statement = db.prepare(`SELECT * FROM ${q(table)}`);
  statement.setReadBigInts(true);
  return statement.iterate() as Iterable<Row>;
}

export function isSqlite(path: string): boolean {
  const fd = openSync(path, "r");
  try { const head = Buffer.alloc(16); return readSync(fd, head, 0, 16, 0) === 16 && head.equals(SQLITE_HEADER); }
  finally { closeSync(fd); }
}

const samePath = (a: string, b: string) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

/** Every row of every table (search indexes excepted, they are derived) in a SQLite file exists in a live database. */
export function proveDatabase(path: string, ctx: ProofContext): string[] {
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: true, timeout: 1000 }); }
  catch (err) { return [`cannot be opened (${(err as Error).message})`]; }
  try {
    const reasons: string[] = [];
    let manifest = new Set<string>();
    if (ctx.reference && samePath(ctx.reference.path, path)) {
      // A table that no longer matches the manifest is not trusted by it; it falls back to the row-by-row proof.
      const result = proveByManifest(db, ctx.reference, ctx.progress);
      manifest = result.proven;
      for (const reason of result.reasons) ctx.progress?.note(`  ${reason}; proving it row by row instead`);
    }
    for (const table of provableTables(db)) {
      if (manifest.has(table)) continue;
      ctx.progress?.note(`checking ${basename(path)}:${table}…`);
      const reason = proveTable(db, table, ctx);
      if (reason) reasons.push(reason);
    }
    return reasons;
  } catch (err) { return [`cannot be read completely (${(err as Error).message})`]; }
  finally { db.close(); }
}

/** Rows a proof will read (row-count estimate from max(rowid), no scan), for progress and ETA. */
export function estimateRows(path: string): number {
  if (!existsSync(path) || !lstatSync(path).isFile() || !isSqlite(path)) return 0;
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: true, timeout: 1000 }); } catch { return 0; }
  try {
    let n = 0;
    for (const table of provableTables(db)) { try { n += Number(db.prepare(`SELECT coalesce(max(rowid),0) n FROM ${q(table)}`).get()!.n); } catch { /* WITHOUT ROWID */ } }
    return n;
  } catch { return 0; } finally { db.close(); }
}

function sameBytes(a: string, b: string): boolean {
  const sa = lstatSync(a), sb = lstatSync(b);
  if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
  const fa = openSync(a, "r"), fb = openSync(b, "r");
  try {
    const ba = Buffer.alloc(1024 * 1024), bb = Buffer.alloc(1024 * 1024);
    for (let at = 0; at < sa.size;) {
      const na = readSync(fa, ba, 0, ba.length, at), nb = readSync(fb, bb, 0, bb.length, at);
      if (na !== nb || !ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
      if (!na) break;
      at += na;
    }
    return true;
  } finally { closeSync(fa); closeSync(fb); }
}

export function fileSha256(path: string): string {
  const hash = createHash("sha256"), fd = openSync(path, "r"), buffer = Buffer.alloc(1024 * 1024);
  try { for (let n; (n = readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, n)); }
  finally { closeSync(fd); }
  return hash.digest("hex");
}

/** An absorbed file counts only when its stored bytes still hash to the recorded sha256. */
function absorbedFile(path: string, live: readonly LiveDb[]): boolean {
  const archive = live.find(l => hasTable(l.db, ABSORBED_FILES));
  if (!archive) return false;
  const sha = fileSha256(path);
  const row = archive.db.prepare(`SELECT bytes FROM ${ABSORBED_FILES} WHERE sha256=?`).get(sha);
  return !!row && createHash("sha256").update(row.bytes as Uint8Array).digest("hex") === sha;
}

const SIDECAR = /-(wal|shm|journal)$/;
/** SQLite sidecar files belong to their database and go with it. */
export function sidecars(path: string): string[] {
  return ["-wal", "-shm", "-journal"].map(suffix => `${path}${suffix}`).filter(existsSync);
}

/** Files of a candidate, sidecars left out (they belong to their database). */
export function candidateFiles(path: string): string[] {
  const st = lstatSync(path);
  if (!st.isDirectory()) return [path];
  const entries = readdirSync(path);
  return entries.filter(entry => !(SIDECAR.test(entry) && entries.includes(entry.replace(SIDECAR, "")))).flatMap(entry => candidateFiles(join(path, entry)));
}

/** Proof for one file or directory. Databases need a row-level proof; any other file needs a byte-identical copy at
 * the same relative path under one of `copies` (for a partial backup: the home and the published backups), or an
 * absorbed copy in archive.db. */
export function proveFile(path: string, ctx: ProofContext, copies: readonly string[] = [], root = path): string[] {
  const st = lstatSync(path);
  const name = relative(dirname(root), path) || basename(path);
  if (st.isSymbolicLink()) return [`${name} is a symbolic link`];
  if (st.isDirectory()) {
    const entries = readdirSync(path);
    return entries.filter(entry => !(SIDECAR.test(entry) && entries.includes(entry.replace(SIDECAR, ""))))
      .flatMap(entry => proveFile(join(path, entry), ctx, copies, root));
  }
  if (!st.isFile()) return [`${name} is not a regular file`];
  if (isSqlite(path)) return proveDatabase(path, ctx).map(reason => `${name}: ${reason}`);
  const rel = relative(root, path);
  if (rel && copies.some(dir => existsSync(join(dir, rel)) && sameBytes(path, join(dir, rel)))) return [];
  if (absorbedFile(path, ctx.live)) return [];
  return [`${name} is not a database and no identical copy exists`];
}

/** Progress with throughput and ETA over an estimated row total, reported at most every two seconds. */
export function proofProgress(total: number, report: (line: string) => void, now = () => Date.now()): ProofProgress & { done(): number } {
  const start = now();
  let done = 0, last = 0;
  return {
    add(rows) {
      done += rows;
      const t = now();
      if (t - last < 2000) return;
      last = t;
      const rate = done / Math.max(1, (t - start) / 1000);
      const left = Math.max(0, total - done);
      const pct = total ? Math.min(100, (100 * done) / total) : 100;
      report(`  ${done.toLocaleString("en")} of ~${total.toLocaleString("en")} rows (${pct.toFixed(1)}%), ${Math.round(rate).toLocaleString("en")} rows/s, ETA ${rate > 0 ? `${Math.ceil(left / rate)} s` : "unknown"}`);
    },
    note(text) { report(text); },
    done: () => done,
  };
}
