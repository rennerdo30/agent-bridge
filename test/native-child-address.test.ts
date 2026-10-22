import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeNode } from "../src/core/node.js";
import { BridgeClient } from "../src/core/client.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { isQuietMessage } from "../src/core/protocol.js";
import { MessageStore } from "../src/core/store.js";
import { NativeChildren } from "../src/core/native-children.js";
import { nullLogger } from "../src/core/logger.js";
import { buildHookResponse, type HookEvent } from "../src/mcp/hooks.js";
import { registerTools, type ServerContext } from "../src/mcp/server.js";
import { ParentLink, parentFromEnv } from "../src/core/parent-link.js";
import { SiblingLink } from "../src/mcp/siblings.js";
import type { Job } from "../src/mcp/jobs.js";
import { fixtureProject, makeEnv, until, type TestEnv } from "./helpers.js";
import { fixturePeer, retainFixtureRunner, unreadOwned } from "./owned-mail.js";
import { localMailbox } from "../src/core/recipient-ownership.js";

let env: TestEnv, parent: BridgeNode, job: BridgeNode, stranger: BridgeNode, ctx: ServerContext;
const agentId = "opus-1";
const hook = (event: HookEvent, over = {}) => buildHookResponse(ctx, { event, subagent: true, agentId, sessionId: "root", stopHookActive: false, ...over });
beforeEach(async () => {
  env = makeEnv();
  fixtureProject(env.home);
  parent = env.node("claude-main");
  await parent.setSessionId("root"); await parent.start();
  retainFixtureRunner(env.home, { id: "sol", name: "codex-job-sol", agent: "codex", owner: parent.name, supervisor: "root", cwd: env.home });
  job = new BridgeNode({ pipePath: env.pipe, token: loadOrCreateToken(env.home), dbPath: env.db, agent: "other", jobAgent: "codex", jobOwner: "root", jobParent: parent.name, id: "job:sol", name: "codex-job-sol", cwd: env.home, autoWake: false, canHostBroker: false, log: nullLogger });
  await job.start(); stranger = env.node("unrelated", "codex"); await stranger.start();
  ctx = { agent: "claude", node: parent, home: env.home, cfg: DEFAULT_CONFIG, log: nullLogger, cwd: () => env.home, channelActive: () => false,
    activity: vi.fn(), observeMeta: vi.fn(), onSessionId: vi.fn(), learnCwd: vi.fn(), wakeDelivery: { confirm: vi.fn(), release: vi.fn(), active: vi.fn() } };
});
afterEach(async () => { await job.stop(); await env.cleanup(); });
const address = () => `${parent.name}/sub:${agentId}`;

it("exchanges native Opus and Codex job mail with quiet parent copies and isolated hook ownership", async () => {
  const start = JSON.stringify(await hook("SubagentStart"));
  expect(start).toContain(address()); expect(start).toContain('native_child');
  expect(await job.siblings()).toContainEqual(expect.objectContaining({ name: address(), agent: "claude", status: "running" }));
  const initialPeers = await parent.peers();
  const main = initialPeers.find(p => p.id === parent.id)!;
  expect(main.projectMain).toBe(true);
  const first = (await job.sendSibling({ to: address(), body: "Review the design" }, 32)).messages[0]!;
  expect(await parent.nativeChildPending(agentId)).toEqual([expect.objectContaining({ id: first.id })]);
  await until(() => parent.unread().length === 1);
  expect(parent.unread().every(isQuietMessage)).toBe(true);
  expect(JSON.stringify(await hook("PostToolUse", { prepare: async () => { throw new Error("child prepared parent metadata"); } }))).toContain("Review the design");
  // The following boundary confirms that the preceding hook output reached the child.
  expect(await parent.nativeChildPending(agentId)).toHaveLength(1);
  await hook("PostToolUse");
  expect(await parent.nativeChildPending(agentId)).toEqual([]);
  const second = (await parent.nativeChildSend(agentId, { to: job.name, body: "Design reviewed", replyTo: first.id })).messages[0]!;
  await until(() => job.unread().some(m => m.id === second.id));
  expect(second).toMatchObject({ from: { name: address(), agent: "claude" }, hop: 1, conversationId: first.conversationId });
  await until(() => parent.unread().length === 2);
  expect(parent.unread().every(isQuietMessage)).toBe(true);
  expect((await parent.peers()).find(p => p.id === parent.id)).toMatchObject({ name: main.name, sessionId: main.sessionId, projectMain: main.projectMain });
  expect((await parent.peers()).some(p => p.name === address())).toBe(false);
  expect(ctx.activity).not.toHaveBeenCalled(); expect(ctx.observeMeta).not.toHaveBeenCalled(); expect(ctx.onSessionId).not.toHaveBeenCalled();
  expect(ctx.wakeDelivery?.confirm).not.toHaveBeenCalled();
});

