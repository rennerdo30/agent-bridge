import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { BridgeNode } from "../src/core/node.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { JobManager, type Job, type JobHost, type Run, type RunnerControl, type RunnerState } from "../src/mcp/jobs.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let me: BridgeNode;
let jobs: JobManager;
const runners: BridgeNode[] = [];

beforeEach(async () => {
  env = makeEnv();
  me = env.node("claude-supervisor", "claude");
  await me.start();
  jobs = new JobManager(me, nullLogger, join(env.home, "jobs.json"));
});

afterEach(async () => {
  jobs.cancelAll();
  await Promise.all(runners.splice(0).map((r) => r.stop()));
  await env.cleanup();
});

function hosted() {
  let state: RunnerState | null = null;
  let alive = true;
  const controls: RunnerControl[] = [];
  const resume = vi.fn(() => (async () => ({ sessionId: "thread-1", text: "continued", isError: false, details: {} })) as Run);
  const host: JobHost = {
    state: () => state,
    alive: () => alive,
    send: (_j, c) => {
      controls.push(c);
      if (c.type === "reports-delivered" && state?.status !== "running") {
        state = { ...state!, delivered: true };
        alive = false;
      }
    },
    kill: () => { alive = false; },
  };
  jobs.runners = host;
  const run = Object.assign(async () => { throw new Error("must run in the host"); }, { hosted: (j: Job) => ({ pid: process.pid, peer: j.name, startedAt: Date.now() }) });
  const job = jobs.start("codex", null, "held task", run, resume);
  state = { pid: process.pid, peer: job.name, status: "running", updatedAt: Date.now(), sessionId: "thread-1", live: true };
  const finish = (body = "complete report", delivered = false) => {
    const report = { id: randomUUID(), body, createdAt: Date.now() };
    state = { ...state!, status: "done", report: body, reportId: report.id, reports: [report], delivered, finishedAt: Date.now() };
    return report;
  };
  return { job, resume, controls, finish, state: () => state!, setState: (s: RunnerState) => { state = s; }, stop: () => { alive = false; } };
}

async function runner(job: Job): Promise<BridgeNode> {
  const node = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), id: `job:${job.id}`, name: job.name, agent: "other", jobAgent: job.agent, cwd: env.home, autoWake: false, canHostBroker: false, log: nullLogger });
  runners.push(node);
  await node.start();
  return node;
}

