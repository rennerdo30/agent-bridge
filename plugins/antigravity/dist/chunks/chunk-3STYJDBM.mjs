import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  activeByteSources,
  safeFile
} from "./chunk-I32N5HZ3.mjs";
import {
  displayPathText
} from "./chunk-HYOPFLLN.mjs";
import {
  BridgeError
} from "./chunk-IYJ5P7ML.mjs";
import {
  JSON_STORE_VERSION,
  archiveFile,
  assertWritableStore,
  cloneJson,
  closeMetadataDb,
  drainScan,
  drainScanResponsive,
  existingMetadataDb,
  fileSignature,
  fileTimeMs,
  indexedJobProjectionCurrent,
  isRecord,
  isSqliteBusy,
  legacyStorePeers,
  mergeStoreFields,
  metadataDb,
  metadataDbOpen,
  metadataFileLease,
  metadataReaderRetained,
  physicalMetadataPath,
  readIndexedJobSteps,
  readJsonSnapshot,
  readJsonStore,
  refreshStorePeerIdentities,
  retainMetadataFiles,
  retentionLimit,
  storageLease,
  writeJsonStore
} from "./chunk-SCH2MQMZ.mjs";
import {
  APP_VERSION,
  DB_FILE_NAME,
  JOBS_FILE,
  REQUEST_TIMEOUT_MS
} from "./chunk-M2P5YTJL.mjs";

// src/core/finished-run-bundles.ts
import { existsSync as existsSync5, lstatSync as lstatSync3, readFileSync as readFileSync3, readdirSync as readdirSync5, statSync as statSync6 } from "node:fs";
import { basename as basename5, join as join6, relative as relative3 } from "node:path";
import { DatabaseSync } from "node:sqlite";

// src/core/run-archive.ts
import { copyFileSync, existsSync as existsSync4, mkdirSync as mkdirSync3, readdirSync as readdirSync4, renameSync as renameSync2, statSync as statSync5 } from "node:fs";
import { basename as basename4, dirname as dirname3, join as join5 } from "node:path";

// src/core/run-log-preview.ts
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
var WINDOW_BYTES = 32 * 1024;
function readRunLogPreview(file, expectedSignature) {
  const retained = activeByteSources()?.open(file);
  if (retained) {
    try {
      const witnessed = statSync(file, { bigint: true });
      if (!witnessed.isFile() || expectedSignature !== void 0 && fileSignature(witnessed) !== expectedSignature)
        throw new Error("run log changed before its preview read");
    } catch (err) {
      retained.close();
      throw err;
    }
    try {
      return previewOf(retained.size, (buffer, position) => retained.read(buffer, 0, buffer.length, position));
    } finally {
      retained.close();
    }
  }
  const fd = openSync(file, "r");
  try {
    const witnessed = fstatSync(fd, { bigint: true });
    if (!witnessed.isFile() || expectedSignature !== void 0 && fileSignature(witnessed) !== expectedSignature)
      throw new Error("run log changed before its preview read");
    return previewOf(Number(witnessed.size), (buffer, position) => readSync(fd, buffer, 0, buffer.length, position));
  } finally {
    closeSync(fd);
  }
}
function previewOf(size, readAt) {
  const read = (position, length) => {
    const buffer = Buffer.alloc(length);
    const count = readAt(buffer, position);
    return buffer.subarray(0, count).toString("utf8");
  };
  if (size <= WINDOW_BYTES * 2) return read(0, size);
  const head = read(0, WINDOW_BYTES), tail = read(size - WINDOW_BYTES, WINDOW_BYTES);
  const headEnd = head.lastIndexOf("\n"), tailStart = tail.indexOf("\n");
  return `${headEnd < 0 ? "" : head.slice(0, headEnd + 1)}[... retained log ...]
${tailStart < 0 ? "" : tail.slice(tailStart + 1)}`;
}

// src/core/job-run-index.ts
import { createHash as createHash2 } from "node:crypto";
import { appendFileSync as appendFileSync2, existsSync as existsSync3, realpathSync as realpathSync2, statSync as statSync4 } from "node:fs";
import { appendFile } from "node:fs/promises";
import { basename as basename3, join as join4, relative as relative2, sep as sep2 } from "node:path";
import { setImmediate as yieldTurn, setTimeout as delay2 } from "node:timers/promises";

// src/core/run-history.ts
import { readFile } from "node:fs/promises";
import { lstatSync as lstatSync2, readdirSync as readdirSync3, realpathSync, statSync as statSync3 } from "node:fs";
import { dirname as dirname2, isAbsolute, join as join3, relative, sep } from "node:path";

