/** Real isolated Broker/Node/MCP boundaries; no native/provider consumption proof. */
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeNode } from "../src/core/node.js";
import { BridgeError, type AgentKind, type ModeSendArgs, type SendModeReport } from "../src/core/protocol.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { JobManager } from "../src/mcp/jobs.js";
import { registerTools, type ServerContext } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
const closes: (() => Promise<void>)[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0)) await close(); await env.cleanup(); });
const kinds = ["claude", "codex", "opencode", "antigravity", "muse"] as const;
const content = (r: any): string => r.content.map((c: any) => c.text ?? "").join("\n");
const modeFrom = (r: any): SendModeReport => JSON.parse(content(r).split("Mode report: ")[1]!.split("\n")[0]!);
const wire = (node: BridgeNode): BridgeClient => (node as any).client;
const brokerOf = (node: BridgeNode): any => (node as any).broker;

async function tools(node: BridgeNode, jobs?: JobManager, agent: AgentKind = "claude") {
  const server = new McpServer({ name: "mode-fixture", version: "1" });
  const ctx: ServerContext = { node, jobs, home: env.home, cfg: DEFAULT_CONFIG, agent,
    log: nullLogger, cwd: () => env.home, channelActive: () => false };
  registerTools(server, ctx, []);
  const client = new Client({ name: "mode-fixture", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  closes.push(async () => { await client.close(); await server.close(); });
  // While a native child is live, a Claude parent call needs the host mod's capability (AB-412).
  return Object.assign(client, { parentScope: (tool: string) => ctx.claudeMailScopes!.issue(tool, node.currentSessionId!) });
}

async function native() {
  const parent = env.node("claude-mode-parent");
  await parent.setSessionId("native-root"); await parent.start();
  const child = await parent.nativeChild({ agentId: "child-1", action: "start", maxHops: 2 });
  return { parent, address: child!.address, childId: child!.agentId, broker: brokerOf(parent) };
}

it.each(["idle", "busy"] as const)("all 25 sender/receiver pairs at %s use real mail or truthful refusal", async activity => {
  const host = env.node("mode-host"); await host.start();
  const nodes = new Map<string, BridgeNode>(), clients = new Map<string, Client>();
  for (const kind of kinds) {
    const sender = env.node(`mode-${kind}-sender`, kind), receiver = env.node(`mode-${kind}-receiver`, kind);
    await sender.setSessionId(`matrix-${kind}-sender`); await receiver.setSessionId(`matrix-${kind}-receiver`);
    await sender.start(); await receiver.start(); await wire(receiver).request("updatePeer", { activity });
    expect((await host.peers()).find(peer => peer.id === receiver.id)?.activity).toBe(activity);
    nodes.set(kind, receiver); clients.set(kind, await tools(sender, undefined, kind));
  }
  for (const sender of kinds) for (const receiver of kinds) {
    const client = clients.get(sender)!, target = nodes.get(receiver)!.name;
    for (const mode of ["queue", "steer", "restart"] as const) {
      const refused = await client.callTool({ name: "send", arguments: { to: target, message: "unsupported mode", mode } });
      expect(refused.isError).toBe(true);
      expect(modeFrom(refused)).toMatchObject({ requested: mode, effective: "refused", stage: "requested", sharedIdempotentDelivery: false });
    }
    const result = await client.callTool({ name: "send", arguments: { to: target, message: `${sender}->${receiver}:${activity}`, mode: "auto" } });
    expect(result.isError).not.toBe(true);
    expect(modeFrom(result)).toMatchObject({ requested: "auto", effective: "mailbox", stage: "stored",
      capabilities: { receiverRole: "session", activeSteering: false, interruptRestart: false, queue: false } });
    expect((result.structuredContent as { mode?: unknown } | undefined)?.mode).toEqual(modeFrom(result));
    await until(() => nodes.get(receiver)!.unread().some(m => m.body === `${sender}->${receiver}:${activity}`));
    expect(nodes.get(receiver)!.unread().filter(m => m.body === "unsupported mode")).toHaveLength(0);
  }
});

it("one-shot native queue retains identical originals under distinct broker UUIDs and proves stored only", async () => {
  const { parent, address, childId } = await native();
  const client = await tools(parent);
  for (const activity of ["idle", "busy"] as const) {
    await wire(parent).request("updatePeer", { activity });
    const result = await client.callTool({ name: "send", arguments: { to: address, message: "same original", mode: "queue", _bridge_scope: client.parentScope("send") } });
    expect(result.isError).not.toBe(true);
    expect(modeFrom(result)).toMatchObject({ requested: "queue", effective: "nativequeue", stage: "stored",
      sharedIdempotentDelivery: false, capabilities: { route: "nativequeue", receiverRole: "native_child",
        ownedSession: true, generationKnown: true, queue: true, activeSteering: false, interruptRestart: false, idleWake: false } });
  }
  const pending = await parent.nativeChildPending(childId);
  expect(pending).toHaveLength(2); expect(pending[0]!.id).not.toBe(pending[1]!.id);
  expect(pending.map(m => m.body)).toEqual(["same original", "same original"]);
  expect(pending.every(m => m.readAt === null)).toBe(true);
  await parent.nativeChild({ agentId: childId, action: "end" });
  await parent.refreshPending();
  expect(parent.unread().filter(m => pending.some(p => p.id === m.id))).toHaveLength(2);
  await expect(parent.sendWithMode({ mode: "queue", to: address, body: "after stop" })).rejects.toMatchObject({ code: "unauthorized" });
});

it.each(["idle", "busy"] as const)("native-role 25-pair matrix at %s uses only registered Claude queues", async activity => {
  const { parent, address, childId } = await native();
  const senders = new Map<string, BridgeNode>();
  const receivers = new Map<string, string>([["claude", address]]);
  for (const kind of kinds) {
    const sender = env.node(`native-${kind}-sender`, kind);
    await sender.setSessionId(`native-${kind}-sender`); await sender.start(); senders.set(kind, sender);
    await parent.nativeChild({ agentId: childId, action: "grant", sendTo: [...senders.values()].map(node => node.name) });
    if (kind !== "claude") {
      const target = env.node(`native-${kind}-target`, kind);
      await target.setSessionId(`native-${kind}-target`); await target.start();
      await wire(target).request("updatePeer", { activity }); receivers.set(kind, `${target.name}/sub:unavailable`);
    }
  }
  await wire(parent).request("updatePeer", { activity });
  for (const sender of kinds) for (const receiver of kinds) {
    const attempt = senders.get(sender)!.sendWithMode({ mode: "queue", to: receivers.get(receiver)!, body: `native ${sender}->${receiver}` });
    if (receiver === "claude") expect((await attempt).mode).toMatchObject({ effective: "nativequeue", stage: "stored", capabilities: { ownedSession: false, queue: true } });
    else await expect(attempt).rejects.toBeInstanceOf(BridgeError);
  }
  expect((await parent.nativeChildPending(childId)).map(message => message.body).sort()).toEqual([
    "native claude->claude", "native codex->claude", "native opencode->claude", "native antigravity->claude", "native muse->claude",
  ].sort());
});

it("delegated registrations and job-owner DTO labels cannot create a new queue issuer", async () => {
  const { parent, address, childId } = await native();
  for (const kind of kinds) {
    const job = new BridgeNode({ pipePath: env.pipe, token: loadOrCreateToken(env.home), dbPath: env.db,
      agent: "other", jobAgent: kind, jobOwner: "native-root", jobParent: parent.name,
      id: `job:mode-${kind}`, name: `${kind}-job-mode-fixture`, cwd: env.home, autoWake: false, canHostBroker: false, log: nullLogger });
    await job.start(); closes.push(async () => { await job.stop(); });
    // Even an explicit grant cannot substitute for the unimplemented job issuer generation.
    await parent.nativeChild({ agentId: childId, action: "grant", sendTo: [job.name] });
    await expect(job.sendWithMode({ mode: "queue", to: address, body: "DTO cannot authorize queue" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(parent.sendWithMode({ mode: "queue", to: job.name, body: "job recipient unsupported" })).rejects.toMatchObject({ code: "bad_request" });
  }
  expect(await parent.nativeChildPending(childId)).toEqual([]);
  const masked = new BridgeNode({ pipePath: env.pipe, token: loadOrCreateToken(env.home), dbPath: env.db,
    agent: "codex", id: "job:masked-issuer", name: "codex-masked-issuer", cwd: env.home,
    autoWake: false, canHostBroker: false, log: nullLogger });
  await masked.setSessionId("masked-session"); await masked.start(); closes.push(async () => { await masked.stop(); });
  await parent.nativeChild({ agentId: childId, action: "grant", sendTo: [masked.name] });
  await expect(masked.sendWithMode({ mode: "queue", to: address, body: "omitted jobAgent cannot confer authority" }))
    .rejects.toMatchObject({ code: "bad_request" });
  expect(await parent.nativeChildPending(childId)).toEqual([]);
});

it("malformed retained subagent hello plus an exact grant cannot admit queue or advertise queue support", async () => {
  const { parent, address, childId, broker } = await native();
  const raw = await BridgeClient.connect(env.pipe, nullLogger);
  closes.push(async () => { raw.close(); });
  const parentPeer = (await parent.peers()).find(peer => peer.id === parent.id)!;
  const id = randomUUID();
  const hello = await raw.request("hello", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home),
    peer: { ...parentPeer, id, name: "codex-malformed-role", agent: "codex", sessionId: "malformed-role-session",
      subagent: true, jobAgent: "unsupported-kind" as AgentKind } });
  const registered = [...broker.conns].find((connection: any) => connection.peer?.id === id).peer;
  expect(registered.subagent).toBe(true); expect(registered.jobAgent).toBeUndefined();
  await parent.nativeChild({ agentId: childId, action: "grant", sendTo: [hello.name] });
  expect((await parent.nativeChildren())[0]!.sendTo).toContain(hello.name);
  const insert = vi.spyOn(broker.store, "insertBatch"), emit = vi.spyOn(broker, "emit");
  const parentInbox = broker.store.unread(parent.name, 100);
  await expect(raw.request("modeSend", { mode: "queue", to: address, body: "malformed role queue must not be stored" }))
    .rejects.toMatchObject({ code: "bad_request", details: { modeReport: { effective: "refused", stage: "requested", capabilities: { queue: false } } } });
  expect(insert).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
  expect(await parent.nativeChildPending(childId)).toEqual([]);
  expect(broker.store.unread(parent.name, 100)).toEqual(parentInbox);
  // Legacy auto is unchanged; its real insertion cannot confer the NEW queue capability.
  const automatic = await raw.request("modeSend", { mode: "auto", to: address, body: "legacy malformed-role auto" });
  expect(automatic.mode.capabilities.queue).toBe(false);
  expect(automatic.mode.sharedIdempotentDelivery).toBe(false);
  expect((await parent.nativeChildPending(childId)).map(message => message.body)).toEqual(["legacy malformed-role auto"]);
});

it.each(["issuer role", "parent role", "grant"] as const)("rechecks current %s after BEGIN before queue insertion", async fault => {
  const { parent, address, childId, broker } = await native();
  const sender = env.node("codex-current-role", "codex");
  await sender.setSessionId("current-role-session"); await sender.start();
  await parent.nativeChild({ agentId: childId, action: "grant", sendTo: [sender.name] });
  const senderPeer = [...broker.conns].find((connection: any) => connection.peer?.id === sender.id).peer;
  const parentPeer = [...broker.conns].find((connection: any) => connection.peer?.id === parent.id).peer;
  const child = broker.nativeChildren.target(address), parentInbox = broker.store.unread(parent.name, 100);
  const originalInsert = broker.store.insertBatch.bind(broker.store), emit = vi.spyOn(broker, "emit");
  let afterBegin = false;
  vi.spyOn(broker.store, "insertBatch").mockImplementation((messages: any, before: any) => originalInsert(messages, () => {
    // Negative fault inside the REAL transaction, after BEGIN IMMEDIATE. No authority is fabricated.
    afterBegin = true;
    if (fault === "issuer role") senderPeer.subagent = true;
    else if (fault === "parent role") parentPeer.subagent = true;
    else child.sendTo = [];
    before();
  }));
  await expect(sender.sendWithMode({ mode: "queue", to: address, body: "must roll back after role or grant changes" }))
    .rejects.toMatchObject({ code: fault === "issuer role" ? "bad_request" : "unauthorized" });
  expect(afterBegin).toBe(true); expect(emit).not.toHaveBeenCalled();
  expect(broker.store.unread(address, 100)).toEqual([]);
  expect(broker.store.unread(parent.name, 100)).toEqual(parentInbox);
});

it("queue rejects caller IDs, dedupe keys, generation/identity/grant DTOs before storage", async () => {
  const { parent, address, childId } = await native();
  for (const extra of [{ messageId: randomUUID() }, { dedupeKey: "caller-command" },
    { generation: 1 }, { from: { name: parent.name } }, { grant: [address] }, { sessionId: "native-root" }]) {
    await expect(wire(parent).request("modeSend", { mode: "queue", to: address, body: "spoofed", ...extra } as ModeSendArgs))
      .rejects.toMatchObject({ code: "bad_request" });
  }
  const client = await tools(parent);
  const refused = await client.callTool({ name: "send", arguments: { to: address, message: "caller id", mode: "queue", message_id: randomUUID(), _bridge_scope: client.parentScope("send") } });
  expect(refused.isError).toBe(true); expect(modeFrom(refused).effective).toBe("refused");
  expect(await parent.nativeChildPending(childId)).toEqual([]);
});

it("real native grant, revocation, hop and parent-generation checks remain authoritative", async () => {
  const { parent, address, childId, broker } = await native();
  const stranger = env.node("mode-stranger", "codex"); await stranger.start();
  await expect(stranger.sendWithMode({ mode: "queue", to: address, body: "not granted" })).rejects.toMatchObject({ code: "unauthorized" });
  await parent.nativeChild({ agentId: childId, action: "grant", sendTo: [stranger.name] });
  const first = await stranger.sendWithMode({ mode: "queue", to: address, body: "granted original" });
  expect(first.mode).toMatchObject({ stage: "stored", capabilities: { ownedSession: false, generationKnown: true, queue: true } });
  await parent.nativeChild({ agentId: childId, action: "grant", sendTo: [] });
  await expect(stranger.sendWithMode({ mode: "queue", to: address, body: "revoked" })).rejects.toMatchObject({ code: "unauthorized" });
  const rootFirst = await parent.sendWithMode({ mode: "queue", to: address, body: "root first hop" });
  const second = await parent.sendWithMode({ mode: "queue", to: address, body: "second hop", replyTo: rootFirst.send.messages[0]!.id });
  await expect(parent.sendWithMode({ mode: "queue", to: address, body: "third hop", replyTo: second.send.messages[0]!.id })).rejects.toMatchObject({ code: "bad_request" });
  await parent.setSessionId("new-root");
  const originalIds = [first, rootFirst, second].map(result => result.send.messages[0]!.id);
  const retained = originalIds.map(id => broker.store.messagesById(id));
  expect(retained.every(messages => messages.length > 0)).toBe(true);
  const parentInbox = broker.store.unread(parent.name, 100), insert = vi.spyOn(broker.store, "insertBatch");
  await expect(parent.sendWithMode({ mode: "queue", to: address, body: "old generation" })).rejects.toMatchObject({
    code: "unauthorized", message: "Native child address is unavailable or unauthorized.",
  });
  expect(insert).not.toHaveBeenCalled(); expect(broker.store.unread(address, 100)).toEqual([]);
  expect(broker.store.unread(parent.name, 100)).toEqual(parentInbox);
  expect(originalIds.map(id => broker.store.messagesById(id))).toEqual(retained);
});

it("rechecks actual broker registrations after storage yields, before native insertion", async () => {
  const { parent, address, broker } = await native();
  let entered!: () => void, release!: () => void;
  const ingress = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const original = broker.store.retryWrite.bind(broker.store); let held = false;
  vi.spyOn(broker.store, "retryWrite").mockImplementation(async (operation: any) => {
    if (!held && String(operation).includes("insertBatch")) { held = true; entered(); await gate; }
    return original(operation);
  });
  const attempt = parent.sendWithMode({ mode: "queue", to: address, body: "must not reach stale child" });
  // Attach the rejection assertion before releasing the genuine write boundary.
  const rejected = expect(attempt).rejects.toMatchObject({ code: "unauthorized" });
  await ingress;
  try { await parent.setSessionId("changed-during-admission"); } finally { release(); }
  await rejected;
  expect(broker.store.unread(address, 100)).toEqual([]);
});

it("a missing broker registration refuses queue instead of trusting caller session/generation labels", async () => {
  const { parent, address, childId, broker } = await native();
  const connection = [...broker.conns].find((conn: any) => conn.peer?.id === parent.id);
  const ready = connection.mailReady;
  // Negative admission fault only: no positive registration or authority is fabricated.
  connection.mailReady = undefined;
  try {
    await expect(parent.sendWithMode({ mode: "queue", to: address, body: "unknown generation" }))
      .rejects.toMatchObject({ code: "bad_request", details: { modeReport: { effective: "refused", capabilities: { generationKnown: false } } } });
  } finally { connection.mailReady = ready; }
  expect(await parent.nativeChildPending(childId)).toEqual([]);
});

it("old-opcode refusal crosses the real wire and only auto falls back to actual legacy mail", async () => {
  const host = env.node("old-mode-host"), sender = env.node("old-mode-sender"), receiver = env.node("old-mode-receiver");
  await host.start(); await sender.start(); await receiver.start();
  const broker = brokerOf(host);
  const unsupported = vi.spyOn(broker, "onModeSend").mockImplementation(() => { throw new BridgeError("bad_request", "unknown op: modeSend"); });
  const result = await sender.sendWithMode({ mode: "auto", to: receiver.name, body: "legacy auto" });
  expect(result.mode).toMatchObject({ protocolSupport: "legacy", effective: "legacyunconfirmed", stage: "requested" });
  await until(() => receiver.unread().length === 1);
  await expect(sender.sendWithMode({ mode: "queue", to: receiver.name, body: "no downgrade" })).rejects.toMatchObject({ code: "protocol_mismatch" });
  expect(unsupported).toHaveBeenCalledTimes(2); expect(receiver.unread()).toHaveLength(1);
});

it("untyped text, wrong typed opcode, timeout and lost ACK never retry/fall back", async () => {
  const { parent, address, childId } = await native();
  const client = wire(parent), original = client.request.bind(client), attempts: string[] = [];
  const legacy = vi.spyOn(parent, "send");
  const faults = [new Error("unknown op: modeSend"), new BridgeError("protocol_mismatch", "wrong opcode", { operation: "send" }),
    new Error("broker request timed out: modeSend"), Object.assign(new Error("broker closed"), { code: "BROKER_CONNECTION_CLOSED" })];
  for (const error of faults) {
    const fault = vi.spyOn(client, "request").mockImplementation(async (op, args: any) => {
      if (op === "modeSend") { attempts.push(op); throw error; } return original(op, args);
    });
    await expect(parent.sendWithMode({ mode: "auto", to: address, body: "no unsafe fallback" })).rejects.toBeInstanceOf(BridgeError);
    fault.mockRestore();
  }
  expect(attempts).toHaveLength(faults.length); expect(legacy).not.toHaveBeenCalled();
  expect(await parent.nativeChildPending(childId)).toEqual([]);
  // Fault injection loses the ACK only AFTER a real broker transaction succeeded.
  let submitted = 0;
  vi.spyOn(client, "request").mockImplementation(async (op, args: any) => {
    const result = await original(op, args);
    if (op === "modeSend") { submitted++; throw new Error("broker request timed out: modeSend"); }
    return result;
  });
  await expect(parent.sendWithMode({ mode: "queue", to: address, body: "ACK lost, original retained" })).rejects.toMatchObject({ code: "timeout", details: { modeReport: { stage: "unknown" } } });
  expect(submitted).toBe(1); expect(await parent.nativeChildPending(childId)).toHaveLength(1);
  expect(legacy).not.toHaveBeenCalled();
});

it("downstream opcode failure after real storage cannot masquerade as modeSend refusal", async () => {
  const host = env.node("downstream-mode-host"), sender = env.node("downstream-mode-sender"), receiver = env.node("downstream-mode-receiver");
  await host.start(); await sender.start(); await receiver.start();
  const broker = brokerOf(host), route = broker.routeSend.bind(broker);
  const attempts = vi.spyOn(broker, "routeSend").mockImplementation(async (...args: any[]) => {
    await route(...args);
    throw new BridgeError("bad_request", "unknown op: downstreamSend");
  });
  const fallback = vi.spyOn(sender, "send");
  await expect(sender.sendWithMode({ mode: "auto", to: receiver.name, body: "retained before downstream failure" }))
    .rejects.toMatchObject({ code: "timeout", details: { modeReport: { stage: "unknown" } } });
  await until(() => receiver.unread().length === 1);
  expect(attempts).toHaveBeenCalledTimes(1); expect(fallback).not.toHaveBeenCalled();
});

it("MCP explicit job modes refuse before lookup, title, settings or finished-job resume", async () => {
  const node = env.node("job-mode-owner"); await node.start();
  const jobs = new JobManager(node, nullLogger), resume = vi.fn(() => async () => ({ text: "must not execute", sessionId: "retained-session", isError: false, details: {} }));
  const job = jobs.track("codex", null, "retained task", resume).job;
  job.status = "done"; job.sessionId = "retained-session";
  const share = vi.spyOn(jobs, "share"), title = vi.spyOn(jobs, "setTitle"), settings = vi.spyOn(jobs, "setSettings"), follow = vi.spyOn(jobs, "followUp");
  const client = await tools(node, jobs);
  closes.push(async () => { jobs.cancelAll(); });
  for (const mode of ["queue", "steer", "restart"] as const) {
    const result = await client.callTool({ name: "message_subagent", arguments: { job: job.name, message: "unsafe continuation", title: "Changed title", effort: "high", mode } });
    expect(result.isError).toBe(true); expect(modeFrom(result)).toMatchObject({ requested: mode, effective: "refused", stage: "requested" });
    const direct = await client.callTool({ name: "send", arguments: { to: job.name, message: "unsafe direct job", mode } });
    expect(direct.isError).toBe(true);
  }
  for (const method of [share, title, settings, follow, resume]) expect(method).not.toHaveBeenCalled();
  expect(job.status).toBe("done"); expect(job.queue).toEqual([]);
});

it("native MCP guard honors mode without acknowledging mail or selecting another child", async () => {
  const { parent, address, childId } = await native();
  const stranger = env.node("scoped-mode-recipient", "codex"); await stranger.start();
  await parent.nativeChild({ agentId: childId, action: "grant", sendTo: [stranger.name] });
  const original = await parent.send({ to: address, body: "unconsumed original" });
  const ctx: ServerContext = { node: parent, home: env.home, cfg: DEFAULT_CONFIG, agent: "claude", log: nullLogger,
    cwd: () => env.home, channelActive: () => false, observeMeta: vi.fn() };
  const handlers = new Map<string, (a: any, e: any) => Promise<any>>();
  registerTools({ registerTool: (name: string, _spec: unknown, fn: any) => handlers.set(name, fn) } as any, ctx, []);
  const call = (args: any, meta: any = {}) => handlers.get("send")!(args, { signal: new AbortController().signal, _meta: meta });
  for (const mode of ["queue", "steer", "restart"] as const) {
    const result = await call({ native_child: childId, to: stranger.name, message: "child explicit refusal", mode });
    expect(result.isError).toBe(true); expect(modeFrom(result).effective).toBe("refused");
  }
  expect((await parent.nativeChildPending(childId)).map(m => m.id)).toContain(original.messages[0]!.id);
  expect((await call({ native_child: "spoofed-child", to: stranger.name, message: "spoof", mode: "auto" })).isError).toBe(true);
  expect((await call({ native_child: childId, to: stranger.name, message: "conflicting identity", mode: "auto" }, { agent_id: "different-child" })).isError).toBe(true);
  const automatic = await call({ native_child: childId, to: stranger.name, message: "scoped auto", mode: "auto" });
  expect(automatic.isError).not.toBe(true); expect(modeFrom(automatic)).toMatchObject({ effective: "mailbox", stage: "stored" });
  await until(() => stranger.unread().some(m => m.body === "scoped auto"));
  expect(ctx.observeMeta).not.toHaveBeenCalled();
});
