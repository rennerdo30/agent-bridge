import { expect, it, vi } from "vitest";
import { deliverFinalResult, readStoredFinalResult, resultDeliveryLabel, type StoredFinalResult } from "../src/mcp/final-result.js";
import { writeRunnerState } from "../src/mcp/job-host.js";
import { JobManager, type Job, type RunnerState } from "../src/mcp/jobs.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, until } from "./helpers.js";

const report = "Subagent codex-job-12345678 done after 1s.\n\nFinal review";
const initial = (): StoredFinalResult => ({ report, reportId: "turn-one", delivered: false });

it("stores before a failed send, then retries with the same identity", async () => {
  let saved: StoredFinalResult | null = null;
  const persist = vi.fn((state: StoredFinalResult) => { saved = { ...state }; });
  const send = vi.fn().mockRejectedValueOnce(new Error("broker restarted")).mockResolvedValue({ stored: true });
  await deliverFinalResult(initial(), persist, send, async () => {});
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]).toEqual([report, "turn-one"]);
  expect(send.mock.calls[1]).toEqual([report, "turn-one"]);
  expect(persist.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
  expect(saved).toMatchObject({ delivered: true });
});

it("does not send while durable storage rejects the result", async () => {
  const persist = vi.fn().mockImplementationOnce(() => { throw new Error("database busy"); }).mockImplementation(() => {});
  const send = vi.fn().mockResolvedValue({ stored: true });
  await deliverFinalResult(initial(), persist, send, async () => {});
  expect(persist).toHaveBeenCalledTimes(3);
  expect(persist.mock.invocationCallOrder[1]).toBeLessThan(send.mock.invocationCallOrder[0]!);
});

it("resumes an undelivered stored result after the sender restarts", async () => {
  let saved = initial();
  const controller = new AbortController();
  const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ stored: true });
  await deliverFinalResult(saved, (state) => { saved = { ...state }; }, send, async () => controller.abort(), controller.signal);
  expect(saved).toMatchObject({ report, reportId: "turn-one", delivered: false });
  expect(resultDeliveryLabel(saved, false)).toBe("result stored, not delivered");
  await deliverFinalResult(saved, (state) => { saved = { ...state }; }, send, async () => {});
  expect(send).toHaveBeenCalledTimes(2);
  expect(saved.delivered).toBe(true);
});

it("allows the parent to fetch the stored report after delivery fails", async () => {
  const env = makeEnv();
  try {
    const controller = new AbortController();
    await deliverFinalResult(initial(), (state) => writeRunnerState(env.home, "12345678", {
      pid: process.pid, peer: "codex-job-12345678", status: "done", updatedAt: Date.now(), ...state,
    }), async () => { throw new Error("offline"); }, async () => controller.abort(), controller.signal);
    const fetched = readStoredFinalResult(env.home, "12345678");
    expect(fetched?.report).toBe(report);
    expect(resultDeliveryLabel(fetched, false)).toBe("result stored, not delivered");
  } finally { await env.cleanup(); }
});

it("does not send again after a durable receipt", async () => {
  const send = vi.fn();
  await deliverFinalResult({ ...initial(), delivered: true }, () => {}, send, async () => {});
  expect(send).not.toHaveBeenCalled();
  const persist = vi.fn();
  const receipt = vi.fn().mockResolvedValue(true);
  await deliverFinalResult(initial(), persist, send, async () => {}, undefined, receipt);
  expect(receipt).toHaveBeenCalledWith("turn-one");
  expect(send).not.toHaveBeenCalled();
  expect(persist).toHaveBeenLastCalledWith({ ...initial(), delivered: true });
  expect(resultDeliveryLabel(initial(), true)).toBe("delivered");
});

it("stops on a permanent refusal so the retained result can be posted by the session", async () => {
  let saved = initial();
  const send = vi.fn().mockRejectedValue(Object.assign(new Error("owner unavailable"), { code: "unauthorized" }));
  const wait = vi.fn(async () => {});
  await deliverFinalResult(saved, state => { saved = state; }, send, wait);
  expect(send).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
  expect(saved).toEqual(initial());
  const env = makeEnv();
  const node = env.node("claude-permanent-refusal", "claude");
  await node.start();
  const jobs = new JobManager(node, nullLogger);
  try {
    const job = jobs.start("codex", null, "review", async () => new Promise(() => {}));
    job.host = { pid: process.pid, peer: job.name, startedAt: job.startedAt };
    const final: RunnerState = { pid: process.pid, peer: job.name, status: "done", updatedAt: Date.now(), ...saved };
    jobs.runners = { state: () => final, alive: () => false, send: vi.fn(), kill: vi.fn() };
    (jobs as unknown as { checkHosted(job: Job, ownershipRefreshed: boolean, polledState: RunnerState): void }).checkHosted(job, true, final);
    await until(() => node.unread().some(message => message.body === report));
    expect(job.status).toBe("done");
    expect(job.report).toBe(report);
  } finally { jobs.cancelAll(); await env.cleanup(); }
});

it("caps transient delivery attempts with the same ID and leaves the result for session fallback", async () => {
  let saved = initial();
  const send = vi.fn().mockRejectedValue(new Error("broker offline"));
  const waits: number[] = [];
  await deliverFinalResult(saved, state => { saved = state; }, send, async ms => { waits.push(ms); });
  expect(send).toHaveBeenCalledTimes(6);
  expect(send.mock.calls.every(call => call[1] === "turn-one")).toBe(true);
  expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  expect(saved.delivered).toBe(false);
});

it("posts the same retained report when the runner exits without delivery", async () => {
  const env = makeEnv();
  const node = env.node("claude-final-fallback", "claude");
  await node.start();
  const jobs = new JobManager(node, nullLogger);
  try {
    const job = jobs.start("codex", null, "review", async () => new Promise(() => {}));
    job.host = { pid: process.pid, peer: job.name, startedAt: job.startedAt };
    const final = { pid: process.pid, peer: job.name, status: "done" as const, updatedAt: Date.now(),
      finishedAt: 12345, report, reportId: "turn-one", delivered: false };
    jobs.runners = { state: () => final, alive: () => false, send: vi.fn(), kill: vi.fn() };
    (jobs as unknown as { checkHosted(job: Job, ownershipRefreshed: boolean, polledState: RunnerState): void }).checkHosted(job, true, final);
    await until(() => node.unread().some(message => message.body === report));
    expect(job).toMatchObject({ status: "done", report, finishedAt: 12345 });
    expect(node.unread().filter(message => message.body === report)).toHaveLength(1);
  } finally { jobs.cancelAll(); await env.cleanup(); }
});

it("clears a stored report when a new turn starts", async () => {
  const env = makeEnv();
  const node = env.node("claude-result-turns", "claude");
  await node.start();
  const jobs = new JobManager(node, nullLogger);
  try {
    const job = jobs.start("codex", null, "review", async () => ({ sessionId: "first", text: "Old report", isError: false, details: {} }),
      () => async () => new Promise(() => {}));
    await until(() => job.status === "done");
    expect(job.report).toContain("Old report");
    expect(job.finishedAt).toBeTypeOf("number");
    expect(jobs.followUp(job.name, "next review").outcome).toBe("started");
    expect(job).toMatchObject({ status: "running" });
    expect(job.report).toBeUndefined();
    expect(job.finishedAt).toBeUndefined();
  } finally { jobs.cancelAll(); await env.cleanup(); }
});
