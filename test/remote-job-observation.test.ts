import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { JobRunners } from "../src/mcp/job-host.js";
import { JobManager, readStore, type Job, type Run } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { RemoteJobHost } from "../src/mcp/remote-job-host.js";
import type { RemoteJobRequest } from "../src/network/remote-job-protocol.js";
import type { RemoteJobSnapshot } from "../src/network/remote-jobs.js";

const managers: JobManager[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
});
afterEach(() => {
  for (const jobs of managers.splice(0)) jobs.setDormant(true);
  vi.useRealTimers();
});

function snapshot(status: "running" | "done" | "failed" | "cancelled" = "running", alive = status === "running"): RemoteJobSnapshot {
  return { alive, approvals: [], state: { pid: 123, peer: "pc2/codex-job-12345678", status,
    updatedAt: Date.now(), sessionId: "remote-session", progress: "last authoritative progress",
    ...(status === "running" ? {} : { report: `remote ${status} report`, finishedAt: Date.now(), delivered: true }) } };
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ab-remote-observation-"));
  const path = join(home, "jobs.json");
  let observe = async (): Promise<RemoteJobSnapshot> => snapshot();
  const remoteJob = vi.fn((_host: string, request: RemoteJobRequest): Promise<RemoteJobSnapshot> =>
    request.op === "spawn" ? Promise.resolve(snapshot()) : observe());
  const resume = vi.fn((): Run => async () => { throw new Error("Unexpected continuation"); });
  function reopen() {
    const node = Object.assign(new LocalCoordinator("owner", "owner-session"), { remoteJob });
    const jobs = new JobManager(node, nullLogger, path, 2);
    jobs.runners = new JobRunners(node as unknown as BridgeNode, home, "unused-cli", nullLogger);
    managers.push(jobs);
    return { jobs, node };
  }
  const { jobs, node } = reopen();
  const host = new RemoteJobHost(node as unknown as BridgeNode, home, nullLogger);
  const run = Object.assign(vi.fn<Run>(async () => { throw new Error("Unexpected inline execution"); }), {
    hosted: (job: Job) => host.start(job, "pc2", "codex", { prompt: "task", title: "Observation fixture", cwd: home }),
  });
  const job = jobs.start("codex", null, "task", run, resume, { cwd: home });
  const operations = () => remoteJob.mock.calls.map(([, request]) => request.op);
  const stored = () => readStore(path).find(saved => saved.id === job.id);
  return { home, job, jobs, node, run, resume, remoteJob, reopen, operations, stored,
    observe: (next: typeof observe) => { observe = next; } };
}

it.each(["done", "failed", "cancelled"] as const)("keeps a running job across failed polls past 90s, then accepts reconnected %s", async status => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  const originalHost = f.job.host;
  f.observe(async () => { throw new Error("link unavailable"); });

  await vi.advanceTimersByTimeAsync(92_000);
  expect(f.job.status).toBe("running");
  expect(f.job.host).toBe(originalHost);
  expect(f.job.progress).toBe("last authoritative progress");
  expect(f.job.report).toBeUndefined();
  expect(f.stored()).toMatchObject({ status: "running", host: originalHost });
  expect(f.node.unread()).toEqual([]);
  expect(f.operations().filter(op => op === "spawn")).toHaveLength(1);
  expect(f.operations().filter(op => op === "control")).toEqual([]);
  expect(f.run).not.toHaveBeenCalled();
  expect(f.resume).not.toHaveBeenCalled();

  f.observe(async () => snapshot(status));
  await vi.advanceTimersByTimeAsync(4_000);
  expect(f.job).toMatchObject({ status, host: null, report: `remote ${status} report` });
  expect(f.stored()).toMatchObject({ status, host: null });
  expect(f.operations().filter(op => op !== "state")).toEqual(["spawn"]);
  expect(f.resume).not.toHaveBeenCalled();
});