it("broker refuses unrelated senders, child control, wildcard grants and a child selecting another parent", async () => {
  await hook("SubagentStart");
  await expect(stranger.send({ to: address(), body: "intrusion" })).rejects.toMatchObject({ code: "unauthorized" });
  await expect(stranger.sendSibling({ to: address(), body: "intrusion" }, 32)).rejects.toMatchObject({ code: "unauthorized" });
  await expect(stranger.nativeChildSend(agentId, { to: job.name, body: "impersonation" })).rejects.toMatchObject({ code: "unauthorized" });
  await expect(job.nativeChild({ agentId, action: "grant", sendTo: [stranger.name] })).rejects.toMatchObject({ code: "unauthorized" });
  await expect(parent.nativeChild({ agentId, action: "grant", sendTo: ["*"] })).rejects.toThrow(/exact/);
  expect(await parent.nativeChildPending(agentId)).toEqual([]);
  expect(await hook("PostToolUse", { sessionId: "foreign" })).toEqual({});
  expect(parent.currentSessionId).toBe("root");
  const remote = { id: randomUUID(), from: { id: "host/foreign", name: "host/unrelated", agent: "codex" }, to: address(), recipient: address(), body: "Paired-PC injection", conversationId: "remote", replyTo: null, hop: 0, createdAt: Date.now(), readAt: null };
  expect(() => (parent as any).broker.receiveRemote(remote)).toThrow(/not authorized/);
  expect(await parent.nativeChildPending(agentId)).toEqual([]);
});

it("reuses exact send_to grants in both directions and revokes them immediately", async () => {
  await hook("SubagentStart");
  await parent.nativeChild({ agentId, action: "grant", sendTo: [stranger.name] });
  const first = (await stranger.send({ to: address(), body: "Granted request" })).messages[0]!;
  const reply = (await parent.nativeChildSend(agentId, { to: stranger.name, body: "Granted reply", replyTo: first.id })).messages[0]!;
  await until(() => stranger.unread().some(m => m.id === reply.id));
  await parent.nativeChild({ agentId, action: "grant", sendTo: [] });
  await expect(stranger.send({ to: address(), body: "revoked" })).rejects.toThrow(/requires/);
  await expect(parent.nativeChildSend(agentId, { to: stranger.name, body: "revoked" })).rejects.toThrow(/requires/);
});

it("current durable job ownership overrides a runner's stale parent claims", async () => {
  await hook("SubagentStart");
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 2, jobs: [{ id: "sol", name: job.name, agent: "codex", status: "running", owner: stranger.name, supervisor: "different-root" }] }));
  await expect(job.sendSibling({ to: address(), body: "Old owner is stale" }, 32)).rejects.toThrow(/requires/);
  await expect(parent.nativeChildSend(agentId, { to: job.name, body: "Old ownership is stale" })).rejects.toThrow(/requires/);
});

it("cancelled child hooks and StopFailure leave child and parent mail untouched", async () => {
  await hook("SubagentStart");
  const sent = (await job.sendSibling({ to: address(), body: "Still pending" }, 32)).messages[0]!;
  const controller = new AbortController(); controller.abort();
  expect(await hook("PostToolUse", { signal: controller.signal })).toEqual({});
  expect(await hook("StopFailure")).toEqual({});
  expect(await parent.nativeChildPending(agentId)).toContainEqual(expect.objectContaining({ id: sent.id }));
  expect(ctx.activity).not.toHaveBeenCalled();
});