describe("completion report recovery", () => {
  it("posts a report before the runner can send it and deduplicates the eventual runner send", async () => {
    const h = hosted();
    const r = await runner(h.job);
    const report = h.finish();
    jobs.list();
    await until(() => jobs.runningCount() === 0 && me.unread().length === 1);
    expect(me.unread()[0]).toMatchObject({ id: report.id, body: report.body, from: { name: h.job.name, agent: "codex" } });
    const sent = await r.send({ to: me.name, body: report.body, reportId: report.id });
    expect(sent.messages[0]!.id).toBe(report.id);
    expect(me.unread()).toHaveLength(1);
    expect(h.resume).not.toHaveBeenCalled();
  });

  it("recovers a report accepted under a former owner name even when delivered is true", async () => {
    const h = hosted();
    const r = await runner(h.job);
    const oldName = me.name;
    await me.relocate(env.home, "claude-renamed");
    expect(h.controls).toContainEqual({ type: "attach" });
    expect(h.job.owner).toBe(me.name);
    const report = h.finish("report queued under old name", true);
    expect((await r.send({ to: oldName, body: report.body, reportId: report.id })).queuedFor).toEqual([oldName]);
    jobs.list();
    await until(() => jobs.runningCount() === 0 && me.unread().some((m) => m.id === report.id));
    expect(me.get(report.id)?.recipient).toBe(me.name);
    expect(me.unread()).toHaveLength(1);
  });

  it("verifies a legacy delivered flag and recovers the original broker message under a stale owner", async () => {
    const h = hosted();
    const r = await runner(h.job);
    const former = me.name;
    await me.relocate(env.home, "claude-current-owner");
    const finishedAt = Date.now();
    const sent = await r.send({ to: former, body: "legacy completion", conversationId: `job-${h.job.id}` });
    h.setState({ ...h.state(), status: "done", report: "legacy completion", delivered: true, finishedAt });
    jobs.list();
    await until(() => jobs.runningCount() === 0 && me.unread().length === 1);
    expect(me.unread()[0]!.id).toBe(sent.messages[0]!.id);
    expect(me.unread()[0]!.recipient).toBe(me.name);
  });

  it("keeps an already consumed legacy report consumed when taking over its runner", async () => {
    const h = hosted();
    const r = await runner(h.job);
    const finishedAt = Date.now();
    const sent = await r.send({ to: me.name, body: "legacy completion", conversationId: `job-${h.job.id}` });
    await until(() => me.hasSeen(sent.messages[0]!.id));
    me.markRead([sent.messages[0]!.id]);
    h.setState({ ...h.state(), status: "done", report: "legacy completion", delivered: true, finishedAt });
    jobs.list();
    await until(() => jobs.runningCount() === 0);
    expect(me.unread()).toHaveLength(0);
  });

  it("preserves an unread recovered report across a server restart without re-delivering a read report", async () => {
    const h = hosted();
    const report = h.finish();
    jobs.list();
    await until(() => jobs.runningCount() === 0 && me.hasSeen(report.id));
    const broker = env.node("broker-retention", "codex");
    await broker.start();
    await me.stop();
    const fresh = env.node("claude-supervisor", "claude");
    await fresh.start();
    await until(() => fresh.hasSeen(report.id));
    fresh.markRead([report.id]);
    const receipt = await fresh.publishJobReport({ ...report, job: { id: `job:${h.job.id}`, name: h.job.name, agent: h.job.agent } });
    expect(receipt.readAt).not.toBeNull();
    expect(fresh.unread()).toHaveLength(0);
    await fresh.stop();
    const again = env.node("claude-supervisor", "claude");
    await again.start();
    expect((await again.publishJobReport({ ...report, job: { id: `job:${h.job.id}`, name: h.job.name, agent: h.job.agent } })).readAt).not.toBeNull();
    expect(again.unread()).toHaveLength(0);
  });

  it("delivers every queued turn's report before settling a runner", async () => {
    const h = hosted();
    const first = { id: randomUUID(), body: "first answer with queued follow-up", createdAt: Date.now() };
    const last = h.finish("second answer");
    h.setState({ ...h.state(), reports: [first, last] });
    jobs.list();
    await until(() => jobs.runningCount() === 0 && me.unread().length === 2);
    expect(me.unread().map((m) => m.body)).toEqual([first.body, last.body]);
  });

  it("takes over a completed runner and durably posts its undelivered report", async () => {
    const h = hosted();
    h.finish("completed while the supervisor was gone");
    h.stop();
    jobs.cancelAll();
    const fresh = new JobManager(me, nullLogger, join(env.home, "jobs.json"));
    fresh.runners = jobs.runners;
    fresh.restore(() => h.resume);
    await until(() => fresh.runningCount() === 0 && me.unread().length === 1);
    expect(fresh.find(h.job.name)?.status).toBe("done");
    expect(me.unread()[0]!.body).toBe("completed while the supervisor was gone");
    fresh.cancelAll();
  });

  it("retries a failed broker publication without falsely settling the job", async () => {
    const h = hosted();
    h.finish();
    const publish = vi.spyOn(me, "publishJobReport").mockRejectedValueOnce(new Error("broker changing hands"));
    jobs.list();
    await until(() => publish.mock.calls.length === 1);
    await new Promise((r) => setImmediate(r));
    expect(jobs.runningCount()).toBe(1);
    jobs.list();
    await until(() => jobs.runningCount() === 0);
    expect(me.unread()).toHaveLength(1);
  });

  it("reports a dead runner after recovering an earlier turn's pending report", async () => {
    const h = hosted();
    const earlier = { id: randomUUID(), body: "earlier completed turn", createdAt: Date.now() };
    h.setState({ ...h.state(), reports: [earlier] });
    h.stop();
    jobs.list();
    await until(() => jobs.runningCount() === 0);
    expect(me.unread().map((m) => m.body)).toContain(earlier.body);
    expect(me.unread().some((m) => m.body.includes("ended without reporting a result"))).toBe(true);
    expect(h.job.status).toBe("failed");
  });

  it("rechecks the report recipient when the session is renamed during publication", async () => {
    const h = hosted();
    const report = h.finish();
    const publish = me.publishJobReport.bind(me);
    vi.spyOn(me, "publishJobReport").mockImplementationOnce(async (r) => {
      const receipt = await publish(r);
      await me.relocate(env.home, "claude-new-owner");
      return receipt;
    });
    jobs.list();
    await until(() => me.name === "claude-new-owner");
    await new Promise((r) => setImmediate(r));
    expect(jobs.runningCount()).toBe(1);
    jobs.list();
    await until(() => jobs.runningCount() === 0);
    expect((await publish({ ...report, job: { id: `job:${h.job.id}`, name: h.job.name, agent: h.job.agent } })).recipient).toBe(me.name);
    expect(me.unread()).toHaveLength(1);
  });

  it("waits for a closing runner before a continuation can replace its state file", async () => {
    const h = hosted();
    const send = jobs.runners!.send;
    jobs.runners!.send = (_job, c) => { if (c.type !== "reports-delivered") send(_job, c); };
    const report = h.finish();
    expect(jobs.followUp(h.job.name, "next turn").outcome).toBe("continuing");
    await until(() => me.hasSeen(report.id));
    await new Promise((r) => setImmediate(r));
    expect(jobs.runningCount()).toBe(1);
    expect(h.resume).not.toHaveBeenCalled();
    h.stop();
    jobs.list();
    await until(() => h.resume.mock.calls.length === 1);
  });
});

