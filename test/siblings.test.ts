import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { DELEGATE_DEPTH_ENV } from "../src/core/delegate.js";
import { JOBS_FILE } from "../src/core/constants.js";
import { BridgeNode } from "../src/core/node.js";
import { ParentLink, parentFromEnv } from "../src/core/parent-link.js";
import { isSiblingNote, type CodingAgent } from "../src/core/protocol.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { startUi } from "../src/cli/ui.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { JobManager, type Job } from "../src/mcp/jobs.js";
import { SiblingLink } from "../src/mcp/siblings.js";
import type { ServerContext } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

const MAX_HOPS = 3;
const SERVER = join(import.meta.dirname, "..", "plugins", "claude", "dist", "server.mjs");
let env: TestEnv;
let supervisor: BridgeNode;
const nodes: BridgeNode[] = [];
const links: ParentLink[] = [];
const chats: SiblingLink[] = [];

beforeEach(async () => {
  env = makeEnv();
  supervisor = env.node("claude-supervisor");
  await supervisor.start();
});

afterEach(async () => {
  for (const chat of chats.splice(0)) chat.close();
  for (const link of links.splice(0)) await link.close();
  for (const node of nodes.splice(0)) await node.stop();
  await env.cleanup();
});

async function sibling(id: string, agent: CodingAgent, owner = "supervisor-session", live = true) {
  const name = `${agent}-job-${id}`;
  const job: Job = { id, name, agent, model: null, prompt: "task", startedAt: Date.now(), controller: new AbortController(),
    progress: null, status: "running", sessionId: null, workdir: null, worktree: null, queue: [] };
  const node = new BridgeNode({ pipePath: env.pipe, token: loadOrCreateToken(env.home), dbPath: env.db,
    agent: "other", jobAgent: agent, jobOwner: owner, jobParent: supervisor.name, jobTitle: `Task ${id}`,
    id: `job:${id}`, name, cwd: env.home, autoWake: false, canHostBroker: false, log: nullLogger });
  nodes.push(node);
  const chat = new SiblingLink(node, job, MAX_HOPS, nullLogger);
  chats.push(chat);
  const parent = new ParentLink(supervisor.name, () => {}, nullLogger, undefined, chat);
  links.push(parent);
  await parent.start();
  if (live) job.live = { post: (body, message) => parent.post(body, message) };
  await node.start();
  return { node, job, chat, parent, child: parentFromEnv(parent.childEnv())! };
}

