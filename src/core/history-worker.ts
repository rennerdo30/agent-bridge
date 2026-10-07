import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { HistoryIndex, HISTORY_TICK_MS } from "./history.js";
import { ConversationIngestor } from "./conversations.js";
import { transcriptPaths } from "./transcripts/common.js";
import { configureSqlite } from "./sqlite-policy.js";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { IdleBackoff } from "./idle-backoff.js";

const db = new DatabaseSync(workerData.file, { timeout: 50 });
configureSqlite(db, 50);
const paths = workerData.paths ?? transcriptPaths();
const index = new HistoryIndex(db, workerData.home, paths);
const ingest = new ConversationIngestor(db, workerData.home, paths, (path) => {
  index.notify(path);
  wake();
});
const backoff = new IdleBackoff();
const watchers = new Map<string, FSWatcher>();
let timer: NodeJS.Timeout | null = null;
let stopped = false;
function wake(): void { if (!stopped) schedule(backoff.wake()); }
function watchHome(): void {
  // Watch only input directories. Watching bridge.db/WAL or our mirrors would wake us on our own writes.
  for (const dir of ["", "runs", "context-events", "approvals", "archive"]) {
    const root = join(workerData.home, dir);
    if (watchers.has(root)) continue;
    try {
      const watcher = watch(root, { recursive: Boolean(dir), persistent: false }, (_, name) => {
        if (!dir && !/^(jobs\.json|runs|context-events|approvals|archive)$/.test(String(name))) return;
        ingest.notifyJobs();
        wake();
      });
      watcher.on("error", () => { watcher.close(); watchers.delete(root); });
      watchers.set(root, watcher);
    } catch { /* The 30-second fallback also discovers roots created after startup. */ }
  }
}
function tick(reset = false, force = false): { work: number; discovering: boolean } {
  watchHome();
  if (reset) index.reset();
  const result = index.tick();
  const work = result.work + ingest.tick(force);
  return { work, discovering: result.discovering || ingest.discovering };
}
function schedule(delay = HISTORY_TICK_MS): void {
  if (timer) clearTimeout(timer);
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
  if (message.wake) { wake(); return; }
  try {
    const result = tick(message.reset, true);
    parentPort?.postMessage({ id: message.id, result });
    schedule(backoff.next(Boolean(result.work || result.discovering)));
  } catch (err) {
    parentPort?.postMessage({ id: message.id, error: String(err) });
  }
});
schedule(100);