describe("messages arriving at a finished runner", () => {
  it("reports an unseen forwarded message instead of restarting the completed job", async () => {
    const h = hosted();
    expect(jobs.followUp(h.job.name, "coordination note").outcome).toBe("delivered");
    h.finish("original final answer");
    jobs.list();
    await until(() => jobs.runningCount() === 0);
    expect(h.resume).not.toHaveBeenCalled();
    expect(me.unread().map((m) => m.body)).toContain("original final answer");
    expect(me.unread().some((m) => m.body.includes("Nothing was restarted") && m.body.includes("coordination note"))).toBe(true);
  });

  it("does not continue a job whose finished state is discovered by a running-only message", async () => {
    const h = hosted();
    h.finish();
    expect(jobs.followUp(h.job.name, "coordination note", true).outcome).toBe("finished");
    await until(() => jobs.runningCount() === 0);
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.controls.filter((c) => c.type === "message")).toEqual([]);
  });

  it("explicitly reports continuation while a finished job's report is being published", async () => {
    const h = hosted();
    h.finish();
    expect(jobs.followUp(h.job.name, "intentional next task").outcome).toBe("continuing");
    await until(() => h.resume.mock.calls.length === 1);
    expect(h.resume).toHaveBeenCalledWith("intentional next task", "thread-1", null, null);
  });

  it("forwards a running-only live message but never queues a turn when live delivery is unavailable", () => {
    const h = hosted();
    expect(jobs.followUp(h.job.name, "live note", true).outcome).toBe("delivered");
    expect(h.controls).toContainEqual({ type: "message", body: "live note", cid: expect.any(String), ifRunning: true });
    h.setState({ ...h.state(), live: false });
    expect(jobs.followUp(h.job.name, "do not start a turn", true).outcome).toBe("not-live");
    expect(h.job.queue).toEqual([]);
  });
});