// src/core/runfeed.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { basename as basename2, join as join2 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// src/core/runner-store.ts
import { randomUUID, createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
  return join(home, RUNNER_DIR, `${id}.json`);
}
function runnerSpecPath(home, id) {
  return join(home, RUNNER_DIR, `${id}.spec.json`);
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
    const value2 = JSON.parse(String(found.value));
    return isRecord(value2) ? value2 : null;
  } catch {
    return null;
  }
}
function put(db, domain, key, value2) {
  runnerStoreStats.rowWrites++;
  db.prepare(`INSERT INTO bridge_metadata VALUES (?,?,?,?)
   ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(domain, key, JSON.stringify(value2), Date.now());
}
function archive(db, domain, id, value2) {
  db.prepare("INSERT INTO bridge_metadata VALUES (?,?,?,?) ON CONFLICT(domain,key) DO NOTHING").run(domain, `${id}/${Date.now()}-${randomUUID()}`, JSON.stringify(value2), Date.now());
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
  let value2;
  try {
    value2 = legacyStorePeers(home).length > 0;
  } catch {
    value2 = true;
  }
  legacyCache.set(key, { at: Date.now(), value: value2 });
  if (value2) {
    try {
      const db = existingMetadataDb(home);
      if (db && imported(db)) transaction(home, db, () => put(db, MARKER_DOMAIN, MARKER_KEY, { complete: false, reopenedAt: Date.now() }));
    } catch {
    }
  }
  return value2;
}
function fileMode(home, db) {
  return legacyRunnerPeers(home) || !imported(db);
}
function readStateFileRaw(home, id, preserve = true) {
  runnerStoreStats.fileReads++;
  const path = runnerStatePath(home, id);
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  if (!preserve) return readHistoryJson(path);
  return readJsonStore(path, void 0, (v) => isRecord(v) && typeof v.pid === "number" && typeof v.status === "string");
}
function readStateFile(home, id, preserve = true) {
  const value2 = readStateFileRaw(home, id, preserve);
  return isRecord(value2) && typeof value2.pid === "number" && typeof value2.status === "string" && !(Number(value2.version) > JSON_STORE_VERSION) ? value2 : null;
}
function readLegacyFile(path) {
  try {
    if (lstatSync(path).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return readHistoryJson(path);
}
var stamp = (value2) => typeof value2?.updatedAt === "number" ? value2.updatedAt : typeof value2?.turnResetAt === "number" ? value2.turnResetAt : -Infinity;
var hasState = (value2) => Boolean(value2 && typeof value2.pid === "number" && typeof value2.status === "string");
var stateBase = (value2) => hasState(value2) ? value2 : {};
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
  const value2 = readLegacyFile(runnerSpecPath(home, id));
  return isRecord(value2) ? value2 : null;
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
  const name = basename(specFile), dir = dirname(specFile);
  const match = /^(.+)\.spec\.json$/.exec(name);
  if (match && basename(dir) === RUNNER_DIR && validId(match[1])) {
    const home = dirname(dir), id = match[1];
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
  const root = join(home, RUNNER_DIR), files = [];
  for (const dir of [root, join(root, "archive"), join(root, ".import")]) {
    if (!existsSync(dir)) continue;
    physicalMetadataPath(dir);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      physicalMetadataPath(path);
      if (name.endsWith(".tmp") || !lstatSync(path).isFile()) continue;
      files.push(path);
    }
  }
  return files;
}
function staged(home, db, file, raw) {
  const rel = file.slice(resolve(home).length + 1).replace(/\\/g, "/");
  const prior = db.prepare("SELECT sha256,cold_path FROM bridge_imports WHERE path=?").get(rel);
  if (!prior) return file;
  if (prior.sha256 === createHash("sha256").update(raw()).digest("hex") && !existsSync(String(prior.cold_path))) return file;
  const dir = join(home, RUNNER_DIR, ".import");
  physicalMetadataPath(dir);
  mkdirSync(dir, { recursive: true, mode: 448 });
  const target = join(dir, `${basename(file)}~${Date.now()}-${randomUUID()}`);
  renameSync(file, target);
  return target;
}
function projectFile(store, path, raw) {
  let value2;
  try {
    value2 = JSON.parse(raw.toString("utf8"));
  } catch {
    return;
  }
  if (!isRecord(value2)) return;
  const parts = path.split("/"), name = parts.at(-1);
  const live = /^(.+?)(\.spec)?\.json(?:~\d+-[\w-]+)?$/.exec(name);
  const old = /^(.+?)(\.spec)?\.json-\d+-[\w-]+$/.exec(name);
  if (parts[1] !== "archive" && live && validId(live[1])) {
    const id = live[1];
    if (live[2]) {
      const current2 = row(store, SPEC, id);
      if (!current2) put(store, SPEC, id, value2);
      else if (JSON.stringify(current2) !== JSON.stringify(value2)) archive(store, SPEC_ARCHIVE, id, value2);
      return;
    }
    const current = row(store, STATE, id);
    if (hasState(value2) && stamp(value2) > stamp(current)) adoptFileState(store, id, current, value2);
    else if (JSON.stringify(current) !== JSON.stringify(value2)) archive(store, STATE_ARCHIVE, id, value2);
    return;
  }
  if (parts[1] === "archive" && old && validId(old[1])) archive(store, old[2] ? SPEC_ARCHIVE : STATE_ARCHIVE, old[1], value2);
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
    const batch = files.slice(offset, offset + (opts.batch ?? IMPORT_BATCH)).map((file) => staged(home, db, file, () => readFileSync(file)));
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

// src/core/runfeed.ts
var RUNS_DIR_NAME = "runs";
var HEARTBEAT_MS = 6e4;
var KEEP_RUN_LOGS = 50;
var STALE_RUN_MS = 15e4;
function runMetaPath(logPath) {
  return logPath.replace(/\.log$/, ".json");
}
var CONTINUATION = "         ";
function stamp2(t) {
  return new Date(t).toTimeString().slice(0, 8);
}
function pruneOldLogs(dir) {
  try {
    archiveOldRuns(join2(dir, ".."));
    const limit = retentionLimit("AGENT_BRIDGE_RUN_LOG_LIMIT", KEEP_RUN_LOGS);
    if (!limit) return;
    const files = readdirSync2(dir).filter((f) => f.endsWith(".log")).map((f) => ({ f, t: statSync2(join2(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(limit)) {
      const path = join2(dir, f);
      if (Date.now() - statSync2(path).mtimeMs <= STALE_RUN_MS && !finishedRunLine(readFileSync2(path, "utf8"))) continue;
      archiveRun(path);
    }
  } catch (err) {
    process.stderr.write(`could not archive run logs: ${String(err)}
`);
  }
}
async function startRunFeedReady(opts, signal) {
  let queued = false;
  for (; ; ) {
    signal.throwIfAborted();
    await refreshStorePeerIdentities(opts.home, signal);
    signal.throwIfAborted();
    try {
      return startRunFeed({ ...opts, requireMetadata: true });
    } catch (error) {
      if (error.code !== "STORE_UPGRADE_DEFERRED") throw error;
      if (!queued) {
        opts.forward?.("queued: waiting for compatible storage readers to retain run context");
        queued = true;
      }
      try {
        await delay(250, void 0, { signal });
      } catch (error2) {
        signal.throwIfAborted();
        throw error2;
      }
    }
  }
}
function startRunFeed(opts) {
  const now = opts.now ?? Date.now;
  const release = storageLease(opts.home);
  const dir = join2(opts.home, RUNS_DIR_NAME);
  const logPath = join2(dir, `${new Date(now()).toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${opts.name}.log`);
  const write = (line) => {
    const [first, ...rest] = displayPathText(line).replace(/\r/g, "").split("\n");
    const body = [first, ...rest.map((l) => `${CONTINUATION}${l}`)].join("\n");
    try {
      appendFileSync(logPath, `${stamp2(now())} ${body}
`);
    } catch {
    }
  };
  let meta = { ...opts.meta };
  const indexRoute = () => {
    if (!existsSync2(join2(opts.home, "bridge.db"))) return;
    try {
      releasingMetadata(opts.home, () => {
        try {
          indexRunFile(opts.home, logPath);
        } catch {
          invalidateJobRunIndex(opts.home);
        }
      });
    } catch {
    }
  };
  let attemptedRouting;
  const routing = () => JSON.stringify([meta.job ?? null, meta.jobStartedAt ?? null]);
  const writeMeta = (required = false) => {
    try {
      const path = runMetaPath(logPath);
      const previous = readJsonStore(path);
      writeJsonStore(path, mergeStoreFields(isRecord(previous) ? previous : {}, { ...meta }), previous);
      if (logPublished && attemptedRouting !== routing()) {
        attemptedRouting = routing();
        indexRoute();
      }
    } catch (err) {
      if (required) throw err;
      process.stderr.write(`could not save run metadata: ${String(err)}
`);
    }
  };
  let logPublished = false;
  try {
    mkdirSync2(dir, { recursive: true });
    writeMeta(opts.requireMetadata);
  } catch (error) {
    release();
    throw error;
  }
  write(opts.header);
  logPublished = true;
  attemptedRouting = routing();
  indexRoute();
  const job = opts.meta?.job, jobStartedAt = opts.meta?.jobStartedAt;
  if (typeof job === "string" && typeof jobStartedAt === "number" && Number.isFinite(jobStartedAt)) {
    const id = job.replace(/^.*-(?:job|ask)-/, "");
    try {
      const state = readRunnerStateRecord(opts.home, id);
      if (state?.pid === process.pid && state.peer === job && state.status === "running" && Number(state.updatedAt) >= jobStartedAt) {
        writeRunnerStateRecord(opts.home, id, { ...state, currentRun: { id, startedAt: jobStartedAt, log: basename2(logPath) } });
      }
    } catch {
    }
  }
  pruneOldLogs(dir);
  const started = now();
  let lastStep = "starting";
  let lastAt = started;
  const emit = (m) => {
    write(m);
    opts.forward?.(displayPathText(m));
  };
  emit(`started \xB7 follow live: agent-bridge watch ${opts.name}`);
  const timer = setInterval(() => {
    const quietMin = Math.floor((now() - lastAt) / 6e4);
    if (quietMin >= 1) emit(`still working, no new step for ${quietMin}m (last: ${lastStep})`);
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref();
  return {
    logPath,
    report: (m, full) => {
      lastStep = m.split(" \xB7 ").pop() ?? m;
      lastAt = now();
      write(full ?? m);
      opts.forward?.(displayPathText(m));
    },
    end: (summary, answer) => {
      clearInterval(timer);
      meta = { ...meta, etaAt: void 0, etaReportedAt: void 0 };
      writeMeta();
      if (answer?.trim()) write(`answer: ${answer.trim()}`);
      write(`finished after ${Math.round((now() - started) / 1e3)}s \xB7 ${summary}`);
      release();
    },
    meta: (patch) => {
      meta = { ...meta, ...patch };
      writeMeta();
    }
  };
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
function readRunLogsResponsive(home, namesFilter, observedComplete, signal, routingOnly = false) {
  return drainScanResponsive((function* () {
    const scan = readRunLogsSteps(home, namesFilter, true, observedComplete, routingOnly);
    try {
      for (; ; ) {
        signal?.throwIfAborted();
        const next = scan.next();
        if (next.done) return next.value;
        yield;
      }
    } finally {
      scan.return([]);
    }
  })());
}
function* readRunLogsSteps(home, namesFilter, responsive = false, observedComplete, routingOnly = false) {
  const root = join3(home, RUNS_DIR_NAME);
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync.native(root);
  } catch (error) {
    observedComplete?.(error.code === "ENOENT");
    return [];
  }
  const warmWitness = responsive ? captureWarmRunRoot(root, canonicalRoot) : void 0;
  const records = /* @__PURE__ */ new Map();
  const signatures = [];
  let complete = !responsive || Boolean(warmWitness), metadataBytes = 0;
  const directories = [];
  for (const archived of [true, false]) {
    const dir = archived ? join3(root, "archive") : root;
    let canonicalDir;
    try {
      canonicalDir = realpathSync.native(dir);
    } catch (error) {
      if (error.code !== "ENOENT") complete = false;
      continue;
    }
    const rel = relative(canonicalRoot, canonicalDir);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      complete = false;
      continue;
    }
    let entries;
    try {
      entries = readdirSync3(canonicalDir, { withFileTypes: true });
    } catch {
      complete = false;
      continue;
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const localFile = (entry) => {
      const file = join3(canonicalDir, entry.name);
      try {
        const direct = lstatSync2(file, { bigint: true });
        return direct.isFile() ? { file, st: direct } : direct.isSymbolicLink() ? (() => {
          const actual = safeFile(root, file, canonicalRoot);
          return actual ? { file: actual, st: statSync3(actual, { bigint: true }) } : null;
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
      if (!record) {
        complete = false;
        continue;
      }
      if (warmWitness && !captureWarmRunParents(warmWitness, dirname2(record.file))) complete = false;
      signatures.push(`${archived}:${name}:${record.file}:${fileSignature(record.st)}`);
      if (extension === ".json") metadataBytes += Number(record.st.size);
      selected.push({ name, original, ...record });
    }
    directories.push({ archived, files: selected });
  }
  const packed = packedRunRecords(home, namesFilter);
  signatures.push(`packed:${packed.length}:${packed.reduce((n, r) => Math.max(n, r.updatedAt), 0)}`);
  const key = `${canonicalRoot}:${namesFilter ? JSON.stringify([...namesFilter].sort()) : "*"}`;
  const signature = signatures.join("\n"), saved = runLogSnapshots.get(key);
  if (!routingOnly && saved?.signature === signature) {
    if (!responsive || warmWitness && (yield* stableWarmRunFiles(warmWitness, directories))) {
      observedComplete?.(complete);
      return yield* cloneRunRecords(saved.records);
    }
    runLogSnapshots.delete(key);
    observedComplete?.(false);
    return [];
  }
  for (const { archived, files } of directories) {
    const metadata = /* @__PURE__ */ new Map();
    const metadataFiles = /* @__PURE__ */ new Map(), metadataTimes = /* @__PURE__ */ new Map();
    for (const { original, file, st } of files) {
      yield;
      if (!original.endsWith(".json")) continue;
      try {
        if (routingOnly) {
          if (safeFile(root, file, canonicalRoot) !== file) {
            complete = false;
            continue;
          }
          metadataFiles.set(original, file);
          metadataTimes.set(original, fileTimeMs(st.mtimeMs, st.mtimeNs));
          continue;
        }
        if (responsive && !unchangedContainedFile(root, file, st, canonicalRoot)) {
          complete = false;
          continue;
        }
        const value2 = readJsonSnapshot(file, { file, stat: st }).value;
        if (isRecord(value2)) {
          metadata.set(original, value2);
          metadataFiles.set(original, file);
        } else complete = false;
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
        const record = {
          name: key2,
          file,
          updatedAt: fileTimeMs(st.mtimeMs, st.mtimeNs),
          size: Number(st.size),
          signature: fileSignature(st),
          archived,
          meta: metadata.get(`${key2}.json`) ?? {},
          metadataFile: metadataFiles.get(`${key2}.json`),
          ...metadataTimes.has(`${key2}.json`) ? { metadataUpdatedAt: metadataTimes.get(`${key2}.json`) } : {}
        };
        const recordKey = routingOnly ? file : key2, previous = records.get(recordKey);
        if (!previous || !archived || record.updatedAt >= previous.updatedAt) records.set(recordKey, record);
      } catch {
      }
    }
  }
  for (const record of packed) {
    const recordKey = routingOnly ? record.file : record.name;
    if (!records.has(recordKey)) records.set(recordKey, record);
  }
  const result = [...records.values()];
  if (responsive) complete &&= routingOnly ? Boolean(warmWitness && unchangedWarmRunParents(warmWitness, warmWitness.parents.keys())) : yield* stableRunFiles(root, directories, canonicalRoot);
  runLogSnapshots.delete(key);
  if (!routingOnly && complete && metadataBytes <= 256 * 1024 * 1024) runLogSnapshots.set(key, { signature, records: result });
  if (runLogSnapshots.size > 8) runLogSnapshots.delete(runLogSnapshots.keys().next().value);
  observedComplete?.(complete);
  return yield* cloneRunRecords(result);
}
function sameDirectory(st, identity) {
  return st.dev === identity.dev && st.ino === identity.ino;
}
function captureWarmRunRoot(root, canonicalRoot) {
  try {
    const alias = lstatSync2(root, { bigint: true }), physical = lstatSync2(canonicalRoot, { bigint: true });
    if (!alias.isDirectory() && !alias.isSymbolicLink() || !physical.isDirectory() || physical.isSymbolicLink() || realpathSync.native(root) !== canonicalRoot) return void 0;
    return { root, canonicalRoot, alias: { dev: alias.dev, ino: alias.ino }, parents: /* @__PURE__ */ new Map([[canonicalRoot, { dev: physical.dev, ino: physical.ino }]]), valid: true };
  } catch {
    return void 0;
  }
}
function captureWarmRunParents(witness, parent) {
  if (!witness.valid) return false;
  const rel = relative(witness.canonicalRoot, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return witness.valid = false;
  try {
    for (let at = parent; !witness.parents.has(at); at = dirname2(at)) {
      const st = lstatSync2(at, { bigint: true });
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
  for (const file of files) for (let at = dirname2(file.file); ; at = dirname2(at)) {
    if (!witness.parents.has(at)) return void 0;
    parents.add(at);
    if (at === witness.canonicalRoot) break;
    if (dirname2(at) === at) return void 0;
  }
  return parents;
}
function unchangedWarmRunParents(witness, parents = [witness.canonicalRoot]) {
  if (!witness.valid) return false;
  try {
    const alias = lstatSync2(witness.root, { bigint: true });
    if (!sameDirectory(alias, witness.alias) || realpathSync.native(witness.root) !== witness.canonicalRoot) return false;
    for (const path of parents) {
      const identity = witness.parents.get(path);
      if (!identity) return false;
      const st = path === witness.root ? alias : lstatSync2(path, { bigint: true });
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
          const direct = lstatSync2(file.file, { bigint: true });
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
    const direct = lstatSync2(file, { bigint: true });
    return direct.isFile() && fileSignature(direct) === fileSignature(before) && safeFile(root, file, canonicalRoot) === file;
  } catch {
    return false;
  }
}
async function readRunStarts(home) {
  const root = join3(home, RUNS_DIR_NAME);
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
      dir = realpathSync.native(archived ? join3(root, "archive") : root);
    } catch {
      continue;
    }
    const rel = relative(canonicalRoot, dir);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    let entries;
    try {
      entries = readdirSync3(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const paths = /* @__PURE__ */ new Map();
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const original = archived ? entry.name.replace(ARCHIVE_SUFFIX, "$1") : entry.name;
      const file = join3(dir, entry.name);
      const contained = entry.isFile() ? file : entry.isSymbolicLink() ? safeFile(root, file, canonicalRoot) : null;
      if (contained) {
        const previous = paths.get(original);
        if (previous && original.endsWith(".log")) {
          try {
            if (statSync3(previous, { bigint: true }).mtimeMs > statSync3(contained, { bigint: true }).mtimeMs) continue;
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
          const direct = lstatSync2(file, { bigint: true });
          const readable = direct.isFile() ? file : direct.isSymbolicLink() ? safeFile(root, file, canonicalRoot) : null;
          if (!readable) return;
          const before = direct.isFile() ? direct : statSync3(readable, { bigint: true });
          if (!before.isFile()) return;
          const raw = await readFile(readable, "utf8");
          const after = lstatSync2(readable, { bigint: true });
          if (!after.isFile() || fileSignature(after) !== fileSignature(before)) return;
          const meta = JSON.parse(raw);
          if (!isRecord(meta) || typeof meta.job !== "string") return;
          const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(name);
          const logStat = m ? void 0 : statSync3(log, { bigint: true });
          const startedAt = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : fileTimeMs(logStat.mtimeMs, logStat.mtimeNs);
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
  const out = /* @__PURE__ */ new Map(), path = join3(home, JOBS_FILE);
  if (responsive) yield;
  let canonicalHome;
  try {
    canonicalHome = realpathSync.native(home);
  } catch {
    return out;
  }
  const indexed = join3(canonicalHome, JOBS_FILE);
  for (const job of (yield* readIndexedJobSteps(indexed, responsive, { ...selection, history: true })).jobs) {
    if (responsive) yield;
    if (typeof job.name === "string" && RUN_LOG_NAME.test(job.name + ".log")) out.set(job.name, job);
  }
  if (indexedJobProjectionCurrent(indexed)) return out;
  const active = safeFile(home, path, canonicalHome);
  if (!active) return out;
  let st;
  try {
    st = statSync3(active, { bigint: true });
  } catch {
    return out;
  }
  if (responsive) yield;
  if (!unchangedContainedFile(home, active, st, canonicalHome)) return out;
  let value2;
  try {
    value2 = readJsonSnapshot(active, { file: active, stat: st }).value;
  } catch {
    return out;
  }
  const jobs = Array.isArray(value2) ? value2 : isRecord(value2) && Array.isArray(value2.jobs) ? value2.jobs : [];
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

// src/core/job-run-index.ts
var HEAD = "job-run-head-v1";
var HISTORY = "job-run-history-v1";
var STATE2 = "job-run-index-v1";
var SCHEMA = 3;
var pending = /* @__PURE__ */ new Map();
var retries = /* @__PURE__ */ new Map();
var invalid = /* @__PURE__ */ new Set();
var brokerHomes = /* @__PURE__ */ new Set();
var reobservations = /* @__PURE__ */ new Map();
var misses = /* @__PURE__ */ new Map();
var watermarks = /* @__PURE__ */ new Map();
var JOB_INDEX_WAIT_MS = REQUEST_TIMEOUT_MS / 2;
var JOB_INDEX_BUSY_WAIT_MS = 40;
var MISS_TTL_MS = 3e4;
var MISS_LIMIT = 4096;
var MTIME_SLACK_MS = 6e4;
var BUSY_RETRIES = 12;
function rootKey(home) {
  return realpathSync2.native(home);
}
function start(run) {
  if (Number.isFinite(run.meta.jobStartedAt)) return run.meta.jobStartedAt;
  const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(run.name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : run.updatedAt;
}
function keys(run) {
  if (typeof run.meta.job === "string") return [run.meta.job];
  if (run.metadataFile || Object.keys(run.meta).length) return [];
  const out = [];
  const match = /-(claude|codex|opencode|antigravity|muse)-([\w-]+)$/.exec(run.name);
  if (match) out.push(`${match[1]}-job-${match[2]}`, `${match[1]}-ask-${match[2]}`);
  return [...new Set(out)];
}
function busyWait(home) {
  try {
    return brokerHomes.has(rootKey(home)) ? 0 : JOB_INDEX_BUSY_WAIT_MS;
  } catch {
    return JOB_INDEX_BUSY_WAIT_MS;
  }
}
var statements = /* @__PURE__ */ new WeakMap();
function statement(db, sql) {
  let byText = statements.get(db);
  if (!byText) statements.set(db, byText = /* @__PURE__ */ new Map());
  let prepared = byText.get(sql);
  if (!prepared) byText.set(sql, prepared = db.prepare(sql));
  return prepared;
}
function withBusyWait(home, action) {
  const db = metadataDb(home);
  if (db.isTransaction) return action();
  const wait = busyWait(home), timeout = Number(statement(db, "PRAGMA busy_timeout").get().timeout);
  if (timeout === wait) return action();
  db.exec(`PRAGMA busy_timeout=${wait}`);
  try {
    return action();
  } finally {
    db.exec(`PRAGMA busy_timeout=${timeout}`);
  }
}
function value(home, domain, key) {
  return withBusyWait(home, () => {
    const row2 = statement(metadataDb(home), "SELECT value FROM bridge_metadata WHERE domain=? AND key=?").get(domain, key);
    return row2 ? JSON.parse(String(row2.value)) : void 0;
  });
}
function put2(home, domain, key, record) {
  statement(metadataDb(home), "INSERT INTO bridge_metadata VALUES (?,?,?,?) ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(domain, key, JSON.stringify(record), Date.now());
}
function completion(home) {
  if (invalid.has(rootKey(home)) || !existsSync3(join4(home, "bridge.db"))) return void 0;
  const complete = value(home, STATE2, "complete");
  return isRecord(complete) && complete.version === SCHEMA && complete.failures === failureWitness(home) ? complete : void 0;
}
function ready(home) {
  return completion(home) !== void 0;
}
var jobRunIndexReady = ready;
function failureWitness(home) {
  const file = join4(home, "job-run-index.dirty");
  try {
    physicalMetadataPath(file);
    return fileSignature(statSync4(file, { bigint: true }));
  } catch (error) {
    if (error.code === "ENOENT") return "none";
    throw error;
  }
}
function transaction2(home, action) {
  const db = metadataDb(home);
  if (db.isTransaction) return action();
  return withBusyWait(home, () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}
function invalidateJobRunIndex(home) {
  const key = rootKey(home);
  invalid.add(key);
  misses.delete(key);
  try {
    const file = join4(home, "job-run-index.dirty");
    physicalMetadataPath(file);
    if (brokerHomes.has(key)) void appendFile(file, "\n", { mode: 384, flush: true }).catch(() => {
    });
    else appendFileSync2(file, "\n", { mode: 384, flush: true });
  } catch {
  }
  try {
    transaction2(home, () => {
      put2(home, STATE2, "complete", false);
      put2(home, STATE2, "invalidated", Number(value(home, STATE2, "invalidated") ?? 0) + 1);
    });
  } catch {
  }
  if (!pending.has(key)) scheduleRetry(home);
}
function olderWriter(writer) {
  if (typeof writer !== "string") return true;
  const a = writer.split(".").map(Number), b = APP_VERSION.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (!Number.isFinite(x)) return true;
    if (x !== y) return x < y;
  }
  return false;
}
function startBrokerJobRunIndex(home) {
  try {
    if (existsSync3(join4(home, "bridge.db"))) {
      const complete = value(home, STATE2, "complete");
      if (isRecord(complete) && (complete.version !== SCHEMA || olderWriter(complete.writer))) invalidateJobRunIndex(home);
    }
  } catch {
  }
  brokerHomes.add(rootKey(home));
  return startJobRunBackfill(home);
}
function scheduleRetry(home, attempt = 0) {
  let key;
  try {
    key = rootKey(home);
  } catch {
    return;
  }
  if (retries.has(key)) return;
  const timer = setTimeout(() => {
    retries.delete(key);
    void Promise.resolve().then(() => startJobRunBackfill(home, attempt + 1)).catch(() => {
    });
  }, Math.min(3e4, 250 * 2 ** Math.min(attempt, 7)));
  timer.unref();
  retries.set(key, { timer, attempt });
}
function routingFacts(run) {
  return JSON.stringify([run.name, run.file, run.metadataFile ?? null, run.meta.job ?? null, run.meta.jobStartedAt ?? null]);
}
function indexJobRun(home, run) {
  run = { ...run, meta: isRecord(run.meta) ? run.meta : {} };
  const json = JSON.stringify(run), digest = createHash2("sha256").update(routingFacts(run)).digest("hex");
  const db = metadataDb(home);
  transaction2(home, () => {
    if (!value(home, HISTORY, digest)) statement(db, "INSERT OR IGNORE INTO bridge_metadata VALUES (?,?,?,?)").run(HISTORY, digest, json, Date.now());
    for (const key of keys(run)) {
      const previous = value(home, HEAD, key);
      if (previous && routingFacts(previous) === routingFacts(run)) continue;
      const candidates = [...previous?.legacyCandidates ?? (previous ? [{ name: previous.name, file: previous.file }] : [])];
      if (!candidates.some((candidate) => candidate.file === run.file)) candidates.push({ name: run.name, file: run.file });
      const replace = !previous || start(run) > start(previous) || start(run) === start(previous) && (run.name === previous.name || run.updatedAt >= previous.updatedAt);
      const head = replace ? run : previous;
      const next = { ...head, indexRoot: relative2(rootKey(home), head.file).split(sep2)[0] === "runs" ? "runs" : "home", legacyCandidates: candidates };
      if (JSON.stringify(previous) !== JSON.stringify(next)) put2(home, HEAD, key, next);
    }
  });
}
function usableMetadata(file) {
  try {
    const raw = readJsonSnapshot(file).value;
    return isRecord(raw) ? raw : {};
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}
function indexRunFile(home, file, metadataFile = file.replace(/\.log$/, ".json")) {
  indexJobRun(home, observeRunFile(home, file, metadataFile));
}
function metadataWitness(file) {
  try {
    return fileSignature(statSync4(file, { bigint: true }));
  } catch {
    return "missing";
  }
}
function observeRunFile(home, file, metadataFile, canonical = realpathSync2.native(join4(home, "runs"))) {
  const root = join4(home, "runs");
  const actual = safeFile(root, file, canonical), meta = safeFile(root, metadataFile, canonical);
  if (!actual || !meta && existsSync3(metadataFile)) throw new Error("Run index requires contained log and metadata files");
  const st = statSync4(actual, { bigint: true });
  if (!st.isFile()) throw new Error("Run index requires a regular run log");
  return {
    name: basename3(file).replace(/\.log$/, ""),
    file: actual,
    metadataFile: meta ?? void 0,
    updatedAt: fileTimeMs(st.mtimeMs, st.mtimeNs),
    size: Number(st.size),
    signature: fileSignature(st),
    archived: file !== join4(root, basename3(file)),
    meta: meta ? usableMetadata(meta) : {}
  };
}
function releasingMetadata(home, action) {
  const opened = !metadataDbOpen(home);
  try {
    return action();
  } finally {
    if (opened && metadataDbOpen(home) && !metadataReaderRetained(home)) {
      try {
        closeMetadataDb(home);
      } catch {
      }
    }
  }
}
var INDEX_BATCH = 32;
async function indexObserved(home, key, runs, signal) {
  for (let at = 0; at < runs.length; at += INDEX_BATCH) {
    signal.throwIfAborted();
    const batch = runs.slice(at, at + INDEX_BATCH);
    const observed = batch.map((run) => {
      if (!run.metadataFile || relative2(key, run.file).split(sep2)[0] !== "runs") return { run };
      const witness = metadataWitness(run.metadataFile), { metadataUpdatedAt: _, ...scanned } = run;
      return { run: { ...scanned, meta: usableMetadata(run.metadataFile) }, source: run, witness };
    });
    await yieldTurn();
    signal.throwIfAborted();
    await retryBusy(signal, () => transaction2(home, () => {
      for (const { run, source, witness } of observed) {
        indexJobRun(home, source && metadataWitness(source.metadataFile) !== witness ? observeRunFile(home, source.file, source.metadataFile) : run);
      }
    }));
    await yieldTurn();
  }
}
function startJobRunBackfill(home, attempt = 0) {
  const key = rootKey(home), active = pending.get(key);
  if (active) return active.work;
  const retry = retries.get(key);
  if (retry) {
    clearTimeout(retry.timer);
    retries.delete(key);
  }
  const stop = new AbortController();
  const work = (async () => {
    await yieldTurn();
    stop.signal.throwIfAborted();
    if (ready(home)) return;
    let release;
    while (!release) {
      stop.signal.throwIfAborted();
      if (ready(home)) return;
      try {
        release = metadataFileLease(join4(key, "job-run-index.lease"), 0, true);
      } catch (error) {
        if (error.code !== "ELEASEBUSY") throw error;
        await delay2(250, void 0, { signal: stop.signal });
      }
    }
    try {
      if (ready(home)) return;
      let complete = false;
      const before = value(home, STATE2, "invalidated"), failures = failureWitness(home), observedFrom = Date.now();
      const runs = await readRunLogsResponsive(home, void 0, (observed) => {
        complete = observed;
      }, stop.signal, true);
      await indexObserved(home, key, runs, stop.signal);
      stop.signal.throwIfAborted();
      if (!complete) throw preparing("catalog observation incomplete");
      await retryBusy(stop.signal, () => transaction2(home, () => {
        if (value(home, STATE2, "invalidated") !== before || failureWitness(home) !== failures) throw preparing("unindexed writer change");
        put2(home, STATE2, "complete", { version: SCHEMA, failures, writer: APP_VERSION, observedFrom, completedAt: Date.now() });
      }));
      invalid.delete(key);
      misses.delete(key);
      watermarks.delete(key);
    } finally {
      release();
    }
  })();
  pending.set(key, { work, stop });
  void work.then(() => pending.delete(key), () => {
    pending.delete(key);
    if (!stop.signal.aborted) scheduleRetry(home, attempt);
  });
  return work;
}
async function stopJobRunBackfill(home) {
  const key = rootKey(home), retry = retries.get(key);
  if (retry) {
    clearTimeout(retry.timer);
    retries.delete(key);
  }
  brokerHomes.delete(key);
  const active = [pending.get(key), reobservations.get(key)].filter((entry) => entry !== void 0);
  for (const entry of active) entry.stop.abort();
  for (const entry of active) await entry.work.catch(() => {
  });
}
function preparing(state) {
  return new BridgeError("job_index_preparing", `Job index preparing (${state}); retry later. No control submitted.`);
}
function stillRunning(state) {
  return new BridgeError("job_index_preparing", `Job index preparing (${state}); retry later. No control submitted.`, { budget: true });
}
async function bounded(work, deadline, state) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw stillRunning(state);
  let timer;
  try {
    await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(stillRunning(state)), remaining);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
async function retryBusy(signal, action) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return action();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= BUSY_RETRIES) throw error;
      await delay2(Math.min(25 * 2 ** attempt, 1e3), void 0, { signal });
    }
  }
}
function generation(home) {
  const complete = completion(home);
  return complete && JSON.stringify(complete);
}
function knownMiss(home, root, ref) {
  const entry = misses.get(root)?.get(ref);
  return entry !== void 0 && performance.now() - entry.at < MISS_TTL_MS && entry.generation === generation(home);
}
function rememberMiss(root, ref, entry) {
  const byKey = misses.get(root) ?? /* @__PURE__ */ new Map();
  byKey.delete(ref);
  byKey.set(ref, entry);
  if (byKey.size > MISS_LIMIT) byKey.delete(byKey.keys().next().value);
  misses.set(root, byKey);
}
var REOBSERVE_CHUNK = 256;
function missKey(ref, startedAt) {
  return Number.isFinite(startedAt) ? `${ref}\0${startedAt}` : ref;
}
function headAnswers(home, ref, startedAt) {
  const head = value(home, HEAD, ref);
  if (!head) return false;
  const known = isRecord(head.meta) ? head.meta.jobStartedAt : void 0;
  return !Number.isFinite(startedAt) || known === void 0 || known === startedAt;
}
function startReobservation(home, root, request) {
  const stop = new AbortController();
  const pass = { keys: /* @__PURE__ */ new Map([[missKey(request.ref, request.startedAt), request]]), open: true, stop, work: Promise.resolve() };
  pass.work = (async () => {
    await yieldTurn();
    pass.open = false;
    const complete = completion(home), current = complete && JSON.stringify(complete);
    if (!complete || !current) return;
    const from = Math.max(watermarks.get(root) ?? -Infinity, (complete.observedFrom ?? 0) - MTIME_SLACK_MS), began = Date.now();
    const suffixes = [...pass.keys.values()].flatMap(({ ref: key }) => {
      const legacy = /^(claude|codex|opencode|antigravity|muse)-(?:job|ask)-([\w-]+)$/.exec(key);
      return legacy ? [`-${legacy[1]}-${legacy[2]}`] : [];
    });
    let observed = false;
    const runs = await readRunLogsResponsive(home, void 0, (value2) => {
      observed = value2;
    }, stop.signal, true);
    const changed = [];
    for (let at2 = 0; at2 < runs.length; at2 += REOBSERVE_CHUNK) {
      stop.signal.throwIfAborted();
      for (const run of runs.slice(at2, at2 + REOBSERVE_CHUNK)) {
        if (relative2(root, run.file).split(sep2)[0] !== "runs") continue;
        if (suffixes.some((suffix) => run.name.endsWith(suffix)) || run.updatedAt >= from || (run.metadataUpdatedAt ?? -Infinity) >= from) changed.push(run);
      }
      await yieldTurn();
    }
    await indexObserved(home, root, changed, stop.signal);
    if (!observed || generation(home) !== current) return;
    watermarks.set(root, Math.max(from, began - MTIME_SLACK_MS));
    const at = performance.now();
    for (const [key, { ref, startedAt }] of pass.keys) if (!headAnswers(home, ref, startedAt)) rememberMiss(root, key, { generation: current, at });
  })();
  reobservations.set(root, pass);
  const done = () => {
    if (reobservations.get(root) === pass) reobservations.delete(root);
  };
  void pass.work.then(done, done);
  return pass;
}
async function reobserveKey(home, ref, deadline, startedAt) {
  const root = rootKey(home), key = missKey(ref, startedAt);
  for (; ; ) {
    if (headAnswers(home, ref, startedAt) || knownMiss(home, root, key)) return;
    let pass = reobservations.get(root);
    if (pass?.open) pass.keys.set(key, { ref, startedAt });
    else if (!pass) pass = startReobservation(home, root, { ref, startedAt });
    const covered = pass.keys.has(key);
    await bounded(pass.work, deadline, "reobservation running");
    if (covered) return;
  }
}
async function waitForJobRunIndex(home, deadline, ref, startedAt) {
  try {
    if (ready(home)) {
      if (ref) await reobserveKey(home, ref, deadline, startedAt);
      return "indexed";
    }
    await bounded(startJobRunBackfill(home), deadline, "backfill running");
    return ready(home) ? "indexed" : "discover";
  } catch (error) {
    if (error instanceof BridgeError && error.details?.budget === true) throw error;
    return "discover";
  }
}
function indexedJobRun(home, ref, startedAt) {
  let stored, root, canonical, file;
  try {
    stored = value(home, HEAD, ref);
    if (!stored) return [];
    if (legacyJobRunAmbiguous(home, ref)) return [];
    root = stored.indexRoot === "runs" ? join4(home, "runs") : home;
    canonical = realpathSync2.native(root);
    file = safeFile(root, stored.file, canonical);
  } catch {
    throw preparing("indexed run unavailable");
  }
  const metadataFile = stored.metadataFile ?? (stored.indexRoot === "runs" && existsSync3(stored.file.replace(/\.log$/, ".json")) ? stored.file.replace(/\.log$/, ".json") : void 0);
  const metadata = metadataFile ? safeFile(root, metadataFile, canonical) : null;
  if (!file || metadataFile && !metadata) {
    invalidateJobRunIndex(home);
    throw preparing("indexed run needs reindexing");
  }
  let st, meta = stored.meta;
  try {
    st = statSync4(file, { bigint: true });
    let metaSignature;
    if (metadata) {
      const ms = statSync4(metadata, { bigint: true });
      metaSignature = fileSignature(ms);
      const raw = readJsonSnapshot(metadata, { file: metadata, stat: ms }).value;
      if (!isRecord(raw)) return [];
      meta = raw;
    }
    if (!st.isFile() || safeFile(root, stored.file, canonical) !== file || realpathSync2.native(root) !== canonical || fileSignature(statSync4(file, { bigint: true })) !== fileSignature(st) || metadata && (safeFile(root, metadataFile, canonical) !== metadata || fileSignature(statSync4(metadata, { bigint: true })) !== metaSignature)) throw preparing("indexed files changing");
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    if (error instanceof BridgeError) throw error;
    throw preparing("indexed files changing");
  }
  const expected = /^(claude|codex|opencode|antigravity|muse)-(?:job|ask)-([\w-]+)$/.exec(ref);
  if (metadata ? meta.job !== ref : Object.keys(meta).length ? meta.job !== ref : !expected || !stored.name.endsWith(`-${expected[1]}-${expected[2]}`)) return [];
  if (meta.jobStartedAt === void 0 && (stored.legacyCandidates?.filter((candidate) => existsSync3(candidate.file)).length ?? 0) > 1) return [];
  if (meta.jobStartedAt !== void 0 && Number.isFinite(startedAt) && meta.jobStartedAt !== startedAt) return [];
  return [{ ...stored, file, meta, signature: fileSignature(st), size: Number(st.size), updatedAt: fileTimeMs(st.mtimeMs, st.mtimeNs) }];
}
function legacyJobRunAmbiguous(home, ref) {
  const stored = value(home, HEAD, ref);
  if (stored?.meta.jobStartedAt !== void 0) return false;
  return (stored?.legacyCandidates?.filter((candidate) => existsSync3(candidate.file)).length ?? 0) > 1;
}

// src/core/run-archive.ts
var DEFAULT_ARCHIVE_AGE_MS = 30 * 24 * 60 * 60 * 1e3;
var ARCHIVE_AGE_ENV = "AGENT_BRIDGE_ARCHIVE_AGE_MS";
var FINISHED_RUN = /^\d\d:\d\d:\d\d finished after \d+s · [^\r\n]+$/;
function finishedRunLine(text) {
  const last = text.trimEnd().split("\n").at(-1) ?? "";
  return FINISHED_RUN.test(last) ? last : null;
}
function archiveRun(log) {
  if (!finishedRunLine(readRunLogPreview(log))) return;
  const home = dirname3(dirname3(log));
  const dir = join5(log, "..", "archive");
  mkdirSync3(dir, { recursive: true, mode: 448 });
  const target = join5(dir, basename4(log));
  if (existsSync4(target)) throw new Error(`run archive already exists: ${target}`);
  const meta = log.replace(/\.log$/, ".json");
  const archivedMeta = target.replace(/\.log$/, ".json");
  if (existsSync4(meta)) {
    if (existsSync4(archivedMeta)) throw new Error(`run metadata archive already exists: ${archivedMeta}`);
    copyFileSync(meta, archivedMeta);
  }
  renameSync2(log, target);
  try {
    if (existsSync4(meta)) renameSync2(meta, archivedMeta);
  } finally {
    if (existsSync4(join5(home, "bridge.db"))) {
      try {
        releasingMetadata(home, () => {
          try {
            indexRunFile(home, target, archivedMeta);
          } catch {
            invalidateJobRunIndex(home);
          }
        });
      } catch {
      }
    }
  }
}
function runLogFiles(home) {
  const dir = join5(home, "runs");
  return [dir, join5(dir, "archive")].flatMap((root) => existsSync4(root) ? readdirSync4(root).filter((f) => /\.log(?:-\d+-[\w-]+)?$/.test(f)).map((f) => join5(root, f)) : []);
}
function runFileName(path) {
  return basename4(path).replace(/(\.log)-\d+-[\w-]+$/, "$1");
}
function archiveOldRuns(home, now = Date.now()) {
  const age = retentionLimit(ARCHIVE_AGE_ENV, DEFAULT_ARCHIVE_AGE_MS);
  if (!age) return 0;
  let count = 0;
  for (const file of runLogFiles(home).filter((p) => !p.includes(`${join5("runs", "archive")}`))) {
    if (statSync5(file).mtimeMs < now - age && finishedRunLine(readRunLogPreview(file))) {
      archiveRun(file);
      count++;
    }
  }
  return count;
}

// src/core/finished-run-bundles.ts
var RUN_LOG = /\.log(?:-\d+-[\w-]+)?$/;
var REVISION = ["finished-runs-revision", "revision"];
var FAILURES = "finished-run-pack-failures";
var runName = (log) => basename5(log).replace(RUN_LOG, "");
function bumpRevision(db) {
  db.prepare(`INSERT INTO bridge_metadata VALUES (?,?,'1',?) ON CONFLICT(domain,key)
  DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT),updated_at=excluded.updated_at`).run(REVISION[0], REVISION[1], Date.now());
}
function upsertRun(home, db, key, value2) {
  generation2++;
  const coldMeta = String(value2.file).replace(RUN_LOG, ".json");
  value2 = { ...value2, metadataFile: value2.metadataFile ? coldMeta : void 0 };
  db.prepare("INSERT INTO bridge_metadata VALUES ('finished-runs',?,?,?) ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(key, JSON.stringify(value2), Date.now());
  bumpRevision(db);
  indexJobRun(home, value2);
}
function packFinishedRuns(home, logs) {
  try {
    let packed = 0;
    for (const log of logs) {
      physicalMetadataPath(log);
      if (!finishedRunLine(readRunLogPreview(log))) continue;
      const stat = lstatSync3(log), metaPath = log.replace(RUN_LOG, ".json"), files = [];
      let meta = {};
      if (existsSync5(metaPath)) {
        physicalMetadataPath(metaPath);
        try {
          meta = JSON.parse(readFileSync3(metaPath, "utf8"));
        } catch {
        }
        files.push(metaPath);
      }
      files.push(log);
      const source = relative3(home, log).replace(/\\/g, "/"), key = runName(log);
      const value2 = {
        name: key,
        updatedAt: stat.mtimeMs,
        size: stat.size,
        signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
        archived: true,
        meta,
        metadataFile: existsSync5(metaPath) && isRecord(meta) ? metaPath : void 0
      };
      retainMetadataFiles(home, files, (db2, path, _raw, cold) => {
        if (path === source) upsertRun(home, db2, key, { ...value2, file: cold, bundleSource: source });
      });
      const db = metadataDb(home);
      if (!db.prepare("SELECT 1 FROM bridge_metadata WHERE domain='finished-runs' AND key=?").get(key)) {
        const imported2 = db.prepare("SELECT cold_path FROM bridge_imports WHERE path=?").get(source);
        if (!imported2) throw new Error("Completed run lacks verified retention evidence");
        db.exec("BEGIN IMMEDIATE");
        try {
          upsertRun(home, db, key, { ...value2, file: String(imported2.cold_path), bundleSource: source });
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }
      packed++;
    }
    return packed;
  } catch (error) {
    invalidateJobRunIndex(home);
    throw error;
  }
}
var cache = /* @__PURE__ */ new Map();
var generation2 = 0;
var RECHECK_MS = 2e3;
function toRecord(key, value2) {
  try {
    const v = JSON.parse(value2);
    const file = String(v.file), metadataFile = file.replace(RUN_LOG, ".json");
    return {
      name: key,
      file,
      updatedAt: Number(v.updatedAt),
      size: Number(v.size),
      signature: String(v.signature),
      archived: true,
      packed: true,
      meta: isRecord(v.meta) ? v.meta : {},
      metadataFile: isRecord(v.meta) && existsSync5(metadataFile) ? metadataFile : void 0
    };
  } catch {
    return null;
  }
}
var copy = (record) => ({ ...record, meta: structuredClone(record.meta) });
function fileIdentity(file) {
  return [file, `${file}-wal`].map((path) => {
    try {
      const s = statSync6(path);
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return "-";
    }
  }).join("/");
}
function packedRunRecords(home, names) {
  const file = join6(home, DB_FILE_NAME), saved = cache.get(file);
  const pick = (records) => names ? [...names].flatMap((name) => {
    const r = records.get(name);
    return r ? [copy(r)] : [];
  }) : [...records.values()].map(copy);
  if (!existsSync5(file)) return [];
  const files = fileIdentity(file);
  if (saved && saved.generation === generation2 && (saved.files === files || Date.now() - saved.checkedAt < RECHECK_MS)) return pick(saved.records);
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
      Object.assign(saved, { files, checkedAt: Date.now(), generation: generation2 });
      return pick(saved.records);
    }
    if (names && names.size <= 64) {
      const keys2 = [...names];
      const rows2 = db.prepare(`SELECT key,value FROM bridge_metadata WHERE domain='finished-runs' AND key IN (${keys2.map(() => "?").join(",")})`).all(...keys2);
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
    cache.set(file, { signature, files, checkedAt: Date.now(), generation: generation2, records });
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    return pick(records);
  } catch (error) {
    if (saved) return pick(saved.records);
    if (isSqliteBusy(error)) return [];
    throw error;
  } finally {
    db?.close();
  }
}
function archivedLogs(home) {
  const dir = join6(home, "runs", "archive");
  return existsSync5(dir) ? readdirSync5(dir).filter((name) => RUN_LOG.test(name)).map((name) => join6(dir, name)) : [];
}
function recoverPackedRuns(home, limit = 100) {
  if (!existsSync5(join6(home, DB_FILE_NAME))) return 0;
  const db = metadataDb(home);
  let recovered = 0;
  for (const row2 of db.prepare("SELECT path,cold_path FROM bridge_imports WHERE path LIKE 'runs/%'").all()) {
    const source = String(row2.path);
    if (!RUN_LOG.test(source)) continue;
    const key = runName(source), cold = String(row2.cold_path);
    if (db.prepare("SELECT 1 FROM bridge_metadata WHERE domain='finished-runs' AND key=?").get(key)) continue;
    if (!existsSync5(cold) || existsSync5(join6(home, source))) continue;
    physicalMetadataPath(cold);
    const stat = lstatSync3(cold), metaCold = cold.replace(RUN_LOG, ".json");
    let meta = {};
    if (existsSync5(metaCold)) {
      try {
        meta = JSON.parse(readFileSync3(metaCold, "utf8"));
      } catch {
      }
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      upsertRun(home, db, key, {
        name: key,
        file: cold,
        bundleSource: source,
        updatedAt: stat.mtimeMs,
        size: stat.size,
        signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
        archived: true,
        meta,
        recovered: true,
        metadataFile: existsSync5(metaCold) && isRecord(meta) ? metaCold : void 0
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      invalidateJobRunIndex(home);
      throw error;
    }
    if (++recovered >= limit) break;
  }
  return recovered;
}
function packArchivedRuns(home, logs, batch = 100, onFailure) {
  const candidates = logs ?? archivedLogs(home);
  if (!candidates.length && !existsSync5(join6(home, DB_FILE_NAME))) return 0;
  recoverPackedRuns(home);
  if (!candidates.length) return 0;
  const db = metadataDb(home);
  const failed = new Map(db.prepare("SELECT key,value FROM bridge_metadata WHERE domain=?").all(FAILURES).map((row2) => [String(row2.key), String(row2.value)]));
  let packed = 0, attempted = 0;
  for (const log of candidates) {
    if (attempted >= batch) break;
    const source = relative3(home, log).replace(/\\/g, "/");
    let signature;
    try {
      const stat = lstatSync3(log);
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

export {
  readRunLogPreview,
  packArchivedRuns,
  runnerStatePath,
  runnerSpecPath,
  legacyRunnerPeers,
  readRunnerStateRecord,
  writeRunnerStateRecord,
  readPendingRunnerSpec,
  publishRunnerSpec,
  takeRunnerSpec,
  importRunnerFiles,
  runnerFilesImported,
  RUNS_DIR_NAME,
  startRunFeedReady,
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
  JOB_INDEX_WAIT_MS,
  jobRunIndexReady,
  startBrokerJobRunIndex,
  stopJobRunBackfill,
  waitForJobRunIndex,
  indexedJobRun,
  legacyJobRunAmbiguous,
  DEFAULT_ARCHIVE_AGE_MS,
  ARCHIVE_AGE_ENV,
  finishedRunLine,
  runLogFiles,
  runFileName,
  archiveOldRuns
};
