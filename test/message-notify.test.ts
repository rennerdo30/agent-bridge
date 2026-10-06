import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { MessageWaitStore } from "../src/mcp/message-wait.js";
import { RewakeEndpoint, sessionFile, shouldWakeClaudeMessage } from "../src/mcp/rewake.js";
import { registerTools, type ServerContext } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let node: BridgeNode;
let store: MessageWaitStore;
let ctx: ServerContext;
const closes: (() => Promise<void>)[] = [];
const cfg = { ...DEFAULT_CONFIG, wakeOnDirect: false, lingerSec: 0, maxHops: 2 };
const mail = (overrides: Partial<BridgeMessage> = {}): BridgeMessage => ({
  id: randomUUID(), from: { id: randomUUID(), name: "mac/peer", agent: "codex" },
  to: "listener", recipient: "listener", replyTo: null, conversationId: randomUUID(),
  hop: 0, body: "the answer", createdAt: Date.now(), readAt: null, ...overrides,
});
async function clientFor(n = node): Promise<Client> {
  ctx = { node: n, home: env.home, cfg, agent: "claude", log: nullLogger, cwd: () => env.home, channelActive: () => false };
  const server = new McpServer({ name: "test", version: "1" });
  registerTools(server, ctx, []);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  closes.push(async () => { await client.close(); await server.close(); });
  return client;
}
const call = async (client: Client, args: Record<string, unknown>) => {
  const result = await client.callTool({ name: "wait_for_message", arguments: args });
  return result.content as { type: string; text: string }[];
};
const textOf = (content: { text: string }[]) => content.map((c) => c.text).join("\n");
beforeEach(async () => {
  env = makeEnv(); node = env.node("listener"); await node.start();
  await node.setSessionId("session"); store = new MessageWaitStore(env.home);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closes.splice(0).reverse()) await close();
  await env.cleanup();
});

