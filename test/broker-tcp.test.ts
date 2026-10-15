import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { brokerTcpPort, brokerTcpPortAsync, BROKER_TCP_FILE, isEphemeralBrokerTcpRecord } from "../src/core/paths.js";
import { readMusePrivateJson, readMusePrivateJsonAsync, writeMusePrivateJson, writeMusePrivateJsonAsync } from "../src/core/muse-context.js";
import { processIdentity, readProcessIdentity } from "../src/core/process-identity.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, until } from "./helpers.js";

vi.mock("node:net", async original => { const actual = await original<typeof import("node:net")>(); return { ...actual, connect: vi.fn(actual.connect) }; });
vi.mock("../src/core/muse-context.js", async original => { const actual = await original<typeof import("../src/core/muse-context.js")>(); return { ...actual, readMusePrivateJsonAsync: vi.fn(actual.readMusePrivateJsonAsync), writeMusePrivateJsonAsync: vi.fn(actual.writeMusePrivateJsonAsync) }; });
vi.mock("../src/core/process-identity.js", async original => { const actual = await original<typeof import("../src/core/process-identity.js")>(); return { ...actual, readProcessIdentity: vi.fn(actual.readProcessIdentity) }; });

afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  vi.mocked(connect).mockReset(); vi.mocked(readMusePrivateJsonAsync).mockReset(); vi.mocked(writeMusePrivateJsonAsync).mockReset(); vi.mocked(readProcessIdentity).mockReset();
});

function inaccessiblePipe(): Socket {
  const socket = new Socket();
  queueMicrotask(() => socket.emit("error", Object.assign(new Error("fixture inaccessible pipe"), { code: "EACCES" })));
  return socket;
}

