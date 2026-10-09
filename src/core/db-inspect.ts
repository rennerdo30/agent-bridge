import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { DB_FILE_NAME } from "./constants.js";
import { decodeBytes, decodeText, registerHistoryFunctions } from "./history-codec.js";
import { conversationBodyText } from "./conversation-text.js";
import { HISTORY_DB_NAME } from "./history-store.js";
import { ARCHIVE_DB_NAME } from "./sqlite-maintenance.js";

/** Read-only inspection of the bridge's own databases for our viewer (CLI and dashboard).
 * Compressed v2 columns (<name> + <name>_codec) are decoded unless raw is requested. */
export const INSPECT_DATABASES = { bridge: DB_FILE_NAME, history: HISTORY_DB_NAME, archive: ARCHIVE_DB_NAME } as const;
export type InspectDb = keyof typeof INSPECT_DATABASES;
export const MAX_INSPECT_ROWS = 500;
/** A filter decodes every scanned row; it only searches the newest rows so a request stays bounded. */
export const FILTER_SCAN_ROWS = 20_000;
const q = (s: string) => `"${s.replaceAll('"', '""')}"`;

export function inspectDbPath(home: string, db: string): string {
  if (!Object.hasOwn(INSPECT_DATABASES, db)) throw Object.assign(new Error(`Unknown database "${db}"; use bridge, history or archive`), { status: 400 });
  return join(home, INSPECT_DATABASES[db as InspectDb]);
}

export function openInspector(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 250 });
  try { db.exec("PRAGMA query_only=ON"); registerHistoryFunctions(db); return db; }
  catch (err) { db.close(); throw err; }
}

export interface InspectTable { name: string; kind: "table" | "view"; rows?: number }
export interface InspectCatalog { dbs: { db: InspectDb; bytes: number; tables: InspectTable[] }[] }

/** Row counts are estimates from max(rowid) for tables, so a catalog never scans a large table. */
export function inspectCatalog(home: string): InspectCatalog {
  const dbs: InspectCatalog["dbs"] = [];
  for (const db of Object.keys(INSPECT_DATABASES) as InspectDb[]) {
    const path = inspectDbPath(home, db);
    if (!existsSync(path)) continue;
    const conn = openInspector(path);
    try {
      const tables = conn.prepare("SELECT name,type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC,name").all()
        .filter(row => !/_(data|idx|docsize|config|content)$/.test(String(row.name)) || row.type === "view")
        .map(row => {
          const entry: InspectTable = { name: String(row.name), kind: row.type === "view" ? "view" : "table" };
          if (entry.kind === "table") { try { entry.rows = Number(conn.prepare(`SELECT coalesce(max(rowid),0) n FROM ${q(entry.name)}`).get()!.n); } catch { /* virtual or WITHOUT ROWID */ } }
          return entry;
        });
      dbs.push({ db, bytes: statSync(path).size, tables });
    } finally { conn.close(); }
  }
  return { dbs };
}

export interface InspectRows { columns: string[]; rows: unknown[][]; total?: number; note?: string }

function present(value: SQLInputValue, codec: SQLInputValue | undefined, raw: boolean): unknown {
  if (codec !== undefined && codec !== null && Number(codec) !== 0) {
    const bytes = value instanceof Uint8Array ? value.length : 0;
    return raw ? { codec: Number(codec), bytes } : decodeText(value, codec);
  }
  if (value instanceof Uint8Array) {
    const text = Buffer.from(value).toString("utf8");
    return /[\u0000-\u0008\u000e-\u001f�]/.test(text) ? { blob: Buffer.from(value).toString("base64").slice(0, 4096), bytes: value.length } : text;
  }
  return typeof value === "bigint" ? String(value) : value;
}