it("keeps a running job while a poll is deferred past expiry, without overlapping requests", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  let reply!: (value: RemoteJobSnapshot) => void;
  f.observe(() => new Promise(resolve => { reply = resolve; }));
  await vi.advanceTimersByTimeAsync(92_000);

  expect(f.job.status).toBe("running");
  expect(f.job.host).toBeTruthy();
  expect(f.operations()).toEqual(["spawn", "state"]);
  // Positive runner-loss evidence still ends the job, even without a final report.
  f.observe(async () => ({ state: null, alive: false, approvals: [] }));
  reply({ state: null, alive: false, approvals: [] });
  await vi.advanceTimersByTimeAsync(2_000);
  expect(f.job).toMatchObject({ status: "failed", host: null });
  expect(f.job.report).toContain("ended without reporting a result");
  expect(f.stored()).toMatchObject({ status: "failed", host: null });
  expect(f.operations().filter(op => op !== "state")).toEqual(["spawn"]);
  expect(f.resume).not.toHaveBeenCalled();
});

it("settles a freshly confirmed dead remote runner without waiting for observation expiry", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  f.observe(async () => ({ state: null, alive: false, approvals: [] }));
  await vi.advanceTimersByTimeAsync(4_000);

  expect(f.job).toMatchObject({ status: "failed", host: null });
  expect(f.job.report).toContain("ended without reporting a result");
  expect(f.stored()).toMatchObject({ status: "failed", host: null });
  expect(f.operations().filter(op => op !== "state")).toEqual(["spawn"]);
  expect(f.resume).not.toHaveBeenCalled();
});

it("adopts a reopened running job with no cached observation and does not retry spawn or control", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  f.jobs.setDormant(true);
  rmSync(join(f.home, "remote-job-states", `${f.job.id}.json`));
  f.observe(async () => { throw new Error("link unavailable after reopen"); });
  await vi.advanceTimersByTimeAsync(92_000);
  const reopened = f.reopen();
  reopened.jobs.restore(() => f.resume);
  const adopted = reopened.jobs.find(f.job.name)!;
  const controlsAtRestore = f.operations().filter(op => op === "control").length;
  await vi.advanceTimersByTimeAsync(92_000);

  expect(adopted.status).toBe("running");
  expect(adopted.host).toEqual(f.job.host);
  expect(adopted.report).toBeUndefined();
  expect(f.stored()).toMatchObject({ status: "running", host: f.job.host });
  expect(reopened.node.unread()).toEqual([]);
  expect(f.operations().filter(op => op === "spawn")).toHaveLength(1);
  expect(f.operations().filter(op => op === "control")).toHaveLength(controlsAtRestore);
  expect(f.remoteJob.mock.calls.filter(([, request]) => request.op === "control").every(([, request]) =>
    request.op === "control" && request.control.type === "attach")).toBe(true);
  expect(f.run).not.toHaveBeenCalled();
  expect(f.resume).not.toHaveBeenCalled();
});

it.each(["done", "failed", "cancelled"] as const)("retains an expired %s observation across reopen while the link is unavailable", async status => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(0);
  f.jobs.setDormant(true);
  f.observe(async () => snapshot(status));
  // Fetch terminal evidence without letting the dormant manager consume it yet.
  await vi.advanceTimersByTimeAsync(2_000);
  f.jobs.runners!.state(f.job);
  await vi.advanceTimersByTimeAsync(0);
  f.observe(async () => { throw new Error("link unavailable"); });
  await vi.advanceTimersByTimeAsync(92_000);
  const reopened = f.reopen();
  reopened.jobs.restore(() => f.resume);
  await vi.advanceTimersByTimeAsync(0);

  expect(reopened.jobs.find(f.job.name)).toMatchObject({ status, host: null, report: `remote ${status} report` });
  expect(f.stored()).toMatchObject({ status, host: null });
  expect(reopened.jobs.runners!.state(f.job)?.report).toBe(`remote ${status} report`);
  expect(f.operations().filter(op => op !== "state")).toEqual(["spawn"]);
  expect(f.resume).not.toHaveBeenCalled();
});
