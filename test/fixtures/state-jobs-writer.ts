import type { DatabaseSync } from "node:sqlite";
import { SHADOW_JOBS_SCHEMA } from "../../src/core/state-jobs.js";

/** TEST ONLY: fabricated scope/session rows, never a production witness. */
export function seedShadowFixture(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  db.exec(SHADOW_JOBS_SCHEMA);
  db.prepare("INSERT INTO shadow_scope VALUES (1,?,?,?,?,?,?)").run("fixture-install", "fixture-lineage", "1", "fixture-instance", "0", "shadow");
  db.prepare("INSERT INTO shadow_sessions VALUES (?,?,?,?)").run("fixture-session", "1", "1", "connected");
}
export const fixtureTransport = () => Buffer.from(JSON.stringify({ installation: "fixture-install", lineage: "fixture-lineage",
  epoch: "1", instance: "fixture-instance", sessionId: "fixture-session", registration: "1" }));
export const fixtureRequest = (overrides: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
  commandId: "create-job", operation: "create", installation: "fixture-install", lineage: "fixture-lineage",
  authorityGeneration: "1", jobId: "fixture-job", turnGeneration: "1", expectedVersion: "0",
  sessionId: "fixture-session", sessionGeneration: "1", ...overrides,
}));

/** Real concurrent SQLite writers use a shared start barrier. The production
 * module is transpiled into a disconnected worker module by the HOSTED test.
 * No native runner, provider, Bridge session or owner runtime is involved.
 */
export const shadowWriterProgram = `
const {workerData,parentPort}=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite');
(async()=>{
 const {ShadowJobsLedger}=await import(workerData.moduleUrl);
 const db=new DatabaseSync(workerData.path);
 db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
 const gate=new Int32Array(workerData.gate);
 parentPort.postMessage({ready:true});
 Atomics.wait(gate,0,0);
 try{parentPort.postMessage({result:new ShadowJobsLedger(db).applyShadowCommand(Buffer.from(workerData.request),Buffer.from(workerData.transport))});}
 finally{db.close();}
})().catch(error=>{parentPort.postMessage({error:String(error)});process.exitCode=1;});`;
