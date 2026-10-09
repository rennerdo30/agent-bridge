import { parentPort, workerData } from "node:worker_threads";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { migrateJobArchives } from "./job-archive-migration.js";
import { closeMetadataDbs } from "./metadata-db.js";
import { importRunnerFiles, runnerFilesImported } from "./runner-store.js";

const stop = new AbortController();
parentPort?.on("message", (message: { stop?: boolean }) => { if (message?.stop) stop.abort(); });

try { parentPort?.postMessage({ result: await migrateJobArchives(workerData.path) }); }
catch (error) { parentPort?.postMessage({ error: String(error) }); }

// AB-208: runner spec/state files are imported off the broker thread once no older process writes them.
// The loop only checks one row per interval; it imports again if an older process reopened the files.
const raw = process.env.AGENT_BRIDGE_RUNNER_IMPORT_DELAY_MS;
const first = raw === undefined || !/^\d+$/.test(raw) ? 30_000 : Number(raw);
const interval = 60_000;
try {
  if (raw !== "off") {
    await sleep(first, undefined, { signal: stop.signal });
    for (;;) {
      if (!runnerFilesImported(dirname(workerData.path))) {
        try {
          const result = await importRunnerFiles(dirname(workerData.path), { signal: stop.signal });
          if (result.imported || result.remaining) parentPort?.postMessage({ runnerImport: result });
        } catch (error) {
          if (stop.signal.aborted) break;
          parentPort?.postMessage({ runnerImportError: String(error) });
        }
      }
      await sleep(interval, undefined, { signal: stop.signal });
    }
  }
} catch (error) { if (!stop.signal.aborted) parentPort?.postMessage({ runnerImportError: String(error) }); }
finally { closeMetadataDbs(); parentPort?.close(); }
