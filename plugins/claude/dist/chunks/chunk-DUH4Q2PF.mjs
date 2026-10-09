import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RUNS_DIR_NAME,
  finishedRunLine,
  readRunLogPreview
} from "./chunk-FV6KQELE.mjs";
import {
  safeFile
} from "./chunk-TFQZM67X.mjs";
import {
  JSON_STORE_VERSION,
  archiveFile,
  assertWritableStore,
  cloneJson,
  existingMetadataDb,
  fileSignature,
  indexedJobProjectionCurrent,
  isRecord,
  legacyStorePeers,
  mergeStoreFields,
  metadataDb,
  physicalMetadataPath,
  readIndexedJobs,
  readJsonSnapshot,
  readJsonStore,
  refreshStorePeerIdentities,
  retainMetadataFiles,
  storageLease,
  writeJsonStore
} from "./chunk-NWPQJULH.mjs";
import {
  DB_FILE_NAME,
  JOBS_FILE
} from "./chunk-7EOIPV3B.mjs";

// src/core/finished-run-bundles.ts
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
var RUN_LOG = /\.log(?:-\d+-[\w-]+)?$/;
var REVISION = ["finished-runs-revision", "revision"];
var FAILURES = "finished-run-pack-failures";
var runName = (log) => basename(log).replace(RUN_LOG, "");
function bumpRevision(db) {
  db.prepare(`INSERT INTO bridge_metadata VALUES (?,?,'1',?) ON CONFLICT(domain,key)
  DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT),updated_at=excluded.updated_at`).run(REVISION[0], REVISION[1], Date.now());
}
function upsertRun(db, key, value) {
  generation++;
  db.prepare("INSERT INTO bridge_metadata VALUES ('finished-runs',?,?,?) ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(key, JSON.stringify(value), Date.now());
  bumpRevision(db);
}
function packFinishedRuns(home, logs) {
  let packed = 0;
  for (const log of logs) {
    physicalMetadataPath(log);
    if (!finishedRunLine(readRunLogPreview(log))) continue;
    const stat = lstatSync(log), metaPath = log.replace(RUN_LOG, ".json"), files = [];
    let meta = {};
    if (existsSync(metaPath)) {
      physicalMetadataPath(metaPath);
      try {
        meta = JSON.parse(readFileSync(metaPath, "utf8"));
      } catch {
      }
      files.push(metaPath);
    }
    files.push(log);
    const source = relative(home, log).replace(/\\/g, "/"), key = runName(log);
    const value = { name: key, updatedAt: stat.mtimeMs, size: stat.size, signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`, archived: true, meta };
    retainMetadataFiles(home, files, (db2, path, _raw, cold) => {
      if (path === source) upsertRun(db2, key, { ...value, file: cold, bundleSource: source });
    });
    const db = metadataDb(home);
    if (!db.prepare("SELECT 1 FROM bridge_metadata WHERE domain='finished-runs' AND key=?").get(key)) {
      const imported2 = db.prepare("SELECT cold_path FROM bridge_imports WHERE path=?").get(source);
      if (!imported2) throw new Error("Completed run lacks verified retention evidence");
      db.exec("BEGIN IMMEDIATE");
      try {
        upsertRun(db, key, { ...value, file: String(imported2.cold_path), bundleSource: source });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    packed++;
  }
  return packed;
}
var cache = /* @__PURE__ */ new Map();
var generation = 0;
var RECHECK_MS = 2e3;
function toRecord(key, value) {
  try {
    const v = JSON.parse(value);
    return { name: key, file: String(v.file), updatedAt: Number(v.updatedAt), size: Number(v.size), signature: String(v.signature), archived: true, meta: v.meta && typeof v.meta === "object" ? v.meta : {} };
  } catch {
    return null;
  }
}
var copy = (record) => ({ ...record, meta: structuredClone(record.meta) });
function fileIdentity(file) {
  return [file, `${file}-wal`].map((path) => {
    try {
      const s = statSync(path);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return "-";
    }
  }).join("/");
}
function packedRunRecords(home, names) {
  const file = join(home, DB_FILE_NAME), saved = cache.get(file);
  const pick = (records) => names ? [...names].flatMap((name) => {
    const r = records.get(name);
    return r ? [copy(r)] : [];
  }) : [...records.values()].map(copy);
  if (!existsSync(file)) return [];
  const files = fileIdentity(file);
  if (saved && saved.generation === generation && (saved.files === files || Date.now() - saved.checkedAt < RECHECK_MS)) return pick(saved.records);
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 1e3 });
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_metadata'").get()) return [];
    const revision = db.prepare("SELECT value FROM bridge_metadata WHERE domain=? AND key=?").get(REVISION[0], REVISION[1]);
    const signature = revision ? `r:${String(revision.value)}` : (() => {
      const row2 = db.prepare("SELECT count(*) n,coalesce(max(updated_at),0) m FROM bridge_metadata WHERE domain='finished-runs'").get();
      return `c:${row2.n}:${row2.m}`;
    })();
    if (saved?.signature === signature) {
      Object.assign(saved, { files, checkedAt: Date.now(), generation });
      return pick(saved.records);
    }
    if (names && names.size <= 64) {
      const keys = [...names];
      const rows2 = db.prepare(`SELECT key,value FROM bridge_metadata WHERE domain='finished-runs' AND key IN (${keys.map(() => "?").join(",")})`).all(...keys);
      return rows2.flatMap((row2) => {
        const r = toRecord(String(row2.key), String(row2.value));
        return r ? [r] : [];
      });
    }
    const records = /* @__PURE__ */ new Map();
    for (const row2 of db.prepare("SELECT key,value FROM bridge_metadata WHERE domain='finished-runs'").iterate()) {
      const record = toRecord(String(row2.key), String(row2.value));
      if (record) records.set(record.name, record);
    }
    cache.delete(file);
    cache.set(file, { signature, files, checkedAt: Date.now(), generation, records });
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    return pick(records);
  } catch (error) {
    if (saved) return pick(saved.records);
    throw error;
  } finally {
    db?.close();
  }
}
function archivedLogs(home) {
  const dir = join(home, "runs", "archive");
  return existsSync(dir) ? readdirSync(dir).filter((name) => RUN_LOG.test(name)).map((name) => join(dir, name)) : [];
}
function recoverPackedRuns(home, limit = 100) {
  if (!existsSync(join(home, DB_FILE_NAME))) return 0;
  const db = metadataDb(home);
  let recovered = 0;
  for (const row2 of db.prepare("SELECT path,cold_path FROM bridge_imports WHERE path LIKE 'runs/%'").all()) {
    const source = String(row2.path);
    if (!RUN_LOG.test(source)) continue;
    const key = runName(source), cold = String(row2.cold_path);
    if (db.prepare("SELECT 1 FROM bridge_metadata WHERE domain='finished-runs' AND key=?").get(key)) continue;
    if (!existsSync(cold) || existsSync(join(home, source))) continue;
    physicalMetadataPath(cold);
    const stat = lstatSync(cold), metaCold = cold.replace(RUN_LOG, ".json");
    let meta = {};
    if (existsSync(metaCold)) {
      try {
        meta = JSON.parse(readFileSync(metaCold, "utf8"));
      } catch {
      }
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      upsertRun(db, key, { name: key, file: cold, bundleSource: source, updatedAt: stat.mtimeMs, size: stat.size, signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`, archived: true, meta, recovered: true });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (++recovered >= limit) break;
  }
  return recovered;
}
function packArchivedRuns(home, logs, batch = 100, onFailure) {
  const candidates = logs ?? archivedLogs(home);
  if (!candidates.length && !existsSync(join(home, DB_FILE_NAME))) return 0;
  recoverPackedRuns(home);
  if (!candidates.length) return 0;
  const db = metadataDb(home);
  const failed = new Map(db.prepare("SELECT key,value FROM bridge_metadata WHERE domain=?").all(FAILURES).map((row2) => [String(row2.key), String(row2.value)]));
  let packed = 0, attempted = 0;
  for (const log of candidates) {
    if (attempted >= batch) break;
    const source = relative(home, log).replace(/\\/g, "/");
    let signature;
    try {
      const stat = lstatSync(log);
      signature = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      continue;
    }
    const prior = failed.get(source);
    if (prior) {
      try {
        if (JSON.parse(prior).signature === signature) continue;
      } catch {
      }
    }
    try {
      if (!finishedRunLine(readRunLogPreview(log))) continue;
    } catch {
      continue;
    }
    attempted++;
    try {
      packed += packFinishedRuns(home, [log]);
      if (prior) db.prepare("DELETE FROM bridge_metadata WHERE domain=? AND key=?").run(FAILURES, source);
    } catch (error) {
      if (error.code === "STORE_UPGRADE_DEFERRED") throw error;
      const failure = { source, error: String(error.message ?? error) };
      db.prepare("INSERT INTO bridge_metadata VALUES (?,?,?,?) ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(FAILURES, source, JSON.stringify({ ...failure, signature, at: Date.now() }), Date.now());
      onFailure?.(failure);
    }
  }
  return packed;
}

// src/core/run-history.ts
import { readFile } from "node:fs/promises";
import { lstatSync as lstatSync2, readdirSync as readdirSync2, realpathSync, statSync as statSync2 } from "node:fs";
import { dirname, isAbsolute, join as join2, relative as relative2, sep } from "node:path";

// src/core/responsive-scan.ts
function drainScan(scan) {
  for (; ; ) {
    const step = scan.next();
    if (step.done) return step.value;
  }
}
async function drainScanResponsive(scan) {
  try {
    for (; ; ) {
      const started = performance.now();
      for (let steps = 0; steps < 32 && performance.now() - started < 4; steps++) {
        const step = scan.next();
        if (step.done) return step.value;
      }
      await new Promise((resolve2) => setImmediate(resolve2));
    }
  } finally {
    scan.return(void 0);
  }
}

// src/core/run-history.ts
var DEFAULT_RUN_PAGE_SIZE = 50;
var MAX_RUN_PAGE_SIZE = 500;
var RUN_LOG_NAME = /^[\w.-]+\.log$/;
var ARCHIVE_SUFFIX = /(\.(?:log|json))-\d+-[\w-]+$/;
function readHistoryJson(file) {
  try {
    return cloneJson(readJsonSnapshot(file).value);
  } catch {
    return null;
  }
}
var runLogSnapshots = /* @__PURE__ */ new Map();
function readRunLogs(home, namesFilter) {
  return drainScan(readRunLogsSteps(home, namesFilter));
}
function readRunLogsResponsive(home, namesFilter) {
  return drainScanResponsive(readRunLogsSteps(home, namesFilter, true));
}
function* readRunLogsSteps(home, namesFilter, responsive = false) {
  const root = join2(home, RUNS_DIR_NAME);
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync.native(root);
  } catch {
    return [];
  }
  const warmWitness = responsive ? captureWarmRunRoot(root, canonicalRoot) : void 0;
  const records = /* @__PURE__ */ new Map();
  const signatures = [];
  let complete = !responsive || Boolean(warmWitness), metadataBytes = 0;
  const directories = [];
  for (const archived of [true, false]) {
    const dir = archived ? join2(root, "archive") : root;
    let canonicalDir;
    try {
      canonicalDir = realpathSync.native(dir);
    } catch {
      continue;
    }
    const rel = relative2(canonicalRoot, canonicalDir);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    let entries;
    try {
      entries = readdirSync2(canonicalDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const localFile = (entry) => {
      const file = join2(canonicalDir, entry.name);
      try {
        const direct = lstatSync2(file);
        return direct.isFile() ? { file, st: direct } : direct.isSymbolicLink() ? (() => {
          const actual = safeFile(root, file, canonicalRoot);
          return actual ? { file: actual, st: statSync2(actual) } : null;
        })() : null;
      } catch {
        return null;
      }
    };
    const selected = [];
    for (const entry of entries) {
      yield;
      const name = entry.name;
      const original = archived ? name.replace(ARCHIVE_SUFFIX, "$1") : name;
      const extension = original.endsWith(".json") ? ".json" : RUN_LOG_NAME.test(original) ? ".log" : null;
      if (!extension || namesFilter && !namesFilter.has(original.slice(0, -extension.length))) continue;
      const record = localFile(entry);
      if (!record) continue;
      if (warmWitness && !captureWarmRunParents(warmWitness, dirname(record.file))) complete = false;
      signatures.push(`${archived}:${name}:${record.file}:${fileSignature(record.st)}`);
      if (extension === ".json") metadataBytes += record.st.size;
      selected.push({ name, original, ...record });
    }
    directories.push({ archived, files: selected });
  }
  const packed = packedRunRecords(home, namesFilter);
  signatures.push(`packed:${packed.length}:${packed.reduce((n, r) => Math.max(n, r.updatedAt), 0)}`);
  const key = `${canonicalRoot}:${namesFilter ? JSON.stringify([...namesFilter].sort()) : "*"}`;
  const signature = signatures.join("\n"), saved = runLogSnapshots.get(key);
  if (saved?.signature === signature) {
    if (!responsive || warmWitness && (yield* stableWarmRunFiles(warmWitness, directories))) return yield* cloneRunRecords(saved.records);
    runLogSnapshots.delete(key);
    return [];
  }
  for (const { archived, files } of directories) {
    const metadata = /* @__PURE__ */ new Map();
    for (const { original, file, st } of files) {
      yield;
      if (!original.endsWith(".json")) continue;
      try {
        if (responsive && !unchangedContainedFile(root, file, st, canonicalRoot)) {
          complete = false;
          continue;
        }
        const value = readJsonSnapshot(file, { file, stat: st }).value;
        if (isRecord(value)) metadata.set(original, value);
      } catch {
        complete = false;
      }
    }
    for (const { original, file, st } of files) {
      yield;
      if (!RUN_LOG_NAME.test(original)) continue;
      try {
        if (!st.isFile()) continue;
        const key2 = original.slice(0, -".log".length);
        const record = { name: key2, file, updatedAt: st.mtimeMs, size: st.size, signature: fileSignature(st), archived, meta: metadata.get(`${key2}.json`) ?? {} };
        const previous = records.get(key2);
        if (!previous || !archived || record.updatedAt >= previous.updatedAt) records.set(key2, record);
      } catch {
      }
    }
  }
  for (const record of packed) if (!records.has(record.name)) records.set(record.name, record);
  const result = [...records.values()];
  if (responsive) complete &&= yield* stableRunFiles(root, directories, canonicalRoot);
  runLogSnapshots.delete(key);
  if (complete && metadataBytes <= 256 * 1024 * 1024) runLogSnapshots.set(key, { signature, records: result });
  if (runLogSnapshots.size > 8) runLogSnapshots.delete(runLogSnapshots.keys().next().value);
  return yield* cloneRunRecords(result);
}
function sameDirectory(st, identity) {
  return st.dev === identity.dev && st.ino === identity.ino;
}
function captureWarmRunRoot(root, canonicalRoot) {
  try {
    const alias = lstatSync2(root), physical = lstatSync2(canonicalRoot);
    if (!alias.isDirectory() && !alias.isSymbolicLink() || !physical.isDirectory() || physical.isSymbolicLink() || realpathSync.native(root) !== canonicalRoot) return void 0;
    return { root, canonicalRoot, alias: { dev: alias.dev, ino: alias.ino }, parents: /* @__PURE__ */ new Map([[canonicalRoot, { dev: physical.dev, ino: physical.ino }]]), valid: true };
  } catch {
    return void 0;
  }
}
function captureWarmRunParents(witness, parent) {
  if (!witness.valid) return false;
  const rel = relative2(witness.canonicalRoot, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return witness.valid = false;
  try {
    for (let at = parent; !witness.parents.has(at); at = dirname(at)) {
      const st = lstatSync2(at);
      if (!st.isDirectory() || st.isSymbolicLink()) return witness.valid = false;
      witness.parents.set(at, { dev: st.dev, ino: st.ino });
    }
    return true;
  } catch {
    return witness.valid = false;
  }
}
function warmRunBatchParents(witness, files) {
  const parents = /* @__PURE__ */ new Set([witness.canonicalRoot]);
  for (const file of files) for (let at = dirname(file.file); ; at = dirname(at)) {
    if (!witness.parents.has(at)) return void 0;
    parents.add(at);
    if (at === witness.canonicalRoot) break;
    if (dirname(at) === at) return void 0;
  }
  return parents;
}
function unchangedWarmRunParents(witness, parents = [witness.canonicalRoot]) {
  if (!witness.valid) return false;
  try {
    const alias = lstatSync2(witness.root);
    if (!sameDirectory(alias, witness.alias) || realpathSync.native(witness.root) !== witness.canonicalRoot) return false;
    for (const path of parents) {
      const identity = witness.parents.get(path);
      if (!identity) return false;
      const st = path === witness.root ? alias : lstatSync2(path);
      if (!st.isDirectory() || st.isSymbolicLink() || !sameDirectory(st, identity)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
function* stableWarmRunFiles(witness, directories) {
  for (const directory of directories) {
    let index = 0;
    while (index < directory.files.length) {
      yield;
      const candidates = directory.files.slice(index, index + 32), parents = warmRunBatchParents(witness, candidates);
      if (!parents || !unchangedWarmRunParents(witness, parents)) return false;
      const started = performance.now();
      let checked = 0;
      do {
        const file = directory.files[index++];
        try {
          const direct = lstatSync2(file.file);
          if (!direct.isFile() || fileSignature(direct) !== fileSignature(file.st)) return false;
        } catch {
          return false;
        }
        checked++;
      } while (index < directory.files.length && checked < 32 && performance.now() - started < 4);
      if (!unchangedWarmRunParents(witness, parents)) return false;
    }
  }
  return unchangedWarmRunParents(witness);
}
function* stableRunFiles(root, directories, canonicalRoot) {
  for (const directory of directories) for (const file of directory.files) {
    yield;
    if (!unchangedContainedFile(root, file.file, file.st, canonicalRoot)) return false;
  }
  return true;
}
function* cloneRunRecords(records) {
  const result = [];
  for (const record of records) {
    yield;
    result.push(cloneJson(record));
  }
  return result;
}
function unchangedContainedFile(root, file, before, canonicalRoot) {
  try {
    const direct = lstatSync2(file);
    return direct.isFile() && fileSignature(direct) === fileSignature(before) && safeFile(root, file, canonicalRoot) === file;
  } catch {
    return false;
  }
}
async function readRunStarts(home) {
  const root = join2(home, RUNS_DIR_NAME);
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync.native(root);
  } catch {
    return [];
  }
  const starts = /* @__PURE__ */ new Map();
  for (const archived of [true, false]) {
    let dir;
    try {
      dir = realpathSync.native(archived ? join2(root, "archive") : root);
    } catch {
      continue;
    }
    const rel = relative2(canonicalRoot, dir);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    let entries;
    try {
      entries = readdirSync2(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const paths = /* @__PURE__ */ new Map();
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const original = archived ? entry.name.replace(ARCHIVE_SUFFIX, "$1") : entry.name;
      const file = join2(dir, entry.name);
      const contained = entry.isFile() ? file : entry.isSymbolicLink() ? safeFile(root, file, canonicalRoot) : null;
      if (contained) {
        const previous = paths.get(original);
        if (previous && original.endsWith(".log")) {
          try {
            if (statSync2(previous).mtimeMs > statSync2(contained).mtimeMs) continue;
          } catch {
            continue;
          }
        }
        paths.set(original, contained);
      }
    }
    const metadata = [];
    for (const [name, log] of paths) {
      if (!RUN_LOG_NAME.test(name)) continue;
      const runName2 = name.slice(0, -4), file = paths.get(`${runName2}.json`);
      if (!archived) starts.delete(runName2);
      if (file) metadata.push({ name, runName: runName2, file, log });
    }
    for (let offset = 0; offset < metadata.length; offset += 32) {
      await Promise.all(metadata.slice(offset, offset + 32).map(async ({ name, runName: runName2, file, log }) => {
        try {
          const direct = lstatSync2(file);
          const readable = direct.isFile() ? file : direct.isSymbolicLink() ? safeFile(root, file, canonicalRoot) : null;
          if (!readable) return;
          const before = direct.isFile() ? direct : statSync2(readable);
          if (!before.isFile()) return;
          const raw = await readFile(readable, "utf8");
          const after = lstatSync2(readable);
          if (!after.isFile() || fileSignature(after) !== fileSignature(before)) return;
          const meta = JSON.parse(raw);
          if (!isRecord(meta) || typeof meta.job !== "string") return;
          const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(name);
          const startedAt = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : statSync2(log).mtimeMs;
          starts.set(runName2, { job: meta.job, startedAt, ...typeof meta.jobStartedAt === "number" ? { jobStartedAt: meta.jobStartedAt } : {} });
        } catch {
        }
      }));
    }
  }
  for (const record of packedRunRecords(home)) {
    if (starts.has(record.name) || typeof record.meta.job !== "string") continue;
    const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(record.name);
    starts.set(record.name, { job: record.meta.job, startedAt: m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : record.updatedAt, ...typeof record.meta.jobStartedAt === "number" ? { jobStartedAt: record.meta.jobStartedAt } : {} });
  }
  return [...starts.values()];
}
function selectHistoryJobs(home, names) {
  const snapshot = drainScan(historyJobsSteps(home, false, { names })), selected = /* @__PURE__ */ new Map();
  for (const name of names) {
    const job = snapshot.get(name);
    if (job) selected.set(name, cloneJson(job));
  }
  return selected;
}
async function selectHistoryJobsResponsive(home, names) {
  return drainScanResponsive((function* () {
    const snapshot = yield* historyJobsSteps(home, true, { names }), selected = /* @__PURE__ */ new Map();
    for (const name of names) {
      yield;
      const job = snapshot.get(name);
      if (job) selected.set(name, cloneJson(job));
    }
    return selected;
  })());
}
function findHistoryJob(home, ref, id) {
  for (const job of drainScan(historyJobsSteps(home, false, { ids: /* @__PURE__ */ new Set([id]), names: /* @__PURE__ */ new Set([ref]) })).values()) {
    if (job.name === ref || job.id === id) return cloneJson(job);
  }
  return void 0;
}
function* historyJobsSteps(home, responsive = false, selection = {}) {
  const out = /* @__PURE__ */ new Map(), path = join2(home, JOBS_FILE);
  if (responsive) yield;
  let canonicalHome;
  try {
    canonicalHome = realpathSync.native(home);
  } catch {
    return out;
  }
  const indexed = join2(canonicalHome, JOBS_FILE);
  for (const job of readIndexedJobs(indexed, { ...selection, history: true }).jobs) {
    if (typeof job.name === "string" && RUN_LOG_NAME.test(job.name + ".log")) out.set(job.name, job);
  }
  if (indexedJobProjectionCurrent(indexed)) return out;
  const active = safeFile(home, path, canonicalHome);
  if (!active) return out;
  const st = statSync2(active);
  if (responsive) yield;
  if (!unchangedContainedFile(home, active, st, canonicalHome)) return out;
  let value;
  try {
    value = readJsonSnapshot(active, { file: active, stat: st }).value;
  } catch {
    return out;
  }
  const jobs = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.jobs) ? value.jobs : [];
  for (const job of jobs) {
    if (responsive) yield;
    if (!isRecord(job) || typeof job.name !== "string" || !RUN_LOG_NAME.test(job.name + ".log")) continue;
    if (selection.names || selection.ids) {
      if (!selection.names?.has(job.name) && !selection.ids?.has(String(job.id))) continue;
    }
    out.set(job.name, job);
  }
  if (responsive && !unchangedContainedFile(home, active, st, canonicalHome)) return /* @__PURE__ */ new Map();
  return out;
}
function pageRuns(runs, before, limit) {
  let at, name;
  if (before !== null) {
    const match = /^(\d+)(?::([\w.-]+))?$/.exec(before);
    if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error("invalid run cursor");
    at = Number(match[1]);
    name = match[2];
  }
  const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const older = sorted.filter((run) => at === void 0 || run.startedAt < at || name !== void 0 && run.startedAt === at && run.name < name);
  const page = older.slice(0, limit), last = page.at(-1);
  const running = before === null ? older.slice(limit).filter((run) => run.status === "running") : [];
  return { runs: [...page, ...running], next: older.length > page.length && last ? `${last.startedAt}:${last.name}` : null, total: runs.length };
}

// src/core/runner-store.ts
import { randomUUID, createHash } from "node:crypto";
import { existsSync as existsSync2, lstatSync as lstatSync3, mkdirSync, readFileSync as readFileSync2, readdirSync as readdirSync3, renameSync } from "node:fs";
import { basename as basename2, dirname as dirname2, join as join3, resolve } from "node:path";
import { setTimeout as yieldWriters } from "node:timers/promises";
var RUNNER_DIR = "jobs";
var STATE = "job-state";
var STATE_ARCHIVE = "job-state-archive";
var SPEC = "job-spec";
var SPEC_ARCHIVE = "job-spec-archive";
var MARKER_DOMAIN = "runner-store";
var MARKER_KEY = "import";
var LEGACY_CACHE_MS = 5e3;
var IMPORT_BATCH = 200;
var runnerStoreStats = { fileReads: 0, rowReads: 0, rowWrites: 0, projections: 0, merges: 0 };
var legacyCache = /* @__PURE__ */ new Map();
function runnerStatePath(home, id) {
  return join3(home, RUNNER_DIR, `${id}.json`);
}
function runnerSpecPath(home, id) {
  return join3(home, RUNNER_DIR, `${id}.spec.json`);
}
var validId = (id) => /^[\w.-]+$/.test(id) && !id.startsWith(".");
function rows(home) {
  try {
    return existingMetadataDb(home) ?? metadataDb(home);
  } catch (error) {
    if (error.code === "STORE_UPGRADE_DEFERRED") return void 0;
    throw error;
  }
}
function row(db, domain, key) {
  runnerStoreStats.rowReads++;
  const found = db.prepare("SELECT value FROM bridge_metadata WHERE domain=? AND key=?").get(domain, key);
  if (!found) return null;
  try {
    const value = JSON.parse(String(found.value));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}
function put(db, domain, key, value) {
  runnerStoreStats.rowWrites++;
  db.prepare(`INSERT INTO bridge_metadata VALUES (?,?,?,?)
   ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(domain, key, JSON.stringify(value), Date.now());
}
function archive(db, domain, id, value) {
  db.prepare("INSERT INTO bridge_metadata VALUES (?,?,?,?) ON CONFLICT(domain,key) DO NOTHING").run(domain, `${id}/${Date.now()}-${randomUUID()}`, JSON.stringify(value), Date.now());
}
function transaction(home, db, work) {
  const release = storageLease(home);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    release();
  }
}
function imported(db) {
  return row(db, MARKER_DOMAIN, MARKER_KEY)?.complete === true;
}
function legacyRunnerPeers(home) {
  const key = resolve(home), cached = legacyCache.get(key);
  if (cached && Date.now() - cached.at < LEGACY_CACHE_MS) return cached.value;
  let value;
  try {
    value = legacyStorePeers(home).length > 0;
  } catch {
    value = true;
  }
  legacyCache.set(key, { at: Date.now(), value });
  if (value) {
    try {
      const db = existingMetadataDb(home);
      if (db && imported(db)) transaction(home, db, () => put(db, MARKER_DOMAIN, MARKER_KEY, { complete: false, reopenedAt: Date.now() }));
    } catch {
    }
  }
  return value;
}
function fileMode(home, db) {
  return legacyRunnerPeers(home) || !imported(db);
}
function readStateFileRaw(home, id, preserve = true) {
  runnerStoreStats.fileReads++;
  const path = runnerStatePath(home, id);
  try {
    if (lstatSync3(path).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  if (!preserve) return readHistoryJson(path);
  return readJsonStore(path, void 0, (v) => isRecord(v) && typeof v.pid === "number" && typeof v.status === "string");
}
function readStateFile(home, id, preserve = true) {
  const value = readStateFileRaw(home, id, preserve);
  return isRecord(value) && typeof value.pid === "number" && typeof value.status === "string" && !(Number(value.version) > JSON_STORE_VERSION) ? value : null;
}
function readLegacyFile(path) {
  try {
    if (lstatSync3(path).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return readHistoryJson(path);
}
var stamp = (value) => typeof value?.updatedAt === "number" ? value.updatedAt : typeof value?.turnResetAt === "number" ? value.turnResetAt : -Infinity;
var hasState = (value) => Boolean(value && typeof value.pid === "number" && typeof value.status === "string");
var stateBase = (value) => hasState(value) ? value : {};
var fileWins = (stored, file) => Boolean(file && (!stored || stamp(file) > stamp(stored)));
function adoptFileState(db, id, stored, file) {
  runnerStoreStats.merges++;
  if (hasState(stored) && stored.pid !== file.pid) archive(db, STATE_ARCHIVE, id, stored);
  put(db, STATE, id, file);
  return file;
}
function currentState(home, db, id, write) {
  const stored = row(db, STATE, id);
  if (!fileMode(home, db)) return stored;
  const file = readStateFile(home, id);
  if (!fileWins(stored, file)) return stored;
  return write ? adoptFileState(db, id, stored, file) : file;
}
function readRunnerStateRecord(home, id, opts = {}) {
  if (!validId(id)) return null;
  const db = rows(home);
  if (!db) return readStateFile(home, id, opts.preserveCorrupt ?? false);
  const stored = row(db, STATE, id);
  if (!fileMode(home, db)) return hasState(stored) ? stored : null;
  const file = readStateFile(home, id, opts.preserveCorrupt ?? false);
  if (!fileWins(stored, file)) return hasState(stored) ? stored : null;
  let merged;
  try {
    merged = transaction(home, db, () => currentState(home, db, id, true));
  } catch {
    merged = file;
  }
  return hasState(merged) ? merged : null;
}
function writeRunnerStateRecord(home, id, state) {
  if (!validId(id)) throw new Error(`Invalid job id: ${id}`);
  const path = runnerStatePath(home, id);
  const db = rows(home);
  if (!db) {
    const previous = readJsonStore(path);
    writeJsonStore(path, mergeStoreFields(isRecord(previous) ? previous : {}, { ...state }), previous);
    return;
  }
  const legacy = legacyRunnerPeers(home);
  if (!legacy && fileMode(home, db)) assertWritableStore(readStateFileRaw(home, id));
  let next = {};
  if (legacy) {
    const previous = readJsonStore(path);
    const file = isRecord(previous) ? previous : null, stored = row(db, STATE, id);
    next = mergeStoreFields(stateBase(stamp(stored) > stamp(file) ? stored : file), { ...state, version: JSON_STORE_VERSION });
    writeJsonStore(path, next, previous);
    runnerStoreStats.projections++;
  }
  transaction(home, db, () => {
    const previous = currentState(home, db, id, true);
    assertWritableStore(previous);
    put(db, STATE, id, mergeStoreFields(stateBase(previous), legacy ? next : { ...state, version: JSON_STORE_VERSION }));
  });
}
function readPendingRunnerSpec(home, id) {
  if (!validId(id)) return null;
  const db = rows(home);
  if (db) {
    const spec = row(db, SPEC, id);
    if (spec && spec.consumedAt === void 0) return spec;
    if (!fileMode(home, db)) return null;
  }
  runnerStoreStats.fileReads++;
  const value = readLegacyFile(runnerSpecPath(home, id));
  return isRecord(value) ? value : null;
}
function publishRunnerSpec(home, id, spec) {
  if (!validId(id)) throw new Error(`Invalid job id: ${id}`);
  const statePath = runnerStatePath(home, id), specPath = runnerSpecPath(home, id);
  const db = rows(home);
  if (!db || fileMode(home, db)) {
    archiveFile(statePath);
    archiveFile(specPath);
  }
  if (!db) {
    writeJsonStore(specPath, { ...spec }, null);
    return specPath;
  }
  transaction(home, db, () => {
    const state = row(db, STATE, id), previous = row(db, SPEC, id);
    if (hasState(state)) archive(db, STATE_ARCHIVE, id, state);
    put(db, STATE, id, { version: JSON_STORE_VERSION, turnResetAt: Date.now() });
    if (previous) archive(db, SPEC_ARCHIVE, id, previous);
    put(db, SPEC, id, { ...spec, version: JSON_STORE_VERSION });
  });
  if (legacyRunnerPeers(home)) {
    writeJsonStore(specPath, { ...spec }, null);
    runnerStoreStats.projections++;
  }
  return specPath;
}
function takeRunnerSpec(specFile) {
  const name = basename2(specFile), dir = dirname2(specFile);
  const match = /^(.+)\.spec\.json$/.exec(name);
  if (match && basename2(dir) === RUNNER_DIR && validId(match[1])) {
    const home = dirname2(dir), id = match[1];
    const db = rows(home);
    if (db) {
      const taken = transaction(home, db, () => {
        const spec = row(db, SPEC, id);
        if (!spec || spec.consumedAt !== void 0) return null;
        assertWritableStore(spec);
        put(db, SPEC, id, { ...spec, consumedAt: Date.now(), consumedBy: process.pid });
        return spec;
      });
      if (taken) {
        archiveFile(specFile);
        const { consumedAt: _consumed, consumedBy: _by, ...spec } = taken;
        return spec;
      }
    }
  }
  const data = readJsonStore(specFile);
  assertWritableStore(data);
  if (!isRecord(data)) return null;
  archiveFile(specFile);
  return data;
}
function legacyFiles(home) {
  const root = join3(home, RUNNER_DIR), files = [];
  for (const dir of [root, join3(root, "archive"), join3(root, ".import")]) {
    if (!existsSync2(dir)) continue;
    physicalMetadataPath(dir);
    for (const name of readdirSync3(dir)) {
      const path = join3(dir, name);
      physicalMetadataPath(path);
      if (name.endsWith(".tmp") || !lstatSync3(path).isFile()) continue;
      files.push(path);
    }
  }
  return files;
}
function staged(home, db, file, raw) {
  const rel = file.slice(resolve(home).length + 1).replace(/\\/g, "/");
  const prior = db.prepare("SELECT sha256,cold_path FROM bridge_imports WHERE path=?").get(rel);
  if (!prior) return file;
  if (prior.sha256 === createHash("sha256").update(raw()).digest("hex") && !existsSync2(String(prior.cold_path))) return file;
  const dir = join3(home, RUNNER_DIR, ".import");
  physicalMetadataPath(dir);
  mkdirSync(dir, { recursive: true, mode: 448 });
  const target = join3(dir, `${basename2(file)}~${Date.now()}-${randomUUID()}`);
  renameSync(file, target);
  return target;
}
function projectFile(store, path, raw) {
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  if (!isRecord(value)) return;
  const parts = path.split("/"), name = parts.at(-1);
  const live = /^(.+?)(\.spec)?\.json(?:~\d+-[\w-]+)?$/.exec(name);
  const old = /^(.+?)(\.spec)?\.json-\d+-[\w-]+$/.exec(name);
  if (parts[1] !== "archive" && live && validId(live[1])) {
    const id = live[1];
    if (live[2]) {
      const current2 = row(store, SPEC, id);
      if (!current2) put(store, SPEC, id, value);
      else if (JSON.stringify(current2) !== JSON.stringify(value)) archive(store, SPEC_ARCHIVE, id, value);
      return;
    }
    const current = row(store, STATE, id);
    if (hasState(value) && stamp(value) > stamp(current)) adoptFileState(store, id, current, value);
    else if (JSON.stringify(current) !== JSON.stringify(value)) archive(store, STATE_ARCHIVE, id, value);
    return;
  }
  if (parts[1] === "archive" && old && validId(old[1])) archive(store, old[2] ? SPEC_ARCHIVE : STATE_ARCHIVE, old[1], value);
}
async function importRunnerFiles(home, opts = {}) {
  const result = { imported: 0, deferred: false, remaining: 0, bundles: [] };
  await refreshStorePeerIdentities(home, opts.signal).catch(() => {
  });
  legacyCache.delete(resolve(home));
  let files = legacyFiles(home);
  if (!files.length && !existingMetadataDb(home)) return result;
  const db = rows(home);
  if (!db || legacyRunnerPeers(home)) {
    result.deferred = true;
    result.remaining = files.length;
    return result;
  }
  let batches = 0;
  for (let offset = 0; offset < files.length; offset += opts.batch ?? IMPORT_BATCH) {
    opts.signal?.throwIfAborted();
    const batch = files.slice(offset, offset + (opts.batch ?? IMPORT_BATCH)).map((file) => staged(home, db, file, () => readFileSync2(file)));
    try {
      result.bundles.push(...retainMetadataFiles(home, batch, projectFile));
    } catch (error) {
      if (error.code === "STORE_UPGRADE_DEFERRED") {
        result.deferred = true;
        break;
      }
      throw error;
    }
    result.imported += batch.length;
    opts.afterBatch?.(++batches);
    await yieldWriters(5);
    legacyCache.delete(resolve(home));
    if (legacyRunnerPeers(home)) {
      result.deferred = true;
      break;
    }
  }
  files = legacyFiles(home);
  result.remaining = files.length;
  if (!result.deferred && !files.length) {
    legacyCache.delete(resolve(home));
    if (!legacyRunnerPeers(home)) transaction(home, db, () => put(db, MARKER_DOMAIN, MARKER_KEY, { complete: true, importedAt: Date.now() }));
  }
  return result;
}
function runnerFilesImported(home) {
  const db = existingMetadataDb(home);
  return Boolean(db && imported(db));
}

export {
  packArchivedRuns,
  drainScan,
  drainScanResponsive,
  DEFAULT_RUN_PAGE_SIZE,
  MAX_RUN_PAGE_SIZE,
  readHistoryJson,
  readRunLogs,
  readRunLogsResponsive,
  readRunLogsSteps,
  unchangedContainedFile,
  readRunStarts,
  selectHistoryJobs,
  selectHistoryJobsResponsive,
  findHistoryJob,
  historyJobsSteps,
  pageRuns,
  runnerStatePath,
  runnerSpecPath,
  legacyRunnerPeers,
  readRunnerStateRecord,
  writeRunnerStateRecord,
  readPendingRunnerSpec,
  publishRunnerSpec,
  takeRunnerSpec,
  importRunnerFiles,
  runnerFilesImported
};
