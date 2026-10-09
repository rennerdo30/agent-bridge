import { parentPort, workerData } from "node:worker_threads";
import { migrateJobArchives } from "./job-archive-migration.js";

try { parentPort?.postMessage({ result: await migrateJobArchives(workerData.path) }); }
catch (error) { parentPort?.postMessage({ error: String(error) }); }
finally { parentPort?.close(); }
