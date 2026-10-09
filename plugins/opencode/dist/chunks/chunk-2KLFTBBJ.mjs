import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RUNS_DIR_NAME
} from "./chunk-ETHEYCLK.mjs";
import {
  safeFile
} from "./chunk-CUZHUOFY.mjs";
import {
  assertWritableStore,
  backupPath,
  cloneJson,
  fileSignature,
  indexedJobProjectionCurrent,
  isRecord,
  metadataFileLease,
  readIndexedJobs,
  readJsonSnapshot,
  readJsonStore,
  storeJobRecords,
  writeJsonStore
} from "./chunk-EVPBD2NK.mjs";
import {
  JOBS_FILE
} from "./chunk-7EOIPV3B.mjs";

// src/core/job-archive.ts
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
function readArchivedJobs(path) {
  return cloneJson(readArchivedJobSnapshot(path).jobs);
}
function readArchivedJobSnapshot(path, selection = {}) {
  return readIndexedJobs(path, selection);
}
function* readArchivedJobSteps(path, responsive = false, selection = {}) {
  let canonical;
  try {
    canonical = realpathSync.native(dirname(path));
  } catch {
  }
  if (responsive) yield;
  if (canonical && realpathSync.native(dirname(path)) !== canonical) throw new Error("job archive ancestor changed during traversal; data kept unchanged");
  return readArchivedJobSnapshot(path, selection);
}
function archiveJobs(path, jobs) {
  return storeJobRecords(path, jobs, true);
}

// src/core/run-history.ts
import { readFile } from "node:fs/promises";
import { lstatSync, readdirSync, realpathSync as realpathSync2, statSync } from "node:fs";
import { dirname as dirname2, isAbsolute, join, relative, sep } from "node:path";

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
      await new Promise((resolve) => setImmediate(resolve));
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
  const root = join(home, RUNS_DIR_NAME);
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync2.native(root);
  } catch {
    return [];
  }
  const warmWitness = responsive ? captureWarmRunRoot(root, canonicalRoot) : void 0;
  const records = /* @__PURE__ */ new Map();
  const signatures = [];
  let complete = !responsive || Boolean(warmWitness), metadataBytes = 0;
  const directories = [];
  for (const archived of [true, false]) {
    const dir = archived ? join(root, "archive") : root;
    let canonicalDir;
    try {
      canonicalDir = realpathSync2.native(dir);
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
          return actual ? { file: actual, st: statSync(actual) } : null;
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
      if (warmWitness && !captureWarmRunParents(warmWitness, dirname2(record.file))) complete = false;
      signatures.push(`${archived}:${name}:${record.file}:${fileSignature(record.st)}`);
      if (extension === ".json") metadataBytes += record.st.size;
      selected.push({ name, original, ...record });
    }
    directories.push({ archived, files: selected });
  }
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
    const alias = lstatSync(root), physical = lstatSync(canonicalRoot);
    if (!alias.isDirectory() && !alias.isSymbolicLink() || !physical.isDirectory() || physical.isSymbolicLink() || realpathSync2.native(root) !== canonicalRoot) return void 0;
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
      const st = lstatSync(at);
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
    const alias = lstatSync(witness.root);
    if (!sameDirectory(alias, witness.alias) || realpathSync2.native(witness.root) !== witness.canonicalRoot) return false;
    for (const path of parents) {
      const identity = witness.parents.get(path);
      if (!identity) return false;
      const st = path === witness.root ? alias : lstatSync(path);
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
          const direct = lstatSync(file.file);
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
    const direct = lstatSync(file);
    return direct.isFile() && fileSignature(direct) === fileSignature(before) && safeFile(root, file, canonicalRoot) === file;
  } catch {
    return false;
  }
}
async function readRunStarts(home) {
  const root = join(home, RUNS_DIR_NAME);
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync2.native(root);
  } catch {
    return [];
  }
  const starts = /* @__PURE__ */ new Map();
  for (const archived of [true, false]) {
    let dir;
    try {
      dir = realpathSync2.native(archived ? join(root, "archive") : root);
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
            if (statSync(previous).mtimeMs > statSync(contained).mtimeMs) continue;
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
          const before = direct.isFile() ? direct : statSync(readable);
          if (!before.isFile()) return;
          const raw = await readFile(readable, "utf8");
          const after = lstatSync(readable);
          if (!after.isFile() || fileSignature(after) !== fileSignature(before)) return;
          const meta = JSON.parse(raw);
          if (!isRecord(meta) || typeof meta.job !== "string") return;
          const m = /^(\d{4})-(\d\d)-(\d\d)-(\d\d)-(\d\d)-(\d\d)-/.exec(name);
          const startedAt = m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : statSync(log).mtimeMs;
          starts.set(runName, { job: meta.job, startedAt, ...typeof meta.jobStartedAt === "number" ? { jobStartedAt: meta.jobStartedAt } : {} });
        } catch {
        }
      }));
    }
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
  const out = /* @__PURE__ */ new Map(), path = join(home, JOBS_FILE);
  if (responsive) yield;
  for (const job of readIndexedJobs(path, { ...selection, history: true }).jobs) {
    if (typeof job.name === "string" && RUN_LOG_NAME.test(job.name + ".log")) out.set(job.name, job);
  }
  if (indexedJobProjectionCurrent(path)) return out;
  let canonicalHome;
  try {
    canonicalHome = realpathSync2.native(home);
  } catch {
    return out;
  }
  const active = safeFile(home, path, canonicalHome);
  if (!active) return out;
  const st = statSync(active);
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

// src/core/ask-completion.ts
import { closeSync, constants as fsConstants, copyFileSync, fsyncSync, openSync } from "node:fs";
import { dirname as dirname3, join as join2 } from "node:path";
import { readFile as readFile2 } from "node:fs/promises";
function recordAskCompletion(home, job) {
  if (!job.name.includes("-ask-") || !["done", "failed", "cancelled"].includes(job.status)) return;
  const path = join2(home, "ask-completions", `${job.id}-${job.startedAt}.json`);
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
    const registry = readHistoryJson(join2(home, "jobs.json"));
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
      const receipt = JSON.parse(await readFile2(join2(dirname3(path), "ask-completions", `${job.id}-${job.startedAt}.json`), "utf8"));
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
      const receipt = readHistoryJson(join2(dirname3(path), "ask-completions", `${job.id}-${job.startedAt}.json`));
      const state = readHistoryJson(join2(dirname3(path), "jobs", `${job.id}.json`));
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
    const fd = openSync(backup, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
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
  readArchivedJobs,
  readArchivedJobSnapshot,
  readArchivedJobSteps,
  archiveJobs,
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
  recordAskCompletion,
  observeAskToolRecord,
  projectAskCompletions,
  reconcileAskCompletions
};