describe("durable notification waits", () => {
  it("returns immediately by default, deduplicates filters and consumes only after delivery", async () => {
    const client = await clientFor();
    const filters = { from: "mac/peer", reply_to: randomUUID(), conversation_id: randomUUID() };
    const blocking = vi.spyOn(node, "waitForMessage");
    const first = textOf(await call(client, filters));
    expect(first).toContain("is armed"); expect(blocking).not.toHaveBeenCalled();
    expect(textOf(await call(client, filters))).toBe(first);
    expect(store.pending(node)).toHaveLength(1);
    const record = store.pending(node)[0]!;
    const unrelated = mail({ replyTo: filters.reply_to, conversationId: "other" });
    const answer = mail({ replyTo: filters.reply_to, conversationId: filters.conversation_id });
    node.deliverLocal(unrelated); node.deliverLocal(answer);
    expect(shouldWakeClaudeMessage(node, cfg, unrelated)).toBe(false);
    expect(shouldWakeClaudeMessage(node, cfg, answer)).toBe(true);
    expect(node.autoWakeEnabled).toBe(false);
    expect(store.pending(node)).toHaveLength(1);
    node.markRead([unrelated.id]); expect(store.pending(node)).toHaveLength(1);
    const out = await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false });
    expect(JSON.stringify(out)).toContain(answer.body);
    expect(store.pending(node)).toEqual([]);
    // Completed subscription is archived, not deleted; the read journal suppresses replay.
    const archive = join(env.home, "message-waits", "archive");
    const file = readdirSync(archive).find((f) => f.startsWith(`${record.id}.json-`))!;
    expect(readFileSync(join(archive, file), "utf8")).toContain(record.id);
    node.deliverLocal(answer); expect(node.unread()).toEqual([]);
  });

  it("restores filters automatically on a replacement session, including mail arriving offline", async () => {
    const client = await clientFor();
    const filters = { from: "mac/peer", reply_to: randomUUID() };
    await call(client, filters);
    const saved = store.pending(node)[0]!;
    await node.stop();
    const replacement = env.node("new-plugin-name"); await replacement.start();
    const newClient = await clientFor(replacement);
    await replacement.setSessionId("session");
    const answer = mail({ recipient: replacement.name, to: replacement.name, replyTo: filters.reply_to });
    replacement.deliverLocal(answer);
    expect(shouldWakeClaudeMessage(replacement, cfg, answer)).toBe(true);
    expect(textOf(await call(newClient, { resume_id: saved.id, from: "wrong-peer" }))).toContain("the answer");
    expect(store.pending(replacement)).toEqual([]);
    expect(store.pending(node)).toEqual([]);
  });

  it("keeps a handed-out reply and its subscription when wake delivery is lost", async () => {
    const client = await clientFor(); await call(client, { from: "mac/peer" });
    const endpoint = new RewakeEndpoint(env.home, node, (m) => shouldWakeClaudeMessage(node, cfg, m), nullLogger);
    await endpoint.start(); endpoint.register("session"); closes.push(() => endpoint.stop());
    const registration = JSON.parse(readFileSync(sessionFile(env.home, "session"), "utf8"));
    const fetchWake = () => fetch(`http://127.0.0.1:${registration.port}/wait`, { headers: { authorization: `Bearer ${registration.secret}` } }).then((r) => r.json());
    const wake = fetchWake(); await until(() => endpoint.waiting);
    node.deliverLocal(mail());
    expect((await wake).text).toContain("the answer");
    expect(store.pending(node)).toHaveLength(1); expect(node.unread()).toHaveLength(1);
    endpoint.releaseUndelivered();
    expect((await fetchWake()).text).toContain("the answer");
    expect(store.pending(node)).toHaveLength(1);
    endpoint.confirmDelivery();
    expect(store.pending(node)).toEqual([]); expect(node.unread()).toEqual([]);
  });

  it("converts a bounded blocking timeout into a notification without another call", async () => {
    const client = await clientFor();
    const original = node.waitForMessage.bind(node);
    // Keep real listener/timeout behavior, inject a 5ms timer instead of waiting 110 seconds.
    const blocking = vi.spyOn(node, "waitForMessage").mockImplementation((_timeout, predicate, signal) => original(5, predicate, signal));
    const result = textOf(await call(client, { mode: "block", timeout_sec: 600, from: "mac/peer" }));
    expect(blocking.mock.calls[0]![0]).toBe(110_000);
    expect(result).toContain("is armed"); expect(result).not.toContain("Repeat wait_for_message");
    expect(node.listenerCount("message")).toBe(0);
    expect(node.listenerCount("notification_waits_changed")).toBe(0);
    node.deliverLocal(mail()); expect(shouldWakeClaudeMessage(node, cfg, node.unread()[0]!)).toBe(true);
    expect(store.pending(node)[0]!.mode).toBe("notify");
  });

  it("converts a legacy resume_id without changing filters and rejects other sessions", async () => {
    const client = await clientFor(); const filters = { from: "mac/peer", reply_to: randomUUID() };
    const saved = store.save(node, filters);
    // Records written before mode existed are still blocking waits.
    const path = join(env.home, "message-waits", `${saved.id}.json`);
    const legacy = JSON.parse(readFileSync(path, "utf8")); delete legacy.mode; writeFileSync(path, JSON.stringify(legacy));
    expect(store.get(node, saved.id).mode).toBe("block");
    await call(client, { resume_id: saved.id, mode: "notify", from: "ignored" });
    expect(store.get(node, saved.id)).toMatchObject({ filters, mode: "notify" });
    const other = env.node("other"); await other.start(); await other.setSessionId("other-session");
    const stranger = await clientFor(other);
    expect(textOf(await call(stranger, { resume_id: saved.id }))).toContain("another session");
    expect(store.get(node, saved.id).mode).toBe("notify");
  });

  it("can cancel and archive a subscription without consuming unread mail", async () => {
    const client = await clientFor(); await call(client, { from: "mac/peer" });
    const id = store.pending(node)[0]!.id; const message = mail(); node.deliverLocal(message);
    expect(textOf(await call(client, { resume_id: id, mode: "cancel" }))).toContain("cancelled and archived");
    expect(store.pending(node)).toEqual([]); expect(node.unread()).toEqual([message]);
    expect(shouldWakeClaudeMessage(node, cfg, message)).toBe(false);
  });

  it("preserves quiet, note and hop guards and leaves unread matches queued", async () => {
    const client = await clientFor(); await call(client, { from: "codex" });
    for (const message of [mail({ hop: 2 }), mail({ conversationId: "files-progress-id" }), mail({ conversationId: "job-id:note" })]) {
      node.deliverLocal(message); expect(shouldWakeClaudeMessage(node, cfg, message)).toBe(false);
    }
    expect(await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false })).toEqual({});
    expect(node.unread()).toHaveLength(3); expect(store.pending(node)).toHaveLength(1);
    node.markRead(node.unread().filter((m) => m.hop === 0).map((m) => m.id));
    // Reading retained progress does not disarm the wait for the eventual useful reply.
    expect(store.pending(node)).toHaveLength(1);
    const final = mail(); node.deliverLocal(final);
    expect(shouldWakeClaudeMessage(node, cfg, final)).toBe(true);
  });

  it("returns an already queued reply and keeps receipt checks bounded", async () => {
    const client = await clientFor(); node.deliverLocal(mail());
    expect(textOf(await call(client, { from: "mac/peer" }))).toContain("the answer");
    expect(store.pending(node)).toEqual([]); expect(node.unread()).toEqual([]);
    const id = randomUUID();
    expect(textOf(await call(client, { read_receipt_of: id, mode: "notify" }))).toContain('mode="block" only');
    expect(store.pending(node)).toEqual([]);
  });

  it("ends the fallback listen window immediately when a notification is armed", async () => {
    const sender = env.node("sender"); await sender.start();
    const client = await clientFor();
    // A recent send would normally make Stop listen for up to lingerSec.
    await node.send({ to: "sender", body: "question" });
    ctx.cfg = { ...cfg, lingerSec: 300 };
    await call(client, { from: "mac/peer" });
    const blocking = vi.spyOn(node, "waitForMessage");
    expect(await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false })).toEqual({});
    expect(blocking).not.toHaveBeenCalled(); expect(store.pending(node)).toHaveLength(1);
  });
});
