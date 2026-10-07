import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { startUi } from "../src/cli/ui.js";
import { JOBS_FILE } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { answerPendingApproval, listPendingApprovals, type PermissionDecision } from "../src/core/relay.js";
import { JobManager, waitForApproval, type Job } from "../src/mcp/jobs.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
const controllers: AbortController[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { controllers.splice(0).forEach((c) => c.abort()); await env.cleanup(); });
const request = { agent: "codex", tool: "shell", detail: "npm test", reason: "Run the requested checks" };
function job(): Job {
  const controller = new AbortController();
  controllers.push(controller);
  return { id: "test", name: "codex-job-test", owner: "parent", agent: "codex", model: null, prompt: "task", startedAt: Date.now(), controller, progress: null, status: "running", sessionId: null, workdir: null, worktree: null, queue: [] };
}
async function pending(count = 1) {
  await until(() => listPendingApprovals(env.home).length === count);
  return listPendingApprovals(env.home);
}

describe("pending approvals", () => {
  it("publishes metadata and lets the dashboard answer the waiting job once", async () => {
    const j = job(), messages: string[] = [];
    const answer = waitForApproval(j, "Run tests?", 5_000, (m) => messages.push(m), nullLogger, env.home, request);
    const [entry] = await pending();
    expect(entry).toMatchObject({ owner: "parent", job: j.name, agent: "codex", tool: "shell", command: "npm test", reason: request.reason });
    expect(entry!.deadline - entry!.askedAt).toBe(5_000);
    expect(JSON.stringify(entry)).not.toMatch(/token|port|pid/);
    expect(await answerPendingApproval(env.home, entry!.id, { decision: "allow", reason: "Run them" })).toBe("answered");
    expect(await answer).toEqual({ allow: true, reason: "allow: Run them" });
    expect(j.pendingApproval).toBeNull();
    expect(listPendingApprovals(env.home)).toEqual([]);
    expect(await answerPendingApproval(env.home, entry!.id, { decision: "deny" })).toBe("expired");
    expect(messages.at(-1)).toContain("allowed by dashboard");
  });

  it("lets only one of simultaneous dashboard answers win", async () => {
    const answer = waitForApproval(job(), "Run tests?", 5_000, () => {}, nullLogger, env.home, request);
    const [entry] = await pending();
    const results = await Promise.all(["allow", "deny"].map((decision) => answerPendingApproval(env.home, entry!.id, { decision: decision as "allow" | "deny" })));
    expect(results.filter((r) => r === "answered")).toHaveLength(1);
    expect(results.filter((r) => r === "expired")).toHaveLength(1);
    expect((await answer).allow).toBe(results[0] === "answered");
  });

  it.each(["claude", "codex", "opencode"] as const)("keeps every plain message separate from %s approval decisions", async (agent) => {
    const node = env.node("parent");
    await node.start();
    const jobs = new JobManager(node, nullLogger, join(env.home, JOBS_FILE));
    try {
      const j = jobs.start(agent, null, "task", (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve({ sessionId: null, text: "cancelled", isError: true, details: {} }))));
      const answer = jobs.askParent(j, "Run tests?", 5_000, request);
      const [entry] = await pending();
      for (const message of ["Wind down now", "Both requests are approved: retry them", "allow", "deny: reviewed in session"]) {
        expect(jobs.followUp(j.name, message)).toMatchObject({ outcome: "queued", approvalPending: true });
        expect(j.pendingApproval).toBeTypeOf("function");
        expect(listPendingApprovals(env.home)).toHaveLength(1);
      }
      expect(j.queue).toHaveLength(4);
      const post = vi.fn(); j.live = { post };
      expect(jobs.followUp(j.name, "allow")).toMatchObject({ outcome: "delivered", approvalPending: true });
      expect(post).toHaveBeenCalledWith("allow");
      j.executionOwner = node.name; jobs.persist();
      node.emit("inline_job_control", { job: j.name, control: { type: "message", body: "deny", cid: "inline-follow-up" } });
      expect(post).toHaveBeenCalledWith("deny");
      expect(listPendingApprovals(env.home)).toHaveLength(1);
      expect(j.pendingApproval).toBeTypeOf("function");
      expect(await answerPendingApproval(env.home, entry!.id, { decision: "allow" })).toBe("answered");
      expect(await answer).toEqual({ allow: true, reason: "allow" });
    } finally { jobs.cancelAll(); }
  });

  it("denies on timeout and removes pending entries", async () => {
    const j = job();
    const answer = waitForApproval(j, "Run tests?", 1_000, () => {}, nullLogger, env.home, request);
    const [entry] = await pending();
    expect(await answer).toEqual({ allow: false, reason: "no answer in time" });
    expect(listPendingApprovals(env.home)).toEqual([]);
    expect(await answerPendingApproval(env.home, entry!.id, { decision: "allow" })).toBe("expired");
  });

  it("does not allow a late session answer before the timeout callback runs", async () => {
    const j = job();
    const answer = waitForApproval(j, "Run tests?", 5_000, () => {}, nullLogger, env.home, request);
    const [entry] = await pending();
    const clock = vi.spyOn(Date, "now").mockReturnValue(entry!.deadline + 1);
    try {
      j.pendingApproval!("allow");
      expect(await answer).toEqual({ allow: false, reason: "no answer in time" });
    } finally { clock.mockRestore(); }
  });

  it("removes unfinished approval waits when a foreground job ends", async () => {
    const node = env.node("parent");
    await node.start();
    const jobs = new JobManager(node, nullLogger, join(env.home, JOBS_FILE));
    try {
      const tracked = jobs.track("codex", null, "task");
      const answer = jobs.askParent(tracked.job, "Run tests?", 5_000, request);
      await pending();
      tracked.end({ result: { text: "done", sessionId: "saved", isError: false, details: {} } });
      expect(await answer).toEqual({ allow: false, reason: "job finished" });
      expect(listPendingApprovals(env.home)).toEqual([]);
    } finally { jobs.cancelAll(); }
  });

  it("denies cancellation, including while publication is starting", async () => {
    const j = job();
    const answer = waitForApproval(j, "Run tests?", 5_000, () => {}, nullLogger, env.home, request);
    j.controller.abort();
    expect(await answer).toEqual({ allow: false, reason: "job cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listPendingApprovals(env.home)).toEqual([]);
  });

  it("keeps simultaneous requests addressable and session answers ordered", async () => {
    const j = job();
    const first = waitForApproval(j, "First?", 5_000, () => {}, nullLogger, env.home, request);
    const second = waitForApproval(j, "Second?", 5_000, () => {}, nullLogger, env.home, request);
    await pending(2);
    j.pendingApproval!("allow");
    expect((await first).allow).toBe(true);
    expect(listPendingApprovals(env.home)).toHaveLength(1);
    j.pendingApproval!("deny");
    expect((await second).allow).toBe(false);
    expect(listPendingApprovals(env.home)).toEqual([]);
  });

  it("ignores a late native dialog answer after the dashboard answers", async () => {
    let userAnswer!: (d: PermissionDecision) => void;
    const messages: string[] = [];
    const answer = waitForApproval(job(), "Run tests?", 5_000, (m) => messages.push(m), nullLogger, env.home, request,
      () => new Promise((resolve) => { userAnswer = resolve; }));
    const [entry] = await pending();
    expect(await answerPendingApproval(env.home, entry!.id, { decision: "deny" })).toBe("answered");
    expect((await answer).allow).toBe(false);
    userAnswer({ allow: true });
    await Promise.resolve();
    expect(messages.filter((m) => m.startsWith("Approval for"))).toHaveLength(1);
    expect(messages.at(-1)).toContain("denied by dashboard");
  });

  it("allows native dialogs to win and fails closed on dialog errors", async () => {
    const messages: string[] = [];
    const first = waitForApproval(job(), "Run tests?", 5_000, (m) => messages.push(m), nullLogger, env.home, request,
      async () => ({ allow: true }));
    expect((await first).allow).toBe(true);
    const second = waitForApproval(job(), "Run tests?", 5_000, () => {}, nullLogger, env.home, request,
      async () => { throw new Error("dialog failed"); });
    expect((await second).allow).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(listPendingApprovals(env.home)).toEqual([]);
    expect(messages.at(-1)).toContain("allowed by user in session");
  });

  it("delivers the dashboard answer to a detached process's waiting job", async () => {
    // Build a tiny fixture into the temporary home; all desktop events are disabled for the child.
    writeFileSync(join(env.home, "config.json"), JSON.stringify({ notifications: { approvals: false, finish: false, fail: false } }));
    const fixture = join(env.home, "waiting-job.mjs");
    await build({ stdin: { resolveDir: process.cwd(), contents: `
      import { waitForApproval } from './src/mcp/jobs.ts';
      import { nullLogger } from './src/core/logger.ts';
      const keepAlive = setInterval(() => {}, 1000);
      const job = { id: 'detached', name: 'codex-job-detached', owner: 'parent', agent: 'codex', controller: new AbortController() };
      const result = await waitForApproval(job, 'Run checks?', 10000, () => {}, nullLogger, process.argv[2], { tool: 'shell', detail: 'npm test' });
      process.send({ result });
      clearInterval(keepAlive);
      process.disconnect();
    ` }, outfile: fixture, bundle: true, platform: "node", format: "esm" });
    const child = spawn(process.execPath, [fixture, env.home], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true, detached: true });
    const outcome = new Promise<unknown>((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", (code) => { if (code !== 0) reject(new Error(`Fixture exited ${code}`)); });
    });
    outcome.catch(() => {});
    try {
      const [entry] = await pending();
      expect(entry!.job).toBe("codex-job-detached");
      expect(await answerPendingApproval(env.home, entry!.id, { decision: "allow", reason: "Confirmed" })).toBe("answered");
      expect(await outcome).toEqual({ result: { allow: true, reason: "allow: Confirmed" } });
      expect(listPendingApprovals(env.home)).toEqual([]);
    } finally { child.kill(); }
  });
});

