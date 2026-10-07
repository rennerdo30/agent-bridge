import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connect as tlsConnect } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeNode } from "../src/core/node.js";
import type { BridgeMessage, PeerInfo } from "../src/core/protocol.js";
import { MessageStore } from "../src/core/store.js";
import { en } from "../src/core/messages.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { DISCOVERY_TTL_MS, NETWORK_REFRESH_MS, NETWORK_TIMEOUT_MS, NETWORK_VERSION, TLS_CIPHER } from "../src/network/constants.js";
import { NetworkService } from "../src/network/link.js";
import { decodePairingCode, keyFingerprint } from "../src/network/pairing.js";
import { formatDelivery } from "../src/mcp/format.js";
import { RewakeEndpoint, sessionFile, shouldWakeClaudeMessage } from "../src/mcp/rewake.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

const TOKEN = "reconnect-test-token";
let env: TestEnv;
let cleanup: (() => void | Promise<void>)[];
beforeEach(() => { env = makeEnv(); cleanup = []; });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.reverse()) await close();
  await env.cleanup();
});

function registration(name = "session", changes: Partial<PeerInfo> = {}): PeerInfo {
  return { id: randomUUID(), name, agent: "claude", cwd: env.home, pid: 111,
    agentPid: 222, agentStartedAt: "cli-created", sessionId: null, startedAt: Date.now(),
    autoWake: false, activity: "idle", ...changes };
}

async function broker(target = env, networkName?: string) {
  const b = new Broker(target.pipe, new MessageStore(target.db, nullLogger), nullLogger, TOKEN, Date.now, undefined,
    networkName ? { home: target.home, config: { ...DEFAULT_NETWORK_CONFIG, enabled: true, name: networkName, bind: "127.0.0.1", port: 0, discovery: false } } : undefined);
  await b.listen();
  cleanup.push(() => b.close());
  return b;
}

async function connect(peer: PeerInfo, target = env) {
  const client = await BridgeClient.connect(target.pipe, nullLogger);
  cleanup.push(() => client.close());
  const messages: BridgeMessage[] = [];
  client.on("event", (event, data) => { if (event === "message") messages.push(data as BridgeMessage); });
  const hello = await client.request("hello", { protocol: PROTOCOL_VERSION, token: TOKEN, peer });
  return { client, hello, messages };
}

