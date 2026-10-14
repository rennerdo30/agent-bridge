import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { brokerTcpPort, BROKER_TCP_FILE } from "../src/core/paths.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, until } from "./helpers.js";

describe("broker loopback fallback", () => {
  it("parses only a valid recorded port", () => {
    const env = makeEnv();
    expect(brokerTcpPort(env.home)).toBeNull();
    writeFileSync(join(env.home, BROKER_TCP_FILE), JSON.stringify({ port: 4321 }));
    expect(brokerTcpPort(env.home)).toBe(4321);
    writeFileSync(join(env.home, BROKER_TCP_FILE), JSON.stringify({ port: "4321" }));
    expect(brokerTcpPort(env.home)).toBeNull();
    writeFileSync(join(env.home, BROKER_TCP_FILE), "not json");
    expect(brokerTcpPort(env.home)).toBeNull();
    env.cleanup();
  });

  it.runIf(process.platform === "win32")("serves the broker protocol on loopback and cleans up its port file", async () => {
    const env = makeEnv(), token = loadOrCreateToken(env.home);
    const broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, token);
    await broker.listen();
    try {
      const portFile = join(env.home, BROKER_TCP_FILE);
      await until(() => existsSync(portFile));
      const port = brokerTcpPort(env.home);
      expect(port).toBeGreaterThan(0);
      // A client whose pipe path is bogus still reaches the broker through the fallback.
      const previous = process.env.AGENT_BRIDGE_HOME;
      process.env.AGENT_BRIDGE_HOME = env.home;
      try {
        const client = await BridgeClient.connect(join(env.home, "no-such-pipe"), nullLogger, 5_000);
        const hello = await client.request("hello", { protocol: PROTOCOL_VERSION, token, peer: {
          id: "tcp-probe", name: "tcp-probe", agent: "other", cwd: env.home, pid: process.pid,
          agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false,
        } });
        expect(Array.isArray(hello.peers)).toBe(true);
        const second = await BridgeClient.connect(join(env.home, "no-such-pipe"), nullLogger, 5_000);
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
      expect(JSON.parse(readFileSync(portFile, "utf8")).port).toBe(port);
    } finally {
      await broker.close();
    }
    expect(existsSync(join(env.home, BROKER_TCP_FILE))).toBe(false);
    env.cleanup();
  });
});


