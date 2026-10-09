import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  HISTORY_STORE_VERSION,
  HISTORY_V1_PREFIX,
  HISTORY_V2_COPY_TABLES,
  chainRows,
  decodeBytes,
  decodeText,
  historyDbPath,
  historyReady,
  legacyTailConflicts,
  openHistoryReader,
  openHistoryStore
} from "./chunk-7QKZLAYZ.mjs";
import {
  extractBundle,
  readBundleManifest
} from "./chunk-QAXPILVJ.mjs";
import {
  ARCHIVE_DB_NAME,
  jobArchivePath,
  maintenanceLock,
  openArchive,
  openJobArchive
} from "./chunk-NWPQJULH.mjs";
import "./chunk-4EDVJNL7.mjs";
import {
  DB_FILE_NAME
} from "./chunk-7EOIPV3B.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/core/storage-finalize.ts
import { createHash as createHash2 } from "node:crypto";
import { closeSync as closeSync2, existsSync as existsSync2, lstatSync as lstatSync2, openSync as openSync2, readSync as readSync2, readdirSync as readdirSync2, rmSync, rmdirSync } from "node:fs";
import { join as join2, resolve as resolve2 } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// src/core/finalize-proof.ts
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
var KNOWN = {
  messages: { key: ["id", "recipient"], same: ["body"] },
  archived_messages: { key: ["id", "recipient"], same: ["body"] },
  conversation_records: { key: ["source", "generation", "offset"], same: ["conversation", "raw"] }
};
var ALIASES = { messages: ["messages", "archived_messages"], archived_messages: ["archived_messages", "messages"] };
var IGNORED_COLUMNS = /* @__PURE__ */ new Set(["retained_rowid"]);
var MAX_DIGEST_ROWS = 2e6;
var CHUNK_ROWS = 500;
var RESEEK_GAP = 10000n;
var SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
var ABSORBED_ROWS = "absorbed_rows";
var ABSORBED_FILES = "absorbed_files";
var COPY_TABLES = new Set(HISTORY_V2_COPY_TABLES);
var q = (s) => `"${s.replaceAll('"', '""')}"`;
function logicalTable(name) {
  return name.replace(/^retained_\d+_/, "").replace(/^v1_/, "");
}
function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${q(table)})`).all().map((row) => ({ name: String(row.name), pk: Number(row.pk) }));
}
function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
var primaryKey = (cols) => cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
function derivedTables(db) {
  const all = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all();
  const virtual = all.filter((row) => /^CREATE VIRTUAL TABLE/i.test(String(row.sql ?? ""))).map((row) => String(row.name));
  return new Set(all.map((row) => String(row.name)).filter((name) => virtual.some((v) => name === v || name.startsWith(`${v}_`))));
}
function provableTables(db) {
  const derived = derivedTables(db);
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all().map((row) => String(row.name)).filter((name) => !derived.has(name));
}
function value(row, column) {
  const v = row[column] ?? null;
  const codec = row[`${column}_codec`];
  if (codec === void 0 || v === null) return v;
  return column === "raw" ? decodeBytes(v, codec) : decodeText(v, codec);
}
function sameValue(a, b) {
  a ??= null;
  b ??= null;
  if (a === null || b === null) return a === b;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    const bytes = (x) => x instanceof Uint8Array ? Buffer.from(x.buffer, x.byteOffset, x.byteLength) : Buffer.from(String(x), "utf8");
    return bytes(a).equals(bytes(b));
  }
  if ((typeof a === "number" || typeof a === "bigint") && (typeof b === "number" || typeof b === "bigint")) return String(a) === String(b);
  return a === b;
}
function sameColumn(a, b, column) {
  const ca = a[`${column}_codec`], cb = b[`${column}_codec`];
  if (ca !== void 0 && cb !== void 0 && String(ca) === String(cb) && sameValue(a[column] ?? null, b[column] ?? null)) return true;
  return sameValue(value(a, column), value(b, column));
}
function rowDigest(row, names) {
  const hash = createHash("sha256");
  for (const name of names) {
    const v = value(row, name);
    const type = v === null ? "null" : v instanceof Uint8Array ? "blob" : typeof v === "bigint" || typeof v === "number" && Number.isInteger(v) ? "int" : typeof v;
    const bytes = v instanceof Uint8Array ? Buffer.from(v) : Buffer.from(String(v), "utf8");
    hash.update(`${name.length}:${name}:${type}:${bytes.length}:`).update(bytes);
  }
  return hash.digest("hex");
}
function compareSql(a, b) {
  const rank = (v) => v === null || v === void 0 ? 0 : typeof v === "number" || typeof v === "bigint" ? 1 : typeof v === "string" ? 2 : 3;
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) return a < b ? -1 : a > b ? 1 : 0;
  const bytes = (v) => typeof v === "string" ? Buffer.from(v, "utf8") : Buffer.from(v);
  return Buffer.compare(bytes(a), bytes(b));
}
var compareKeys = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    const c = compareSql(a[i], b[i]);
    if (c) return c;
  }
  return 0;
};
function indexedBy(db, table, key) {
  const info = db.prepare(`PRAGMA table_info(${q(table)})`).all();
  if (key.length === 1 && info.some((c) => c.name === key[0] && Number(c.pk) === 1 && /^INTEGER$/i.test(String(c.type))) && info.filter((c) => Number(c.pk) > 0).length === 1) return true;
  for (const index of db.prepare(`PRAGMA index_list(${q(table)})`).all()) {
    const cols = db.prepare(`PRAGMA index_xinfo(${q(String(index.name))})`).all().filter((c) => Number(c.key) === 1);
    if (cols.length >= key.length && key.every((k, n) => cols[n].name === k && String(cols[n].coll ?? "BINARY").toUpperCase() === "BINARY" && !Number(cols[n].desc))) return true;
  }
  return false;
}
function keyOf(values) {
  return values.map((v) => v === null || v === void 0 ? "n" : v instanceof Uint8Array ? `b${Buffer.from(v).toString("base64")}` : typeof v === "bigint" || typeof v === "number" ? `i${String(v)}` : `t${v}`).join("\0");
}
function tableProof(candidate, table, ctx, aligned, chunkRows = CHUNK_ROWS) {
  const logical = logicalTable(table);
  const own = columns(candidate, table);
  const allColumns = own.map((c) => c.name);
  const cols = allColumns.filter((c) => !IGNORED_COLUMNS.has(c));
  const sorted = [...cols].sort();
  const total = Number(candidate.prepare(`SELECT count(*) n FROM ${q(table)}`).get().n);
  const names = ALIASES[logical] ?? [logical];
  const targets = ctx.live.flatMap((l) => names.filter((n) => !l.exclude?.has(n) && hasTable(l.db, n)).map((name) => ({ l, name, cols: columns(l.db, name) })));
  const where = [...new Set(targets.map((t) => t.l.label))].join(", ");
  const absorbedDb = ctx.live.find((l) => hasTable(l.db, ABSORBED_ROWS))?.db;
  const digest = (row) => rowDigest(row, sorted);
  const has = (t, wanted) => wanted.every((w) => t.cols.some((c) => c.name === w));
  let key = KNOWN[logical]?.key ?? (primaryKey(own).length ? primaryKey(own) : void 0);
  if (!key) for (const t of targets) {
    const pk = primaryKey(t.cols);
    if (pk.length && pk.every((k) => cols.includes(k))) {
      key = pk;
      break;
    }
  }
  if (key && !key.every((k) => cols.includes(k))) key = void 0;
  const sameCols = KNOWN[logical]?.same ?? [];
  const keyed = key ? targets.filter((t) => has(t, key) && has(t, sameCols)) : [];
  const full = key ? [] : targets.filter((t) => has(t, cols));
  let problem;
  if (!targets.length) problem = `no live database has a ${logical} table`;
  else if (key && !keyed.length) problem = `no live ${logical} table has the key ${key.join(",")}`;
  else if (!key && !full.length) problem = `rows without a key, and no live ${logical} table can be compared row by row`;
  const matches = (candidateRow, liveRow) => key ? key.every((k) => sameValue(candidateRow[k] ?? null, liveRow[k] ?? null)) && sameCols.every((c) => sameColumn(candidateRow, liveRow, c)) : cols.every((c) => sameColumn(candidateRow, liveRow, c));
  const projection = (available, wanted) => [...new Set(wanted.flatMap((c) => available.includes(`${c}_codec`) ? [c, `${c}_codec`] : [c]))].filter((c) => available.includes(c)).map(q).join(",");
  const needed = key ? [...key, ...sameCols] : cols;
  let digestSets;
  const fullSets = () => digestSets ??= full.flatMap((t) => {
    if (Number(t.l.db.prepare(`SELECT count(*) n FROM ${q(t.name)}`).get().n) > MAX_DIGEST_ROWS) return [];
    const set = /* @__PURE__ */ new Set(), all = t.l.db.prepare(`SELECT * FROM ${q(t.name)}`);
    all.setReadBigInts(true);
    for (const row of all.iterate()) set.add(digest(row));
    return [set];
  });
  const lookup = (rows) => {
    if (problem || !key && !fullSets().length) return rows.map(() => "missing");
    if (!key) {
      const sets = fullSets();
      return rows.map((row) => sets.some((s) => s.has(digest(row))) ? "present" : "missing");
    }
    const found = /* @__PURE__ */ new Map();
    const withNull = rows.filter((row) => key.some((k) => row[k] === null || row[k] === void 0));
    const plain = rows.filter((row) => !withNull.includes(row));
    for (const t of keyed) {
      if (plain.length) {
        const tuple = key.length === 1 ? q(key[0]) : `(${key.map(q).join(",")})`;
        const values = plain.map(() => key.length === 1 ? "?" : `(${key.map(() => "?").join(",")})`).join(",");
        const s = t.l.db.prepare(`SELECT ${projection(t.cols.map((c) => c.name), needed)} FROM ${q(t.name)} WHERE ${tuple} IN (${key.length === 1 ? values : `VALUES ${values}`})`);
        s.setReadBigInts(true);
        for (const match of s.all(...plain.flatMap((row) => key.map((k) => row[k])))) {
          const id = keyOf(key.map((k) => match[k]));
          (found.get(id) ?? found.set(id, []).get(id)).push(match);
        }
      }
      if (withNull.length) {
        const s = t.l.db.prepare(`SELECT ${projection(t.cols.map((c) => c.name), needed)} FROM ${q(t.name)} WHERE ${key.map((k) => `${q(k)} IS ?`).join(" AND ")}`);
        s.setReadBigInts(true);
        for (const row of withNull) for (const match of s.all(...key.map((k) => row[k] ?? null))) {
          const id = keyOf(key.map((k) => match[k]));
          (found.get(id) ?? found.set(id, []).get(id)).push(match);
        }
      }
    }
    return rows.map((row) => {
      const candidates2 = found.get(keyOf(key.map((k) => row[k] ?? null)));
      if (!candidates2?.length) return "missing";
      return candidates2.some((match) => sameCols.every((c) => sameColumn(row, match, c))) ? "present" : "conflict";
    });
  };
  const absorbed = (rows) => {
    const out = /* @__PURE__ */ new Set();
    if (!absorbedDb || !rows.length) return out;
    const digests = rows.map(digest);
    const s = absorbedDb.prepare(`SELECT digest FROM ${ABSORBED_ROWS} WHERE source_table=? AND digest IN (${digests.map(() => "?").join(",")})`);
    const known = new Set(s.all(logical, ...digests).map((r) => String(r.digest)));
    rows.forEach((row, n) => {
      if (known.has(digests[n])) out.add(row);
    });
    return out;
  };
  function* chunks(after = -1n) {
    let rowid = true;
    let source;
    const keyList = key ? key.map(q).join(",") : "";
    const merging = key && !sameCols.length && after === -1n && indexedBy(candidate, table, key) ? keyed.filter((t) => indexedBy(t.l.db, t.name, key)) : [];
    const mergeCursors = merging.map((t) => {
      const s = t.l.db.prepare(`SELECT ${keyList} FROM ${q(t.name)} ORDER BY ${keyList}`);
      s.setReadBigInts(true);
      const it = s.iterate();
      const first = it.next();
      return { it, current: first.done ? void 0 : key.map((k) => first.value[k] ?? null) };
    });
    const merged = (row) => {
      const wanted = key.map((k) => row[k] ?? null);
      let hit = false;
      for (const c of mergeCursors) {
        while (c.current && compareKeys(c.current, wanted) < 0) {
          const next = c.it.next();
          c.current = next.done ? void 0 : key.map((k) => next.value[k] ?? null);
        }
        if (c.current && compareKeys(c.current, wanted) === 0) hit = true;
      }
      return hit;
    };
    if (mergeCursors.length) {
      try {
        const s = candidate.prepare(`SELECT rowid AS "__cid", ${keyList} FROM ${q(table)} ORDER BY ${keyList}`);
        s.setReadBigInts(true);
        source = s.iterate();
      } catch {
        rowid = false;
        const s = candidate.prepare(`SELECT * FROM ${q(table)} ORDER BY ${keyList}`);
        s.setReadBigInts(true);
        source = s.iterate();
      }
    } else try {
      const s = candidate.prepare(`SELECT rowid AS "__cid", ${projection(allColumns, [...needed, ...aligned?.by ? [aligned.by] : []])} FROM ${q(table)} WHERE rowid>? ORDER BY rowid`);
      s.setReadBigInts(true);
      source = s.iterate(after);
    } catch {
      rowid = false;
      const s = candidate.prepare(`SELECT * FROM ${q(table)}`);
      s.setReadBigInts(true);
      source = s.iterate();
    }
    let cursor, current;
    const targetColumns = aligned ? projection(columns(aligned.db, aligned.table).map((c) => c.name), needed) : "";
    const whole = (rows) => {
      if (!rowid || !rows.length) return rows;
      const s = candidate.prepare(`SELECT rowid AS "__cid", * FROM ${q(table)} WHERE rowid IN (${rows.map(() => "?").join(",")})`);
      s.setReadBigInts(true);
      const byId = new Map(s.all(...rows.map((r) => r.__cid)).map((r) => [String(r.__cid), r]));
      return rows.map((r) => byId.get(String(r.__cid)) ?? r);
    };
    const point = aligned && aligned.db.prepare(`SELECT rowid AS "__tid", ${targetColumns} FROM ${q(aligned.table)} WHERE rowid=?`);
    point?.setReadBigInts(true);
    const seek = (id) => {
      cursor?.return?.();
      const s = aligned.db.prepare(`SELECT rowid AS "__tid", ${targetColumns} FROM ${q(aligned.table)} WHERE rowid>=? ORDER BY rowid`);
      s.setReadBigInts(true);
      cursor = s.iterate(id);
      const next = cursor.next();
      current = next.done ? void 0 : next.value;
    };
    const alignedRow = (id) => {
      if (!cursor) seek(id);
      else if (!current || id < current.__tid) return point.get(id);
      else if (id - current.__tid > RESEEK_GAP) seek(id);
      while (current && current.__tid < id) {
        const next = cursor.next();
        current = next.done ? void 0 : next.value;
      }
      return current && current.__tid === id ? current : void 0;
    };
    try {
      for (; ; ) {
        const batch = [];
        for (let next = source.next(); !next.done; next = source.next()) {
          batch.push(next.value);
          if (batch.length >= chunkRows) break;
        }
        if (!batch.length) return;
        const result = { last: rowid && !mergeCursors.length ? batch.at(-1).__cid : null, rows: [], present: 0, absorbed: 0 };
        let rest = batch;
        if (mergeCursors.length) {
          rest = [];
          for (const row of batch) if (merged(row)) result.present++;
          else rest.push(row);
        } else if (aligned) {
          rest = [];
          for (const row of batch) {
            const id = aligned.by ? row[aligned.by] : row.__cid;
            const match = typeof id === "bigint" ? alignedRow(id) : void 0;
            if (match && matches(row, match)) result.present++;
            else rest.push(row);
          }
        }
        const statuses = lookup(rest);
        const open = rest.filter((_, n) => statuses[n] !== "present");
        const fetched = whole(open);
        const full2 = new Map(open.map((row, n) => [row, fetched[n]]));
        const known = absorbed(rest.filter((_, n) => statuses[n] === "missing").map((row) => full2.get(row)));
        rest.forEach((row, n) => {
          const status = statuses[n];
          if (status === "present") {
            result.present++;
            return;
          }
          const complete = full2.get(row);
          if (status === "missing" && known.has(complete)) result.absorbed++;
          else result.rows.push({ row: complete, status });
        });
        ctx.progress?.add(batch.length);
        yield result;
        if (batch.length < chunkRows) return;
      }
    } finally {
      cursor?.return?.();
      source.return?.();
      for (const c of mergeCursors) c.it.return?.();
    }
  }
  return { table, logical, total, columns: sorted, allColumns, where, problem, digest, chunks };
}
function alignedTarget(table, ctx, sameDb) {
  const logical = logicalTable(table);
  if (!ctx.history || !COPY_TABLES.has(logical) || !hasTable(ctx.history, logical)) return void 0;
  if (sameDb && table === logical) return void 0;
  return { db: ctx.history, table: logical, by: table.startsWith("retained_") ? "retained_rowid" : void 0 };
}
function reasonsOf(p, missing, conflicts) {
  const reasons = [];
  if (missing) reasons.push(p.problem ? `${p.table}: ${missing} of ${p.total} rows, and ${p.problem}` : `${p.table}: ${missing} of ${p.total} rows are not in ${p.where}`);
  if (conflicts) reasons.push(`${p.table}: ${conflicts} rows conflict with different content in ${p.where}`);
  return reasons;
}
function proveTable(candidate, table, ctx, aligned = alignedTarget(table, ctx)) {
  const p = tableProof(candidate, table, ctx, aligned);
  if (!p.total) return null;
  let missing = 0, conflicts = 0;
  for (const chunk of p.chunks()) for (const { status } of chunk.rows) status === "missing" ? missing++ : conflicts++;
  const reasons = reasonsOf(p, missing, conflicts);
  return reasons.length ? reasons.join("; ") : null;
}
function proveByManifest(db, reference, progress) {
  const proven = /* @__PURE__ */ new Set(), reasons = [];
  for (const [name, expected] of Object.entries(reference.manifest)) {
    const table = reference.prefix + name;
    if (!hasTable(db, table)) {
      if (expected.rows) reasons.push(`${table}: missing, but the migration manifest lists ${expected.rows} rows`);
      continue;
    }
    progress?.note(`checking ${table} against the verified migration manifest\u2026`);
    const names = ["__rowid", ...columns(db, table).map((c) => c.name)];
    let chain = "", rows = 0;
    for (const row of db.prepare(`SELECT rowid AS __rowid,* FROM ${q(table)} ORDER BY rowid`).iterate()) {
      chain = chainRows(chain, [row], names);
      if (++rows % CHUNK_ROWS === 0) progress?.add(CHUNK_ROWS);
    }
    progress?.add(rows % CHUNK_ROWS);
    const sha = chain || createHash("sha256").digest("hex");
    if (rows !== expected.rows || sha !== expected.sha256) reasons.push(`${table}: ${rows} rows with sha256 ${sha.slice(0, 12)}\u2026, but the verified migration copied ${expected.rows} rows with ${expected.sha256.slice(0, 12)}\u2026`);
    else proven.add(table);
  }
  return { proven, reasons };
}
function isSqlite(path) {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(16);
    return readSync(fd, head, 0, 16, 0) === 16 && head.equals(SQLITE_HEADER);
  } finally {
    closeSync(fd);
  }
}
var samePath = (a, b) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
function proveDatabase(path, ctx) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 1e3 });
  } catch (err) {
    return [`cannot be opened (${err.message})`];
  }
  try {
    const reasons = [];
    let manifest = /* @__PURE__ */ new Set();
    if (ctx.reference && samePath(ctx.reference.path, path)) {
      const result = proveByManifest(db, ctx.reference, ctx.progress);
      manifest = result.proven;
      for (const reason of result.reasons) ctx.progress?.note(`  ${reason}; proving it row by row instead`);
    }
    for (const table of provableTables(db)) {
      if (manifest.has(table)) continue;
      ctx.progress?.note(`checking ${basename(path)}:${table}\u2026`);
      const reason = proveTable(db, table, ctx);
      if (reason) reasons.push(reason);
    }
    return reasons;
  } catch (err) {
    return [`cannot be read completely (${err.message})`];
  } finally {
    db.close();
  }
}
function estimateRows(path) {
  if (!existsSync(path) || !lstatSync(path).isFile() || !isSqlite(path)) return 0;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 1e3 });
  } catch {
    return 0;
  }
  try {
    let n = 0;
    for (const table of provableTables(db)) {
      try {
        n += Number(db.prepare(`SELECT coalesce(max(rowid),0) n FROM ${q(table)}`).get().n);
      } catch {
      }
    }
    return n;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}
function sameBytes(a, b) {
  const sa = lstatSync(a), sb = lstatSync(b);
  if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
  const fa = openSync(a, "r"), fb = openSync(b, "r");
  try {
    const ba = Buffer.alloc(1024 * 1024), bb = Buffer.alloc(1024 * 1024);
    for (let at = 0; at < sa.size; ) {
      const na = readSync(fa, ba, 0, ba.length, at), nb = readSync(fb, bb, 0, bb.length, at);
      if (na !== nb || !ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
      if (!na) break;
      at += na;
    }
    return true;
  } finally {
    closeSync(fa);
    closeSync(fb);
  }
}
function fileSha256(path) {
  const hash = createHash("sha256"), fd = openSync(path, "r"), buffer = Buffer.alloc(1024 * 1024);
  try {
    for (let n; n = readSync(fd, buffer, 0, buffer.length, null); ) hash.update(buffer.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}
function absorbedFile(path, live) {
  const archive = live.find((l) => hasTable(l.db, ABSORBED_FILES));
  if (!archive) return false;
  const sha = fileSha256(path);
  const row = archive.db.prepare(`SELECT bytes FROM ${ABSORBED_FILES} WHERE sha256=?`).get(sha);
  return !!row && createHash("sha256").update(row.bytes).digest("hex") === sha;
}
var SIDECAR = /-(wal|shm|journal)$/;
function sidecars(path) {
  return ["-wal", "-shm", "-journal"].map((suffix) => `${path}${suffix}`).filter(existsSync);
}
function candidateFiles(path) {
  const st = lstatSync(path);
  if (!st.isDirectory()) return [path];
  const entries = readdirSync(path);
  return entries.filter((entry) => !(SIDECAR.test(entry) && entries.includes(entry.replace(SIDECAR, "")))).flatMap((entry) => candidateFiles(join(path, entry)));
}
function proveFile(path, ctx, copies = [], root = path) {
  const st = lstatSync(path);
  const name = relative(dirname(root), path) || basename(path);
  if (st.isSymbolicLink()) return [`${name} is a symbolic link`];
  if (st.isDirectory()) {
    const entries = readdirSync(path);
    return entries.filter((entry) => !(SIDECAR.test(entry) && entries.includes(entry.replace(SIDECAR, "")))).flatMap((entry) => proveFile(join(path, entry), ctx, copies, root));
  }
  if (!st.isFile()) return [`${name} is not a regular file`];
  if (isSqlite(path)) return proveDatabase(path, ctx).map((reason) => `${name}: ${reason}`);
  const rel = relative(root, path);
  if (rel && copies.some((dir) => existsSync(join(dir, rel)) && sameBytes(path, join(dir, rel)))) return [];
  if (absorbedFile(path, ctx.live)) return [];
  return [`${name} is not a database and no identical copy exists`];
}
function proofProgress(total, report, now = () => Date.now()) {
  const start = now();
  let done = 0, last = 0;
  return {
    add(rows) {
      done += rows;
      const t = now();
      if (t - last < 2e3) return;
      last = t;
      const rate = done / Math.max(1, (t - start) / 1e3);
      const left = Math.max(0, total - done);
      const pct = total ? Math.min(100, 100 * done / total) : 100;
      report(`  ${done.toLocaleString("en")} of ~${total.toLocaleString("en")} rows (${pct.toFixed(1)}%), ${Math.round(rate).toLocaleString("en")} rows/s, ETA ${rate > 0 ? `${Math.ceil(left / rate)} s` : "unknown"}`);
    },
    note(text) {
      report(text);
    },
    done: () => done
  };
}

// src/core/storage-finalize.ts
var LEGACY_BRIDGE_TABLES = ["history_fts", "history_documents", "history_tags", "history_files", "history_sessions", "conversation_records", "conversation_sources", "conversation_parts", "conversations", "conversation_projects", "conversation_memberships"];
var COLD_JOBS = ["cold-storage", "jobs-v1"];
function size(path) {
  if (!existsSync2(path)) return 0;
  const st = lstatSync2(path);
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  return readdirSync2(path).reduce((n, name) => n + size(join2(path, name)), 0);
}
function jobArchiveComplete(home) {
  if (!existsSync2(jobArchivePath(join2(home, "jobs.json")))) return false;
  const db = openJobArchive(join2(home, "jobs.json"));
  try {
    return db?.prepare("SELECT state FROM archive_migrations WHERE version=1").get()?.state === "complete";
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
function historyIsVerified(home) {
  const history = historyDbPath(join2(home, DB_FILE_NAME));
  if (!existsSync2(history)) return false;
  const db = new DatabaseSync2(history, { readOnly: true, timeout: 1e3 });
  try {
    return historyReady(db);
  } finally {
    db.close();
  }
}
function referenceSnapshot(history) {
  try {
    const state = history.prepare("SELECT snapshot,status,manifest,source FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
    if (state?.status !== "verified" || !state.snapshot || !state.manifest) return void 0;
    const manifest = JSON.parse(String(state.manifest));
    if (!manifest || typeof manifest !== "object" || !Object.values(manifest).every((v) => Number.isInteger(v?.rows) && typeof v?.sha256 === "string")) return void 0;
    return { path: String(state.snapshot), prefix: state.source === "history-v1" ? HISTORY_V1_PREFIX : "", manifest };
  } catch {
    return void 0;
  }
}
function openLive(home) {
  const live = [];
  const bridge = join2(home, DB_FILE_NAME), archive = join2(home, ARCHIVE_DB_NAME), history = historyDbPath(bridge);
  let historyDb;
  try {
    if (existsSync2(bridge)) live.push({ label: "bridge.db", db: new DatabaseSync2(bridge, { readOnly: true, timeout: 5e3 }), exclude: new Set(LEGACY_BRIDGE_TABLES) });
    if (existsSync2(archive)) live.push({ label: "archive.db", db: new DatabaseSync2(archive, { readOnly: true, timeout: 5e3 }) });
    if (existsSync2(history)) {
      historyDb = openHistoryReader(history, 5e3);
      live.push({ label: "history.db", db: historyDb });
    }
  } catch (err) {
    for (const l of live) l.db.close();
    throw err;
  }
  return { live, history: historyDb, close: () => {
    for (const l of live) l.db.close();
  } };
}
function historyCandidates(db) {
  const derived = derivedTables(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE ? OR name LIKE 'retained\\_%' ESCAPE '\\') ORDER BY name").all(`${HISTORY_V1_PREFIX}%`).map((row) => String(row.name));
  const virtual = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'").all().map((row) => String(row.name)));
  return names.filter((name) => !derived.has(name) || virtual.has(name)).map((name) => ({ name, derived: derived.has(name) }));
}
function proveHistoryTables(db, progress) {
  const candidates2 = historyCandidates(db);
  const ctx = { live: [{ label: "history.db v2", db, exclude: new Set(candidates2.map((c) => c.name)) }], history: db, progress };
  const results = candidates2.filter((c) => !c.derived).map((c) => {
    progress?.note(`checking history.db:${c.name}\u2026`);
    return { name: c.name, reason: proveTable(db, c.name, ctx, alignedTarget(c.name, ctx, true)) };
  });
  for (const c of candidates2.filter((c2) => c2.derived)) {
    const base = `${c.name.slice(0, c.name.length - logicalTable(c.name).length)}history_documents`;
    const unproven = results.find((r) => r.name === base && r.reason !== null);
    results.push({ name: c.name, reason: unproven ? `search index of ${base}, which is kept` : null });
  }
  return results;
}
function fileCandidates(home) {
  const out = [];
  const add = (path, reason, copies = []) => {
    const kind = lstatSync2(path).isDirectory() ? "directory" : "file";
    out.push({ item: { kind, path, bytes: size(path) + sidecars(path).reduce((n, s) => n + size(s), 0), reason }, copies });
  };
  const listed = (dir) => existsSync2(dir) ? readdirSync2(dir) : [];
  const notSidecar = (dir, name, names) => !(/-(wal|shm|journal)$/.test(name) && names.includes(name.replace(/-(wal|shm|journal)$/, "")));
  const snapshots = join2(home, ".migration-snapshots"), snapshotNames = listed(snapshots);
  for (const name of snapshotNames) if (notSidecar(snapshots, name, snapshotNames)) add(join2(snapshots, name), "pre-migration snapshot; every row it holds exists in the live databases");
  const homeNames = listed(home);
  for (const name of homeNames) if (/^bridge\.db\.backup-/.test(name) && notSidecar(home, name, homeNames)) add(join2(home, name), "old whole-database backup; every row it holds exists in the live databases");
  const archive = join2(home, "archive"), archiveNames = listed(archive);
  for (const name of archiveNames) if (/^bridge\.db\.backup/.test(name) && notSidecar(archive, name, archiveNames)) add(join2(archive, name), "old whole-database backup; every row it holds exists in the live databases");
  const backups = join2(home, "backups");
  const published = [...listed(backups).filter((n) => !n.startsWith(".")).map((n) => join2(backups, n)), ...listed(join2(backups, "archive")).map((n) => join2(backups, "archive", n))];
  for (const name of listed(backups)) if (name.startsWith(".pending-"))
    add(join2(backups, name), "incomplete automatic backup; every file in it exists elsewhere", [home, ...published]);
  return out;
}
function bundleEntries(dir, verify) {
  const entries = /* @__PURE__ */ new Map(), failures = [];
  for (const manifest of existsSync2(dir) ? readdirSync2(dir).filter((name) => name.endsWith(".manifest.json")) : []) {
    try {
      if (verify) extractBundle(join2(dir, manifest));
      for (const entry of readBundleManifest(join2(dir, manifest)).entries) {
        const set = entries.get(entry.name) ?? /* @__PURE__ */ new Set();
        set.add(`${entry.bytes}:${entry.sha256}`);
        entries.set(entry.name, set);
      }
    } catch (err) {
      failures.push(`${manifest} does not verify (${err.message})`);
    }
  }
  return { entries, failures };
}
function fileDigest(path) {
  const hash = createHash2("sha256"), fd = openSync2(path, "r"), buffer = Buffer.alloc(1024 * 1024);
  try {
    for (let n; n = readSync2(fd, buffer, 0, buffer.length, null); ) hash.update(buffer.subarray(0, n));
  } finally {
    closeSync2(fd);
  }
  return hash.digest("hex");
}
function bundledOriginals(home, verify) {
  const cold = join2(home, ...COLD_JOBS);
  const dirs = ["archive-originals", "root-originals"].map((name) => join2(cold, name)).filter(existsSync2);
  if (!dirs.length) return [];
  const { entries, failures } = bundleEntries(cold, verify);
  return dirs.map((dir) => {
    const files = [], unlisted = [];
    let bytes = 0;
    for (const name of readdirSync2(dir)) {
      const path = join2(dir, name), st = lstatSync2(path);
      const listed = st.isFile() && [...entries.get(name) ?? []].some((e) => e.startsWith(`${st.size}:`));
      if (listed && (!verify || entries.get(name).has(`${st.size}:${fileDigest(path)}`))) {
        files.push(path);
        bytes += st.size;
      } else unlisted.push(name);
    }
    return { dir, files, bytes, unlisted, failures };
  });
}
function candidates(home) {
  const blockers = [];
  const historyVerified = historyIsVerified(home);
  if (!historyVerified) blockers.push("History store v2 is not verified yet; nothing in the old format may be removed.");
  if (!jobArchiveComplete(home)) blockers.push("Job archive import is not complete yet; job copies stay.");
  const bridgeTables = [];
  const bridge = join2(home, DB_FILE_NAME);
  if (historyVerified && existsSync2(bridge)) {
    const db = new DatabaseSync2(bridge, { readOnly: true, timeout: 1e3 });
    try {
      for (const name of LEGACY_BRIDGE_TABLES) if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name))
        bridgeTables.push({ kind: "table", path: `bridge.db:${name}`, bytes: 0, reason: "legacy history, copied into history.db and verified" });
    } finally {
      db.close();
    }
  }
  return { blockers, bridgeTables, history: historyVerified, files: historyVerified ? fileCandidates(home) : [] };
}
function plan(blockers, items, kept, proven) {
  return { ready: blockers.length === 0, blockers, items, bytes: items.reduce((n, i) => n + i.bytes, 0), kept, proven };
}
var samePath2 = (a, b) => process.platform === "win32" ? resolve2(a).toLowerCase() === resolve2(b).toLowerCase() : resolve2(a) === resolve2(b);
function planFinalize(home, options = {}) {
  if (options.prove) return runFinalize(home, options.report ?? (() => {
  }), { dryRun: true });
  const found = candidates(home);
  const items = found.bridgeTables.map((i) => ({ ...i, reason: `${i.reason}; proven against history.db v2 at removal` })), kept = [];
  if (found.history) {
    const db = openHistoryReader(historyDbPath(join2(home, DB_FILE_NAME)), 1e3);
    let reference;
    try {
      reference = referenceSnapshot(db);
      for (const { name } of historyCandidates(db))
        items.push({ kind: "table", path: `history.db:${name}`, bytes: 0, reason: "earlier history format or failed attempt; proven against the v2 tables row by row at removal" });
    } finally {
      db.close();
    }
    for (const { item } of found.files) {
      const isReference = reference && samePath2(reference.path, item.path);
      items.push({ ...item, reason: isReference ? "source snapshot of the verified history migration; its history tables are proven by the migration manifest, every other row against the live databases at removal" : `${item.reason}; proven row by row at removal` });
    }
  }
  if (!found.blockers.length) for (const group of bundledOriginals(home, false)) {
    if (group.files.length) items.push({ kind: "directory", path: group.dir, bytes: group.bytes, reason: `${group.files.length} job copy originals listed in bundle manifests; their bytes are verified against the bundles at removal` });
    if (group.unlisted.length || group.failures.length) kept.push({ kind: "directory", path: group.dir, bytes: size(group.dir) - group.bytes, reason: summarize([...group.failures, ...group.unlisted.map((name) => `${name} is in no bundle manifest`)]) });
  }
  return plan(found.blockers, items, kept, false);
}
var summarize = (reasons) => reasons.length > 3 ? `${reasons.slice(0, 3).join("; ")}; and ${reasons.length - 3} more` : reasons.join("; ");
var withAbsorbHint = (reason) => /rows are not in|rows, and no live|no identical copy exists/.test(reason) ? `${reason} (run agent-bridge storage absorb to import what exists only here)` : reason;
function verifyLegacyBridge(bridge, history, report, progress) {
  const blockers = [];
  const has = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const ctx = { live: [{ label: "history.db", db: history }], history, progress };
  for (const table of LEGACY_BRIDGE_TABLES) {
    if (table === "history_fts" || !has(bridge, table)) continue;
    if (!has(history, table)) {
      blockers.push(`history.db has no ${table} table.`);
      continue;
    }
    report(table === "conversation_records" ? "comparing every legacy transcript record byte-for-byte\u2026" : `checking that every ${table} row exists in history.db\u2026`);
    const proof = tableProof(bridge, table, ctx, { db: history, table });
    let missing = 0, different = 0;
    for (const chunk of proof.chunks()) for (const { status } of chunk.rows) status === "missing" ? missing++ : different++;
    if (table === "conversation_records") {
      if (missing) blockers.push(`${missing} legacy transcript records are not in history.db yet (the legacy tail has not caught up).`);
      if (different) blockers.push(`${different} legacy transcript records differ from their copy in history.db.`);
      report(`  ${proof.total.toLocaleString("en")} records checked, ${missing} missing, ${different} different`);
    } else if (table === "history_documents") {
      if (missing + different) report(`  ${missing + different} legacy search documents were re-derived after a reindex; their source records are verified above.`);
    } else if (missing + different) blockers.push(`${missing + different} ${table} rows exist only in bridge.db.`);
  }
  return blockers;
}
function verifyBeforeFinalize(home, report = () => {
}) {
  const blockers = [];
  const bridgeFile = join2(home, DB_FILE_NAME), historyFile = historyDbPath(bridgeFile);
  if (!existsSync2(historyFile)) return ["history.db does not exist."];
  const history = openHistoryReader(historyFile, 5e3);
  try {
    if (!historyReady(history)) return ["History store v2 is not verified."];
    const conflicts = legacyTailConflicts(history);
    if (conflicts) blockers.push(`${conflicts} legacy tail conflict(s): bridge.db rows whose bytes differ from history.db or lack a conversation; both copies are retained in history_legacy_conflicts. Resolve them before finalize.`);
    const unfinished = history.prepare("SELECT count(*) n FROM history_copy_state WHERE verified=0").get().n;
    if (Number(unfinished)) blockers.push("The history copy has unverified tables.");
  } finally {
    history.close();
  }
  return blockers;
}
function proofWork(home, found) {
  let rows = 0;
  const add = (db, tables) => {
    for (const t of tables) {
      try {
        rows += Number(db.prepare(`SELECT coalesce(max(rowid),0) n FROM "${t.replaceAll('"', '""')}"`).get().n);
      } catch {
      }
    }
  };
  const bridge = join2(home, DB_FILE_NAME);
  if (found.bridgeTables.length) {
    const db = new DatabaseSync2(bridge, { readOnly: true, timeout: 5e3 });
    try {
      add(db, found.bridgeTables.map((i) => i.path.slice("bridge.db:".length)).filter((t) => t !== "history_fts"));
    } finally {
      db.close();
    }
  }
  const history = new DatabaseSync2(historyDbPath(bridge), { readOnly: true, timeout: 5e3 });
  try {
    add(history, historyCandidates(history).filter((c) => !c.derived).map((c) => c.name));
  } finally {
    history.close();
  }
  for (const { item } of found.files) for (const file of item.kind === "directory" ? [] : [item.path]) rows += estimateRows(file);
  return rows;
}
function runFinalize(home, report, options = {}) {
  const dry = options.dryRun === true;
  const release = dry ? () => {
  } : maintenanceLock(home);
  try {
    const found = candidates(home);
    const jobArchiveOnly = dry && options.ignoreJobArchive === true && found.history && found.blockers.every((b) => b.startsWith("Job archive"));
    if (found.blockers.length && !jobArchiveOnly) return plan(found.blockers, [], [], true);
    const verification = verifyBeforeFinalize(home, report);
    if (verification.length) return plan(verification, [], [], true);
    const started = Date.now();
    const progress = proofProgress(proofWork(home, found), report);
    report(dry ? "verification passed; proving every listed item (nothing is removed)\u2026" : "verification passed; removing the old-format data that is proven redundant\u2026");
    const removed = [], kept = [];
    if (found.bridgeTables.length) {
      const db = new DatabaseSync2(join2(home, DB_FILE_NAME), { timeout: 3e4, readOnly: dry });
      try {
        if (!dry) db.exec("BEGIN IMMEDIATE");
        try {
          const history2 = openHistoryReader(historyDbPath(join2(home, DB_FILE_NAME)), 5e3);
          let blockers;
          try {
            blockers = verifyLegacyBridge(db, history2, report, progress);
          } finally {
            history2.close();
          }
          if (blockers.length) {
            if (!dry) db.exec("ROLLBACK");
            return plan(blockers, [], [], true);
          }
          for (const item of found.bridgeTables) {
            const name = item.path.slice("bridge.db:".length);
            const sized = { ...item, bytes: 0 };
            if (!dry) {
              db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
              report(`removed ${item.path}`);
            }
            removed.push(sized);
          }
          if (!dry) db.exec("COMMIT");
        } catch (err) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw err;
        }
        if (!dry) {
          report("compacting bridge.db (only the remaining core data is rewritten)\u2026");
          db.exec("VACUUM");
        }
      } finally {
        db.close();
      }
    }
    {
      const file = historyDbPath(join2(home, DB_FILE_NAME));
      const db = dry ? openHistoryReader(file, 5e3) : openHistoryStore(file);
      try {
        let dropped = 0;
        if (!dry) db.exec("BEGIN IMMEDIATE");
        try {
          for (const { name, reason } of proveHistoryTables(db, progress)) {
            const item = { kind: "table", path: `history.db:${name}`, bytes: 0, reason: "earlier history format or failed attempt; every row exists in the verified v2 tables" };
            if (reason !== null) {
              kept.push({ ...item, reason });
              report(`kept ${item.path}: ${reason}`);
              continue;
            }
            if (!dry) {
              db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
              report(`removed ${item.path}`);
              dropped++;
            }
            removed.push(item);
          }
          if (!dry) db.exec("COMMIT");
        } catch (err) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw err;
        }
        if (dropped) db.exec("VACUUM");
      } finally {
        db.close();
      }
    }
    const { live, history, close } = openLive(home);
    try {
      const reference = history ? referenceSnapshot(history) : void 0;
      const ctx = { live, history, reference, progress };
      const files = [...found.files].sort((a, b) => Number(!!reference && samePath2(reference.path, a.item.path)) - Number(!!reference && samePath2(reference.path, b.item.path)));
      for (const { item, copies } of files) {
        report(`checking ${item.path}\u2026`);
        const reasons = proveFile(item.path, ctx, copies);
        if (reasons.length) {
          const reason = withAbsorbHint(summarize(reasons));
          kept.push({ ...item, reason });
          report(`kept ${item.path}: ${reason}`);
          continue;
        }
        if (!dry) {
          for (const path of [...sidecars(item.path), item.path]) rmSync(path, { recursive: true, force: true });
          report(`removed ${item.path}`);
        }
        removed.push(item);
      }
    } finally {
      close();
    }
    for (const group of jobArchiveOnly ? [] : bundledOriginals(home, true)) {
      if (!dry) for (const path of group.files) rmSync(path, { force: true });
      if (group.files.length) {
        removed.push({ kind: "directory", path: group.dir, bytes: group.bytes, reason: `${group.files.length} job copy originals that a verified bundle restores byte-exact` });
        if (!dry) report(`removed ${group.files.length} bundled originals from ${group.dir}`);
      }
      if (group.unlisted.length || group.failures.length) kept.push({ kind: "directory", path: group.dir, bytes: size(group.dir), reason: summarize([...group.failures, ...group.unlisted.map((name) => `${name} is in no verified bundle`)]) });
      else if (!dry) try {
        rmdirSync(group.dir);
      } catch {
      }
    }
    report(`proof finished in ${Math.round((Date.now() - started) / 1e3)} s (${progress.done().toLocaleString("en")} rows read)`);
    return plan([], removed, kept, true);
  } finally {
    release();
  }
}
function rollbackHistoryStore(home) {
  const bridge = join2(home, DB_FILE_NAME);
  const legacy = new DatabaseSync2(bridge, { readOnly: true, timeout: 5e3 });
  try {
    if (!legacy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_records'").get())
      throw new Error("The legacy history in bridge.db was already removed by storage finalize; rollback is no longer possible.");
  } finally {
    legacy.close();
  }
  const db = openHistoryStore(historyDbPath(bridge));
  try {
    const state = db.prepare("SELECT status FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
    if (!state) return "No history migration has started; readers already use the legacy history.";
    db.prepare("UPDATE history_migration SET status='failed',manifest=? WHERE version=?").run(JSON.stringify({ error: "History store rolled back by the owner; legacy history in bridge.db is in use. Run agent-bridge reindex to migrate again.", resumeStatus: "copying", rolledBackFrom: state.status }), HISTORY_STORE_VERSION);
    return "Rolled back: search and transcripts read the legacy history in bridge.db again. The new copy in history.db is kept.";
  } finally {
    db.close();
  }
}

// src/core/storage-absorb.ts
import { lstatSync as lstatSync3, readFileSync } from "node:fs";
import { basename as basename2, join as join3, resolve as resolve3 } from "node:path";
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";
var MAX_ABSORB_FILE_BYTES = 256 * 1024 * 1024;
var BATCH_ROWS = 500;
var q2 = (s) => `"${s.replaceAll('"', '""')}"`;
var ABSORB_SCHEMA = `
CREATE TABLE IF NOT EXISTS ${ABSORBED_ROWS} (source_table TEXT NOT NULL, digest TEXT NOT NULL, row TEXT NOT NULL, origin TEXT NOT NULL, absorbed_at INTEGER NOT NULL, PRIMARY KEY(source_table, digest));
CREATE TABLE IF NOT EXISTS ${ABSORBED_FILES} (sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL, size INTEGER NOT NULL, origin TEXT NOT NULL, absorbed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS absorb_progress (source TEXT NOT NULL, table_name TEXT NOT NULL, after_rowid INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(source, table_name));`;
function encodeAbsorbedRow(row, columns2) {
  return JSON.stringify({
    columns: columns2,
    values: columns2.map((c) => {
      const v = row[c] ?? null;
      if (v === null) return null;
      if (typeof v === "bigint") return { i: v.toString() };
      if (typeof v === "number") return Number.isInteger(v) ? { i: String(v) } : { r: v };
      if (typeof v === "string") return { t: v };
      return { b: Buffer.from(v).toString("base64") };
    })
  });
}
function signature(path) {
  const st = lstatSync3(path);
  return `${path}|${st.size}|${Math.trunc(st.mtimeMs)}`;
}
function archiveMessage(archive, row, origin, now) {
  const cols = archive.prepare("PRAGMA table_info(messages)").all();
  const values = cols.map((col) => {
    const name = String(col.name);
    if (row[name] !== void 0 && row[name] !== null) return row[name];
    if (name === "archive_reason") return `absorbed from ${origin}`;
    if (name === "archived_at") return now;
    if (!Number(col.notnull)) return null;
    return /INT/i.test(String(col.type)) ? 0 : "";
  });
  if (row.id === null || row.id === void 0 || row.recipient === null || row.recipient === void 0) return;
  archive.prepare(`INSERT OR IGNORE INTO messages(${cols.map((c) => q2(String(c.name))).join(",")}) VALUES(${cols.map(() => "?").join(",")})`).run(...values);
}
function absorbDatabase(path, ctx, archive, source, options) {
  let db;
  try {
    db = new DatabaseSync3(path, { readOnly: true, timeout: 1e3 });
  } catch (err) {
    source.problems.push(`${basename2(path)} cannot be opened (${err.message})`);
    return;
  }
  try {
    const sig = signature(path), origin = basename2(path);
    const reference = ctx.reference && samePath3(ctx.reference.path, path) ? ctx.reference : void 0;
    for (const table of provableTables(db)) {
      if (reference) {
        const name = table.startsWith(reference.prefix) ? table.slice(reference.prefix.length) : void 0;
        const expected = name !== void 0 ? reference.manifest[name] : void 0;
        if (expected && Number(db.prepare(`SELECT count(*) n FROM ${q2(table)}`).get().n) === expected.rows) continue;
      }
      const p = tableProof(db, table, ctx, alignedTarget(table, ctx), options.batchRows);
      if (!p.total) continue;
      const progress = archive?.prepare("SELECT after_rowid, done FROM absorb_progress WHERE source=? AND table_name=?").get(sig, table);
      if (progress?.done) continue;
      const conflictsBefore = source.conflicts;
      let after = BigInt(Number(progress?.after_rowid ?? -1));
      options.report?.(`  ${table}: ${p.total.toLocaleString("en")} rows`);
      for (const chunk of p.chunks(after)) {
        if (archive) archive.exec("BEGIN IMMEDIATE");
        try {
          for (const { row, status } of chunk.rows) {
            if (status === "conflict") {
              source.conflicts++;
              continue;
            }
            source.rows++;
            if (!archive) continue;
            archive.prepare(`INSERT OR IGNORE INTO ${ABSORBED_ROWS}(source_table,digest,row,origin,absorbed_at) VALUES(?,?,?,?,?)`).run(p.logical, p.digest(row), encodeAbsorbedRow(row, p.allColumns), origin, options.now);
            if (p.logical === "messages" || p.logical === "archived_messages") archiveMessage(archive, row, origin, options.now);
          }
          if (chunk.last !== null) after = chunk.last;
          if (archive) {
            archive.prepare("INSERT INTO absorb_progress(source,table_name,after_rowid) VALUES(?,?,?) ON CONFLICT(source,table_name) DO UPDATE SET after_rowid=excluded.after_rowid").run(sig, table, chunk.last ?? -1n);
            archive.exec("COMMIT");
          }
        } catch (err) {
          if (archive?.isTransaction) archive.exec("ROLLBACK");
          throw Object.assign(err, { absorbWrite: true });
        }
      }
      if (source.conflicts === conflictsBefore) archive?.prepare("INSERT INTO absorb_progress(source,table_name,after_rowid,done) VALUES(?,?,?,1) ON CONFLICT(source,table_name) DO UPDATE SET done=1").run(sig, table, after);
      else archive?.prepare("DELETE FROM absorb_progress WHERE source=? AND table_name=?").run(sig, table);
    }
  } catch (err) {
    if (err.absorbWrite) throw err;
    source.problems.push(`${basename2(path)} cannot be read completely (${err.message})`);
  } finally {
    db.close();
  }
}
function absorbFile(path, root, copies, ctx, archive, source, now) {
  if (!proveFile(path, ctx, copies, root).length) return;
  const st = lstatSync3(path);
  if (!st.isFile()) {
    source.problems.push(`${basename2(path)} is not a regular file`);
    return;
  }
  if (st.size > MAX_ABSORB_FILE_BYTES) {
    source.problems.push(`${basename2(path)} is larger than ${MAX_ABSORB_FILE_BYTES / 1024 ** 2} MiB and is not absorbed`);
    return;
  }
  source.files++;
  if (!archive) return;
  const bytes = readFileSync(path), sha = fileSha256(path);
  archive.prepare(`INSERT OR IGNORE INTO ${ABSORBED_FILES}(sha256,bytes,size,origin,absorbed_at) VALUES(?,?,?,?,?)`).run(sha, bytes, bytes.length, path, now);
}
var samePath3 = (a, b) => process.platform === "win32" ? resolve3(a).toLowerCase() === resolve3(b).toLowerCase() : resolve3(a) === resolve3(b);
function runAbsorb(home, options = {}) {
  const result = { applied: !!options.apply, blockers: [], sources: [], rows: 0, files: 0, conflicts: 0 };
  if (!historyIsVerified(home)) {
    result.blockers.push("History store v2 is not verified yet; old copies are compared against it, so absorb waits.");
    return result;
  }
  const release = options.apply ? maintenanceLock(home) : () => {
  };
  const opened = [];
  try {
    const bridge = join3(home, DB_FILE_NAME), historyPath = historyDbPath(bridge), archivePath = join3(home, ARCHIVE_DB_NAME);
    const open = (path) => {
      const db = new DatabaseSync3(path, { readOnly: true, timeout: 5e3 });
      opened.push(db);
      return db;
    };
    let archive;
    if (options.apply) {
      archive = openArchive(archivePath);
      opened.push(archive);
      archive.exec(ABSORB_SCHEMA);
    }
    const history = open(historyPath);
    const live = [{ label: "bridge.db", db: open(bridge), exclude: new Set(LEGACY_BRIDGE_TABLES) }, { label: "history.db", db: history }];
    const archiveLive = archive ?? (lstatOrNull(archivePath) ? open(archivePath) : void 0);
    if (archiveLive) live.splice(1, 0, { label: "archive.db", db: archiveLive });
    const ctx = { live, history, reference: referenceSnapshot(history) };
    const settings = { ...options, batchRows: options.batchRows ?? BATCH_ROWS, now: options.now ?? Date.now() };
    for (const { item, copies } of fileCandidates(home)) {
      const source = { path: item.path, rows: 0, files: 0, conflicts: 0, problems: [] };
      options.report?.(`${options.apply ? "absorbing" : "checking"} ${item.path}\u2026`);
      for (const file of candidateFiles(item.path)) {
        if (lstatSync3(file).isSymbolicLink()) {
          source.problems.push(`${basename2(file)} is a symbolic link`);
          continue;
        }
        if (isSqlite(file)) absorbDatabase(file, ctx, archive, source, settings);
        else absorbFile(file, item.path, copies, ctx, archive, source, settings.now);
      }
      options.report?.(`  ${source.rows} rows and ${source.files} files ${options.apply ? "absorbed" : "to absorb"}, ${source.conflicts} conflicts${source.problems.length ? `; ${source.problems.join("; ")}` : ""}`);
      result.sources.push(source);
      result.rows += source.rows;
      result.files += source.files;
      result.conflicts += source.conflicts;
    }
    return result;
  } finally {
    for (const db of opened.reverse()) db.close();
    release();
  }
}
function lstatOrNull(path) {
  try {
    return lstatSync3(path);
  } catch {
    return null;
  }
}

// src/cli/storage.ts
var USAGE = "Usage: agent-bridge storage finalize [--check | --yes] [--json] | storage absorb [--yes] [--json] | storage rollback-history\nfinalize lists the old-format data that the verified new storage replaces (quick: nothing is read row by row); --check proves every item\nand removes nothing; --yes proves again and removes exactly the proven items, then compacts bridge.db.\nabsorb lists rows and files that exist only in old backups and snapshots; with --yes it imports them losslessly into archive.db.";
var gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
function runStorage(rest, home, out) {
  if (rest[0] === "rollback-history" && rest.length === 1) {
    try {
      out(rollbackHistoryStore(home));
      return 0;
    } catch (err) {
      out(String(err.message));
      return 1;
    }
  }
  const args = new Set(rest.slice(1));
  if (rest[0] === "absorb" && [...args].every((a) => a === "--yes" || a === "--json")) {
    const json2 = args.has("--json");
    let result;
    try {
      result = runAbsorb(home, { apply: args.has("--yes"), report: (line) => {
        if (!json2) out(line);
      } });
    } catch (err) {
      out(String(err.message));
      return 1;
    }
    if (json2) {
      out(JSON.stringify(result, null, 2));
      return result.blockers.length ? 1 : 0;
    }
    if (result.blockers.length) {
      out("Not ready; nothing was imported:");
      for (const blocker of result.blockers) out(`  - ${blocker}`);
      return 1;
    }
    out(`${result.rows} rows and ${result.files} files ${result.applied ? "imported into archive.db" : "exist only in old copies"}; ${result.conflicts} conflicting rows (their copies stay).`);
    if (!result.applied) out("Run again with --yes to import them (stop all bridge processes first), then agent-bridge storage finalize.");
    return 0;
  }
  const finalizeFlags = /* @__PURE__ */ new Set(["--yes", "--json", "--check"]);
  if (rest[0] !== "finalize" || [...args].some((a) => !finalizeFlags.has(a)) || args.has("--yes") && args.has("--check")) {
    out(USAGE);
    return 2;
  }
  const json = args.has("--json"), check = args.has("--check"), apply = args.has("--yes");
  const report = (line) => {
    if (!json) out(line);
  };
  const plan2 = apply ? runFinalize(home, report) : check ? runFinalize(home, report, { dryRun: true }) : planFinalize(home);
  if (json) {
    out(JSON.stringify({ ...plan2, removed: apply && plan2.ready }, null, 2));
    return plan2.ready ? 0 : 1;
  }
  if (!plan2.ready) {
    out("Not ready; nothing was removed:");
    for (const blocker of plan2.blockers) out(`  - ${blocker}`);
    return 1;
  }
  const shown = (item) => item.kind === "table" ? "-".padStart(10) : gib(item.bytes).padStart(10);
  const kept = () => {
    if (!plan2.kept.length) return;
    out("Kept, because they are not proven redundant row by row:");
    for (const item of plan2.kept) out(`  ${shown(item)}  ${item.path}  (${item.reason})`);
  };
  if (!apply) {
    for (const item of plan2.items) out(`  ${shown(item)}  ${item.path}  (${item.reason})`);
    kept();
    out(check ? `${plan2.items.length} items, ${gib(plan2.bytes)}, proven redundant; nothing was removed. Run with --yes to remove them (they are proven again then).` : `${plan2.items.length} candidates, ${gib(plan2.bytes)} in files. Nothing was read row by row yet: --check proves them without removing anything, --yes proves and removes.`);
    return 0;
  }
  kept();
  out(`Removed ${plan2.items.length} items, ${gib(plan2.bytes)}.`);
  return 0;
}
export {
  runStorage
};
