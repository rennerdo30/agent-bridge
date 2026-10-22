import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { COMPLETION_DEDUPE_PREFIX } from "../src/core/completion.js";
import * as delegate from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import { closeMetadataDbs } from "../src/core/metadata-db.js";
import { resolvePipePath } from "../src/core/paths.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import { recipientKey } from "../src/core/recipient-ownership.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import * as worktree from "../src/core/worktree.js";
import { JobRunners } from "../src/mcp/job-host.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { messageSchema, NetworkService } from "../src/network/link.js";
import { REMOTE_JOB_FRAME } from "../src/network/remote-job-protocol.js";
import { RemoteJobs } from "../src/network/remote-jobs.js";
import { fixtureConnection, fixturePeer } from "./owned-mail.js";

vi.mock("../src/core/usage.js", async original => ({ ...await original<typeof import("../src/core/usage.js")>(), checkUsagePreflight: async () => ({ type: "allow", reason: "unknown" }) }));
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); closeMetadataDbs(); vi.restoreAllMocks(); });

/** Only the authenticated transport is replaced. Both peer advertisements pass
 * the production parser; receive, registration, routing and persistence are real. */
async function hosts(hosted = false) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-remote-report-")));
  cleanups.push(() => { closeMetadataDbs(); rmSync(home, { recursive: true, force: true }); });
  vi.spyOn(delegate, "bundledCli").mockReturnValue("fixture-cli");
  vi.spyOn(delegate, "pidAlive").mockReturnValue(false);
  vi.spyOn(worktree, "gitDirsOutside").mockResolvedValue([]);
  vi.spyOn(JobRunners.prototype, "startAsync").mockResolvedValue({ pid: null, peer: "mock-runner", startedAt: Date.now() });
  const sourceHome = join(home, "source"), runnerHome = join(home, "runner");
  const sourceStore = new MessageStore(join(sourceHome, "bridge.db"), nullLogger);
  const supervisor = fixturePeer(sourceStore, "supervisor", { id: "supervisor-id", sessionId: "original-supervisor-session", cwd: home,
    ...(hosted ? { frontend: { kind: "t3", scope: "a".repeat(64), threadId: "original-thread", providerInstanceId: "codex" } as const } : {}) });
  const sourceRouter = new Broker("handler-only", sourceStore, nullLogger, "fixture") as any;
  const sourceConn = fixtureConnection(sourceStore, supervisor);
  Object.assign(sourceConn.socket, { writableLength: 0, write: () => true, destroy() {} });
  sourceRouter.conns.add(sourceConn);
  const sourceNetwork = new NetworkService(sourceHome, { ...DEFAULT_NETWORK_CONFIG, name: "source" }, {
    peers: () => [supervisor], receive: (message, destination) => sourceRouter.receiveRemote(message, destination),
  }, nullLogger);
  const sourceIdentity = sourceNetwork.status().identity!;
  mkdirSync(runnerHome, { recursive: true });
  writeFileSync(join(runnerHome, "config.json"), JSON.stringify({ version: 4,
    network: { ...DEFAULT_NETWORK_CONFIG, remoteJobs: { enabled: true, allowRoots: [home], agents: ["codex"], allowPeers: [sourceIdentity.name] } } }));
  const token = loadOrCreateToken(runnerHome), pipe = resolvePipePath(runnerHome, {});
  let store = new MessageStore(join(runnerHome, "bridge.db"), nullLogger);
  let broker = new Broker(pipe, store, nullLogger, token, Date.now, join(runnerHome, "jobs.json")) as any;
  const makeNetwork = () => new NetworkService(runnerHome, { ...DEFAULT_NETWORK_CONFIG, name: "runner" }, {
    peers: () => broker.localPeers(), receive: (message, destination) => broker.receiveRemote(message, destination),
    pinDestination: (message, destination) => store.pinDestination(message, destination),
    pinnedDestinations: id => store.pinnedDestinations(id),
  }, nullLogger);
  let network = makeNetwork();
  const runnerIdentity = network.status().identity!;
  const responses: any[] = [], frames: BridgeMessage[] = [];
  let responseReceiver: ((type: string, response: unknown) => Promise<void>) | undefined;
  let loseAck = false, disconnectBeforeReceive = false;
  const link = { remote: { ...sourceIdentity }, peers: sourceNetwork.localPeers(),
    recipientOwnershipV1: true, nativeOwnershipV1: true, mailboxProvenanceV1: true, t3ThreadRouting: true,
    supports: () => true, refresh() {}, writeExtension: async (type: string, response: unknown) => { responses.push(response); await responseReceiver?.(type, response); },
    send: async (raw: BridgeMessage, destination: any) => {
      const message = messageSchema.parse(raw);
      const sender = network.localPeers().find(p => p.id === message.from.id && p.name === message.from.name);
      expect(sender && recipientKey(sender.frontend, sender.nativeOwner)).toBe(message.senderOwner);
      frames.push(message);
      if (disconnectBeforeReceive) { disconnectBeforeReceive = false; throw new Error("mock disconnect before remote storage"); }
      const result = sourceNetwork.receive({ ...message,
        from: { ...message.from, id: `${runnerIdentity.id}/${message.from.id}`, name: `${runnerIdentity.name}/${message.from.name}` },
        senderMailbox: { kind: "remote", hostId: runnerIdentity.id, hostFingerprint: runnerIdentity.fingerprint } }, destination);
      if (loseAck) { loseAck = false; throw new Error("mock transport lost ACK after durable receive"); }
      return result;
    } };
  (network as any).links.set(sourceIdentity.id, link);
  broker.network = network;
  let remote = new RemoteJobs(network, runnerHome, nullLogger, async () => {}); broker.remoteJobs = remote;
  await broker.listen();
  cleanups.push(async () => { remote.close(); broker.network = null; await broker.close(); await sourceRouter.close(); });
  const job = "1234abcd", owner = `${sourceIdentity.name}/${supervisor.name}`;
  const peer = { id: supervisor.id, name: supervisor.name, supervisor: supervisor.sessionId! };
  await network.receiveExtension(REMOTE_JOB_FRAME, { kind: "request", rid: randomUUID(), peer,
    request: { op: "spawn", job, target: "codex", args: { cwd: home, prompt: "retained remote context", title: "remote report" } } }, sourceIdentity as any);
  expect(responses[0]?.error).toBeUndefined(); expect(remote.jobForRegistration(job)).toBeDefined();
  const clients: BridgeClient[] = [];
  cleanups.push(() => { for (const client of clients) client.close(); });
  const connect = async (jobParent = owner, jobOwner = `${sourceIdentity.id}/${supervisor.sessionId}`) => {
    const client = await BridgeClient.connect(pipe, nullLogger); clients.push(client);
    await client.request("hello", { protocol: PROTOCOL_VERSION, token, peer: { id: `job:${job}`, name: `codex-job-${job}`, agent: "other", jobAgent: "codex",
      jobOwner, jobParent, cwd: home, pid: process.pid, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false } });
    return client;
  };
  let requester: RemoteJobs | undefined, lookup: ReturnType<typeof vi.spyOn> | undefined;
  const requestState = (peer = supervisor) => {
    if (!requester) {
      requester = new RemoteJobs(sourceNetwork, sourceHome, nullLogger, async () => {});
      cleanups.push(() => requester!.close());
      lookup = vi.spyOn(remote as any, "handle");
      (sourceNetwork as any).links.set(runnerIdentity.id, { remote: runnerIdentity, supports: () => true,
        // Only the authenticated transport is replaced: production sendExtension
        // must publish the canonical new advertisement before the request frame.
        refresh: () => { link.peers = sourceNetwork.localPeers(); },
        writeExtension: (type: any, payload: Record<string, unknown>) => network.receiveExtension(type, payload, sourceIdentity as any) });
      responseReceiver = (type: any, payload: any) => Promise.resolve(sourceNetwork.receiveExtension(type, payload, runnerIdentity as any));
    }
    return requester.request(runnerIdentity.id, peer, { op: "state", job: "87654321" });
  };
  return { get store() { return store; }, sourceStore, supervisor, link, frames, owner, connect, sourceIdentity,
    requestState, lookups: () => lookup?.mock.calls.length ?? 0,
    lostAck: () => { loseAck = true; },
    disconnect: () => { disconnectBeforeReceive = true; },
    legacyRecord: () => {
      const file = join(runnerHome, "remote-jobs.json"), doc = JSON.parse(readFileSync(file, "utf8"));
      delete doc.jobs[0].returnRoute; writeFileSync(file, JSON.stringify(doc));
      return { file, bytes: readFileSync(file, "utf8") };
    },
    recover: async () => {
      remote.close(); broker.network = null; await broker.close();
      store = new MessageStore(join(runnerHome, "bridge.db"), nullLogger);
      broker = new Broker(pipe, store, nullLogger, token, Date.now, join(runnerHome, "jobs.json")) as any;
      network = makeNetwork(); (network as any).links.set(sourceIdentity.id, link); broker.network = network;
      remote = new RemoteJobs(network, runnerHome, nullLogger, async () => {}); broker.remoteJobs = remote;
      await broker.listen();
    },
  };
}

