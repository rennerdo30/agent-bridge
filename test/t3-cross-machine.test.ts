import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import type { BridgeMessage, PeerInfo } from "../src/core/protocol.js";
import { MessageStore } from "../src/core/store.js";
import { BridgeClient } from "../src/core/client.js";
import { BridgeNode as LiveBridgeNode } from "../src/core/node.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { resolvePipePath } from "../src/core/paths.js";
import { DatabaseSync } from "node:sqlite";
import { messageBackupIfDue } from "../src/core/message-backups.js";
import { T3Host, T3_TOOL_NAMES } from "../src/core/t3-host.js";
import type { T3Binding } from "../src/core/t3-identity.js";
import { NetworkService, type NetworkDestination } from "../src/network/link.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { T3Waker } from "../src/mcp/t3-wake.js";
import { until } from "./helpers.js";

// No CLI/provider/daemon subprocess may escape this fixture. Windows ACL queries are
// mocked as well; TLS pairing and wire framing still run on isolated loopback sockets.
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const refused = () => { throw new Error("subprocess forbidden in cross-PC fixture"); };
  return { ...actual, spawn: vi.fn(refused), spawnSync: vi.fn(refused), exec: vi.fn(refused),
    execFile: vi.fn(refused), execSync: vi.fn(refused), fork: vi.fn(refused),
    execFileSync: vi.fn((file: string, args: string[]) => {
      if (file.endsWith("whoami.exe")) return '"fixture","S-1-5-21-123"\n';
      if (file.endsWith("icacls.exe")) return `${args[0]} fixture:(F)\n`;
      return refused();
    }) };
});

// Real brokers, durable stores, authenticated hello/helloT3 and production queue
// recovery. Only OS identity/ACL probes and provider execution remain mocked.
async function persistentHost(name: string, folder = name) {
  const dir = join(home, folder); mkdirSync(dir, { recursive: true });
  const pipe = resolvePipePath(dir, {}), db = join(dir, "bridge.db"), token = "isolated-fixture-token";
  const store = new MessageStore(db, nullLogger);
  const broker = new Broker(pipe, store, nullLogger, token, Date.now, undefined,
    { home: dir, config: { ...DEFAULT_NETWORK_CONFIG, enabled: true, name, bind: "127.0.0.1", port: 0, discovery: false } });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await broker.close(); } };
  cleanup.push(close); await broker.listen();
  const admin = await BridgeClient.connect(pipe, nullLogger); cleanup.push(() => admin.close());
  await admin.request("auth", { protocol: PROTOCOL_VERSION, token });
  const network = (broker as any).network as NetworkService;
  expect(network).toBeDefined();
  const register = async (frontend?: T3Binding, name = "destination") => {
    const client = await BridgeClient.connect(pipe, nullLogger); cleanup.push(() => client.close());
    await client.request("auth", { protocol: PROTOCOL_VERSION, token });
    const events: BridgeMessage[] = [];
    client.on("event", (event, data) => { if (event === "message") events.push(data as BridgeMessage); });
    const registration = peer(name, frontend);
    const hello = await client.request(frontend ? "helloT3" : "hello", { protocol: PROTOCOL_VERSION, token, peer: registration });
    registration.name = hello.name;
    return { client, events, peer: registration };
  };
  return { broker, store, network, dir, pipe, db, token, admin, close, register };
}
async function pairPersistent(a: Awaited<ReturnType<typeof persistentHost>>, b: Awaited<ReturnType<typeof persistentHost>>, invite = b.network.keys.invite()) {
  await a.admin.request("networkLink", { code: invite, host: "127.0.0.1", port: b.network.port });
  return invite;
}

