import { randomUUID } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { JOBS_FILE } from "../src/core/constants.js";
import { MessageStore } from "../src/core/store.js";
import { ReadJournal } from "../src/core/read-journal.js";
import { BridgeNode } from "../src/core/node.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeMessage, PeerInfo } from "../src/core/protocol.js";
import { formatDelivery, formatPeer } from "../src/mcp/format.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { MessageWaitStore, resumeWaitHint, SINGLE_WAIT_SEC, singleWaitTimeoutMs, waitForReadReceipt } from "../src/mcp/message-wait.js";
import { shouldWakeClaudeMessage } from "../src/mcp/rewake.js";
import type { ServerContext } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let extraNodes: BridgeNode[] = [];
beforeEach(() => { env = makeEnv(); extraNodes = []; });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await Promise.all(extraNodes.map((n) => n.stop())); await env.cleanup(); });

describe("delivery and reload recovery", () => {
  it("distinguishes idle inbox delivery from consumption and waits for a read receipt", async () => {
    const sender = env.node("sender");
    const recipient = env.node("recipient");
    await sender.start(); await recipient.start();
    recipient.setActivity("idle");
    // Serialize the activity update before routing.
    await recipient.peers();
    const sent = await sender.send({ to: recipient.name, body: "please check" });
    const id = sent.messages[0]!.id;
    expect(formatDelivery(sent).join("\n")).toContain("will be read on its next turn");
    expect(formatPeer((await sender.peers()).find((p) => p.name === recipient.name)!)).toContain("will be read on its next turn");
    expect(await sender.messageReceipt(id)).toEqual([{ recipient: recipient.name, readAt: null }]);
    await until(() => recipient.unread().length === 1);
    const waiting = waitForReadReceipt(sender, id, 2_000, new AbortController().signal);
    recipient.markRead([id]);
    expect(await waiting).toEqual([{ recipient: recipient.name, readAt: expect.any(Number) }]);
    expect(recipient.autoWakeEnabled).toBe(false);
  });

  it("uses the same truthful idle result for a namespaced paired-PC peer", () => {
    const name = "mac/claude-app";
    const res = { messages: [], deliveredTo: [name], queuedFor: [], recipientStates: [{ name, activity: "idle" as const, autoWake: false }] };
    expect(formatDelivery(res)[0]).toContain("will be read on its next turn");
    res.recipientStates[0]!.autoWake = true;
    expect(formatDelivery(res)[0]).toContain("no wake for this delivery");
    expect(formatPeer({ ...res.recipientStates[0], agent: "claude", id: "id", cwd: "", startedAt: Date.now() } as PeerInfo)).toContain("auto-wake");
  });

  it("keeps earlier and new reads when a prior journal append was interrupted", () => {
    const journal = new ReadJournal(env.home);
    journal.append("name:recipient", ["first"]);
    const path = join(env.home, "read-state", readdirSync(join(env.home, "read-state"))[0]!);
    writeFileSync(path, '["first"]\n["interrupted"');
    journal.append("name:recipient", ["latest"]);
    expect(journal.read("name:recipient")).toEqual(["first", "latest"]);
  });

  it("persists consumption before an ack lost during a plugin replacement", async () => {
    const broker = env.node("sender");
    const old = env.node("recipient");
    await broker.start(); await old.start();
    await old.setSessionId("recipient-session");
    const sent = await broker.send({ to: old.name, body: "already handled" });
    const id = sent.messages[0]!.id;
    await until(() => old.unread().length === 1);
    const client = (old as any).client;
    const request = client.request.bind(client);
    vi.spyOn(client, "request").mockImplementation((op, args) => op === "ack" ? Promise.reject(new Error("Connection closed")) : request(op, args));
    old.markRead([id]);
    expect((await broker.messageReceipt(id))[0]!.readAt).toBeNull();
    await old.stop();
    const replacement = env.node("recipient");
    await replacement.start();
    await replacement.setSessionId("recipient-session");
    await until(() => replacement.hasSeen(id));
    expect(replacement.unread()).toEqual([]);
    let acked = false;
    for (let attempt = 0; attempt < 20 && !acked; attempt++) {
      acked = (await broker.messageReceipt(id))[0]!.readAt !== null;
      if (!acked) await new Promise((r) => setTimeout(r, 20));
    }
    expect(acked).toBe(true);
  });

  it("never replays finished job notes from durable backlog but keeps final results", async () => {
    const sender = env.node("sender");
    await sender.start();
    const id = randomUUID();
    writeFileSync(join(env.home, JOBS_FILE), JSON.stringify({ version: 1, jobs: [{ id, status: "done" }] }));
    const job = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), id: `job:${id}`, jobAgent: "codex", agent: "other", name: "codex-job-old", cwd: env.home, autoWake: false, log: nullLogger, canHostBroker: false });
    extraNodes.push(job);
    await job.start();
    const note = await job.send({ to: "recipient", body: "reserve a slot", conversationId: `job-${id}:note` });
    const final = await job.send({ to: "recipient", body: "completed", conversationId: `job-${id}` });
    const recipient = env.node("recipient");
    await recipient.start();
    await until(() => recipient.unread().length === 1);
    expect(recipient.unread()[0]!.id).toBe(final.messages[0]!.id);
    expect((await job.messageReceipt(note.messages[0]!.id))[0]!.readAt).toBeTypeOf("number");
    const ctx: ServerContext = { agent: "claude", cfg: { ...DEFAULT_CONFIG, wakeOnDirect: false }, node: recipient, log: nullLogger, home: env.home, cwd: () => env.home, channelActive: () => false,
      jobs: { isNote: (m: BridgeMessage) => m.conversationId.endsWith(":note"), find: () => ({ status: "done" }) } as any };
    // Also discard a note that was buffered while the job was running, then finished.
    recipient.deliverLocal(note.messages[0]!);
    const out = await buildHookResponse(ctx, { event: "UserPromptSubmit", sessionId: null, stopHookActive: false });
    expect(JSON.stringify(out)).not.toContain("reserve a slot");
    expect(JSON.stringify(out)).toContain("completed");
    expect(recipient.hasSeen(final.messages[0]!.id)).toBe(true);
  });

  it("merges reload aliases without replaying or conflicting with a broadcast copy", () => {
    const store = new MessageStore(":memory:", nullLogger);
    try {
      const m: BridgeMessage = { id: randomUUID(), from: { id: randomUUID(), name: "sender", agent: "claude" }, to: "*", recipient: "recipient-2", conversationId: randomUUID(), replyTo: null, hop: 0, body: "broadcast", createdAt: Date.now(), readAt: null };
      store.insert(m);
      store.insert({ ...m, recipient: "recipient" });
      expect(store.claim("recipient-2", "recipient")).toBe(1);
      expect(store.unread("recipient-2", 10)).toEqual([]);
      expect(store.unread("recipient", 10)).toHaveLength(1);
      expect(store.claim("recipient", "recipient")).toBe(0);
      expect(store.unread("recipient", 10)).toHaveLength(1);
    } finally { store.close(); }
  });

  it("restores interrupted wait filters and a resume hint on the replacement session", async () => {
    const old = env.node("recipient");
    await old.start(); await old.setSessionId("session");
    const store = new MessageWaitStore(env.home);
    const filters = { from: "mac/claude-app", reply_to: randomUUID(), conversation_id: randomUUID() };
    const saved = store.save(old, filters);
    const pending = old.waitForMessage(600_000);
    await old.stop();
    expect(await pending).toBeNull();
    expect(old.listenerCount("message")).toBe(0);
    const replacement = env.node("recipient");
    await replacement.start(); await replacement.setSessionId("session");
    const restored = new MessageWaitStore(env.home).get(replacement, saved.id);
    expect(restored.filters).toEqual(filters);
    expect(resumeWaitHint(restored)).toContain(filters.reply_to);
    const ctx: ServerContext = { agent: "claude", cfg: { ...DEFAULT_CONFIG }, node: replacement, log: nullLogger, home: env.home, cwd: () => env.home, channelActive: () => false };
    const out = await buildHookResponse(ctx, { event: "SessionStart", sessionId: "session", stopHookActive: false });
    expect(JSON.stringify(out)).toContain(saved.id);
    store.remove(saved.id);
    expect(store.pending(replacement)).toEqual([]);
  });

  it("defaults direct wake on and respects config sections and environment overrides", () => {
    expect(loadConfig(env.home, "claude", nullLogger, {}).wakeOnDirect).toBe(true);
    writeFileSync(join(env.home, "config.json"), JSON.stringify({ wakeOnDirect: true, claude: { wakeOnDirect: false } }));
    expect(loadConfig(env.home, "claude", nullLogger, {}).wakeOnDirect).toBe(false);
    expect(loadConfig(env.home, "claude", nullLogger, { AGENT_BRIDGE_WAKE_ON_DIRECT: "on" }).wakeOnDirect).toBe(true);
  });

  it("wakes direct Claude messages by default with broadcast, kind, note and hop guards", async () => {
    const node = env.node("claude-app");
    const message: BridgeMessage = { id: randomUUID(), from: { id: randomUUID(), name: "another-session", agent: "claude" }, to: node.name, recipient: node.name, conversationId: randomUUID(), replyTo: null, hop: 0, body: "work", createdAt: Date.now(), readAt: null };
    const cfg = { ...DEFAULT_CONFIG, maxHops: 2 };
    expect(node.autoWakeEnabled).toBe(false);
    expect(shouldWakeClaudeMessage(node, cfg, message)).toBe(true);
    expect(shouldWakeClaudeMessage(node, { ...cfg, wakeOnDirect: false }, message)).toBe(false);
    expect(shouldWakeClaudeMessage(node, cfg, { ...message, to: "*" })).toBe(true);
    expect(shouldWakeClaudeMessage(node, { ...cfg, wakeOnDirect: false }, { ...message, to: "*" })).toBe(false);
    expect(shouldWakeClaudeMessage(node, cfg, { ...message, to: "claude" })).toBe(false);
    expect(shouldWakeClaudeMessage(node, cfg, { ...message, hop: 2 })).toBe(false);
    expect(shouldWakeClaudeMessage(node, cfg, { ...message, conversationId: "job-old:note" })).toBe(false);
    expect(shouldWakeClaudeMessage(node, cfg, { ...message, from: { ...message.from, id: "paired-id/peer-id" }, to: "mac/claude-app" })).toBe(true);
    vi.spyOn(node, "isAwaitedReply").mockReturnValue(true);
    expect(shouldWakeClaudeMessage(node, { ...cfg, wakeOnDirect: false }, message)).toBe(true);
    expect(shouldWakeClaudeMessage(node, cfg, { ...message, to: "*" })).toBe(true);
    expect(shouldWakeClaudeMessage(node, { ...cfg, wakeOnDirect: false }, { ...message, to: "*" })).toBe(false);
    expect(shouldWakeClaudeMessage(node, cfg, { ...message, to: "claude" })).toBe(false);
    await node.setAutoWake(true);
    expect(shouldWakeClaudeMessage(node, cfg, { ...message, to: "*" })).toBe(true);
    expect(shouldWakeClaudeMessage(node, cfg, { ...message, hop: 2 })).toBe(false);
    expect(shouldWakeClaudeMessage(node, cfg, { ...message, conversationId: "job-old:note" })).toBe(false);
  });

  it("caps every single wait below the client background threshold", () => {
    expect(SINGLE_WAIT_SEC).toBe(110);
    for (const requested of [120, 180, 600, 900, 1_800]) expect(singleWaitTimeoutMs(requested)).toBe(110_000);
    expect(singleWaitTimeoutMs(1)).toBe(1_000);
  });

  it("delivers a muted broadcast on the next active hook when a channel is enabled", async () => {
    const sender = env.node("sender");
    const recipient = env.node("recipient");
    await sender.start(); await recipient.start();
    await sender.send({ to: "*", body: "broadcast without wake" });
    await until(() => recipient.unread().length === 1);
    const ctx: ServerContext = { agent: "claude", cfg: { ...DEFAULT_CONFIG, wakeOnDirect: false }, node: recipient, log: nullLogger, home: env.home, cwd: () => env.home, channelActive: () => true };
    const out = await buildHookResponse(ctx, { event: "UserPromptSubmit", sessionId: null, stopHookActive: false });
    expect(JSON.stringify(out)).toContain("broadcast without wake");
    expect(recipient.unread()).toEqual([]);
  });

  it("bounds a receipt wait even when the broker or paired link never answers", async () => {
    vi.useFakeTimers();
    const node = { wasReplaced: false, messageReceipt: () => new Promise(() => {}) } as unknown as BridgeNode;
    const waiting = waitForReadReceipt(node, randomUUID(), singleWaitTimeoutMs(600), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(110_000);
    expect(await waiting).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not consume a message when a wait starts already cancelled", async () => {
    const node = env.node("recipient");
    const ac = new AbortController(); ac.abort();
    expect(await node.waitForMessage(110_000, () => true, ac.signal)).toBeNull();
    expect(node.listenerCount("message")).toBe(0);
  });
});
