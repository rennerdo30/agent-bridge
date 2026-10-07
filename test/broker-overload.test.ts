import { EventEmitter } from "node:events";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { JOBS_FILE, PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { JobManager, readStore } from "../src/mcp/jobs.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

describe("broker overload survival", () => {
  it("bounds pending frames by bytes without losing the large-message tail", async () => {
    const token = loadOrCreateToken(env.home), store = new MessageStore(env.db, nullLogger);
    const body = "large result ".repeat(10_000);
    for (let i = 0; i < 50; i++) store.insert({ id: randomUUID(), from: { id: "job:large", name: "opencode-job-large", agent: "opencode" },
      recipient: "reader", to: "reader", conversationId: "job-large", replyTo: null, hop: 0, body, createdAt: Date.now() + i, readAt: null });
    const broker = new Broker(env.pipe, store, nullLogger, token);
    await broker.listen();
    const client = await BridgeClient.connect(env.pipe, nullLogger);
    try {
      await client.request("hello", { protocol: PROTOCOL_VERSION, token, peer: { id: "reader", name: "reader", agent: "opencode", cwd: env.home,
        pid: process.pid, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false } });
      const batch = await client.request("pending", { limit: 500 });
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThan(50);
      expect(client.isClosed).toBe(false);
      await client.request("ack", { ids: batch.map((m) => m.id) });
      expect((await client.request("pending", { limit: 500 })).length).toBe(50 - batch.length);
      expect(store.byId(batch[0]!.id)?.body).toBe(body);
    } finally { client.close(); await broker.close(); }
  });
  it("refills a consuming node past 500 queued messages without any hook or inbox calls", async () => {
    const store = new MessageStore(env.db, nullLogger);
    try {
      for (let i = 0; i < 550; i++) store.insert({ id: randomUUID(), from: { id: "job:worker", name: "opencode-job-worker", agent: "opencode" },
        recipient: "reader", to: "reader", conversationId: "job-worker", replyTo: null, hop: 0, body: `result-${i}`, createdAt: Date.now() + i, readAt: null });
    } finally { store.close(); }
    const reader = env.node("reader", "opencode");
    const received = new Set<string>();
    reader.on("message", (m) => { received.add(m.id); reader.markRead([m.id]); });
    await reader.start();
    await until(() => received.size === 550);
    expect(reader.unread()).toEqual([]);
  });
  it.each(["send", "inline result"])("answers peers while a real SQLite writer lock delays %s, then queues it exactly once", async (operation) => {
    const sender = env.node("sender"), recipient = env.node("recipient", "opencode");
    await sender.start(); await recipient.start();
    const inline = { id: randomUUID(), from: { id: "job:inline", name: "opencode-job-inline", agent: "opencode" as const },
      to: "recipient", recipient: "recipient", conversationId: "job-inline", replyTo: null, hop: 0, body: "LOCKED_SEND", createdAt: Date.now(), readAt: null };
    if (operation === "inline result") writeFileSync(join(env.home, JOBS_FILE), JSON.stringify({ version: 3, jobs: [{
      id: "inline", name: "opencode-job-inline", agent: "opencode", status: "done", owner: recipient.name,
      rootName: recipient.name, executionOwner: sender.name, startedAt: Date.now(), prompt: "fixture",
    }] }));
    const submit = () => operation === "send" ? sender.send({ to: "recipient", body: "LOCKED_SEND", dedupeKey: "busy-once" }) : sender.reportInlineJob(inline);
    const worker = new Worker(`
      const { DatabaseSync } = require('node:sqlite');
      const { workerData, parentPort } = require('node:worker_threads');
      const db = new DatabaseSync(workerData, { timeout: 3000 });
      db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('locked');
      parentPort.once('message', () => { db.exec('COMMIT'); db.close(); parentPort.postMessage('released'); });
    `, { eval: true, workerData: env.db });
    const messages: string[] = [];
    worker.on("message", (m) => messages.push(m));
    let sent: Promise<unknown> | undefined;
    try {
      await until(() => messages.includes("locked"));
      let settled = false;
      sent = submit().then((res) => { settled = true; return res; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await sender.peers()).map((p) => p.name)).toContain("recipient");
      expect(settled).toBe(false);
      worker.postMessage("release");
      await until(() => messages.includes("released"));
      const result = await sent;
      expect(result).toMatchObject(operation === "send" ? { deliveredTo: ["recipient"], queuedFor: [] } : { saved: true });
      await until(() => recipient.unread().length === 1);
      expect(recipient.unread()[0]!.body).toBe("LOCKED_SEND");
      expect(await submit()).toEqual(result);
      expect(recipient.unread()).toHaveLength(1);
    } finally {
      worker.postMessage("release");
      await sent?.catch(() => {});
      await worker.terminate();
    }
  });
  it("keeps the elected listener and other peers connected when its session is replaced", async () => {
    const owner = env.node("owner"); const other = env.node("other", "codex");
    await owner.start(); await owner.setSessionId("same-session"); await other.start();
    const disconnect = vi.fn(); other.on("disconnected", disconnect);
    const replacement = env.node("owner");
    await replacement.start(); await replacement.setSessionId("same-session");
    await until(() => owner.wasReplaced && !owner.isConnected);
    expect(owner.isBroker).toBe(true);
    expect(other.isConnected).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();
    expect((await other.send({ to: replacement.name, body: "still available" })).deliveredTo).toEqual([replacement.name]);
  });

  it("contains a deferred storage error and retains mail for a later pending read", async () => {
    const token = loadOrCreateToken(env.home), store = new MessageStore(env.db, nullLogger);
    const broker = new Broker(env.pipe, store, nullLogger, token);
    const message = { id: "retained", from: { id: "sender", name: "sender", agent: "codex" as const }, to: "reader", recipient: "reader", conversationId: "chat", replyTo: null, hop: 0, body: "preserved", createdAt: Date.now(), readAt: null };
    store.insert(message);
    const unread = vi.spyOn(store, "unread").mockImplementationOnce(() => { throw new Error("database is locked"); });
    await broker.listen();
    const client = await BridgeClient.connect(env.pipe, nullLogger);
    try {
      await client.request("hello", { protocol: PROTOCOL_VERSION, token, peer: { id: "reader", name: "reader", agent: "other", cwd: env.home, pid: process.pid, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false } });
      await until(() => unread.mock.calls.length > 0);
      expect(await client.request("ping", {})).toHaveProperty("brokerPid");
      expect(await client.request("pending", {})).toMatchObject([{ id: "retained", body: "preserved" }]);
    } finally { client.close(); await broker.close(); }
  });

  it("disconnects a request flood without disrupting an unrelated client", async () => {
    const token = loadOrCreateToken(env.home), store = new MessageStore(env.db, nullLogger);
    const broker = new Broker(env.pipe, store, nullLogger, token);
    await broker.listen();
    const bad = await BridgeClient.connect(env.pipe, nullLogger), good = await BridgeClient.connect(env.pipe, nullLogger);
    // Hold dispatch responses so the cap is exercised independently of machine speed.
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const original = (broker as any).handlers.ping;
    (broker as any).handlers.ping = async () => { await blocked; return original(); };
    try {
      const requests = Array.from({ length: 512 }, () => bad.request("ping", {}).catch(() => null));
      await until(() => bad.isClosed);
      (broker as any).handlers.ping = original; release(); await Promise.all(requests);
      expect(await good.request("ping", {})).toHaveProperty("brokerPid");
    } finally { release(); bad.close(); good.close(); await broker.close(); }
  });

  it("retries a busy jobs store without blocking timers or losing the latest progress", async () => {
    const path = join(env.home, "jobs.json"), lock = `${path}.lock`;
    const coordinator = Object.assign(new EventEmitter(), { name: "owner", id: "owner-id", currentSessionId: "owner-session", deliverLocal: () => {} });
    const manager = new JobManager(coordinator as any, nullLogger, path);
    const tracked = manager.track("codex", null, "saved task");
    writeFileSync(lock, "");
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 10);
    try {
      tracked.job.percent = 10; manager.persist(); tracked.job.percent = 55; manager.persist();
      await until(() => ticked, 1000);
      expect(readStore(path)[0]?.percent).not.toBe(55);
      rmSync(lock); await until(() => readStore(path)[0]?.percent === 55);
      expect(readStore(path)[0]?.prompt).toBe("saved task");
    } finally { clearTimeout(timer); rmSync(lock, { force: true }); tracked.end(); }
  });
});
