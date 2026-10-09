import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DelegateError } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { DEFAULT_FOLLOW_UP, JobManager, type Resume, type RunResult } from "../src/mcp/jobs.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let me: BridgeNode;
let jobs: JobManager;
beforeEach(async () => {
  env = makeEnv();
  me = env.node("claude-f", "claude");
  await me.start();
  jobs = new JobManager(me, nullLogger);
});
afterEach(async () => {
  jobs.cancelAll();
  await env.cleanup();
});

const ok = (text: string, sessionId = "ses-1", workdir = "/wt"): RunResult => ({ sessionId, text, isError: false, details: {}, workdir });

/** A fake agent: remembers every message it got, per session. */
function fakeAgent() {
  const calls: { message: string; sessionId: string | null; workdir: string | null }[] = [];
  const resume: Resume = (message, sessionId, workdir) => async () => {
    calls.push({ message, sessionId, workdir });
    return ok(`reply to: ${message}`, sessionId, workdir ?? "/wt");
  };
  return { calls, resume };
}

const bodies = () => me.unread().map((m) => m.body);

describe("messaging subagents", () => {
  it("continues a finished subagent in its own session and folder", async () => {
    const agent = fakeAgent();
    const job = jobs.start("codex", null, "first task", async () => ok("first answer"), agent.resume);
    await until(() => bodies().some((b) => b.includes("first answer")));
    expect(jobs.followUp(job.name, "and now the tests").outcome).toBe("started");
    await until(() => bodies().some((b) => b.includes("reply to: and now the tests")));
    expect(agent.calls).toEqual([{ message: "and now the tests", sessionId: "ses-1", workdir: "/wt" }]);
    expect(bodies().every((b) => b.includes(job.name))).toBe(true);
  });

  it("queues follow-ups while the subagent runs and sends them when it finishes", async () => {
    const agent = fakeAgent();
    let release!: (r: RunResult) => void;
    const job = jobs.start("opencode", null, "long task", () => new Promise((r) => (release = r)), agent.resume);
    expect(jobs.followUp(job.name, "also check X").outcome).toBe("queued");
    expect(jobs.followUp(job.name, "and Y").outcome).toBe("queued");
    release(ok("long answer"));
    await until(() => agent.calls.length === 1);
    expect(agent.calls[0]!.message).toBe("also check X\n\nand Y");
    await until(() => bodies().some((b) => b.includes("reply to: also check X")));
  });

  it("recovers a failed subagent with its session and a default message", async () => {
    const agent = fakeAgent();
    const job = jobs.start("codex", null, "task", async () => {
      throw new DelegateError("delegate aborted", "aborted", "", "", "ses-crashed");
    }, agent.resume);
    await until(() => bodies().some((b) => b.includes("failed") && b.includes("To recover it")));
    expect(jobs.followUp(job.name, DEFAULT_FOLLOW_UP).outcome).toBe("started");
    await until(() => agent.calls.length === 1);
    expect(agent.calls[0]).toMatchObject({ sessionId: "ses-crashed", message: DEFAULT_FOLLOW_UP });
  });

  it("continues a job that was loaded before its continuation factory existed (startup order)", async () => {
    const agent = fakeAgent();
    // Loaded without a continuation, as a job seen through a startup event before restore installed the factory.
    const early = jobs.start("codex", null, "early task", async () => ok("early answer", "ses-early"), undefined as unknown as Resume);
    await until(() => bodies().some((b) => b.includes("early answer")));
    jobs.restore(() => agent.resume);
    expect(jobs.followUp(early.name, "continue the early one").outcome).toBe("started");
    await until(() => agent.calls.length === 1);
    expect(agent.calls[0]).toMatchObject({ sessionId: "ses-early", message: "continue the early one" });
    // A job that still lacks it after restore (outside the restored window) becomes resumable on follow-up.
    const late = jobs.start("codex", null, "late task", async () => ok("late answer", "ses-late"), undefined as unknown as Resume);
    await until(() => bodies().some((b) => b.includes("late answer")));
    expect(jobs.followUp(late.name, "continue the late one").outcome).toBe("started");
    await until(() => agent.calls.length === 2);
    expect(agent.calls[1]).toMatchObject({ sessionId: "ses-late", message: "continue the late one" });
  });

  it("explains when a subagent cannot be continued", async () => {
    expect(jobs.followUp("codex-job-nope", "hi").outcome).toBe("unknown");
    const job = jobs.start("codex", null, "task", async () => {
      throw new DelegateError("could not start", "failed");
    }, fakeAgent().resume);
    await until(() => jobs.recent().length === 1);
    expect(jobs.followUp(job.name, "hi").outcome).toBe("no-session");
  });

  it("records blocking ask runs so they can be continued too", async () => {
    const agent = fakeAgent();
    const tracked = jobs.track("claude", "opus", "review this", agent.resume);
    tracked.end({ result: ok("looks fine", "c-7", "/repo") });
    expect(jobs.recent()[0]).toMatchObject({ name: tracked.job.name, status: "done", sessionId: "c-7" });
    expect(jobs.followUp(tracked.job.name, "what about security?").outcome).toBe("started");
    await until(() => agent.calls.length === 1);
    expect(agent.calls[0]).toEqual({ message: "what about security?", sessionId: "c-7", workdir: "/repo" });
  });

  it("sends follow-ups queued during a blocking ask run once it ends", async () => {
    const agent = fakeAgent();
    const tracked = jobs.track("codex", null, "review this", agent.resume);
    expect(jobs.followUp(tracked.job.name, "check the tests too").outcome).toBe("queued");
    tracked.end({ result: ok("reviewed", "t-2", "/repo") });
    await until(() => bodies().some((b) => b.includes("reply to: check the tests too")));
    expect(agent.calls[0]).toMatchObject({ sessionId: "t-2" });
  });

  it("cancels blocking ask runs by name", () => {
    const tracked = jobs.track("codex", null, "slow", fakeAgent().resume);
    expect(jobs.cancel(tracked.job.name)).toBe(true);
    expect(tracked.job.controller.signal.aborted).toBe(true);
    expect(jobs.cancel("codex-ask-nope")).toBe(false);
  });

  it("keeps jobs across a restart of the session: finished ones continue, running ones can be recovered", async () => {
    const store = join(env.home, "jobs.json");
    const first = new JobManager(me, nullLogger, store);
    const agent = fakeAgent();
    const done = first.start("codex", "gpt-x", "task one", async () => ok("one", "ses-A", "/wt/a"), agent.resume, { access: "edit" });
    await until(() => first.recent().some((j) => j.id === done.id));
    const running = first.start("claude", null, "task two", (_s, _p, job) => {
      first.note(job, { sessionId: "ses-B", workdir: "/wt/b" });
      return new Promise(() => {});
    }, agent.resume);
    await until(() => running.sessionId === "ses-B");

    // The session restarts: a new manager reads what the old one saved.
    const args: Record<string, unknown>[] = [];
    const second = new JobManager(me, nullLogger, store);
    second.restore((_agent, a) => (args.push(a), agent.resume));
    expect(second.find(running.name)).toMatchObject({ status: "interrupted", sessionId: "ses-B", workdir: "/wt/b" });
    expect(args).toContainEqual({ access: "edit" });
    expect(second.followUp(done.name, "and now the tests").outcome).toBe("started");
    expect(second.followUp(running.name, DEFAULT_FOLLOW_UP).outcome).toBe("started");
    await until(() => agent.calls.length === 2);
    expect(agent.calls.map((c) => c.sessionId).sort()).toEqual(["ses-A", "ses-B"]);
    second.cancelAll();
    first.cancelAll();
  });

  it("queues a continuation while all slots are taken and starts it when one frees up, first come first served", async () => {
    const full = new JobManager(me, nullLogger, null, 1);
    const agent = fakeAgent();
    const done1 = full.start("codex", null, "one", async () => ok("one done", "ses-1"), agent.resume);
    await until(() => full.recent().some((j) => j.id === done1.id));
    const done2 = full.start("codex", null, "two", async () => ok("two done", "ses-2"), agent.resume);
    await until(() => full.recent().some((j) => j.id === done2.id));
    let release!: (r: RunResult) => void;
    full.start("opencode", null, "blocker", () => new Promise((r) => (release = r)), agent.resume);

    expect(full.followUp(done1.name, "more for one").outcome).toBe("waiting");
    expect(full.followUp(done2.name, "more for two").outcome).toBe("waiting");
    expect(full.followUp(done1.name, "and this").outcome).toBe("waiting");
    expect(full.waiting().map((j) => j.name)).toEqual([done1.name, done2.name]);
    expect(full.recent().map((j) => j.name)).not.toContain(done1.name);
    expect(full.runningCount()).toBe(1);
    expect(agent.calls).toEqual([]);

    release(ok("blocker done"));
    await until(() => agent.calls.length === 2);
    // One slot: the first in line runs, with everything sent to it meanwhile; the second only after it.
    expect(agent.calls[0]).toMatchObject({ sessionId: "ses-1", message: "more for one\n\nand this" });
    expect(agent.calls[1]).toMatchObject({ sessionId: "ses-2", message: "more for two" });
    await until(() => full.waiting().length === 0 && full.runningCount() === 0);
    full.cancelAll();
  });

  it("drops a queued continuation with cancel", async () => {
    const full = new JobManager(me, nullLogger, null, 1);
    const agent = fakeAgent();
    const done = full.start("codex", null, "one", async () => ok("one done"), agent.resume);
    await until(() => full.recent().some((j) => j.id === done.id));
    let release!: (r: RunResult) => void;
    full.start("codex", null, "blocker", () => new Promise((r) => (release = r)), agent.resume);
    expect(full.followUp(done.name, "more").outcome).toBe("waiting");
    expect(full.cancel(done.name)).toBe(true);
    expect(full.waiting()).toEqual([]);
    release(ok("blocker done"));
    await until(() => full.runningCount() === 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(agent.calls).toEqual([]);
  });

  it("says why a job failed, not only what it said last", async () => {
    const failed = jobs.start("opencode", null, "long task", async () => ({ ...ok("step 12: running tests"), isError: true, details: { error: "Upstream response was not valid JSON" } }), fakeAgent().resume);
    await until(() => bodies().some((b) => b.includes(failed.name)));
    const report = bodies().find((b) => b.includes(failed.name))!;
    expect(report).toMatch(/failed after \d+s\.[\s\S]*Cause: error: Upstream response was not valid JSON\n\nIts last message:\nstep 12: running tests/);

    const cancelled = jobs.start("codex", null, "slow", (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DelegateError("delegate aborted", "aborted", "", "", "s-9")))), fakeAgent().resume);
    jobs.cancel(cancelled.name);
    await until(() => bodies().some((b) => b.includes(cancelled.name)));
    expect(bodies().find((b) => b.includes(cancelled.name))).toContain("Cause: cancelled");
  });

  it("names or renames a job, also while it runs", async () => {
    const titles: string[] = [];
    let release!: (r: RunResult) => void;
    const job = jobs.start("codex", null, "task", (_s, _p, j) => {
      j.retitle = (t) => titles.push(t);
      return new Promise((r) => (release = r));
    }, fakeAgent().resume);
    await until(() => Boolean(job.retitle));
    expect(jobs.setTitle(job.name, "Build castle gates")).toBe(true);
    expect(job.args?.title).toBe("Build castle gates");
    expect(titles).toEqual(["Build castle gates"]);
    expect(jobs.setTitle("codex-job-nope", "x")).toBe(false);
    // A new thinking level is kept for the job's next turns.
    expect(jobs.setEffort(job.name, "high")).toBe(true);
    expect(job.args?.effort).toBe("high");
    release(ok("done"));
  });
});
describe("listing after a restart", () => {
  it("lists every interrupted job, not only the newest five finished", async () => {
    const store = join(env.home, "jobs.json");
    const first = new JobManager(me, nullLogger, store);
    const agent = fakeAgent();
    const lost = first.start("codex", null, "long", (_s, _p, job) => {
      first.note(job, { sessionId: "ses-lost" });
      return new Promise(() => {});
    }, agent.resume);
    await until(() => lost.sessionId === "ses-lost");
    const second = new JobManager(me, nullLogger, store);
    second.restore(() => agent.resume);
    for (let i = 0; i < 6; i++) second.start("codex", null, `quick ${i}`, async () => ok(`done ${i}`, `ses-${i}`), agent.resume);
    await until(() => second.recent(10).filter((j) => j.status === "done").length === 6);
    const listed = second.recent();
    expect(listed.map((j) => j.name)).toContain(lost.name);
    expect(listed.find((j) => j.name === lost.name)?.status).toBe("interrupted");
    second.cancelAll();
    first.cancelAll();
  });
});

