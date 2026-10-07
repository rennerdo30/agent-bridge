import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { HistoryIndex, HISTORY_TICK_MS } from "./history.js";
import { ConversationIngestor } from "./conversations.js";
import { transcriptPaths } from "./transcripts/common.js";

const db = new DatabaseSync(workerData.file, { timeout: 50 });
const paths = workerData.paths ?? transcriptPaths();
const index = new HistoryIndex(db, workerData.home, paths);
const ingest = new ConversationIngestor(db, workerData.home, paths);
let timer: NodeJS.Timeout | null = null;
function tick(reset = false): { work: number; discovering: boolean } {
  if (reset) index.reset();
  const result = index.tick();
  const work = result.work + ingest.tick();
  return { work, discovering: result.discovering || ingest.discovering };
}
function schedule(delay = HISTORY_TICK_MS): void {
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
