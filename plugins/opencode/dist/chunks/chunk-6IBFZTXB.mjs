import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  fileSignature,
  isRecord,
  mergeStoreFields,
  readJsonStore,
  refreshStorePeerIdentities,
  retentionLimit,
  storageLease,
  writeJsonStore
} from "./chunk-ZI3EJK3N.mjs";

// src/core/run-archive.ts
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";

// src/core/run-log-preview.ts
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
var WINDOW_BYTES = 32 * 1024;
function readRunLogPreview(file, expectedSignature) {
  const fd = openSync(file, "r");
  try {
    const witnessed = fstatSync(fd);
    if (!witnessed.isFile() || expectedSignature !== void 0 && fileSignature(witnessed) !== expectedSignature)
      throw new Error("run log changed before its preview read");
    const size = witnessed.size;
    const read = (position, length) => {
      const buffer = Buffer.alloc(length);
      const count = readSync(fd, buffer, 0, length, position);
      return buffer.subarray(0, count).toString("utf8");
    };
    if (size <= WINDOW_BYTES * 2) return read(0, size);
    const head = read(0, WINDOW_BYTES), tail = read(size - WINDOW_BYTES, WINDOW_BYTES);
    const headEnd = head.lastIndexOf("\n"), tailStart = tail.indexOf("\n");
    return `${headEnd < 0 ? "" : head.slice(0, headEnd + 1)}[... retained log ...]
${tailStart < 0 ? "" : tail.slice(tailStart + 1)}`;
  } finally {
    closeSync(fd);
  }
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
  const dir = join(log, "..", "archive");
  mkdirSync(dir, { recursive: true, mode: 448 });
  const target = join(dir, basename(log));
  if (existsSync(target)) throw new Error(`run archive already exists: ${target}`);
  const meta = log.replace(/\.log$/, ".json");
  const archivedMeta = target.replace(/\.log$/, ".json");
  if (existsSync(meta)) {
    if (existsSync(archivedMeta)) throw new Error(`run metadata archive already exists: ${archivedMeta}`);
    copyFileSync(meta, archivedMeta);
  }
  renameSync(log, target);
  if (existsSync(meta)) renameSync(meta, archivedMeta);
}
function runLogFiles(home) {
  const dir = join(home, "runs");
  return [dir, join(dir, "archive")].flatMap((root) => existsSync(root) ? readdirSync(root).filter((f) => /\.log(?:-\d+-[\w-]+)?$/.test(f)).map((f) => join(root, f)) : []);
}
function runFileName(path) {
  return basename(path).replace(/(\.log)-\d+-[\w-]+$/, "$1");
}
function archiveOldRuns(home, now = Date.now()) {
  const age = retentionLimit(ARCHIVE_AGE_ENV, DEFAULT_ARCHIVE_AGE_MS);
  if (!age) return 0;
  let count = 0;
  for (const file of runLogFiles(home).filter((p) => !p.includes(`${join("runs", "archive")}`))) {
    if (statSync(file).mtimeMs < now - age && finishedRunLine(readRunLogPreview(file))) {
      archiveRun(file);
      count++;
    }
  }
  return count;
}

// src/core/runfeed.ts
import { appendFileSync, mkdirSync as mkdirSync2, readFileSync, readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { join as join2 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
var RUNS_DIR_NAME = "runs";
var HEARTBEAT_MS = 6e4;
var KEEP_RUN_LOGS = 50;
var STALE_RUN_MS = 15e4;
function runMetaPath(logPath) {
  return logPath.replace(/\.log$/, ".json");
}
var CONTINUATION = "         ";
function stamp(t) {
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
      if (Date.now() - statSync2(path).mtimeMs <= STALE_RUN_MS && !finishedRunLine(readFileSync(path, "utf8"))) continue;
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
    const [first, ...rest] = line.replace(/\r/g, "").split("\n");
    const body = [first, ...rest.map((l) => `${CONTINUATION}${l}`)].join("\n");
    try {
      appendFileSync(logPath, `${stamp(now())} ${body}
`);
    } catch {
    }
  };
  let meta = { ...opts.meta };
  const writeMeta = (required = false) => {
    try {
      const path = runMetaPath(logPath);
      const previous = readJsonStore(path);
      writeJsonStore(path, mergeStoreFields(isRecord(previous) ? previous : {}, { ...meta }), previous);
    } catch (err) {
      if (required) throw err;
      process.stderr.write(`could not save run metadata: ${String(err)}
`);
    }
  };
  try {
    mkdirSync2(dir, { recursive: true });
    writeMeta(opts.requireMetadata);
  } catch (error) {
    release();
    throw error;
  }
  write(opts.header);
  pruneOldLogs(dir);
  const started = now();
  let lastStep = "starting";
  let lastAt = started;
  const emit = (m) => {
    write(m);
    opts.forward?.(m);
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
      opts.forward?.(m);
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

export {
  readRunLogPreview,
  DEFAULT_ARCHIVE_AGE_MS,
  ARCHIVE_AGE_ENV,
  finishedRunLine,
  runLogFiles,
  runFileName,
  archiveOldRuns,
  RUNS_DIR_NAME,
  startRunFeedReady
};