describe("subagent limit", () => {
  it("raising the limit mid-session starts waiting continuations", async () => {
    const limited = new JobManager(me, nullLogger, null, 1);
    const agent = fakeAgent();
    const done = limited.start("codex", null, "first", async () => ok("first done", "ses-1"), agent.resume);
    await until(() => limited.recent().some((j) => j.id === done.id));
    limited.start("codex", null, "busy", () => new Promise(() => {}), agent.resume);
    expect(limited.followUp(done.name, "continue").outcome).toBe("waiting");
    limited.setLimit(2);
    expect(limited.limit).toBe(2);
    await until(() => agent.calls.length === 1);
    expect(agent.calls[0]).toMatchObject({ message: "continue", sessionId: "ses-1" });
    limited.cancelAll();
  });
});

describe("jobs of a session under a stand-in name", () => {
  it("adopts jobs of a -N stand-in name once no live session holds that name", async () => {
    const store = join(env.home, "jobs.json");
    const standIn = env.node("claude-f", "claude"); // second node of the same name: "claude-f-2"
    await standIn.start();
    expect(standIn.name).toBe("claude-f-2");
    const first = new JobManager(standIn, nullLogger, store);
    const agent = fakeAgent();
    const done = first.start("codex", null, "task", async () => ok("finished", "ses-x"), agent.resume);
    await until(() => first.recent().some((j) => j.id === done.id));
    const second = new JobManager(me, nullLogger, store);
    second.restore(() => agent.resume);
    // While "claude-f-2" is online it is another session of this folder: its jobs stay its own.
    second.adoptStandIns(new Set(["claude-f", "claude-f-2"]));
    expect(second.recent().map((j) => j.name)).not.toContain(done.name);
    // Gone (a reload's stand-in): its jobs are this session's.
    await standIn.stop();
    second.adoptStandIns(new Set(["claude-f"]), new Set(["claude-f-2"]));
    expect(second.recent().map((j) => j.name)).toContain(done.name);
    second.cancelAll();
    first.cancelAll();
    await standIn.stop();
  });
});
