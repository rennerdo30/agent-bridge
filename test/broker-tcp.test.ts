import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { brokerTcpPort, BROKER_TCP_FILE, isEphemeralBrokerTcpRecord } from "../src/core/paths.js";
import { readMusePrivateJson, writeMusePrivateJson } from "../src/core/muse-context.js";
import { processIdentity } from "../src/core/process-identity.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, until } from "./helpers.js";

describe("broker loopback fallback", () => {
  it.runIf(process.platform === "win32")("does not overwrite unknown durable discovery content when starting", async () => {
    const env = makeEnv(), file = join(env.home, BROKER_TCP_FILE);
    writeMusePrivateJson(file, { userHistory: "unique retained history" });
    const before = readFileSync(file);
    const broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, loadOrCreateToken(env.home));
    try { await broker.listen(); expect(readFileSync(file)).toEqual(before); }
    finally { await broker.close(); expect(readFileSync(file)).toEqual(before); await env.cleanup(); }
  });
  it("parses only a valid recorded port", () => {
    const env = makeEnv();
    expect(brokerTcpPort(env.home, env.pipe)).toBeNull();
    const record = { port: 4321, pid: process.pid, identity: processIdentity(process.pid), nonce: "fixture", protocol: PROTOCOL_VERSION, pipePath: env.pipe };
    writeMusePrivateJson(join(env.home, BROKER_TCP_FILE), record);
    expect(brokerTcpPort(env.home, env.pipe)).toBe(4321);
    expect(isEphemeralBrokerTcpRecord(record)).toBe(true);
    expect(isEphemeralBrokerTcpRecord({ ...record, userHistory: "unique durable data" })).toBe(false);
    expect(brokerTcpPort(env.home, "foreign-pipe")).toBeNull();
    writeMusePrivateJson(join(env.home, BROKER_TCP_FILE), { ...record, identity: "reused-pid" }, "w");
    expect(brokerTcpPort(env.home, env.pipe)).toBeNull();
    writeMusePrivateJson(join(env.home, BROKER_TCP_FILE), { ...record, port: "4321" }, "w");
    expect(brokerTcpPort(env.home, env.pipe)).toBeNull();
    writeFileSync(join(env.home, BROKER_TCP_FILE), "not json");
    expect(brokerTcpPort(env.home, env.pipe)).toBeNull();
    env.cleanup();
  });

  it.runIf(process.platform === "win32")("retains a successor or any descriptor containing durable data", async () => {
    for (const addition of [{ nonce: "successor" }, { userHistory: "unique retained history" }]) {
      const env = makeEnv(), token = loadOrCreateToken(env.home);
      const broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, token);
      try {
        await broker.listen();
        const file = join(env.home, BROKER_TCP_FILE), record = readMusePrivateJson(file);
        writeMusePrivateJson(file, { ...record, ...addition }, "w");
        const before = readFileSync(file);
        await broker.close();
        expect(readFileSync(file)).toEqual(before);
      } finally { await broker.close(); await env.cleanup(); }
    }
  });

  it.runIf(process.platform === "win32")("serves the broker protocol on loopback and cleans up its port file", async () => {
    const env = makeEnv(), token = loadOrCreateToken(env.home);
    const broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, token);
    await broker.listen();
    try {
      const portFile = join(env.home, BROKER_TCP_FILE);
      await until(() => existsSync(portFile));
      const port = brokerTcpPort(env.home, env.pipe);
      expect(port).toBeGreaterThan(0);
      // An unrelated requested endpoint must not be redirected by ambient home.
      // Simulate an inaccessible intended named pipe before using real loopback.
      const previous = process.env.AGENT_BRIDGE_HOME;
      process.env.AGENT_BRIDGE_HOME = env.home;
      try {
        await expect(BridgeClient.connect(join(env.home, "no-such-pipe"), nullLogger, 500)).rejects.toBeDefined();
        const open = vi.spyOn(BridgeClient as any, "connectSocket").mockRejectedValueOnce(Object.assign(new Error("fixture inaccessible pipe"), { code: "EACCES" }));
        const client = await BridgeClient.connect(env.pipe, nullLogger, 5_000);
        open.mockRestore();
        const hello = await client.request("hello", { protocol: PROTOCOL_VERSION, token, peer: {
          id: "tcp-probe", name: "tcp-probe", agent: "other", cwd: env.home, pid: process.pid,
          agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false,
        } });
        expect(Array.isArray(hello.peers)).toBe(true);
        const reopen = vi.spyOn(BridgeClient as any, "connectSocket").mockRejectedValueOnce(Object.assign(new Error("fixture inaccessible pipe"), { code: "EACCES" }));
        const second = await BridgeClient.connect(env.pipe, nullLogger, 5_000);
        reopen.mockRestore();
        const hello2 = await second.request("hello", { protocol: PROTOCOL_VERSION, token, peer: {
          id: "tcp-probe-2", name: "tcp-probe-2", agent: "other", cwd: env.home, pid: process.pid,
          agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false,
        } });
        expect(hello2.peers.map((p) => p.name)).toContain("tcp-probe");
        second.close();
        client.close();
      } finally {
        if (previous === undefined) delete process.env.AGENT_BRIDGE_HOME; else process.env.AGENT_BRIDGE_HOME = previous;
      }
      expect(readMusePrivateJson(portFile).port).toBe(port);
    } finally {
      await broker.close();
    }
    expect(existsSync(join(env.home, BROKER_TCP_FILE))).toBe(false);
    env.cleanup();
  });
});


