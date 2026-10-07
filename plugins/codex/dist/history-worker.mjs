import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  ConversationIngestor
} from "./chunks/chunk-K5UGVRMW.mjs";
import "./chunks/chunk-G6MLDC24.mjs";
import {
  HISTORY_TICK_MS,
  HistoryIndex
} from "./chunks/chunk-S7VTNSOR.mjs";
import "./chunks/chunk-QBVZNCPA.mjs";
import {
  transcriptPaths
} from "./chunks/chunk-AT5K4DQH.mjs";
import {
  configureSqlite
} from "./chunks/chunk-AGX4O262.mjs";
import "./chunks/chunk-WXTV3GSE.mjs";
import "./chunks/chunk-2EE2AGA4.mjs";
import "./chunks/chunk-FDMEMG4Z.mjs";
import "./chunks/chunk-4BCYRJ3A.mjs";
import "./chunks/chunk-BOOG2SC5.mjs";
import "./chunks/chunk-X27LYYGH.mjs";
import "./chunks/chunk-HHAVWD7J.mjs";

// src/core/history-worker.ts
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
var db = new DatabaseSync(workerData.file, { timeout: 50 });
configureSqlite(db, 50);
var paths = workerData.paths ?? transcriptPaths();
var index = new HistoryIndex(db, workerData.home, paths);
var ingest = new ConversationIngestor(db, workerData.home, paths);
var timer = null;
function tick(reset = false) {
  if (reset) index.reset();
  const result = index.tick();
  const work = result.work + ingest.tick();
  return { work, discovering: result.discovering || ingest.discovering };
}
function schedule(delay = HISTORY_TICK_MS) {
  timer = setTimeout(() => {
    try {
      const result = tick();
      schedule(result.work || result.discovering ? 100 : HISTORY_TICK_MS);
    } catch (err) {
      parentPort?.postMessage({ error: String(err) });
      schedule();
    }
  }, delay);
}
parentPort?.on("message", (message) => {
  if (message.stop) {
    if (timer) clearTimeout(timer);
    index.close();
    ingest.close();
    db.close();
    parentPort?.close();
    return;
  }
  try {
    parentPort?.postMessage({ id: message.id, result: tick(message.reset) });
  } catch (err) {
    parentPort?.postMessage({ id: message.id, error: String(err) });
  }
});
schedule(100);
