import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { JobManager, readStore, type Resume, type RunResult } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";

let home: string;
const managers: JobManager[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ab-terminal-handoff-")); });
afterEach(() => { for (const manager of managers.splice(0)) { manager.setDormant(true); manager.cancelAll(); } vi.restoreAllMocks(); });
const path = () => join(home, "jobs.json");
function manager(node: LocalCoordinator) {
  const result = new JobManager(node, nullLogger, path()); managers.push(result); return result;
}
function persist(manager: JobManager) { (manager as unknown as { persist(): void }).persist(); }
const done = (text: string, sessionId = "retained-native-session"): RunResult => ({ text, sessionId, workdir: home, isError: false, details: {} });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function checkWaiting(manager: JobManager) { (manager as unknown as { startWaiting(): void }).startWaiting(); }

it("reconciles a stale new-owner observer after executor completion and resumes retained context under a frozen clock", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const executor = new LocalCoordinator("executor", "source-root"), owner = new LocalCoordinator("owner", "target-root");
  const source = manager(executor), target = manager(owner);
  const delivered: unknown[] = [];
  Object.assign(executor, { reportInlineJob: async (message: unknown) => { delivered.push(message); return { saved: true }; } });
  Object.assign(owner, { reportInlineJob: async (message: unknown) => { delivered.push(message); return { saved: true }; } });
  let finish!: (result: RunResult) => void;
  const job = source.start("claude", null, "complete original handoff context", async () => new Promise(resolve => { finish = resolve; }), undefined,
    { title: "Exact context", effort: "high", access: "edit" });
  const original = readStore(path())[0]!;
  writeFileSync(path(), JSON.stringify({ version: 4, unknownOwnerData: { retained: true }, jobs: [{ ...original,
    owner: owner.name, supervisor: owner.currentSessionId, rootSession: owner.currentSessionId, rootName: owner.name,
    executionOwner: executor.name, masters: [owner.name, executor.name], ownershipHistory: [{ id: "handoff", at: 1_000,
      from: executor.name, to: owner.name, rootSession: owner.currentSessionId, rootName: owner.name, reason: "explicit-handoff" }] }] }));
  source.refreshOwnership(); target.refreshOwnership();
  const resumed = vi.fn((message: string, sessionId: string | null, workdir: string | null) => async () => done(`${message} resumed in ${workdir}`, sessionId!));
  target.restore(() => resumed);
  const observer = target.find(job.name)!;
  const controller = observer.controller;
  expect(observer.status).toBe("running");
  expect((target as unknown as { running: Map<string, unknown> }).running.has(job.id)).toBe(true);
  executor.emit("inline_job_control", { job: job.name, control: { type: "message", body: "accepted before completion" } });
  job.args!.effort = "xhigh"; job.percent = 65; job.progressNote = "durable completion progress";
  finish(done("executor's complete result")); await flush();
  const completed = readStore(path())[0]!;
  expect(completed.status).toBe("done");
  expect(completed.queuedMessages).toEqual(["accepted before completion"]);
  // No refresh: reproduce the new owner's normal persist of its stale running snapshot.
  persist(target);
  expect(observer.controller).toBe(controller);
  expect(controller.signal.aborted).toBe(false);
  const protectedRecord = readStore(path())[0]!;
  expect(protectedRecord).toMatchObject({ status: "done", sessionId: "retained-native-session", prompt: job.prompt,
    args: { effort: "xhigh", access: "edit" }, percent: 65, progressNote: "durable completion progress" });
  expect(protectedRecord.deliveryHistory).toEqual(completed.deliveryHistory);
  expect((target as unknown as { running: Map<string, unknown> }).running.has(job.id)).toBe(false);
  await flush(); await flush();
  expect(resumed).toHaveBeenCalledWith("accepted before completion", "retained-native-session", home, null);
  const firstContinuation = readStore(path())[0]!;
  expect(firstContinuation.status).toBe("done");
  expect(firstContinuation.startedAt).toBeGreaterThan(completed.startedAt);
  expect(target.followUp(job.name, "next exact task").outcome).toBe("started");
  await flush(); await flush();
  expect(resumed).toHaveBeenLastCalledWith("next exact task", "retained-native-session", home, null);
  const latest = readStore(path())[0]!;
  expect(latest.status).toBe("done");
  expect(latest.startedAt).toBeGreaterThan(firstContinuation.startedAt);
  expect(latest.deliveryHistory).toEqual(expect.arrayContaining(completed.deliveryHistory!));
  expect(JSON.parse(readFileSync(path(), "utf8")).unknownOwnerData).toEqual({ retained: true });
  expect(delivered.length).toBeGreaterThanOrEqual(3);
});

