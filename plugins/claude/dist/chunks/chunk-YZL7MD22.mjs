import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  isRecord,
  mergeStoreFields,
  readJsonStore,
  retentionLimit,
  storageLease,
  writeJsonStore
} from "./chunk-4BCYRJ3A.mjs";

// src/core/run-archive.ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";
var DEFAULT_ARCHIVE_AGE_MS = 30 * 24 * 60 * 60 * 1e3;
var ARCHIVE_AGE_ENV = "AGENT_BRIDGE_ARCHIVE_AGE_MS";
var FINISHED_RUN = /^\d\d:\d\d:\d\d finished after \d+s · /m;
function archiveRun(log) {
  if (!FINISHED_RUN.test(readFileSync(log, "utf8"))) return;
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
    if (statSync(file).mtimeMs < now - age && FINISHED_RUN.test(readFileSync(file, "utf8"))) {
      archiveRun(file);
      count++;
    }
  }
  return count;
}

// src/core/runfeed.ts
import { appendFileSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { join as join2 } from "node:path";
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
      if (Date.now() - statSync2(path).mtimeMs <= STALE_RUN_MS && !/^\d\d:\d\d:\d\d finished after \d+s · /m.test(readFileSync2(path, "utf8"))) continue;
      archiveRun(path);
    }
  } catch (err) {
    process.stderr.write(`could not archive run logs: ${String(err)}
`);
  }
}
function startRunFeed(opts) {
  const now = opts.now ?? Date.now;
  const release = storageLease(opts.home);
  const dir = join2(opts.home, RUNS_DIR_NAME);
  mkdirSync2(dir, { recursive: true });
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
  const writeMeta = () => {
    try {
      const path = runMetaPath(logPath);
      const previous = readJsonStore(path);
      writeJsonStore(path, mergeStoreFields(isRecord(previous) ? previous : {}, { ...meta }), previous);
    } catch (err) {
      process.stderr.write(`could not save run metadata: ${String(err)}
`);
    }
  };
  writeMeta();
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
  DEFAULT_ARCHIVE_AGE_MS,
  ARCHIVE_AGE_ENV,
  runLogFiles,
  runFileName,
  archiveOldRuns,
  RUNS_DIR_NAME,
  startRunFeed
};
