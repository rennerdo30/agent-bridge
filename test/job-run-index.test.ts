import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeEnv, type TestEnv } from "./helpers.js";
import * as history from "../src/core/run-history.js";
import { recoverJobRecord, recoverJobRecordAsync } from "../src/core/job-recovery.js";
import { indexedJobRun, indexJobRun, JOB_INDEX_WAIT_MS, startJobRunBackfill, stopJobRunBackfill } from "../src/core/job-run-index.js";
import { metadataFileLease } from "../src/core/metadata-file-lease.js";
import { closeMetadataDb, metadataDb } from "../src/core/metadata-db.js";
import { archiveRun } from "../src/core/run-archive.js";
import { packFinishedRuns } from "../src/core/finished-run-bundles.js";
import { startRunFeed } from "../src/core/runfeed.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await env.cleanup(); });
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
