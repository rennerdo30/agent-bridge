import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  HISTORY_DB_NAME,
  decodeText,
  registerHistoryFunctions
} from "./chunk-K2G7MFNA.mjs";
import {
  ARCHIVE_DB_NAME
} from "./chunk-EVPBD2NK.mjs";
import {
  DB_FILE_NAME
} from "./chunk-7EOIPV3B.mjs";

// src/core/db-inspect.ts
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var INSPECT_DATABASES = { bridge: DB_FILE_NAME, history: HISTORY_DB_NAME, archive: ARCHIVE_DB_NAME };
var MAX_INSPECT_ROWS = 500;
var FILTER_SCAN_ROWS = 2e4;
var q = (s) => `"${s.replaceAll('"', '""')}"`;
function inspectDbPath(home, db) {
  if (!Object.hasOwn(INSPECT_DATABASES, db)) throw Object.assign(new Error(`Unknown database "${db}"; use bridge, history or archive`), { status: 400 });
  return join(home, INSPECT_DATABASES[db]);
}
function openInspector(path) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 250 });
  try {
    db.exec("PRAGMA query_only=ON");
    registerHistoryFunctions(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
function inspectCatalog(home) {
  const dbs = [];
  for (const db of Object.keys(INSPECT_DATABASES)) {
    const path = inspectDbPath(home, db);
    if (!existsSync(path)) continue;
    const conn = openInspector(path);
    try {
      const tables = conn.prepare("SELECT name,type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type DESC,name").all().filter((row) => !/_(data|idx|docsize|config|content)$/.test(String(row.name)) || row.type === "view").map((row) => {
        const entry = { name: String(row.name), kind: row.type === "view" ? "view" : "table" };
        if (entry.kind === "table") {
          try {
            entry.rows = Number(conn.prepare(`SELECT coalesce(max(rowid),0) n FROM ${q(entry.name)}`).get().n);
          } catch {
          }
        }
        return entry;
      });
      dbs.push({ db, bytes: statSync(path).size, tables });
    } finally {
      conn.close();
    }
  }
  return { dbs };
}
function present(value, codec, raw) {
  if (codec !== void 0 && codec !== null && Number(codec) !== 0) {
    const bytes = value instanceof Uint8Array ? value.length : 0;
    return raw ? { codec: Number(codec), bytes } : decodeText(value, codec);
  }
  if (value instanceof Uint8Array) {
    const text = Buffer.from(value).toString("utf8");
    return /[\u0000-\u0008\u000e-\u001f�]/.test(text) ? { blob: Buffer.from(value).toString("base64").slice(0, 4096), bytes: value.length } : text;
  }
  return typeof value === "bigint" ? String(value) : value;
}
function inspectRows(home, input) {
  const path = inspectDbPath(home, input.db);
  if (!existsSync(path)) throw Object.assign(new Error(`Database "${input.db}" does not exist yet`), { status: 404 });
  const conn = openInspector(path);
  try {
    const known = conn.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(input.table);
    if (!known) throw Object.assign(new Error(`Unknown table or view "${input.table}"`), { status: 400 });
    const limit = Math.min(MAX_INSPECT_ROWS, Math.max(1, Math.floor(input.limit ?? 100)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const columns = conn.prepare(`SELECT * FROM ${q(input.table)} LIMIT 0`).columns().map((c) => c.name);
    const codecs = new Map(columns.filter((c) => columns.includes(`${c}_codec`)).map((c) => [c, `${c}_codec`]));
    const shown = columns.filter((c) => ![...codecs.values()].includes(c));
    const filter = input.filter?.trim().toLowerCase();
    const raw = input.raw === true;
    const rows = [];
    let note;
    if (!filter) {
      for (const row of conn.prepare(`SELECT * FROM ${q(input.table)} LIMIT ? OFFSET ?`).iterate(limit, offset))
        rows.push(shown.map((c) => present(row[c], codecs.has(c) ? row[codecs.get(c)] : void 0, raw)));
      return { columns: shown, rows };
    }
    let skipped = 0, scanned = 0;
    const isTable = conn.prepare("SELECT type FROM sqlite_master WHERE name=?").get(input.table).type === "table";
    const scan = isTable ? `SELECT * FROM ${q(input.table)} ORDER BY rowid DESC LIMIT ?` : `SELECT * FROM ${q(input.table)} LIMIT ?`;
    for (const row of conn.prepare(scan).iterate(FILTER_SCAN_ROWS)) {
      scanned++;
      const values = shown.map((c) => present(row[c], codecs.has(c) ? row[codecs.get(c)] : void 0, false));
      if (!values.some((v) => (typeof v === "string" ? v : JSON.stringify(v) ?? "").toLowerCase().includes(filter))) continue;
      if (skipped++ < offset) continue;
      rows.push(raw ? shown.map((c) => present(row[c], codecs.has(c) ? row[codecs.get(c)] : void 0, true)) : values);
      if (rows.length >= limit) break;
    }
    if (scanned >= FILTER_SCAN_ROWS) note = `Filter searched the newest ${FILTER_SCAN_ROWS.toLocaleString("en")} rows; use agent-bridge db query for a full scan.`;
    return { columns: shown, rows, ...note ? { note } : {} };
  } finally {
    conn.close();
  }
}
function inspectQuery(home, db, sql) {
  const conn = openInspector(inspectDbPath(home, db));
  try {
    const statement = conn.prepare(sql);
    const rows = statement.all().map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, present(v, void 0, false)])));
    return { columns: statement.columns().map((c) => c.name), rows };
  } finally {
    conn.close();
  }
}
function exportDecompressed(home, db, table, out) {
  if (existsSync(out)) throw new Error(`${out} already exists; choose a new file`);
  const conn = openInspector(inspectDbPath(home, db));
  const target = new DatabaseSync(out);
  try {
    if (!conn.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name=?").get(table)) throw new Error(`Unknown table or view "${table}"`);
    const columns = conn.prepare(`SELECT * FROM ${q(table)} LIMIT 0`).columns().map((c) => c.name);
    const codecs = new Map(columns.filter((c) => columns.includes(`${c}_codec`)).map((c) => [c, `${c}_codec`]));
    const shown = columns.filter((c) => ![...codecs.values()].includes(c));
    target.exec(`CREATE TABLE ${q(table)} (${shown.map(q).join(",")})`);
    const insert = target.prepare(`INSERT INTO ${q(table)} VALUES(${shown.map(() => "?").join(",")})`);
    let count = 0;
    target.exec("BEGIN");
    for (const row of conn.prepare(`SELECT * FROM ${q(table)}`).iterate()) {
      insert.run(...shown.map((c) => {
        const value = row[c];
        return codecs.has(c) && Number(row[codecs.get(c)]) !== 0 ? decodeText(value, row[codecs.get(c)]) : value;
      }));
      if (++count % 5e3 === 0) {
        target.exec("COMMIT");
        target.exec("BEGIN");
      }
    }
    target.exec("COMMIT");
    return count;
  } finally {
    conn.close();
    target.close();
  }
}

export {
  INSPECT_DATABASES,
  MAX_INSPECT_ROWS,
  inspectCatalog,
  inspectRows,
  inspectQuery,
  exportDecompressed
};