describe("broker loopback fallback", () => {
  it.runIf(process.platform === "win32")("does not overwrite unknown durable discovery content when starting", async () => {
    const env = makeEnv(), file = join(env.home, BROKER_TCP_FILE);
    writeMusePrivateJson(file, { userHistory: "unique retained history" });
    const before = readFileSync(file);
    const broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, loadOrCreateToken(env.home));
    try { await broker.listen(); expect(readFileSync(file)).toEqual(before); }
    finally { await broker.close(); expect(readFileSync(file)).toEqual(before); await env.cleanup(); }
  });
  it.runIf(process.platform === "win32")("refuses to overwrite a discovery record it could not read", async () => {
    const env = makeEnv(), file = join(env.home, BROKER_TCP_FILE);
    // A well-formed ephemeral record: only the failed read, not the content, can make the broker keep it.
    writeMusePrivateJson(file, { port: 4321, pid: 2147483646, identity: "fixture-generation", nonce: "fixture", protocol: PROTOCOL_VERSION, pipePath: env.pipe });
    const before = readFileSync(file);
    vi.mocked(readMusePrivateJsonAsync).mockRejectedValueOnce(new Error("fixture: protected record unreadable"));
    const broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, loadOrCreateToken(env.home));
    try {
      await broker.listen();
      expect(readMusePrivateJsonAsync).toHaveBeenCalledOnce();
      expect(writeMusePrivateJsonAsync).not.toHaveBeenCalled();
      expect(readFileSync(file)).toEqual(before);
    } finally { await broker.close(); expect(readFileSync(file)).toEqual(before); await env.cleanup(); }
  });
  it.runIf(process.platform === "win32")("retains discovery content that appears while its own record is being written", async () => {
    const env = makeEnv(), file = join(env.home, BROKER_TCP_FILE);
    const actual = (await vi.importActual<typeof import("../src/core/muse-context.js")>("../src/core/muse-context.js")).writeMusePrivateJsonAsync;
    vi.mocked(writeMusePrivateJsonAsync).mockImplementationOnce(async (path, value, flag) => {
      await actual(path, value, flag);
      writeMusePrivateJson(file, { userHistory: "appeared during publication" });
    });
    const broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, loadOrCreateToken(env.home));
    try {
      await broker.listen();
      expect(writeMusePrivateJsonAsync).toHaveBeenCalledOnce();
      expect(readMusePrivateJson(file)).toEqual({ userHistory: "appeared during publication" });
      expect(readdirSync(env.home).filter(name => name.endsWith(".tmp"))).toEqual([]);
    } finally { await broker.close(); expect(readMusePrivateJson(file)).toEqual({ userHistory: "appeared during publication" }); await env.cleanup(); }
  });
  it("parses only an authenticated recorded port synchronously and asynchronously", async () => {
    const env = makeEnv();
    const portAsync = (pipe = env.pipe) => brokerTcpPortAsync(env.home, pipe, new AbortController().signal);
    expect(brokerTcpPort(env.home, env.pipe)).toBeNull();
    expect(await portAsync()).toBeNull();
    const record = { port: 4321, pid: process.pid, identity: processIdentity(process.pid), nonce: "fixture", protocol: PROTOCOL_VERSION, pipePath: env.pipe };
    writeMusePrivateJson(join(env.home, BROKER_TCP_FILE), record);
    expect(brokerTcpPort(env.home, env.pipe)).toBe(4321);
    expect(await portAsync()).toBe(4321);
    expect(isEphemeralBrokerTcpRecord(record)).toBe(true);
    expect(isEphemeralBrokerTcpRecord({ ...record, userHistory: "unique durable data" })).toBe(false);
    expect(brokerTcpPort(env.home, "foreign-pipe")).toBeNull();
    expect(await portAsync("foreign-pipe")).toBeNull();
    writeMusePrivateJson(join(env.home, BROKER_TCP_FILE), { ...record, identity: "reused-pid" }, "w");
    expect(brokerTcpPort(env.home, env.pipe)).toBeNull();
    expect(await portAsync()).toBeNull();
    writeMusePrivateJson(join(env.home, BROKER_TCP_FILE), { ...record, port: "4321" }, "w");
    expect(brokerTcpPort(env.home, env.pipe)).toBeNull();
    expect(await portAsync()).toBeNull();
    writeFileSync(join(env.home, BROKER_TCP_FILE), "not json");
    expect(brokerTcpPort(env.home, env.pipe)).toBeNull();
    expect(await portAsync()).toBeNull();
    await env.cleanup();
  });

  it.runIf(process.platform === "win32")("bounds slow discovery without blocking timers or a working pipe's direct promise", async () => {
    const env = makeEnv(), failedPipe = new Socket(), workingPipe = new Socket();
    vi.stubEnv("AGENT_BRIDGE_HOME", env.home);
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.mocked(readMusePrivateJsonAsync).mockImplementationOnce(async (_path, abort) => {
      signal = abort;
      return new Promise((_resolve, reject) => abort!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    vi.mocked(connect).mockReturnValueOnce(failedPipe).mockReturnValueOnce(workingPipe);
    let client: BridgeClient | undefined;
    try {
      const pending = BridgeClient.connect(env.pipe, nullLogger, 100);
      const rejected = expect(pending).rejects.toMatchObject({ code: "ETIMEDOUT" });
      failedPipe.emit("error", new Error("inaccessible"));
      expect(signal?.aborted).toBe(false);
      const ready = vi.fn();
      const healthy = BridgeClient.connect(env.pipe, nullLogger, 100);
      healthy.then(ready);
      workingPipe.emit("connect");
      // One Promise reaction, just as main; no catch/async propagation on success.
      await Promise.resolve();
      expect(ready).toHaveBeenCalledTimes(1);
      client = await healthy;
      const unrelated = vi.fn(); setTimeout(unrelated, 5);
      await vi.advanceTimersByTimeAsync(10);
      expect(unrelated).toHaveBeenCalledTimes(1);
      expect(vi.mocked(readMusePrivateJsonAsync)).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(90);
      await rejected;
      expect(signal?.aborted).toBe(true);
      expect(connect).toHaveBeenCalledTimes(2); // No late TCP attempt.
    } finally { client?.close(); failedPipe.destroy(); workingPipe.destroy(); vi.useRealTimers(); await env.cleanup(); }
  });

  it.runIf(process.platform === "win32")("gives TCP only the original deadline remaining after authenticated discovery", async () => {
    const env = makeEnv(), pipe = new Socket(), tcp = new Socket();
    vi.stubEnv("AGENT_BRIDGE_HOME", env.home);
    vi.useFakeTimers();
    vi.mocked(connect).mockReturnValueOnce(pipe).mockReturnValueOnce(tcp);
    vi.mocked(readMusePrivateJsonAsync).mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      return { port: 4321, pid: process.pid, identity: "broker-generation", nonce: "fixture", protocol: PROTOCOL_VERSION, pipePath: env.pipe };
    });
    vi.mocked(readProcessIdentity).mockResolvedValueOnce("broker-generation");
    try {
      const pending = BridgeClient.connect(env.pipe, nullLogger, 100);
      const rejected = expect(pending).rejects.toMatchObject({ code: "ETIMEDOUT" });
      pipe.emit("error", new Error("inaccessible"));
      await vi.advanceTimersByTimeAsync(60);
      expect(connect).toHaveBeenLastCalledWith(4321, "127.0.0.1");
      expect(tcp.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(40);
      await rejected;
      expect(tcp.destroyed).toBe(true);
    } finally { pipe.destroy(); tcp.destroy(); vi.useRealTimers(); await env.cleanup(); }
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
        vi.mocked(connect).mockImplementationOnce(inaccessiblePipe);
        const client = await BridgeClient.connect(env.pipe, nullLogger, 5_000);
        const hello = await client.request("hello", { protocol: PROTOCOL_VERSION, token, peer: {
          id: "tcp-probe", name: "tcp-probe", agent: "other", cwd: env.home, pid: process.pid,
          agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false,
        } });
        expect(Array.isArray(hello.peers)).toBe(true);
        vi.mocked(connect).mockImplementationOnce(inaccessiblePipe);
        const second = await BridgeClient.connect(env.pipe, nullLogger, 5_000);
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


