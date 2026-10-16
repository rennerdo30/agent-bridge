import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import * as projection from "../src/core/job-archive-index.js";
import * as cache from "../src/core/file-cache.js";
import * as feeds from "../src/core/job-recovery-feed.js";
import * as index from "../src/core/job-run-index.js";
import * as recovery from "../src/core/job-recovery.js";
import { nullLogger } from "../src/core/logger.js";
import type { MessageStore } from "../src/core/store.js";
import { retryRequest, transientRequestError } from "../src/core/request-retry.js";
import { BridgeError } from "../src/core/protocol.js";
import { makeEnv, type TestEnv } from "./helpers.js";

type Job = Record<string, unknown>;
type FixtureBroker = {
  jobForControl(peer: unknown, ref: string): Promise<Job | undefined>;
  currentJobAuthority(job: Job | undefined): Job | undefined;
  handlers: {
    jobAuthority(conn: unknown, args: { job: string }): Promise<Job | null>;
    inlineJobControl(conn: unknown, args: { job: string; control: { type: "cancel" } }): Promise<unknown>;
  };
  emit(...args: unknown[]): void;
  onSend(...args: unknown[]): Promise<unknown>;
  storedJob(ref: string): Job | undefined;
};
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await env.cleanup(); });

function fixture() {
  const job = { id: "tiny", name: "codex-job-tiny", agent: "codex", owner: "owner", startedAt: 1,
    sessionId: "native", prompt: "exact fixture task", status: "interrupted", args: {} };
  const registry = join(env.home, "jobs.json");
  writeFileSync(registry, JSON.stringify({ version: 4, jobs: [job] }));
  // Call real handlers without starting sockets, services, background work or process probes.
  const broker = new Broker(env.pipe, {} as MessageStore, nullLogger, "fixture-only", Date.now, registry) as unknown as FixtureBroker;
  const conn = { peer: { id: "owner", name: "owner", agent: "other", cwd: env.home } };
  return { job, registry, broker, conn };
}

function legacyFixture() {
  const f = fixture(), { prompt: _prompt, ...row } = f.job;
  writeFileSync(f.registry, JSON.stringify({ version: 4, jobs: [row] }));
  const root = join(env.home, "runs"); mkdirSync(root);
  const file = join(root, "2026-10-08-01-02-03-codex-tiny.log"), metadata = file.replace(/\.log$/, ".json");
  writeFileSync(file, "header by owner\n         original private fixture prompt\n         ---\n");
  writeFileSync(metadata, JSON.stringify({ job: f.job.name, session: "native", by: "owner" }));
  // Exercise real bounded discovery and both prepares with only this one tiny job/run.
  vi.spyOn(index, "waitForJobRunIndex").mockResolvedValue("discover");
  return { ...f, file, metadata, row };
}

function deferredHeader() {
  let entered!: () => void, release!: (value: feeds.RecoveryHeader) => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<feeds.RecoveryHeader>(resolve => { release = resolve; });
  const read = vi.spyOn(feeds, "readRecoveryHeader").mockImplementationOnce(() => { entered(); return held; });
  return { ready, read, release: () => release({ header: "header by owner", prompt: "original private fixture prompt" }) };
}

function noControl(broker: FixtureBroker) {
  return { emit: vi.spyOn(broker, "emit"), send: vi.spyOn(broker, "onSend") };
}

function payload(error: unknown) {
  expect(error).toBeInstanceOf(BridgeError);
  return (error as BridgeError).toPayload();
}

function failAfterAwait(f: ReturnType<typeof fixture>, error: Error, source: "projection" | "snapshot" = "projection") {
  const read = cache.readJsonSnapshot;
  const fault = vi.fn(() => { throw error; });
  vi.spyOn(f.broker, "jobForControl").mockImplementation(async () => {
    await Promise.resolve();
    if (source === "projection") vi.spyOn(projection, "indexedJobProjectionCurrent").mockImplementationOnce(fault);
    else {
      vi.spyOn(projection, "indexedJobProjectionCurrent").mockReturnValueOnce(false);
      vi.spyOn(cache, "readJsonSnapshot").mockImplementationOnce((...args) => { if (args[0] === f.registry) return fault(); return read(...args); });
    }
    return f.job;
  });
  return fault;
}

