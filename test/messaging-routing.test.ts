import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BridgeClient } from "../src/core/client.js";
import type { DatabaseSync } from "node:sqlite";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

it.each(["claude", "codex", "opencode", "antigravity"] as const)("project mail reaches the %s secondary without a main relay", async agent => {
  const project = join(env.home, "topic-project"); mkdirSync(project);
  execFileSync("git", ["init", project], { windowsHide: true, stdio: "ignore" });
  const sender = env.node("sender", "other"), main = env.node("main"), secondary = env.node("secondary", agent), foreign = env.node("foreign", agent);
  await sender.start(); await main.relocate(project); await main.start();
  await secondary.relocate(project); await secondary.start(); await foreign.start();
  const sent = await sender.send({ to: "project:topic-project", body: "Proposal for the delegated topic", conversationId: "topic-round-3" });
  expect(sent.deliveredTo).toEqual([main.name, secondary.name]);
  await until(() => main.unread().length === 1 && secondary.unread().length === 1);
  expect(secondary.unread()[0]).toMatchObject({ id: sent.messages[0]!.id, conversationId: "topic-round-3" });
  await expect(secondary.send({ to: sender.name, body: "Secondary topic reply", replyTo: sent.messages[0]!.id, ifNoNewerThan: sent.messages[0]!.id })).resolves.toBeTruthy();
  expect(foreign.unread()).toEqual([]);
  await main.setUnavailable(true);
  expect((await sender.send({ to: "project:topic-project", body: "Next proposal" })).deliveredTo).toEqual([secondary.name]);
});

it.each(["claude", "codex", "opencode", "antigravity"] as const)("%s refuses stale negotiation replies and warns ordinary senders", async agent => {
  const a = env.node("a", agent), b = env.node("b", agent), c = env.node("c", "other");
  await a.start(); await b.start(); await c.start();
  const proposal = await b.send({ to: a.name, body: "Choose alpha", conversationId: "round-3" });
  const anchor = proposal.messages[0]!.id;
  await b.send({ to: a.name, body: "Newer proposal: beta", replyTo: anchor });
  await c.send({ to: a.name, body: "Tie break: beta", conversationId: "round-3" });
  await until(() => a.unread().length === 3);
  await expect(a.send({ to: b.name, body: "Stale settlement", replyTo: anchor, ifNoNewerThan: anchor })).rejects.toThrow("Stale reply refused");
  await expect(a.send({ to: "offline-settler", body: "Guard without reply_to", ifNoNewerThan: anchor })).rejects.toThrow("Stale reply refused");
  expect(b.unread()).toEqual([]);
  const ordinary = await a.send({ to: b.name, body: "Unprotected reply", replyTo: anchor });
  expect(ordinary.unreadBeforeSend).toHaveLength(3);
  a.markRead(a.unread().map(m => m.id));
  await expect(a.send({ to: b.name, body: "Reviewed settlement", replyTo: anchor, ifNoNewerThan: anchor })).resolves.toMatchObject({ deliveredTo: [b.name] });
  await expect(c.send({ to: b.name, body: "Foreign anchor", ifNoNewerThan: anchor })).rejects.toThrow("exchanged by this session");
});

it("retained status notes cannot block a guarded proposal", async () => {
  const a = env.node("a"), b = env.node("b"); await a.start(); await b.start();
  const proposal = await b.send({ to: a.name, body: "Proposal", conversationId: "topic" });
  await b.send({ to: a.name, body: "FYI", conversationId: "topic:note" });
  await expect(a.send({ to: b.name, body: "Answer", replyTo: proposal.messages[0]!.id, ifNoNewerThan: proposal.messages[0]!.id })).resolves.toBeTruthy();
});

it("an older broker cannot silently discard a requested reply guard", async () => {
  const a = env.node("a"); await a.start();
  const client = (a as unknown as { client: BridgeClient }).client;
  const request = vi.spyOn(client, "request").mockRejectedValue(new Error("unknown op: trackedSend"));
  await expect(a.send({ to: "offline", body: "Must be guarded", ifNoNewerThan: "anchor" })).rejects.toThrow("unknown op: trackedSend");
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]![0]).toBe("trackedSend");
});

it("a fan-out persistence failure leaves no half-delivered project send", () => {
  const store = new MessageStore(env.db, nullLogger);
  try {
    (store as unknown as { db: DatabaseSync }).db.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON messages WHEN NEW.recipient='reject' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
    const base = { id: "batch-test", from: { id: "sender", name: "sender", agent: "codex" as const }, to: "project:project", conversationId: "topic", replyTo: null, hop: 0, body: "Proposal", createdAt: Date.now(), readAt: null };
    expect(() => store.insertBatch([{ ...base, recipient: "main" }, { ...base, recipient: "reject" }])).toThrow("fixture write failure");
    expect(store.unread("main", 10)).toEqual([]);
    expect(store.unread("reject", 10)).toEqual([]);
  } finally { store.close(); }
});