it("reaches remote lookup for a freshly advertised native supervisor with the peer-refresh fixture identity", async () => {
  const h = await hosts();
  const originalSession = h.supervisor.sessionId;
  // A freshly advertised name without native identity must fail before lookup.
  h.supervisor.sessionId = null; h.supervisor.agentPid = null;
  h.link.peers = [];
  await expect(h.requestState()).rejects.toThrow("Remote supervisor return ownership is unproven");
  expect(h.lookups()).toBe(0);
  // Restore the exact session minted by the actual source store, not a static
  // nativeOwner string. The production request path must refresh this binding.
  h.supervisor.sessionId = originalSession;
  await expect(h.requestState()).rejects.toThrow("Unknown remote job.");
  expect(h.lookups()).toBe(1);
  await expect(h.requestState({ ...h.supervisor, id: randomUUID() })).rejects.toThrow("not an advertised supervisor");
  expect(h.lookups()).toBe(1);
});

it.each([false, true])("retains the real paired supervisor report across lost ACK, registry reload and runner reconnect (hosted=%s)", async hosted => {
  const h = await hosts(hosted); let runner = await h.connect();
  const args = { messageId: randomUUID(), to: h.owner, body: "Original final report: exact retained bytes", conversationId: "job-1234abcd" };
  h.lostAck(); await expect(runner.request("trackedSend", args)).rejects.toThrow("mock transport lost ACK");
  expect(h.sourceStore.messagesById(args.messageId)).toHaveLength(1);
  expect(h.store.pinnedSends(args.messageId)).toHaveLength(1);
  expect(h.store.jobRoutingGrant(args.messageId)).toBeNull();
  runner.close(); await h.recover(); runner = await h.connect();
  const retry = await runner.request("trackedSend", args);
  expect(retry.storage?.state).toBe("stored");
  expect(h.sourceStore.messagesById(args.messageId)).toHaveLength(1);
  expect(h.frames.every(frame => frame.to === h.owner && frame.body === args.body)).toBe(true);
  const copy = h.sourceStore.messagesById(args.messageId)[0]!;
  expect(recipientKey(copy.recipientFrontend, copy.recipientNative)).toBe(recipientKey(h.link.peers[0]!.frontend, h.link.peers[0]!.nativeOwner));
  expect(copy.senderMailbox?.kind).toBe("remote");
  expect(h.store.pinnedSends(args.messageId)[0]!.destination).toMatchObject({ hostId: h.sourceIdentity.id, hostFingerprint: h.sourceIdentity.fingerprint, name: h.supervisor.name });
  await expect(runner.request("trackedSend", { ...args, body: "changed report" })).rejects.toMatchObject({ code: "bad_request" });
  expect(h.sourceStore.messagesById(args.messageId)).toHaveLength(1);
});

