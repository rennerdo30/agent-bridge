import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { decodeBytes, decodeText } from "./history-codec.js";

/** Row-level proof that old data is redundant (owner rule: storage finalize may delete something only when every
 * row in it still exists in the live databases, checked at deletion time). Anything unproven is kept and reported.
 * Rows that exist nowhere else can first be absorbed into archive.db (storage-absorb.ts); absorbed rows count as
 * present when they are byte-identical. */

type Row = Record<string, SQLInputValue>;
/** A live database and the tables in it that do not count as a copy (for example, ones about to be dropped). */
export interface LiveDb { label: string; db: DatabaseSync; exclude?: ReadonlySet<string> }

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
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
/** archive.db tables written by storage absorb. Additive: older readers ignore them. */
export const ABSORBED_ROWS = "absorbed_rows";
export const ABSORBED_FILES = "absorbed_files";
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

function same(a: SQLInputValue, b: SQLInputValue): boolean {
  a ??= null; b ??= null;
  if (a === null || b === null) return a === b;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    const bytes = (x: SQLInputValue) => x instanceof Uint8Array ? Buffer.from(x.buffer, x.byteOffset, x.byteLength) : Buffer.from(String(x), "utf8");
    return bytes(a).equals(bytes(b));
  }
  if ((typeof a === "number" || typeof a === "bigint") && (typeof b === "number" || typeof b === "bigint")) return String(a) === String(b);
  return a === b;
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

/** present: a live copy exists (by key with identical immutable content, or as an identical row);
 * absorbed: an identical row was absorbed into archive.db; conflict: the key exists live with different immutable
 * content (never overwritten, so the old copy must stay); missing: nowhere else. */
export type RowStatus = "present" | "absorbed" | "missing" | "conflict";
export interface TableClassifier {
  table: string; logical: string; total: number;
  /** Sorted columns that identify an absorbed row. */
  columns: string[];
  /** Where live copies were looked for, for messages. */
  where: string;
  /** Set when no live table can hold these rows; only absorbed rows then count as present. */
  problem?: string;
  classify(row: Row): RowStatus;
  digest(row: Row): string;
}

function absorbedLookup(live: readonly LiveDb[]): StatementSync | undefined {
  const archive = live.find(l => hasTable(l.db, ABSORBED_ROWS));
  return archive?.db.prepare(`SELECT 1 FROM ${ABSORBED_ROWS} WHERE source_table=? AND digest=?`);
}

export function tableClassifier(candidate: DatabaseSync, table: string, live: readonly LiveDb[]): TableClassifier {
  const logical = logicalTable(table);
  const own = columns(candidate, table);
  const cols = own.map(c => c.name).filter(c => !IGNORED_COLUMNS.has(c));
  const sorted = [...cols].sort();
  const total = Number(candidate.prepare(`SELECT count(*) n FROM ${q(table)}`).get()!.n);
  const names = ALIASES[logical] ?? [logical];
  const targets = live.flatMap(l => names.filter(n => !l.exclude?.has(n) && hasTable(l.db, n)).map(name => ({ l, name, cols: columns(l.db, name) })));
  const where = [...new Set(targets.map(t => t.l.label))].join(", ");
  const absorbed = absorbedLookup(live);
  const digest = (row: Row) => rowDigest(row, sorted);
  const isAbsorbed = (row: Row) => !!absorbed?.get(logical, digest(row));
  const base = { table, logical, total, columns: sorted, where, digest };
  if (!targets.length) return { ...base, problem: `no live database has a ${logical} table`, classify: row => isAbsorbed(row) ? "absorbed" : "missing" };
  const has = (t: { cols: Column[] }, wanted: readonly string[]) => wanted.every(w => t.cols.some(c => c.name === w));
  let key = KNOWN[logical]?.key ?? (primaryKey(own).length ? primaryKey(own) : undefined);
  if (!key) for (const t of targets) { const pk = primaryKey(t.cols); if (pk.length && pk.every(k => cols.includes(k))) { key = pk; break; } }
  const sameCols = KNOWN[logical]?.same ?? [];
  if (key && key.every(k => cols.includes(k))) {
    const keyCols = key;
    const lookups = targets.filter(t => has(t, keyCols) && has(t, sameCols)).map(t => {
      const s = t.l.db.prepare(`SELECT * FROM ${q(t.name)} WHERE ${keyCols.map(k => `${q(k)} IS ?`).join(" AND ")}`);
      s.setReadBigInts(true);
      return s;
    });
    if (!lookups.length) return { ...base, problem: `no live ${logical} table has the key ${keyCols.join(",")}`, classify: row => isAbsorbed(row) ? "absorbed" : "missing" };
    return {
      ...base,
      classify(row) {
        const args = keyCols.map(k => row[k] ?? null);
        let found = false;
        for (const s of lookups) for (const match of s.all(...args)) {
          if (sameCols.every(c => same(value(match, c), value(row, c)))) return "present";
          found = true;
        }
        if (isAbsorbed(row)) return "absorbed";
        return found ? "conflict" : "missing";
      },
    };
  }
  const sets: Set<string>[] = [];
  for (const t of targets) {
    if (!has(t, cols)) continue;
    if (Number(t.l.db.prepare(`SELECT count(*) n FROM ${q(t.name)}`).get()!.n) > MAX_DIGEST_ROWS) continue;
    const set = new Set<string>();
    const all = t.l.db.prepare(`SELECT * FROM ${q(t.name)}`);
    all.setReadBigInts(true);
    for (const row of all.iterate()) set.add(digest(row));
    sets.push(set);
  }
  if (!sets.length) return { ...base, problem: `rows without a key, and no live ${logical} table can be compared row by row`, classify: row => isAbsorbed(row) ? "absorbed" : "missing" };
  return { ...base, classify: row => sets.some(s => s.has(digest(row))) ? "present" : isAbsorbed(row) ? "absorbed" : "missing" };
}

