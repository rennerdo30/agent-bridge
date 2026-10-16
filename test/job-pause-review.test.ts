import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { runnerTurnOutcome } from "../src/mcp/job-runner.js";
import { JobManager, PAUSE_RACE_NOTE, readStore, type Job, type Run, type RunnerState, type RunResult } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { RemoteJobHost } from "../src/mcp/remote-job-host.js";

// AB-398 review fixes: restart, race, leftover-process, approval, remote and pause-all behaviour of pause/resume.
const managers: JobManager[] = [];
const nodes = new Map<JobManager, LocalCoordinator>();
afterEach(() => {
  for (const jobs of managers.splice(0)) { jobs.setDormant(true); jobs.cancelAll(); }
  nodes.clear();
  vi.restoreAllMocks();
});

function manager(path: string) {
  const node = new LocalCoordinator("owner", "owner-session");
  Object.assign(node, { jobAuthority: async (ref: string) => readStore(path).find(j => j.name === ref || j.id === ref) ?? null });
  const jobs = new JobManager(node, nullLogger, path, 3);
  managers.push(jobs); nodes.set(jobs, node);
  return jobs;
}
function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), "ab-pause-review-")), "jobs.json");
  return { jobs: manager(path), path };
}

const answer = { text: "finished", sessionId: "same-native-session", isError: false, details: {} };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const abortable = (): Run => signal => new Promise(resolve => signal.addEventListener("abort", () => resolve({ ...answer, status: "cancelled" }), { once: true }));
const bodies = (jobs: JobManager) => nodes.get(jobs)!.unread().map(m => m.body);
const hostedRun = (): Run => Object.assign(async () => answer, { hosted: () => ({ pid: 123, peer: "runner", startedAt: Date.now() }) });

it("keeps a paused queued start paused across a restart until it is resumed (H2)", async () => {
  const { jobs, path } = fixture();
  jobs.setLimit(1);
  const busy = jobs.start("codex", null, "busy", abortable());
  const initial = vi.fn(async () => answer);
  const waiting = jobs.start("codex", null, "waiting", initial);
  expect(jobs.pause(waiting.name, "owner build")).toBe(true);
  jobs.cancel(busy.name); await flush();
  jobs.setDormant(true); jobs.cancelAll();
  expect(readStore(path).find(j => j.id === waiting.id)).toMatchObject({ status: "paused", waitingForStart: true });

  const second = manager(path);
  const rebuilt = vi.fn(async () => answer);
  const resume = vi.fn((_prompt: string, _session: string): Run => rebuilt);
  second.restore(() => resume);
  second.setLimit(3); await flush();
  expect(resume).not.toHaveBeenCalled();
  expect(initial).not.toHaveBeenCalled();
  expect(second.find(waiting.name)).toMatchObject({ status: "paused", pauseReason: "owner build" });
  expect(second.resumePaused(waiting.name)).toEqual([waiting.name]);
  await flush();
  expect(resume).toHaveBeenCalledOnce();
  expect(resume.mock.calls[0]?.[0]).toBe("waiting");
  expect(rebuilt).toHaveBeenCalledOnce();
});

it("settles a pending inline pause at restart so the job can be resumed (M1)", async () => {
  const { jobs, path } = fixture();
  const job = jobs.start("codex", null, "inline", () => new Promise(() => {}));
  jobs.note(job, { sessionId: "kept-session" });
  jobs.pause(job.name, "owner build");
  expect(job).toMatchObject({ status: "paused", pausePending: true });
  jobs.setDormant(true); jobs.cancelAll();
  expect(readStore(path).find(j => j.id === job.id)).toMatchObject({ status: "paused", pausePending: true });

  const second = manager(path);
  const continued = vi.fn(async () => answer);
  const resume = vi.fn((_message: string, _sessionId: string): Run => continued);
  second.restore(() => resume);
  expect(second.find(job.name)).toMatchObject({ status: "paused", pausePending: false });
  expect(second.resumePaused(job.name)).toEqual([job.name]);
  await flush();
  expect(resume.mock.calls[0]?.[1]).toBe("kept-session");
  expect(resume.mock.calls[0]?.[0]).toContain("You were paused (owner build)");
  expect(continued).toHaveBeenCalledOnce();
});

