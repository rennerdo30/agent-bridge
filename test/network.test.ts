import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { loadConfig } from "../src/core/config.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeNode } from "../src/core/node.js";
import { resolvePipePath } from "../src/core/paths.js";
import type { BridgeMessage, PeerInfo } from "../src/core/protocol.js";
import { MessageStore } from "../src/core/store.js";
import { parseNetworkAddress } from "../src/network/cli.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { DISCOVERY_TTL_MS, MAX_DISCOVERY_BYTES, MAX_NETWORK_FRAME_BYTES, NETWORK_VERSION, PAIRING_TTL_MS, TLS_CIPHER } from "../src/network/constants.js";
import { NetworkDiscovery } from "../src/network/discovery.js";
import { NetworkService } from "../src/network/link.js";
import { decodePairingCode, keyFingerprint, PairingStore } from "../src/network/pairing.js";
import { collectTransfer, MAX_TRANSFER_BYTES, receiveTransfer, safeTransferPath } from "../src/network/files.js";
import { until } from "./helpers.js";

const LOOPBACK = "127.0.0.1";
const TOKEN = "network-test-token";
let home: string;
let cleanup: (() => void | Promise<void>)[];
beforeEach(() => {
  const root = join(process.cwd(), ".agent-bridge-test");
  mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "network-"));
  cleanup = [];
});
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const peer = (name: string, jobAgent?: "codex"): PeerInfo => ({ id: randomUUID(), name, agent: "claude", cwd: home, pid: process.pid, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false, ...(jobAgent ? { jobAgent } : {}) });
function service(name: string, peers: PeerInfo[] = [], received: BridgeMessage[] = []): NetworkService {
  const network = new NetworkService(join(home, name), { ...DEFAULT_NETWORK_CONFIG, enabled: true, name, bind: LOOPBACK, port: 0, discovery: false }, { peers: () => peers, receive: (m) => { received.push(m); return { delivered: true }; } }, nullLogger);
  cleanup.push(() => network.close());
  return network;
}

