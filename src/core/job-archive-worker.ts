import { parentPort, workerData } from "node:worker_threads";
import { dirname } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { migrateJobArchives } from "./job-archive-migration.js";
import { packArchivedRuns } from "./finished-run-bundles.js";
import { closeMetadataDbs } from "./metadata-db.js";

let stopped = false;
parentPort?.on("message", message => { if (message?.stop) stopped = true; });

/** Archived finished runs are packed here, off the broker thread, in bounded batches (AB-208). */
async function packRuns(home: string): Promise<{ packed: number; failed: number }> {
  let packed = 0, failed = 0;
  try {
    while (!stopped) {
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

try {
  if (!workerData.packOnly) parentPort?.postMessage({ result: await migrateJobArchives(workerData.path) });
}
catch (error) { parentPort?.postMessage({ error: String(error) }); }
try {
  const runs = await packRuns(dirname(workerData.path));
  if (runs.packed || runs.failed) parentPort?.postMessage({ packed: runs });
}
catch (error) { parentPort?.postMessage({ packError: String(error) }); }
finally { parentPort?.close(); }