it("keeps one resume note and the slot-queue place of a waiting resume across a restart (L3)", async () => {
  const { jobs, path } = fixture();
  jobs.setLimit(1);
  const resume = vi.fn((_message: string, _sessionId: string): Run => async () => answer);
  const paused = jobs.start("codex", null, "paused one", abortable(), resume);
  jobs.note(paused, { sessionId: "paused-session" });
  jobs.pause(paused.name, "owner build"); await flush();
  expect(paused).toMatchObject({ status: "paused", pausePending: false });
  jobs.start("codex", null, "busy", abortable());
  expect(jobs.resumePaused(paused.name)).toEqual([paused.name]);
  expect(jobs.resumePaused(paused.name)).toEqual([paused.name]);
  expect(resume).not.toHaveBeenCalled();
  expect(paused.queue.filter(body => body.startsWith("You were paused"))).toHaveLength(1);
  expect(jobs.waiting().map(j => j.name)).toContain(paused.name);
  jobs.setDormant(true); jobs.cancelAll();
  expect(readStore(path).find(j => j.id === paused.id)).toMatchObject({ status: "paused", resumeRequested: true });

  const second = manager(path);
  const continued = vi.fn(async () => answer);
  const resumed = vi.fn((_message: string, _sessionId: string): Run => continued);
  second.restore(() => resumed);
  expect(second.waiting().map(j => j.name)).toContain(paused.name);
  second.setLimit(3); await flush();
  expect(resumed).toHaveBeenCalledOnce();
  expect(resumed.mock.calls[0]?.[1]).toBe("same-native-session");
  expect(resumed.mock.calls[0]?.[0].match(/You were paused/g)).toHaveLength(1);
});

it("delivers a report when a pause races a completed inline turn (H3)", async () => {
  const { jobs } = fixture();
  const job = jobs.start("codex", null, "racing", async () => ({ ...answer, text: "the real result" }));
  expect(jobs.pause(job.name, "owner build")).toBe(true);
  expect(job.status).toBe("paused");
  await flush();
  expect(job.status).toBe("done");
  expect(job.pauseReason).toBeUndefined();
  expect(bodies(jobs).find(body => body.includes("the real result"))).toContain(PAUSE_RACE_NOTE);
  expect(() => jobs.pause(job.name)).toThrow(`${job.name} already finished (done); there is no turn to pause.`);
});

it("delivers a blocking ask's result when a pause races its completion (H3)", () => {
  const { jobs } = fixture();
  const tracked = jobs.track("codex", null, "ask task");
  expect(jobs.pause(tracked.job.name, "owner build")).toBe(true);
  expect(tracked.job.controller.signal.aborted).toBe(true);
  tracked.end({ result: { ...answer, text: "ask result" } });
  expect(tracked.job).toMatchObject({ status: "done", pausePending: false });
  expect(tracked.job.pauseReason).toBeUndefined();
});

it("settles a hosted runner's finished report normally when the pause raced it (H3)", async () => {
  const { jobs } = fixture();
  let state: RunnerState | null = null;
  let alive = true;
  jobs.runners = { state: () => state, alive: () => alive, send: vi.fn(), kill: vi.fn() };
  const job = jobs.start("codex", null, "hosted", hostedRun(), vi.fn());
  jobs.pause(job.name, "owner build");
  state = { pid: 123, peer: "runner", status: "done", updatedAt: Date.now(), sessionId: "s", report: `runner result\n\n${PAUSE_RACE_NOTE}`, delivered: false };
  alive = false;
  jobs.list(); await flush();
  expect(job.status).toBe("done");
  expect(bodies(jobs).some(body => body.includes("runner result") && body.includes(PAUSE_RACE_NOTE))).toBe(true);
});

it("decides runner turn outcomes for pause races and leftover processes (H3, M6)", () => {
  const base = { scoped: true, processesStopped: true };
  expect(runnerTurnOutcome({ ...base, status: "done", completed: true, pausePending: false })).toEqual({ status: "done", pauseRaced: false, pausedWithLeftovers: false });
  expect(runnerTurnOutcome({ ...base, status: "done", completed: true, pausePending: true })).toEqual({ status: "done", pauseRaced: true, pausedWithLeftovers: false });
  // Leftover processes make a completed turn "failed", but its report is still delivered rather than swallowed.
  expect(runnerTurnOutcome({ scoped: true, processesStopped: false, status: "failed", completed: true, pausePending: true })).toEqual({ status: "failed", pauseRaced: true, pausedWithLeftovers: false });
  expect(runnerTurnOutcome({ ...base, status: "failed", completed: false, pausePending: true })).toEqual({ status: "paused", pauseRaced: false, pausedWithLeftovers: false });
  // A pause whose job-owned processes would not stop stays a pause (never a silent cancellation) and reports them.
  expect(runnerTurnOutcome({ scoped: true, processesStopped: false, status: "failed", completed: false, pausePending: true })).toEqual({ status: "paused", pauseRaced: false, pausedWithLeftovers: true });
  expect(runnerTurnOutcome({ scoped: false, processesStopped: false, status: "failed", completed: false, pausePending: true })).toEqual({ status: "paused", pauseRaced: false, pausedWithLeftovers: false });
});

it("keeps a runner-reported pause paused when its turn did not finish (M6)", async () => {
  const { jobs } = fixture();
  let state: RunnerState | null = null;
  let alive = true;
  jobs.runners = { state: () => state, alive: () => alive, send: vi.fn(), kill: vi.fn() };
  const job = jobs.start("codex", null, "hosted", hostedRun(), vi.fn());
  jobs.pause(job.name, "owner build");
  state = { pid: 123, peer: "runner", status: "paused", updatedAt: Date.now(), sessionId: "s" };
  alive = false;
  jobs.list(); await flush();
  expect(job).toMatchObject({ status: "paused", pausePending: false, pauseReason: "owner build" });
  expect(bodies(jobs).some(body => /cancelled/i.test(body))).toBe(false);
});

