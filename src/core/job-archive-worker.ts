import { parentPort, workerData } from "node:worker_threads";
import { dirname } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { migrateJobArchives } from "./job-archive-migration.js";
import { packArchivedRuns } from "./finished-run-bundles.js";
import { closeMetadataDbs } from "./metadata-db.js";
import { importRunnerFiles, runnerFilesImported } from "./runner-store.js";

const stop = new AbortController();
// The broker asks for a repack of newly archived runs; the long-running import loop picks it up.
let repackRequested = false;
let lifecycleQuiesced = false, lifecycleUnknown = false, operationActive = true;
let lifecycleRequest: string | null = null, lifecycleRevision = 0;
let idleWake: (() => void) | null = null, resumeWake: (() => void) | null = null;
function reportLifecycle(): void {
  if (lifecycleRevision >= Number.MAX_SAFE_INTEGER) lifecycleUnknown = true;
  else lifecycleRevision++;
  parentPort?.postMessage({ archiveLifecycle: { ownerInstance: workerData.lifecycleOwner, requestId: lifecycleRequest, revision: lifecycleRevision,
    quiesced: lifecycleQuiesced, pendingOperations: operationActive || repackRequested ? 1 : 0, unknown: lifecycleUnknown,
    settled: lifecycleQuiesced && !operationActive && !repackRequested && !lifecycleUnknown && !stop.signal.aborted } });
}
/** Interrupt only an idle scheduling wait, never an accepted migration/pack/import. */
async function idleWait(milliseconds: number): Promise<void> {
  const due = performance.now() + milliseconds;
  while (!stop.signal.aborted) {
    await pauseBetweenOperations();
    const remaining = due - performance.now();
    if (remaining <= 0 || stop.signal.aborted) return;
    await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); stop.signal.removeEventListener("abort", finish); if (idleWake === finish) idleWake = null; resolve(); };
    const timer = setTimeout(finish, remaining); idleWake = finish;
    stop.signal.addEventListener("abort", finish, { once: true });
    });
  }
}
async function pauseBetweenOperations(): Promise<void> {
  while (lifecycleQuiesced && !stop.signal.aborted) {
    if (repackRequested) {
      // A repack accepted before the seal remains work, not a discarded queue.
      repackRequested = false; operationActive = true; reportLifecycle();
      try { const runs = await packRuns(home); if (runs.packed || runs.failed) parentPort?.postMessage({ packed: runs }); }
      catch (error) { lifecycleUnknown = true; parentPort?.postMessage({ packError: String(error) }); }
      finally { operationActive = false; reportLifecycle(); }
      continue;
    }
    reportLifecycle();
    await new Promise<void>(resolve => { resumeWake = resolve; });
    resumeWake = null;
  }
}
parentPort?.on("message", (message: { stop?: boolean; repack?: boolean; archiveLifecycle?: { kind?: string; ownerInstance?: string; requestId?: string } }) => {
  if (message?.stop) stop.abort();
  if (message?.stop) { idleWake?.(); resumeWake?.(); reportLifecycle(); }
  if (message?.repack) { repackRequested = true; reportLifecycle(); if (lifecycleQuiesced) idleWake?.(); resumeWake?.(); }
  const control = message?.archiveLifecycle;
  if (!control) return;
  if (control.ownerInstance !== workerData.lifecycleOwner || typeof control.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(control.requestId)) { lifecycleUnknown = true; reportLifecycle(); return; }
  if (control.kind === "quiesce") { lifecycleQuiesced = true; lifecycleRequest = control.requestId; idleWake?.(); reportLifecycle(); }
  else if (control.kind === "resume" && control.requestId === lifecycleRequest) { lifecycleQuiesced = false; lifecycleRequest = null; resumeWake?.(); reportLifecycle(); }
  else { lifecycleUnknown = true; reportLifecycle(); }
});

/** Archived finished runs are packed here, off the broker thread, in bounded batches (AB-208). */
async function packRuns(home: string): Promise<{ packed: number; failed: number }> {
  let packed = 0, failed = 0;
  try {
    while (!stop.signal.aborted) {
      let batchFailures = 0;
      const batch = packArchivedRuns(home, undefined, 100, failure => {
        batchFailures++;
        lifecycleUnknown = true;
        parentPort?.postMessage({ warning: "archived run kept in place, not packed", failure });
      });
      packed += batch; failed += batchFailures;
      if (!batch && !batchFailures) break;
      await yieldTurn();
    }
  } finally { closeMetadataDbs(); }
  return { packed, failed };
}

/** AB-208: runner spec/state files are imported off the broker thread once no older process writes them.
 * The loop only checks one row per interval; it imports again if an older process reopened the files. */
async function importRunners(home: string): Promise<void> {
  const raw = process.env.AGENT_BRIDGE_RUNNER_IMPORT_DELAY_MS;
  if (raw === "off") return;
  const first = raw === undefined || !/^\d+$/.test(raw) ? 30_000 : Number(raw);
  const interval = 60_000;
  await idleWait(first);
  while (!stop.signal.aborted) {
    await pauseBetweenOperations();
    if (stop.signal.aborted) return;
    operationActive = true; reportLifecycle();
    try {
    if (!runnerFilesImported(home)) {
      try {
        const result = await importRunnerFiles(home, { signal: stop.signal });
        if (result.deferred || result.remaining) lifecycleUnknown = true;
        if (result.imported || result.remaining) parentPort?.postMessage({ runnerImport: result });
      } catch (error) {
        if (stop.signal.aborted) return;
        lifecycleUnknown = true;
        parentPort?.postMessage({ runnerImportError: String(error) });
      }
    }
    if (repackRequested) {
      repackRequested = false;
      const runs = await packRuns(home);
      if (runs.packed || runs.failed) parentPort?.postMessage({ packed: runs });
    }
    } finally { operationActive = false; reportLifecycle(); }
    await idleWait(interval);
  }
}

const home = dirname(workerData.path);
try {
  if (!workerData.packOnly) {
    const result = await migrateJobArchives(workerData.path);
    if (result.deferred || result.kept) lifecycleUnknown = true;
    parentPort?.postMessage({ result });
  }
}
catch (error) { lifecycleUnknown = true; parentPort?.postMessage({ error: String(error) }); }
try {
  const runs = await packRuns(home);
  if (runs.packed || runs.failed) parentPort?.postMessage({ packed: runs });
}
catch (error) { lifecycleUnknown = true; parentPort?.postMessage({ packError: String(error) }); }
operationActive = false; reportLifecycle();
await pauseBetweenOperations();
try { if (!workerData.packOnly && !stop.signal.aborted) await importRunners(home); }
catch (error) { if (!stop.signal.aborted) { lifecycleUnknown = true; parentPort?.postMessage({ runnerImportError: String(error) }); } }
finally { closeMetadataDbs(); parentPort?.close(); }