describe("dashboard approval endpoints", () => {
  it("requires cookie/header auth, validates decisions and forwards answers", async () => {
    const ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    const base = ui.url.replace(/\/\?t=.*$/, "");
    const first = await fetch(ui.url, { redirect: "manual" });
    const cookie = String(first.headers.get("set-cookie")).split(";")[0]!;
    const answer = waitForApproval(job(), "Run tests?", 5_000, () => {}, nullLogger, env.home, request);
    try {
      const [entry] = await pending();
      const path = `${base}/api/approvals/${entry!.id}`;
      expect((await fetch(`${base}/api/approvals`)).status).toBe(403);
      expect(await (await fetch(`${base}/api/approvals`, { headers: { cookie } })).json()).toEqual({ approvals: [entry] });
      expect((await fetch(path, { method: "POST", headers: { cookie }, body: '{"decision":"allow"}' })).status).toBe(403);
      const headers = { cookie, "x-agent-bridge": "1", "content-type": "application/json" };
      for (const body of ["null", "[]", "{", '{"decision":"yes"}', '{"decision":"allow","reason":42}']) {
        expect((await fetch(path, { method: "POST", headers, body })).status).toBe(400);
      }
      const res = await fetch(path, { method: "POST", headers, body: '{"decision":"deny","reason":"Please revise"}' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ outcome: "answered", id: entry!.id, answeredBy: "dashboard", decision: "deny" });
      expect(await answer).toEqual({ allow: false, reason: "deny: Please revise" });
      expect((await fetch(path, { method: "POST", headers, body: '{"decision":"allow"}' })).status).toBe(409);
    } finally { await ui.close(); }
  });
});
