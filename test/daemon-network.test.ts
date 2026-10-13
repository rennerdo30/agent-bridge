import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { EndpointReservation } from "../src/core/endpoint-reservation.js";
import { BridgeClient } from "../src/core/client.js";
import { MessageStore } from "../src/core/store.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { NetworkService } from "../src/network/link.js";
import { NetworkDiscovery } from "../src/network/discovery.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv, reservation: EndpointReservation, broker: Broker, store: MessageStore, remote: NetworkService | undefined;
let token: string;
const host = "127.0.0.1";
const cfg = () => ({ ...DEFAULT_NETWORK_CONFIG, enabled: true, name: "owned-fixture", bind: host, port: 0, discovery: true });
beforeEach(async () => {
  env = makeEnv(); token = loadOrCreateToken(env.home); reservation = await EndpointReservation.bind(env.pipe); store = new MessageStore(env.db, nullLogger);
  broker = new Broker(env.pipe, store, nullLogger, token, Date.now, undefined, { home: env.home, config: cfg() });
});
afterEach(async () => { vi.restoreAllMocks(); await remote?.close(); remote = undefined; await broker.close(); await reservation.close(); await env.cleanup(); });
async function delayedStartup() {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  // Hold the startup completion boundary; actual TLS/PSK, Link and broker paths
  // remain real. No multicast traffic is needed for this admission proof.
  vi.spyOn(NetworkDiscovery.prototype, "start").mockImplementation(async () => { entered(); await gate; });
  const listening = broker.listen(reservation); await started;
  return { listening, release, network: Reflect.get(broker, "network") as NetworkService };
}
async function remoteService() {
  const peer: PeerInfo = { id: randomUUID(), name: "remote-peer", agent: "codex", pid: process.pid, agentPid: null,
    cwd: env.home, sessionId: "fixture-remote", startedAt: 1, autoWake: false };
  remote = new NetworkService(join(env.home, "remote"), { ...cfg(), name: "remote-fixture", discovery: false },
    { peers: () => [peer], receive: () => ({ delivered: true }) }, nullLogger);
  await remote.start(); return { remote, peer };
}
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("tentative network authority during owned daemon initialization", () => {
  it("real paired TLS cannot look up keys, construct links or mutate state before ready, then the same key/config delivers", async () => {
    const { listening, release, network } = await delayedStartup(), { remote, peer } = await remoteService();
    const code = network.keys.invite(), file = join(env.home, "network", "keys.json"), before = digest(file);
    const lookup = vi.spyOn(network.keys, "keyFor"), accept = vi.spyOn(network.keys, "accept"), receive = vi.spyOn(broker as unknown as { receiveRemote(...args: unknown[]): unknown }, "receiveRemote");
    try {
      expect(network.status().ready).toBe(false); expect(Reflect.get(network, "timer")).toBeNull();
      await expect(remote.link(code, host, network.port)).rejects.toThrow();
      expect(lookup).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled(); expect(receive).not.toHaveBeenCalled();
      expect(network.peers()).toEqual([]); expect(network.status().paired).toEqual([]); expect(digest(file)).toBe(before);
      await expect(network.link(remote.keys.invite(), host, remote.port)).rejects.toThrow("network startup is not ready");
      expect(Reflect.get(network, "connecting").size).toBe(0); expect(Reflect.get(network, "timer")).toBeNull();
      const local = await BridgeClient.connect(env.pipe, nullLogger);
      try { await expect(local.request("auth", { protocol: PROTOCOL_VERSION, token })).rejects.toMatchObject({ code: "internal" }); }
      finally { local.close(); }
    } finally { release(); }
    await listening; expect(network.status().ready).toBe(true);
    const localNode = env.node("local-peer"); await localNode.start();
    await remote.link(code, host, network.port); expect(lookup).toHaveBeenCalled(); expect(accept).toHaveBeenCalled();
    const id = randomUUID();
    expect(await remote.send({ id, from: { id: peer.id, name: peer.name, agent: peer.agent }, to: "owned-fixture/local-peer", recipient: "owned-fixture/local-peer",
      conversationId: randomUUID(), replyTo: null, hop: 0, body: "Actual authenticated fixture delivery", createdAt: Date.now(), readAt: null })).toMatchObject({ storage: { id, state: "stored" } });
    await until(() => store.unread("local-peer", 100).some(message => message.id === id));
    expect(store.unread("local-peer", 100).filter(message => message.id === id)).toHaveLength(1);
  });
  it("reconfiguration while tentative refuses before any config write or replacement listener", async () => {
    const { listening, release, network } = await delayedStartup();
    const configure = Reflect.get(broker, "configureNetwork").bind(broker);
    try { await expect(configure({ ...cfg(), discovery: false })).rejects.toMatchObject({ code: "bad_request" }); expect(Reflect.get(broker, "network")).toBe(network); expect(network.status().ready).toBe(false); }
    finally { release(); }
    await listening; expect(network.status().ready).toBe(true);
  });
  it("failed activation inhibits authority before asynchronous cleanup and releases only owned listeners", async () => {
    const { listening, release, network } = await delayedStartup(), { remote } = await remoteService();
    const code = network.keys.invite(), lookup = vi.spyOn(network.keys, "keyFor");
    const port = network.port;
    vi.spyOn(network, "activateAuthority").mockImplementation(() => { throw new Error("fixture activation failure"); });
    release(); await expect(listening).rejects.toThrow("fixture activation failure");
    expect(network.status().ready).toBe(false); expect(Reflect.get(network, "timer")).toBeNull(); expect(network.peers()).toEqual([]);
    await expect(remote.link(code, host, port)).rejects.toThrow(); expect(lookup).not.toHaveBeenCalled();
    await expect(BridgeClient.connect(env.pipe, nullLogger)).rejects.toHaveProperty("code");
  });
});
