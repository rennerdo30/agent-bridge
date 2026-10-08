import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { readRehearsalCursor, rehearsalBytes } from "../scripts/release-rehearsal.js";

function checkpoint(): string {
  const root = join(process.cwd(), ".agent-bridge-test"); mkdirSync(root, { recursive: true });
  const snapshot = join(mkdtempSync(join(root, "rehearsal-cursor-")), "snapshot.db");
  const db = new DatabaseSync(`${snapshot}.progress.db`);
  try {
    db.exec("CREATE TABLE table_state(table_name,generation,snapshot_after,snapshot_rows,snapshot_verify_after,snapshot_verify_rows,copy_after,copy_rows,verify_after,verify_rows); INSERT INTO table_state VALUES('conversation_records',0,1,1,NULL,0,NULL,0,NULL,0)");
  } finally { db.close(); }
  return snapshot;
}
async function lock(snapshot: string, milliseconds: number): Promise<Worker> {
  const worker = new Worker(`const {DatabaseSync}=require('node:sqlite'); const {parentPort,workerData}=require('node:worker_threads'); const db=new DatabaseSync(workerData.path); db.exec('BEGIN EXCLUSIVE'); db.prepare('UPDATE table_state SET generation=1').run(); parentPort.postMessage('locked'); setTimeout(()=>{db.exec('COMMIT');db.close()},workerData.milliseconds)`, { eval: true, workerData: { path: `${snapshot}.progress.db`, milliseconds } });
  await new Promise<void>((resolve, reject) => { worker.once("message", () => resolve()); worker.once("error", reject); });
  return worker;
}

describe("opt-in release rehearsal checkpoint inspection", () => {
  it("parses bounded opt-in sizes", () => {
    expect(rehearsalBytes("8MiB")).toBe(8 * 1024 ** 2);
    expect(rehearsalBytes("20GiB")).toBe(20 * 1024 ** 3);
    expect(() => rehearsalBytes("65GiB")).toThrow();
  });
  it("yields and retries a transient exclusive checkpoint lock", async () => {
    const snapshot = checkpoint(), worker = await lock(snapshot, 350);
    try { expect(await readRehearsalCursor({ snapshot })).toMatchObject({ generation: 1, snapshot_after: 1 }); }
    finally { await worker.terminate(); }
  });
  it("fails bounded inspection without treating a persistent lock as verification failure", async () => {
    const snapshot = checkpoint(), worker = await lock(snapshot, 2000), started = performance.now();
    try {
      await expect(readRehearsalCursor({ snapshot }, 150)).rejects.toThrow("Checkpoint inspection remained busy");
      expect(performance.now() - started).toBeLessThan(1000);
    } finally { await worker.terminate(); }
  });
});
