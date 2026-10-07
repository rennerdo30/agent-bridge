import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { ResourceSlots } from "../src/core/resource-slots.js";
import { RootConcurrency } from "../src/core/root-concurrency.js";
import { STARTUP_RESOURCE, STARTUP_CAPACITY } from "../src/core/startup-admission.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { JobManager, readStore, type Run } from "../src/mcp/jobs.js";
import { JobRunners } from "../src/mcp/job-host.js";
import { runDelegate } from "../src/mcp/delegate-run.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { until } from "./helpers.js";

let home: string;
const managers: JobManager[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ab-admission-")); });
afterEach(() => { managers.splice(0).forEach(j => j.cancelAll()); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
const result = { text: "done", sessionId: "saved", isError: false, details: {} };
function manager(cap = 2) {
  const jobs = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger, join(home, "jobs.json"), cap);
  managers.push(jobs); return jobs;
}

it.each(["claude", "codex", "opencode", "antigravity"] as const)("releases the %s slot after synchronous hosted or inline startup failure", async agent => {
  const jobs = manager(1);
  jobs.runners = { state: () => null, alive: () => false, send() {}, kill() {} };
  const run: Run = Object.assign(async () => result, { hosted: () => { throw new Error("ownership setup failed before launch"); } });
  const failed = jobs.start(agent, null, "fail", run);
  expect(failed.status).toBe("failed"); expect(jobs.runningCount()).toBe(0); expect(jobs.canStart()).toBe(true);
  const inline = jobs.start(agent, null, "fail inline", () => { throw new Error("pre-start validation"); });
  expect(inline.status).toBe("failed"); expect(jobs.canStart()).toBe(true);
  const next = jobs.start(agent, null, "next", async () => result);
  await until(() => next.status === "done");
});

it("queues a mass spawn in order, cancels unstarted work and never exceeds its running cap", async () => {
  const jobs = manager(2);
  const started: string[] = []; const finish: Array<() => void> = [];
  const run: Run = async (_signal, _progress, job) => {
    started.push(job.prompt); await new Promise<void>(resolve => finish.push(resolve)); return result;
  };
  const agents = ["claude", "codex", "opencode", "antigravity"] as const;
  const all = Array.from({ length: 25 }, (_, i) => jobs.start(agents[i % 4]!, null, `task-${i}`, run));
  expect(jobs.runningCount()).toBe(2); expect(jobs.waiting()).toHaveLength(23);
  expect(started).toEqual(["task-0", "task-1"]);
  expect(jobs.cancel(all[4]!.name)).toBe(true); expect(all[4]!.status).toBe("failed");
  for (let i = 0; i < 24; i++) {
    finish[i]!(); await until(() => all.filter(j => j.status === "done").length === i + 1);
    expect(jobs.runningCount()).toBeLessThanOrEqual(2);
  }
  expect(started).toEqual(all.filter((_, i) => i !== 4).map(j => j.prompt));
  expect(jobs.waiting()).toEqual([]);
});

it("restores an unstarted queued job after reload with its original prompt and spawn options", async () => {
  const first = manager(1);
  first.start("claude", null, "block", () => new Promise(() => {}));
  const queued = first.start("codex", "model", "original prompt", async () => result, undefined, { worktree: true, title: "Task", allow_tools: ["pair-desk:worker"] });
  expect(readStore(join(home, "jobs.json")).find(j => j.id === queued.id)).toMatchObject({ waitingForStart: true });
  first.cancelAll();
  const second = manager(1); const resume = vi.fn(() => async () => result);
  second.restore(() => resume);
  expect(second.waiting().map(j => j.id)).toContain(queued.id);
  second.setLimit(1);
  await until(() => second.find(queued.id)?.status === "done");
  expect(resume).toHaveBeenCalledWith("original prompt", "", null, null);
  expect(second.find(queued.id)?.args).toMatchObject({ worktree: true, title: "Task", allow_tools: ["pair-desk:worker"] });
});

it("keeps a real live runner visible despite stale or missing heartbeat and settles only after exit", () => {
  const jobs = manager(1);
  const runners = new JobRunners({} as any, home, "unused", nullLogger); jobs.runners = runners;
  const run: Run = Object.assign(async () => result, { hosted: () => ({ pid: process.pid, peer: "runner", startedAt: Date.now() - 120_000 }) });
  const job = jobs.start("codex", null, "live", run);
  const state = { pid: process.pid, peer: job.name, status: "running" as const, updatedAt: Date.now() - 600_000 };
  vi.spyOn(runners, "state").mockReturnValue(state);
  expect(jobs.list()).toContain(job); expect(jobs.canStart()).toBe(false);
  expect(runners.alive(job, null)).toBe(true);
  vi.spyOn(runners, "alive").mockReturnValue(false);
  expect(jobs.canStart()).toBe(true); expect(job.status).toBe("failed");
});

it("queues shared-root admission races and removes a cancelled ticket", async () => {
  const root = new RootConcurrency(home, "same-root"); const other = new RootConcurrency(home, "same-root");
  const holder = { id: "holder", pid: process.pid }; const waiter = { id: "waiter", pid: process.pid };
  try {
    root.setLimit(1); expect(root.acquire(holder)).toBe(true);
    const controller = new AbortController(); let admitted = false;
    const pending = other.acquireWhenAvailable(waiter, controller.signal).then(() => { admitted = true; });
    await new Promise(resolve => setTimeout(resolve, 20)); expect(admitted).toBe(false);
    root.release(holder); await pending; expect(admitted).toBe(true); other.release(waiter);
    expect(root.acquire(holder)).toBe(true);
    const cancel = new AbortController(); const cancelled = other.acquireWhenAvailable(waiter, cancel.signal);
    const rejected = expect(cancelled).rejects.toThrow(); cancel.abort(); await rejected;
    const slots = new ResourceSlots(home); try { expect(slots.list().map(s => s.id)).toEqual(["holder"]); } finally { slots.close(); }
  } finally { root.release(holder); other.release(waiter); root.close(); other.close(); }
});

it("bounds native startup across every CLI and releases admission on session, failure and cancellation", async () => {
  let active = 0, maximum = 0;
  const enter: Array<() => void> = [];
  for (const profile of Object.values(DELEGATION_TARGETS)) vi.spyOn(profile, "run").mockImplementation(async (_cfg, req) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise<void>(resolve => enter.push(() => { active--; req.onSession?.("native"); resolve(); }));
    return result;
  });
  const rc = { agent: "codex" as const, home, cfg: DEFAULT_CONFIG, log: nullLogger, me: () => "owner", cwd: () => home };
  const targets = ["claude", "codex", "opencode", "antigravity"] as const;
  const turns = targets.map(target => runDelegate(rc, target, { prompt: "Review", title: "Review" }, new AbortController().signal, undefined, true));
  await until(() => enter.length === 2); expect(maximum).toBe(2);
  enter[0]!(); enter[1]!(); await until(() => enter.length === 4); enter[2]!(); enter[3]!();
  await Promise.all(turns); expect(maximum).toBe(2);
  vi.mocked(DELEGATION_TARGETS.codex.run).mockRejectedValueOnce(new Error("failed before session"));
  await expect(runDelegate(rc, "codex", { prompt: "Fail", title: "Fail" }, new AbortController().signal, undefined, true)).rejects.toThrow("failed before session");
  const slots = new ResourceSlots(home);
  try {
    expect(slots.list()).toEqual([]);
    const holders = Array.from({ length: STARTUP_CAPACITY }, (_, i) => ({ id: `busy-${i}`, pid: process.pid }));
    holders.forEach(owner => expect(slots.tryAcquire(STARTUP_RESOURCE, STARTUP_CAPACITY, owner)).toBe(true));
    const controller = new AbortController();
    const pending = runDelegate(rc, "codex", { prompt: "Cancel before start", title: "Cancel" }, controller.signal, undefined, true);
    const rejected = expect(pending).rejects.toThrow();
    await until(() => slots.list().some(s => !s.held));
    controller.abort(); await rejected;
    expect(slots.list()).toHaveLength(holders.length);
    holders.forEach(owner => slots.release(owner));
  } finally { slots.close(); }
});

it.each(["claude", "codex", "opencode", "antigravity"] as const)("releases the real root lease when %s fails before its session starts", async agent => {
  const jobs = manager(1);
  const tracked = jobs.track(agent, null, "fail");
  vi.spyOn(DELEGATION_TARGETS[agent], "run").mockRejectedValue(new Error("pre-session failure"));
  const rc = { agent: "codex" as const, home, cfg: { ...DEFAULT_CONFIG, maxJobs: 1 }, log: nullLogger, me: () => "owner", cwd: () => home };
  await expect(runDelegate(rc, agent, { prompt: "Fail", title: "Fail" }, tracked.job.controller.signal, undefined, true, tracked.job)).rejects.toThrow("pre-session failure");
  tracked.end({ error: new Error("pre-session failure") });
  const slots = new ResourceSlots(home);
  try { expect(slots.list()).toEqual([]); expect(jobs.canStart()).toBe(true); } finally { slots.close(); }
});