it("preserves a real active executor's controller when a same-turn terminal record is observed", async () => {
  const node = new LocalCoordinator("executor", "source-root"), jobs = manager(node);
  let finish!: (result: RunResult) => void;
  const job = jobs.start("claude", null, "actually executing context", async () => new Promise(resolve => { finish = resolve; }));
  const controller = job.controller;
  const original = readStore(path())[0]!;
  writeFileSync(path(), JSON.stringify({ version: 4, jobs: [{ ...original, status: "done", sessionId: "external-final", finishedAt: Date.now() }] }));
  persist(jobs);
  expect(readStore(path())[0]!.status).toBe("done");
  expect(job.status).toBe("running");
  expect(job.controller).toBe(controller);
  expect(controller.signal.aborted).toBe(false);
  expect((jobs as unknown as { running: Map<string, unknown> }).running.get(job.id)).toBe(job);
  finish(done("actual executor finished")); await flush();
  expect(job.status).toBe("done");
  expect(controller.signal.aborted).toBe(false);
});

it("retains a throwing handoff continuation's accepted queue across persistence and restore until explicit retry", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_000);
  const executor = new LocalCoordinator("executor", "source-root"), owner = new LocalCoordinator("owner", "target-root");
  const source = manager(executor), target = manager(owner);
  const warning = vi.fn();
  (target as unknown as { log: typeof nullLogger }).log = { ...nullLogger, warn: warning };
  let finish!: (result: RunResult) => void;
  const job = source.start("claude", null, "exact original context", async () => new Promise(resolve => { finish = resolve; }));
  const original = readStore(path())[0]!;
  writeFileSync(path(), JSON.stringify({ version: 4, jobs: [{ ...original,
    owner: owner.name, supervisor: owner.currentSessionId, rootSession: owner.currentSessionId, rootName: owner.name,
    executionOwner: executor.name, ownershipHistory: [{ id: "handoff", at: 1_000, from: executor.name, to: owner.name,
      rootSession: owner.currentSessionId, rootName: owner.name, reason: "explicit-handoff" }] }] }));
  source.refreshOwnership(); target.refreshOwnership();
  const delegate = vi.fn(async () => done("continued"));
  const factory = vi.fn<Resume>(() => {
    throw new Error("synthetic resume preparation failed");
  });
  target.restore(() => factory);
  const observer = target.find(job.name)!;
  const controller = observer.controller;
  for (const body of ["first accepted", "second accepted"]) executor.emit("inline_job_control", { job: job.name, control: { type: "message", body } });
  finish(done("executor completed")); await flush();
  const completed = readStore(path())[0]!;
  persist(target); // Same-turn terminal reconciliation schedules the post-lock microtask.
  await flush(); await flush(); // A thrown factory must not escape this microtask.
  expect(factory).toHaveBeenCalledTimes(1);
  expect(factory).toHaveBeenCalledWith("first accepted\n\nsecond accepted", "retained-native-session", home, null);
  expect(delegate).not.toHaveBeenCalled();
  expect(observer).toMatchObject({ status: "done", startedAt: completed.startedAt, queue: ["first accepted", "second accepted"],
    continuationFailure: { turn: completed.startedAt, error: "Error: synthetic resume preparation failed" } });
  expect(observer.controller).toBe(controller);
  expect(controller.signal.aborted).toBe(false);
  expect((target as unknown as { running: Map<string, unknown>; waitingJobs: Map<string, unknown> }).running.has(job.id)).toBe(false);
  expect((target as unknown as { waitingJobs: Map<string, unknown> }).waitingJobs.has(job.id)).toBe(false);
  expect(warning).toHaveBeenCalledWith("subagent continuation could not be prepared; queued messages retained for explicit retry", expect.objectContaining({ queued: 2 }));
  persist(target); target.refreshOwnership(); checkWaiting(target);
  const restored = manager(owner);
  restored.restore(() => factory); restored.refreshOwnership(); checkWaiting(restored);
  await flush();
  expect(factory).toHaveBeenCalledTimes(1); // Neither polling nor a restart retries the failed factory.
  expect(readStore(path())[0]).toMatchObject({ status: "done", startedAt: completed.startedAt,
    queuedMessages: ["first accepted", "second accepted"], continuationFailure: { turn: completed.startedAt } });
  expect(() => target.followUp(job.name, "retry that also fails")).toThrow("synthetic resume preparation failed");
  persist(target); checkWaiting(target);
  expect(observer.controller).toBe(controller);
  expect(observer.startedAt).toBe(completed.startedAt);
  expect(readStore(path())[0]!.queuedMessages).toEqual(["first accepted", "second accepted", "retry that also fails"]);
  factory.mockImplementation(() => delegate);
  expect(target.followUp(job.name, "explicit retry").outcome).toBe("started");
  expect(factory).toHaveBeenLastCalledWith("first accepted\n\nsecond accepted\n\nretry that also fails\n\nexplicit retry", "retained-native-session", home, null);
  expect(observer.startedAt).toBeGreaterThan(completed.startedAt);
  await flush(); await flush();
  expect(delegate).toHaveBeenCalledTimes(1);
  expect(readStore(path())[0]).toMatchObject({ status: "done", queuedMessages: [], continuationFailure: null });
});

