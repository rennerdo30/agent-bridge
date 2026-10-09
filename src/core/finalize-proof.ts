import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { decodeBytes, decodeText } from "./history-codec.js";

/** Row-level proof that old data is redundant (owner rule: storage finalize may delete something only when every
 * row in it still exists in the live databases, checked at deletion time). Anything unproven is kept and reported. */

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
/** Keyless tables are compared by whole-row digest sets; above this the proof is not attempted (the data is kept). */
const MAX_DIGEST_ROWS = 2_000_000;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** retained_<stamp>_<table> and v1_<table> hold rows of <table>. */
export function logicalTable(name: string): string { return name.replace(/^retained_\d+_/, "").replace(/^v1_/, ""); }

interface Column { name: string; pk: number }
function columns(db: DatabaseSync, table: string): Column[] {
  return db.prepare(`PRAGMA table_info(${q(table)})`).all().map(row => ({ name: String(row.name), pk: Number(row.pk) }));
}
function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
const primaryKey = (cols: Column[]) => cols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);

/** Virtual tables (search indexes) and their shadow tables hold derived data only. */
export function derivedTables(db: DatabaseSync): Set<string> {
  const all = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all();
  const virtual = all.filter(row => /^CREATE VIRTUAL TABLE/i.test(String(row.sql ?? ""))).map(row => String(row.name));
  return new Set(all.map(row => String(row.name)).filter(name => virtual.some(v => name === v || name.startsWith(`${v}_`))));
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

function digest(row: Row, names: readonly string[]): string {
  const hash = createHash("sha256");
  for (const name of names) {
    let v = value(row, name);
    if (typeof v === "bigint") v = Number(v);
    const bytes = v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(String(v), "utf8");
    hash.update(`${name.length}:${name}:${v === null ? "null" : v instanceof Uint8Array ? "blob" : typeof v}:${bytes.length}:`).update(bytes);
  }
  return hash.digest("hex");
}

/** null when every row of `table` exists in a live database (by key, with identical immutable content, or as an
 * identical whole row for tables without a key); otherwise the reason it must be kept. */
export function proveTable(candidate: DatabaseSync, table: string, live: readonly LiveDb[]): string | null {
  const logical = logicalTable(table);
  const own = columns(candidate, table);
  const cols = own.map(c => c.name).filter(c => !IGNORED_COLUMNS.has(c));
  const total = Number(candidate.prepare(`SELECT count(*) n FROM ${q(table)}`).get()!.n);
  if (!total) return null;
  const names = ALIASES[logical] ?? [logical];
  const targets = live.flatMap(l => names.filter(n => !l.exclude?.has(n) && hasTable(l.db, n)).map(name => ({ l, name, cols: columns(l.db, name) })));
  const where = targets.length ? [...new Set(targets.map(t => t.l.label))].join(", ") : "";
  if (!targets.length) return `${table}: ${total} rows, and no live database has a ${logical} table`;
  const has = (t: { cols: Column[] }, wanted: readonly string[]) => wanted.every(w => t.cols.some(c => c.name === w));
  let key = KNOWN[logical]?.key ?? (primaryKey(own).length ? primaryKey(own) : undefined);
  if (!key) for (const t of targets) { const pk = primaryKey(t.cols); if (pk.length && pk.every(k => cols.includes(k))) { key = pk; break; } }
  const sameCols = KNOWN[logical]?.same ?? [];
  let missing = 0;
  if (key && key.every(k => cols.includes(k))) {
    const keyCols = key;
    const lookups = targets.filter(t => has(t, keyCols) && has(t, sameCols))
      .map(t => t.l.db.prepare(`SELECT * FROM ${q(t.name)} WHERE ${keyCols.map(k => `${q(k)} IS ?`).join(" AND ")}`));
    if (!lookups.length) return `${table}: ${total} rows, and no live ${logical} table has the key ${keyCols.join(",")}`;
    for (const row of candidate.prepare(`SELECT * FROM ${q(table)}`).iterate()) {
      const args = keyCols.map(k => row[k] ?? null);
      if (!lookups.some(s => s.all(...args).some(found => sameCols.every(c => same(value(found, c), value(row, c)))))) missing++;
    }
  } else {
    const sets: Set<string>[] = [];
    for (const t of targets) {
      if (!has(t, cols)) continue;
      if (Number(t.l.db.prepare(`SELECT count(*) n FROM ${q(t.name)}`).get()!.n) > MAX_DIGEST_ROWS) continue;
      const set = new Set<string>();
      for (const row of t.l.db.prepare(`SELECT * FROM ${q(t.name)}`).iterate()) set.add(digest(row, cols));
      sets.push(set);
    }
    if (!sets.length) return `${table}: ${total} rows without a key, and no live ${logical} table can be compared row by row`;
    for (const row of candidate.prepare(`SELECT * FROM ${q(table)}`).iterate()) if (!sets.some(s => s.has(digest(row, cols)))) missing++;
  }
  return missing ? `${table}: ${missing} of ${total} rows are not in ${where}` : null;
}

function isSqlite(path: string): boolean {
  const fd = openSync(path, "r");
  try { const head = Buffer.alloc(16); return readSync(fd, head, 0, 16, 0) === 16 && head.equals(SQLITE_HEADER); }
  finally { closeSync(fd); }
}

/** Every row of every table (search indexes excepted, they are derived) in a SQLite file exists in a live database. */
export function proveDatabase(path: string, live: readonly LiveDb[]): string[] {
  let db: DatabaseSync;
  try { db = new DatabaseSync(path, { readOnly: true, timeout: 1000 }); }
  catch (err) { return [`cannot be opened (${(err as Error).message})`]; }
  try {
    const derived = derivedTables(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all()
      .map(row => String(row.name)).filter(name => !derived.has(name));
    return tables.map(table => proveTable(db, table, live)).filter((r): r is string => r !== null);
  } catch (err) { return [`cannot be read completely (${(err as Error).message})`]; }
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

const SIDECAR = /-(wal|shm|journal)$/;
/** SQLite sidecar files belong to their database and go with it. */
export function sidecars(path: string): string[] {
  return ["-wal", "-shm", "-journal"].map(suffix => `${path}${suffix}`).filter(existsSync);
}

/** Proof for one file or directory. Databases need a row-level proof; any other file needs a byte-identical copy at
 * the same relative path under one of `copies` (for a partial backup: the home and the published backups). */
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
  return [`${name} is not a database and no identical copy exists`];
}
