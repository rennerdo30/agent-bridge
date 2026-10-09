import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RUNS_DIR_NAME
} from "./chunk-TQCKZODX.mjs";
import {
  safeFile
} from "./chunk-OVBYB4CB.mjs";
import {
  JSON_STORE_VERSION,
  archiveFile,
  assertStoreUpgrade,
  assertWritableStore,
  backupPath,
  isProcessIdentityAlive,
  isRecord,
  processIdentity,
  readJsonStore,
  readProcessIdentity,
  writeJsonStore
} from "./chunk-GN275QYC.mjs";
import {
  JOBS_FILE
} from "./chunk-PEBTAWO6.mjs";

// src/core/file-cache.ts
import { readFileSync, statSync } from "node:fs";
var MAX_BYTES = 32 * 1024 * 1024;
var MAX_ENTRIES = 2048;
var cache = /* @__PURE__ */ new Map();
var damaged = /* @__PURE__ */ new Map();
var bytes = 0;
function cloneJson(value) {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  if (value !== null && typeof value === "object") {
    const copied = {};
    for (const key of Object.keys(value)) {
      const item = cloneJson(value[key]);
      if (key === "__proto__") Object.defineProperty(copied, key, { value: item, writable: true, configurable: true, enumerable: true });
      else copied[key] = item;
    }
    return copied;
  }
  return value;
}
function fileSignature(st) {
  return `${st.dev}:${st.ino}:${st.birthtimeMs}:${st.ctimeMs}:${st.mtimeMs}:${st.size}`;
}
function readJsonSnapshot(file, scan) {
  if (scan && scan.file !== file) throw new Error("JSON snapshot scan belongs to another file");
  const st = scan?.stat ?? statSync(file), signature = fileSignature(st);
  const failure = damaged.get(file);
  if (failure?.signature === signature) throw failure.error;
  damaged.delete(file);
  const saved = cache.get(file);
  if (saved?.signature === signature) {
    cache.delete(file);
    cache.set(file, saved);
    return saved;
  }
  if (saved) {
    cache.delete(file);
    bytes -= saved.bytes;
  }
  let value;
  try {
    if (!scan) value = JSON.parse(readFileSync(file, "utf8"));
    else {
      const raw = readFileSync(file, "utf8");
      const after = statSync(file);
      if (!after.isFile() || fileSignature(after) !== signature)
        throw new Error("JSON snapshot identity changed during read");
      value = JSON.parse(raw);
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      damaged.set(file, { signature, error });
      if (damaged.size > 128) damaged.delete(damaged.keys().next().value);
    }
    throw error;
  }
  const next = { signature, value, bytes: st.size };
  if (st.size <= MAX_BYTES) {
    cache.set(file, next);
    bytes += st.size;
    while (bytes > MAX_BYTES || cache.size > MAX_ENTRIES) {
      const first = cache.keys().next().value;
      bytes -= cache.get(first).bytes;
      cache.delete(first);
    }
  }
  return next;
}

