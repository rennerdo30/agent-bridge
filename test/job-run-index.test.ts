import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { basename, join } from "node:path";
import { Worker } from "node:worker_threads";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import * as history from "../src/core/run-history.js";
import * as archive from "../src/core/job-archive-index.js";
import * as recoveryFeed from "../src/core/job-recovery-feed.js";
import { recoverJobRecord, recoverJobRecordAsync } from "../src/core/job-recovery.js";
import * as index from "../src/core/job-run-index.js";
import { indexedJobRun, indexJobRun, JOB_INDEX_BUSY_WAIT_MS, jobRunIndexReady, JOB_INDEX_WAIT_MS, startBrokerJobRunIndex, startJobRunBackfill, stopJobRunBackfill, waitForJobRunIndex } from "../src/core/job-run-index.js";
import * as fileCache from "../src/core/file-cache.js";
import { APP_VERSION } from "../src/core/constants.js";
import { metadataFileLease } from "../src/core/metadata-file-lease.js";
import { closeMetadataDb, metadataDb, metadataDbOpen } from "../src/core/metadata-db.js";
import { archiveOldRuns, archiveRun } from "../src/core/run-archive.js";
import { packFinishedRuns } from "../src/core/finished-run-bundles.js";
import { startRunFeed } from "../src/core/runfeed.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await stopJobRunBackfill(env.home); await env.cleanup(); });
function fixture(id = "legacy", run = "arbitrary-native-turn", startedAt = 1) {
  const dir = join(env.home, "runs"), name = `codex-job-${id}`;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${run}.log`), metadata = join(dir, `${run}.json`), prompt = `exact task for ${id}\n  retained spacing 🌍`;
  writeFileSync(file, `header by owner\n${prompt.split("\n").map(line => `         ${line}`).join("\n")}\n         ---\n00:00:01 finished after 1s · done\n`);
  writeFileSync(metadata, JSON.stringify({ job: name, jobStartedAt: startedAt, session: `native-${id}`, by: "owner", access: "read", effort: "high" }));
  return { name, file, metadata, prompt };
}
function heldScan() {
  const original = history.readRunLogsResponsive;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const scan = vi.spyOn(history, "readRunLogsResponsive").mockImplementation(async (...args) => { entered(); await gate; return original(...args); });
  return { scan, release, started };
}
it("completes backfill while a feed publishes progress after catalog observation", async () => {
  const f = fixture(), original = history.readRunLogsResponsive;
  const feed = startRunFeed({ home: env.home, name: "active-writer", header: "active", meta: { job: "codex-job-active", jobStartedAt: 2 } });
  vi.spyOn(history, "readRunLogsResponsive").mockImplementationOnce(async (...args) => {
    const records = await original(...args);
    feed.meta({ percent: 42, progressNote: "still running" });
    return records;
  });
  try { await startJobRunBackfill(env.home); expect(jobRunIndexReady(env.home)).toBe(true); expect(indexedJobRun(env.home, f.name)).toHaveLength(1); }
  finally { feed.end("done"); }
});
it("keeps routing discovery complete when metadata is replaced at every scan suspension", async () => {
  fixture(); const feed = startRunFeed({ home: env.home, name: "continuous-progress", header: "active", meta: { job: "codex-job-active", jobStartedAt: 2 } });
  vi.spyOn(history, "readRunLogsResponsive").mockImplementationOnce(async (home, names, complete) => {
    const scan = history.readRunLogsSteps(home, names, true, complete, true);
    for (;;) {
      const step = scan.next(); if (step.done) return step.value;
      feed.meta({ percent: 42, progressNote: "concurrent progress" }); await yieldTurn();
    }
  });
  try { await startJobRunBackfill(env.home); expect(jobRunIndexReady(env.home)).toBe(true); }
  finally { feed.end("done"); }
});
it("retains routing changes once and performs no index writes for progress-only patches", async () => {
  metadataDb(env.home); // The index lives in an existing metadata store.
  const feed = startRunFeed({ home: env.home, name: "progress", header: "active", meta: { job: "codex-job-progress", jobStartedAt: 2 } });
  const db = metadataDb(env.home), changes = () => Number(db.prepare("SELECT total_changes() n").get()!.n);
  try {
    const before = changes(); feed.meta({ percent: 42 }); feed.meta({ session: "learned-native" });
    expect(changes()).toBe(before);
    expect(indexedJobRun(env.home, "codex-job-progress")[0]!.meta.session).toBe("learned-native");
    expect(Number(db.prepare("SELECT count(*) n FROM bridge_metadata WHERE domain='job-run-history-v1'").get()!.n)).toBe(1);
  } finally { feed.end("done"); }
});
it("rejects current metadata that contradicts the indexed key and never indexes conflicting suffixes", async () => {
  const f = fixture("actual", "2026-10-01-00-00-00-codex-other"); await startJobRunBackfill(env.home);
  expect(indexedJobRun(env.home, "codex-job-other")).toEqual([]);
  writeFileSync(f.metadata, JSON.stringify({ job: "codex-job-reused", jobStartedAt: 2, session: "other-native" }));
  expect(indexedJobRun(env.home, f.name)).toEqual([]);
});
it("never enriches a newer history turn from a stale routing head or reused filename", async () => {
  const f = fixture(); await startJobRunBackfill(env.home);
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ id: "legacy", name: f.name, agent: "codex", owner: "owner", startedAt: 2, status: "done" }] }));
  const recovered = await recoverJobRecordAsync(env.home, f.name);
  expect(recovered?.prompt ?? "").toBe(""); expect(recovered?.sessionId ?? null).toBeNull();
});
it("revalidates a reused name's generation even when its new index write was lost", async () => {
  const f = fixture(); await startJobRunBackfill(env.home);
  writeFileSync(f.metadata, JSON.stringify({ job: f.name, jobStartedAt: 2, session: "reused-native", by: "owner" }));
  expect(indexedJobRun(env.home, f.name, 1)).toEqual([]);
  expect(indexedJobRun(env.home, f.name, 2)[0]!.meta.session).toBe("reused-native");
});
it("rolls back history and head together when an index statement fails", () => {
  fixture(); const record = history.readRunLogs(env.home)[0]!, db = metadataDb(env.home);
  db.exec("CREATE TRIGGER fail_head BEFORE INSERT ON bridge_metadata WHEN NEW.domain='job-run-head-v1' BEGIN SELECT RAISE(ABORT,'synthetic head failure'); END");
  expect(() => indexJobRun(env.home, record)).toThrow("synthetic head failure");
  expect(Number(db.prepare("SELECT count(*) n FROM bridge_metadata WHERE domain IN ('job-run-head-v1','job-run-history-v1')").get()!.n)).toBe(0);
  expect(db.isTransaction).toBe(false); expect(db.prepare("PRAGMA busy_timeout").get()!.timeout).toBe(5000);
});
it("uses one transaction and a bounded SQLite lock wait off the broker for an entire route update", () => {
  fixture(); const record = history.readRunLogs(env.home)[0]!, db = metadataDb(env.home);
  const exec = vi.spyOn(db, "exec"); indexJobRun(env.home, record);
  expect(exec.mock.calls.map(call => call[0])).toEqual([`PRAGMA busy_timeout=${JOB_INDEX_BUSY_WAIT_MS}`, "BEGIN IMMEDIATE", "COMMIT", "PRAGMA busy_timeout=5000"]);
  const other = new DatabaseSync(join(env.home, "bridge.db")); other.exec("BEGIN IMMEDIATE");
  try {
    exec.mockClear(); expect(() => indexJobRun(env.home, { ...record, file: record.file + ".moved" })).toThrow();
    expect(exec.mock.calls.map(call => call[0])).toEqual([`PRAGMA busy_timeout=${JOB_INDEX_BUSY_WAIT_MS}`, "BEGIN IMMEDIATE", "PRAGMA busy_timeout=5000"]);
  } finally { other.exec("ROLLBACK"); other.close(); }
});
it("keeps zero SQLite lock wait for index transactions in the broker", async () => {
  fixture(); await startBrokerJobRunIndex(env.home);
  const record = history.readRunLogs(env.home)[0]!, db = metadataDb(env.home), exec = vi.spyOn(db, "exec");
  indexJobRun(env.home, { ...record, file: record.file + ".broker" });
  expect(exec.mock.calls.map(call => call[0])).toEqual(["PRAGMA busy_timeout=0", "BEGIN IMMEDIATE", "COMMIT", "PRAGMA busy_timeout=5000"]);
});
it("waits briefly off the broker when an index write hits SQLITE_BUSY from another connection", async () => {
  fixture(); await startJobRunBackfill(env.home);
  const late = fixture("busy", "busy-native-turn", 5), flags = new Int32Array(new SharedArrayBuffer(8));
  const holder = new Worker(`
    const { workerData } = require("node:worker_threads"), { DatabaseSync } = require("node:sqlite");
    const flags = new Int32Array(workerData.flags), db = new DatabaseSync(workerData.db);
    db.exec("BEGIN IMMEDIATE"); Atomics.store(flags, 0, 1); Atomics.notify(flags, 0);
    Atomics.wait(flags, 1, 0, 10000); Atomics.wait(flags, 1, 1, 10);
    db.exec("ROLLBACK"); db.close();`, { eval: true, workerData: { db: join(env.home, "bridge.db"), flags: flags.buffer } });
  const exited = new Promise(resolve => holder.once("exit", resolve));
  try {
    expect(Atomics.wait(flags, 0, 0, 10000)).not.toBe("timed-out");
    Atomics.store(flags, 1, 1); Atomics.notify(flags, 1);
    index.indexRunFile(env.home, late.file); // The other connection still holds the write lock; it ends 10 ms after the signal.
  } finally { Atomics.store(flags, 1, 1); Atomics.notify(flags, 1); await exited; }
  expect(jobRunIndexReady(env.home)).toBe(true); expect(existsSync(join(env.home, "job-run-index.dirty"))).toBe(false);
  expect(indexedJobRun(env.home, late.name)).toHaveLength(1);
});
it("retains an invalidation receipt even when SQLite cannot commit the readiness fence", async () => {
  const f = fixture(); await startJobRunBackfill(env.home);
  const db = metadataDb(env.home), complete = () => db.prepare("SELECT value FROM bridge_metadata WHERE domain='job-run-index-v1' AND key='complete'").get()!.value;
  const before = complete(), other = new DatabaseSync(join(env.home, "bridge.db")); other.exec("BEGIN IMMEDIATE");
  try {
    index.invalidateJobRunIndex(env.home);
    expect(complete()).toBe(before); expect(readFileSync(join(env.home, "job-run-index.dirty"), "utf8")).toBe("\n");
    expect(jobRunIndexReady(env.home)).toBe(false);
  } finally { other.exec("ROLLBACK"); other.close(); }
  await startJobRunBackfill(env.home);
  expect(jobRunIndexReady(env.home)).toBe(true); expect(indexedJobRun(env.home, f.name)).toHaveLength(1);
  expect(readFileSync(join(env.home, "job-run-index.dirty"), "utf8")).toBe("\n");
});
it("retries failed backfill in the background with no new request", async () => {
  fixture(); const original = history.readRunLogsResponsive;
  const scan = vi.spyOn(history, "readRunLogsResponsive").mockRejectedValueOnce(new Error("synthetic IO failure")).mockImplementation(original);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await expect(startJobRunBackfill(env.home)).rejects.toThrow("synthetic IO failure");
  expect(jobRunIndexReady(env.home)).toBe(false);
  await vi.advanceTimersByTimeAsync(250); vi.useRealTimers();
  await until(() => jobRunIndexReady(env.home)); expect(scan).toHaveBeenCalledTimes(2);
});
it("reports a failed backfill as unavailable so callers discover instead of failing", async () => {
  fixture(); vi.spyOn(history, "readRunLogsResponsive").mockRejectedValue(new Error("synthetic discovery failure"));
  await expect(waitForJobRunIndex(env.home, performance.now() + JOB_INDEX_WAIT_MS)).resolves.toBe("discover");
});
it("continues a cold job through bounded discovery when the backfill fails with SQLITE_BUSY", async () => {
  const f = fixture(), original = history.readRunLogsResponsive;
  const busy = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
  const scan = vi.spyOn(history, "readRunLogsResponsive").mockRejectedValueOnce(busy).mockImplementation(original);
  expect(await recoverJobRecordAsync(env.home, f.name)).toMatchObject({ prompt: f.prompt, sessionId: "native-legacy", args: { access: "read", effort: "high" } });
  expect(scan.mock.calls.length).toBeGreaterThanOrEqual(2); // The failed backfill scan, then discovery.
});
it("retries a busy backfill batch asynchronously on the broker and completes", async () => {
  const f = fixture(), begins = vi.spyOn(metadataDb(env.home), "exec");
  const other = new DatabaseSync(join(env.home, "bridge.db")); other.exec("BEGIN IMMEDIATE");
  let settled = false;
  const work = startBrokerJobRunIndex(env.home).finally(() => { settled = true; });
  try {
    // Zero busy wait on the broker: the batch meets SQLITE_BUSY and backs off without blocking.
    await until(() => db_begins() > 1); expect(settled).toBe(false);
  } finally { other.exec("ROLLBACK"); other.close(); }
  await work;
  expect(jobRunIndexReady(env.home)).toBe(true); expect(indexedJobRun(env.home, f.name)).toHaveLength(1);
  function db_begins() { return begins.mock.calls.filter(call => call[0] === "BEGIN IMMEDIATE").length; }
});
it("reobserves an unseen legacy key introduced after eager empty completion", async () => {
  await startJobRunBackfill(env.home); expect(jobRunIndexReady(env.home)).toBe(true);
  const f = fixture("late-key");
  expect(await recoverJobRecordAsync(env.home, f.name)).toMatchObject({ prompt: f.prompt, sessionId: "native-late-key" });
});
it("accepts unique metadata with an unknown generation and discovers ambiguous metadata", async () => {
  const f = fixture("unknown-generation");
  writeFileSync(f.metadata, JSON.stringify({ job: f.name, session: "legacy-native", by: "owner" }));
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ id: "unknown-generation", name: f.name, agent: "codex", owner: "owner", startedAt: 1, status: "done" }] }));
  await startJobRunBackfill(env.home);
  expect(await recoverJobRecordAsync(env.home, f.name)).toMatchObject({ prompt: f.prompt, sessionId: "legacy-native" });
  const second = fixture("unknown-generation", "second-native-turn", 2);
  writeFileSync(second.metadata, JSON.stringify({ job: f.name, session: "other-legacy-native", by: "owner" }));
  index.invalidateJobRunIndex(env.home); await startJobRunBackfill(env.home);
  // Neither unknown generation becomes proof just because it was indexed last.
  const scan = vi.spyOn(history, "readRunLogsResponsive");
  const recovered = await recoverJobRecordAsync(env.home, f.name);
  expect(scan).toHaveBeenCalled();
  expect(recovered?.prompt ?? "").toBe(""); expect(recovered?.sessionId ?? null).toBeNull();
});
it("uses the ready index in synchronous recovery without catalog discovery", async () => {
  const f = fixture(); await startJobRunBackfill(env.home);
  const scan = vi.spyOn(history, "readRunLogs").mockImplementation(() => { throw new Error("synchronous catalog must not be read"); });
  expect(recoverJobRecord(env.home, f.name)).toMatchObject({ prompt: f.prompt }); expect(scan).not.toHaveBeenCalled();
});
it("does not abort strict feed startup or stamp ready after a failed auxiliary write", async () => {
  fixture(); await startJobRunBackfill(env.home);
  const original = index.indexRunFile;
  const indexing = vi.spyOn(index, "indexRunFile").mockImplementation((home, file, meta) => {
    if (file.includes("failed-index")) throw new Error("synthetic auxiliary failure"); original(home, file, meta);
  });
  const feed = startRunFeed({ home: env.home, name: "failed-index", header: "exact retained task", requireMetadata: true, meta: { job: "codex-job-failed", jobStartedAt: 2 } });
  try {
    expect(readFileSync(feed.logPath, "utf8")).toContain("exact retained task"); expect(jobRunIndexReady(env.home)).toBe(false);
    const attempted = indexing.mock.calls.length;
    feed.meta({ percent: 50 }); expect(indexing).toHaveBeenCalledTimes(attempted);
    const other = startRunFeed({ home: env.home, name: "successful-index", header: "other", meta: { job: "codex-job-success", jobStartedAt: 3 } });
    other.end("done"); expect(jobRunIndexReady(env.home)).toBe(false);
  } finally { feed.end("done"); }
});
it("invalidates a moved route and repairs it without a request", async () => {
  const f = fixture(); await startJobRunBackfill(env.home);
  const dir = join(env.home, "runs", "archive"); mkdirSync(dir);
  renameSync(f.file, join(dir, "arbitrary-native-turn.log")); renameSync(f.metadata, join(dir, "arbitrary-native-turn.json"));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  expect(() => indexedJobRun(env.home, f.name)).toThrow("reindexing"); expect(jobRunIndexReady(env.home)).toBe(false);
  await vi.advanceTimersByTimeAsync(250); vi.useRealTimers(); await until(() => jobRunIndexReady(env.home));
  expect(indexedJobRun(env.home, f.name)[0]!.archived).toBe(true);
});
it("keeps originals and clears readiness when packing's transactional index update fails", async () => {
  const f = fixture(), bytes = readFileSync(f.file), metadata = readFileSync(f.metadata);
  await startJobRunBackfill(env.home);
  vi.spyOn(index, "indexJobRun").mockImplementationOnce(() => { throw new Error("synthetic packed index failure"); });
  expect(() => packFinishedRuns(env.home, [f.file])).toThrow("synthetic packed index failure");
  expect(jobRunIndexReady(env.home)).toBe(false); expect(readFileSync(f.file)).toEqual(bytes); expect(readFileSync(f.metadata)).toEqual(metadata);
});
it("uses bounded discovery for ambiguous log-only keys and never selects the newest blindly", async () => {
  const dir = join(env.home, "runs"); mkdirSync(dir);
  for (const stamp of ["01", "02"]) writeFileSync(join(dir, `2026-10-${stamp}-00-00-00-codex-ambiguous.log`), `header by owner\n         task ${stamp}\n         ---\n`);
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ id: "ambiguous", name: "codex-job-ambiguous", agent: "codex", owner: "owner", sessionId: "native", startedAt: 1, status: "done" }] }));
  await startJobRunBackfill(env.home); const scan = vi.spyOn(history, "readRunLogsResponsive");
  const result = await recoverJobRecordAsync(env.home, "codex-job-ambiguous");
  expect(scan).toHaveBeenCalled(); expect(result?.prompt ?? "").toBe("");
  scan.mockImplementation(() => new Promise(() => {}));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const waiting = recoverJobRecordAsync(env.home, "codex-job-ambiguous");
  const rejected = expect(waiting).rejects.toMatchObject({ code: "job_index_preparing" });
  await vi.advanceTimersByTimeAsync(JOB_INDEX_WAIT_MS); await rejected;
});
it("eagerly backfills once and lets fifteen concurrent cold requests succeed when discovery finishes", async () => {
  const f = fixture(), held = heldScan();
  const backfill = startJobRunBackfill(env.home);
  await held.started;
  const requests = Array.from({ length: 15 }, () => recoverJobRecordAsync(env.home, f.name));
  await yieldTurn();
  expect(held.scan).toHaveBeenCalledTimes(1);
  held.release(); await backfill;
  for (const result of await Promise.all(requests)) expect(result).toMatchObject({ prompt: f.prompt, sessionId: "native-legacy", args: { access: "read", effort: "high" } });
  expect(held.scan).toHaveBeenCalledTimes(1);
});
it("fails closed with a retryable preparing state inside the existing budget and keeps backfill alive", async () => {
  const f = fixture(), held = heldScan(), backfill = startJobRunBackfill(env.home); await held.started;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const wait = recoverJobRecordAsync(env.home, f.name);
  const rejected = expect(wait).rejects.toMatchObject({ code: "job_index_preparing", message: expect.stringContaining("backfill running") });
  await vi.advanceTimersByTimeAsync(JOB_INDEX_WAIT_MS); await rejected;
  expect(held.scan).toHaveBeenCalledTimes(1);
  vi.useRealTimers(); held.release(); await backfill;
  expect(indexedJobRun(env.home, "codex-job-legacy")).toHaveLength(1);
});
it("uses durable exact lookups after reopen while an unrelated catalog dependency remains stalled", async () => {
  const fixtures = Array.from({ length: 15 }, (_, i) => fixture(`legacy${i}`, `misnamed-${i}`, i + 1));
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: fixtures.map((f, i) => ({ id: `legacy${i}`, name: f.name, agent: "codex", owner: "owner", status: "running", startedAt: i + 1, host: { pid: 999999999, peer: f.name, startedAt: i + 1 } })) }));
  await startJobRunBackfill(env.home); closeMetadataDb(env.home);
  const scan = vi.spyOn(history, "readRunLogsResponsive").mockRejectedValue(new Error("Catalog dependency stalled; indexed recovery must bypass it"));
  const owner = env.node("owner", "other"); await owner.start();
  const results = await Promise.all(fixtures.map(f => owner.jobAuthority(f.name)));
  for (let i = 0; i < fixtures.length; i++) expect(results[i]).toMatchObject({ prompt: fixtures[i]!.prompt, sessionId: `native-legacy${i}`, args: { access: "read" } });
  expect(scan).not.toHaveBeenCalled();
});
it("retains exact recovery after reopen when projection publication follows the indexed snapshot", async () => {
  const f = fixture(), path = join(env.home, "jobs.json");
  const jobs = [{ id: "legacy", name: f.name, agent: "codex", owner: "owner", status: "done", startedAt: 1 }];
  writeFileSync(path, JSON.stringify({ version: 4, jobs }));
  const bytes = [path, f.file, f.metadata].map(file => readFileSync(file));
  await startJobRunBackfill(env.home); closeMetadataDb(env.home);
  const syncScan = vi.spyOn(history, "readRunLogs").mockImplementation(() => { throw new Error("indexed recovery must bypass the catalog"); });
  const scan = vi.spyOn(history, "readRunLogsResponsive").mockRejectedValue(new Error("indexed recovery must bypass the catalog"));
  const read = archive.readIndexedJobSteps;
  const publication = vi.spyOn(archive, "readIndexedJobSteps").mockImplementationOnce(function* (...args) {
    const snapshot = yield* read(...args);
    expect(snapshot.jobs).toEqual([]);
    // Publish through the migration's writer APIs after capture, before history checks the witness.
    archive.storeJobRecords(path, jobs);
    archive.markJobProjection(path, jobs);
    expect(archive.indexedJobProjectionCurrent(path)).toBe(true);
    expect(archive.indexedJobProjectionCurrent(path, snapshot.signature)).toBe(false);
    return snapshot;
  });
  const header = vi.spyOn(recoveryFeed, "readRecoveryHeader"), refusal = vi.fn();
  const recovered = await recoverJobRecordAsync(env.home, f.name, { onUnavailable: refusal });
  expect(refusal).not.toHaveBeenCalled();
  expect(recovered).toMatchObject({
    id: "legacy", name: f.name, startedAt: 1, owner: "owner", prompt: f.prompt,
    sessionId: "native-legacy", args: { access: "read", effort: "high" },
  });
  expect(publication).toHaveBeenCalledTimes(2); expect(header).toHaveBeenCalledTimes(1);
  expect(syncScan).not.toHaveBeenCalled(); expect(scan).not.toHaveBeenCalled();
  expect([path, f.file, f.metadata].map(file => readFileSync(file))).toEqual(bytes);
});
it("still refuses a genuinely changed native context after one header read", async () => {
  const f = fixture(); await startJobRunBackfill(env.home); closeMetadataDb(env.home);
  const read = recoveryFeed.readRecoveryHeader;
  const header = vi.spyOn(recoveryFeed, "readRecoveryHeader").mockImplementationOnce(async (...args) => {
    const payload = await read(...args);
    writeFileSync(f.metadata, JSON.stringify({ job: f.name, jobStartedAt: 1, session: "changed-native", by: "owner", access: "read", effort: "high" }));
    return payload;
  });
  const refusal = vi.fn();
  expect(await recoverJobRecordAsync(env.home, f.name, { onUnavailable: refusal })).toBeUndefined();
  expect(refusal).toHaveBeenCalledExactlyOnceWith({ reason: "recovery_context_changed", stage: "context_recheck" });
  expect(header).toHaveBeenCalledTimes(1);
});
it("shares another owner's backfill lease and cancels a waiting observer without starting a second scan", async () => {
  fixture();
  const release = metadataFileLease(join(env.home, "job-run-index.lease"), 0, true);
  const scan = vi.spyOn(history, "readRunLogsResponsive");
  const work = startJobRunBackfill(env.home);
  const rejected = expect(work).rejects.toBeDefined();
  try { await yieldTurn(); await yieldTurn(); expect(scan).not.toHaveBeenCalled(); await stopJobRunBackfill(env.home); await rejected; }
  finally { release(); }
  await startJobRunBackfill(env.home);
  expect(scan).toHaveBeenCalledTimes(1);
});
it("keeps partial observations resumable and never publishes readiness after an incomplete scan", async () => {
  const f = fixture(), original = history.readRunLogsResponsive;
  vi.spyOn(history, "readRunLogsResponsive").mockImplementationOnce(async (home, names, complete) => {
    const records = await original(home, names); complete?.(false); return records;
  });
  await expect(startJobRunBackfill(env.home)).rejects.toMatchObject({ code: "job_index_preparing", message: expect.stringContaining("observation incomplete") });
  expect(indexedJobRun(env.home, f.name)).toHaveLength(1);
  expect(metadataDb(env.home).prepare("SELECT 1 FROM bridge_metadata WHERE domain='job-run-index-v1' AND key='complete'").get()).toBeUndefined();
  await startJobRunBackfill(env.home);
  expect(await recoverJobRecordAsync(env.home, f.name)).toMatchObject({ prompt: f.prompt });
});
it("resumes partial durable backfill without losing observations or source bytes", async () => {
  const f = fixture(), bytes = readFileSync(f.file), records = history.readRunLogs(env.home);
  indexJobRun(env.home, records[0]!); closeMetadataDb(env.home);
  await startJobRunBackfill(env.home);
  const count = () => Number(metadataDb(env.home).prepare("SELECT count(*) n FROM bridge_metadata WHERE domain='job-run-history-v1'").get()!.n);
  const before = count(); await startJobRunBackfill(env.home);
  expect(count()).toBe(before); expect(readFileSync(f.file)).toEqual(bytes); expect(existsSync(f.metadata)).toBe(true);
  expect(await recoverJobRecordAsync(env.home, f.name)).toEqual(recoverJobRecord(env.home, f.name));
});
it("keeps exact routes through archive and packing without repeating discovery or deleting data", async () => {
  const f = fixture(), bytes = readFileSync(f.file); await startJobRunBackfill(env.home);
  const scan = vi.spyOn(history, "readRunLogsResponsive");
  archiveRun(f.file);
  expect(await recoverJobRecordAsync(env.home, f.name)).toMatchObject({ prompt: f.prompt });
  const archived = join(env.home, "runs", "archive", "arbitrary-native-turn.log");
  expect(packFinishedRuns(env.home, [archived])).toBe(1);
  expect(await recoverJobRecordAsync(env.home, f.name)).toMatchObject({ prompt: f.prompt, sessionId: "native-legacy" });
  expect(readFileSync(indexedJobRun(env.home, f.name)[0]!.file)).toEqual(bytes);
  expect(scan).not.toHaveBeenCalled();
});
it("indexes newly created and continued feeds without invalidating a completed backfill", async () => {
  const old = fixture(); await startJobRunBackfill(env.home);
  const scan = vi.spyOn(history, "readRunLogsResponsive");
  const feed = startRunFeed({ home: env.home, name: "independent-new-native", header: "header by owner\nnew exact task\n---", meta: { job: old.name, jobStartedAt: 2, by: "owner", session: "new-native", access: "read" } });
  try {
    expect(await recoverJobRecordAsync(env.home, old.name)).toMatchObject({ prompt: "new exact task", sessionId: "new-native", startedAt: 2 });
    feed.meta({ session: "updated-native" });
    expect(await recoverJobRecordAsync(env.home, old.name)).toMatchObject({ sessionId: "updated-native" });
    expect(scan).not.toHaveBeenCalled();
  } finally { feed.end("done"); }
});
it("keeps a suffix-matched legacy log without metadata addressable after archiving", async () => {
  const id = "logonly", name = `codex-job-${id}`, dir = join(env.home, "runs"); mkdirSync(dir);
  const file = join(dir, `2026-10-01-00-00-00-codex-${id}.log`);
  writeFileSync(file, "header by owner\n         retained log-only prompt\n         ---\n00:00:01 finished after 1s · done\n");
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ id, name, agent: "codex", owner: "owner", sessionId: "native", startedAt: 1, status: "done" }] }));
  await startJobRunBackfill(env.home);
  const scan = vi.spyOn(history, "readRunLogsResponsive");
  archiveRun(file);
  expect(await recoverJobRecordAsync(env.home, name)).toMatchObject({ prompt: "retained log-only prompt", sessionId: "native" });
  expect(scan).not.toHaveBeenCalled();
});
it("preserves packing when retained metadata is a non-object JSON value", () => {
  const f = fixture("nullmeta", "2026-10-01-00-00-00-codex-nullmeta"), bytes = readFileSync(f.file);
  writeFileSync(f.metadata, "null");
  expect(packFinishedRuns(env.home, [f.file])).toBe(1);
  const retained = indexedJobRun(env.home, f.name)[0]!;
  expect(readFileSync(retained.file)).toEqual(bytes);
  expect(retained.meta).toEqual({});
});
it("completes backfill when loose metadata is malformed and records that run with no routing key", async () => {
  const f = fixture(), dir = join(env.home, "runs"), originals = new Map<string, Buffer>();
  for (const [id, bytes] of [["nullmeta", "null"], ["corruptmeta", "{not json"]] as const) {
    const log = join(dir, `2026-10-01-00-00-00-codex-${id}.log`), meta = log.replace(/\.log$/, ".json");
    writeFileSync(log, "header by owner\n         retained prompt\n         ---\n00:00:01 finished after 1s · done\n"); writeFileSync(meta, bytes);
    originals.set(log, readFileSync(log)); originals.set(meta, readFileSync(meta));
  }
  await startJobRunBackfill(env.home);
  expect(jobRunIndexReady(env.home)).toBe(true); expect(existsSync(join(env.home, "job-run-index.dirty"))).toBe(false);
  expect(indexedJobRun(env.home, f.name)).toHaveLength(1);
  // The metadata exists but proves nothing: neither its job nor the filename becomes a route.
  expect(indexedJobRun(env.home, "codex-job-nullmeta")).toEqual([]); expect(indexedJobRun(env.home, "codex-job-corruptmeta")).toEqual([]);
  const observed = metadataDb(env.home).prepare("SELECT value FROM bridge_metadata WHERE domain='job-run-history-v1'").all().map(row => JSON.parse(String(row.value)).name);
  expect(observed).toEqual(expect.arrayContaining(["2026-10-01-00-00-00-codex-nullmeta", "2026-10-01-00-00-00-codex-corruptmeta"]));
  for (const [file, bytes] of originals) expect(readFileSync(file)).toEqual(bytes);
});
it("keeps a ready index ready across repeated misses and serves other lookups without rescans", async () => {
  const f = fixture(); await startBrokerJobRunIndex(env.home);
  const db = metadataDb(env.home), complete = () => db.prepare("SELECT value FROM bridge_metadata WHERE domain='job-run-index-v1' AND key='complete'").get()!.value;
  const before = complete(), scan = vi.spyOn(history, "readRunLogsResponsive");
  for (let i = 0; i < 3; i++) {
    await waitForJobRunIndex(env.home, performance.now() + JOB_INDEX_WAIT_MS, "codex-job-mistyped");
    expect(jobRunIndexReady(env.home)).toBe(true);
  }
  // One bounded re-observation for the unseen key; later misses in this generation are free.
  expect(scan).toHaveBeenCalledTimes(1);
  expect(complete()).toBe(before); expect(existsSync(join(env.home, "job-run-index.dirty"))).toBe(false);
  expect(await recoverJobRecordAsync(env.home, f.name)).toMatchObject({ prompt: f.prompt, sessionId: "native-legacy" });
  expect(indexedJobRun(env.home, f.name)).toHaveLength(1); expect(scan).toHaveBeenCalledTimes(1);
});
it("fails only the lookup whose files change between reads and keeps the index ready", async () => {
  const f = fixture(); await startJobRunBackfill(env.home);
  let n = 0; const signature = vi.spyOn(fileCache, "fileSignature").mockImplementation(() => `changing-${n++}`);
  expect(() => indexedJobRun(env.home, f.name)).toThrow(expect.objectContaining({ code: "job_index_preparing" }));
  expect(jobRunIndexReady(env.home)).toBe(true); expect(existsSync(join(env.home, "job-run-index.dirty"))).toBe(false);
  signature.mockRestore();
  expect(indexedJobRun(env.home, f.name)).toHaveLength(1);
});
it("invalidates once at broker start after an older version wrote the index", async () => {
  const f = fixture(); await startJobRunBackfill(env.home);
  const db = metadataDb(env.home);
  const state = (key: string) => JSON.parse(String(db.prepare("SELECT value FROM bridge_metadata WHERE domain='job-run-index-v1' AND key=?").get(key)?.value ?? "null"));
  db.prepare("UPDATE bridge_metadata SET value=? WHERE domain='job-run-index-v1' AND key='complete'").run(JSON.stringify({ ...state("complete"), writer: "0.0.1" }));
  const invalidated = Number(state("invalidated") ?? 0);
  await startBrokerJobRunIndex(env.home);
  expect(jobRunIndexReady(env.home)).toBe(true); expect(state("complete").writer).toBe(APP_VERSION);
  expect(Number(state("invalidated"))).toBe(invalidated + 1);
  await stopJobRunBackfill(env.home); await startBrokerJobRunIndex(env.home);
  expect(Number(state("invalidated"))).toBe(invalidated + 1);
  expect(indexedJobRun(env.home, f.name)).toHaveLength(1);
});
it("keeps archiving after a successful move when the route update fails", async () => {
  const first = fixture("first", "2026-10-01-00-00-00-codex-first"), second = fixture("second", "2026-10-01-00-00-00-codex-second", 2);
  const bytes = [readFileSync(first.file), readFileSync(second.file)];
  await startJobRunBackfill(env.home);
  vi.spyOn(index, "indexRunFile").mockImplementation(() => { throw new Error("synthetic archive index failure"); });
  expect(archiveOldRuns(env.home, Date.now() + 400 * 24 * 60 * 60 * 1_000)).toBe(2);
  [first, second].forEach((f, i) => {
    expect(existsSync(f.file)).toBe(false);
    expect(readFileSync(join(env.home, "runs", "archive", basename(f.file)))).toEqual(bytes[i]);
    expect(existsSync(join(env.home, "runs", "archive", basename(f.metadata)))).toBe(true);
  });
  expect(jobRunIndexReady(env.home)).toBe(false);
});
it("appends exactly one invalidation receipt for one failed feed route update", () => {
  metadataDb(env.home);
  vi.spyOn(index, "indexRunFile").mockImplementation(() => { throw new Error("synthetic feed index failure"); });
  const feed = startRunFeed({ home: env.home, name: "one-receipt", header: "task", meta: { job: "codex-job-receipt", jobStartedAt: 2 } });
  try { expect(readFileSync(join(env.home, "job-run-index.dirty"), "utf8")).toBe("\n"); }
  finally { feed.end("done"); }
});
it("releases a bridge.db handle that an archive route write opened itself", () => {
  const f = fixture("handle", "2026-10-01-00-00-00-codex-handle");
  metadataDb(env.home); closeMetadataDb(env.home); // The store exists; no handle is open.
  archiveRun(f.file);
  expect(metadataDbOpen(env.home)).toBe(false);
  expect(indexedJobRun(env.home, f.name)[0]!.archived).toBe(true);
});
it("yields to the broker event loop while filtering a large reobservation catalog without extra stats", async () => {
  fixture(); await startBrokerJobRunIndex(env.home);
  const runs = join(realpathSync.native(env.home), "runs"), seen: number[] = [];
  let ticks = 0, spinning = true;
  const spin = () => { ticks++; if (spinning) setImmediate(spin); };
  const records = Array.from({ length: 2_000 }, (_, i) => ({
    name: `retained-${i}`, file: join(runs, `retained-${i}.log`), size: 1, signature: `s${i}`, archived: false, meta: {},
    metadataFile: join(runs, `retained-${i}.json`), metadataUpdatedAt: 0,
    get updatedAt() { seen.push(ticks); return 0; },
  })) as history.RunLogRecord[];
  vi.spyOn(history, "readRunLogsResponsive").mockResolvedValueOnce(records);
  setImmediate(spin);
  try { await waitForJobRunIndex(env.home, performance.now() + JOB_INDEX_WAIT_MS, "codex-job-unseen"); }
  finally { spinning = false; }
  expect(seen).toHaveLength(2_000);
  expect(new Set(seen).size).toBeGreaterThan(1); // The event loop ran between filter chunks.
  expect(jobRunIndexReady(env.home)).toBe(true);
});
it("re-observes a known key when an older writer adds a newer turn after completion", async () => {
  const f = fixture(); await startBrokerJobRunIndex(env.home);
  // An older writer creates the next turn without index rows.
  const next = fixture("legacy", "older-writer-next-turn", 2);
  writeFileSync(next.metadata, JSON.stringify({ job: f.name, jobStartedAt: 2, session: "next-native", by: "owner", access: "read" }));
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ id: "legacy", name: f.name, agent: "codex", owner: "owner", startedAt: 2, status: "done" }] }));
  expect(await recoverJobRecordAsync(env.home, f.name)).toMatchObject({ prompt: f.prompt, sessionId: "next-native", startedAt: 2 });
  expect(jobRunIndexReady(env.home)).toBe(true); expect(existsSync(join(env.home, "job-run-index.dirty"))).toBe(false);
});
it("never initializes the metadata store from a feed or archive route write", () => {
  const feed = startRunFeed({ home: env.home, name: "2026-10-01-00-00-00-codex-nostore", header: "task", meta: { job: "codex-job-nostore" } });
  feed.end("done"); archiveRun(feed.logPath);
  expect(existsSync(join(env.home, "bridge.db"))).toBe(false);
  expect(existsSync(join(env.home, "runs", "archive", basename(feed.logPath)))).toBe(true);
});