it("refuses replacement remote supervisor or host before retaining a new report intent", async () => {
  const h = await hosts(), runner = await h.connect();
  const original = h.link.peers;
  h.link.peers = original.map(p => ({ ...p, nativeOwner: JSON.stringify({ kind: "session", agent: "codex", sessionId: "replacement" }), sessionId: "replacement" }));
  const args = { messageId: randomUUID(), to: h.owner, body: "Never hand final report to replacement" };
  await expect(runner.request("trackedSend", args)).rejects.toThrow();
  expect(h.store.sendIntentOwner(args.messageId)).toBeUndefined(); expect(h.frames).toHaveLength(0);
  h.link.peers = original; h.link.remote = { ...h.sourceIdentity, id: randomUUID() };
  await expect(runner.request("trackedSend", args)).rejects.toThrow();
  expect(h.store.sendIntentOwner(args.messageId)).toBeUndefined(); expect(h.frames).toHaveLength(0);
});

it.each(["note", "question", "cancelled-final"])("routes the original paired %s envelope without local job grants", async kind => {
  const h = await hosts(), runner = await h.connect();
  const args = { messageId: randomUUID(), to: h.owner, body: `${kind} accepted bytes`,
    conversationId: `job-1234abcd${kind === "cancelled-final" ? "" : `:${kind}`}` };
  const sent = kind === "cancelled-final" ? await runner.request("send", { ...args, messageId: undefined,
    dedupeKey: `${COMPLETION_DEDUPE_PREFIX}11111111-1111-4111-8111-111111111111` }) : await runner.request("trackedSend", args);
  const id = sent.messages[0]!.id;
  expect(h.sourceStore.messagesById(id)).toHaveLength(1);
  expect(h.sourceStore.messagesById(id)[0]).toMatchObject({ to: h.owner, body: args.body, conversationId: args.conversationId });
  expect(h.store.jobRoutingGrant(id)).toBeNull();
  expect(sent.messages).toHaveLength(1); expect(h.frames).toHaveLength(1);
  if (kind === "cancelled-final") {
    await runner.request("send", { ...args, messageId: undefined, dedupeKey: `${COMPLETION_DEDUPE_PREFIX}11111111-1111-4111-8111-111111111111` });
    expect(h.sourceStore.messagesById(id)).toHaveLength(1); expect(h.frames).toHaveLength(1);
  }
});

