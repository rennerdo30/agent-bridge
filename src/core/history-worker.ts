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
import { historyBudget } from "./history-budget.js";
import { projectDatabasePath, ownsProjectMirrors } from "./project-store.js";
import { dirname } from "node:path";
import { reconcileAskCompletions } from "./ask-completion.js";
import { join } from "node:path";
import { readHistoryJson } from "./run-history.js";
import { isRecord, writeJsonStore } from "./json-store.js";
import { IdleBackoff } from "./idle-backoff.js";

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
const idle = new IdleBackoff(HISTORY_TICK_MS);
let pauseUntil = 0;
let storageBudgetPaused = false;
// Persisted failures survive worker/broker restarts. Only an explicit reindex retries.
let migrationFailure = historyMigrationFailure(db);
const importFailurePath = join(workerData.home, "history-import-failure.json");
const savedImportFailure = readHistoryJson(importFailurePath);
let importState: { error?: string; history?: string[] } = isRecord(savedImportFailure) ? savedImportFailure : {};
function saveImportState(): void {
  writeJsonStore(importFailurePath, { importVersion: 1, ...importState }, readHistoryJson(importFailurePath));
}
if (migrationFailure) parentPort?.postMessage({ error: migrationFailure });
const ioBytesPerSecond = Number(process.env.AGENT_BRIDGE_HISTORY_MIGRATION_IO_BYTES_PER_SECOND || HISTORY_IO_BYTES_PER_SECOND);
let migrationProgress = readHistoryMigrationProgress(db, ioBytesPerSecond);
if (typeof importState.error === "string") migrationProgress = { ...migrationProgress, error: importState.error, paused: true };
const pressureWaiters = new Set<() => void>();
const peers = new Map<string, PeerInfo>();
function enabled(): boolean { return loadConfig(workerData.home, "other", nullLogger).history.ingest; }
function reportPaused(paused: boolean): void {
  migrationProgress = { ...migrationProgress, paused, phase: paused && migrationProgress.phase === "starting" ? "paused" : migrationProgress.phase };
  parentPort?.postMessage({ migrationProgress });
}
reportPaused(!enabled() || Boolean(importState.error));
const paused = () => pending || Date.now() < pauseUntil || !enabled() || storageBudgetPaused;
async function checkStorageBudget(): Promise<boolean> {
  const config = loadConfig(workerData.home, "other", nullLogger);
  const mirrors = ownsProjectMirrors(workerData.home)
    ? db.prepare("SELECT DISTINCT project FROM conversations WHERE project != ''").all().map(row => dirname(projectDatabasePath(String(row.project), workerData.home))) : [];
  const budget = await historyBudget(workerData.home, config.history.budgetBytes, mirrors);
  storageBudgetPaused = budget.paused;
  if (budget.paused) {
    migrationProgress = { ...migrationProgress, paused: true, error: `History storage budget reached (${budget.bytes}/${budget.budgetBytes} bytes); import paused, sources, cursors and all archives retained. Raise history.budgetBytes to resume; never prune user data.` };
    parentPort?.postMessage({ migrationProgress });
  } else if (migrationProgress.error?.startsWith("History storage budget reached")) migrationProgress = { ...migrationProgress, error: null };
  return budget.paused;
}
// Migration yields between paced chunks. Recheck admission while it is in progress.
let checkingBudget = false;
const budgetTimer = setInterval(() => {
  if (!running || checkingBudget || stopped) return;
  checkingBudget = true;
  void checkStorageBudget().catch(error => { storageBudgetPaused = true; parentPort?.postMessage({ error: String(error) }); })
    .finally(() => { checkingBudget = false; });
}, 1000);
budgetTimer.unref();
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
  if (pending || Date.now() < pauseUntil || !enabled()) { reportPaused(true); return { work: 0, discovering: !ready }; }
  running = true;
  try {
    if (await checkStorageBudget()) return { work: 0, discovering: !ready };
    reset = requestedReset;
    requestedReset = false;
    if (migrationFailure && !reset) throw new Error(migrationFailure);
    if (importState.error && !reset) throw new Error(importState.error);
    if (reset && importState.error) {
      const { error: priorError, ...retainedState } = importState;
      importState = { ...retainedState, history: [...(importState.history ?? []), priorError] };
      saveImportState();
      migrationProgress = { ...migrationProgress, error: null };
    }
    reportPaused(false);
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
    const result = index.tick(true);
    return { work: legacyWork + rawWork + result.work, discovering: result.discovering || ingest.discovering };
  } catch (error) {
    if ((error as { code?: string }).code === "HISTORY_IMPORT_VERIFICATION_FAILED") {
      importState = { ...importState, error: String(error) }; saveImportState();
      migrationProgress = { ...migrationProgress, error: importState.error!, paused: true };
      parentPort?.postMessage({ migrationProgress });
    }
    throw error;
  } finally { running = false; }
}
function schedule(delay = HISTORY_TICK_MS): void {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    let next = idle.next(0, false);
    try {
      // Resume on the pressure-clear event; polling can miss short idle gaps.
      await waitForPressureGap();
      if (!migrationFailure && !importState.error) {
        const result = await tick();
        if (result.work || result.discovering && enabled()) next = idle.next(result.work, result.discovering);
      }
    }
    catch (err) {
      if ((err as { code?: string }).code !== "HISTORY_SNAPSHOT_PAUSED" && !stopped) parentPort?.postMessage({ error: String(err) });
      pauseUntil = Date.now() + 5000;
    }
    // Backfill gets seconds-scale cadence, never a hot loop.
    schedule(next);
  }, delay);
}
function close(): void { clearInterval(budgetTimer); index.close(); ingest.close(); source.close(); db.close(); parentPort?.close(); }
parentPort?.on("message", async (message) => {
  if (message.pressure) {
    const wasPending = pending;
    pending = !!message.pending;
    if (message.lockError) pauseUntil = Date.now() + 5000;
    if (!pending) { releasePressure(); if (wasPending && !running) { idle.reset(); schedule(0); } }
    return;
  }
  if (message.peer) { peers.set(message.peer.id, message.peer); idle.reset(); if (!running) schedule(0); return; }
  if (message.stop) {
    stopped = true;
    releasePressure();
    if (timer) clearTimeout(timer);
    while (running) await yieldTurn(10);
    close(); return;
  }
  try {
    if (message.reconcileAsks) {
      parentPort?.postMessage({ id: message.id, result: { work: reconcileAskCompletions(join(workerData.home, "jobs.json")), discovering: false } });
      return;
    }
    while (running && !stopped) await yieldTurn(10);
    parentPort?.postMessage({ id: message.id, result: await tick(message.reset) });
  }
  catch (err) { parentPort?.postMessage({ id: message.id, error: String(err) }); }
});
schedule();