describe("remote reconnect identity and reachability (AB-104)", () => {
  it("replaces overlapping servers of the same CLI before any hook learns a session id", async () => {
    await broker();
    const old = await connect(registration());
    const fresh = await connect(registration("session", { pid: 333 }));
    expect(fresh.hello.name).toBe("session");
    await until(() => old.client.isClosed);
    expect((await fresh.client.request("peers", {})).map((p) => p.name)).toEqual(["session"]);
    const distinct = await connect(registration("session", { agentStartedAt: "different-cli", pid: 444 }));
    expect(distinct.hello.name).toBe("session-2");
    expect(fresh.client.isClosed).toBe(false);
  });

  it("reclaims the original name and queued mail after disconnect and broker restart", async () => {
    const first = await broker();
    const closeFirst = cleanup[0]!;
    const old = await connect(registration("session", { sessionId: "chat" }));
    await old.client.request("updatePeer", { name: "session-2" });
    old.client.close();
    await until(() => old.client.isClosed);
    const sender = await connect(registration("sender", { agentPid: 999 }));
    const sent = await sender.client.request("send", { to: "session", body: "queued before reconnect" });
    expect(sent.queuedFor).toEqual(["session"]);
    await first.close();
    cleanup.splice(cleanup.indexOf(closeFirst), 1);
    await broker();
    const fresh = await connect(registration("session-2", { pid: 555 }));
    expect(fresh.hello).toMatchObject({ name: "session", sessionId: "chat" });
    await until(() => fresh.messages.some((m) => m.id === sent.messages[0]!.id));
    const pending = await fresh.client.request("pending", {});
    expect(pending.filter((message) => message.id === sent.messages[0]!.id)).toMatchObject([{ body: "queued before reconnect" }]);
    expect(pending).toContainEqual(expect.objectContaining({ from: expect.objectContaining({ id: "bridge-project-routing" }) }));
  });

  it("backs up v5 bindings and messages before migrating retained names", () => {
    const store = new MessageStore(env.db, nullLogger);
    store.rememberSession(registration("session", { sessionId: "chat" }), 1);
    store.insert({ id: "keep", recipient: "session", from: { id: "sender", name: "sender", agent: "claude" },
      to: "session", conversationId: "chat", replyTo: null, hop: 0, body: "original user data", createdAt: 1, readAt: null });
    store.close();
    const legacy = new DatabaseSync(env.db);
    legacy.exec("DROP TABLE peer_names; DROP TABLE peer_name_owners; PRAGMA user_version=5;"); legacy.close();
    const upgraded = new MessageStore(env.db, nullLogger);
    try {
      expect(upgraded.namesFor(registration("session-2"))).toEqual(["session"]);
      expect(upgraded.byId("keep")?.body).toBe("original user data");
      const path = readdirSync(env.home).find((name) => name.startsWith("bridge.db.backup-"))!;
      const backup = new DatabaseSync(join(env.home, path), { readOnly: true });
      try {
        expect(backup.prepare("PRAGMA user_version").get()!.user_version).toBe(5);
        expect(backup.prepare("SELECT body FROM messages").get()!.body).toBe("original user data");
        expect(backup.prepare("SELECT session_id FROM session_bindings").get()!.session_id).toBe("chat");
      } finally { backup.close(); }
    } finally { upgraded.close(); }
  });

  it("reclaims a disconnected name when hook identity arrives after registration", async () => {
    await broker();
    const old = await connect(registration("session", { sessionId: "chat", agentStartedAt: null }));
    old.client.close(); await until(() => old.client.isClosed);
    const sender = await connect(registration("sender", { agentPid: 999 }));
    const sent = await sender.client.request("send", { to: "session", body: "waiting for hook identity" });
    const fresh = await connect(registration("session-2", { agentPid: 333 }));
    expect(fresh.hello).toMatchObject({ name: "session-2", sessionId: null });
    expect(await fresh.client.request("updatePeer", { sessionId: "chat" })).toMatchObject({ name: "session" });
    await until(() => fresh.messages.some((m) => m.id === sent.messages[0]!.id));
  });

  it("does not invent an alias from ambiguous v5 registrations of the same folder", () => {
    const store = new MessageStore(env.db, nullLogger);
    store.rememberSession(registration("session", { sessionId: "one" }), 1);
    store.rememberSession(registration("session-2", { agentPid: 333, sessionId: "two" }), 2);
    store.close();
    const legacy = new DatabaseSync(env.db);
    legacy.exec("DROP TABLE peer_names; DROP TABLE peer_name_owners; PRAGMA user_version=5;"); legacy.close();
    const upgraded = new MessageStore(env.db, nullLogger);
    try {
      expect(upgraded.namesFor(registration("session", { sessionId: "one" }))).toEqual([]);
      expect(upgraded.recoverSession(registration("session"))).toBe("one");
      expect(upgraded.recoverSession(registration("session-2", { agentPid: 333 }))).toBe("two");
    } finally { upgraded.close(); }
  });

  it("keeps an idle remote session advertised and wakes queued and redirected mail", async () => {
    const remoteEnv = makeEnv();
    cleanup.push(() => remoteEnv.cleanup());
    await broker(env, "windows"); await broker(remoteEnv, "mac");
    const sender = await connect(registration("sender", { agentPid: 999 }));
    const node = (name: string) => {
      const n = new BridgeNode({ pipePath: remoteEnv.pipe, dbPath: remoteEnv.db, token: TOKEN,
        agent: "claude", name, cwd: remoteEnv.home, autoWake: false, log: nullLogger, canHostBroker: false });
      cleanup.push(() => n.stop()); return n;
    };
    const old = node("session"); await old.start(); await old.setSessionId("chat");
    await old.relocate(remoteEnv.home, "session-3");
    await old.relocate(remoteEnv.home, "session-4"); await old.stop();
    const remoteAdmin = await connect(registration("admin", { agentPid: 998, cwd: remoteEnv.home }), remoteEnv);
    const status = await remoteAdmin.client.request("networkStatus", {});
    await sender.client.request("networkLink", { code: (await remoteAdmin.client.request("networkPair", {})).code, host: "127.0.0.1", port: status.port! });
    const queued = await sender.client.request("send", { to: "mac/session-4", body: "wake after reconnect" });
    expect(queued.queuedFor).toEqual(["mac/session-4"]);
    const holder = await connect(registration("session", { agentPid: 777, cwd: remoteEnv.home }), remoteEnv);
    const fresh = node("session"); await fresh.start();
    expect(fresh.name).toBe("session-3");
    expect(fresh.currentSessionId).toBe("chat");
    fresh.setActivity("idle"); await fresh.setWakePolicy(true, true);
    const wake = new RewakeEndpoint(remoteEnv.home, fresh, (m) => shouldWakeClaudeMessage(fresh, DEFAULT_CONFIG, m), nullLogger);
    await wake.start(); wake.register("chat"); cleanup.push(() => wake.stop());
    const endpoint = JSON.parse(readFileSync(sessionFile(remoteEnv.home, "chat"), "utf8"));
    const wait = () => fetch(`http://127.0.0.1:${endpoint.port}/wait`, { headers: { authorization: `Bearer ${endpoint.secret}` }, signal: AbortSignal.timeout(10_000) }).then((r) => r.json());
    expect((await wait()).text).toContain("wake after reconnect");
    fresh.markRead([queued.messages[0]!.id]);
    await until(() => fresh.hasSeen(queued.messages[0]!.id));
    let receipt: number | null = null;
    for (let i = 0; i < 30 && receipt === null; i++) {
      receipt = (await sender.client.request("messageReceipt", { id: queued.messages[0]!.id }))[0]!.readAt;
      if (receipt === null) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(receipt).toBeTypeOf("number");
    const held = await sender.client.request("send", { to: "mac/session", body: "for different live CLI" });
    expect(held.deliveredTo).toEqual(["mac/session"]);
    await until(() => holder.messages.some((m) => m.body === "for different live CLI"));
    holder.client.close(); await until(() => holder.client.isClosed);
    // Wall-clock age exceeds both discovery expiry and request timeout; real intervals still run.
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + DISCOVERY_TTL_MS + NETWORK_TIMEOUT_MS + 60_000);
    await new Promise((resolve) => setTimeout(resolve, NETWORK_REFRESH_MS * 3));
    const peers = await sender.client.request("peers", {});
    expect(peers.find((p) => p.name === "mac/session-3")).toMatchObject({ activity: "idle", wakeAvailable: true });
    fresh.setActivity("busy"); fresh.setActivity("idle");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fresh.unread().some((m) => m.body === "for different live CLI")).toBe(false);
    expect((await sender.client.request("send", { to: "mac/session", body: "for disconnected name owner" })).queuedFor).toEqual(["mac/session"]);
    const waking = wait();
    const redirected = await sender.client.request("send", { to: "mac/session-4", body: "wake retained alias" });
    expect(redirected.deliveredTo).toEqual(["mac/session-3"]);
    expect(formatDelivery(redirected).join("\n")).toContain("wake requested on the receiving PC");
    expect((await waking).text).toContain("wake retained alias");
  });

  it("describes a disconnected recipient without claiming the CLI is closed", () => {
    expect(en["send.queued"]).toContain("not connected right now");
    expect(en["send.queued"]).toContain("does not prove the session is closed");
    expect(en["send.queued"]).toContain("wake policy and hook permit");
  });

  it("detects an unresponsive authenticated link without waiting for a user message", async () => {
    const timings = { refreshMs: 50, heartbeatTimeoutMs: 250 };
    const network = new NetworkService(env.home, { ...DEFAULT_NETWORK_CONFIG, enabled: true,
      name: "windows", bind: "127.0.0.1", port: 0, discovery: false }, { peers: () => [], receive: () => ({ delivered: true }) }, nullLogger, timings);
    await network.start(); cleanup.push(() => network.close());
    const code = decodePairingCode(network.keys.invite());
    const socket = tlsConnect({ host: "127.0.0.1", port: network.port, minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
      ciphers: TLS_CIPHER, rejectUnauthorized: false, checkServerIdentity: () => undefined,
      pskCallback: () => ({ identity: keyFingerprint(code.key), psk: Buffer.from(code.key, "hex") }) });
    cleanup.push(() => { socket.destroy(); });
    socket.on("error", () => {});
    let echoes = 0, buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        if (JSON.parse(buffer.slice(0, nl)).type === "echo") echoes++;
        buffer = buffer.slice(nl + 1);
      }
    });
    await new Promise<void>((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", reject); });
    socket.write(JSON.stringify({ type: "hello", v: NETWORK_VERSION, id: randomUUID(), name: "mac",
      fingerprint: "a".repeat(64), echo: true, peers: [registration()] }) + "\n");
    await until(() => network.status().paired[0]?.connected === true);
    expect(network.peers()).toHaveLength(1);
    await until(() => echoes > 0);
    await until(() => network.status().paired[0]?.connected === false);
    expect(network.peers()).toEqual([]);
    expect(echoes).toBe(1); // bounded to one in-flight heartbeat
  });
});