it("unconfirmed hook hand-outs return to the parent instead of being acknowledged before delivery", async () => {
  await hook("SubagentStart");
  const sent = (await job.sendSibling({ to: address(), body: "Unconfirmed hook context" }, 32)).messages[0]!;
  expect(JSON.stringify(await hook("PostToolUse"))).toContain("Unconfirmed hook context");
  expect((await job.messageReceipt(sent.id)).find(r => r.recipient === address())?.readAt).toBeNull();
  await expect(stranger.messageReceipt(sent.id)).rejects.toMatchObject({ code: "unauthorized" });
  await hook("SubagentStop"); await parent.refreshPending();
  expect(parent.unread()).toContainEqual(expect.objectContaining({ id: sent.id, body: "Unconfirmed hook context", readAt: null }));
});

it("authorizes a child-origin receipt only in its original active child incarnation and parent lineage", async () => {
  await hook("SubagentStart");
  const sent = (await parent.nativeChildSend(agentId, { to: job.name, body: "Child-owned receipt" })).messages[0]!;
  expect(JSON.parse(sent.senderOwner!.slice("native:".length))).toMatchObject({ kind: "child", parent: parent.name, session: "root", agentId });
  const receipt = () => parent.messageReceipt(sent.id, agentId);
  expect(await receipt()).toContainEqual({ recipient: job.name, readAt: null });
  await expect(parent.messageReceipt(sent.id)).rejects.toMatchObject({ code: "unauthorized" });
  await parent.nativeChild({ agentId: "other-child", action: "start" });
  await expect(parent.messageReceipt(sent.id, "other-child")).rejects.toMatchObject({ code: "unauthorized" });
  await expect(stranger.messageReceipt(sent.id, agentId)).rejects.toMatchObject({ code: "unauthorized" });
  const foreign = env.node("claude-foreign", "claude", false, "foreign-root"); await foreign.start();
  await foreign.nativeChild({ agentId, action: "start" });
  await expect(foreign.messageReceipt(sent.id, agentId)).rejects.toMatchObject({ code: "unauthorized" });
  await job.refreshPending(); job.markRead([sent.id]);
  await expect.poll(receipt).toContainEqual({ recipient: job.name, readAt: expect.any(Number) });
  await hook("SubagentStop");
  await expect(receipt()).rejects.toMatchObject({ code: "unauthorized" });
  // Even an explicit reload of the same parent session creates a new child
  // incarnation; it cannot inherit the previous child's sender authority.
  await parent.stop();
  const replacement = env.node("claude-main", "claude", false, "root"); await replacement.start();
  await replacement.nativeChild({ agentId, action: "start" });
  await expect(replacement.messageReceipt(sent.id, agentId)).rejects.toMatchObject({ code: "unauthorized" });
});

it("SubagentStop returns all pending mail to the parent and late hooks cannot resurrect the address", async () => {
  await hook("SubagentStart");
  const first = (await job.sendSibling({ to: address(), body: "Unconsumed findings" }, 32)).messages[0]!;
  await hook("SubagentStop");
  await parent.refreshPending();
  expect(parent.unread().find(m => m.id === first.id)).toMatchObject({ recipient: parent.name, to: address(), body: "Unconsumed findings", readAt: null });
  expect(await parent.nativeChildren()).toEqual([]);
  await expect(job.sendSibling({ to: address(), body: "late" }, 32)).rejects.toThrow(/unavailable/);
  await expect(hook("PostToolUse")).rejects.toThrow(/live/);
  expect((await job.messageReceipt(first.id)).find(r => r.recipient === parent.name)?.readAt).toBeNull();
});

it("parent SessionEnd returns pending mail without changing parent identity", async () => {
  await hook("SubagentStart");
  const sent = (await parent.send({ to: address(), body: "Parent instruction" })).messages[0]!;
  await buildHookResponse(ctx, { event: "SessionEnd", sessionId: "root", stopHookActive: false });
  await parent.refreshPending();
  expect(parent.unread().find(m => m.id === sent.id)?.body).toBe("Parent instruction");
  expect(parent.currentSessionId).toBe("root"); expect(await parent.nativeChildren()).toEqual([]);
  await expect(parent.nativeChild({ agentId: "late-new-child", action: "start" })).rejects.toThrow(/ended/);
});