it("retains queued messages when the executor's automatic continuation factory throws", async () => {
  const node = new LocalCoordinator("executor", "source-root"), jobs = manager(node);
  let finish!: (result: RunResult) => void;
  const factory = vi.fn(() => { throw new Error("synthetic automatic continuation failure"); });
  const job = jobs.start("claude", null, "original context", async () => new Promise(resolve => { finish = resolve; }), factory);
  expect(jobs.followUp(job.name, "accepted while executing").outcome).toBe("queued");
  const turn = job.startedAt, controller = job.controller;
  finish(done("original result")); await flush(); await flush();
  persist(jobs); jobs.refreshOwnership(); checkWaiting(jobs);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(job).toMatchObject({ status: "done", startedAt: turn, queue: ["accepted while executing"] });
  expect(job.controller).toBe(controller);
  expect(controller.signal.aborted).toBe(false);
  expect(readStore(path())[0]).toMatchObject({ status: "done", queuedMessages: ["accepted while executing"], continuationFailure: { turn } });
});

it("admits a durable local continuation without leaving a waiter that intercepts live messages or cancellation", async () => {
  const jobs = manager(new LocalCoordinator("executor", "source-root"));
  const liveMessage = vi.fn();
  const factory = vi.fn<Resume>(() => async (signal, _progress, active) => {
    active.live = { post: liveMessage };
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("current continuation cancelled")), { once: true });
    });
  });
  const job = jobs.start("claude", null, "original durable context", async () => done("first turn complete"), factory);
  await flush(); await flush();
  expect(readStore(path())[0]).toMatchObject({ status: "done", sessionId: "retained-native-session" });
  const firstTurn = job.startedAt;
  expect(jobs.followUp(job.name, "resume exact context").outcome).toBe("started");
  expect(factory).toHaveBeenCalledWith("resume exact context", "retained-native-session", home, null);
  expect(job.startedAt).toBeGreaterThan(firstTurn);
  expect(jobs.waiting()).toEqual([]);
  const controller = job.controller;
  expect(controller.signal.aborted).toBe(false);
  expect(jobs.followUp(job.name, "steer the current continuation").outcome).toBe("delivered");
  expect(liveMessage).toHaveBeenCalledWith("steer the current continuation");
  expect(job.queue).toEqual([]);
  expect(jobs.waiting()).toEqual([]);
  expect(jobs.cancel(job.name)).toBe(true);
  expect(job.controller).toBe(controller);
  expect(controller.signal.aborted).toBe(true);
  await flush(); await flush();
  expect(factory).toHaveBeenCalledTimes(1);
  expect(job.status).toBe("failed");
  expect(readStore(path())[0]).toMatchObject({ status: "failed", queuedMessages: [] });
});
