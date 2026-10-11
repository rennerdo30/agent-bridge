import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { t } from "../src/core/i18n.js";
import { acquireLock, JobManager, readStore, type HostedAdmission, type JobHostInfo, type Run, type RunnerState } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";

let home: string;
const managers: JobManager[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ab-cancel-resume-")); });
afterEach(() => {
  for (const jobs of managers.splice(0)) { jobs.setDormant(true); jobs.cancelAll(); }
  vi.restoreAllMocks();
});
const path = () => join(home, "jobs.json");
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const answer = { text: "retained answer", sessionId: "native-session", isError: false, details: {} };
function manager(name = "owner") {
  const node = new LocalCoordinator(name, `${name}-session`);
  Object.assign(node, { jobAuthority: async (ref: string) => readStore(path()).find(j => j.name === ref || j.id === ref) ?? null });
  const jobs = new JobManager(node, nullLogger, path(), 2); managers.push(jobs);
  return { jobs, node };
}
function pendingHost() {
  let resolve!: (host: JobHostInfo | null) => void;
  let reject!: (error: unknown) => void;
  let gate!: HostedAdmission;
  const inline = vi.fn(async () => answer);
  const run: Run = Object.assign(inline, { hosted: (_job: unknown, admission: HostedAdmission) => {
    gate = admission;
    return new Promise<JobHostInfo | null>((yes, no) => { resolve = yes; reject = no; });
  } });
  return { run, inline, resolve: (host: JobHostInfo | null) => resolve(host), reject: (error: unknown) => reject(error), gate: () => gate };
}
function hostFixture(jobs: JobManager) {
  let state: RunnerState | null = null, alive = true;
  const send = vi.fn(), kill = vi.fn();
  jobs.runners = { state: () => state, alive: () => alive, send, kill };
  return { send, kill, state: (next: RunnerState | null) => { state = next; }, alive: (next: boolean) => { alive = next; } };
}

it("rejects cancel/startup resumes with stopping, then cancelled-before-start, without inventing a session", async () => {
  const { jobs } = manager(), host = hostFixture(jobs), pending = pendingHost(), resume = vi.fn(() => pending.run);
  const job = jobs.start("codex", null, "original bytes", pending.run, resume);
  expect(jobs.cancel(job.name)).toBe(true);
  expect(pending.gate().signal.aborted).toBe(true);
  expect(jobs.followUp(job.name, "retry while stopping").outcome).toBe("stopping");
  pending.reject(pending.gate().signal.reason); await flush();
  expect(job.status).toBe("cancelled");
  expect(jobs.followUp(job.name, "retry after stop").outcome).toBe("cancelled-before-start");
  expect(jobs.followUp(job.name, "second retry").outcome).toBe("cancelled-before-start");
  expect(resume).not.toHaveBeenCalled(); expect(pending.inline).not.toHaveBeenCalled();
  expect(host.send).not.toHaveBeenCalled();
  expect(readStore(path())[0]).toMatchObject({ prompt: "original bytes", sessionId: null, status: "cancelled" });
  expect(t("followUp.cancelled-before-start", { name: job.name })).toContain("start a new job");
  expect(t("followUp.stopping", { name: job.name })).toContain("retry in 1 s");
});

it("cancels an initial slot waiter without starting a native session", () => {
  const { jobs } = manager(); jobs.setLimit(1);
  jobs.start("codex", null, "busy", () => new Promise(() => {}));
  const delegate = vi.fn(async () => answer);
  const waiting = jobs.start("codex", null, "not yet started", delegate);
  expect(waiting.waitingForStart).toBe(true);
  jobs.cancel(waiting.name);
  expect(jobs.followUp(waiting.name, "continue").outcome).toBe("cancelled-before-start");
  expect(delegate).not.toHaveBeenCalled();
});

it("retains the original initial run and its queued context while registry admission is busy", async () => {
  const { jobs } = manager();
  let complete!: (result: typeof answer) => void;
  const original = vi.fn(() => new Promise<typeof answer>(resolve => { complete = resolve; }));
  const continued = vi.fn(async () => answer), resume = vi.fn(() => continued);
  const release = acquireLock(`${path()}.lock`, 0);
  let job;
  try {
    job = jobs.start("codex", null, "original prompt bytes", original, resume);
    expect(job.waitingForStart).toBe(true);
    expect(jobs.followUp(job.name, "queued initial context").outcome).toBe("waiting");
    expect(original).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
  } finally { release(); }
  jobs.setLimit(2);
  expect(original).toHaveBeenCalledOnce(); expect(resume).not.toHaveBeenCalled();
  expect(job!.queue).toEqual(["queued initial context"]);
  complete(answer); await flush();
  expect(resume).toHaveBeenCalledExactlyOnceWith("queued initial context", "native-session", null, null);
  expect(continued).toHaveBeenCalledOnce();
});

it("waits for a delivered cancelled runner to EXIT before continuing its retained session", async () => {
  const { jobs } = manager(), fixture = hostFixture(jobs);
  const host = { pid: 123, peer: "runner", startedAt: Date.now() };
  const run: Run = Object.assign(async () => answer, { hosted: () => host });
  const resumed = vi.fn(async (signal: AbortSignal) => { expect(signal.aborted).toBe(false); return answer; });
  const resume = vi.fn(() => resumed);
  const job = jobs.start("codex", null, "task", run, resume);
  jobs.note(job, { sessionId: "native-session", workdir: home });
  jobs.cancel(job.name);
  fixture.state({ pid: 123, peer: "runner", status: "cancelled", stopping: true, delivered: true, sessionId: "native-session", updatedAt: Date.now() });
  expect(jobs.followUp(job.name, "resume while exiting").outcome).toBe("stopping");
  expect(resume).not.toHaveBeenCalled(); expect(job.host).toBe(host);
  fixture.alive(false);
  expect(jobs.followUp(job.name, "resume after exit").outcome).toBe("started");
  await flush();
  expect(resume).toHaveBeenCalledExactlyOnceWith("resume after exit", "native-session", home, null);
  expect(resumed).toHaveBeenCalledOnce();
});

it("keeps a native session learned AFTER cancel and queues its continuation until the inline turn stops", async () => {
  const { jobs } = manager();
  let stop!: (error: Error) => void;
  const resumed = vi.fn(async () => answer), resume = vi.fn(() => resumed);
  const job = jobs.start("codex", null, "starting", () => new Promise((_, reject) => { stop = reject; }), resume);
  jobs.cancel(job.name);
  expect(jobs.followUp(job.name, "too early").outcome).toBe("stopping");
  jobs.note(job, { sessionId: "native-session", workdir: home });
  expect(jobs.followUp(job.name, "retained follow-up").outcome).toBe("waiting");
  expect(resume).not.toHaveBeenCalled();
  stop(new Error("cancelled")); await flush();
  expect(resume).toHaveBeenCalledExactlyOnceWith("retained follow-up", "native-session", home, null);
  expect(readStore(path())[0]?.sessionId).toBe("native-session");
});

it("continues a cancelled foreground ask only after its caller reports the turn stopped", async () => {
  const { jobs } = manager();
  const run = vi.fn(async (signal: AbortSignal) => { expect(signal.aborted).toBe(false); return answer; });
  const resume = vi.fn(() => run), tracked = jobs.track("codex", null, "blocking ask", resume);
  jobs.cancel(tracked.job.name); jobs.note(tracked.job, { sessionId: "native-session" });
  expect(jobs.followUp(tracked.job.name, "after cancellation").outcome).toBe("waiting");
  expect(run).not.toHaveBeenCalled();
  tracked.end({ error: new Error("cancelled") }); await flush();
  expect(resume).toHaveBeenCalledExactlyOnceWith("after cancellation", "native-session", null, null);
  expect(run).toHaveBeenCalledOnce();
});

it("publishes startup cancellation to a second master whose controller was never aborted", async () => {
  const owner = manager(), observer = manager("other-master"), pending = pendingHost();
  hostFixture(owner.jobs); hostFixture(observer.jobs);
  const job = owner.jobs.start("codex", null, "startup", pending.run, () => pending.run);
  const document = JSON.parse(readFileSync(path(), "utf8"));
  document.jobs[0].masters = ["owner", "other-master"]; writeFileSync(path(), JSON.stringify(document));
  const observed = await observer.jobs.share(job.name);
  owner.jobs.cancel(job.name);
  expect(observed!.controller.signal.aborted).toBe(false);
  expect(observer.jobs.followUp(job.name, "other supervisor retry").outcome).toBe("stopping");
  pending.reject(pending.gate().signal.reason); await flush();
  await observer.jobs.share(job.name);
  expect(observer.jobs.followUp(job.name, "after stop").outcome).toBe("cancelled-before-start");
});

it("claims a continuation before asynchronous host admission and excludes a second manager", async () => {
  const first = manager(), second = manager(), pending = pendingHost();
  hostFixture(first.jobs); hostFixture(second.jobs);
  const job = first.jobs.start("codex", null, "initial", async () => answer); await flush();
  let competingOutcome: string | undefined;
  const continuation: Run = Object.assign(pending.run, { hosted: pending.run.hosted });
  const firstResume = vi.fn(() => continuation), secondResume = vi.fn(() => pending.run);
  first.jobs.restore(() => firstResume); second.jobs.restore(() => secondResume);
  const originalHosted = continuation.hosted!;
  continuation.hosted = (current, admission) => {
    competingOutcome = second.jobs.followUp(job.name, "concurrent master").outcome;
    expect(readStore(path())[0]).toMatchObject({ status: "running", executionOwner: "owner", sessionId: "native-session" });
    return originalHosted(current, admission);
  };
  expect(first.jobs.followUp(job.name, "first continuation").outcome).toBe("started");
  expect(competingOutcome).toBe("stopping");
  expect(firstResume).toHaveBeenCalledOnce(); expect(secondResume).not.toHaveBeenCalled();
  expect(pending.inline).not.toHaveBeenCalled();
  first.jobs.cancel(job.name); pending.reject(pending.gate().signal.reason); await flush();
});

it("does not abort or accept a retry while another process owns the job transition lease", async () => {
  const { jobs } = manager();
  const job = jobs.start("codex", null, "active", () => new Promise(() => {}));
  const key = createHash("sha256").update(job.id).digest("hex");
  const release = acquireLock(join(home, "job-controls", `${key}.lock`), 0);
  try {
    expect(jobs.followUp(job.name, "retry").outcome).toBe("stopping");
    expect(() => jobs.cancel(job.name)).toThrow("retry cancellation in 1 s");
    expect(job.controller.signal.aborted).toBe(false); expect(job.queue).toEqual([]);
  } finally { release(); }
  jobs.cancel(job.name);
});

it("retries an inline cancellation control after temporary lease contention", async () => {
  const { jobs, node } = manager();
  const job = jobs.start("codex", null, "active", () => new Promise(() => {}));
  const key = createHash("sha256").update(job.id).digest("hex");
  const release = acquireLock(join(home, "job-controls", `${key}.lock`), 0);
  try {
    node.emit("inline_job_control", { job: job.name, control: { type: "cancel" } });
    expect(job.controller.signal.aborted).toBe(false);
  } finally { release(); }
  await vi.waitFor(() => expect(job.controller.signal.aborted).toBe(true));
  expect(readStore(path())[0]?.cancellingTurn).toBe(job.startedAt);
});

it("does not apply a deferred inline cancellation to a newer durable turn", async () => {
  const { jobs, node } = manager();
  const job = jobs.start("codex", null, "old active turn", () => new Promise(() => {}));
  const key = createHash("sha256").update(job.id).digest("hex"), nextTurn = job.startedAt + 1;
  const release = acquireLock(join(home, "job-controls", `${key}.lock`), 0);
  try { node.emit("inline_job_control", { job: job.name, control: { type: "cancel" } }); }
  finally { release(); }
  const document = JSON.parse(readFileSync(path(), "utf8"));
  document.jobs[0].startedAt = nextTurn; writeFileSync(path(), JSON.stringify(document));
  await vi.waitFor(() => expect(job.startedAt).toBe(nextTurn));
  expect(job.controller.signal.aborted).toBe(false);
  expect(readStore(path())[0]?.cancellingTurn).toBeUndefined();
});

it("retains every queued occurrence accepted by another writer while a continuation is constructed", async () => {
  const { jobs } = manager();
  let complete!: (result: typeof answer) => void;
  const resume = vi.fn((): Run => {
    if (resume.mock.calls.length > 1) return async () => answer;
    const document = JSON.parse(readFileSync(path(), "utf8"));
    document.jobs[0].queuedMessages = ["concurrent bytes", "concurrent bytes"];
    writeFileSync(path(), JSON.stringify(document));
    return () => new Promise(resolve => { complete = resolve; });
  });
  const job = jobs.start("codex", null, "initial", async () => answer, resume); await flush();
  expect(jobs.followUp(job.name, "first continuation").outcome).toBe("started");
  expect(readStore(path())[0]?.queuedMessages).toEqual(["concurrent bytes", "concurrent bytes"]);
  complete(answer); await flush();
  expect(resume).toHaveBeenNthCalledWith(2, "concurrent bytes\n\nconcurrent bytes", "native-session", null, null);
});

it.each(["background", "foreground"])("does not revive a still-live %s inline executor through a second manager's restore", async mode => {
  const source = manager(), target = manager();
  const resumed = vi.fn(async () => answer);
  const job = mode === "foreground" ? source.jobs.track("codex", null, "still running").job
    : source.jobs.start("codex", null, "still running", () => new Promise(() => {}));
  source.jobs.note(job, { sessionId: "native-session" });
  target.jobs.restore(() => () => resumed);
  expect(target.jobs.followUp(job.name, "unsafe duplicate").outcome).toBe("stopping");
  expect(resumed).not.toHaveBeenCalled();
  expect(readStore(path())[0]).toMatchObject({ startedAt: job.startedAt, executionPid: process.pid, status: "running" });
});

it("persists dropping a queued continuation and stops its still-running turn on a repeated cancel", async () => {
  const { jobs } = manager();
  let stop!: (error: Error) => void;
  const resume = vi.fn(() => async () => answer);
  const job = jobs.start("codex", null, "task", () => new Promise((_, reject) => { stop = reject; }), resume);
  jobs.note(job, { sessionId: "native-session" }); jobs.cancel(job.name);
  expect(jobs.followUp(job.name, "queued bytes").outcome).toBe("waiting");
  expect(readStore(path())[0]?.queuedMessages).toEqual(["queued bytes"]);
  jobs.cancel(job.name);
  expect(readStore(path())[0]?.queuedMessages).toEqual([]);
  stop(new Error("cancelled")); await flush();
  expect(resume).not.toHaveBeenCalled();
  expect(readStore(path())[0]).toMatchObject({ status: "cancelled", sessionId: "native-session" });
});

it("does not let a stale observer revive a cancelled turn or erase its native facts", async () => {
  const source = manager("executor"), target = manager("owner");
  const job = source.jobs.start("codex", null, "original retained prompt", () => new Promise(() => {}));
  const document = JSON.parse(readFileSync(path(), "utf8"));
  Object.assign(document.jobs[0], { owner: "owner", executionOwner: "executor", masters: ["owner", "executor"], ownershipHistory: [{ from: "executor", to: "owner", at: Date.now() }] });
  document.ownerData = { bytes: "keep" }; writeFileSync(path(), JSON.stringify(document));
  source.jobs.refreshOwnership(); target.jobs.restore(() => () => async () => answer);
  const observed = target.jobs.find(job.name)!;
  expect(observed.status).toBe("running"); expect(observed.sessionId).toBeNull();
  const cancelled = JSON.parse(readFileSync(path(), "utf8"));
  Object.assign(cancelled.jobs[0], { status: "cancelled", sessionId: "native-session", workdir: home, finishedAt: Date.now(), cancellingTurn: job.startedAt });
  writeFileSync(path(), JSON.stringify(cancelled));
  target.jobs.persist();
  expect(readStore(path())[0]).toMatchObject({ status: "cancelled", sessionId: "native-session", workdir: home, prompt: "original retained prompt" });
  expect(JSON.parse(readFileSync(path(), "utf8")).ownerData).toEqual({ bytes: "keep" });
});
