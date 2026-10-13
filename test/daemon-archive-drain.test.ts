import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobArchiveBackground } from "../src/core/job-archive-background.js";
import { openJobArchive } from "../src/core/job-archive-index.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv, archive: JobArchiveBackground | undefined, lock: DatabaseSync | undefined;
beforeEach(() => { env = makeEnv(); vi.stubEnv("AGENT_BRIDGE_RUNNER_IMPORT_DELAY_MS", "60000"); });
afterEach(async () => {
  if (lock?.isTransaction) lock.exec("ROLLBACK"); lock?.close(); lock = undefined;
  await archive?.close(); archive = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await env.cleanup();
});
const deadline = () => performance.now() + 2000;
const jobs = () => join(env.home, "jobs.json");
async function normalIdle() {
  // Fixture setup observes actual completed initial work, not a longer lifecycle
  // budget or a claim that a cold worker can drain inside the production phase.
  await until(() => archive!.lifecycleOwnerManifest().pendingOperations === 0);
  expect(archive!.lifecycleOwnerManifest().unknown).toBe(false);
}

describe("archive reversible producer seal (not store release/durability)", () => {
  it("actual idle ACK is bound to the same worker, and serialization/resume/close invalidate the witness", async () => {
    archive = new JobArchiveBackground(jobs(), nullLogger); await normalIdle();
    const worker = Reflect.get(archive, "worker"), terminate = vi.spyOn(worker, "terminate"), post = vi.spyOn(worker, "postMessage");
    archive.quiesceLifecycleMaintenance();
    const witness = await archive.settleLifecycleMaintenance(deadline());
    expect(witness).toMatchObject({ settled: true, pendingWorkers: 1, pendingOperations: 0, unknown: false, ownershipReleased: false });
    expect(archive.isCurrentLifecycleWitness(witness, () => true)).toBe(true);
    expect(archive.isCurrentLifecycleWitness({ ...witness }, () => true)).toBe(false);
    expect(archive.isCurrentLifecycleWitness(witness, () => false)).toBe(false);
    archive.resumeLifecycleMaintenance();
    expect(archive.isCurrentLifecycleWitness(witness, () => true)).toBe(false); expect(Reflect.get(archive, "worker")).toBe(worker);
    expect(terminate).not.toHaveBeenCalled(); expect(post.mock.calls.some(call => call[0]?.stop)).toBe(false);
    await archive.close(); expect(archive.lifecycleOwnerManifest().closed).toBe(true);
  });
  it("actual migration blocked by its fixture-owned SQL writer remains alive at observer timeout; no cancellation or second worker", async () => {
    lock = openJobArchive(jobs(), true)!;
    lock.exec("CREATE TABLE retained_fixture(body BLOB); INSERT INTO retained_fixture VALUES(X'00ff33'); BEGIN IMMEDIATE");
    archive = new JobArchiveBackground(jobs(), nullLogger);
    const worker = Reflect.get(archive, "worker"), post = vi.spyOn(worker, "postMessage"), terminate = vi.spyOn(worker, "terminate");
    archive.quiesceLifecycleMaintenance();
    const pending = archive.settleLifecycleMaintenance(performance.now() + 20);
    expect(await archive.settleLifecycleMaintenance(deadline())).toMatchObject({ settled: false, pendingWorkers: 1 });
    expect(await pending).toMatchObject({ settled: false, pendingWorkers: 1 });
    expect(Reflect.get(archive, "worker")).toBe(worker); expect(terminate).not.toHaveBeenCalled();
    expect(post.mock.calls.some(call => call[0]?.stop)).toBe(false);
    expect(lock.prepare("SELECT body FROM retained_fixture").get()!.body).toEqual(new Uint8Array([0, 255, 51]));
    lock.exec("ROLLBACK"); lock.close(); lock = undefined;
    await normalIdle();
    expect(await archive.settleLifecycleMaintenance(deadline())).toMatchObject({ settled: true, ownershipReleased: false });
    const observed = new DatabaseSync(join(env.home, "job-archive.db"), { readOnly: true });
    try { expect(observed.prepare("SELECT body FROM retained_fixture").get()!.body).toEqual(new Uint8Array([0, 255, 51])); }
    finally { observed.close(); }
    archive.resumeLifecycleMaintenance(); expect(Reflect.get(archive, "worker")).toBe(worker);
  });
  it("repack while sealed is retained and blocks the witness, then resume delivers it exactly once to the same worker", async () => {
    archive = new JobArchiveBackground(jobs(), nullLogger); await normalIdle();
    const worker = Reflect.get(archive, "worker"); archive.quiesceLifecycleMaintenance();
    const witness = await archive.settleLifecycleMaintenance(deadline()); expect(witness.settled).toBe(true);
    const post = vi.spyOn(worker, "postMessage"); archive.repack(); archive.repack();
    expect(archive.lifecycleOwnerManifest()).toMatchObject({ queuedRepack: true, settled: false });
    expect(archive.isCurrentLifecycleWitness(witness, () => true)).toBe(false); expect(post).not.toHaveBeenCalled();
    archive.resumeLifecycleMaintenance();
    expect(post.mock.calls.filter(call => call[0]?.repack)).toHaveLength(1);
    expect(Reflect.get(archive, "worker")).toBe(worker); expect(archive.lifecycleOwnerManifest().queuedRepack).toBe(false);
  });
  it("SIMULATED late owned worker error latches unknown and invalidates a full witness", async () => {
    archive = new JobArchiveBackground(jobs(), nullLogger); await normalIdle(); archive.quiesceLifecycleMaintenance();
    const witness = await archive.settleLifecycleMaintenance(deadline()); expect(witness.settled).toBe(true);
    Reflect.get(archive, "worker").emit("error", new Error("SIMULATED owned worker error"));
    expect(archive.lifecycleOwnerManifest()).toMatchObject({ unknown: true, settled: false });
    expect(archive.isCurrentLifecycleWitness(witness, () => true)).toBe(false);
    archive.resumeLifecycleMaintenance(); expect(archive.lifecycleOwnerManifest().unknown).toBe(true);
  });
});
