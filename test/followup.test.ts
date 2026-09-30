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
    release(ok("done"));
  });
});