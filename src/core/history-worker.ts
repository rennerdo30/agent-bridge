import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { HistoryIndex, HISTORY_TICK_MS } from "./history.js";
import { ConversationIngestor } from "./conversations.js";
import { transcriptPaths } from "./transcripts/common.js";
import { copyLegacyConversationTail, historyMigrationFailure, HISTORY_IO_BYTES_PER_SECOND, legacyTailConflicts, migrateHistoryStore, openHistoryStore } from "./history-store.js";
import { checkpointOwnedMetadataConnections, closeMetadataDbs } from "./metadata-db.js";
import type { HistoryWorkerCheckpoint } from "./history-background.js";
import { loadConfig } from "./config.js";
import { nullLogger } from "./logger.js";
import type { PeerInfo } from "./protocol.js";
import { setTimeout as yieldTurn } from "node:timers/promises";
import { readHistoryMigrationProgress } from "./history-migration.js";
import { historyBudget, HistoryBudgetAdmission, type HistoryBudget } from "./history-budget.js";
import { projectDatabasePath, ownsProjectMirrors } from "./project-store.js";
import { dirname } from "node:path";
import { reconcileAskCompletions } from "./ask-completion.js";
import { join } from "node:path";
import { readHistoryJson } from "./run-history.js";
import { isRecord, writeJsonStore } from "./json-store.js";
import { IdleBackoff } from "./idle-backoff.js";
import { statSync } from "node:fs";
import { fileSignature } from "./file-cache.js";
import { CONFIG_FILE_NAME } from "./constants.js";
import type { BridgeConfig } from "./config.js";

