import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { isQuietMessage } from "../src/core/protocol.js";
import { listPendingApprovals } from "../src/core/relay.js";
import { JobManager, waitForApproval, type Run } from "../src/mcp/jobs.js";
import { registerTools, type ServerContext } from "../src/mcp/server.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { shouldWakeClaudeMessage } from "../src/mcp/rewake.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
let env: TestEnv;
const closes: (() => Promise<void>)[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0)) await close(); await env.cleanup(); });

it.each(["claude", "codex", "opencode", "antigravity"] as const)("%s can broadcast to running jobs when authority RPCs fail", async agent => {
  const node = env.node("supervisor", agent), other = env.node("other", "other"); await node.start(); await other.start();
  const jobs = new JobManager(node, nullLogger);
  const received: string[] = [];
  for (let i = 0; i < 2; i++) {
    const job = jobs.start(agent, null, "Long task", signal => new Promise(resolve => signal.addEventListener("abort", () => resolve({ text: "Stopped", sessionId: null, isError: true, details: {} }))));
    job.live = { post: message => received.push(message) };
  }
  const authority = vi.spyOn(node, "jobAuthority").mockRejectedValue(new Error("unknown op: jobAuthority"));
  const projectJobs = vi.spyOn(node, "projectJobs").mockRejectedValue(new Error("unknown op: projectJobs"));
  const ctx: ServerContext = { node, jobs, home: env.home, cfg: DEFAULT_CONFIG, agent, log: nullLogger, cwd: () => env.home, channelActive: () => false };
  const server = new McpServer({ name: "test", version: "1" }); registerTools(server, ctx, []);
  const client = new Client({ name: "test", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  closes.push(async () => { jobs.cancelAll(); await client.close(); await server.close(); });
  const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
  const pendingAnswer = waitForApproval(jobs.list()[0]!, "May I run this check?", 5_000,
    body => jobs.fromSubagent(jobs.list()[0]!, body, null, true), nullLogger, env.home);
  await until(() => listPendingApprovals(env.home).length === 1);
  expect(text(await client.callTool({ name: "send", arguments: { to: "jobs:*", message: "Hold for owner" } }))).toContain("consumption unconfirmed");
  expect(received).toEqual(["Hold for owner", "Hold for owner"]); expect(other.unread()).toEqual([]);
  expect(authority).not.toHaveBeenCalled(); expect(projectJobs).not.toHaveBeenCalled();
  expect(listPendingApprovals(env.home)).toHaveLength(1);
  const decision = await client.callTool({ name: "decide", arguments: { approval_id: listPendingApprovals(env.home)[0]!.id, decision: "allow" } });
  expect(text(decision)).toContain("Approval answered"); expect((await pendingAnswer).allow).toBe(true);
  expect(node.unread().some(m => m.body.includes("allowed by MCP decide"))).toBe(true);
  await client.callTool({ name: "send", arguments: { to: "*", message: "Next checkpoint" } });
  expect(received).toEqual(["Hold for owner", "Hold for owner", "Next checkpoint", "Next checkpoint"]);
});

it.each(["claude", "codex", "opencode", "antigravity"] as const)("%s retains notes without wake or next-prompt context and keeps questions actionable", async agent => {
  const node = env.node("supervisor", agent, true); await node.start();
  const jobs = new JobManager(node, nullLogger);
  const job = jobs.start(agent, null, "Long task", signal => new Promise(resolve => signal.addEventListener("abort", () => resolve({ text: "Stopped", sessionId: null, isError: true, details: {} }))));
  job.awaitingAnswer = true;
  const ctx: ServerContext = { node, jobs, home: env.home, cfg: DEFAULT_CONFIG, agent, log: nullLogger, cwd: () => env.home, channelActive: () => false };
  try {
    jobs.fromSubagent(job, "Routine status", null, false, true);
    const note = node.unread()[0]!;
    expect(isQuietMessage(note)).toBe(true); expect(shouldWakeClaudeMessage(node, DEFAULT_CONFIG, note)).toBe(false);
    expect(await buildHookResponse(ctx, { event: "UserPromptSubmit", sessionId: null, stopHookActive: false, prompt: "Owner task" })).toEqual({});
    expect(node.unread()[0]!.body).toBe("Routine status"); expect(job.awaitingAnswer).toBe(true);
    jobs.fromSubagent(job, "Acknowledged.", null);
    expect(job.awaitingAnswer).toBe(true);
    jobs.fromSubagent(job, "Which owner should review this?", null, true);
    const question = node.unread().find(m => m.body.includes("Which owner"))!;
    expect(isQuietMessage(question)).toBe(false); expect(shouldWakeClaudeMessage(node, DEFAULT_CONFIG, question)).toBe(true);
  } finally { jobs.cancelAll(); }
});

it("uses detached runner links, retains undeliverable mail and reports each failure independently", async () => {
  const node = env.node("supervisor"); await node.start();
  const jobs = new JobManager(node, nullLogger);
  const send = vi.fn((_job, _control) => {});
  jobs.runners = { state: () => null, alive: () => true, send, kill: vi.fn() };
  const run: Run = Object.assign(async () => ({ text: "unused", sessionId: null, isError: false, details: {} }),
    { hosted: () => ({ pid: 123, peer: "runner", startedAt: Date.now() }) });
  const hosted = jobs.start("codex", null, "Hosted", run);
  const queued = jobs.start("opencode", null, "No live link", () => new Promise(() => {}));
  const failed = jobs.start("claude", null, "Broken link", () => new Promise(() => {}));
  failed.live = { post: () => { throw new Error("fixture transport unavailable"); } };
  try {
    const results = jobs.broadcastRunning("Hold at next checkpoint");
    expect(send).toHaveBeenCalledWith(hosted, expect.objectContaining({ type: "message", body: "Hold at next checkpoint", cid: expect.any(String) }));
    expect(hosted.forwarded).toHaveLength(1);
    expect(queued.queue).toEqual(["Hold at next checkpoint"]);
    expect(results).toEqual([
      { name: hosted.name, outcome: "queued on existing runner link; consumption unconfirmed" },
      { name: queued.name, outcome: "queued for follow-up; no live link" },
      { name: failed.name, outcome: "failed: fixture transport unavailable" },
    ]);
  } finally { jobs.cancelAll(); }
});