export function inspectRows(home: string, input: { db: string; table: string; offset?: number; limit?: number; filter?: string; raw?: boolean }): InspectRows {
  const path = inspectDbPath(home, input.db);
  if (!existsSync(path)) throw Object.assign(new Error(`Database "${input.db}" does not exist yet`), { status: 404 });
  const conn = openInspector(path);
  try {
    const known = conn.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(input.table);
    if (!known) throw Object.assign(new Error(`Unknown table or view "${input.table}"`), { status: 400 });
    const limit = Math.min(MAX_INSPECT_ROWS, Math.max(1, Math.floor(input.limit ?? 100)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const columns = conn.prepare(`SELECT * FROM ${q(input.table)} LIMIT 0`).columns().map(c => c.name);
    const codecs = new Map(columns.filter(c => columns.includes(`${c}_codec`)).map(c => [c, `${c}_codec`]));
    const shown = columns.filter(c => ![...codecs.values()].includes(c));
    const filter = input.filter?.trim().toLowerCase();
    const raw = input.raw === true;
    const rows: unknown[][] = [];
    let note: string | undefined;
    if (!filter) {
      for (const row of conn.prepare(`SELECT * FROM ${q(input.table)} LIMIT ? OFFSET ?`).iterate(limit, offset))
        rows.push(shown.map(c => present(row[c]!, codecs.has(c) ? row[codecs.get(c)!] : undefined, raw)));
      return { columns: shown, rows };
    }
    let skipped = 0, scanned = 0;
    const isTable = conn.prepare("SELECT type FROM sqlite_master WHERE name=?").get(input.table)!.type === "table";
    const scan = isTable ? `SELECT * FROM ${q(input.table)} ORDER BY rowid DESC LIMIT ?` : `SELECT * FROM ${q(input.table)} LIMIT ?`;
    for (const row of conn.prepare(scan).iterate(FILTER_SCAN_ROWS)) {
      scanned++;
      const values = shown.map(c => present(row[c]!, codecs.has(c) ? row[codecs.get(c)!] : undefined, false));
      if (!values.some(v => (typeof v === "string" ? v : JSON.stringify(v) ?? "").toLowerCase().includes(filter))) continue;
      if (skipped++ < offset) continue;
      rows.push(raw ? shown.map(c => present(row[c]!, codecs.has(c) ? row[codecs.get(c)!] : undefined, true)) : values);
      if (rows.length >= limit) break;
    }
    if (scanned >= FILTER_SCAN_ROWS) note = `Filter searched the newest ${FILTER_SCAN_ROWS.toLocaleString("en")} rows; use agent-bridge db query for a full scan.`;
    return { columns: shown, rows, ...(note ? { note } : {}) };
  } finally { conn.close(); }
}

/** CLI only: one read-only statement with the decode functions available. */
export function inspectQuery(home: string, db: string, sql: string): { columns: string[]; rows: Record<string, unknown>[] } {
  const conn = openInspector(inspectDbPath(home, db));
  try {
    const statement = conn.prepare(sql);
    const rows = statement.all().map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, present(v as SQLInputValue, undefined, false)])));
    return { columns: statement.columns().map(c => c.name), rows };
  } finally { conn.close(); }
}

/** Writes a plain SQLite copy of one table or view with every compressed column decoded, for third-party viewers. */
export function exportDecompressed(home: string, db: string, table: string, out: string): number {
  if (existsSync(out)) throw new Error(`${out} already exists; choose a new file`);
  const conn = openInspector(inspectDbPath(home, db));
  const target = new DatabaseSync(out);
  try {
    if (!conn.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(table)) throw new Error(`Unknown table or view "${table}"`);
    const columns = conn.prepare(`SELECT * FROM ${q(table)} LIMIT 0`).columns().map(c => c.name);
    const codecs = new Map(columns.filter(c => columns.includes(`${c}_codec`)).map(c => [c, `${c}_codec`]));
    const shown = columns.filter(c => ![...codecs.values()].includes(c));
    // Lossless: a BLOB column (transcript raw bytes) is decoded to its exact bytes, never to text.
    const declared = new Map(conn.prepare(`PRAGMA table_info(${q(table)})`).all().map(r => [String(r.name), String(r.type).toUpperCase()]));
    const bytes = new Set(shown.filter(c => declared.get(c) === "BLOB"));
    // conversation_records.body is stored only when it differs from the raw text; viewers get the resolved text.
    const resolveBody = shown.includes("body") && bytes.has("raw") && shown.includes("source") && shown.includes("offset");
    target.exec(`CREATE TABLE ${q(table)} (${shown.map(c => bytes.has(c) ? `${q(c)} BLOB` : q(c)).join(",")})`);
    const insert = target.prepare(`INSERT INTO ${q(table)} VALUES(${shown.map(() => "?").join(",")})`);
    let count = 0;
    target.exec("BEGIN");
    for (const row of conn.prepare(`SELECT * FROM ${q(table)}`).iterate()) {
      const decode = (c: string): SQLInputValue => {
        const value = row[c] as SQLInputValue, codec = codecs.has(c) ? row[codecs.get(c)!] : undefined;
        if (value === null) return value;
        if (bytes.has(c)) return decodeBytes(value, codec);
        return codec !== undefined && Number(codec) !== 0 ? decodeText(value, codec) : value;
      };
      insert.run(...shown.map(c => c === "body" && resolveBody ? conversationBodyText(row.body, decodeBytes(row.raw, row.raw_codec)) : decode(c)));
      if (++count % 5000 === 0) { target.exec("COMMIT"); target.exec("BEGIN"); }
    }
    target.exec("COMMIT");
    return count;
  } finally { conn.close(); target.close(); }
}
