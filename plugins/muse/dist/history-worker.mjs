import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  HistoryBudgetAdmission,
  historyBudget
} from "./chunks/chunk-EBFZLA6V.mjs";
import {
  HISTORY_TICK_MS,
  HistoryIndex
} from "./chunks/chunk-KCDVYXJY.mjs";
import "./chunks/chunk-3H3BD5VT.mjs";
import {
  ConversationIngestor,
  ownsProjectMirrors,
  projectDatabasePath
} from "./chunks/chunk-E45OBGDJ.mjs";
import "./chunks/chunk-TV2C3R42.mjs";
import {
  HISTORY_IO_BYTES_PER_SECOND,
  copyLegacyConversationTail,
  historyMigrationFailure,
  legacyTailConflicts,
  migrateHistoryStore,
  openHistoryStore,
  readHistoryMigrationProgress
} from "./chunks/chunk-OPOPAXBC.mjs";
import "./chunks/chunk-PJLG7FXO.mjs";
import "./chunks/chunk-77WY4MHW.mjs";
import {
  reconcileAskCompletions
} from "./chunks/chunk-QRAXKSFL.mjs";
import {
  loadConfig
} from "./chunks/chunk-QIBQO535.mjs";
import "./chunks/chunk-2C4MGFLC.mjs";
import "./chunks/chunk-PK5B76NL.mjs";
import {
  readHistoryJson
} from "./chunks/chunk-OWW5LACU.mjs";
import {
  transcriptPaths
} from "./chunks/chunk-I32N5HZ3.mjs";
import "./chunks/chunk-HYOPFLLN.mjs";
import "./chunks/chunk-IYJ5P7ML.mjs";
import {
  checkpointOwnedMetadataConnections,
  closeMetadataDbs,
  fileSignature,
  isRecord,
  nullLogger,
  writeJsonStore
} from "./chunks/chunk-ACDP6DDW.mjs";
import "./chunks/chunk-UWI3FQLD.mjs";
import {
  CONFIG_FILE_NAME
} from "./chunks/chunk-QWG77COH.mjs";
import "./chunks/chunk-ARGAVNKJ.mjs";
import "./chunks/chunk-6RNADTH4.mjs";

// src/core/history-worker.ts
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as yieldTurn } from "node:timers/promises";
import { dirname } from "node:path";
import { join } from "node:path";

// src/core/idle-backoff.ts
var IdleBackoff = class {
  constructor(minimum = 2e3, maximum = 3e4) {
    this.minimum = minimum;
    this.maximum = maximum;
    this.delay = minimum;
  }
  minimum;
  maximum;
  delay;
  next(work, discovering) {
    this.delay = work || discovering ? this.minimum : Math.min(this.maximum, this.delay * 2);
    return this.delay;
  }
  reset() {
    this.delay = this.minimum;
  }
};

