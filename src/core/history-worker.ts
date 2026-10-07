import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { HistoryIndex, HISTORY_TICK_MS } from "./history.js";
import { ConversationIngestor } from "./conversations.js";
import { transcriptPaths } from "./transcripts/common.js";
import { copyLegacyConversationTail, migrateHistoryStore, openHistoryStore } from "./history-store.js";
import { loadConfig } from "./config.js";
import { nullLogger } from "./logger.js";
import type { PeerInfo } from "./protocol.js";
import { setTimeout as yieldTurn } from "node:timers/promises";

const db = openHistoryStore(workerData.file);
// This connection can never acquire bridge.db's write lock.
const source = new DatabaseSync(workerData.bridge, { readOnly: true, timeout: 100 });
source.exec("PRAGMA busy_timeout=100; PRAGMA query_only=ON");
const paths = workerData.paths ?? transcriptPaths();
const index = new HistoryIndex(db, workerData.home, paths, source);
const ingest = new ConversationIngestor(db, workerData.home, paths, source);
let timer: NodeJS.Timeout | null = null;
let stopped = false, pending = false, ready = false, running = false;
let pauseUntil = 0;
const peers = new Map<string, PeerInfo>();
function enabled(): boolean { return loadConfig(workerData.home, "other", nullLogger).history.ingest; }
const paused = () => pending || Date.now() < pauseUntil || !enabled();
async function tick(reset = false): Promise<{ work: number; discovering: boolean }> {
  if (running || stopped || paused()) return { work: 0, discovering: !ready };
  running = true;
  try {
    if (!ready) {
      await migrateHistoryStore(workerData.bridge, db, paused, () => stopped, owner => parentPort?.postMessage({ migrationLease: owner }));
      ready = true;
    }
    if (stopped || paused()) return { work: 0, discovering: true };
    const legacyWork = copyLegacyConversationTail(source, db);
    await yieldTurn(10);
    for (const [id, peer] of [...peers].slice(0, 32)) { index.rememberPeer(peer); peers.delete(id); }
    if (reset) index.reset();
    const result = index.tick();
    // A real event-loop turn between bounded batches lets pressure/stop arrive.
    await yieldTurn(10);
    const work = legacyWork + result.work + (stopped || paused() ? 0 : ingest.tick());
    return { work, discovering: result.discovering || ingest.discovering };
  } finally { running = false; }
}
function schedule(delay = HISTORY_TICK_MS): void {
  if (stopped) return;
  timer = setTimeout(async () => {
    try {
      // Wait for a gap in broker work instead of repeatedly missing the same burst phase.
      while (pending && !stopped) await yieldTurn(100);
      await tick();
    }
    catch (err) { parentPort?.postMessage({ error: String(err) }); pauseUntil = Date.now() + 5000; }
    // Backfill gets seconds-scale cadence, never a hot loop.
    schedule();
  }, delay);
}
function close(): void { index.close(); ingest.close(); source.close(); db.close(); parentPort?.close(); }
parentPort?.on("message", async (message) => {
  if (message.pressure) {
    pending = !!message.pending;
    if (message.lockError) pauseUntil = Date.now() + 5000;
    return;
  }
  if (message.peer) { peers.set(message.peer.id, message.peer); return; }
  if (message.stop) {
    stopped = true;
    if (timer) clearTimeout(timer);
    while (running) await yieldTurn(10);
    close(); return;
  }
  try {
    while (running && !stopped) await yieldTurn(10);
    parentPort?.postMessage({ id: message.id, result: await tick(message.reset) });
  }
  catch (err) { parentPort?.postMessage({ id: message.id, error: String(err) }); }
});
schedule();
