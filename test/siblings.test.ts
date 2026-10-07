import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { DELEGATE_DEPTH_ENV } from "../src/core/delegate.js";
import { JOBS_FILE } from "../src/core/constants.js";
import { DEFAULT_SIBLING_MAX_HOPS, isJobSendTarget } from "../src/core/job-messaging.js";
import { formatSiblingMessages } from "../src/mcp/format.js";
import { readStore } from "../src/mcp/jobs.js";
import { BridgeNode } from "../src/core/node.js";
import { ParentLink, parentFromEnv } from "../src/core/parent-link.js";
import { isSiblingNote, type BridgeMessage, type CodingAgent } from "../src/core/protocol.js";
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

async function sibling(id: string, agent: CodingAgent, owner = "supervisor-session", live = true, sendTo: string[] = []) {
  const name = `${agent}-job-${id}`;
  const job: Job = { id, name, agent, model: null, prompt: "task", startedAt: Date.now(), controller: new AbortController(),
    progress: null, status: "running", sessionId: null, workdir: null, worktree: null, queue: [], args: { send_to: sendTo } };
  const node = new BridgeNode({ pipePath: env.pipe, token: loadOrCreateToken(env.home), dbPath: env.db,
    agent: "other", jobAgent: agent, jobOwner: owner, jobParent: supervisor.name, jobTitle: `Task ${id}`,
    jobSendTo: sendTo,
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
  it("marks a sibling message read only when the child consumes its context", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    const sent = (await a.chat.send(b.job.name, "Review the capture")).messages[0]!;
    await until(() => b.node.hasSeen(sent.id));
    expect(await a.node.messageReceipt(sent.id)).toEqual([{ recipient: b.job.name, readAt: null }]);
    await b.child.inbox();
    await expect.poll(() => a.node.messageReceipt(sent.id)).toEqual([{ recipient: b.job.name, readAt: expect.any(Number) }]);
  });

  it("preserves unconsumed turn-end sibling mail without starting a new turn", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    const sent = (await a.chat.send(b.job.name, "One more detail")).messages[0]!;
    await until(() => b.node.hasSeen(sent.id));
    expect(await b.parent.close()).toEqual([]);
    expect(b.node.unread().find((m) => m.id === sent.id)?.body).toBe("One more detail");
    expect(await a.node.messageReceipt(sent.id)).toEqual([{ recipient: b.job.name, readAt: null }]);
  });
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
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["get_conversation", "hook_event", "peers", "report_progress", "search_history", "send"]);
      const peers = await call("peers");
      expect(JSON.stringify(peers)).toContain(b.job.name);
      expect(JSON.stringify(peers)).toContain("Task b");
      expect(JSON.stringify(peers)).toContain("32 messages");
      expect(JSON.stringify(peers)).toContain("Explicit send_to grants: none");
      const sent = await call("send", { to: b.job.name, message: "Direct handover" });
      expect(sent.isError).toBeUndefined();
      const messageId = /Message (\S+) sent/.exec(JSON.stringify(sent))![1]!;
      await b.child.siblings.send(a.job.name, "Acknowledged", messageId);
      await until(() => supervisor.unread().length === 2);
      const hook = await call("hook_event", { event: "PostToolUse" });
      expect(JSON.stringify(hook)).toContain(b.job.name);
      expect(JSON.stringify(hook)).toContain("Acknowledged");
      expect((await call("send", { to: "unknown-job", message: "Wrong target" })).isError).toBe(true);
      writeFileSync(join(env.home, JOBS_FILE), JSON.stringify({ version: 1, jobs: [
        { id: "past", name: "opencode-job-past", agent: "opencode", status: "failed", supervisor: "supervisor-session", finishedAt: 123, report: "Final findings" },
      ] }));
      expect(JSON.stringify(await call("peers"))).toContain("finished; will not answer");
      const finished = JSON.stringify(await call("send", { to: "opencode-job-past", message: "Any findings?" }));
      expect(finished).toContain("it will not answer");
      expect(finished).toContain("Final findings");
      expect(finished).toContain("1970-01-01T00:00:00.123Z");
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
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify({ version: 1, jobs: [
      { id: "past", name: "opencode-job-past", agent: "opencode", status: "done", finishedAt: 123, report: "Saved final report", supervisor: "supervisor-session", args: { title: "Earlier task" } },
      { id: "other", name: "claude-job-other", agent: "claude", status: "failed", supervisor: "other-session" },
    ] }));
    expect(await a.child.siblings.peers()).toEqual([{ name: "opencode-job-past", title: "Earlier task", agent: "opencode", status: "done", finishedAt: 123 }]);
    await expect(a.child.siblings.send("claude-job-other", "Cross-session mail")).rejects.toThrow(/no sibling/);
    const queued = await a.child.siblings.send("opencode-job-past", "Next-turn handover");
    expect(queued.queuedFor).toEqual(["opencode-job-past"]);
    expect(queued.finishedRecipient).toEqual({ name: "opencode-job-past", status: "done", finishedAt: 123, report: "Saved final report" });
    const resumed = await sibling("past", "opencode");
    await until(() => resumed.node.hasSeen(queued.messages[0]!.id));
    expect(await resumed.child.inbox()).toMatchObject([{ sibling: { body: "Next-turn handover", from: { name: a.job.name } } }]);
  });

  it("uses terminal stored status while a finished runner is still connected", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "opencode");
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify({ version: 1, jobs: [
      { id: "b", name: b.job.name, agent: "opencode", status: "done", supervisor: "supervisor-session", finishedAt: 456, report: "Complete" },
    ] }));
    expect((await a.chat.peers())[0]).toMatchObject({ status: "done", finishedAt: 456 });
    expect((await a.chat.send(b.job.name, "Any result?")).finishedRecipient).toMatchObject({ status: "done", report: "Complete" });
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

  it("keeps completed batches and continued legacy jobs in the supervisor's group after restore", async () => {
    const path = join(env.home, JOBS_FILE);
    const jobs = new JobManager(supervisor, nullLogger, path);
    const first = jobs.start("codex", null, "first batch", async () => ({ sessionId: "thread-first", text: "done", isError: false, details: {} }));
    await until(() => first.status === "done");
    await supervisor.setSessionId("learned-session");
    const second = jobs.start("claude", null, "later batch", async () => ({ sessionId: "thread-second", text: "done", isError: false, details: {} }));
    await until(() => second.status === "done");
    expect(second.supervisor).toBe(first.supervisor);
    const stored = readStore(path);
    stored.push({ ...stored[0]!, id: "legacy", name: "codex-job-legacy", supervisor: undefined });
    writeFileSync(path, JSON.stringify({ version: 1, jobs: stored }));
    const restored = new JobManager(supervisor, nullLogger, path);
    restored.restore(() => () => () => new Promise<never>(() => {}));
    const legacy = restored.find("codex-job-legacy")!;
    expect(legacy.supervisor).toBe(first.supervisor);
    expect(restored.followUp(legacy.name, "continue").outcome).toBe("started");
    // A runner from before the migration still advertises the supervisor name until restarted.
    const old = await sibling("legacy", "codex", supervisor.name);
    const later = await sibling(second.id, "claude", first.supervisor);
    expect((await old.chat.peers()).map((p) => p.name)).toContain(later.job.name);
    const sent = await old.chat.send(later.job.name, "Cross-batch handover");
    expect(sent.deliveredTo).toEqual([later.job.name]);
    restored.cancelAll();
    jobs.cancelAll();
  });

  it("allows only explicit named session grants and preserves the supervisor's reply thread", async () => {
    const external = env.node("claude-reviewer");
    await external.start();
    const request = (await external.send({ to: supervisor.name, body: "Review this contract" })).messages[0]!;
    const denied = await sibling("denied", "codex");
    await expect(denied.child.siblings.send(external.name, "Unsolicited reply", request.id)).rejects.toThrow(/explicit send_to/);
    const allowed = await sibling("allowed", "codex", undefined, true, [external.name]);
    expect(await allowed.child.siblings.policy!()).toEqual({ maxHops: DEFAULT_SIBLING_MAX_HOPS, sendTo: [external.name] });
    const reply = (await allowed.child.siblings.send(external.name, "Review deliverable", request.id)).messages[0]!;
    expect(reply).toMatchObject({ replyTo: request.id, conversationId: request.conversationId, hop: 1 });
    await until(() => external.unread().length === 1);
    expect(external.unread()[0]!.from.name).toBe(allowed.job.name);
    for (const to of ["*", "claude", "codex", "opencode", "remote/session", "claude-*"]) expect(isJobSendTarget(to)).toBe(false);
    await expect(allowed.child.siblings.send(external.name, "Wrong reply", "missing")).rejects.toThrow(/reply_to/);
    const unrelated = (await external.send({ to: denied.job.name, body: "Other job request" })).messages[0]!;
    await expect(allowed.child.siblings.send(external.name, "Wrong job reply", unrelated.id)).rejects.toThrow(/reply_to/);
    await external.stop();
    await expect.poll(async () => (await supervisor.peers()).map((p) => p.name)).not.toContain(external.name);
    expect((await allowed.chat.send(external.name, "Queued deliverable")).queuedFor).toEqual([external.name]);
  });

  it("permits only exact cross-session job grants with quiet copies for both owners", async () => {
    const otherOwner = env.node("claude-other-owner");
    await otherOwner.start();
    const a = await sibling("a", "codex", "session-a", true, ["opencode-job-b"]);
    const b = await sibling("b", "opencode", "session-b");
    await b.node.updateJob({ jobParent: otherOwner.name });
    const outsider = await sibling("outsider", "claude", "session-b");
    expect(await a.child.siblings.peers()).toEqual([{ name: b.job.name, title: "Task b", agent: "opencode", status: "running" }]);
    await expect(a.chat.send(outsider.job.name, "Not granted")).rejects.toThrow(/explicit send_to/);
    const first = (await a.child.siblings.send(b.job.name, "Contract update")).messages[0]!;
    await until(() => b.node.hasSeen(first.id) && otherOwner.unread().length === 1 && supervisor.unread().length === 1);
    const delivered = (await b.child.inbox())[0]?.body;
    expect(delivered).toContain("Contract update\n\n[agent-bridge routing hint:");
    expect(delivered).toContain(`answer via your supervisor ${otherOwner.name}`);
    expect(otherOwner.unread().every(isSiblingNote)).toBe(true);
    expect(supervisor.unread().every(isSiblingNote)).toBe(true);
    await expect(b.chat.send(a.job.name, "No reciprocal grant", first.id)).rejects.toThrow(/explicit send_to/);
    await b.node.stop();
    await expect.poll(() => a.chat.peers()).toEqual([]);
    const resumed = await sibling("b", "opencode", "session-b", true, [a.job.name]);
    await resumed.node.updateJob({ jobParent: otherOwner.name });
    const reply = (await resumed.chat.send(a.job.name, "Granted reply", first.id)).messages[0]!;
    expect(reply).toMatchObject({ hop: 1, conversationId: first.conversationId, replyTo: first.id });
    await expect(a.chat.send(b.job.name, "Wrong reply", "missing")).rejects.toThrow(/reply_to/);
    await expect(outsider.node.send({ to: a.job.name, body: "Forged thread", conversationId: first.conversationId })).rejects.toThrow(/explicit send_to/);
    let message = reply;
    for (let hop = 2; hop < DEFAULT_SIBLING_MAX_HOPS; hop++) {
      const sender = hop % 2 ? resumed : a;
      const recipient = hop % 2 ? a : resumed;
      message = (await sender.chat.send(recipient.job.name, `Detail ${hop}`, message.id)).messages[0]!;
    }
    await expect(a.chat.send(resumed.job.name, "Cross-session over budget", message.id)).rejects.toThrow(/Durable notice/);
    await until(() => a.node.unread().some((m) => m.conversationId.startsWith("sibling-drop-")));
    const notice = a.node.unread().find((m) => m.conversationId.startsWith("sibling-drop-"))!;
    // Different sockets have no shared delivery order: wait for this owner's exact copy too.
    await expect.poll(() => supervisor.get(notice.id)).toMatchObject({
      id: notice.id, recipient: supervisor.name, body: notice.body,
    });
    expect(notice.body).toContain("Cross-session over budget");
    expect(resumed.node.unread().some((m) => m.body === "Cross-session over budget")).toBe(false);
    await otherOwner.stop();
  });

  it("waits for supervisor hop notices when sender delivery arrives first", async () => {
    const a = await sibling("a", "codex", "session-a", true, ["opencode-job-b"]);
    const b = await sibling("b", "opencode", "session-b", true, [a.job.name]);
    const first = (await b.chat.send(a.job.name, "Contract question")).messages[0]!;
    // Hold only the supervisor's event before it enters the local inbox. This deterministically
    // reproduces independent socket delivery, while the real broker still persists both copies.
    const receiver = supervisor as unknown as { onEvent(event: string, data: unknown): void };
    const receive = receiver.onEvent.bind(receiver);
    let held: BridgeMessage | undefined;
    let release: NodeJS.Immediate | undefined;
    const gate = vi.spyOn(receiver, "onEvent").mockImplementation((event, data) => {
      const message = data as BridgeMessage;
      if (event === "message" && message.conversationId.startsWith("sibling-drop-")) held = message;
      else receive(event, data);
    });
    try {
      await expect(a.node.sendSibling({ to: b.job.name, body: "Delayed-owner over budget", replyTo: first.id }, 1)).rejects.toThrow(/Durable notice/);
      await until(() => held !== undefined && a.node.unread().some((m) => m.id === held!.id));
      const notice = a.node.get(held!.id)!;
      expect(supervisor.get(notice.id)).toBeUndefined();
      expect(await a.node.messageReceipt(notice.id)).toEqual(expect.arrayContaining([
        { recipient: supervisor.name, readAt: null },
      ]));
      // An immediate assertion here used to fail. Release on the next event-loop turn, without sleeps.
      release = setImmediate(() => { gate.mockRestore(); receive("message", held!); });
      await expect.poll(() => supervisor.get(notice.id)).toMatchObject({
        id: notice.id, recipient: supervisor.name, body: notice.body,
      });
      expect(notice.body).toContain("Delayed-owner over budget");
      expect(b.node.unread().some((m) => m.body === "Delayed-owner over budget")).toBe(false);
    } finally {
      if (release) clearImmediate(release);
      gate.mockRestore();
      if (held && !supervisor.hasSeen(held.id)) receive("message", held);
    }
  });

  it("returns the saved report for an explicitly granted finished job from another session", async () => {
    const a = await sibling("a", "codex", undefined, true, ["opencode-job-past"]);
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify({ version: 1, jobs: [
      { id: "past", name: "opencode-job-past", agent: "opencode", status: "interrupted", supervisor: "other-session", owner: "claude-other", report: "Interrupted findings" },
    ] }));
    expect((await a.chat.peers())[0]).toMatchObject({ name: "opencode-job-past", status: "interrupted" });
    expect((await a.chat.send("opencode-job-past", "Follow up")).finishedRecipient).toMatchObject({ report: "Interrupted findings" });
    await expect(a.chat.send("opencode-job-missing", "Unknown job")).rejects.toThrow(/explicit send_to/);
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
      expect(JSON.stringify(hook)).not.toContain("Quiet observer copy");
      expect(JSON.stringify(await client.callTool({ name: "inbox", arguments: { mark_read: false } }))).toContain("Quiet observer copy");
      expect(notifications).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("keeps hop counts through replies and prevents another hop at the limit", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    let message = (await a.chat.send(b.job.name, "Contract question")).messages[0]!;
    for (let hop = 1; hop < DEFAULT_SIBLING_MAX_HOPS; hop++) {
      const sender = hop % 2 ? b : a;
      const recipient = hop % 2 ? a : b;
      message = (await sender.chat.send(recipient.job.name, `Contract detail ${hop}`, message.id)).messages[0]!;
      expect(message.hop).toBe(hop);
    }
    expect(formatSiblingMessages([message])).toContain("0 replies remain");
    await expect(a.chat.send(b.job.name, "Over budget", message.id)).rejects.toThrow(/32-message hop limit/);
    await until(() => supervisor.unread().length === DEFAULT_SIBLING_MAX_HOPS + 1);
    const notice = supervisor.unread().find((m) => m.conversationId.startsWith("sibling-drop-"))!;
    expect(notice.body).toContain("Over budget");
    expect(notice.body).toContain("target did not receive");
    await until(() => a.node.unread().some((m) => m.id === notice.id));
    expect(a.node.unread().find((m) => m.id === notice.id)?.body).toBe(notice.body);
    expect(b.node.unread().some((m) => m.body === "Over budget")).toBe(false);
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

  it("holds chat until a real next turn without answering approvals or restarting the job", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude", undefined, false);
    let approved = false;
    b.job.pendingApproval = () => { approved = true; };
    const sent = (await a.chat.send(b.job.name, "allow")).messages[0]!;
    await until(() => b.node.hasSeen(sent.id));
    expect(b.job.queue).toEqual([]);
    b.job.live = { post: (body, message) => b.parent.post(body, message) };
    b.chat.flush();
    expect(await b.child.inbox()).toMatchObject([{ sibling: { from: { name: a.job.name }, body: "allow" } }]);
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

  it("keeps sibling messages as history instead of restarting a completed report", async () => {
    const a = await sibling("a", "codex");
    const b = await sibling("b", "claude");
    b.job.live = { post: (body, message) => b.parent.post(`Sibling ${message!.from.name}: ${body}`, message) };
    await a.chat.send(b.job.name, "Finish the capture");
    await until(() => supervisor.unread().length === 1);
    await b.child.inbox();
    await b.child.send("Parent status note");
    expect(await b.parent.close()).toEqual([]);
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