it.each(["projection", "snapshot"] as const)("F1: %s busy after jobForControl awaits is named uncertainty, never absence", async source => {
  const f = fixture();
  const fault = failAfterAwait(f, Object.assign(new Error("database is locked; private SQL and path must not escape"), { code: "SQLITE_BUSY" }), source);
  const result = await f.broker.handlers.jobAuthority(f.conn, { job: f.job.name }).catch(error => error);
  expect(fault).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ code: "job_index_preparing", details: { reason: "authority_store_read", stage: "authority_fence" } });
  expect(transientRequestError(result)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private SQL");
});

it("F1: the existing read retry recovers a one-time busy refusal with its unchanged fake-clock delay", async () => {
  const f = fixture(), fault = failAfterAwait(f, Object.assign(new Error("locked"), { code: "SQLITE_LOCKED" }));
  // Install the fault on the first final fence only, not every retry.
  vi.mocked(f.broker.jobForControl).mockImplementationOnce(async () => {
    await Promise.resolve();
    vi.spyOn(projection, "indexedJobProjectionCurrent").mockImplementationOnce(fault);
    return f.job;
  }).mockResolvedValue(f.job);
  vi.useFakeTimers();
  const request = vi.fn(() => f.broker.handlers.jobAuthority(f.conn, { job: f.job.name }));
  const pending = retryRequest("fixture authority", request);
  await vi.advanceTimersByTimeAsync(0); expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(99); expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject(f.job);
  expect(request).toHaveBeenCalledTimes(2); expect(fault).toHaveBeenCalledTimes(1);
});

it("F1: permanent authority IO errors are sanitized, named and nonretrying; no control is submitted", async () => {
  const f = fixture(), control = noControl(f.broker);
  const fault = failAfterAwait(f, Object.assign(new Error(`denied ${env.home}; SELECT private prompt`), { code: "EACCES" }));
  const request = vi.fn(() => f.broker.handlers.inlineJobControl(f.conn, { job: f.job.name, control: { type: "cancel" } }));
  const error = await retryRequest("fixture control", request).catch(error => error);
  expect(error).toMatchObject({ code: "internal", details: { reason: "authority_store_read", stage: "authority_fence" } });
  expect(transientRequestError(error)).toBe(false);
  expect(payload(error)).toEqual({ code: "internal", message: "Job authority unavailable (authority_store_read; authority_fence). No control submitted.",
    details: { reason: "authority_store_read", stage: "authority_fence" } });
  expect(request).toHaveBeenCalledTimes(1); expect(fault).toHaveBeenCalledTimes(1);
  expect(control.emit).not.toHaveBeenCalled(); expect(control.send).not.toHaveBeenCalled();
});

it("F1: ENOENT still resolves retained authority without treating a missing registry as uncertainty", async () => {
  const f = fixture();
  failAfterAwait(f, Object.assign(new Error("missing fixture registry"), { code: "ENOENT" }));
  expect(await f.broker.handlers.jobAuthority(f.conn, { job: f.job.name })).toMatchObject(f.job);
});

it("F2/N2: unavailable header fails closed without a usable current; later independent lookup succeeds", async () => {
  const f = legacyFixture(), control = noControl(f.broker);
  const read = vi.spyOn(feeds, "readRecoveryHeader").mockResolvedValueOnce(undefined);
  const request = vi.fn(() => f.broker.handlers.inlineJobControl(f.conn, { job: f.job.name, control: { type: "cancel" } }));
  const error = await retryRequest("fixture control", request).catch(error => error);
  expect(payload(error)).toEqual({ code: "job_index_preparing", message: "Job recovery unavailable (recovery_header_unavailable; header_read). No control submitted.",
    details: { reason: "recovery_header_unavailable", stage: "header_read" } });
  expect(transientRequestError(error)).toBe(false); expect(request).toHaveBeenCalledTimes(1);
  expect(control.emit).not.toHaveBeenCalled(); expect(control.send).not.toHaveBeenCalled();
  expect(await f.broker.handlers.jobAuthority(f.conn, { job: f.job.name })).toMatchObject({ prompt: "original private fixture prompt", sessionId: "native" });
  expect(read).toHaveBeenCalledTimes(2);
});