it("parent disconnect durably returns mail for its next connection", async () => {
  await hook("SubagentStart");
  const first = (await job.sendSibling({ to: address(), body: "Survive disconnect" }, 32)).messages[0]!;
  // Keep the elected broker alive while disconnecting a separate parent session.
  const otherParent = env.node("claude-second"); await otherParent.setSessionId("second"); await otherParent.start();
  await otherParent.nativeChild({ agentId, action: "start" });
  const addr = `${otherParent.name}/sub:${agentId}`;
  const pending = (await otherParent.send({ to: addr, body: "Survive second parent" })).messages[0]!;
  await otherParent.stop();
  const restored = env.node("claude-second"); await restored.setSessionId("second"); await restored.start();
  await expect.poll(async () => { await restored.refreshPending(); return restored.unread(); }).toContainEqual(expect.objectContaining({ id: pending.id, recipient: "claude-second", readAt: null }));
  expect(await parent.nativeChildPending(agentId)).toContainEqual(expect.objectContaining({ id: first.id }));
});

it("broker recovery returns orphaned child queues without removing retained rows", async () => {
  const store = new MessageStore(":memory:", nullLogger);
  try {
    const parent = fixturePeer(store, "claude-old", { agent: "claude" });
    const children = new NativeChildren(store), address = (await children.start(parent, "opus")).address;
    const identity = children.target(address).identity;
    store.insert({ id: "orphan", from: { id: "sol", name: "codex-sol", agent: "codex" }, to: address, recipient: address,
      recipientNative: identity, recipientMailbox: localMailbox(store.namespace), body: "Retained bytes", conversationId: "thread", replyTo: null, hop: 0, createdAt: Date.now(), readAt: null });
    await new NativeChildren(store).recover();
    expect(unreadOwned(store, parent)).toContainEqual(expect.objectContaining({ id: "orphan", body: "Retained bytes" }));
    expect(unreadOwned(store, fixturePeer(store, parent.name, { agent: "claude" }))).toEqual([]);
    expect(store.messagesById("orphan").find(m => m.recipient === address)).toMatchObject({ body: "Retained bytes", recipientNative: identity });
    expect(store.nativeChildRoutes()).toEqual([]);
  } finally { store.close(); }
});

it("enforces child hops in both directions and refuses unrelated reply anchors", async () => {
  await parent.nativeChild({ agentId, action: "start", maxHops: 2 });
  const first = (await job.sendSibling({ to: address(), body: "first" }, 32)).messages[0]!;
  const second = (await parent.nativeChildSend(agentId, { to: job.name, body: "second", replyTo: first.id })).messages[0]!;
  await expect(job.sendSibling({ to: address(), body: "third", replyTo: second.id }, 32)).rejects.toThrow(/hop limit/);
  await expect(parent.nativeChildSend(agentId, { to: job.name, body: "missing", replyTo: "missing" })).rejects.toThrow(/reply_to/);
  await expect(parent.nativeChildSend(agentId, { to: "*", body: "broadcast" })).rejects.toThrow(/requires/);
});

it("preserves the AB-268 hello rejection for native children", async () => {
  const client = await BridgeClient.connect(env.pipe, nullLogger);
  try {
    const main = (await parent.peers()).find(p => p.id === parent.id)!;
    await expect(client.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), peer: { ...main, id: "native-spoof", subagent: true } })).rejects.toThrow(/cannot register/);
    expect((await parent.peers()).find(p => p.id === parent.id)).toMatchObject({ name: parent.name, sessionId: "root", projectMain: main.projectMain });
  } finally { client.close(); }
});