const db = openHistoryStore(workerData.file);
// This connection can never acquire bridge.db's write lock.
const source = new DatabaseSync(workerData.bridge, { readOnly: true, timeout: 100 });
source.exec("PRAGMA busy_timeout=100; PRAGMA query_only=ON");
const paths = workerData.paths ?? transcriptPaths();
// Built once the store is at v2 and verified: a deferred v1 store (AB-225) is upgraded in place by the migration,
// and both read the schema when they are constructed.
let index: HistoryIndex | null = null;
let ingest: ConversationIngestor | null = null;
let legacyConflicts = -1;
let timer: NodeJS.Timeout | null = null;
let stopped = false, pending = false, ready = false, running = false;
let requestedReset = false;
// Keep unapplied accepted intent for a lifecycle seal without changing normal
// tick/reset admission or its existing backoff behavior.
let activeReset = false, unappliedReset = false;
// This identity comes from the owning HistoryBackground's Worker constructor,
// never from config, a tool argument or an incoming lifecycle request.
const lifecycleOwnerInstance = workerData.lifecycleOwnerInstance;
let lifecycleGeneration = 0, lifecycleQuiesced = false, lifecycleUnknown = false;
const acceptedOperations = new Set<symbol>();
let checkpointRequest: { requestId: string; generation: number; deadline: number } | null = null;
let checkpointReported = false;
let retainedDueAt: number | null = null;
function acceptOperation(): () => void {
  const operation = Symbol();
  acceptedOperations.add(operation);
  return () => { acceptedOperations.delete(operation); restoreRetainedSchedule(); reportCheckpoint(); };
}
function restoreRetainedSchedule(): void {
  if (lifecycleQuiesced || stopped || running || acceptedOperations.size || timer || retainedDueAt === null) return;
  const due = retainedDueAt; retainedDueAt = null;
  schedule(Math.max(0, due - Date.now()));
}
function reportCheckpoint(): void {
  const request = checkpointRequest;
  if (!request || checkpointReported || !lifecycleQuiesced || running || checkingBudget || acceptedOperations.size) return;
  checkpointReported = true;
  const pendingOperations = acceptedOperations.size + peers.size + Number(requestedReset) + pressureWaiters.size + Number(pending);
  const producerSettled = !stopped && !lifecycleUnknown && pendingOperations === 0;
  // Only the metadata registry has an existing trusted stage API. HistoryIndex,
  // ConversationIngestor/history.db and project-store have no owned store closure
  // contract. Never turn a zero in-memory queue or this stage into release proof.
  // Metadata path observations do not bind native SQLite handles. The approved
  // external-replacement fault exclusion never exempts Bridge-owned writers.
  const metadata = producerSettled && performance.now() < request.deadline
    ? checkpointOwnedMetadataConnections({ ownerInstance: lifecycleOwnerInstance, generation: request.generation, home: workerData.home,
        isCurrentSealed: () => lifecycleQuiesced && !stopped && !lifecycleUnknown && lifecycleGeneration === request.generation &&
          checkpointRequest === request && !running && !checkingBudget && acceptedOperations.size === 0 && !peers.size && !requestedReset && !pressureWaiters.size && !pending }, request.deadline)
    : null;
  const unknown = lifecycleUnknown || Boolean(metadata && !metadata.checkpointed && metadata.reason !== "budget" && metadata.reason !== "busy");
  if (unknown) lifecycleUnknown = true;
  const result: HistoryWorkerCheckpoint = { ownerInstance: lifecycleOwnerInstance, generation: request.generation, requestId: request.requestId,
    quiesced: lifecycleQuiesced, pendingOperations, retainedPeers: peers.size, retainedReset: requestedReset,
    retainedSchedule: retainedDueAt !== null || wakeAfterTick || transcriptsChanged,
    pressureWaiters: pressureWaiters.size, pressurePending: pending, budgetRunning: checkingBudget, unknown, producerSettled: producerSettled && !unknown,
    reason: unknown ? "unknown" : producerSettled ? "owner_unsupported" : "pending", metadata,
    handlesRetained: true, ownershipReleased: false };
  parentPort?.postMessage({ historyCheckpoint: result });
}
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
/** config.json is read again only when it changes; every tick asks several times (AB-147). */
let configCache: { signature: string; value: BridgeConfig } | null = null;
function currentConfig(): BridgeConfig {
  let signature = "missing";
  try { signature = fileSignature(statSync(join(workerData.home, CONFIG_FILE_NAME), { bigint: true })); } catch { /* defaults */ }
  if (configCache?.signature !== signature) configCache = { signature, value: loadConfig(workerData.home, "other", nullLogger) };
  return configCache.value;
}
function enabled(): boolean { return currentConfig().history.ingest; }
function reportPaused(paused: boolean): void {
  migrationProgress = { ...migrationProgress, paused, phase: paused && migrationProgress.phase === "starting" ? "paused" : migrationProgress.phase };
  parentPort?.postMessage({ migrationProgress });
}
reportPaused(!enabled() || Boolean(importState.error));
const paused = () => pending || Date.now() < pauseUntil || !enabled() || storageBudgetPaused;
function applyStorageBudget(budget: HistoryBudget): void {
  storageBudgetPaused = budget.paused;
  if (budget.paused) {
    migrationProgress = { ...migrationProgress, paused: true, error: `History storage budget reached (${budget.bytes}/${budget.budgetBytes} bytes); import paused, sources, cursors and all archives retained. Raise history.budgetBytes to resume; never prune user data.` };
    parentPort?.postMessage({ migrationProgress });
  } else if (migrationProgress.error?.startsWith("History storage budget reached")) migrationProgress = { ...migrationProgress, error: null };
}
const budgetAdmission = new HistoryBudgetAdmission(async () => {
  const started = performance.now();
  const config = currentConfig();
  const mirrors = ownsProjectMirrors(workerData.home)
    ? db.prepare("SELECT DISTINCT project FROM conversations WHERE project != ''").all().map(row => dirname(projectDatabasePath(String(row.project), workerData.home))) : [];
  const budget = await historyBudget(workerData.home, config.history.budgetBytes, mirrors);
  parentPort?.postMessage({ historyTiming: { budgetScanMs: performance.now() - started } });
  applyStorageBudget(budget);
  return budget;
});
// Migration yields between paced chunks. Recheck admission while it is in progress.
let checkingBudget = false;
function budgetTick(): void {
  if (checkingBudget || stopped || lifecycleQuiesced) return;
  const finish = acceptOperation();
  checkingBudget = true;
  void budgetAdmission.refresh().catch(error => { storageBudgetPaused = true; parentPort?.postMessage({ error: String(error) }); })
    .finally(() => { checkingBudget = false; finish(); });
}
let budgetTimer: NodeJS.Timeout | null = setInterval(budgetTick, 1000);
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
  const started = performance.now();
  const phases: Record<string, number> = {};
  let phase = "budgetMs", phaseStarted = started;
  const step = (next: string) => {
    const now = performance.now();
    phases[phase] = (phases[phase] ?? 0) + now - phaseStarted;
    phase = next; phaseStarted = now;
  };
  try {
    const admitted = await budgetAdmission.admit(currentConfig().history.budgetBytes);
    step("resetStateMs");
    if (!admitted) return { work: 0, discovering: !ready };
    reset = requestedReset;
    requestedReset = false;
    activeReset = reset;
    if (migrationFailure && !reset) throw new Error(migrationFailure);
    if (importState.error && !reset) throw new Error(importState.error);
    if (reset && importState.error) {
      const { error: priorError, ...retainedState } = importState;
      importState = { ...retainedState, history: [...(importState.history ?? []), priorError] };
      saveImportState();
      migrationProgress = { ...migrationProgress, error: null };
    }
    step("observerNotifyMs");
    reportPaused(false);
    step("migrationMs");
    if (!ready) {
      try {
        await migrateHistoryStore(workerData.bridge, db, paused, () => stopped, owner => parentPort?.postMessage({ migrationLease: owner }), reset, { ioBytesPerSecond, onProgress: progress => { migrationProgress = progress; parentPort?.postMessage({ migrationProgress }); } });
        migrationFailure = null;
      } catch (err) { migrationFailure = historyMigrationFailure(db); throw err; }
      step("indexInitMs");
      index ??= new HistoryIndex(db, workerData.home, paths, source);
      step("ingestInitMs");
      if (!ingest) {
        ingest = new ConversationIngestor(db, workerData.home, paths, source); ingest.onChange = onTranscriptChange;
        const registering = index;
        ingest.onUnknownPaths = (changed) => { registering.registerChanged(changed); };
      }
      ready = true;
    }
    step("admissionCheckMs");
    if (!index || !ingest) return { work: 0, discovering: true };
    if (stopped || paused()) return { work: 0, discovering: true };
    // The legacy tail never gates raw capture: a failure here is reported and native ingestion still runs (AB-226).
    step("legacyTailMs");
    let legacyWork = 0;
    try { legacyWork = copyLegacyConversationTail(source, db); }
    catch (error) { if (!stopped) parentPort?.postMessage({ error: `legacy history tail deferred; originals retained: ${String(error)}` }); }
    step("legacyConflictsMs");
    const conflicts = legacyTailConflicts(db);
    if (conflicts !== legacyConflicts) {
      legacyConflicts = conflicts;
      migrationProgress = { ...migrationProgress, legacyConflicts: conflicts };
      parentPort?.postMessage({ migrationProgress });
      if (conflicts) parentPort?.postMessage({ error: `${conflicts} legacy history tail conflict(s) retained in history.db (history_legacy_conflicts); both originals kept, finalize stays blocked` });
    }
    step("ingestYieldMs");
    await yieldTurn(10);
    step("ingestPressureWaitMs");
    await waitForPressureGap();
    step("peerResetMs");
    if (stopped || paused()) return { work: legacyWork, discovering: true };
    for (const [id, peer] of [...peers].slice(0, 32)) { index.rememberPeer(peer); peers.delete(id); }
    if (reset) { index.reset(); activeReset = false; unappliedReset = false; requestedReset = false; }
    // Preserve raw bytes before spending the next idle gap on derived indexing.
    // Otherwise a full index batch can consume every gap in sustained traffic.
    step("ingestMs");
    const rawWork = ingest.tick();
    step("indexWakeMs");
    if (transcriptsChanged) { transcriptsChanged = false; index.wake(); }
    step("indexYieldMs");
    await yieldTurn(10);
    step("indexPressureWaitMs");
    await waitForPressureGap();
    step("indexAdmissionMs");
    if (stopped || paused()) return { work: legacyWork + rawWork, discovering: true };
    step("indexMs");
    const result = index.tick(true);
    step("resultMs");
    return { work: legacyWork + rawWork + result.work, discovering: result.discovering || ingest.discovering };
  } catch (error) {
    step("failureStateWriteMs");
    if ((error as { code?: string }).code === "HISTORY_IMPORT_VERIFICATION_FAILED") {
      importState = { ...importState, error: String(error) }; saveImportState();
      migrationProgress = { ...migrationProgress, error: importState.error!, paused: true };
      parentPort?.postMessage({ migrationProgress });
    }
    throw error;
  } finally {
    step("completionMs");
    if (activeReset) { unappliedReset = true; if (lifecycleQuiesced) requestedReset = true; }
    activeReset = false;
    running = false;
    budgetAdmission.complete();
    step("timingNotifyMs");
    parentPort?.postMessage({ historyTiming: { ...phases, totalMs: performance.now() - started } });
  }
}
let dueAt = 0, transcriptsChanged = false, wakeAfterTick = false, liveAfterTick = false, lastTickAt = 0;
/** Timer callbacks in flight (from firing until they schedule the next one), including the wait before `running`. */
let firing = 0;
/** Watched transcript and run-log changes are retained at once (AB-383): a tick within LIVE_WAKE_MS, at most one
 * per LIVE_GAP_MS while a file keeps changing. It never postpones a tick that is due sooner. */
