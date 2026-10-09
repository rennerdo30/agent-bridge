import { parentPort, workerData } from "node:worker_threads";
import { dirname } from "node:path";
import { setImmediate as yieldTurn, setTimeout as sleep } from "node:timers/promises";
import { migrateJobArchives } from "./job-archive-migration.js";
import { packArchivedRuns } from "./finished-run-bundles.js";
import { closeMetadataDbs } from "./metadata-db.js";
import { importRunnerFiles, runnerFilesImported } from "./runner-store.js";

const stop = new AbortController();
// The broker asks for a repack of newly archived runs; the long-running import loop picks it up.
let repackRequested = false;
parentPort?.on("message", (message: { stop?: boolean; repack?: boolean }) => {
  if (message?.stop) stop.abort();
  if (message?.repack) repackRequested = true;
});

/** Archived finished runs are packed here, off the broker thread, in bounded batches (AB-208). */
async function packRuns(home: string): Promise<{ packed: number; failed: number }> {
  let packed = 0, failed = 0;
  try {
    while (!stop.signal.aborted) {
      let batchFailures = 0;
      const batch = packArchivedRuns(home, undefined, 100, failure => {
        batchFailures++;
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
  await sleep(first, undefined, { signal: stop.signal });
  for (;;) {
    if (!runnerFilesImported(home)) {
      try {
        const result = await importRunnerFiles(home, { signal: stop.signal });
        if (result.imported || result.remaining) parentPort?.postMessage({ runnerImport: result });
      } catch (error) {
        if (stop.signal.aborted) return;
        parentPort?.postMessage({ runnerImportError: String(error) });
      }
    }
    if (repackRequested) {
      repackRequested = false;
      const runs = await packRuns(home);
      if (runs.packed || runs.failed) parentPort?.postMessage({ packed: runs });
    }
    await sleep(interval, undefined, { signal: stop.signal });
  }
}

const home = dirname(workerData.path);
try {
  if (!workerData.packOnly) parentPort?.postMessage({ result: await migrateJobArchives(workerData.path) });
}
catch (error) { parentPort?.postMessage({ error: String(error) }); }
try {
  const runs = await packRuns(home);
  if (runs.packed || runs.failed) parentPort?.postMessage({ packed: runs });
}
catch (error) { parentPort?.postMessage({ packError: String(error) }); }
try { if (!workerData.packOnly && !stop.signal.aborted) await importRunners(home); }
catch (error) { if (!stop.signal.aborted) parentPort?.postMessage({ runnerImportError: String(error) }); }
finally { closeMetadataDbs(); parentPort?.close(); }