it("withdraws a pending approval as paused, not as a cancellation (L9)", async () => {
  const { jobs } = fixture();
  let decision: { allow: boolean; reason: string } | undefined;
  const job = jobs.start("codex", null, "asks", (_signal, _progress, self) => jobs.askParent(self!, "may I write?", 60_000).then(r => {
    decision = r;
    return { ...answer, isError: true, status: "cancelled" as const };
  }));
  await flush();
  jobs.pause(job.name, "owner build");
  await flush();
  expect(decision).toEqual({ allow: false, reason: "job paused" });
  expect(bodies(jobs).some(body => body.includes("withdrawn because the job was paused"))).toBe(true);
  expect(bodies(jobs).some(body => body.includes("denied by cancellation"))).toBe(false);
  expect(job.status).toBe("paused");
});

it("pauses a remote ask through its remote control (remote pause)", async () => {
  const { jobs } = fixture();
  const control = vi.fn();
  let finish!: (result: RunResult) => void;
  const job = jobs.start("codex", null, "remote", (_signal, _progress, self) => {
    self!.remoteControl = control;
    return new Promise<RunResult>(resolve => { finish = resolve; });
  }, vi.fn());
  jobs.pause(job.name, "owner build");
  expect(control).toHaveBeenCalledOnce();
  expect(control).toHaveBeenCalledWith({ type: "pause", reason: "owner build" });
  expect(job.controller.signal.aborted).toBe(false);
  // remote-ask maps a remote "paused" runner state to a cancelled run result.
  finish({ ...answer, text: "Remote paused", isError: true, status: "cancelled" });
  await flush();
  expect(job).toMatchObject({ status: "paused", pausePending: false });
});

it("sends a remote runner's pause once per turn however often it is requested (L6)", async () => {
  const home = mkdtempSync(join(tmpdir(), "ab-remote-pause-"));
  const remoteJob = vi.fn(async () => ({ state: null, alive: true, approvals: [] }));
  const host = new RemoteJobHost({ remoteJob } as unknown as BridgeNode, home, nullLogger);
  const job = { id: "abc", name: "codex-job-abc", startedAt: 1, remote: { host: "pc2", name: "codex-job-abc" } } as unknown as Job;
  host.send(job, { type: "pause", reason: "owner build" });
  host.send(job, { type: "pause", reason: "owner build" });
  expect(remoteJob).toHaveBeenCalledOnce();
  expect(remoteJob).toHaveBeenCalledWith("pc2", { op: "control", job: "abc", control: { type: "pause", reason: "owner build" } });
  job.startedAt = 2;
  host.send(job, { type: "pause", reason: "next turn" });
  expect(remoteJob).toHaveBeenCalledTimes(2);
  await flush();
});

it("pauses and resumes only this supervisor's jobs and reports per-job failures (M4)", async () => {
  const { jobs } = fixture();
  const resume = vi.fn((): Run => async () => answer);
  const one = jobs.start("codex", null, "one", abortable(), resume);
  const two = jobs.start("codex", null, "two", abortable());
  const foreign = jobs.start("codex", null, "foreign", abortable(), resume);
  jobs.note(one, { sessionId: "session-one" });
  foreign.owner = "another-supervisor";
  const original = jobs.pause.bind(jobs);
  const spy = vi.spyOn(jobs, "pause").mockImplementation((ref: string, reason?: string) => {
    if (ref === two.name) throw new Error("store busy");
    return original(ref, reason);
  });
  expect(jobs.pauseAll("owner build")).toEqual({ paused: [one.name], failed: [{ job: two.name, error: "store busy" }] });
  expect(one.status).toBe("paused");
  expect(two.status).toBe("running");
  expect(foreign.status).toBe("running");
  expect(foreign.controller.signal.aborted).toBe(false);
  spy.mockRestore();
  jobs.pause(two.name, "owner build");
  await flush();
  // two has no retained session: its resume fails alone, and one still resumes.
  expect(jobs.resumeAll()).toEqual({ resumed: [one.name], failed: [{ job: two.name, error: `${two.name} has no retained session to resume.` }] });
  await flush();
  expect(resume).toHaveBeenCalledOnce();
  expect(two.status).toBe("paused");
});

it("caps the pause reason and refuses jobs with nothing to pause", () => {
  const { jobs } = fixture();
  const job = jobs.start("codex", null, "long reason", abortable());
  jobs.pause(job.name, "x".repeat(800));
  expect(job.pauseReason).toHaveLength(500);
  expect(() => jobs.pause(job.name)).toThrow(`${job.name} is already paused.`);
  expect(() => jobs.pause("codex-job-missing")).toThrow("Unknown job codex-job-missing.");
  expect(() => jobs.resumePaused("codex-job-missing")).toThrow("codex-job-missing is not paused.");
});