// src/core/history-worker.ts
import { statSync } from "node:fs";
var db = openHistoryStore(workerData.file);
var source = new DatabaseSync(workerData.bridge, { readOnly: true, timeout: 100 });
source.exec("PRAGMA busy_timeout=100; PRAGMA query_only=ON");
var paths = workerData.paths ?? transcriptPaths();
var index = null;
var ingest = null;
var legacyConflicts = -1;
var timer = null;
var stopped = false;
var pending = false;
var ready = false;
var running = false;
var requestedReset = false;
var activeReset = false;
var unappliedReset = false;
var lifecycleOwnerInstance = workerData.lifecycleOwnerInstance;
var lifecycleGeneration = 0;
var lifecycleQuiesced = false;
var lifecycleUnknown = false;
var acceptedOperations = /* @__PURE__ */ new Set();
var checkpointRequest = null;
var checkpointReported = false;
var retainedDueAt = null;
function acceptOperation() {
  const operation = /* @__PURE__ */ Symbol();
  acceptedOperations.add(operation);
  return () => {
    acceptedOperations.delete(operation);
    restoreRetainedSchedule();
    reportCheckpoint();
  };
}
function restoreRetainedSchedule() {
  if (lifecycleQuiesced || stopped || running || acceptedOperations.size || timer || retainedDueAt === null) return;
  const due = retainedDueAt;
  retainedDueAt = null;
  schedule(Math.max(0, due - Date.now()));
}
function reportCheckpoint() {
  const request = checkpointRequest;
  if (!request || checkpointReported || !lifecycleQuiesced || running || checkingBudget || acceptedOperations.size) return;
  checkpointReported = true;
  const pendingOperations = acceptedOperations.size + peers.size + Number(requestedReset) + pressureWaiters.size + Number(pending);
  const producerSettled = !stopped && !lifecycleUnknown && pendingOperations === 0;
  const metadata = producerSettled && performance.now() < request.deadline ? checkpointOwnedMetadataConnections({
    ownerInstance: lifecycleOwnerInstance,
    generation: request.generation,
    home: workerData.home,
    isCurrentSealed: () => lifecycleQuiesced && !stopped && !lifecycleUnknown && lifecycleGeneration === request.generation && checkpointRequest === request && !running && !checkingBudget && acceptedOperations.size === 0 && !peers.size && !requestedReset && !pressureWaiters.size && !pending
  }, request.deadline) : null;
  const unknown = lifecycleUnknown || Boolean(metadata && !metadata.checkpointed && metadata.reason !== "budget" && metadata.reason !== "busy");
  if (unknown) lifecycleUnknown = true;
  const result = {
    ownerInstance: lifecycleOwnerInstance,
    generation: request.generation,
    requestId: request.requestId,
    quiesced: lifecycleQuiesced,
    pendingOperations,
    retainedPeers: peers.size,
    retainedReset: requestedReset,
    retainedSchedule: retainedDueAt !== null || wakeAfterTick || transcriptsChanged,
    pressureWaiters: pressureWaiters.size,
    pressurePending: pending,
    budgetRunning: checkingBudget,
    unknown,
    producerSettled: producerSettled && !unknown,
    reason: unknown ? "unknown" : producerSettled ? "owner_unsupported" : "pending",
    metadata,
    handlesRetained: true,
    ownershipReleased: false
  };
  parentPort?.postMessage({ historyCheckpoint: result });
}
var idle = new IdleBackoff(HISTORY_TICK_MS);
var pauseUntil = 0;
var storageBudgetPaused = false;
var migrationFailure = historyMigrationFailure(db);
var importFailurePath = join(workerData.home, "history-import-failure.json");
var savedImportFailure = readHistoryJson(importFailurePath);
var importState = isRecord(savedImportFailure) ? savedImportFailure : {};
function saveImportState() {
  writeJsonStore(importFailurePath, { importVersion: 1, ...importState }, readHistoryJson(importFailurePath));
}
if (migrationFailure) parentPort?.postMessage({ error: migrationFailure });
var ioBytesPerSecond = Number(process.env.AGENT_BRIDGE_HISTORY_MIGRATION_IO_BYTES_PER_SECOND || HISTORY_IO_BYTES_PER_SECOND);
var migrationProgress = readHistoryMigrationProgress(db, ioBytesPerSecond);
if (typeof importState.error === "string") migrationProgress = { ...migrationProgress, error: importState.error, paused: true };
var pressureWaiters = /* @__PURE__ */ new Set();
var peers = /* @__PURE__ */ new Map();
var configCache = null;
function currentConfig() {
  let signature = "missing";
  try {
    signature = fileSignature(statSync(join(workerData.home, CONFIG_FILE_NAME), { bigint: true }));
  } catch {
  }
  if (configCache?.signature !== signature) configCache = { signature, value: loadConfig(workerData.home, "other", nullLogger) };
  return configCache.value;
}
function enabled() {
  return currentConfig().history.ingest;
}
function reportPaused(paused2) {
  migrationProgress = { ...migrationProgress, paused: paused2, phase: paused2 && migrationProgress.phase === "starting" ? "paused" : migrationProgress.phase };
  parentPort?.postMessage({ migrationProgress });
}
reportPaused(!enabled() || Boolean(importState.error));
var paused = () => pending || Date.now() < pauseUntil || !enabled() || storageBudgetPaused;
function applyStorageBudget(budget) {
  storageBudgetPaused = budget.paused;
  if (budget.paused) {
    migrationProgress = { ...migrationProgress, paused: true, error: `History storage budget reached (${budget.bytes}/${budget.budgetBytes} bytes); import paused, sources, cursors and all archives retained. Raise history.budgetBytes to resume; never prune user data.` };
    parentPort?.postMessage({ migrationProgress });
  } else if (migrationProgress.error?.startsWith("History storage budget reached")) migrationProgress = { ...migrationProgress, error: null };
}
var budgetAdmission = new HistoryBudgetAdmission(async () => {
  const started = performance.now();
  const config = currentConfig();
  const mirrors = ownsProjectMirrors(workerData.home) ? db.prepare("SELECT DISTINCT project FROM conversations WHERE project != ''").all().map((row) => dirname(projectDatabasePath(String(row.project), workerData.home))) : [];
  const budget = await historyBudget(workerData.home, config.history.budgetBytes, mirrors);
  parentPort?.postMessage({ historyTiming: { budgetScanMs: performance.now() - started } });
  applyStorageBudget(budget);
  return budget;
});
var checkingBudget = false;
function budgetTick() {
  if (checkingBudget || stopped || lifecycleQuiesced) return;
  const finish = acceptOperation();
  checkingBudget = true;
  void budgetAdmission.refresh().catch((error) => {
    storageBudgetPaused = true;
    parentPort?.postMessage({ error: String(error) });
  }).finally(() => {
    checkingBudget = false;
    finish();
  });
}
var budgetTimer = setInterval(budgetTick, 1e3);
budgetTimer.unref();
async function waitForPressureGap() {
  while (pending && !stopped) await new Promise((resolve) => {
    pressureWaiters.add(resolve);
  });
}
function releasePressure() {
  for (const resolve of pressureWaiters) resolve();
  pressureWaiters.clear();
}
async function tick(reset = false) {
  if (reset) requestedReset = true;
  if (running || stopped) return { work: 0, discovering: !ready };
  if (pending || Date.now() < pauseUntil || !enabled()) {
    reportPaused(true);
    return { work: 0, discovering: !ready };
  }
  running = true;
  const started = performance.now();
  const phases = {};
  let phase = "budgetMs", phaseStarted = started;
  const step = (next) => {
    const now = performance.now();
    phases[phase] = (phases[phase] ?? 0) + now - phaseStarted;
    phase = next;
    phaseStarted = now;
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
      importState = { ...retainedState, history: [...importState.history ?? [], priorError] };
      saveImportState();
      migrationProgress = { ...migrationProgress, error: null };
    }
    step("observerNotifyMs");
    reportPaused(false);
    step("migrationMs");
    if (!ready) {
      try {
        await migrateHistoryStore(workerData.bridge, db, paused, () => stopped, (owner) => parentPort?.postMessage({ migrationLease: owner }), reset, { ioBytesPerSecond, onProgress: (progress) => {
          migrationProgress = progress;
          parentPort?.postMessage({ migrationProgress });
        } });
        migrationFailure = null;
      } catch (err) {
        migrationFailure = historyMigrationFailure(db);
        throw err;
      }
      step("indexInitMs");
      index ??= new HistoryIndex(db, workerData.home, paths, source);
      step("ingestInitMs");
      if (!ingest) {
        ingest = new ConversationIngestor(db, workerData.home, paths, source);
        ingest.onChange = onTranscriptChange;
        const registering = index;
        ingest.onUnknownPaths = (changed) => {
          registering.registerChanged(changed);
        };
      }
      ready = true;
    }
    step("admissionCheckMs");
    if (!index || !ingest) return { work: 0, discovering: true };
    if (stopped || paused()) return { work: 0, discovering: true };
    step("legacyTailMs");
    let legacyWork = 0;
    try {
      legacyWork = copyLegacyConversationTail(source, db);
    } catch (error) {
      if (!stopped) parentPort?.postMessage({ error: `legacy history tail deferred; originals retained: ${String(error)}` });
    }
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
    for (const [id, peer] of [...peers].slice(0, 32)) {
      index.rememberPeer(peer);
      peers.delete(id);
    }
    if (reset) {
      index.reset();
      activeReset = false;
      unappliedReset = false;
      requestedReset = false;
    }
    step("ingestMs");
    const rawWork = ingest.tick();
    step("indexWakeMs");
    if (transcriptsChanged) {
      transcriptsChanged = false;
      index.wake();
    }
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
    if (error.code === "HISTORY_IMPORT_VERIFICATION_FAILED") {
      importState = { ...importState, error: String(error) };
      saveImportState();
      migrationProgress = { ...migrationProgress, error: importState.error, paused: true };
      parentPort?.postMessage({ migrationProgress });
    }
    throw error;
  } finally {
    step("completionMs");
    if (activeReset) {
      unappliedReset = true;
      if (lifecycleQuiesced) requestedReset = true;
    }
    activeReset = false;
    running = false;
    budgetAdmission.complete();
    step("timingNotifyMs");
    parentPort?.postMessage({ historyTiming: { ...phases, totalMs: performance.now() - started } });
  }
}
var dueAt = 0;
var transcriptsChanged = false;
var wakeAfterTick = false;
var liveAfterTick = false;
var lastTickAt = 0;
var firing = 0;
var LIVE_WAKE_MS = 15;
var LIVE_GAP_MS = 100;
function wakeSoon() {
  if (lifecycleQuiesced) return;
  if (stopped) return;
  idle.reset();
  if (running || firing) {
    liveAfterTick = true;
    return;
  }
  const delay = Math.max(LIVE_WAKE_MS, lastTickAt + LIVE_GAP_MS - Date.now());
  if (timer && dueAt - Date.now() <= delay) return;
  schedule(delay);
}
var onTranscriptChange = () => {
  transcriptsChanged = true;
  if (lifecycleQuiesced && checkpointReported) parentPort?.postMessage({ historyLifecycleChanged: true });
  wakeSoon();
};
function schedule(delay = HISTORY_TICK_MS) {
  if (stopped) return;
  if (lifecycleQuiesced) {
    retainedDueAt = Date.now() + delay;
    return;
  }
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
      const pressureStarted = performance.now();
      await waitForPressureGap();
      parentPort?.postMessage({ historyTiming: {
        scheduleWaitMs: firedAt - scheduledAt,
        scheduleDelayMs: delay,
        scheduleLateMs: Math.max(0, firedAt - scheduledAt - delay),
        acceptMs,
        schedulePressureWaitMs: performance.now() - pressureStarted
      } });
      if (!migrationFailure && !importState.error) {
        const result = await tick();
        if (result.work || result.discovering && enabled()) next = idle.next(result.work, result.discovering);
      }
    } catch (err) {
      if (err.code !== "HISTORY_SNAPSHOT_PAUSED" && !stopped) parentPort?.postMessage({ error: String(err) });
      pauseUntil = Date.now() + 5e3;
    }
    lastTickAt = Date.now();
    if (liveAfterTick) {
      liveAfterTick = false;
      next = Math.min(next, LIVE_GAP_MS);
    }
    if (wakeAfterTick) {
      wakeAfterTick = false;
      next = 0;
    }
    firing--;
    schedule(next);
    const finishStarted = performance.now();
    finish();
    parentPort?.postMessage({ historyTiming: { operationFinishCheckpointMs: performance.now() - finishStarted } });
  }, delay);
}
function close() {
  if (budgetTimer) clearInterval(budgetTimer);
  index?.close();
  ingest?.close();
  source.close();
  db.close();
  closeMetadataDbs();
  parentPort?.close();
}
parentPort?.on("message", async (message) => {
  if (message.historyLifecycle) {
    if (typeof lifecycleOwnerInstance !== "string" || message.ownerInstance !== lifecycleOwnerInstance || !Number.isSafeInteger(message.generation) || message.generation < lifecycleGeneration) {
      lifecycleUnknown = true;
      return;
    }
    if (message.historyLifecycle === "quiesce") {
      if (message.generation <= lifecycleGeneration) return;
      lifecycleGeneration = message.generation;
      lifecycleQuiesced = true;
      requestedReset ||= unappliedReset || activeReset;
      checkpointRequest = null;
      checkpointReported = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
        retainedDueAt = dueAt;
      }
      if (budgetTimer) clearInterval(budgetTimer);
      budgetTimer = null;
      return;
    }
    if (message.historyLifecycle === "resume") {
      if (message.generation <= lifecycleGeneration) return;
      lifecycleGeneration = message.generation;
      lifecycleQuiesced = false;
      checkpointRequest = null;
      checkpointReported = false;
      if (!budgetTimer && !stopped) {
        budgetTimer = setInterval(budgetTick, 1e3);
        budgetTimer.unref();
      }
      restoreRetainedSchedule();
      if (retainedDueAt === null && !timer && (wakeAfterTick || peers.size || requestedReset || transcriptsChanged) && !running) schedule(0);
      return;
    }
    if (message.historyLifecycle === "checkpoint") {
      if (!lifecycleQuiesced || message.generation !== lifecycleGeneration || checkpointRequest || typeof message.requestId !== "string" || !Number.isFinite(message.deadline)) {
        lifecycleUnknown = true;
        return;
      }
      checkpointRequest = { requestId: message.requestId, generation: message.generation, deadline: message.deadline };
      reportCheckpoint();
      return;
    }
    lifecycleUnknown = true;
    return;
  }
  if (lifecycleQuiesced && !message.stop && !(message.pressure && !message.pending && !message.lockError)) {
    lifecycleUnknown = true;
    return;
  }
  const finish = acceptOperation();
  try {
    if (message.pressure) {
      const wasPending = pending;
      pending = !!message.pending;
      if (message.lockError) pauseUntil = Date.now() + 5e3;
      if (!pending) {
        releasePressure();
        if (wasPending && !running) {
          idle.reset();
          schedule(0);
        }
      }
      return;
    }
    if (message.peer) {
      peers.set(message.peer.id, message.peer);
      idle.reset();
      if (!running) schedule(0);
      return;
    }
    if (message.wake) {
      idle.reset();
      if (running || firing) wakeAfterTick = true;
      else schedule(0);
      return;
    }
    if (message.stop) {
      stopped = true;
      releasePressure();
      if (timer) clearTimeout(timer);
      while (running || checkingBudget) await yieldTurn(10);
      close();
      return;
    }
    try {
      if (message.reconcileAsks) {
        parentPort?.postMessage({ id: message.id, result: { work: reconcileAskCompletions(join(workerData.home, "jobs.json")), discovering: false } });
        return;
      }
      while (running && !stopped) await yieldTurn(10);
      parentPort?.postMessage({ id: message.id, result: await tick(message.reset) });
    } catch (err) {
      parentPort?.postMessage({ id: message.id, error: String(err) });
    }
  } finally {
    finish();
  }
});
schedule();