it.each(["path", "signature", "context"] as const)("F3/N3: deferred header refuses a changed %s without re-prepare or control", async change => {
  const f = legacyFixture(), held = deferredHeader(), control = noControl(f.broker);
  const pending = f.broker.handlers.inlineJobControl(f.conn, { job: f.job.name, control: { type: "cancel" } }).catch(error => error);
  await held.ready;
  if (change === "path") {
    renameSync(f.file, f.file.replace("01-02-03", "01-02-04"));
    renameSync(f.metadata, f.metadata.replace("01-02-03", "01-02-04"));
  } else if (change === "signature") writeFileSync(f.file, "header by owner\n         a different turn must never use the old prompt\n         ---\n");
  else writeFileSync(f.metadata, JSON.stringify({ job: f.job.name, session: "changed-native", by: "owner" }));
  held.release();
  const error = await pending;
  expect(error).toMatchObject({ code: "job_index_preparing", details: { reason: "recovery_context_changed", stage: "context_recheck" } });
  expect(transientRequestError(error)).toBe(false); expect(held.read).toHaveBeenCalledTimes(1);
  expect(index.waitForJobRunIndex).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(payload(error))).not.toContain("private fixture prompt");
  expect(control.emit).not.toHaveBeenCalled(); expect(control.send).not.toHaveBeenCalled();
});

it("N4: known incomplete context is unavailable while a genuinely absent ref remains null", async () => {
  const f = legacyFixture();
  vi.spyOn(index, "waitForJobRunIndex").mockResolvedValue("indexed");
  vi.spyOn(index, "legacyJobRunAmbiguous").mockReturnValue(false);
  vi.spyOn(index, "indexedJobRun").mockReturnValue([]);
  await expect(f.broker.handlers.jobAuthority(f.conn, { job: f.job.name })).rejects.toMatchObject({
    code: "job_index_preparing", details: { reason: "recovery_context_unavailable", stage: "prepare" } });
  expect(await f.broker.handlers.jobAuthority(f.conn, { job: "codex-job-absent" })).toBeNull();
});

it("N4: prepared context disappearing after the header await is attributed without re-prepare", async () => {
  const f = legacyFixture(), held = deferredHeader();
  const pending = f.broker.handlers.jobAuthority(f.conn, { job: f.job.name }).catch(error => error);
  await held.ready;
  writeFileSync(f.registry, JSON.stringify({ version: 4, jobs: [] }));
  renameSync(f.file, f.file + ".unavailable");
  held.release();
  expect(await pending).toMatchObject({ code: "job_index_preparing", details: { reason: "recovery_context_unavailable", stage: "context_recheck" } });
  expect(held.read).toHaveBeenCalledTimes(1); expect(index.waitForJobRunIndex).toHaveBeenCalledTimes(2);
});

it("N4: an unreconstructible owner remains a refusal with a bounded finish reason", async () => {
  const f = legacyFixture(), { owner: _owner, ...row } = f.row;
  writeFileSync(f.registry, JSON.stringify({ version: 4, jobs: [row] }));
  writeFileSync(f.metadata, JSON.stringify({ job: f.job.name, session: "native" }));
  vi.spyOn(feeds, "readRecoveryHeader").mockResolvedValueOnce({ header: "no owner", prompt: "private prompt" });
  await expect(f.broker.handlers.jobAuthority(f.conn, { job: f.job.name })).rejects.toMatchObject({
    code: "job_index_preparing", details: { reason: "recovery_context_unavailable", stage: "finish" } });
});

