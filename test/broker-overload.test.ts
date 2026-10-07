import { EventEmitter } from "node:events";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { JobManager, readStore } from "../src/mcp/jobs.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

describe("broker overload survival", () => {
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
