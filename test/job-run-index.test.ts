import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import * as history from "../src/core/run-history.js";
import { recoverJobRecord, recoverJobRecordAsync } from "../src/core/job-recovery.js";
import * as index from "../src/core/job-run-index.js";
import { indexedJobRun, indexJobRun, jobRunIndexReady, JOB_INDEX_WAIT_MS, startJobRunBackfill, stopJobRunBackfill, waitForJobRunIndex } from "../src/core/job-run-index.js";
import { metadataFileLease } from "../src/core/metadata-file-lease.js";
import { closeMetadataDb, metadataDb } from "../src/core/metadata-db.js";
import { archiveRun } from "../src/core/run-archive.js";
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
it("uses one transaction and zero SQLite lock wait for an entire route update", () => {
  fixture(); const record = history.readRunLogs(env.home)[0]!, db = metadataDb(env.home);
  const exec = vi.spyOn(db, "exec"); indexJobRun(env.home, record);
  expect(exec.mock.calls.map(call => call[0])).toEqual(["PRAGMA busy_timeout=0", "BEGIN IMMEDIATE", "COMMIT", "PRAGMA busy_timeout=5000"]);
  const other = new DatabaseSync(join(env.home, "bridge.db")); other.exec("BEGIN IMMEDIATE");
  try {
    exec.mockClear(); expect(() => indexJobRun(env.home, { ...record, file: record.file + ".moved" })).toThrow();
    expect(exec.mock.calls.map(call => call[0])).toEqual(["PRAGMA busy_timeout=0", "BEGIN IMMEDIATE", "PRAGMA busy_timeout=5000"]);
  } finally { other.exec("ROLLBACK"); other.close(); }
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
it("maps non-Bridge discovery errors to retryable preparing", async () => {
  fixture(); vi.spyOn(history, "readRunLogsResponsive").mockRejectedValue(new Error("synthetic discovery failure"));
  await expect(waitForJobRunIndex(env.home, performance.now() + JOB_INDEX_WAIT_MS)).rejects.toMatchObject({ code: "job_index_preparing" });
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
