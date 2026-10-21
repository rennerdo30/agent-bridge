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
vi.mock("../src/core/process-identity.js", async original => ({
  ...await original<typeof import("../src/core/process-identity.js")>(),
  processIdentity: () => "fixture-process-identity", isProcessIdentityAlive: () => true,
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
  const service = new NetworkService(join(home, name), { ...DEFAULT_NETWORK_CONFIG,
    enabled: true, name, bind: "127.0.0.1", port: 0, discovery: false }, { peers: () => peers, receive }, nullLogger);
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
    autoWakeEnabled: false, unread: () => store.unread(destination.name, 100), isNotificationAwaited: () => false, isAwaitedReply: () => false });
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
  expect(store.unread(destination.name, 10)[0]?.from.id).toBe(`${a.keys.identity.id}/${sender.id}`);
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
  expect(store.unread(destination.name, 10)).toHaveLength(1); // Wake acceptance is not consumption.
});
