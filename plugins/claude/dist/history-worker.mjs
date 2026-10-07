import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  ConversationIngestor
} from "./chunks/chunk-HQFTDE63.mjs";
import "./chunks/chunk-55UBJKRO.mjs";
import "./chunks/chunk-QN2BR77F.mjs";
import "./chunks/chunk-CV444Y3C.mjs";
import {
  HISTORY_TICK_MS,
  HistoryIndex
} from "./chunks/chunk-BMYN33JS.mjs";
import "./chunks/chunk-UPRSZQYD.mjs";
import "./chunks/chunk-JIZVJD5Z.mjs";
import "./chunks/chunk-JSAVG5BJ.mjs";
import {
  transcriptPaths
} from "./chunks/chunk-H2JCI6FF.mjs";
import {
  configureSqlite
} from "./chunks/chunk-AGX4O262.mjs";
import "./chunks/chunk-FVHLG3WF.mjs";
import "./chunks/chunk-VNX2WF5E.mjs";
import "./chunks/chunk-TPCM6ZR4.mjs";
import "./chunks/chunk-FDMEMG4Z.mjs";
import "./chunks/chunk-SKREW3F6.mjs";
import "./chunks/chunk-6PRX5EOQ.mjs";
import "./chunks/chunk-HHAVWD7J.mjs";

// src/core/history-worker.ts
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { watch } from "node:fs";
import { join } from "node:path";

// src/core/idle-backoff.ts
var IdleBackoff = class {
  delay = 2e3;
  next(active) {
    if (active) return this.wake();
    const delay = this.delay;
    this.delay = Math.min(3e4, delay * 2);
    return delay;
  }
  wake() {
    this.delay = 2e3;
    return 100;
  }
};

// src/core/history-worker.ts
var db = new DatabaseSync(workerData.file, { timeout: 50 });
configureSqlite(db, 50);
var paths = workerData.paths ?? transcriptPaths();
var index = new HistoryIndex(db, workerData.home, paths);
var ingest = new ConversationIngestor(db, workerData.home, paths, (path) => {
  index.notify(path);
  wake();
});
var backoff = new IdleBackoff();
var watchers = /* @__PURE__ */ new Map();
var timer = null;
var scheduledAt = 0;
var stopped = false;
function wake() {
  if (!stopped) schedule(backoff.wake());
}
function watchHome() {
  for (const dir of ["", "runs", "context-events", "approvals", "archive"]) {
    const root = join(workerData.home, dir);
    if (watchers.has(root)) continue;
    try {
      const watcher = watch(root, { recursive: Boolean(dir), persistent: false }, (_, name) => {
        if (!dir && !/^(jobs\.json|runs|context-events|approvals|archive)$/.test(String(name))) return;
        if (name) index.notify(join(root, String(name)));
        ingest.notifyJobs();
        wake();
      });
      watcher.on("error", () => {
        watcher.close();
        watchers.delete(root);
      });
      watchers.set(root, watcher);
    } catch {
    }
  }
}
function tick(reset = false, force = false) {
  watchHome();
  if (reset) index.reset();
  const result = index.tick(!force);
  const work = result.work + ingest.tick(force);
  return { work, discovering: result.discovering || ingest.discovering };
}
function schedule(delay = HISTORY_TICK_MS) {
  const due = Date.now() + delay;
  if (timer && scheduledAt <= due) return;
  if (timer) clearTimeout(timer);
  scheduledAt = due;
  timer = setTimeout(() => {
    timer = null;
    try {
      const result = tick();
      schedule(backoff.next(Boolean(result.work || result.discovering)));
    } catch (err) {
      parentPort?.postMessage({ error: String(err) });
      schedule();
    }
  }, delay);
}
parentPort?.on("message", (message) => {
  if (message.stop) {
    stopped = true;
    if (timer) clearTimeout(timer);
    index.close();
    ingest.close();
    for (const watcher of watchers.values()) watcher.close();
    db.close();
    parentPort?.close();
    return;
  }
  if (message.wake) {
    wake();
    return;
  }
  try {
    const result = tick(message.reset, true);
    parentPort?.postMessage({ id: message.id, result });
    schedule(backoff.next(Boolean(result.work || result.discovering)));
  } catch (err) {
    parentPort?.postMessage({ id: message.id, error: String(err) });
  }
});
schedule(100);