// src/core/run-history.ts
import { readFile } from "node:fs/promises";
import { lstatSync, readdirSync, realpathSync, statSync as statSync2 } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
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
var historyJobSnapshots = /* @__PURE__ */ new Map();
function readRunLogs(home, namesFilter) {
  const root = join(home, RUNS_DIR_NAME);
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync.native(root);
  } catch {
    return [];
  }
  const records = /* @__PURE__ */ new Map();
  const signatures = [];
  let complete = true, metadataBytes = 0;
  const directories = [];
  for (const archived of [true, false]) {
    const dir = archived ? join(root, "archive") : root;
    let canonicalDir;
    try {
      canonicalDir = realpathSync.native(dir);
    } catch {
      continue;
    }
    const rel = relative(canonicalRoot, canonicalDir);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    let entries;
    try {
      entries = readdirSync(canonicalDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const localFile = (entry) => {
      const file = join(canonicalDir, entry.name);
      try {
        const direct = lstatSync(file);
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
      const name = entry.name;
      const original = archived ? name.replace(ARCHIVE_SUFFIX, "$1") : name;
      const extension = original.endsWith(".json") ? ".json" : RUN_LOG_NAME.test(original) ? ".log" : null;
      if (!extension || namesFilter && !namesFilter.has(original.slice(0, -extension.length))) continue;
      const record = localFile(entry);
      if (!record) continue;
      signatures.push(`${archived}:${name}:${record.file}:${fileSignature(record.st)}`);
      if (extension === ".json") metadataBytes += record.st.size;
      selected.push({ name, original, ...record });
    }
    directories.push({ archived, files: selected });
  }
  const key = `${canonicalRoot}:${namesFilter ? JSON.stringify([...namesFilter].sort()) : "*"}`;
  const signature = signatures.join("\n"), saved = runLogSnapshots.get(key);
  if (saved?.signature === signature) return cloneJson(saved.records);
  for (const { archived, files } of directories) {
    const metadata = /* @__PURE__ */ new Map();
    for (const { original, file, st } of files) {
      if (!original.endsWith(".json")) continue;
      try {
        const value = readJsonSnapshot(file, { file, stat: st }).value;
        if (isRecord(value)) metadata.set(original, value);
      } catch {
        complete = false;
      }
    }
    for (const { original, file, st } of files) {
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
  const result = [...records.values()];
  runLogSnapshots.delete(key);
  if (complete && metadataBytes <= 256 * 1024 * 1024) runLogSnapshots.set(key, { signature, records: result });
  if (runLogSnapshots.size > 8) runLogSnapshots.delete(runLogSnapshots.keys().next().value);
  return cloneJson(result);
}
async function readRunStarts(home) {
  const root = join(home, RUNS_DIR_NAME);
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
      dir = realpathSync.native(archived ? join(root, "archive") : root);
    } catch {
      continue;
    }
    const rel = relative(canonicalRoot, dir);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const paths = /* @__PURE__ */ new Map();
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const original = archived ? entry.name.replace(ARCHIVE_SUFFIX, "$1") : entry.name;
      const file = join(dir, entry.name);
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
      const runName = name.slice(0, -4), file = paths.get(`${runName}.json`);
      if (!archived) starts.delete(runName);
      if (file) metadata.push({ name, runName, file, log });
    }
    for (let offset = 0; offset < metadata.length; offset += 32) {
      await Promise.all(metadata.slice(offset, offset + 32).map(async ({ name, runName, file, log }) => {
        try {
          const direct = lstatSync(file);
          const readable = direct.isFile() ? file : direct.isSymbolicLink() ? safeFile(root, file, canonicalRoot) : null;
          if (!readable) return;
          const before = direct.isFile() ? direct : statSync2(readable);
          if (!before.isFile()) return;
          const raw = await readFile(readable, "utf8");
          const after = lstatSync(readable);
          if (!after.isFile() || fileSignature(after) !== fileSignature(before)) return;
          const meta = JSON.parse(raw);
          if (!isRecord(meta) || typeof meta.job !== "string") return;
          const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(name);
          const startedAt = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : statSync2(log).mtimeMs;
          starts.set(runName, { job: meta.job, startedAt, ...typeof meta.jobStartedAt === "number" ? { jobStartedAt: meta.jobStartedAt } : {} });
        } catch {
        }
      }));
    }
  }
  return [...starts.values()];
}
function readHistoryJobs(home) {
  return new Map([...historyJobsSnapshot(home)].map(([name, job]) => [name, cloneJson(job)]));
}
function selectHistoryJobs(home, names) {
  const snapshot = historyJobsSnapshot(home), selected = /* @__PURE__ */ new Map();
  for (const name of names) {
    const job = snapshot.get(name);
    if (job) selected.set(name, cloneJson(job));
  }
  return selected;
}
function findHistoryJob(home, ref, id) {
  for (const job of historyJobsSnapshot(home).values()) {
    if (job.name === ref || job.id === id) return cloneJson(job);
  }
  return void 0;
}
function historyJobsSnapshot(home) {
  const out = /* @__PURE__ */ new Map();
  let canonicalHome;
  try {
    canonicalHome = realpathSync.native(home);
  } catch {
    return out;
  }
  const snapshots2 = [];
  const scan = (directory, accept) => {
    let canonicalDir;
    try {
      canonicalDir = realpathSync.native(directory);
    } catch {
      return;
    }
    const rel = relative(canonicalHome, canonicalDir);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
    let entries;
    try {
      entries = readdirSync(canonicalDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = entry.name;
      if (!accept(name)) continue;
      const candidate = join(canonicalDir, name);
      try {
        const direct = lstatSync(candidate);
        const file = direct.isFile() ? candidate : direct.isSymbolicLink() ? safeFile(home, candidate, canonicalHome) : null;
        if (!file) continue;
        const st = direct.isFile() ? direct : statSync2(file);
        if (!st.isFile()) continue;
        const stamp = /(?:jobs-|\.backup-|\.overflow\.json-|jobs\.json-)(\d+)/.exec(file)?.[1];
        snapshots2.push({ file, st, time: stamp ? Number(stamp) : st.mtimeMs });
      } catch {
      }
    }
  };
  scan(join(canonicalHome, "archive"), (name) => name.startsWith(`${JOBS_FILE}.`) || name.startsWith(`${JOBS_FILE}-`) || /^jobs-.*\.json$/.test(name));
  scan(canonicalHome, (name) => name.startsWith(`${JOBS_FILE}.backup-`) || name === `${JOBS_FILE}.overflow.json`);
  snapshots2.sort((a, b) => a.time - b.time || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const active = join(canonicalHome, JOBS_FILE);
  try {
    const direct = lstatSync(active);
    const file = direct.isFile() ? active : direct.isSymbolicLink() ? safeFile(home, active, canonicalHome) : null;
    if (file) {
      const st = direct.isFile() ? direct : statSync2(file);
      if (st.isFile()) snapshots2.push({ file, st, time: 0 });
    }
  } catch {
  }
  const signatures = [];
  let complete = true;
  let bytes2 = 0;
  for (const { file, st } of snapshots2) {
    signatures.push(`${file}:${fileSignature(st)}`);
    bytes2 += st.size;
  }
  const signature = signatures.join("\n"), saved = historyJobSnapshots.get(canonicalHome);
  if (saved?.signature === signature) return saved.jobs;
  for (const { file, st } of snapshots2) {
    let value;
    try {
      value = readJsonSnapshot(file, { file, stat: st }).value;
    } catch {
      complete = false;
      continue;
    }
    const jobs = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.jobs) ? value.jobs : [];
    for (const job of jobs) {
      if (!isRecord(job) || typeof job.name !== "string" || !RUN_LOG_NAME.test(`${job.name}.log`)) continue;
      out.set(job.name, { ...out.get(job.name), ...job });
    }
  }
  historyJobSnapshots.delete(canonicalHome);
  if (complete && bytes2 <= 256 * 1024 * 1024) historyJobSnapshots.set(canonicalHome, { signature, jobs: out });
  if (historyJobSnapshots.size > 4) historyJobSnapshots.delete(historyJobSnapshots.keys().next().value);
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

// src/core/job-archive.ts
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync as lstatSync2, mkdirSync, openSync, readdirSync as readdirSync2, writeFileSync } from "node:fs";
import { basename, dirname, join as join2 } from "node:path";
var snapshots = /* @__PURE__ */ new Map();
var EMPTY_SNAPSHOT = { signature: "", jobs: [] };
function physicalDirectory(dir) {
  const st = lstatSync2(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("job archive directory must be physical; data kept unchanged");
}
function physicalFile(file) {
  const st = lstatSync2(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("job archive file must be physical; data kept unchanged");
  return st;
}
function readArchivedJobs(path) {
  return cloneJson(readArchivedJobSnapshot(path).jobs);
}
function readArchivedJobSnapshot(path) {
  const dir = join2(dirname(path), "archive");
  if (!existsSync(dir)) return EMPTY_SNAPSHOT;
  physicalDirectory(dir);
  const files = [];
  const signatures = [];
  let bytes2 = 0;
  for (const file of readdirSync2(dir).sort()) {
    if (!file.startsWith(`${basename(path)}.overflow.json-`) && !/^jobs-.*\.json$/.test(file)) continue;
    const full = join2(dir, file), st = physicalFile(full);
    const stamp = /(?:^jobs-|\.overflow\.json-)(\d+)-/.exec(file)?.[1];
    signatures.push(`${file}:${fileSignature(st)}`);
    files.push({ path: full, time: stamp ? Number(stamp) : st.mtimeMs, st });
    bytes2 += st.size;
  }
  const signature = signatures.join("\n"), saved = snapshots.get(path);
  if (saved?.signature === signature) return saved;
  const jobs = /* @__PURE__ */ new Map();
  files.sort((a, b) => a.time - b.time || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const { path: file, st } of files) {
    const value = readJsonSnapshot(file, { file, stat: st }).value;
    if (!isRecord(value) || value.version !== void 0 && (!Number.isInteger(value.version) || value.version < 0 || value.version > JSON_STORE_VERSION) || !Array.isArray(value.jobs)) throw new Error(`invalid job archive: ${basename(file)}`);
    for (const job of value.jobs) if (isRecord(job) && typeof job.id === "string") {
      const prior = jobs.get(job.id);
      if (job.status === "running" && prior && prior.startedAt === job.startedAt && isRecord(prior.completionReceipt) && prior.completionReceipt.version === 1 && ["done", "failed", "cancelled"].includes(String(prior.status))) continue;
      jobs.set(job.id, job);
    }
  }
  const next = { signature, jobs: [...jobs.values()] };
  snapshots.delete(path);
  if (bytes2 <= 256 * 1024 * 1024) snapshots.set(path, next);
  if (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value);
  return next;
}
function archiveJobs(path, jobs) {
  assertStoreUpgrade(dirname(path), "json", 0, JSON_STORE_VERSION);
  const dir = join2(dirname(path), "archive");
  mkdirSync(dir, { recursive: true, mode: 448 });
  physicalDirectory(dir);
  const retained = join2(dir, "archive");
  mkdirSync(retained, { recursive: true, mode: 448 });
  physicalDirectory(retained);
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : isRecord(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const records = jobs.map(canonical).sort((a, b) => {
    const x = JSON.stringify(a), y = JSON.stringify(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const contents = JSON.stringify({ version: JSON_STORE_VERSION, jobs: records }, null, 2) + "\n";
  const digest = createHash("sha256").update(contents).digest("hex");
  const target = join2(dir, `jobs-content-${digest}.json`);
  const temp = join2(dir, `.jobs-${randomUUID()}.tmp`);
  const fd = openSync(temp, "wx", 384);
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    try {
      linkSync(temp, target);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      physicalFile(target);
      const existing = readJsonSnapshot(target).value;
      if (JSON.stringify(canonical(existing)) !== JSON.stringify(canonical({ version: JSON_STORE_VERSION, jobs: records }))) throw new Error("job archive identity conflict; active jobs retained");
    }
    if (process.platform !== "win32") {
      const directory = openSync(dir, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    archiveFile(temp);
  }
  return target;
}

// src/core/ask-completion.ts
import { closeSync as closeSync3, constants as fsConstants, copyFileSync, fsyncSync as fsyncSync3, openSync as openSync3 } from "node:fs";
import { dirname as dirname3, join as join4 } from "node:path";

// src/core/metadata-file-lease.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import { closeSync as closeSync2, fsyncSync as fsyncSync2, linkSync as linkSync2, lstatSync as lstatSync3, mkdirSync as mkdirSync2, openSync as openSync2, readFileSync as readFileSync2, readdirSync as readdirSync3, renameSync, writeFileSync as writeFileSync2 } from "node:fs";
import { basename as basename2, dirname as dirname2, join as join3, resolve } from "node:path";
var VERSION = 2;
var RETRY_MS = 20;
var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
var MARKER = /^(?:owner|claim)-v1\.(\d+)\.([A-Za-z0-9_-]+)\.([a-f0-9-]{36})\.json$/;
var busy = () => Object.assign(new Error("metadata lease has a live or unknown owner"), { code: "ELEASEBUSY" });
var exitedIdentities = /* @__PURE__ */ new Set();
var identityProbes = /* @__PURE__ */ new Set();
function nonBlockingAlive(owner) {
  if (owner.pid === process.pid) return isProcessIdentityAlive(owner.pid, owner.identity);
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return error.code === "ESRCH" ? false : void 0;
  }
  const key = `${owner.pid}:${owner.identity}`;
  if (exitedIdentities.has(key)) return false;
  if (!identityProbes.has(key)) {
    identityProbes.add(key);
    void readProcessIdentity(owner.pid).then((current) => {
      if (current !== null && current !== owner.identity) {
        if (exitedIdentities.size >= 512) exitedIdentities.delete(exitedIdentities.values().next().value);
        exitedIdentities.add(key);
      }
    }).catch(() => {
    }).finally(() => identityProbes.delete(key));
  }
  return void 0;
}
function physicalDirectory2(path) {
  const stat = lstatSync3(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw busy();
}
function physicalAncestors(path) {
  let current = resolve(path);
  for (; ; ) {
    try {
      physicalDirectory2(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname2(current);
    if (parent === current) return;
    current = parent;
  }
}
function markerName(identity, claim = false) {
  return `${claim ? "claim" : "owner"}-v1.${process.pid}.${Buffer.from(identity).toString("base64url")}.${randomUUID2()}.json`;
}
function fileIdentity(path) {
  const stat = lstatSync3(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw busy();
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}
function readOwner(path, registry) {
  try {
    const file = fileIdentity(path);
    const value = JSON.parse(readFileSync2(path, "utf8"));
    if (!isRecord(value) || value.version !== VERSION || typeof value.ownerDirectory !== "string" || !UUID.test(value.ownerDirectory)) return null;
    physicalDirectory2(registry);
    const dir = join3(registry, value.ownerDirectory);
    physicalDirectory2(dir);
    const files = readdirSync3(dir);
    if (files.length !== 1) return null;
    const marker = files[0];
    const match = MARKER.exec(marker);
    const pid = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(pid) || pid <= 0 || !UUID.test(match[3])) return null;
    const identity = Buffer.from(match[2], "base64url").toString("utf8");
    if (!identity || Buffer.from(identity).toString("base64url") !== match[2]) return null;
    if (fileIdentity(join3(dir, marker)) !== file || fileIdentity(path) !== file) return null;
    return { dir, marker, pid, identity, file };
  } catch {
    return null;
  }
}
function archiveOwned(path, registry, owner, identity) {
  const current = readOwner(path, registry);
  if (!current || current.file !== owner.file || current.marker !== owner.marker || current.dir !== owner.dir) throw busy();
  const claim = markerName(identity, true);
  renameSync(join3(owner.dir, owner.marker), join3(owner.dir, claim));
  if (fileIdentity(path) !== owner.file) throw busy();
  renameSync(path, join3(owner.dir, `released-v2.${randomUUID2()}.json`));
  archiveFile(owner.dir);
}
function metadataFileLease(path, waitMs = 0, nonBlockingRecovery = false) {
  const identity = processIdentity(process.pid);
  if (!identity) throw busy();
  const parent = dirname2(path);
  physicalAncestors(parent);
  mkdirSync2(parent, { recursive: true, mode: 448 });
  physicalDirectory2(parent);
  const namespace = join3(parent, ".metadata-leases");
  mkdirSync2(namespace, { recursive: true, mode: 448 });
  physicalDirectory2(namespace);
  const registry = join3(namespace, createHash2("sha256").update(basename2(path)).digest("hex"));
  mkdirSync2(registry, { recursive: true, mode: 448 });
  physicalDirectory2(registry);
  const archive = join3(registry, "archive");
  mkdirSync2(archive, { recursive: true, mode: 448 });
  physicalDirectory2(archive);
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let staged;
  try {
    for (; ; ) {
      let absent = false;
      try {
        lstatSync3(path);
      } catch (error) {
        if (error.code === "ENOENT") absent = true;
        else throw error;
      }
      if (absent) {
        if (!staged) {
          const ownerDirectory = randomUUID2();
          const dir = join3(registry, ownerDirectory);
          mkdirSync2(dir, { mode: 448 });
          const marker = markerName(identity);
          const source = join3(dir, marker);
          try {
            const fd = openSync2(source, "wx", 384);
            try {
              writeFileSync2(fd, `${JSON.stringify({ version: VERSION, pid: process.pid, identity, nonce: marker, ownerDirectory, createdAt: Date.now() })}
`);
              fsyncSync2(fd);
            } finally {
              closeSync2(fd);
            }
            staged = { dir, marker, pid: process.pid, identity, file: fileIdentity(source) };
          } catch (error) {
            archiveFile(dir);
            throw error;
          }
        }
        try {
          linkSync2(join3(staged.dir, staged.marker), path);
          const acquired = staged;
          staged = void 0;
          let released = false;
          return () => {
            if (released) return;
            const owner2 = readOwner(path, registry);
            if (!owner2 || owner2.file !== acquired.file || owner2.dir !== acquired.dir || owner2.marker !== acquired.marker) return;
            archiveOwned(path, registry, owner2, identity);
            released = true;
          };
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      const owner = readOwner(path, registry);
      if (owner && (nonBlockingRecovery ? nonBlockingAlive(owner) : isProcessIdentityAlive(owner.pid, owner.identity)) === false) {
        try {
          archiveOwned(path, registry, owner, identity);
          continue;
        } catch {
        }
      }
      if (Date.now() >= deadline) throw busy();
      Atomics.wait(pause, 0, 0, RETRY_MS);
    }
  } finally {
    if (staged) archiveFile(staged.dir);
  }
}

// src/core/ask-completion.ts
import { readFile as readFile2 } from "node:fs/promises";
function recordAskCompletion(home, job) {
  if (!job.name.includes("-ask-") || !["done", "failed", "cancelled"].includes(job.status)) return;
  const path = join4(home, "ask-completions", `${job.id}-${job.startedAt}.json`);
  writeJsonStore(path, { receiptVersion: 1, ...job }, readHistoryJson(path));
}
function observeAskToolRecord(db, home, source, generation, raw, at, offset) {
  if (offset === void 0) {
    for (const line of raw.toString("utf8").split("\n")) observeAskRow(db, home, source, generation, line, at);
    return;
  }
  const key = `ask-jsonl-fragment:${source}:${generation}`;
  const saved = JSON.parse(String(db.prepare("SELECT cursor FROM history_cursors WHERE source=?").get(key)?.cursor ?? "{}"));
  const lines = ((saved.after === offset ? saved.tail ?? "" : "") + raw.toString("utf8")).split("\n");
  let tail = lines.pop() ?? "";
  for (const line of lines) observeAskRow(db, home, source, generation, line, at);
  try {
    JSON.parse(tail);
    observeAskRow(db, home, source, generation, tail, at);
    tail = "";
  } catch {
  }
  if (Buffer.byteLength(tail) > 1024 * 1024) tail = "";
  db.prepare("INSERT INTO history_cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(key, JSON.stringify({ after: offset + raw.length, tail }));
}
function observeAskRow(db, home, source, generation, line, at) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(row) || !isRecord(row.message) || !Array.isArray(row.message.content)) return;
  const timestamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : row.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) at = timestamp;
  for (const block of row.message.content) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      const target = /(?:^|__)ask_(codex|claude|opencode|antigravity)$/.exec(block.name)?.[1];
      if (target) db.prepare("INSERT INTO history_cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(`ask-tool:${source}:${generation}:${block.id}`, JSON.stringify({ target, at }));
    }
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    const call = db.prepare("SELECT cursor FROM history_cursors WHERE source=?").get(`ask-tool:${source}:${generation}:${block.tool_use_id}`);
    if (!call) continue;
    const paired = JSON.parse(String(call.cursor));
    let text = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.filter(isRecord).map((item) => typeof item.text === "string" ? item.text : "").join("\n") : "";
    let failed = block.is_error === true;
    try {
      const wrapped = JSON.parse(text);
      if (isRecord(wrapped) && Array.isArray(wrapped.content)) {
        text = wrapped.content.filter(isRecord).map((item) => item.text ?? "").join("\n");
        failed ||= wrapped.isError === true;
      }
    } catch {
    }
    const match = /^Job: ((codex|claude|opencode|antigravity)-ask-([\w-]+))\r?\n/.exec(text);
    if (!match || match[2] !== paired.target) continue;
    const registry = readHistoryJson(join4(home, "jobs.json"));
    const jobs = Array.isArray(registry) ? registry : isRecord(registry) && Array.isArray(registry.jobs) ? registry.jobs : [];
    const job = jobs.find((job2) => isRecord(job2) && job2.name === match[1]);
    if (!isRecord(job) || typeof job.startedAt !== "number" || job.startedAt < paired.at || job.startedAt > at) continue;
    recordAskCompletion(home, { id: match[3], name: match[1], startedAt: job.startedAt, finishedAt: at, status: failed ? "failed" : "done" });
  }
}
async function projectAskCompletions(path, jobs) {
  const result = [];
  for (const job of jobs) {
    if (job.status !== "running" || typeof job.id !== "string" || !/^[\w-]+$/.test(job.id) || typeof job.name !== "string" || !job.name.includes("-ask-")) {
      result.push(job);
      continue;
    }
    try {
      const receipt = JSON.parse(await readFile2(join4(dirname3(path), "ask-completions", `${job.id}-${job.startedAt}.json`), "utf8"));
      result.push(receipt.receiptVersion === 1 && receipt.name === job.name && receipt.startedAt === job.startedAt && ["done", "failed", "cancelled"].includes(receipt.status) && receipt.finishedAt >= Number(job.startedAt) ? { ...job, status: receipt.status, finishedAt: receipt.finishedAt, host: null } : job);
    } catch {
      result.push(job);
    }
  }
  return result;
}
function reconcileAskCompletions(path) {
  const release = metadataFileLease(`${path}.lock`, 0, true);
  try {
    const previous = readJsonStore(path, void 0, (value) => Array.isArray(value) || isRecord(value));
    assertWritableStore(previous);
    const entries = Array.isArray(previous) ? previous : isRecord(previous) && Array.isArray(previous.jobs) ? previous.jobs : [];
    const originals = [];
    const jobs = entries.map((job) => {
      if (!isRecord(job) || typeof job.id !== "string" || !/^[\w-]+$/.test(job.id) || typeof job.name !== "string" || !job.name.includes("-ask-") || job.status !== "running" || typeof job.startedAt !== "number") return job;
      const receipt = readHistoryJson(join4(dirname3(path), "ask-completions", `${job.id}-${job.startedAt}.json`));
      const state = readHistoryJson(join4(dirname3(path), "jobs", `${job.id}.json`));
      const final = isRecord(receipt) && receipt.receiptVersion === 1 && receipt.name === job.name && receipt.startedAt === job.startedAt ? receipt : isRecord(state) && state.startedAt === job.startedAt ? state : void 0;
      if (!final || !["done", "failed", "cancelled"].includes(String(final.status)) || typeof (final.finishedAt ?? final.updatedAt) !== "number" || Number(final.finishedAt ?? final.updatedAt) < job.startedAt) return job;
      originals.push(job);
      return {
        ...job,
        status: final.status,
        finishedAt: final.finishedAt ?? final.updatedAt,
        host: null,
        completionReceipt: { version: 1, startedAt: job.startedAt, status: final.status }
      };
    });
    if (!originals.length) return 0;
    const backup = backupPath(path);
    copyFileSync(path, backup, fsConstants.COPYFILE_EXCL);
    const fd = openSync3(backup, "r+");
    try {
      fsyncSync3(fd);
    } finally {
      closeSync3(fd);
    }
    archiveJobs(path, originals);
    const completedIds = new Set(originals.map((job) => job.id));
    archiveJobs(path, jobs.filter((job) => isRecord(job) && completedIds.has(job.id)));
    writeJsonStore(path, { ...isRecord(previous) ? previous : {}, jobs }, previous);
    return originals.length;
  } finally {
    release();
  }
}

export {
  cloneJson,
  readJsonSnapshot,
  DEFAULT_RUN_PAGE_SIZE,
  MAX_RUN_PAGE_SIZE,
  readHistoryJson,
  readRunLogs,
  readRunStarts,
  readHistoryJobs,
  selectHistoryJobs,
  findHistoryJob,
  pageRuns,
  readArchivedJobs,
  readArchivedJobSnapshot,
  archiveJobs,
  metadataFileLease,
  recordAskCompletion,
  observeAskToolRecord,
  projectAskCompletions,
  reconcileAskCompletions
};