it("scopes ordinary bridge tools with explicit child identity or metadata, keeping parent mail private", async () => {
  const handlers = new Map<string, (a: any, e: any) => Promise<any>>();
  registerTools({ registerTool: (name: string, _spec: unknown, fn: any) => handlers.set(name, fn) } as any, ctx, []);
  const call = (name: string, a = {}, meta?: Record<string, unknown>) => handlers.get(name)!(a, { signal: new AbortController().signal, _meta: meta });
  await call("hook_event", { event: "SubagentStart", session_id: "root", agent_id: agentId });
  await stranger.send({ to: parent.name, body: "Private parent task" });
  await until(() => parent.unread().some(m => m.body === "Private parent task"));
  const first = (await job.sendSibling({ to: address(), body: "Child task" }, 32)).messages[0]!;
  const inbox = await call("inbox", { native_child: agentId });
  expect(JSON.stringify(inbox)).toContain("Child task"); expect(JSON.stringify(inbox)).not.toContain("Private parent task");
  expect(JSON.stringify(await call("inbox", { mark_read: false }))).toContain(address());
  ctx.observeMeta = vi.fn();
  expect(JSON.stringify(await call("hook_event", { event: "PostToolUse", session_id: "root" }, { agentId }))).toContain(address());
  expect(ctx.observeMeta).not.toHaveBeenCalled();
  const sent = await call("send", { to: job.name, message: "Native reply", reply_to: first.id }, { agent_id: agentId, sessionId: "bad" });
  expect(sent.isError).not.toBe(true); expect(JSON.stringify(sent)).toContain(address()); expect(ctx.observeMeta).not.toHaveBeenCalled();
  expect((await call("project_main", { to: stranger.name }, { agent_id: agentId })).isError).toBe(true);
  expect((await call("inbox", { native_child: "other-child" }, { agent_id: agentId })).isError).toBe(true);
  expect(parent.currentSessionId).toBe("root");
  const id = randomUUID();
  const send = { native_child: agentId, to: job.name, message: "Idempotent child send", message_id: id };
  expect((await call("send", send)).isError).not.toBe(true);
  expect(JSON.stringify(await call("send", send))).toContain('recovered');
});

it("concurrent durable child retries create one delivery and one supervisor copy", async () => {
  await hook("SubagentStart");
  const args = { to: job.name, body: "One delivery", messageId: randomUUID() };
  const results = await Promise.all([parent.nativeChildSend(agentId, args), parent.nativeChildSend(agentId, args)]);
  expect(results.filter(r => r.storage?.recovered)).toHaveLength(1);
  await until(() => parent.unread().length === 1 && job.unread().length === 1);
  expect(parent.unread()[0]?.body).toContain("One delivery");
  const inbound = { to: address(), body: "One inbound delivery", dedupeKey: "same-sibling-retry" };
  const incoming = await Promise.all([job.sendSibling(inbound, 32), job.sendSibling(inbound, 32)]);
  expect(incoming[0]?.messages[0]?.id).toBe(incoming[1]?.messages[0]?.id);
  expect(await parent.nativeChildPending(agentId)).toHaveLength(1);
  await until(() => parent.unread().length === 2);
});

it("routes through the real Codex bridge job parent-link inbox and sibling send path", async () => {
  const work: Job = { id: "sol", name: job.name, agent: "codex", model: null, prompt: "Review", status: "running", startedAt: Date.now(), controller: new AbortController(), progress: null, sessionId: null, workdir: env.home, worktree: null, queue: [] };
  const chat = new SiblingLink(job, work, 32, nullLogger);
  const link = new ParentLink(parent.name, () => {}, nullLogger, undefined, chat);
  await link.start();
  work.live = { post: (body, message) => link.post(body, message) };
  const client = parentFromEnv(link.childEnv())!;
  try {
    await hook("SubagentStart");
    const first = (await client.siblings.send(address(), "Codex job question")).messages[0]!;
    expect(JSON.stringify(await hook("PostToolUse"))).toContain("Codex job question");
    const second = (await parent.nativeChildSend(agentId, { to: job.name, body: "Native Opus answer", replyTo: first.id })).messages[0]!;
    await until(() => job.hasSeen(second.id));
    expect(await client.inbox()).toContainEqual(expect.objectContaining({ id: second.id, body: "Native Opus answer", sibling: expect.objectContaining({ from: expect.objectContaining({ name: address(), agent: "claude" }) }) }));
    await client.siblings.send(address(), "Codex job follow-up", second.id);
    expect(JSON.stringify(await hook("PostToolUse"))).toContain("Codex job follow-up");
  } finally { chat.close(); await link.close(); }
});