describe("network pairing", () => {
  it("is off by default and rejects malformed configuration", () => {
    expect(loadConfig(home, "other", nullLogger, {}).network.enabled).toBe(false);
    writeFileSync(join(home, "config.json"), JSON.stringify({ network: { enabled: true, port: -1 } }));
    expect(loadConfig(home, "other", nullLogger, {}).network.enabled).toBe(false);
  });

  it.skipIf(process.platform !== "win32")("removes explicit grants the key folder already had (as on CI runners)", () => {
    const dir = join(home, "network");
    mkdirSync(dir, { recursive: true });
    // Everyone (S-1-1-0) with read access, as an explicit grant like those on a runner's temp folder.
    execFileSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe"), [dir, "/grant", "*S-1-1-0:(OI)(CI)R", "/Q"], { stdio: "pipe" });
    expect(() => new PairingStore(home, "office-pc")).not.toThrow();
    const acl = execFileSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe"), [dir], { encoding: "utf8" });
    expect((acl.match(/:\(/g) ?? []).length).toBe(1);
  });

  it("stores owner-only secrets, persists identity, expires and consumes invitations", () => {
    let now = Date.now();
    const store = new PairingStore(home, "windows", () => now);
    const original = store.identity;
    const code = decodePairingCode(store.invite());
    expect(new PairingStore(home, "windows").identity).toEqual(original);
    expect(readFileSync(join(home, "network", "keys.json"), "utf8")).toContain(code.key);
    if (process.platform !== "win32") expect(statSync(join(home, "network", "keys.json")).mode & 0o777).toBe(0o600);
    else {
      const acl = execFileSync("icacls.exe", [join(home, "network", "keys.json")], { encoding: "utf8", windowsHide: true });
      expect(acl.match(/:\(/g)).toHaveLength(1);
      expect(acl).not.toContain("(I)");
    }
    now += PAIRING_TTL_MS;
    expect(() => store.accept(code.key, { id: randomUUID(), name: "mac", fingerprint: "a".repeat(64) })).toThrow(/expired/);
    const fresh = decodePairingCode(store.invite());
    const remote = { id: randomUUID(), name: "mac", fingerprint: "b".repeat(64) };
    store.accept(fresh.key, remote);
    expect(() => store.accept(fresh.key, { ...remote, id: randomUUID() })).toThrow(/identity changed/);
    store.remove(remote.id);
    expect(() => store.accept(fresh.key, remote)).toThrow(/revoked/);
    expect(() => decodePairingCode("1234")).toThrow();
  });

  it("authenticates TLS-PSK, namespaces peers, routes both directions and removes revoked links", async () => {
    const aPeer = peer("claude-app");
    const bPeer = peer("codex-app", "codex");
    const aReceived: BridgeMessage[] = [];
    const bReceived: BridgeMessage[] = [];
    const a = service("windows", [aPeer], aReceived);
    const b = service("mac", [bPeer], bReceived);
    await a.start();
    await b.start();
    await a.link(b.keys.invite(), LOOPBACK, b.port);
    expect(a.peers()[0]?.name).toBe("mac/codex-app");
    expect(a.peers()[0]?.jobAgent).toBe("codex");
    expect(a.status().paired[0]).toMatchObject({ name: "mac", connected: true });
    expect(JSON.stringify(a.status())).not.toContain('"key"');
    const message: BridgeMessage = { id: randomUUID(), from: { id: aPeer.id, name: aPeer.name, agent: aPeer.agent }, to: "mac/codex-app", recipient: "mac/codex-app", conversationId: randomUUID(), replyTo: null, hop: 0, body: "contract request", createdAt: Date.now(), readAt: null };
    expect(await a.send(message)).toMatchObject({ deliveredTo: ["mac/codex-app"] });
    expect(bReceived[0]).toMatchObject({ from: { name: "windows/claude-app" }, recipient: "codex-app", body: "contract request" });
    await b.send({ ...message, id: randomUUID(), from: { id: bPeer.id, name: bPeer.name, agent: "codex" }, recipient: "windows/claude-app", to: "windows/claude-app", replyTo: message.id, hop: 1, body: "contract reply" });
    expect(aReceived[0]).toMatchObject({ from: { name: "mac/codex-app", agent: "codex" }, replyTo: message.id, hop: 1 });
    a.unlink(b.keys.identity.id);
    await until(() => b.peers().length === 0);
    await expect(a.send(message)).rejects.toMatchObject({ code: "unknown_target" });
  });

  it("rejects a wrong key and wrong identity without persisting trust", async () => {
    const a = service("windows");
    const b = service("mac");
    await a.start();
    await b.start();
    const code = decodePairingCode(b.keys.invite());
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    await expect(a.link(encode({ ...code, key: "f".repeat(64) }), LOOPBACK, b.port)).rejects.toThrow();
    await expect(a.link(encode({ ...code, fingerprint: "f".repeat(64) }), LOOPBACK, b.port)).rejects.toThrow(/identity changed/);
    expect(a.status().paired).toEqual([]);
    expect(a.peers()).toEqual([]);
  });

  it("exchanges TLS ciphertext through a loopback proxy, never plaintext messages", async () => {
    const aPeer = peer("claude-app");
    const a = service("windows", [aPeer]);
    const b = service("mac");
    await a.start();
    await b.start();
    const traffic: Buffer[] = [];
    const sockets: Socket[] = [];
    const proxy = createServer((incoming) => {
      const outgoing = connect(b.port, LOOPBACK);
      sockets.push(incoming, outgoing);
      for (const socket of [incoming, outgoing]) { socket.on("error", () => {}); socket.on("data", (data: Buffer) => traffic.push(data)); }
      incoming.pipe(outgoing); outgoing.pipe(incoming);
      incoming.on("close", () => outgoing.destroy()); outgoing.on("close", () => incoming.destroy());
    });
    cleanup.push(async () => { sockets.forEach((s) => s.destroy()); await new Promise<void>((r) => proxy.close(() => r())); });
    await new Promise<void>((r) => proxy.listen(0, LOOPBACK, r));
    const address = proxy.address();
    await a.link(b.keys.invite(), LOOPBACK, typeof address === "object" && address ? address.port : 0);
    const body = "secret-contract-never-on-wire-7390";
    await a.send({ id: randomUUID(), from: { id: aPeer.id, name: aPeer.name, agent: aPeer.agent }, recipient: "mac/later", to: "mac/later", conversationId: randomUUID(), replyTo: null, hop: 0, body, createdAt: Date.now(), readAt: null });
    expect(Buffer.concat(traffic).includes(Buffer.from(body))).toBe(false);
    expect(Buffer.concat(traffic).includes(Buffer.from('"type":"hello"'))).toBe(false);
  });

  it("parses explicit addresses and rejects credentials and paths", () => {
    expect(parseNetworkAddress("127.0.0.1:1234")).toEqual({ host: LOOPBACK, port: 1234 });
    expect(() => parseNetworkAddress("user@localhost:1234")).toThrow();
    expect(() => parseNetworkAddress("localhost:1234/path")).toThrow();
  });

  it("reconnects only stored paired endpoints after a remote broker restart", async () => {
    const a = service("windows", [peer("claude-app")]);
    const peers = [peer("codex-app")];
    const b = service("mac", peers);
    await a.start(); await b.start();
    const port = b.port;
    await a.link(b.keys.invite(), LOOPBACK, port);
    const identity = b.keys.identity;
    await b.close();
    await until(() => a.peers().length === 0);
    const restarted = new NetworkService(join(home, "mac"), { ...DEFAULT_NETWORK_CONFIG, enabled: true, name: "mac", bind: LOOPBACK, port, discovery: false }, { peers: () => peers, receive: () => ({ delivered: true }) }, nullLogger);
    cleanup.push(() => restarted.close());
    await restarted.start();
    await until(() => a.peers().length === 1);
    expect(restarted.keys.identity).toEqual(identity);
    expect(a.status().paired[0]?.connected).toBe(true);
  });

  it("rejects plaintext endpoints and refuses messages from an unadvertised sender", async () => {
    const a = service("windows");
    const b = service("mac");
    await a.start(); await b.start();
    const sockets: Socket[] = [];
    const plaintext = createServer((socket) => { sockets.push(socket); socket.end("plaintext bridge\n"); });
    cleanup.push(async () => { sockets.forEach((s) => s.destroy()); await new Promise<void>((r) => plaintext.close(() => r())); });
    await new Promise<void>((r) => plaintext.listen(0, LOOPBACK, r));
    const address = plaintext.address();
    await expect(a.link(b.keys.invite(), LOOPBACK, typeof address === "object" && address ? address.port : 0)).rejects.toThrow();
    expect(a.status().paired).toEqual([]);
    await a.link(b.keys.invite(), LOOPBACK, b.port);
    const sender = peer("invented-peer");
    await expect(a.send({ id: randomUUID(), from: { id: sender.id, name: sender.name, agent: sender.agent }, recipient: "mac/later", to: "mac/later", conversationId: randomUUID(), replyTo: null, hop: 0, body: "spoofed", createdAt: Date.now(), readAt: null })).rejects.toThrow(/not advertised/);
  });

  it("drops encrypted records before hello and oversized frames", async () => {
    const network = service("mac");
    await network.start();
    for (const data of [JSON.stringify({ type: "peers", peers: [] }) + "\n", "x".repeat(MAX_NETWORK_FRAME_BYTES + 1)]) {
      const code = decodePairingCode(network.keys.invite());
      const socket = tlsConnect({ host: LOOPBACK, port: network.port, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", ciphers: TLS_CIPHER, rejectUnauthorized: false, pskCallback: () => ({ identity: keyFingerprint(code.key), psk: Buffer.from(code.key, "hex") }) });
      cleanup.push(() => { socket.destroy(); });
      socket.on("error", () => {});
      socket.resume();
      await new Promise<void>((resolve, reject) => { socket.once("secureConnect", resolve); socket.once("error", reject); });
      socket.write(data);
      await new Promise<void>((r) => socket.once("close", () => r()));
      expect(network.status().paired).toEqual([]);
    }
  });
});

describe("broker federation", () => {
  it("preserves durable inboxes, offline queueing and reply hops across two brokers", async () => {
    const make = async (name: string) => {
      const dir = join(home, name);
      mkdirSync(dir, { recursive: true });
      const pipe = resolvePipePath(dir, {});
      const broker = new Broker(pipe, new MessageStore(join(dir, "bridge.db"), nullLogger), nullLogger, TOKEN, Date.now, undefined, { home: dir, config: { ...DEFAULT_NETWORK_CONFIG, enabled: true, name, bind: LOOPBACK, port: 0, discovery: false } });
      cleanup.push(() => broker.close());
      await broker.listen();
      const admin = await BridgeClient.connect(pipe, nullLogger);
      cleanup.push(() => admin.close());
      await admin.request("auth", { protocol: PROTOCOL_VERSION, token: TOKEN });
      const node = (peerName: string, jobAgent?: "codex") => {
        const n = new BridgeNode({ pipePath: pipe, token: TOKEN, dbPath: join(dir, "bridge.db"), agent: "claude", name: peerName, cwd: dir, autoWake: false, log: nullLogger, canHostBroker: false, ...(jobAgent ? { jobAgent, id: `job:${randomUUID()}` } : {}) });
        cleanup.push(() => n.stop());
        return n;
      };
      return { admin, node };
    };
    const a = await make("windows");
    const b = await make("mac");
    const sender = a.node("claude-app");
    const recipient = b.node("codex-job", "codex");
    await sender.start(); await recipient.start();
    const port = (await b.admin.request("networkStatus", {})).port!;
    await a.admin.request("networkLink", { code: (await b.admin.request("networkPair", {})).code, host: LOOPBACK, port });
    expect((await sender.peers()).map((p) => p.name)).toContain("mac/codex-job");
    const sent = await sender.send({ to: "mac/codex-job", body: "contract" });
    const received = await recipient.waitForMessage(2_000);
    expect(received?.id).toBe(sent.messages[0]?.id);
    await recipient.send({ to: received!.from.name, body: "agreed", replyTo: received!.id });
    expect(await sender.waitForMessage(2_000)).toMatchObject({ body: "agreed", conversationId: received!.conversationId, hop: 1 });
    expect(await sender.send({ to: "mac/later", body: "saved offline" })).toMatchObject({ queuedFor: ["mac/later"] });
    const dedupeKey = randomUUID();
    const duplicate = await Promise.all([sender.send({ to: "mac/codex-job", body: "once", dedupeKey }), sender.send({ to: "mac/codex-job", body: "once", dedupeKey })]);
    expect(duplicate[0]?.messages[0]?.id).toBe(duplicate[1]?.messages[0]?.id);
    expect(recipient.unread().filter((m) => m.body === "once")).toHaveLength(1);
    const remoteId = (await sender.peers()).find((p) => p.name === "mac/codex-job")!.id;
    expect(await sender.send({ to: remoteId, body: "by id" })).toMatchObject({ deliveredTo: ["mac/codex-job"] });
    const later = b.node("later");
    await later.start();
    expect(await later.waitForMessage(2_000)).toMatchObject({ body: "saved offline", from: { name: "windows/claude-app" } });
    const source = join(home, "contract");
    mkdirSync(join(source, "empty"), { recursive: true });
    writeFileSync(join(source, "api.txt"), "contract v1");
    const files = await sender.sendFiles("mac/codex-job", [source]);
    expect(files).toMatchObject({ files: 1, bytes: 11 });
    expect(readFileSync(join(files.inbox, "contract", "api.txt"), "utf8")).toBe("contract v1");
    expect(statSync(join(files.inbox, "contract", "empty")).isDirectory()).toBe(true);
    await until(() => recipient.unread().some((m) => m.id === files.id));
    expect(recipient.unread().find((m) => m.id === files.id)?.from.name).toBe("windows/claude-app");
    const localReceiver = a.node("local-receiver");
    await localReceiver.start();
    const localFiles = await sender.sendFiles("local-receiver", [join(source, "api.txt")]);
    expect(readFileSync(join(localFiles.inbox, "api.txt"), "utf8")).toBe("contract v1");
    await expect(sender.sendFiles("mac/missing-peer", [source])).rejects.toThrow(/not online/);
    await expect(a.admin.request("networkLink", { code: "bad", host: LOOPBACK, port: -1 })).rejects.toThrow();
  });
});

describe("file inbox validation", () => {
  it("rejects traversal, Windows aliases and drive paths before writing anything", () => {
    const from = peer("claude-app");
    const source = join(home, "api.txt");
    writeFileSync(source, "contract");
    const transfer = collectTransfer([source], home, "codex-app", from);
    for (const path of ["../escape", "/absolute", "C:/absolute", "folder\\escape", "CON", "CONIN$", "COM¹.txt", "file.txt:stream", "folder/file. ", "a/../../b"]) {
      expect(safeTransferPath(path)).toBe(false);
      expect(() => receiveTransfer(home, { ...transfer, entries: [{ ...transfer.entries[0]!, path }] })).toThrow();
    }
    expect(() => statSync(join(home, "inbox"))).toThrow();
  });

  it("rejects wrong checksums, duplicate paths, file parents, and oversized batches", () => {
    const source = join(home, "api.txt");
    writeFileSync(source, "contract");
    const transfer = collectTransfer([source], home, "codex-app", peer("claude-app"));
    const entry = transfer.entries[0]!;
    expect(() => receiveTransfer(home, { ...transfer, entries: [{ ...entry, kind: "file", data: "YQ==", sha256: "0".repeat(64) }] })).toThrow(/checksum/);
    expect(() => receiveTransfer(home, { ...transfer, entries: [entry, { ...entry, path: "API.TXT" }] })).toThrow(/duplicate/);
    expect(() => receiveTransfer(home, { ...transfer, entries: [entry, { ...entry, path: "api.txt/child" }] })).toThrow(/parent/);
    writeFileSync(source, Buffer.alloc(MAX_TRANSFER_BYTES + 1));
    expect(() => collectTransfer([source], home, "codex-app", peer("claude-app"))).toThrow(/size limit/);
    const large = join(home, "large");
    mkdirSync(large);
    writeFileSync(join(large, "a"), Buffer.alloc(MAX_TRANSFER_BYTES));
    writeFileSync(join(large, "b"), "b");
    expect(() => collectTransfer([large], home, "codex-app", peer("claude-app"))).toThrow(/size limit/);
    const link = join(home, "linked-source");
    symlinkSync(large, link, "junction");
    expect(() => collectTransfer([link], home, "codex-app", peer("claude-app"))).toThrow(/symlinks or junctions/);
  });
});

describe("passive LAN discovery", () => {
  it("finds two UDP instances on loopback without creating any pairing", async () => {
    const a = new PairingStore(join(home, "a"), "windows");
    const b = new PairingStore(join(home, "b"), "mac");
    const d1 = new NetworkDiscovery({ identity: a.identity, port: 1234, bind: LOOPBACK, udpPort: 0, destination: LOOPBACK });
    const d2 = new NetworkDiscovery({ identity: b.identity, port: 1235, bind: LOOPBACK, udpPort: 0, destination: LOOPBACK });
    cleanup.push(() => d1.close(), () => d2.close());
    await d1.start(); await d2.start();
    d1.announce(d2.port); d2.announce(d1.port);
    await until(() => d1.instances().length === 1 && d2.instances().length === 1);
    expect(d1.instances()[0]).toMatchObject({ name: "mac", host: LOOPBACK, port: 1235 });
    expect(a.pairs()).toEqual([]); expect(b.pairs()).toEqual([]);
  });

  it("ignores malformed, oversized and self announcements, and expires stale hints", () => {
    let now = 0;
    const store = new PairingStore(home, "windows");
    const discovery = new NetworkDiscovery({ identity: store.identity, port: 1234, now: () => now });
    const remote = { ...store.identity, id: randomUUID(), name: "mac", port: 1235, service: "agent-bridge", v: NETWORK_VERSION };
    discovery.observe(Buffer.from("{"), LOOPBACK);
    discovery.observe(Buffer.alloc(MAX_DISCOVERY_BYTES + 1), LOOPBACK);
    discovery.observe(Buffer.from(JSON.stringify({ ...remote, id: store.identity.id })), LOOPBACK);
    discovery.observe(Buffer.from(JSON.stringify({ ...remote, port: 0 })), LOOPBACK);
    expect(discovery.instances()).toEqual([]);
    discovery.observe(Buffer.from(JSON.stringify(remote)), LOOPBACK);
    expect(discovery.instances()).toHaveLength(1);
    now = DISCOVERY_TTL_MS;
    expect(discovery.instances()).toEqual([]);
  });
});