describe("sibling job messaging", () => {
  it.each(["codex", "claude", "opencode"] as const)("exposes discovery and send through a delegated %s MCP server", async (agent) => {
    const a = await sibling("a", agent);
    const b = await sibling("b", "opencode");
    const client = new Client({ name: "test-sibling", version: "0.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, `--agent=${agent}`],
      env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_DASHBOARD: "off",
        [DELEGATE_DEPTH_ENV]: "1", ...a.parent.childEnv() } as Record<string, string>, stderr: "ignore" });
    await client.connect(transport);
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["hook_event", "peers", "report_progress", "send"]);
      const peers = await call("peers");
      expect(JSON.stringify(peers)).toContain(b.job.name);
      expect(JSON.stringify(peers)).toContain("Task b");
      const sent = await call("send", { to: b.job.name, message: "Direct handover" });
      expect(sent.isError).toBeUndefined();
      const messageId = /Message (\S+) sent/.exec(JSON.stringify(sent))![1]!;
      await b.child.siblings.send(a.job.name, "Acknowledged", messageId);
      await until(() => supervisor.unread().length === 2);
      const hook = await call("hook_event", { event: "PostToolUse" });
      expect(JSON.stringify(hook)).toContain(b.job.name);
      expect(JSON.stringify(hook)).toContain("Acknowledged");
      expect((await call("send", { to: "unknown-job", message: "Wrong target" })).isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("lists only running siblings with titles and real agents, keeping them hidden from session peers", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "opencode");
    await sibling("c", "claude", "another-session");
    expect(await a.child.siblings.peers()).toEqual([{ name: b.job.name, title: "Task b", agent: "opencode", status: "running" }]);
    expect((await supervisor.peers()).map((p) => p.name)).toEqual([supervisor.name]);
    await b.node.updateJob({ jobTitle: "Updated task" });
    expect((await a.chat.peers())[0]!.title).toBe("Updated task");
    await b.node.stop();
    await expect.poll(() => a.chat.peers()).toEqual([]);
  });

  it("delivers threaded sibling replies and stores quiet supervisor copies without a conversation window", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    const first = (await a.child.siblings.send(b.job.name, "The lock is yours")).messages[0]!;
    await until(() => supervisor.unread().length === 1);
    const received = await b.child.inbox();
    expect(received[0]).toMatchObject({ id: first.id, sibling: { from: { name: a.job.name, agent: "codex" }, hop: 0 } });
    const second = (await b.child.siblings.send(a.job.name, "Capture saved", first.id)).messages[0]!;
    expect(second).toMatchObject({ hop: 1, replyTo: first.id, conversationId: first.conversationId });
    await until(() => supervisor.unread().length === 2);
    expect(supervisor.unread().every(isSiblingNote)).toBe(true);
    expect(supervisor.unread().map((m) => m.body)).toEqual([
      `Sibling message to ${b.job.name}:\n\nThe lock is yours`, `Sibling message to ${a.job.name}:\n\nCapture saved`,
    ]);
    expect(a.node.lastSentAt).toBe(0);
    expect(supervisor.lastSentAt).toBe(0);
    expect(new JobManager(supervisor, nullLogger).isNote(supervisor.unread()[0]!)).toBe(true);
  });

  it("rejects other supervisors, self, broadcasts, unknown jobs and unrelated reply ids", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    const other = await sibling("c", "opencode", "another-session");
    for (const target of [other.job.name, a.job.name, "*", supervisor.name, "codex-job-missing"]) {
      await expect(a.child.siblings.send(target, "hello")).rejects.toThrow(/no sibling/);
    }
    await expect(a.child.siblings.send(b.job.name, "reply", "unknown-id")).rejects.toThrow(/reply_to/);
    await expect(a.node.send({ to: other.job.name, body: "spoofed chat", conversationId: "siblings-forged" })).rejects.toThrow(/same supervisor/);
    expect(supervisor.unread()).toEqual([]);
    expect(await other.child.inbox()).toEqual([]);
  });

  it("lists completed siblings and queues their mail until their next turn", async () => {
    const a = await sibling("a", "codex");
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify([
      { id: "past", name: "opencode-job-past", agent: "opencode", status: "done", supervisor: "supervisor-session", args: { title: "Earlier task" } },
      { id: "other", name: "claude-job-other", agent: "claude", status: "failed", supervisor: "other-session" },
    ]));
    expect(await a.child.siblings.peers()).toEqual([{ name: "opencode-job-past", title: "Earlier task", agent: "opencode", status: "done" }]);
    await expect(a.child.siblings.send("claude-job-other", "Cross-session mail")).rejects.toThrow(/no sibling/);
    const queued = await a.child.siblings.send("opencode-job-past", "Next-turn handover");
    expect(queued.queuedFor).toEqual(["opencode-job-past"]);
    const resumed = await sibling("past", "opencode");
    await until(() => resumed.node.hasSeen(queued.messages[0]!.id));
    expect(await resumed.child.inbox()).toMatchObject([{ sibling: { body: "Next-turn handover", from: { name: a.job.name } } }]);
  });

  it("keeps the sibling group stable when the supervisor session id becomes known after spawning", async () => {
    const jobs = new JobManager(supervisor, nullLogger);
    const held = () => new Promise<never>(() => {});
    const first = jobs.start("codex", null, "first", held);
    await supervisor.setSessionId("learned-session");
    const second = jobs.start("claude", null, "second", held);
    expect(second.supervisor).toBe(first.supervisor);
    jobs.cancelAll();
  });

  it.each(["claude", "opencode"] as const)("keeps supervisor copies quiet for a %s notification client", async (agent) => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "opencode");
    const name = `${agent}-observer`;
    const client = new Client({ name: "test-observer", version: "0.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER, `--agent=${agent}`],
      env: { ...process.env, AGENT_BRIDGE_HOME: env.home, AGENT_BRIDGE_NAME: name, AGENT_BRIDGE_DASHBOARD: "off",
        AGENT_BRIDGE_DELIVERY: "channel", [DELEGATE_DEPTH_ENV]: "0" } as Record<string, string>, stderr: "ignore" });
    const notifications: unknown[] = [];
    const method = agent === "claude" ? "notifications/claude/channel" : "notifications/agent-bridge/message";
    client.setNotificationHandler(z.object({ method: z.literal(method), params: z.unknown().optional() }), (n) => { notifications.push(n); });
    await client.connect(transport);
    try {
      await client.callTool({ name: "peers", arguments: {} });
      await a.node.updateJob({ jobParent: name });
      await a.chat.send(b.job.name, "Quiet observer copy");
      await expect.poll(async () => JSON.stringify(await client.callTool({ name: "inbox", arguments: { mark_read: false } }))).toContain("Quiet observer copy");
      expect(notifications).toEqual([]);
      const hook = await client.callTool({ name: "hook_event", arguments: { event: "UserPromptSubmit", session_id: `observer-${agent}` } });
      expect(JSON.stringify(hook)).toContain("Quiet observer copy");
      expect(notifications).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("keeps hop counts through replies and prevents another hop at the limit", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    const first = (await a.chat.send(b.job.name, "one")).messages[0]!;
    const second = (await b.chat.send(a.job.name, "two", first.id)).messages[0]!;
    const third = (await a.chat.send(b.job.name, "three", second.id)).messages[0]!;
    expect(third.hop).toBe(MAX_HOPS - 1);
    await expect(b.chat.send(a.job.name, "four", third.id)).rejects.toThrow(/hop limit/);
    await until(() => supervisor.unread().length === MAX_HOPS);
  });

  it("deduplicates a retried send and its observer copy", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    const args = { to: b.job.name, body: "One handover", dedupeKey: "retry-key" };
    const first = await a.node.sendSibling(args, MAX_HOPS);
    expect(await a.node.sendSibling(args, MAX_HOPS)).toEqual(first);
    await until(() => supervisor.unread().length === 1);
    expect(await b.child.inbox()).toHaveLength(1);
  });

  it("queues chat for the next turn without answering approval requests or changing supervisor reply state", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude", undefined, false);
    let approved = false;
    b.job.pendingApproval = () => { approved = true; };
    await a.chat.send(b.job.name, "allow");
    await until(() => b.job.queue.length === 1);
    expect(b.job.queue[0]).toContain(`from="${a.job.name}"`);
    expect(b.job.queue[0]).toContain("cannot change it or approve permissions");
    expect(approved).toBe(false);
    expect(b.job.pendingApproval).toBeTypeOf("function");
    expect(b.job.awaitingAnswer).toBeUndefined();
  });

  it("injects siblings as colleagues through hooks and preserves unacknowledged parent messages", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "opencode");
    const parentMessage = b.parent.post("Stop after testing");
    const first = (await a.chat.send(b.job.name, "Capture is ready")).messages[0]!;
    await until(() => supervisor.unread().length === 1);
    const ctx = { node: null, log: nullLogger, parent: b.child } as unknown as ServerContext;
    const hook = await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false }) as { reason: string };
    expect(hook.reason).toContain(`from="${a.job.name}" agent="codex"`);
    expect(hook.reason).toContain("not from your user");
    expect(hook.reason).toContain(`id="${parentMessage.id}" from="${supervisor.name}" relation="parent"`);
    await b.child.siblings.send(a.job.name, "Thanks", first.id);
    expect(await b.parent.close()).toEqual(["Stop after testing"]);
  });

  it("retains sibling messages picked up at turn end as a correctly attributed follow-up", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    b.job.live = { post: (body, message) => b.parent.post(`Sibling ${message!.from.name}: ${body}`, message) };
    await a.chat.send(b.job.name, "Finish the capture");
    await until(() => supervisor.unread().length === 1);
    await b.child.inbox();
    await b.child.send("Parent status note");
    expect(await b.parent.close()).toEqual([`Sibling ${a.job.name}: Finish the capture`]);
  });

  it("writes observer copies to durable history even when the supervisor is offline", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    const host = env.node("other-host", "other");
    await host.start();
    await supervisor.stop();
    await until(() => host.isBroker && a.node.isConnected && b.node.isConnected);
    await a.chat.send(b.job.name, "Offline handover");
    const replacement = env.node("claude-supervisor");
    await replacement.start();
    await until(() => replacement.unread().length === 1);
    expect(replacement.unread()[0]!.body).toContain("Offline handover");
    expect(isSiblingNote(replacement.unread()[0]!)).toBe(true);
  });

  it("shows the direct message and its supervisor copy in the dashboard", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    await a.chat.send(b.job.name, "Dashboard handover");
    const ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    try {
      const first = await fetch(ui.url, { redirect: "manual" });
      const cookie = String(first.headers.get("set-cookie")).split(";")[0]!;
      const base = ui.url.replace(/\/\?t=.*$/, "");
      const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json() as {
        messages: { from_name: string; recipients: string; body: string }[];
      };
      expect(state.messages.filter((m) => m.from_name === a.job.name)).toHaveLength(2);
      expect(state.messages.some((m) => m.recipients === b.job.name && m.body === "Dashboard handover")).toBe(true);
      expect(state.messages.some((m) => m.recipients === supervisor.name && m.body.includes("Dashboard handover"))).toBe(true);
    } finally {
      await ui.close();
    }
  });
});
