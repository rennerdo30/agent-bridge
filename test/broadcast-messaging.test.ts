import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeNode } from "../src/core/node.js";
import { resolvePipePath } from "../src/core/paths.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { NetworkService } from "../src/network/link.js";
import { formatDelivery } from "../src/mcp/format.js";
import { shouldWakeClaudeMessage } from "../src/mcp/rewake.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let cleanup: (() => void | Promise<void>)[];
beforeEach(() => { env = makeEnv(); cleanup = []; });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.reverse()) await close();
  await env.cleanup();
});

async function host(name: string) {
  const dir = join(env.home, name);
  mkdirSync(dir);
  // Even with macOS's long canonical tmpdir prefix, Unix sockets must fit below 104 bytes.
  const pipe = process.platform === "win32" ? resolvePipePath(dir, {}) : `/tmp/ab-${randomUUID().slice(0, 12)}.sock`;
  const db = join(dir, "bridge.db");
  const broker = new Broker(pipe, new MessageStore(db, nullLogger), nullLogger, "broadcast-test", Date.now, undefined,
    { home: dir, config: { ...DEFAULT_NETWORK_CONFIG, enabled: true, name, bind: "127.0.0.1", port: 0, discovery: false } });
  cleanup.push(() => broker.close());
  await broker.listen();
  const admin = await BridgeClient.connect(pipe, nullLogger);
  cleanup.push(() => admin.close());
  await admin.request("auth", { protocol: PROTOCOL_VERSION, token: "broadcast-test" });
  return { admin, node(peerName: string, job = false) {
    const node = new BridgeNode({ pipePath: pipe, dbPath: db, token: "broadcast-test", agent: "claude", name: peerName,
      cwd: dir, autoWake: false, canHostBroker: false, log: nullLogger, ...(job ? { jobAgent: "codex" as const, id: `job:${randomUUID()}` } : {}) });
    cleanup.push(() => node.stop());
    return node;
  } };
}

it("broadcasts to local and paired-PC sessions with recipient wake policies and per-recipient receipts", async () => {
  const a = await host("windows");
  const b = await host("mac");
  const sender = a.node("sender");
  const local = a.node("local");
  const remote = b.node("remote");
  const muted = b.node("muted");
  const worker = b.node("worker", true);
  for (const node of [sender, local, remote, muted, worker]) await node.start();
  for (const node of [local, remote, muted]) node.setActivity("idle");
  await local.setWakePolicy(true, true);
  await remote.setWakePolicy(true, true);
  await muted.setWakePolicy(false, true);
  await a.admin.request("networkLink", { code: (await b.admin.request("networkPair", {})).code,
    host: "127.0.0.1", port: (await b.admin.request("networkStatus", {})).port! });
  const sent = await sender.send({ to: "*", body: "Owner-wide instruction", dedupeKey: "broadcast-once" });
  expect(sent.deliveredTo.sort()).toEqual(["local", "mac/muted", "mac/remote"]);
  expect(new Set(sent.messages.map((m) => m.id)).size).toBe(1);
  expect(sent.messages.every((m) => m.to === "*")).toBe(true);
  expect(formatDelivery(sent).find((line) => line.includes("mac/remote"))).toContain("wake requested");
  expect(formatDelivery(sent).find((line) => line.includes("mac/muted"))).toContain("no wake for this delivery");
  await until(() => local.unread().length === 1 && remote.unread().length === 1 && muted.unread().length === 1);
  expect(worker.unread()).toEqual([]);
  expect(sender.unread()).toEqual([]);
  expect(shouldWakeClaudeMessage(remote, DEFAULT_CONFIG, remote.unread()[0]!)).toBe(true);
  expect(shouldWakeClaudeMessage(muted, { ...DEFAULT_CONFIG, wakeOnDirect: false }, muted.unread()[0]!)).toBe(false);
  const id = sent.messages[0]!.id;
  expect((await sender.messageReceipt(id)).every((r) => r.readAt === null)).toBe(true);
  local.markRead([id]); remote.markRead([id]);
  await expect.poll(() => sender.messageReceipt(id)).toMatchObject([
    { recipient: "local", readAt: expect.any(Number) }, { recipient: "mac/remote", readAt: expect.any(Number) },
    { recipient: "mac/muted", readAt: null },
  ]);
  expect((await sender.send({ to: "*", body: "Owner-wide instruction", dedupeKey: "broadcast-once" })).messages).toEqual(sent.messages);
  expect(remote.unread()).toEqual([]);
  const original = NetworkService.prototype.send;
  vi.spyOn(NetworkService.prototype, "send").mockImplementation(function (this: NetworkService, message) {
    if (message.recipient === "mac/muted") return Promise.reject(new Error("paired link lost"));
    return original.call(this, message);
  });
  const partial = await sender.send({ to: "*", body: "Second instruction" });
  expect(partial.deliveredTo.sort()).toEqual(["local", "mac/remote"]);
  expect(partial.failedFor).toEqual([{ name: "mac/muted", reason: "paired link lost" }]);
  expect(formatDelivery(partial).join("\n")).toContain("Delivery not confirmed: mac/muted");
  expect(partial.messages.find((m) => m.recipient === "mac/muted")?.body).toBe("Second instruction");
});

it("broadcasts when the only recipients are on a paired PC", async () => {
  const a = await host("windows");
  const b = await host("mac");
  const sender = a.node("sender");
  const remote = b.node("remote");
  await sender.start(); await remote.start();
  await a.admin.request("networkLink", { code: (await b.admin.request("networkPair", {})).code,
    host: "127.0.0.1", port: (await b.admin.request("networkStatus", {})).port! });
  expect((await sender.send({ to: "*", body: "Remote-only broadcast" })).deliveredTo).toEqual(["mac/remote"]);
  expect(await remote.waitForMessage(2_000)).toMatchObject({ body: "Remote-only broadcast", to: "*" });
});

it("queues broadcasts for known offline sessions of every agent, survives restart and excludes jobs", async () => {
  const sender = env.node("sender");
  const recipients = [env.node("offline-code", "codex"), env.node("offline-open", "opencode"), env.node("offline-chat", "claude")];
  await sender.start();
  for (const n of recipients) { await n.start(); await n.stop(); }
  const worker = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home),
    name: "codex-job-offline", id: "job:offline", agent: "other", jobAgent: "codex", cwd: env.home,
    autoWake: false, canHostBroker: false, log: nullLogger });
  await worker.start();
  await expect(worker.send({ to: "*", body: "Unauthorized broadcast" })).rejects.toMatchObject({ code: "unauthorized" });
  await worker.stop();
  const sent = await sender.send({ to: "*", body: "Offline broadcast", dedupeKey: "offline-once" });
  expect(sent.deliveredTo).toEqual([]);
  expect(sent.queuedFor.sort()).toEqual(recipients.map((n) => n.name).sort());
  expect(new Set(sent.messages.map((m) => m.id)).size).toBe(1);
  await sender.stop();
  const replacement = env.node("sender");
  await replacement.start();
  for (const n of recipients) {
    const live = env.node(n.name, n.name === "offline-open" ? "opencode" : n.name === "offline-code" ? "codex" : "claude");
    await live.start();
    expect(await live.waitForMessage(2_000)).toMatchObject({ id: sent.messages[0]!.id, body: "Offline broadcast", to: "*" });
  }
});