it.each(["thread", "provider", "scope", "native"])("retains unread ownership through real registration/recovery and rejects a %s claimant", async changed => {
  const a = await persistentHost("pc-a"); let b = await persistentHost("pc-b");
  const sender = await a.register(binding("a", "sender-thread"), "sender");
  const original = binding("b", "original-thread"), first = await b.register(original);
  const invite = await pairPersistent(a, b);
  const id = randomUUID();
  await sender.client.request("trackedSend", { messageId: id, to: "pc-b/destination", body: "original private mail" });
  await until(() => first.events.some(m => m.id === id));
  first.client.close(); await b.close(); b = await persistentHost("pc-b");
  const wrong = changed === "native" ? undefined : { ...original, ...(changed === "thread" ? { threadId: "wrong" } :
    changed === "provider" ? { providerInstanceId: "wrong" } : { scope: "c".repeat(64) }) };
  const impostor = await b.register(wrong);
  const pending = await impostor.client.request("pending", { limit: 100 });
  expect(pending.filter(m => m.id === id)).toEqual([]);
  expect(impostor.events.filter(m => m.id === id)).toEqual([]);
  expect(await impostor.client.request("ack", { ids: [id] })).toEqual({ acked: 0 });
  expect(b.store.receipts(id)[0]?.readAt).toBeNull();
  await pairPersistent(a, b, invite);
  // Bypass only the source pin to attack the receiver's duplicate-receipt guard
  // through its real authenticated wire and production registration checks.
  await expect(link(a.network).send({ ...a.store.byId(id)!, recipient: "destination" },
    { peerId: impostor.peer.id, ...(wrong ? { frontend: wrong } : {}) })).rejects.toThrow(/ownership|destination|recipient/i);
  const reconnected = await b.register(original);
  expect(reconnected.peer.name).not.toBe(impostor.peer.name);
  expect((await reconnected.client.request("pending", { limit: 100 })).map(m => m.id)).toContain(id);
  expect(await reconnected.client.request("ack", { ids: [id] })).toEqual({ acked: 1 });
  expect((await impostor.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(id);
});

it("keeps legacy unfenced mail native and refuses hosted stand-in claims", async () => {
  const b = await persistentHost("pc-b");
  const legacy = message(peer("legacy"), "destination"); b.store.insert(legacy);
  const bound = await b.register(binding("b", "original-thread"));
  expect((await bound.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(legacy.id);
  bound.client.close(); await until(() => !(b.broker as any).localPeers().length);
  const native = await b.register();
  expect((await native.client.request("pending", { limit: 100 })).map(m => m.id)).toContain(legacy.id);
  native.client.close(); await until(() => !(b.broker as any).localPeers().length);
  const owner = await b.register(binding("b", "original-thread"), "destination-2");
  const owned = message(peer("legacy"), "destination");
  b.store.insert({ ...owned, recipientFrontend: binding("b", "different-thread") } as BridgeMessage);
  expect(await owner.client.request("claimMail", { names: ["destination"] })).toEqual({ moved: 0 });
  expect((await owner.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(owned.id);
  const matching = { ...message(peer("legacy"), "destination-3"), recipientFrontend: binding("b", "original-thread") };
  b.store.insert(matching);
  expect(await owner.client.request("claimMail", { names: ["destination-3"] })).toEqual({ moved: 1 });
  expect((await owner.client.request("pending", { limit: 100 })).map(m => m.id)).toContain(matching.id);
});

it("keeps broadcast recipient copies independently owned during live name reuse", async () => {
  const a = await persistentHost("pc-a"), b = await persistentHost("pc-b");
  const sender = await a.register(binding("a", "sender-thread"), "sender");
  const original = await b.register(binding("b", "original-thread"));
  const other = await b.register(binding("b", "other-thread"), "other"), native = await b.register(undefined, "native");
  await pairPersistent(a, b);
  const id = randomUUID();
  await sender.client.request("trackedSend", { messageId: id, to: "*", body: "three independently owned copies" });
  for (const recipient of [original, other, native]) expect((await recipient.client.request("pending", { limit: 100 })).map(m => m.id)).toContain(id);
  expect(b.store.messagesById(id)).toHaveLength(3);
  original.client.close(); await until(() => !(b.broker as any).localPeers().some((p: PeerInfo) => p.id === original.peer.id));
  const reused = await b.register(binding("b", "replacement-thread"));
  expect((await reused.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(id);
  expect(await reused.client.request("ack", { ids: [id] })).toEqual({ acked: 0 });
  expect(await other.client.request("ack", { ids: [id] })).toEqual({ acked: 1 });
  expect(b.store.receipts(id).find(r => r.recipient === "destination")?.readAt).toBeNull();
});

it("migrates v9 additively without attributing legacy rows and retains ownership through archive/reopen", async () => {
  let b = await persistentHost("pc-b");
  const legacy = message(peer("legacy"), "destination"); b.store.insert(legacy);
  const file = b.db; await b.close();
  const old = new DatabaseSync(file);
  old.exec("DROP TABLE message_frontends; DROP TABLE send_intents; DROP TABLE send_destinations; PRAGMA user_version=9;");
  const before = old.prepare("SELECT * FROM messages").all(); old.close();
  b = await persistentHost("pc-b");
  const current = new DatabaseSync(file, { readOnly: true });
  expect(current.prepare("PRAGMA user_version").get()!.user_version).toBe(10);
  expect(current.prepare("SELECT * FROM messages").all()).toEqual(before); current.close();
  const hosted = await b.register(binding("b", "original-thread"));
  expect((await hosted.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(legacy.id);
  const owned = { ...message(peer("legacy"), "destination"), recipientFrontend: binding("b", "original-thread") };
  const pin = { hostId: randomUUID(), hostFingerprint: "f".repeat(64), name: "remote", frontend: owned.recipientFrontend };
  b.store.rememberSendIntent(owned.id, "fixture-owner", "fixture-request");
  b.store.pinDestination(owned, pin);
  b.store.insert(owned); b.store.expireQueued("destination", Date.now() + 1000);
  const backup = await messageBackupIfDue(b.dir, { checkpoint: async () => {} });
  expect(backup.path).toBeTruthy();
  const snapshot = new DatabaseSync(join(backup.path!, "bridge.messages.db"), { readOnly: true });
  expect(snapshot.prepare("SELECT binding FROM message_frontends WHERE id=?").get(owned.id)?.binding).toBe(JSON.stringify(owned.recipientFrontend));
  expect(snapshot.prepare("SELECT owner FROM send_intents WHERE id=?").get(owned.id)?.owner).toBe("fixture-owner");
  expect(JSON.parse(String(snapshot.prepare("SELECT destination FROM send_destinations WHERE id=?").get(owned.id)?.destination))).toEqual(pin);
  snapshot.close();
  await b.close(); b = await persistentHost("pc-b");
  expect(b.store.byId(owned.id)?.recipientFrontend).toEqual(owned.recipientFrontend);
  expect(b.store.byId(legacy.id)?.body).toBe(legacy.body);
});

it.each(["thread", "host", "same-binding"])("pins first dispatch across source broker loss and automatic tracked retry (%s)", async changed => {
  let a = await persistentHost("pc-a"), b = await persistentHost("pc-b");
  const original = binding("b", "original-thread"), first = await b.register(original);
  const sender = new LiveBridgeNode({ pipePath: a.pipe, token: a.token, dbPath: a.db, agent: "codex", name: "sender", cwd: a.dir,
    frontend: binding("a", "sender-thread"), autoWake: false, canHostBroker: false, log: nullLogger });
  cleanup.push(() => sender.stop()); await sender.start();
  const invite = await pairPersistent(a, b), id = randomUUID();
  let reached!: () => void, resume!: () => void;
  const intercepted = new Promise<void>(resolve => { reached = resolve; }), resumed = new Promise<void>(resolve => { resume = resolve; });
  const connected = sender.ensureConnected.bind(sender); let retrying = false;
  vi.spyOn(sender, "ensureConnected").mockImplementation(async () => { if (retrying) await resumed; return connected(); });
  const transport = link(a.network), write = transport.write.bind(transport);
  vi.spyOn(transport, "write").mockImplementation((frame: any) => {
    if (frame.type !== "send") return write(frame);
    retrying = true;
    (sender as any).client.close(); reached();
    throw new Error("fixture source crash before first wire dispatch");
  });
  const sent = sender.send({ messageId: id, to: "pc-b/destination", body: "must stay with original destination" }).catch(error => error);
  await intercepted;
  expect(a.store.byId(id)).toBeNull(); expect(b.store.byId(id)).toBeNull();
  const persisted = new DatabaseSync(a.db, { readOnly: true });
  const intent = JSON.parse(String(persisted.prepare("SELECT destination FROM send_destinations WHERE id=?").get(id)?.destination));
  expect(intent).toMatchObject({ hostId: b.network.keys.identity.id, hostFingerprint: b.network.keys.identity.fingerprint, frontend: original });
  persisted.close();
  await a.close(); first.client.close(); await b.close();
  b = await persistentHost("pc-b", changed === "host" ? "replacement-pc-b" : "pc-b");
  const next = await b.register(changed === "thread" ? binding("b", "new-thread") : original);
  a = await persistentHost("pc-a");
  if (changed === "host") {
    const old = a.network.status().paired[0]!;
    await a.admin.request("networkUnlink", { id: old.id });
    await pairPersistent(a, b);
  } else await pairPersistent(a, b, invite);
  resume();
  const result = await sent;
  if (changed === "same-binding") {
    expect(result).not.toBeInstanceOf(Error);
    expect((await next.client.request("pending", { limit: 100 })).map(m => m.id)).toContain(id);
  } else {
    expect(result).toBeInstanceOf(Error);
    expect((await next.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(id);
    expect(b.store.byId(id)).toBeNull();
  }
});
vi.mock("../src/core/process-identity.js", async original => ({
  ...await original<typeof import("../src/core/process-identity.js")>(),
  processIdentity: () => "fixture-process-identity", isProcessIdentityAlive: () => true,
  ownProcessIdentity: async () => "fixture-process-identity", readProcessIdentity: async () => "fixture-process-identity",
  parentProcessIdentity: async () => "fixture-process-identity",
}));
vi.mock("../src/core/muse-context.js", async original => ({
  ...await original<typeof import("../src/core/muse-context.js")>(),
  registerMuseContext: () => () => {}, registerMuseContextAsync: async () => () => {},
  writeMusePrivateJsonAsync: async () => { throw new Error("unrelated Muse TCP discovery disabled in fixture"); },
}));

let home: string;
let cleanup: (() => void | Promise<void>)[];
beforeEach(() => {
  mkdirSync(process.env.AGENT_BRIDGE_TEST_ROOT!, { recursive: true });
  home = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "t3-cross-machine-"));
  cleanup = [];
});
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  expect(childProcess.spawn).not.toHaveBeenCalled();
  expect(childProcess.execFile).not.toHaveBeenCalled();
  expect(childProcess.exec).not.toHaveBeenCalled();
  expect(childProcess.fork).not.toHaveBeenCalled();
  expect(childProcess.spawnSync).not.toHaveBeenCalled();
  expect(childProcess.execSync).not.toHaveBeenCalled();
  vi.clearAllMocks(); vi.restoreAllMocks();
});

const binding = (host: "a" | "b", threadId: string): T3Binding => ({
  kind: "t3", scope: host.repeat(64), threadId, providerInstanceId: `provider-${host}`,
});
function peer(name: string, frontend?: T3Binding): PeerInfo {
  return { id: randomUUID(), name, agent: "codex", cwd: home, pid: process.pid, agentPid: null,
    sessionId: "same-native-provider-id", startedAt: Date.now(), autoWake: false, frontend };
}
function service(name: string, peers: PeerInfo[], receive: (m: BridgeMessage, destination?: NetworkDestination | null) => { delivered: boolean }) {
  const intents = new MessageStore(":memory:", nullLogger); cleanup.push(() => intents.close());
  const service = new NetworkService(join(home, name), { ...DEFAULT_NETWORK_CONFIG,
    enabled: true, name, bind: "127.0.0.1", port: 0, discovery: false }, { peers: () => peers, receive,
      pinDestination: (message, destination) => intents.pinDestination(message, destination) }, nullLogger);
  cleanup.push(() => service.close());
  return service;
}
async function connect(a: NetworkService, b: NetworkService) {
  await a.start(); await b.start();
  const invite = b.keys.invite();
  await a.link(invite, "127.0.0.1", b.port);
  expect(a.keys.identity.id).not.toBe(b.keys.identity.id);
  return invite;
}
function message(from: PeerInfo, recipient = "pc-b/destination"): BridgeMessage {
  return { id: randomUUID(), from: { id: from.id, name: from.name, agent: from.agent }, to: recipient,
    recipient, conversationId: randomUUID(), replyTo: null, hop: 0, body: "remote mail", createdAt: Date.now(), readAt: null };
}
// Only fixture socket state is exposed; production Link framing/authentication stays intact.
const link = (service: NetworkService) => [...(service as any).links.values()][0];

it("retains the destination frontend across the authenticated peer advertisement", async () => {
  const sender = peer("sender", binding("a", "sender-thread")), destination = peer("destination", binding("b", "target-thread"));
  const a = service("pc-a", [sender], () => ({ delivered: true }));
  const b = service("pc-b", [destination], () => ({ delivered: true }));
  await connect(a, b);
  expect(a.peers()[0]?.frontend).toEqual(destination.frontend);
  expect(b.peers()[0]?.frontend).toEqual(sender.frontend);
});

it.each(["thread", "scope", "provider", "id", "native", "became-t3", "missing"])("rejects a stale %s destination before inbox storage or wake", async changed => {
  const sender = peer("sender", binding("a", "sender-thread")), destination = peer("destination", changed === "became-t3" ? undefined : binding("b", "target-thread"));
  const received = vi.fn(() => ({ delivered: true }));
  const local = [destination];
  const a = service("pc-a", [sender], () => ({ delivered: true })), b = service("pc-b", local, received);
  await connect(a, b);
  if (changed === "missing") local.length = 0;
  else if (changed === "id") destination.id = randomUUID();
  else if (changed === "native") destination.frontend = undefined;
  else if (changed === "became-t3") destination.frontend = binding("b", "new-thread");
  else destination.frontend = { ...destination.frontend!, ...(changed === "thread" ? { threadId: "wrong-thread" } :
    changed === "scope" ? { scope: "c".repeat(64) } : { providerInstanceId: "wrong-provider" }) };
  // No refresh: the send races with an old advertisement from the paired PC.
  await expect(a.send(message(sender))).rejects.toThrow(/destination|binding|thread/i);
  expect(received).not.toHaveBeenCalled();
});

it("rejects an unfenced retained alias that the broker resolves to a hosted thread", async () => {
  const sender = peer("native-sender"), destination = peer("destination", binding("b", "target-thread"));
  const store = new MessageStore(":memory:", nullLogger); cleanup.push(() => store.close());
  const emit = vi.fn(), target = { peer: destination };
  const a = service("pc-a", [sender], () => ({ delivered: true }));
  const b = service("pc-b", [destination], (m, ...args: unknown[]) => (Broker.prototype as any).receiveRemote.call({
    store, emit, recipientConn: (name: string) => ["destination", "old-destination"].includes(name) ? target : undefined }, m, ...args));
  await connect(a, b);
  await expect(a.send(message(sender, "pc-b/old-destination"))).rejects.toThrow(/binding|destination|thread/i);
  expect(emit).not.toHaveBeenCalled();
  expect(store.unread(destination.name, 10)).toEqual([]);
});

it("preserves legacy native-to-native delivery without a T3 capability", async () => {
  const sender = peer("native-sender"), destination = peer("destination");
  const received = vi.fn(() => ({ delivered: true }));
  const a = service("pc-a", [sender], () => ({ delivered: true })), b = service("pc-b", [destination], received);
  const hello = b.extensionHelloCapabilities.bind(b);
  vi.spyOn(b, "extensionHelloCapabilities").mockImplementation(() => ({ ...hello(), t3ThreadRouting: false }));
  await connect(a, b);
  expect(await a.send(message(sender))).toMatchObject({ deliveredTo: ["pc-b/destination"] });
  expect(received).toHaveBeenCalledTimes(1);
});

it("refuses an unfenced legacy send to a T3 session and does not downgrade T3 sends to an old host", async () => {
  const sender = peer("sender", binding("a", "sender-thread")), destination = peer("destination", binding("b", "target-thread"));
  const received = vi.fn(() => ({ delivered: true }));
  const a = service("pc-a", [sender], () => ({ delivered: true })), b = service("pc-b", [destination], received);
  const hello = b.extensionHelloCapabilities.bind(b);
  vi.spyOn(b, "extensionHelloCapabilities").mockImplementation(() => ({ ...hello(), t3ThreadRouting: false }));
  await connect(a, b);
  await expect(a.send(message(sender))).rejects.toThrow(/T3|thread/i);
  // A shipped sender can still put an ordinary frame on the wire; ingress must reject it.
  await expect(link(a).send({ ...message(sender), recipient: "destination" })).rejects.toThrow(/binding|destination|thread/i);
  expect(received).not.toHaveBeenCalled();
});

it.each(["accepted", "refused", "wrong-receipt"])("delivers to the exact remote T3 thread, dedupes reconnect replay and has no native fallback (%s)", async outcome => {
  const sender = peer("sender", binding("a", "sender-thread")), destination = peer("destination", binding("b", "target-thread"));
  const other = peer("other", binding("b", "other-thread"));
  const store = new MessageStore(":memory:", nullLogger); cleanup.push(() => store.close());
  const node = Object.assign(new EventEmitter(), { name: destination.name, isConnected: true, wasReplaced: false,
    autoWakeEnabled: false, unread: () => store.unread(destination.name, 100, destination.frontend), isNotificationAwaited: () => false, isAwaitedReply: () => false });
  const emitted = vi.fn((target: { peer: PeerInfo }, _event: string, mail: BridgeMessage) => { if (target.peer === destination) node.emit("message", mail); });
  const target = { peer: destination }, otherTarget = { peer: other };
  const receive = (m: BridgeMessage, ...args: unknown[]) => (Broker.prototype as any).receiveRemote.call({ store, emit: emitted,
    recipientConn: (name: string) => name === destination.name ? target : name === other.name ? otherTarget : undefined }, m, ...args);
  const a = service("pc-a", [sender], () => ({ delivered: true })), b = service("pc-b", [destination, other], receive);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const host = new T3Host({ endpoint: new URL("http://127.0.0.1:1/fixture-only"), authorization: "Bearer fixture-only", scope: destination.frontend!.scope }, async () => ({
    listTools: async () => ({ tools: T3_TOOL_NAMES.map(name => ({ name })) }), close: async () => {},
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "t3_thread_send" && outcome === "refused") throw new Error("fixture host refused");
      const data = name === "orchestrator_capabilities" ? { parentThreadId: "target-thread", inheritedProviderInstanceId: "provider-b", inheritedModel: "fixture-model",
        runtimeMode: "full-access", interactionMode: "default", features: { appOwnedSubagents: false, cancellation: false, threadManagement: true },
        providers: [{ providerInstanceId: "provider-b", driverKind: "fixture", displayName: "fixture", canRunChildTask: false, canRunCrossProviderChildTask: false,
          constraints: [], models: [{ id: "fixture-model" }] }] } : name === "t3_thread_list" ? { currentThreadId: "target-thread", projectId: "project" } :
        { threadId: outcome === "wrong-receipt" ? "wrong-thread" : args.threadId, messageId: "wake-message", runId: "wake-run", delivery: "queued", status: "queued" };
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
  }));
  cleanup.push(() => host.close());
  await host.capabilities();
  const waker = new T3Waker(host, node as unknown as BridgeNode, { ...DEFAULT_CONFIG, wakeOnDirect: true }, nullLogger, 60_000, join(home, "wake"));
  cleanup.push(waker.stop);
  const invite = await connect(a, b);
  const writes = vi.spyOn(link(a), "write");
  const mail = message(sender);
  expect(await a.send(mail)).toMatchObject({ deliveredTo: ["pc-b/destination"], storage: { state: "stored" } });
  await waker.flush(); waker.stop();
  expect(emitted).toHaveBeenCalledTimes(1);
  expect(emitted.mock.calls[0]?.[0]).toBe(target);
  expect(store.unread("other", 10)).toEqual([]);
  expect(store.unread(destination.name, 10, destination.frontend)[0]?.from.id).toBe(`${a.keys.identity.id}/${sender.id}`);
  const sends = () => calls.filter(c => c.name === "t3_thread_send");
  expect(sends()).toHaveLength(1);
  expect(sends()[0]?.args).toMatchObject({ threadId: "target-thread", mode: "queue" });
  expect(sends()[0]?.args.message).not.toContain(mail.body); // Pointer wake, never the remote payload as a prompt.
  const wire = JSON.stringify(writes.mock.calls);
  expect(wire).not.toContain("Bearer fixture-only");
  expect(wire).not.toContain("127.0.0.1:1/fixture-only");
  expect(writes.mock.calls.some(([frame]: any[]) => frame.type === "send" && frame.destination?.frontend?.threadId === "target-thread")).toBe(true);
  link(a).socket.destroy();
  await until(() => a.peers().length === 0 && b.peers().length === 0);
  await a.link(invite, "127.0.0.1", b.port);
  // The sender reloads after hello. send must refresh its advertised identity before mail.
  sender.id = randomUUID();
  const replay = { ...mail, from: { ...mail.from, id: sender.id } };
  expect(await a.send(replay)).toMatchObject({ storage: { recovered: true } });
  const reloaded = new T3Waker(host, node as unknown as BridgeNode, { ...DEFAULT_CONFIG, wakeOnDirect: true }, nullLogger, 60_000, join(home, "wake"));
  cleanup.push(reloaded.stop); await reloaded.flush();
  expect(emitted).toHaveBeenCalledTimes(1);
  expect(sends()).toHaveLength(1);
  expect(store.unread(destination.name, 10, destination.frontend)).toHaveLength(1); // Wake acceptance is not consumption.
});