it.each(["unavailable", "changed"] as const)("preserves usable stored-current fallback after recovery is %s", async reason => {
  const f = legacyFixture();
  if (reason === "unavailable") {
    vi.spyOn(feeds, "readRecoveryHeader").mockImplementationOnce(async () => {
      writeFileSync(f.registry, JSON.stringify({ version: 4, jobs: [f.job] }));
      return undefined;
    });
  } else {
    const held = deferredHeader();
    // Supply the existing usable-current fallback at the same post-recovery read boundary.
    const read = f.broker.storedJob.bind(f.broker); let reads = 0;
    vi.spyOn(f.broker, "storedJob").mockImplementation(ref => ++reads === 1 ? read(ref) : f.job);
    const pending = f.broker.handlers.jobAuthority(f.conn, { job: f.job.name });
    await held.ready;
    writeFileSync(f.metadata, JSON.stringify({ job: f.job.name, session: "changed-native", by: "owner" }));
    held.release();
    expect(await pending).toMatchObject(f.job);
    expect(held.read).toHaveBeenCalledTimes(1);
    return;
  }
  expect(await f.broker.handlers.jobAuthority(f.conn, { job: f.job.name })).toMatchObject(f.job);
});

it("keeps recovered canControl(false) returning current and final authorization denial returning null", async () => {
  const f = legacyFixture();
  const current = { ...f.job, owner: "different-owner" };
  const stored = vi.spyOn(f.broker, "storedJob").mockReturnValue(current);
  expect(await f.broker.jobForControl(f.conn.peer, f.job.name)).toMatchObject({ owner: "owner" });
  // Recovery now belongs to a foreign supervisor; it must not replace the current row.
  writeFileSync(f.registry, JSON.stringify({ version: 4, jobs: [{ ...f.row, owner: "different-owner" }] }));
  expect(await f.broker.jobForControl(f.conn.peer, f.job.name)).toBe(current);
  expect(await f.broker.handlers.jobAuthority(f.conn, { job: f.job.name })).toBeNull();
  expect(stored).toHaveBeenCalled();
});

it("observer preserves the direct recovery API's undefined refusal and reports only allowlisted attribution", async () => {
  const f = legacyFixture(), held = deferredHeader(), observer = vi.fn();
  const pending = recovery.recoverJobRecordAsync(env.home, f.job.name, { onUnavailable: observer });
  await held.ready;
  writeFileSync(f.metadata, JSON.stringify({ job: f.job.name, session: "changed-native", by: "owner" }));
  held.release();
  expect(await pending).toBeUndefined();
  expect(observer.mock.calls).toEqual([[{ reason: "recovery_context_changed", stage: "context_recheck" }]]);
  const unavailable = vi.spyOn(feeds, "readRecoveryHeader").mockResolvedValueOnce(undefined);
  expect(await recovery.recoverJobRecordAsync(env.home, f.job.name)).toBeUndefined();
  expect(unavailable).toHaveBeenCalledTimes(2);
});

it.each(["id", "name", "agent", "startedAt", "sessionId", "threadId"])("preserves the final %s comparison fence", async key => {
  const f = fixture();
  const resolved = { ...f.job, threadId: "thread" };
  writeFileSync(f.registry, JSON.stringify({ version: 4, jobs: [{ ...resolved, [key]: key === "startedAt" ? 2 : "changed" }] }));
  vi.spyOn(f.broker, "jobForControl").mockResolvedValue(resolved);
  // The id probe must see the differing record too, so exercise that comparison independently.
  vi.spyOn(projection, "indexedJobProjectionCurrent").mockReturnValue(true);
  vi.spyOn(projection, "readIndexedJobs").mockReturnValue({ signature: "fixture", jobs: [{ ...resolved, [key]: key === "startedAt" ? 2 : "changed" }] });
  expect(await f.broker.handlers.jobAuthority(f.conn, { job: f.job.name })).toBeNull();
});
