import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { APP_VERSION } from "../src/core/constants.js";
import { checkDepth, childEnv, PARENT_JOB_ENV, ROOT_SESSION_ENV, ROOT_NAME_ENV, pidAlive } from "../src/core/delegate.js";
import { FinalAnswers } from "../src/core/final-answers.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { ParentLink, parentFromEnv } from "../src/core/parent-link.js";
import { answerPendingApproval, listPendingApprovals } from "../src/core/relay.js";
import { RootConcurrency } from "../src/core/root-concurrency.js";
import { summarizeRun } from "../src/cli/ui.js";
import { runDelegate } from "../src/mcp/delegate-run.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { JobManager, readStore } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { registerTools, type ServerContext } from "../src/mcp/server.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { until } from "./helpers.js";

const ROOT = "root-session";
const ROOT_NAME = "claude-owner";
const PARENT_JOB = "codex-job-parent";
const textOf = (r: any): string => r.content.map((c: any) => c.text ?? "").join("\n");
let home: string;
const managers: JobManager[] = [];
const clients: Client[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ab-nested-")); });
afterEach(async () => {
  for (const manager of managers.splice(0)) manager.cancelAll();
  for (const client of clients.splice(0)) await client.close();
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  await until(() => {
    try { rmSync(home, { recursive: true, force: true }); return true; }
    catch (err) { if (["EPERM", "EBUSY", "ENOTEMPTY"].includes((err as NodeJS.ErrnoException).code ?? "")) return false; throw err; }
  });
});

function nestedContext(escalate = vi.fn(async (_body: string) => {})): ServerContext {
  const coordinator = new LocalCoordinator(PARENT_JOB, ROOT);
  const jobs = new JobManager(coordinator, nullLogger, join(home, "jobs.json"), 2, { parentJob: PARENT_JOB, rootSession: ROOT, rootName: ROOT_NAME, escalate });
  managers.push(jobs);
  const budget = new RootConcurrency(home, ROOT); budget.setLimit(2); budget.close();
  return { agent: "codex", cfg: { ...DEFAULT_CONFIG, maxJobs: 2 }, node: null, log: nullLogger, home, cwd: () => home, channelActive: () => false,
    jobs, childInbox: coordinator, parent: { name: ROOT_NAME, inbox: async () => [], send: vi.fn(), progress: vi.fn(), siblings: { peers: async () => [], send: vi.fn() } } };
}

async function connect(ctx: ServerContext): Promise<Client> {
  const server = new McpServer({ name: "nested-test", version: "0" });
  registerTools(server, ctx, ["claude", "opencode"]);
  const client = new Client({ name: "test", version: "0" });
  clients.push(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("nested delegation", () => {
  it("does not carry a parent's plugin selector into another delegated host", () => {
    vi.stubEnv("AGENT_BRIDGE_PLUGIN_RUNTIME_HOME", join(home, "native-runtime"));
    vi.stubEnv("AGENT_BRIDGE_LAUNCH_PLUGIN_ROOT", join(home, "native-plugin"));
    vi.stubEnv("AGENT_BRIDGE_HOME", home);
    vi.stubEnv("AGENT_BRIDGE_PARENT_URL", "http://127.0.0.1:1234");
    const env = childEnv();
    expect(env.AGENT_BRIDGE_PLUGIN_RUNTIME_HOME).toBeUndefined();
    expect(env.AGENT_BRIDGE_LAUNCH_PLUGIN_ROOT).toBeUndefined();
    expect(env.AGENT_BRIDGE_HOME).toBe(home);
    expect(env.AGENT_BRIDGE_PARENT_URL).toBe("http://127.0.0.1:1234");
    expect(env.AGENT_BRIDGE_INTERNAL).toBe("1");
    expect(childEnv({ AGENT_BRIDGE_PLUGIN_RUNTIME_HOME: "target-runtime" }).AGENT_BRIDGE_PLUGIN_RUNTIME_HOME).toBe("target-runtime");
  });
  it("allows depth 2, refuses depth 3 by default and enforces the hard ceiling", () => {
    expect(() => checkDepth(2, { AGENT_BRIDGE_DELEGATE_DEPTH: "1" })).not.toThrow();
    expect(() => checkDepth(2, { AGENT_BRIDGE_DELEGATE_DEPTH: "2" })).toThrow("depth limit 2");
    expect(() => checkDepth(3, { AGENT_BRIDGE_DELEGATE_DEPTH: "2" })).not.toThrow();
    expect(() => checkDepth(99, { AGENT_BRIDGE_DELEGATE_DEPTH: "3" })).toThrow("depth limit 3");
    vi.stubEnv("AGENT_BRIDGE_DELEGATE_DEPTH", "1");
    expect(childEnv().AGENT_BRIDGE_DELEGATE_DEPTH).toBe("2");
  });

  it("loads bounded depth from config and environment without changing source data", () => {
    const path = join(home, "config.json");
    const original = JSON.stringify({ maxDelegateDepth: 1, unrelated: "keep" }); writeFileSync(path, original);
    expect(loadConfig(home, "codex", nullLogger, {}).maxDelegateDepth).toBe(1);
    expect(loadConfig(home, "codex", nullLogger, { AGENT_BRIDGE_MAX_DELEGATE_DEPTH: "3" }).maxDelegateDepth).toBe(3);
    expect(loadConfig(home, "codex", nullLogger, { AGENT_BRIDGE_MAX_DELEGATE_DEPTH: "4" }).maxDelegateDepth).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(DEFAULT_CONFIG.maxDelegateDepth).toBe(2);
  });

  it("shares the root cap across generations and keeps unrelated roots independent", () => {
    const root = new RootConcurrency(home, ROOT); const nested = new RootConcurrency(home, ROOT); const other = new RootConcurrency(home, "other-root");
    const parent = { id: "parent", pid: process.pid }; const sibling = { id: "sibling", pid: process.pid }; const child = { id: "child", pid: process.pid };
    try {
      root.setLimit(2); other.setLimit(1);
      expect(root.acquire(parent)).toBe(true); expect(root.acquire(sibling)).toBe(true);
      expect(nested.acquire(child)).toBe(false); expect(nested.available()).toBe(false);
      expect(other.acquire(child)).toBe(true);
      root.release(sibling); expect(nested.acquire(child)).toBe(true);
      root.setLimit(1); nested.ensureLimit(9); expect(nested.available()).toBe(false);
      root.release(parent); nested.release(child); expect(root.acquire(parent)).toBe(true); expect(nested.acquire(child)).toBe(false);
    } finally { root.release(parent); root.release(sibling); nested.release(child); other.release(child); root.close(); nested.close(); other.close(); }
  });

  it("exposes private child tools at depth 1 and hides spawn tools at depth 2", async () => {
    vi.stubEnv("AGENT_BRIDGE_DELEGATE_DEPTH", "1");
    const client = await connect(nestedContext());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["spawn_claude", "ask_claude", "message_subagent", "cancel_subagent", "inbox", "wait_for_message"]) expect(names).toContain(name);
    for (const name of ["auto_wake", "max_subagents", "send_files"]) expect(names).not.toContain(name);
    vi.stubEnv("AGENT_BRIDGE_DELEGATE_DEPTH", "2");
    const leaf = await connect(nestedContext());
    expect((await leaf.listTools()).tools.map((tool) => tool.name)).not.toContain("spawn_claude");
  });

  it("runs a nested ask and persists ancestry in jobs, run metadata and dashboard state", async () => {
    vi.stubEnv("AGENT_BRIDGE_DELEGATE_DEPTH", "1");
    const ctx = nestedContext();
    vi.spyOn(DELEGATION_TARGETS.claude, "run").mockImplementation(async (_cfg, req) => {
      expect(req.extraEnv?.[PARENT_JOB_ENV]).toMatch(/^claude-ask-/);
      expect(req.extraEnv?.[ROOT_SESSION_ENV]).toBe(ROOT);
      expect(req.maxDelegateDepth).toBe(2);
      return { sessionId: "child-session", text: "nested report", isError: false, details: {} };
    });
    const client = await connect(ctx);
    expect(textOf(await client.callTool({ name: "ask_claude", arguments: { prompt: "Review", title: "Nested review" } }))).toContain("nested report");
    const stored = readStore(join(home, "jobs.json"));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ parentJob: PARENT_JOB, rootSession: ROOT, rootName: ROOT_NAME, metadataVersion: 2, status: "done" });
    const metaFile = readdirSync(join(home, "runs")).find((file) => file.endsWith(".json"))!;
    const meta = JSON.parse(readFileSync(join(home, "runs", metaFile), "utf8"));
    expect(meta).toMatchObject({ parentJob: PARENT_JOB, rootSession: ROOT, metadataVersion: 2, bridgeVersion: APP_VERSION });
    expect(summarizeRun(metaFile.replace(/\.json$/, ".log"), "", Date.now(), Date.now(), meta)).toMatchObject({ parentJob: PARENT_JOB, rootSession: ROOT });
  });

  it("delivers background completion and live child messages to the direct parent's hook", async () => {
    const ctx = nestedContext();
    const job = ctx.jobs!.start("claude", null, "review", async () => ({ sessionId: "child", text: "child deliverable", isError: false, details: {} }));
    await until(() => ctx.childInbox!.unread().length > 0);
    const hook = await buildHookResponse(ctx, { event: "PostToolUse", sessionId: "parent-native-session", stopHookActive: false });
    expect(JSON.stringify(hook)).toContain("child deliverable"); expect(JSON.stringify(hook)).toContain(job.name);
    expect(ctx.parent!.send).not.toHaveBeenCalled(); expect(ctx.childInbox!.unread()).toEqual([]);
    ctx.jobs!.fromSubagent(job, "live answer", null, true);
    expect(JSON.stringify(await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false }))).toContain("live answer");
  });

  it("routes approval to the direct parent and preserves the wait when escalated to the owner", async () => {
    const escalation = vi.fn(async (_body: string) => {}); const ctx = nestedContext(escalation);
    const tracked = ctx.jobs!.track("claude", null, "review"); tracked.job.foreground = false;
    const waiting = ctx.jobs!.askParent(tracked.job, "Run release?", 30_000, { agent: "claude", tool: "shell", detail: "release" });
    await until(() => listPendingApprovals(home).length === 1);
    expect(ctx.childInbox!.unread()[0]!.body).toContain("asks for approval");
    expect(escalation).not.toHaveBeenCalled();
    const client = await connect(ctx);
    expect(textOf(await client.callTool({ name: "decide", arguments: { approval_id: listPendingApprovals(home)[0]!.id, decision: "escalate" } }))).toContain("escalated");
    expect(escalation).toHaveBeenCalledOnce();
    const [entry] = listPendingApprovals(home);
    expect(entry).toMatchObject({ owner: ROOT_NAME, parentJob: PARENT_JOB, rootSession: ROOT });
    expect(await answerPendingApproval(home, entry!.id, { decision: "allow" })).toBe("answered");
    expect(await waiting).toEqual({ allow: true, reason: "allow" });
    expect(await answerPendingApproval(home, entry!.id, { decision: "deny" })).toBe("expired");
    tracked.end();
  });

  it("automatically escalates blocking nested asks and allows direct-parent denial", async () => {
    const escalation = vi.fn(async (_body: string) => {}); const ctx = nestedContext(escalation);
    const tracked = ctx.jobs!.track("claude", null, "review");
    const waiting = ctx.jobs!.askParent(tracked.job, "Need owner", 30_000);
    await until(() => escalation.mock.calls.length === 1);
    await answerPendingApproval(home, listPendingApprovals(home)[0]!.id, { decision: "deny", reason: "out of scope" });
    expect(await waiting).toEqual({ allow: false, reason: "deny: out of scope" });
    expect(listPendingApprovals(home)).toEqual([]); tracked.end();
  });

  it("keeps an escalated approval answerable by the direct parent", async () => {
    const escalation = vi.fn(async (_body: string) => {}); const ctx = nestedContext(escalation);
    const tracked = ctx.jobs!.track("claude", null, "review"); tracked.job.foreground = false;
    const waiting = ctx.jobs!.askParent(tracked.job, "Need owner", 30_000);
    await until(() => listPendingApprovals(home).length === 1);
    tracked.job.pendingApproval!("escalate");
    expect(tracked.job.pendingApproval).toBeTypeOf("function");
    await answerPendingApproval(home, listPendingApprovals(home)[0]!.id, { decision: "deny", reason: "owner no longer needed" });
    expect(await waiting).toEqual({ allow: false, reason: "deny: owner no longer needed" }); tracked.end();
  });

  it("answers a descendant approval from the top supervisor's explicit decide tool", async () => {
    const ctx = nestedContext(); const tracked = ctx.jobs!.track("claude", null, "review"); tracked.job.foreground = false;
    const waiting = ctx.jobs!.askParent(tracked.job, "Need owner", 30_000);
    await until(() => listPendingApprovals(home).length === 1);
    tracked.job.pendingApproval!("escalate");
    const top = new LocalCoordinator(ROOT_NAME, ROOT);
    // This control-only stand-in does not deliver independent-session notifications.
    Object.assign(top, { setNotificationWaitHandlers: vi.fn(), jobAuthority: vi.fn(async () => tracked.job) });
    const topJobs = new JobManager(top, nullLogger, join(home, "jobs.json"), 2); managers.push(topJobs);
    const client = await connect({ ...ctx, agent: "claude", node: top as unknown as BridgeNode, jobs: topJobs, childInbox: undefined, parent: null });
    expect(topJobs.find(tracked.job.name)).toBeUndefined();
    expect(textOf(await client.callTool({ name: "decide", arguments: { approval_id: listPendingApprovals(home)[0]!.id, decision: "allow", reason: "owner approved" } }))).toBe("Approval answered.");
    expect(await waiting).toEqual({ allow: true, reason: "allow: owner approved" }); tracked.end();
  });

  it("requires current broker authority even when pending metadata names the caller", async () => {
    const ctx = nestedContext();
    const tracked = ctx.jobs!.track("opencode", null, "review"); tracked.job.foreground = false;
    const waiting = ctx.jobs!.askParent(tracked.job, "Need owner", 30_000);
    await until(() => listPendingApprovals(home).length === 1);
    const top = new LocalCoordinator(ROOT_NAME, ROOT);
    Object.assign(top, { setNotificationWaitHandlers: vi.fn(), jobAuthority: vi.fn(async () => null) });
    const topJobs = new JobManager(top, nullLogger, join(home, "jobs.json"), 2); managers.push(topJobs);
    const client = await connect({ ...ctx, agent: "claude", node: top as unknown as BridgeNode, jobs: topJobs, childInbox: undefined, parent: null });
    const approval = listPendingApprovals(home)[0]!;
    const denied = await client.callTool({ name: "decide", arguments: { approval_id: approval.id, decision: "allow" } });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("another supervisor");
    expect(tracked.job.pendingApproval).toBeTypeOf("function");
    await answerPendingApproval(home, approval.id, { decision: "deny" });
    expect((await waiting).allow).toBe(false); tracked.end();
  });

  it("starts a queued continuation when a different generation releases root capacity", async () => {
    const ctx = nestedContext();
    const tracked = ctx.jobs!.track("claude", null, "review", () => async () => ({ sessionId: "child", text: "continued", isError: false, details: {} }));
    tracked.end({ result: { sessionId: "child", text: "first", isError: false, details: {} } });
    const budget = new RootConcurrency(home, ROOT); const holder = { id: "root-holder", pid: process.pid };
    budget.setLimit(1); budget.acquire(holder);
    try {
      expect(ctx.jobs!.followUp(tracked.job.name, "continue").outcome).toBe("waiting");
      budget.release(holder);
      await until(() => ctx.childInbox!.unread().some((m) => m.body.includes("continued")));
      expect(ctx.jobs!.waiting()).toEqual([]);
    } finally { budget.release(holder); budget.close(); }
  });

  it("spawns, approves, resumes and cancels children through the delegated MCP tools", async () => {
    vi.stubEnv("AGENT_BRIDGE_DELEGATE_DEPTH", "1");
    const ctx = nestedContext(); const client = await connect(ctx);
    let cancelMode = false;
    let enteredCancellation = false;
    vi.spyOn(DELEGATION_TARGETS.claude, "run").mockImplementation(async (_cfg, req) => {
      if (cancelMode) { enteredCancellation = true; return new Promise((_resolve, reject) => req.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); }
      const decision = await req.approve!({ agent: "claude", tool: "shell", detail: "run checks" });
      return { sessionId: "child-session", text: decision.allow ? "approved child result" : "denied child result", isError: false, details: {} };
    });
    const spawned = textOf(await client.callTool({ name: "spawn_claude", arguments: { prompt: "Review", title: "Nested review" } }));
    const name = /claude-job-[a-f0-9]+/.exec(spawned)![0];
    await until(() => listPendingApprovals(home).length === 1);
    await client.callTool({ name: "decide", arguments: { approval_id: listPendingApprovals(home)[0]!.id, decision: "allow" } });
    await until(() => ctx.jobs!.find(name)!.status === "done");
    expect(textOf(await client.callTool({ name: "inbox", arguments: {} }))).toContain("approved child result");
    await client.callTool({ name: "message_subagent", arguments: { job: name, message: "Review again" } });
    await until(() => listPendingApprovals(home).length === 1);
    await client.callTool({ name: "decide", arguments: { approval_id: listPendingApprovals(home)[0]!.id, decision: "deny" } });
    await until(() => ctx.jobs!.find(name)!.status === "done");
    expect(textOf(await client.callTool({ name: "wait_for_message", arguments: { from: name, timeout_sec: 1 } }))).toContain("denied child result");
    cancelMode = true;
    await client.callTool({ name: "message_subagent", arguments: { job: name, message: "Wait" } });
    await until(() => enteredCancellation);
    expect(textOf(await client.callTool({ name: "cancel_subagent", arguments: { job: name } }))).toContain(name);
    await until(() => ctx.jobs!.find(name)!.status === "failed");
    expect(listPendingApprovals(home)).toEqual([]);
  });

  it("restores only its own children and preserves unrelated and unknown stored fields", () => {
    const path = join(home, "jobs.json");
    const common = { agent: "claude", model: null, prompt: "full original task", startedAt: Date.now(), status: "done", sessionId: "child", workdir: home, worktree: null };
    const original = [ { ...common, id: "own", name: "claude-job-own", owner: PARENT_JOB, parentJob: PARENT_JOB, rootSession: ROOT, futureField: "keep" },
      { ...common, id: "other", name: "claude-job-other", owner: "other-owner", parentJob: "other-parent", futureField: "also keep" } ];
    writeFileSync(path, JSON.stringify(original));
    const ctx = nestedContext(); ctx.jobs!.restore(() => undefined);
    expect(ctx.jobs!.find("claude-job-own")).toBeDefined(); expect(ctx.jobs!.find("claude-job-other")).toBeUndefined();
    const stored = readStore(path);
    expect(stored).toHaveLength(2);
    expect(stored.find((j) => j.id === "other")).toMatchObject(original[1]!);
    expect(stored.find((j) => j.id === "own")).toMatchObject({ futureField: "keep", prompt: "full original task" });
  });

  it("starts a bundled delegated server with a working child JobManager", async () => {
    const serverPath = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
    writeFileSync(join(home, "app-server"), `
const { createInterface } = require("node:readline");
const { writeFileSync } = require("node:fs");
const write = (m) => console.log(JSON.stringify(m));
writeFileSync("child-env.json", JSON.stringify({depth: process.env.AGENT_BRIDGE_DELEGATE_DEPTH, parentJob: process.env.AGENT_BRIDGE_PARENT_JOB, rootSession: process.env.AGENT_BRIDGE_ROOT_SESSION}));
createInterface({input: process.stdin}).on("line", (line) => {
  const m = JSON.parse(line); if (!m.id) return;
  let result = {};
  if (m.method === "thread/start") result = {thread: {id: "nested-thread"}};
  if (m.method === "turn/start") result = {turn: {id: "nested-turn"}};
  write({id: m.id, result});
  if (m.method === "turn/start") setTimeout(() => {
    write({method: "item/completed", params: {turnId: "nested-turn", item: {id: "report", type: "agentMessage", phase: "final_answer", text: "bundled nested result"}}});
    write({method: "turn/completed", params: {turn: {id: "nested-turn", status: "completed"}}});
  }, 10);
});`);
    const link = new ParentLink(ROOT_NAME, vi.fn(), nullLogger); await link.start();
    const budget = new RootConcurrency(home, ROOT); budget.setLimit(2); budget.close();
    const client = new Client({ name: "nested-bundle", version: "0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, "--agent=claude"], cwd: home, stderr: "ignore",
      env: { ...process.env, ...link.childEnv(), AGENT_BRIDGE_HOME: home, AGENT_BRIDGE_DASHBOARD: "off", AGENT_BRIDGE_JOB_RUNNER: "0", AGENT_BRIDGE_CODEX_BIN: process.execPath,
        AGENT_BRIDGE_DELEGATE_DEPTH: "1", [PARENT_JOB_ENV]: PARENT_JOB, [ROOT_SESSION_ENV]: ROOT, [ROOT_NAME_ENV]: ROOT_NAME } as Record<string, string> });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("spawn_codex");
      const answer = await client.callTool({ name: "ask_codex", arguments: { title: "Nested bundle review", prompt: "Review" } });
      expect(textOf(answer)).toContain("bundled nested result");
      expect(JSON.parse(readFileSync(join(home, "child-env.json"), "utf8"))).toMatchObject({ depth: "2", rootSession: ROOT, parentJob: expect.stringMatching(/^codex-ask-/) });
      expect(readStore(join(home, "jobs.json"))[0]).toMatchObject({ parentJob: PARENT_JOB, rootSession: ROOT, status: "done" });
    } finally { const pid = transport.pid; await client.close(); if (pid) await until(() => !pidAlive(pid)); await link.close(); }
  });

  it("forwards escalation through parent links without turning it into an approval answer", async () => {
    const upstream = vi.fn(async (_body: string) => {});
    const messages = vi.fn(); const link = new ParentLink(PARENT_JOB, messages, nullLogger, undefined, undefined, upstream);
    await link.start();
    try { await parentFromEnv(link.childEnv())!.escalate!("owner decision required"); expect(upstream).toHaveBeenCalledWith("owner decision required"); expect(messages).not.toHaveBeenCalled(); }
    finally { await link.close(); }
  });

  it("refuses nested execution at a full root budget before calling a target", async () => {
    const ctx = nestedContext(); const budget = new RootConcurrency(home, ROOT);
    const parent = { id: "parent", pid: process.pid }; const sibling = { id: "sibling", pid: process.pid };
    budget.acquire(parent); budget.acquire(sibling);
    const tracked = ctx.jobs!.track("claude", null, "review");
    const run = vi.spyOn(DELEGATION_TARGETS.claude, "run");
    try {
      expect(ctx.jobs!.canStart()).toBe(false);
      await expect(runDelegate({ ...ctx, me: () => PARENT_JOB }, "claude", { title: "Review", prompt: "task" }, tracked.job.controller.signal, undefined, false, tracked.job)).rejects.toThrow("concurrency limit");
      expect(run).not.toHaveBeenCalled();
    } finally { tracked.end(); budget.release(parent); budget.release(sibling); budget.close(); }
  });
});

it("AB-88 retains the substantive report before its trailing sibling acknowledgement", () => {
  // Saved stream: 2026-10-06 10:17:45 and 10:17:59 UTC, both in the same turn.
  const answers = new FinalAnswers();
  answers.add({ id: "msg_05223993b28982a4016ac4cac0698887d0b4a8e808822d7fc5", phase: "final_answer", text: "Implemented and committed on feature/platform-social. Commit: 59e2595aa. Platform tests 19/19, server-startup tests 7/7, MMO tests 7/10. Unverified: cold smoke and live overlay." });
  answers.add({ id: "msg_05223993b28982a4016ac4cad74c5487d0afcfe620aeb47b70", phase: "final_answer", text: "Confirmed to the sibling: AS-2005 is committed and reported, with no further CPU-heavy checks pending." });
  expect(answers.text()).toContain("Platform tests 19/19");
  expect(answers.text()).toContain("Confirmed to the sibling");
  expect(answers.text().indexOf("Implemented")).toBeLessThan(answers.text().indexOf("Confirmed"));
});