it("rolls back remote request admission when the exact destination cannot be persisted, then retries original bytes", async () => {
  const h = await hosts(), runner = await h.connect();
  const args = { messageId: randomUUID(), to: h.owner, body: "Atomic intent plus original destination" };
  const fail = vi.spyOn(h.store, "pinDestination").mockImplementationOnce(() => { throw new Error("injected pin write failure"); });
  await expect(runner.request("trackedSend", args)).rejects.toThrow("injected pin write failure");
  expect(h.store.sendIntentOwner(args.messageId)).toBeUndefined(); expect(h.store.pinnedSends(args.messageId)).toEqual([]); expect(h.frames).toHaveLength(0);
  fail.mockRestore(); await runner.request("trackedSend", args);
  expect(h.sourceStore.messagesById(args.messageId)).toHaveLength(1);
});

it("withholds all remote capability omissions before intent and payload effects", async () => {
  const h = await hosts(), runner = await h.connect();
  for (const cap of ["recipientOwnershipV1", "nativeOwnershipV1", "mailboxProvenanceV1"] as const) {
    h.link[cap] = false;
    const args = { messageId: randomUUID(), to: h.owner, body: "Capability-fenced report" };
    await expect(runner.request("trackedSend", args)).rejects.toMatchObject({ code: "unknown_target" });
    expect(h.store.sendIntentOwner(args.messageId)).toBeUndefined(); expect(h.store.pinnedSends(args.messageId)).toEqual([]);
    h.link[cap] = true;
  }
  expect(h.frames).toHaveLength(0);
});

it("retains unproven legacy remote return evidence without guessing a current supervisor, even without caller jobParent", async () => {
  const h = await hosts(), legacy = h.legacyRecord(); await h.recover();
  const runner = await h.connect("");
  const args = { messageId: randomUUID(), to: h.owner, body: "Legacy report remains recoverable" };
  await expect(runner.request("trackedSend", args)).rejects.toMatchObject({ code: "unauthorized" });
  expect(h.store.sendIntentOwner(args.messageId)).toBeUndefined(); expect(h.frames).toHaveLength(0);
  expect(readFileSync(legacy.file, "utf8")).toBe(legacy.bytes);
});

it("refuses changed binding or fingerprint on a pinned retry after receiver storage and source restart", async () => {
  const h = await hosts(), runner = await h.connect();
  const args = { messageId: randomUUID(), to: h.owner, body: "Retained sender and destination proof" };
  h.lostAck(); await expect(runner.request("trackedSend", args)).rejects.toThrow("mock transport lost ACK");
  runner.close(); await h.recover(); const retry = await h.connect();
  const original = h.link.peers, originalPin = h.store.pinnedSends(args.messageId);
  h.link.peers = original.map(p => ({ ...p, nativeOwner: JSON.stringify({ kind: "session", agent: "codex", sessionId: "replacement" }) }));
  await expect(retry.request("trackedSend", args)).rejects.toMatchObject({ code: "unknown_target" });
  h.link.peers = original; h.link.remote.fingerprint = "b".repeat(64);
  await expect(retry.request("trackedSend", args)).rejects.toMatchObject({ code: "unknown_target" });
  expect(h.frames).toHaveLength(1); expect(h.sourceStore.messagesById(args.messageId)).toHaveLength(1);
  expect(h.store.pinnedSends(args.messageId)).toEqual(originalPin);
});

it("retains the first authenticated destination before remote storage and survives a host display rename", async () => {
  const h = await hosts(), runner = await h.connect();
  const args = { messageId: randomUUID(), to: h.owner, body: "Original before-dispatch crash evidence" };
  h.disconnect(); await expect(runner.request("trackedSend", args)).rejects.toThrow("mock disconnect before remote storage");
  expect(h.sourceStore.messagesById(args.messageId)).toHaveLength(0);
  const retained = h.store.pinnedSends(args.messageId); expect(retained).toHaveLength(1);
  runner.close(); await h.recover(); const next = await h.connect();
  h.link.remote.name = "renamed-source";
  const sent = await next.request("trackedSend", args);
  expect(sent.storage?.state).toBe("stored");
  expect(h.sourceStore.messagesById(args.messageId)).toHaveLength(1);
  expect(h.sourceStore.messagesById(args.messageId)[0]!.to).toBe(h.owner);
  expect(h.store.pinnedSends(args.messageId)).toEqual(retained);
});
