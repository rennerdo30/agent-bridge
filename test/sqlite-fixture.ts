import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { SQLITE_BUSY_TIMEOUT_MS, SQLITE_REQUEST_BUSY_MS } from "../src/core/sqlite-policy.js";

/** Fixture writers share the production bound when background workers own the database. */
export function openFixtureDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
    return db;
  } catch (error) { db.close(); throw error; }
}

/** Hold a real SQLite writer until setup enters its bounded native busy wait. */
export async function holdFixtureWriter(file: string): Promise<{ release(): void; close(): Promise<void> }> {
  const worker = new Worker(`
    const { DatabaseSync } = require("node:sqlite");
    const { parentPort, workerData } = require("node:worker_threads");
    const db = new DatabaseSync(workerData.file);
    db.exec("PRAGMA busy_timeout=" + workerData.busyTimeoutMs);
    db.exec("BEGIN IMMEDIATE");
    parentPort.postMessage("locked");
    parentPort.once("message", () => setTimeout(() => {
      db.exec("COMMIT"); db.close();
    }, workerData.releaseDelayMs));
  `, { eval: true, workerData: { file, busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS, releaseDelayMs: SQLITE_REQUEST_BUSY_MS } });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("message", () => resolve());
      worker.once("error", reject);
      worker.once("exit", code => reject(new Error(`Fixture writer exited before locking (${code})`)));
    });
  } catch (error) { await worker.terminate(); throw error; }
  return {
    release() { worker.postMessage("release"); },
    async close() { await worker.terminate(); },
  };
}
