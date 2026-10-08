import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { HistoryIndex, HISTORY_TICK_MS } from "./history.js";
import { ConversationIngestor } from "./conversations.js";
import { transcriptPaths } from "./transcripts/common.js";
import { copyLegacyConversationTail, historyMigrationFailure, HISTORY_IO_BYTES_PER_SECOND, migrateHistoryStore, openHistoryStore } from "./history-store.js";
import { loadConfig } from "./config.js";
import { nullLogger } from "./logger.js";
import type { PeerInfo } from "./protocol.js";
import { setTimeout as yieldTurn } from "node:timers/promises";
import { readHistoryMigrationProgress } from "./history-migration.js";

const db = openHistoryStore(workerData.file);
// This connection can never acquire bridge.db's write lock.
const source = new DatabaseSync(workerData.bridge, { readOnly: true, timeout: 100 });
source.exec("PRAGMA busy_timeout=100; PRAGMA query_only=ON");
const paths = workerData.paths ?? transcriptPaths();
const index = new HistoryIndex(db, workerData.home, paths, source);
const ingest = new ConversationIngestor(db, workerData.home, paths, source);
let timer: NodeJS.Timeout | null = null;
let stopped = false, pending = false, ready = false, running = false;
let requestedReset = false;
let pauseUntil = 0;
// Persisted failures survive worker/broker restarts. Only an explicit reindex retries.
let migrationFailure = historyMigrationFailure(db);
if (migrationFailure) parentPort?.postMessage({ error: migrationFailure });
const ioBytesPerSecond = Number(process.env.AGENT_BRIDGE_HISTORY_MIGRATION_IO_BYTES_PER_SECOND || HISTORY_IO_BYTES_PER_SECOND);
let migrationProgress = readHistoryMigrationProgress(db, ioBytesPerSecond);
const pressureWaiters = new Set<() => void>();
const peers = new Map<string, PeerInfo>();
function enabled(): boolean { return loadConfig(workerData.home, "other", nullLogger).history.ingest; }
function reportPaused(paused: boolean): void {
  migrationProgress = { ...migrationProgress, paused, phase: paused && migrationProgress.phase === "starting" ? "paused" : migrationProgress.phase };
  parentPort?.postMessage({ migrationProgress });
}
reportPaused(!enabled());
const paused = () => pending || Date.now() < pauseUntil || !enabled();
async function waitForPressureGap(): Promise<void> {
  while (pending && !stopped) await new Promise<void>(resolve => { pressureWaiters.add(resolve); });
}
function releasePressure(): void {
  for (const resolve of pressureWaiters) resolve();
  pressureWaiters.clear();
}
async function tick(reset = false): Promise<{ work: number; discovering: boolean }> {
  if (reset) requestedReset = true;
  if (running || stopped) return { work: 0, discovering: !ready };
  if (paused()) { reportPaused(true); return { work: 0, discovering: !ready }; }
  reset = requestedReset;
  requestedReset = false;
  reportPaused(false);
  if (migrationFailure && !reset) throw new Error(migrationFailure);
  running = true;
  try {
    if (!ready) {
      try {
        await migrateHistoryStore(workerData.bridge, db, paused, () => stopped, owner => parentPort?.postMessage({ migrationLease: owner }), reset, { ioBytesPerSecond, onProgress: progress => { migrationProgress = progress; parentPort?.postMessage({ migrationProgress }); } });
        migrationFailure = null;
      } catch (err) { migrationFailure = historyMigrationFailure(db); throw err; }
      ready = true;
    }
    if (stopped || paused()) return { work: 0, discovering: true };
    const legacyWork = copyLegacyConversationTail(source, db);
    await yieldTurn(10);
    await waitForPressureGap();
    if (stopped || paused()) return { work: legacyWork, discovering: true };
    for (const [id, peer] of [...peers].slice(0, 32)) { index.rememberPeer(peer); peers.delete(id); }
    if (reset) index.reset();
    // Preserve raw bytes before spending the next idle gap on derived indexing.
    // Otherwise a full index batch can consume every gap in sustained traffic.
    const rawWork = ingest.tick();
    await yieldTurn(10);
    await waitForPressureGap();
    if (stopped || paused()) return { work: legacyWork + rawWork, discovering: true };
    const result = index.tick();
    return { work: legacyWork + rawWork + result.work, discovering: result.discovering || ingest.discovering };
  } finally { running = false; }
}
function schedule(delay = HISTORY_TICK_MS): void {
  if (stopped) return;
  timer = setTimeout(async () => {
    try {
      // Resume on the pressure-clear event; polling can miss short idle gaps.
      await waitForPressureGap();
      if (!migrationFailure) await tick();
    }
    catch (err) {
      if ((err as { code?: string }).code !== "HISTORY_SNAPSHOT_PAUSED" && !stopped) parentPort?.postMessage({ error: String(err) });
      pauseUntil = Date.now() + 5000;
    }
    // Backfill gets seconds-scale cadence, never a hot loop.
    schedule();
  }, delay);
}
function close(): void { index.close(); ingest.close(); source.close(); db.close(); parentPort?.close(); }
parentPort?.on("message", async (message) => {
  if (message.pressure) {
    pending = !!message.pending;
    if (message.lockError) pauseUntil = Date.now() + 5000;
    if (!pending) releasePressure();
    return;
  }
  if (message.peer) { peers.set(message.peer.id, message.peer); return; }
  if (message.stop) {
    stopped = true;
    releasePressure();
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
