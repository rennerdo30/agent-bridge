import { parentPort, workerData } from "node:worker_threads";
import { backupIfDueBackground } from "./backups.js";

const state = new Int32Array(workerData.pressure, 0, 2);
const pauseUntil = new BigInt64Array(workerData.pressure, 8, 1);
let pressureSince = 0;
const checkpoint = () => {
  for (;;) {
    if (Atomics.load(state, 1)) throw new Error("Automatic backup stopped; incomplete snapshot preserved");
    const paused = !!Atomics.load(state, 0) || Date.now() < Number(Atomics.load(pauseUntil, 0));
    if (!paused) { pressureSince = 0; break; }
    pressureSince ||= Date.now();
    if (Date.now() - pressureSince >= 5_000) throw new Error("Automatic backup paused for sustained broker pressure; incomplete snapshot preserved");
    Atomics.wait(state, 0, Atomics.load(state, 0), 100);
  }
  // Small fixed page/chunk windows keep bulk reads, writes, and verification bounded.
  Atomics.wait(state, 1, 0, 5);
};

try {
  const path = await backupIfDueBackground(workerData.home, { checkpoint });
  parentPort?.postMessage({ path });
} catch (error) { parentPort?.postMessage({ error: String(error) }); }
finally { parentPort?.close(); }