const LIVE_WAKE_MS = 15, LIVE_GAP_MS = 100;
function wakeSoon(): void {
  if (lifecycleQuiesced) return;
  if (stopped) return;
  idle.reset();
  // Only one pending tick may exist: a wake while a callback is in flight is folded into its next schedule.
  if (running || firing) { liveAfterTick = true; return; }
  const delay = Math.max(LIVE_WAKE_MS, lastTickAt + LIVE_GAP_MS - Date.now());
  if (timer && dueAt - Date.now() <= delay) return;
  schedule(delay);
}
// The ingestor is created once the store is ready; it reports watched transcript changes through this hook.
const onTranscriptChange = () => {
  transcriptsChanged = true;
  if (lifecycleQuiesced && checkpointReported) parentPort?.postMessage({ historyLifecycleChanged: true });
  wakeSoon();
};
function schedule(delay = HISTORY_TICK_MS): void {
  if (stopped) return;
  if (lifecycleQuiesced) { retainedDueAt = Date.now() + delay; return; }
  retainedDueAt = null;
  if (timer) clearTimeout(timer);
  dueAt = Date.now() + delay;
  const scheduledAt = performance.now();
  timer = setTimeout(async () => {
    const firedAt = performance.now();
    timer = null;
    const acceptStarted = performance.now();
    const finish = acceptOperation();
    const acceptMs = performance.now() - acceptStarted;
    firing++;
    let next = idle.next(0, false);
    try {
      // Resume on the pressure-clear event; polling can miss short idle gaps.
      const pressureStarted = performance.now();
      await waitForPressureGap();
      parentPort?.postMessage({ historyTiming: { scheduleWaitMs: firedAt - scheduledAt, scheduleDelayMs: delay,
        scheduleLateMs: Math.max(0, firedAt - scheduledAt - delay), acceptMs, schedulePressureWaitMs: performance.now() - pressureStarted } });
      if (!migrationFailure && !importState.error) {
        const result = await tick();
        if (result.work || result.discovering && enabled()) next = idle.next(result.work, result.discovering);
      }
    }
    catch (err) {
      if ((err as { code?: string }).code !== "HISTORY_SNAPSHOT_PAUSED" && !stopped) parentPort?.postMessage({ error: String(err) });
      pauseUntil = Date.now() + 5000;
    }
    lastTickAt = Date.now();
    // Backfill gets seconds-scale cadence, never a hot loop. A message or live-file wake during the tick runs one more soon.
    if (liveAfterTick) { liveAfterTick = false; next = Math.min(next, LIVE_GAP_MS); }
    if (wakeAfterTick) { wakeAfterTick = false; next = 0; }
    firing--;
    schedule(next);
    const finishStarted = performance.now();
    finish();
    parentPort?.postMessage({ historyTiming: { operationFinishCheckpointMs: performance.now() - finishStarted } });
  }, delay);
}
function close(): void { if (budgetTimer) clearInterval(budgetTimer); index?.close(); ingest?.close(); source.close(); db.close(); closeMetadataDbs(); parentPort?.close(); }
parentPort?.on("message", async (message) => {
  if (message.historyLifecycle) {
    if (typeof lifecycleOwnerInstance !== "string" || message.ownerInstance !== lifecycleOwnerInstance ||
        !Number.isSafeInteger(message.generation) || message.generation < lifecycleGeneration) {
      lifecycleUnknown = true; return;
    }
    if (message.historyLifecycle === "quiesce") {
      if (message.generation <= lifecycleGeneration) return;
      lifecycleGeneration = message.generation;
      lifecycleQuiesced = true;
      requestedReset ||= unappliedReset || activeReset;
      checkpointRequest = null; checkpointReported = false;
      if (timer) { clearTimeout(timer); timer = null; retainedDueAt = dueAt; }
      if (budgetTimer) clearInterval(budgetTimer);
      budgetTimer = null;
      return;
    }
    if (message.historyLifecycle === "resume") {
      if (message.generation <= lifecycleGeneration) return;
      lifecycleGeneration = message.generation;
      lifecycleQuiesced = false;
      checkpointRequest = null; checkpointReported = false;
      if (!budgetTimer && !stopped) { budgetTimer = setInterval(budgetTick, 1000); budgetTimer.unref(); }
      restoreRetainedSchedule();
      if (retainedDueAt === null && !timer && (wakeAfterTick || peers.size || requestedReset || transcriptsChanged) && !running) schedule(0);
      return;
    }
    if (message.historyLifecycle === "checkpoint") {
      if (!lifecycleQuiesced || message.generation !== lifecycleGeneration || checkpointRequest ||
          typeof message.requestId !== "string" || !Number.isFinite(message.deadline)) { lifecycleUnknown = true; return; }
      checkpointRequest = { requestId: message.requestId, generation: message.generation, deadline: message.deadline };
      reportCheckpoint();
      return;
    }
    lifecycleUnknown = true;
    return;
  }
  // Pressure clear is a continuation of the accepted writer that caused the
  // original pressure wait. Inhibiting it would strand already admitted work.
  if (lifecycleQuiesced && !message.stop && !(message.pressure && !message.pending && !message.lockError)) {
    lifecycleUnknown = true;
    return;
  }
  const finish = acceptOperation();
  try {
    if (message.pressure) {
      const wasPending = pending;
      pending = !!message.pending;
      if (message.lockError) pauseUntil = Date.now() + 5000;
      if (!pending) { releasePressure(); if (wasPending && !running) { idle.reset(); schedule(0); } }
      return;
    }
    if (message.peer) { peers.set(message.peer.id, message.peer); idle.reset(); if (!running) schedule(0); return; }
    // A new bridge message: index it now rather than after an idle backoff; during a tick, right after it.
    if (message.wake) { idle.reset(); if (running || firing) wakeAfterTick = true; else schedule(0); return; }
    if (message.stop) {
      stopped = true;
      releasePressure();
      if (timer) clearTimeout(timer);
      while (running || checkingBudget) await yieldTurn(10);
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
  } finally { finish(); }
});
schedule();
