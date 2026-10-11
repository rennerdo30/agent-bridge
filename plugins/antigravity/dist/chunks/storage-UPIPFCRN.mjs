import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  HISTORY_STORE_VERSION,
  HISTORY_V1_PREFIX,
  decodeBytes,
  decodeHistoryRow,
  decodeText,
  historyDbPath,
  historyReady,
  legacyTailConflicts,
  openHistoryReader,
  openHistoryStore
} from "./chunk-35TTMNMP.mjs";
import {
  extractBundle,
  readBundleManifest
} from "./chunk-PGQJBVIR.mjs";
import {
  ARCHIVE_DB_NAME,
  jobArchivePath,
  maintenanceLock,
  openArchive,
  openJobArchive
} from "./chunk-ZPDQU7BI.mjs";
import "./chunk-4EDVJNL7.mjs";
import {
  DB_FILE_NAME
} from "./chunk-7EOIPV3B.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/core/storage-finalize.ts
import { createHash as createHash2 } from "node:crypto";
import { closeSync as closeSync2, existsSync as existsSync2, lstatSync as lstatSync2, openSync as openSync2, readSync as readSync2, readdirSync as readdirSync2, rmSync, rmdirSync } from "node:fs";
import { join as join2 } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// src/core/finalize-proof.ts
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
var KNOWN = {
  messages: { key: ["id", "recipient"], same: ["body"] },
  archived_messages: { key: ["id", "recipient"], same: ["body"] },
  conversation_records: { key: ["source", "generation", "offset"], same: ["conversation", "raw"] }
};
var ALIASES = { messages: ["messages", "archived_messages"], archived_messages: ["archived_messages", "messages"] };
var IGNORED_COLUMNS = /* @__PURE__ */ new Set(["retained_rowid"]);
var MAX_DIGEST_ROWS = 2e6;
var SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
var ABSORBED_ROWS = "absorbed_rows";
var ABSORBED_FILES = "absorbed_files";
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
function same(a, b) {
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
function absorbedLookup(live) {
  const archive = live.find((l) => hasTable(l.db, ABSORBED_ROWS));
  return archive?.db.prepare(`SELECT 1 FROM ${ABSORBED_ROWS} WHERE source_table=? AND digest=?`);
}
function tableClassifier(candidate, table, live) {
  const logical = logicalTable(table);
  const own = columns(candidate, table);
  const cols = own.map((c) => c.name).filter((c) => !IGNORED_COLUMNS.has(c));
  const sorted = [...cols].sort();
  const total = Number(candidate.prepare(`SELECT count(*) n FROM ${q(table)}`).get().n);
  const names = ALIASES[logical] ?? [logical];
  const targets = live.flatMap((l) => names.filter((n) => !l.exclude?.has(n) && hasTable(l.db, n)).map((name) => ({ l, name, cols: columns(l.db, name) })));
  const where = [...new Set(targets.map((t) => t.l.label))].join(", ");
  const absorbed = absorbedLookup(live);
  const digest = (row) => rowDigest(row, sorted);
  const isAbsorbed = (row) => !!absorbed?.get(logical, digest(row));
  const base = { table, logical, total, columns: sorted, where, digest };
  if (!targets.length) return { ...base, problem: `no live database has a ${logical} table`, classify: (row) => isAbsorbed(row) ? "absorbed" : "missing" };
  const has = (t, wanted) => wanted.every((w) => t.cols.some((c) => c.name === w));
  let key = KNOWN[logical]?.key ?? (primaryKey(own).length ? primaryKey(own) : void 0);
  if (!key) for (const t of targets) {
    const pk = primaryKey(t.cols);
    if (pk.length && pk.every((k) => cols.includes(k))) {
      key = pk;
      break;
    }
  }
  const sameCols = KNOWN[logical]?.same ?? [];
  if (key && key.every((k) => cols.includes(k))) {
    const keyCols = key;
    const lookups = targets.filter((t) => has(t, keyCols) && has(t, sameCols)).map((t) => {
      const s = t.l.db.prepare(`SELECT * FROM ${q(t.name)} WHERE ${keyCols.map((k) => `${q(k)} IS ?`).join(" AND ")}`);
      s.setReadBigInts(true);
      return s;
    });
    if (!lookups.length) return { ...base, problem: `no live ${logical} table has the key ${keyCols.join(",")}`, classify: (row) => isAbsorbed(row) ? "absorbed" : "missing" };
    return {
      ...base,
      classify(row) {
        const args = keyCols.map((k) => row[k] ?? null);
        let found = false;
        for (const s of lookups) for (const match of s.all(...args)) {
          if (sameCols.every((c) => same(value(match, c), value(row, c)))) return "present";
          found = true;
        }
        if (isAbsorbed(row)) return "absorbed";
        return found ? "conflict" : "missing";
      }
    };
  }
  const sets = [];
  for (const t of targets) {
    if (!has(t, cols)) continue;
    if (Number(t.l.db.prepare(`SELECT count(*) n FROM ${q(t.name)}`).get().n) > MAX_DIGEST_ROWS) continue;
    const set = /* @__PURE__ */ new Set();
    const all = t.l.db.prepare(`SELECT * FROM ${q(t.name)}`);
    all.setReadBigInts(true);
    for (const row of all.iterate()) set.add(digest(row));
    sets.push(set);
  }
  if (!sets.length) return { ...base, problem: `rows without a key, and no live ${logical} table can be compared row by row`, classify: (row) => isAbsorbed(row) ? "absorbed" : "missing" };
  return { ...base, classify: (row) => sets.some((s) => s.has(digest(row))) ? "present" : isAbsorbed(row) ? "absorbed" : "missing" };
}
function candidateRows(db, table) {
  const statement = db.prepare(`SELECT * FROM ${q(table)}`);
  statement.setReadBigInts(true);
  return statement.iterate();
}
function proveTable(candidate, table, live) {
  const c = tableClassifier(candidate, table, live);
  if (!c.total) return null;
  let missing = 0, conflicts = 0;
  for (const row of candidateRows(candidate, table)) {
    const status = c.classify(row);
    if (status === "missing") missing++;
    else if (status === "conflict") conflicts++;
  }
  const reasons = [];
  if (missing) reasons.push(c.problem ? `${table}: ${missing} of ${c.total} rows, and ${c.problem}` : `${table}: ${missing} of ${c.total} rows are not in ${c.where}`);
  if (conflicts) reasons.push(`${table}: ${conflicts} rows conflict with different content in ${c.where}`);
  return reasons.length ? reasons.join("; ") : null;
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
function proveDatabase(path, live) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 1e3 });
  } catch (err) {
    return [`cannot be opened (${err.message})`];
  }
  try {
    return provableTables(db).map((table) => proveTable(db, table, live)).filter((r) => r !== null);
  } catch (err) {
    return [`cannot be read completely (${err.message})`];
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
function proveFile(path, live, copies = [], root = path) {
  const st = lstatSync(path);
  const name = relative(dirname(root), path) || basename(path);
  if (st.isSymbolicLink()) return [`${name} is a symbolic link`];
  if (st.isDirectory()) {
    const entries = readdirSync(path);
    return entries.filter((entry) => !(SIDECAR.test(entry) && entries.includes(entry.replace(SIDECAR, "")))).flatMap((entry) => proveFile(join(path, entry), live, copies, root));
  }
  if (!st.isFile()) return [`${name} is not a regular file`];
  if (isSqlite(path)) return proveDatabase(path, live).map((reason) => `${name}: ${reason}`);
  const rel = relative(root, path);
  if (rel && copies.some((dir) => existsSync(join(dir, rel)) && sameBytes(path, join(dir, rel)))) return [];
  if (absorbedFile(path, live)) return [];
  return [`${name} is not a database and no identical copy exists`];
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
function tableBytes(db, name) {
  try {
    return Number(db.prepare("SELECT coalesce(sum(pgsize),0) n FROM dbstat WHERE name=? OR name LIKE ?").get(name, `${name}_%`).n);
  } catch {
    return 0;
  }
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
function openLive(home) {
  const live = [];
  const bridge = join2(home, DB_FILE_NAME), archive = join2(home, ARCHIVE_DB_NAME), history = historyDbPath(bridge);
  try {
    if (existsSync2(bridge)) live.push({ label: "bridge.db", db: new DatabaseSync2(bridge, { readOnly: true, timeout: 5e3 }), exclude: new Set(LEGACY_BRIDGE_TABLES) });
    if (existsSync2(archive)) live.push({ label: "archive.db", db: new DatabaseSync2(archive, { readOnly: true, timeout: 5e3 }) });
    if (existsSync2(history)) live.push({ label: "history.db", db: new DatabaseSync2(history, { readOnly: true, timeout: 5e3 }) });
  } catch (err) {
    for (const l of live) l.db.close();
    throw err;
  }
  return { live, close: () => {
    for (const l of live) l.db.close();
  } };
}
function historyCandidates(db) {
  const derived = derivedTables(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE ? OR name LIKE 'retained\\_%' ESCAPE '\\') ORDER BY name").all(`${HISTORY_V1_PREFIX}%`).map((row) => String(row.name));
  const virtual = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'").all().map((row) => String(row.name)));
  return names.filter((name) => !derived.has(name) || virtual.has(name)).map((name) => ({ name, derived: derived.has(name) }));
}
function proveHistoryTables(db) {
  const candidates2 = historyCandidates(db);
  const v2 = [{ label: "history.db v2", db, exclude: new Set(candidates2.map((c) => c.name)) }];
  const results = candidates2.filter((c) => !c.derived).map((c) => ({ name: c.name, reason: proveTable(db, c.name, v2) }));
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
function verifiedBundleEntries(dir) {
  const entries = /* @__PURE__ */ new Map(), failures = [];
  for (const manifest of existsSync2(dir) ? readdirSync2(dir).filter((name) => name.endsWith(".manifest.json")) : []) {
    try {
      extractBundle(join2(dir, manifest));
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
function bundledOriginals(home) {
  const cold = join2(home, ...COLD_JOBS);
  const dirs = ["archive-originals", "root-originals"].map((name) => join2(cold, name)).filter(existsSync2);
  if (!dirs.length) return [];
  const { entries, failures } = verifiedBundleEntries(cold);
  return dirs.map((dir) => {
    const files = [], unlisted = [];
    let bytes = 0;
    for (const name of readdirSync2(dir)) {
      const path = join2(dir, name), st = lstatSync2(path);
      if (st.isFile() && entries.get(name)?.has(`${st.size}:${fileDigest(path)}`)) {
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
        bridgeTables.push({ kind: "table", path: `bridge.db:${name}`, bytes: tableBytes(db, name), reason: "legacy history, copied into history.db and verified" });
    } finally {
      db.close();
    }
  }
  return { blockers, bridgeTables, history: historyVerified, files: historyVerified ? fileCandidates(home) : [] };
}
function plan(blockers, items, kept) {
  return { ready: blockers.length === 0, blockers, items, bytes: items.reduce((n, i) => n + i.bytes, 0), kept };
}
function planFinalize(home) {
  const found = candidates(home);
  const items = [...found.bridgeTables], kept = [];
  if (found.history) {
    const db = openHistoryReader(historyDbPath(join2(home, DB_FILE_NAME)), 1e3);
    try {
      for (const { name, reason } of proveHistoryTables(db)) {
        const item = { kind: "table", path: `history.db:${name}`, bytes: tableBytes(db, name), reason: "earlier history format or failed attempt; every row exists in the verified v2 tables" };
        if (reason === null) items.push(item);
        else kept.push({ ...item, reason });
      }
    } finally {
      db.close();
    }
    const { live, close } = openLive(home);
    try {
      for (const { item, copies } of found.files) {
        const reasons = proveFile(item.path, live, copies);
        if (!reasons.length) items.push(item);
        else kept.push({ ...item, reason: withAbsorbHint(summarize(reasons)) });
      }
    } finally {
      close();
    }
  }
  if (!found.blockers.length) for (const group of bundledOriginals(home)) {
    if (group.files.length) items.push({ kind: "directory", path: group.dir, bytes: group.bytes, reason: `${group.files.length} job copy originals that a verified bundle restores byte-exact` });
    if (group.unlisted.length || group.failures.length) kept.push({ kind: "directory", path: group.dir, bytes: size(group.dir) - group.bytes, reason: summarize([...group.failures, ...group.unlisted.map((name) => `${name} is in no verified bundle`)]) });
  }
  return plan(found.blockers, items, kept);
}
var summarize = (reasons) => reasons.length > 3 ? `${reasons.slice(0, 3).join("; ")}; and ${reasons.length - 3} more` : reasons.join("; ");
var withAbsorbHint = (reason) => /rows are not in|rows, and no live|no identical copy exists/.test(reason) ? `${reason} (run agent-bridge storage absorb to import what exists only here)` : reason;
var PRESENCE_KEYS = {
  conversations: ["id"],
  conversation_sources: ["id"],
  conversation_parts: ["source", "part"],
  conversation_projects: ["project"],
  conversation_memberships: ["project", "conversation"],
  history_documents: ["id"],
  history_tags: ["id", "type", "value"],
  history_files: ["path"],
  history_sessions: ["alias"]
};
function verifyLegacyBridge(bridge, history, report) {
  const blockers = [];
  const has = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (has(bridge, "conversation_records")) {
    report("comparing every legacy transcript record byte-for-byte\u2026");
    const same2 = history.prepare("SELECT * FROM conversation_records WHERE id=?");
    const mapped = history.prepare("SELECT target_id FROM history_legacy_tail WHERE source_id=?");
    let checked = 0, missing = 0, different = 0;
    for (const row of bridge.prepare("SELECT * FROM conversation_records ORDER BY id").iterate()) {
      let target = same2.get(row.id);
      if (!target || target.source !== row.source || target.generation !== row.generation || target.offset !== row.offset) {
        const tail = mapped.get(row.id);
        target = tail ? same2.get(tail.target_id) : void 0;
      }
      if (!target) missing++;
      else {
        const decoded = decodeHistoryRow("conversation_records", target);
        if (!decoded.raw.equals(Buffer.from(row.raw)) || decoded.conversation !== row.conversation || decoded.source !== row.source) different++;
      }
      if (++checked % 5e4 === 0) report(`  ${checked.toLocaleString("en")} records checked`);
    }
    if (missing) blockers.push(`${missing} legacy transcript records are not in history.db yet (the legacy tail has not caught up).`);
    if (different) blockers.push(`${different} legacy transcript records differ from their copy in history.db.`);
    report(`  ${checked.toLocaleString("en")} records checked, ${missing} missing, ${different} different`);
  }
  for (const [table, keys] of Object.entries(PRESENCE_KEYS)) {
    if (!has(bridge, table)) continue;
    if (!has(history, table)) {
      blockers.push(`history.db has no ${table} table.`);
      continue;
    }
    report(`checking that every ${table} row exists in history.db\u2026`);
    const where = keys.map((k) => `"${k}"=?`).join(" AND ");
    const lookup = history.prepare(`SELECT 1 FROM "${table}" WHERE ${where}`);
    let missing = 0;
    for (const row of bridge.prepare(`SELECT ${keys.map((k) => `"${k}"`).join(",")} FROM "${table}"`).iterate())
      if (!lookup.get(...keys.map((k) => row[k]))) missing++;
    if (missing && table !== "history_documents") blockers.push(`${missing} ${table} rows exist only in bridge.db.`);
    else if (missing) report(`  ${missing} legacy search documents were re-derived after a reindex; their source records are verified above.`);
  }
  return blockers;
}
function verifyBeforeFinalize(home, report = () => {
}) {
  const blockers = [];
  const bridgeFile = join2(home, DB_FILE_NAME), historyFile = historyDbPath(bridgeFile);
  if (!existsSync2(historyFile)) return ["history.db does not exist."];
  const history = openHistoryReader(historyFile, 5e3);
  const bridge = new DatabaseSync2(bridgeFile, { readOnly: true, timeout: 5e3 });
  try {
    if (!historyReady(history)) return ["History store v2 is not verified."];
    report("checking history.db integrity\u2026");
    if (history.prepare("PRAGMA quick_check").all().some((row) => row.quick_check !== "ok")) blockers.push("history.db failed quick_check.");
    blockers.push(...verifyLegacyBridge(bridge, history, report));
    const conflicts = legacyTailConflicts(history);
    if (conflicts) blockers.push(`${conflicts} legacy tail conflict(s): bridge.db rows whose bytes differ from history.db or lack a conversation; both copies are retained in history_legacy_conflicts. Resolve them before finalize.`);
    const unfinished = history.prepare("SELECT count(*) n FROM history_copy_state WHERE verified=0").get().n;
    if (Number(unfinished)) blockers.push("The history copy has unverified tables.");
  } finally {
    history.close();
    bridge.close();
  }
  return blockers;
}
function runFinalize(home, report) {
  const release = maintenanceLock(home);
  try {
    const found = candidates(home);
    if (found.blockers.length) return plan(found.blockers, [], []);
    const verification = verifyBeforeFinalize(home, report);
    if (verification.length) return plan(verification, [], []);
    report("verification passed; removing the old-format data that is proven redundant\u2026");
    const removed = [], kept = [];
    if (found.bridgeTables.length) {
      const db = new DatabaseSync2(join2(home, DB_FILE_NAME), { timeout: 3e4 });
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const history = openHistoryReader(historyDbPath(join2(home, DB_FILE_NAME)), 5e3);
          let blockers;
          try {
            blockers = verifyLegacyBridge(db, history, report);
          } finally {
            history.close();
          }
          if (blockers.length) {
            db.exec("ROLLBACK");
            return plan(blockers, [], []);
          }
          for (const item of found.bridgeTables) {
            db.exec(`DROP TABLE IF EXISTS "${item.path.slice("bridge.db:".length).replaceAll('"', '""')}"`);
            removed.push(item);
            report(`removed ${item.path}`);
          }
          db.exec("COMMIT");
        } catch (err) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw err;
        }
        report("compacting bridge.db (only the remaining core data is rewritten)\u2026");
        db.exec("VACUUM");
      } finally {
        db.close();
      }
    }
    {
      const db = openHistoryStore(historyDbPath(join2(home, DB_FILE_NAME)));
      try {
        let dropped = 0;
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const { name, reason } of proveHistoryTables(db)) {
            const item = { kind: "table", path: `history.db:${name}`, bytes: tableBytes(db, name), reason: "earlier history format or failed attempt; every row exists in the verified v2 tables" };
            if (reason !== null) {
              kept.push({ ...item, reason });
              report(`kept ${item.path}: ${reason}`);
              continue;
            }
            db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
            removed.push(item);
            dropped++;
            report(`removed ${item.path}`);
          }
          db.exec("COMMIT");
        } catch (err) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw err;
        }
        if (dropped) db.exec("VACUUM");
      } finally {
        db.close();
      }
    }
    const { live, close } = openLive(home);
    try {
      for (const { item, copies } of found.files) {
        const reasons = proveFile(item.path, live, copies);
        if (reasons.length) {
          const reason = withAbsorbHint(summarize(reasons));
          kept.push({ ...item, reason });
          report(`kept ${item.path}: ${reason}`);
          continue;
        }
        for (const path of [...sidecars(item.path), item.path]) rmSync(path, { recursive: true, force: true });
        removed.push(item);
        report(`removed ${item.path}`);
      }
    } finally {
      close();
    }
    for (const group of bundledOriginals(home)) {
      for (const path of group.files) rmSync(path, { force: true });
      if (group.files.length) {
        removed.push({ kind: "directory", path: group.dir, bytes: group.bytes, reason: `${group.files.length} job copy originals that a verified bundle restores byte-exact` });
        report(`removed ${group.files.length} bundled originals from ${group.dir}`);
      }
      if (group.unlisted.length || group.failures.length) kept.push({ kind: "directory", path: group.dir, bytes: size(group.dir), reason: summarize([...group.failures, ...group.unlisted.map((name) => `${name} is in no verified bundle`)]) });
      else try {
        rmdirSync(group.dir);
      } catch {
      }
    }
    return plan([], removed, kept);
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
import { basename as basename2, join as join3 } from "node:path";
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
function absorbDatabase(path, live, archive, source, options) {
  let db;
  try {
    db = new DatabaseSync3(path, { readOnly: true, timeout: 1e3 });
  } catch (err) {
    source.problems.push(`${basename2(path)} cannot be opened (${err.message})`);
    return;
  }
  try {
    const sig = signature(path), origin = basename2(path);
    for (const table of provableTables(db)) {
      const c = tableClassifier(db, table, live);
      if (!c.total) continue;
      const all = db.prepare(`PRAGMA table_info(${q2(table)})`).all().map((r) => String(r.name));
      const progress = archive?.prepare("SELECT after_rowid, done FROM absorb_progress WHERE source=? AND table_name=?").get(sig, table);
      if (progress?.done) continue;
      let after = Number(progress?.after_rowid ?? -1), rowid = true;
      const conflictsBefore = source.conflicts;
      const page = (from, offset) => {
        if (rowid) {
          try {
            const s2 = db.prepare(`SELECT rowid AS "__absorb_rowid", * FROM ${q2(table)} WHERE rowid>? ORDER BY rowid LIMIT ?`);
            s2.setReadBigInts(true);
            return s2.all(from, options.batchRows);
          } catch {
            rowid = false;
          }
        }
        const s = db.prepare(`SELECT * FROM ${q2(table)} LIMIT ? OFFSET ?`);
        s.setReadBigInts(true);
        return s.all(options.batchRows, offset);
      };
      for (let offset = 0; ; ) {
        const rows = page(after, offset);
        if (!rows.length) break;
        offset += rows.length;
        if (rowid) after = Number(rows.at(-1).__absorb_rowid);
        if (archive) archive.exec("BEGIN IMMEDIATE");
        try {
          for (const row of rows) {
            const status = c.classify(row);
            if (status === "conflict") {
              source.conflicts++;
              continue;
            }
            if (status !== "missing") continue;
            source.rows++;
            if (!archive) continue;
            archive.prepare(`INSERT OR IGNORE INTO ${ABSORBED_ROWS}(source_table,digest,row,origin,absorbed_at) VALUES(?,?,?,?,?)`).run(c.logical, c.digest(row), encodeAbsorbedRow(row, all), origin, options.now);
            if (c.logical === "messages" || c.logical === "archived_messages") archiveMessage(archive, row, origin, options.now);
          }
          if (archive) {
            archive.prepare("INSERT INTO absorb_progress(source,table_name,after_rowid) VALUES(?,?,?) ON CONFLICT(source,table_name) DO UPDATE SET after_rowid=excluded.after_rowid").run(sig, table, rowid ? after : -1);
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
function absorbFile(path, root, copies, live, archive, source, now) {
  if (!proveFile(path, live, copies, root).length) return;
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
    const bridge = join3(home, DB_FILE_NAME), history = historyDbPath(bridge), archivePath = join3(home, ARCHIVE_DB_NAME);
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
    const live = [{ label: "bridge.db", db: open(bridge), exclude: new Set(LEGACY_BRIDGE_TABLES) }, { label: "history.db", db: open(history) }];
    const archiveLive = archive ?? (lstatOrNull(archivePath) ? open(archivePath) : void 0);
    if (archiveLive) live.splice(1, 0, { label: "archive.db", db: archiveLive });
    const settings = { ...options, batchRows: options.batchRows ?? BATCH_ROWS, now: options.now ?? Date.now() };
    for (const { item, copies } of fileCandidates(home)) {
      const source = { path: item.path, rows: 0, files: 0, conflicts: 0, problems: [] };
      options.report?.(`${options.apply ? "absorbing" : "checking"} ${item.path}\u2026`);
      for (const file of candidateFiles(item.path)) {
        if (lstatSync3(file).isSymbolicLink()) {
          source.problems.push(`${basename2(file)} is a symbolic link`);
          continue;
        }
        if (isSqlite(file)) absorbDatabase(file, live, archive, source, settings);
        else absorbFile(file, item.path, copies, live, archive, source, settings.now);
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
var USAGE = "Usage: agent-bridge storage finalize [--yes] [--json] | storage absorb [--yes] [--json] | storage rollback-history\nfinalize lists the old-format data that the verified new storage replaces; with --yes it removes exactly that list and compacts bridge.db.\nabsorb lists rows and files that exist only in old backups and snapshots; with --yes it imports them losslessly into archive.db.";
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
    const json = args.has("--json");
    let result;
    try {
      result = runAbsorb(home, { apply: args.has("--yes"), report: (line) => {
        if (!json) out(line);
      } });
    } catch (err) {
      out(String(err.message));
      return 1;
    }
    if (json) {
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
  if (rest[0] !== "finalize" || [...args].some((a) => a !== "--yes" && a !== "--json")) {
    out(USAGE);
    return 2;
  }
  const plan2 = args.has("--yes") ? runFinalize(home, (line) => {
    if (!args.has("--json")) out(line);
  }) : planFinalize(home);
  if (args.has("--json")) {
    out(JSON.stringify({ ...plan2, removed: args.has("--yes") && plan2.ready }, null, 2));
    return plan2.ready ? 0 : 1;
  }
  if (!plan2.ready) {
    out("Not ready; nothing was removed:");
    for (const blocker of plan2.blockers) out(`  - ${blocker}`);
    return 1;
  }
  const kept = () => {
    if (!plan2.kept.length) return;
    out("Kept, because they are not proven redundant row by row:");
    for (const item of plan2.kept) out(`  ${gib(item.bytes).padStart(10)}  ${item.path}  (${item.reason})`);
  };
  if (!args.has("--yes")) {
    for (const item of plan2.items) out(`  ${gib(item.bytes).padStart(10)}  ${item.path}  (${item.reason})`);
    kept();
    out(`${plan2.items.length} items, ${gib(plan2.bytes)}. Run again with --yes to remove them.`);
    return 0;
  }
  kept();
  out(`Removed ${plan2.items.length} items, ${gib(plan2.bytes)}.`);
  return 0;
}
export {
  runStorage
};