/** Rows of a candidate table, read with exact integers. */
export function candidateRows(db: DatabaseSync, table: string): Iterable<Row> {
  const statement = db.prepare(`SELECT * FROM ${q(table)}`);
  statement.setReadBigInts(true);
  return statement.iterate() as Iterable<Row>;
}

/** null when every row of `table` exists in a live database or was absorbed; otherwise the reason it must be kept. */
export function proveTable(candidate: DatabaseSync, table: string, live: readonly LiveDb[]): string | null {
  const c = tableClassifier(candidate, table, live);
  if (!c.total) return null;
  let missing = 0, conflicts = 0;
  for (const row of candidateRows(candidate, table)) {
    const status = c.classify(row);
    if (status === "missing") missing++;
    else if (status === "conflict") conflicts++;
  }
  const reasons: string[] = [];
  if (missing) reasons.push(c.problem ? `${table}: ${missing} of ${c.total} rows, and ${c.problem}` : `${table}: ${missing} of ${c.total} rows are not in ${c.where}`);
  if (conflicts) reasons.push(`${table}: ${conflicts} rows conflict with different content in ${c.where}`);
  return reasons.length ? reasons.join("; ") : null;
}

export function isSqlite(path: string): boolean {
  const fd = openSync(path, "r");
  try { const head = Buffer.alloc(16); return readSync(fd, head, 0, 16, 0) === 16 && head.equals(SQLITE_HEADER); }
  finally { closeSync(fd); }
}

/** Every row of every table (search indexes excepted, they are derived) in a SQLite file exists in a live database. */
export function proveDatabase(path: string, live: readonly LiveDb[]): string[] {
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: true, timeout: 1000 }); }
  catch (err) { return [`cannot be opened (${(err as Error).message})`]; }
  try { return provableTables(db).map(table => proveTable(db, table, live)).filter((r): r is string => r !== null); }
  catch (err) { return [`cannot be read completely (${(err as Error).message})`]; }
  finally { db.close(); }
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
export function proveFile(path: string, live: readonly LiveDb[], copies: readonly string[] = [], root = path): string[] {
  const st = lstatSync(path);
  const name = relative(dirname(root), path) || basename(path);
  if (st.isSymbolicLink()) return [`${name} is a symbolic link`];
  if (st.isDirectory()) {
    const entries = readdirSync(path);
    return entries.filter(entry => !(SIDECAR.test(entry) && entries.includes(entry.replace(SIDECAR, ""))))
      .flatMap(entry => proveFile(join(path, entry), live, copies, root));
  }
  if (!st.isFile()) return [`${name} is not a regular file`];
  if (isSqlite(path)) return proveDatabase(path, live).map(reason => `${name}: ${reason}`);
  const rel = relative(root, path);
  if (rel && copies.some(dir => existsSync(join(dir, rel)) && sameBytes(path, join(dir, rel)))) return [];
  if (absorbedFile(path, live)) return [];
  return [`${name} is not a database and no identical copy exists`];
}
