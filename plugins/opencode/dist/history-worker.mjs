import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  historyBudget
} from "./chunks/chunk-2PKS7JZW.mjs";
import {
  ConversationIngestor
} from "./chunks/chunk-FUMBH4J7.mjs";
import {
  HISTORY_TICK_MS,
  HistoryIndex
} from "./chunks/chunk-MLDAU7BS.mjs";
import {
  ownsProjectMirrors,
  projectDatabasePath
} from "./chunks/chunk-7PYLSGO7.mjs";
import {
  HISTORY_IO_BYTES_PER_SECOND,
  copyLegacyConversationTail,
  historyMigrationFailure,
  legacyTailConflicts,
  migrateHistoryStore,
  openHistoryStore,
  readHistoryMigrationProgress
} from "./chunks/chunk-2P6P5FZO.mjs";
import "./chunks/chunk-3CXCL26P.mjs";
import "./chunks/chunk-6RP3VKJ3.mjs";
import {
  reconcileAskCompletions
} from "./chunks/chunk-AGEMLUYH.mjs";
import "./chunks/chunk-KLFFS5AY.mjs";
import {
  loadConfig
} from "./chunks/chunk-2GQW7PXU.mjs";
import "./chunks/chunk-4QXHCXBU.mjs";
import "./chunks/chunk-ZNBE7QJQ.mjs";
import "./chunks/chunk-EUVUYVJQ.mjs";
import "./chunks/chunk-FDMEMG4Z.mjs";
import {
  readHistoryJson
} from "./chunks/chunk-3HR6VMN7.mjs";
import "./chunks/chunk-I6MYXRDE.mjs";
import {
  transcriptPaths
} from "./chunks/chunk-WM3QOXKL.mjs";
import {
  closeMetadataDbs,
  fileSignature,
  isRecord,
  nullLogger,
  writeJsonStore
} from "./chunks/chunk-UNRS7LDN.mjs";
import "./chunks/chunk-VBHAVRFY.mjs";
import {
  CONFIG_FILE_NAME
} from "./chunks/chunk-DLCSA3SJ.mjs";
import "./chunks/chunk-HHAVWD7J.mjs";

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
    signature = fileSignature(statSync(join(workerData.home, CONFIG_FILE_NAME)));
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
async function checkStorageBudget() {
  const config = currentConfig();
  const mirrors = ownsProjectMirrors(workerData.home) ? db.prepare("SELECT DISTINCT project FROM conversations WHERE project != ''").all().map((row) => dirname(projectDatabasePath(String(row.project), workerData.home))) : [];
  const budget = await historyBudget(workerData.home, config.history.budgetBytes, mirrors);
  storageBudgetPaused = budget.paused;
  if (budget.paused) {
    migrationProgress = { ...migrationProgress, paused: true, error: `History storage budget reached (${budget.bytes}/${budget.budgetBytes} bytes); import paused, sources, cursors and all archives retained. Raise history.budgetBytes to resume; never prune user data.` };
    parentPort?.postMessage({ migrationProgress });
  } else if (migrationProgress.error?.startsWith("History storage budget reached")) migrationProgress = { ...migrationProgress, error: null };
  return budget.paused;
}
var checkingBudget = false;
var budgetTimer = setInterval(() => {
  if (!running || checkingBudget || stopped) return;
  checkingBudget = true;
  void checkStorageBudget().catch((error) => {
    storageBudgetPaused = true;
    parentPort?.postMessage({ error: String(error) });
  }).finally(() => {
    checkingBudget = false;
  });
}, 1e3);
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
  try {
    if (await checkStorageBudget()) return { work: 0, discovering: !ready };
    reset = requestedReset;
    requestedReset = false;
    if (migrationFailure && !reset) throw new Error(migrationFailure);
    if (importState.error && !reset) throw new Error(importState.error);
    if (reset && importState.error) {
      const { error: priorError, ...retainedState } = importState;
      importState = { ...retainedState, history: [...importState.history ?? [], priorError] };
      saveImportState();
      migrationProgress = { ...migrationProgress, error: null };
    }
    reportPaused(false);
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
      index ??= new HistoryIndex(db, workerData.home, paths, source);
      if (!ingest) {
        ingest = new ConversationIngestor(db, workerData.home, paths, source);
        ingest.onChange = onTranscriptChange;
      }
      ready = true;
    }
    if (!index || !ingest) return { work: 0, discovering: true };
    if (stopped || paused()) return { work: 0, discovering: true };
    let legacyWork = 0;
    try {
      legacyWork = copyLegacyConversationTail(source, db);
    } catch (error) {
      if (!stopped) parentPort?.postMessage({ error: `legacy history tail deferred; originals retained: ${String(error)}` });
    }
    const conflicts = legacyTailConflicts(db);
    if (conflicts !== legacyConflicts) {
      legacyConflicts = conflicts;
      migrationProgress = { ...migrationProgress, legacyConflicts: conflicts };
      parentPort?.postMessage({ migrationProgress });
      if (conflicts) parentPort?.postMessage({ error: `${conflicts} legacy history tail conflict(s) retained in history.db (history_legacy_conflicts); both originals kept, finalize stays blocked` });
    }
    await yieldTurn(10);
    await waitForPressureGap();
    if (stopped || paused()) return { work: legacyWork, discovering: true };
    for (const [id, peer] of [...peers].slice(0, 32)) {
      index.rememberPeer(peer);
      peers.delete(id);
    }
    if (reset) index.reset();
    const rawWork = ingest.tick();
    if (transcriptsChanged) {
      transcriptsChanged = false;
      index.wake();
    }
    await yieldTurn(10);
    await waitForPressureGap();
    if (stopped || paused()) return { work: legacyWork + rawWork, discovering: true };
    const result = index.tick(true);
    return { work: legacyWork + rawWork + result.work, discovering: result.discovering || ingest.discovering };
  } catch (error) {
    if (error.code === "HISTORY_IMPORT_VERIFICATION_FAILED") {
      importState = { ...importState, error: String(error) };
      saveImportState();
      migrationProgress = { ...migrationProgress, error: importState.error, paused: true };
      parentPort?.postMessage({ migrationProgress });
    }
    throw error;
  } finally {
    running = false;
  }
}
var dueAt = 0;
var transcriptsChanged = false;
var wakeAfterTick = false;
function wakeSoon() {
  if (stopped || !timer || dueAt - Date.now() <= HISTORY_TICK_MS) return;
  idle.reset();
  schedule(HISTORY_TICK_MS);
}
var onTranscriptChange = () => {
  transcriptsChanged = true;
  wakeSoon();
};
function schedule(delay = HISTORY_TICK_MS) {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  dueAt = Date.now() + delay;
  timer = setTimeout(async () => {
    timer = null;
    let next = idle.next(0, false);
    try {
      await waitForPressureGap();
      if (!migrationFailure && !importState.error) {
        const result = await tick();
        if (result.work || result.discovering && enabled()) next = idle.next(result.work, result.discovering);
      }
    } catch (err) {
      if (err.code !== "HISTORY_SNAPSHOT_PAUSED" && !stopped) parentPort?.postMessage({ error: String(err) });
      pauseUntil = Date.now() + 5e3;
    }
    if (wakeAfterTick) {
      wakeAfterTick = false;
      next = 0;
    }
    schedule(next);
  }, delay);
}
function close() {
  clearInterval(budgetTimer);
  index?.close();
  ingest?.close();
  source.close();
  db.close();
  closeMetadataDbs();
  parentPort?.close();
}
parentPort?.on("message", async (message) => {
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
    if (running) wakeAfterTick = true;
    else schedule(0);
    return;
  }
  if (message.stop) {
    stopped = true;
    releasePressure();
    if (timer) clearTimeout(timer);
    while (running) await yieldTurn(10);
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
});
schedule();
