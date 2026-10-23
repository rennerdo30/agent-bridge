import { createHash, randomUUID } from "node:crypto";
import { localMailbox } from "../src/core/recipient-ownership.js";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import * as processIdentities from "../src/core/process-identity.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import type { BridgeMessage, PeerInfo } from "../src/core/protocol.js";
import { encodeFrame, FrameDecoder } from "../src/core/protocol.js";
import { MessageStore, migrateMessageSchema } from "../src/core/store.js";
import { JobManager } from "../src/mcp/jobs.js";
import { commitHandoff } from "../src/core/job-handoff.js";
import { readJsonStore, writeJsonStore } from "../src/core/json-store.js";
import { ReadJournal } from "../src/core/read-journal.js";
import { closeMetadataDb, metadataDb } from "../src/core/metadata-db.js";
import { localResultReceipt } from "../src/core/local-result-receipts.js";
import { BridgeClient } from "../src/core/client.js";
import { BridgeNode as LiveBridgeNode } from "../src/core/node.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { resolvePipePath } from "../src/core/paths.js";
import { DatabaseSync } from "node:sqlite";
import { messageBackupIfDue } from "../src/core/message-backups.js";
import { attachStoreCompatibility } from "../src/core/store-compatibility-overlay.js";
import { ConversationIngestor } from "../src/core/conversations.js";
import { transcriptPaths } from "../src/core/transcripts/index.js";
import { migrateHistoryStore } from "../src/core/history-store.js";
import { T3Host, T3_TOOL_NAMES } from "../src/core/t3-host.js";
import type { T3Binding } from "../src/core/t3-identity.js";
import { NetworkService, type NetworkDestination } from "../src/network/link.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { T3Waker } from "../src/mcp/t3-wake.js";
import { until } from "./helpers.js";
import { fixtureAck, fixturePeer, fixtureRoleMessage, unreadOwned } from "./owned-mail.js";

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
vi.mock("../src/core/transcripts/index.js", async original => {
  const actual = await original<typeof import("../src/core/transcripts/index.js")>();
  return { ...actual, transcriptPaths: () => ({ claude: join(home, "empty-claude"), codex: join(home, "empty-codex"), opencode: join(home, "empty-opencode"), antigravity: join(home, "empty-antigravity"), muse: join(home, "empty-muse") }) };
});

// Real brokers, durable stores, authenticated hello/helloT3 and production queue
// recovery. Only OS identity/ACL probes and provider execution remain mocked.
async function persistentHost(name: string, folder = name) {
  const dir = join(home, folder); mkdirSync(dir, { recursive: true });
  cleanup.push(() => closeMetadataDb(dir));
  const pipe = resolvePipePath(dir, {}), db = join(dir, "bridge.db"), token = "isolated-fixture-token";
  const store = new MessageStore(db, nullLogger);
  const broker = new Broker(pipe, store, nullLogger, token, Date.now, undefined,
    { home: dir, config: { ...DEFAULT_NETWORK_CONFIG, enabled: true, name, bind: "127.0.0.1", port: 0, discovery: false } });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await broker.close(); } };
  cleanup.push(close); await broker.listen();
  // This fixture drives archive/history transitions explicitly. Give it sole
  // writer scheduling instead of racing unrelated background maintenance.
  store.quiesceLifecycleMaintenance();
  const admin = await BridgeClient.connect(pipe, nullLogger); cleanup.push(() => admin.close());
  await admin.request("auth", { protocol: PROTOCOL_VERSION, token });
  const network = (broker as any).network as NetworkService;
  expect(network).toBeDefined();
  const register = async (frontend?: T3Binding, name = "destination", cwd = home, sessionId: string | null = "same-native-provider-id", extra: Partial<PeerInfo> = {}) => {
    const client = await BridgeClient.connect(pipe, nullLogger); cleanup.push(() => client.close());
    await client.request("auth", { protocol: PROTOCOL_VERSION, token });
    const events: BridgeMessage[] = [];
    client.on("event", (event, data) => { if (event === "message") events.push(data as BridgeMessage); });
    const registration = peer(name, frontend);
    registration.cwd = cwd;
    registration.sessionId = sessionId;
    Object.assign(registration, extra);
    const hello = await client.request(frontend ? "helloT3" : "hello", { protocol: PROTOCOL_VERSION, token, peer: registration });
    registration.name = hello.name;
    return { client, events, peer: registration };
  };
  return { broker, store, network, dir, pipe, db, token, admin, close, register };
}

/** Explicit isolated selected-table restore, including the captured namespace. */
function restoreMessageBackup(backup: string, folder: string): MessageStore {
  const dir = join(home, folder); mkdirSync(dir);
  const store = new MessageStore(join(dir, "bridge.db"), nullLogger); cleanup.push(() => store.close());
  for (const [snapshot, destination] of [["bridge.messages.db", "bridge.db"], ["archive.messages.db", "archive.db"]]) {
    const source = join(backup, snapshot!); if (!existsSync(source)) continue;
    const db = new DatabaseSync(join(dir, destination!));
    try {
      db.prepare("ATTACH DATABASE ? AS selected_snapshot").run(source);
      for (const row of db.prepare("SELECT name FROM selected_snapshot.sqlite_master WHERE type='table'").all()) {
        const name = String(row.name); if (!/^[a-z_]+$/.test(name)) throw new Error("unexpected snapshot table");
        if (name === "mailbox_store") db.exec("DELETE FROM main.mailbox_store");
        db.exec(`INSERT OR IGNORE INTO main.${name} SELECT * FROM selected_snapshot.${name}`);
      }
    } finally { db.close(); }
  }
  return store;
}

it.each(["session", "provider", "process", "incarnation", "missing"])("fences native exact-name mail across %s replacement and recovers only the original identity", async change => {
  let host = await persistentHost("pc-b");
  const processProof = { agentPid: 111111, agentStartedAt: "fixture-process-identity" };
  const processIdentity = change === "process" || change === "incarnation";
  const session = processIdentity || change === "missing" ? null : "native-A";
  const first = await host.register(undefined, "destination", host.dir, session, processIdentity ? processProof : {});
  const sender = await host.register(binding("a", "sender"), "sender"), id = randomUUID();
  await sender.client.request("trackedSend", { messageId: id, to: "destination", body: "native A private mail" });
  const original = host.store.byId(id)!;
  first.client.close(); await host.close(); host = await persistentHost("pc-b");
  const next = await host.register(undefined, "destination", host.dir, change === "session" ? "native-B" : session,
    change === "process" ? { ...processProof, agentPid: 222222 } : change === "incarnation" ? { ...processProof, agentStartedAt: "reused-pid-new-creation" } : change === "provider" ? { agent: "other" } : {});
  expect((await next.client.request("pending", {})).map(m => m.id)).not.toContain(id);
  expect(next.events.filter(m => m.id === id)).toEqual([]);
  expect(await next.client.request("ack", { ids: [id], mailboxProofs: proof(original), nativeOwners: { [id]: original.recipientNative! } })).toEqual({ acked: 0 });
  next.client.close(); await until(() => !(host.broker as any).localPeers().length);
  const returned = await host.register(undefined, "reconnected-A", host.dir, session, processIdentity ? processProof : {});
  expect((await returned.client.request("pending", {})).some(m => m.id === id)).toBe(change !== "missing");
});

it("does not reuse a prior native session's cached legacy-send receipt after session update", async () => {
  const host = await persistentHost("pc-a"), sender = await host.register(undefined, "sender", host.dir, "native-A");
  await host.register(binding("a", "destination"));
  const request = { to: "destination", body: "new authority uses its own operation", dedupeKey: "same-ui-request" };
  const first = await sender.client.request("send", request);
  await sender.client.request("updatePeer", { sessionId: "native-B" });
  const next = await sender.client.request("send", request);
  expect(next.messages[0]!.id).not.toBe(first.messages[0]!.id);
  await expect(sender.client.request("sendState", { id: first.messages[0]!.id })).rejects.toThrow(/ownership|identity|sender/i);
});

it("fences retained native sender authority across same-name replacement and allows the same session reconnect", async () => {
  let host = await persistentHost("pc-a"), sender = await host.register(undefined, "sender", host.dir, "sender-A");
  await host.register(binding("a", "destination")); const args = { messageId: randomUUID(), to: "destination", body: "original native sender" };
  await sender.client.request("trackedSend", args); await host.close(); host = await persistentHost("pc-a");
  const replacement = await host.register(undefined, "sender", host.dir, "sender-B");
  await expect(replacement.client.request("sendState", { id: args.messageId })).rejects.toThrow(/ownership|sender|identity/i);
  await expect(replacement.client.request("trackedSend", args)).rejects.toThrow(/ownership|sender|identity/i);
  replacement.client.close(); await until(() => !(host.broker as any).localPeers().length);
  sender = await host.register(undefined, "sender", host.dir, "sender-A");
  expect((await sender.client.request("sendState", { id: args.messageId })).state).toBe("stored");
});

it("refuses remote native receipts and duplicates from a same-name replacement sender and accepts the original sender reconnect", async () => {
  const a = await persistentHost("pc-a"), b = await persistentHost("pc-b");
  let sender = await a.register(undefined, "sender", a.dir, "sender-A");
  const destination = await b.register(undefined, "destination", b.dir, "recipient-A");
  await pairPersistent(a, b); const id = randomUUID(), args = { messageId: id, to: "pc-b/destination", body: "authenticated native sender" };
  await sender.client.request("trackedSend", args);
  const copy = (await destination.client.request("pending", {})).find(m => m.id === id)!;
  const source = a.network.status().identity!;
  expect(copy.senderMailbox).toEqual({ kind: "remote", hostId: source.id, hostFingerprint: source.fingerprint });
  const outgoing = a.store.byId(id)!;
  await link(a.network).send({ ...outgoing, recipient: "destination", senderMailbox: { kind: "remote", hostId: randomUUID(), hostFingerprint: "0".repeat(64) }, recipientMailbox: { kind: "local", namespace: a.store.namespace } },
    { peerId: destination.peer.id, native: copy.recipientNative });
  expect(b.store.byId(id)?.senderMailbox).toEqual(copy.senderMailbox);
  await destination.client.request("ack", { ids: [id], mailboxProofs: proof(copy), nativeOwners: { [id]: copy.recipientNative! } });
  expect((await sender.client.request("messageReceipt", { id }))[0]!.readAt).not.toBeNull();
  sender.client.close(); await until(() => !(a.broker as any).localPeers().length);
  const replacement = await a.register(undefined, "sender", a.dir, "sender-B"); link(a.network).refresh();
  await until(() => b.network.peers().some(p => p.sessionId === "sender-B"));
  await expect(link(a.network).receipt(id, replacement.peer.id, "destination")).rejects.toThrow(/original.*sender|ownership/i);
  const incoming = { ...message(replacement.peer, "destination"), id, to: args.to, body: args.body, conversationId: id,
    senderOwner: `native:${JSON.stringify({ kind: "session", agent: "codex", sessionId: "sender-B" })}` };
  await expect(link(a.network).send(incoming, { peerId: destination.peer.id, native: b.network.localPeers()[0]!.nativeOwner })).rejects.toThrow(/sender ownership|different content/i);
  expect(b.store.messagesById(id)).toHaveLength(1);
  replacement.client.close(); await until(() => !(a.broker as any).localPeers().length);
  sender = await a.register(undefined, "sender", a.dir, "sender-A");
  expect((await sender.client.request("messageReceipt", { id }))[0]!.readAt).not.toBeNull();
});

const ownerQuestion = () => ({ title: "Choose the exact scope", topic: "scope", context: "Private scoped answer.", options: [
  { id: "small", label: "Small", consequence: "Narrow work", recommended: true },
  { id: "large", label: "Large", consequence: "More work", recommended: false }], blocking: true, blocks: "Scope decision", meanwhile: "Independent checks" });
it.each(["native-online", "hosted-online", "native-replaced", "hosted-replaced"])("delivers owner answers to the proven original recipient (%s) without silent settlement", async scenario => {
  let host = await persistentHost("pc-b"), frontend = scenario.startsWith("hosted") ? binding("b", "asker-A") : undefined;
  let asker = await host.register(frontend, "asker", host.dir, "asker-A");
  const q = (await asker.client.request("askOwner", ownerQuestion())).question;
  if (scenario.endsWith("replaced")) {
    asker.client.close(); await host.close(); host = await persistentHost("pc-b");
    const replacement = await host.register(frontend ? binding("b", "asker-B") : undefined, "asker", home, "asker-B");
    await host.admin.request("answerOwner", { id: q.id, answer: { text: "Exact owner answer" } });
    expect((await replacement.client.request("pending", {})).filter(m => m.replyTo === q.id)).toEqual([]);
    replacement.client.close(); await until(() => !(host.broker as any).localPeers().length);
    asker = await host.register(frontend, "asker-reconnected", host.dir, "asker-A");
  } else await host.admin.request("answerOwner", { id: q.id, answer: { text: "Exact owner answer" } });
  const delivered = (await asker.client.request("pending", {})).find(m => m.replyTo === q.id);
  expect(delivered?.body).toContain("Exact owner answer");
  expect(delivered?.recipientAmbiguous).toBeUndefined();
  if (frontend) expect(delivered?.recipientFrontend).toEqual(frontend); else expect(delivered?.recipientNative).toBeTruthy();
  expect(await asker.client.request("ack", { ids: [delivered!.id], mailboxProofs: proof(delivered!), nativeOwners: { [delivered!.id]: delivered!.recipientNative! } })).toEqual({ acked: 1 });
  const recorded = (await host.admin.request("ownerQuestions", {})).find(item => item.id === q.id)!;
  expect(recorded.deliveries.some(d => d.messageId === delivered!.id && d.readAt !== null)).toBe(true);
});

it("does not settle an answered historical question whose original binding is unavailable", async () => {
  const host = await persistentHost("pc-b"), asker = await host.register(binding("b", "asker-A"), "asker", host.dir);
  const q = (await asker.client.request("askOwner", ownerQuestion())).question;
  const service = (host.broker as any).ownerQuestions();
  for (const a of q.askers) { delete a.owner; delete a.mainOwner; delete a.jobOwner; }
  q.deliveryComplete = true; service.store.save(q);
  const answered = await host.admin.request("answerOwner", { id: q.id, answer: { text: "Retain this pending answer" } });
  const original = answered.deliveries.filter(d => !d.owner);
  expect(original.length).toBeGreaterThan(0); expect(original.every(d => d.state === "pending" && !d.messageId)).toBe(true);
  expect(answered.deliveryComplete).toBe(false); expect(service.store.work().some((item: any) => item.id === q.id)).toBe(true);
});

it("keeps project-main change notices with the original native sender after its name is reused", async () => {
  const host = await persistentHost("pc-b"), main = await host.register(binding("b", "main-A"), "main-A", host.dir);
  const sender = await host.register(undefined, "prior-sender", host.dir, "native-A");
  await sender.client.request("trackedSend", { messageId: randomUUID(), to: "project:pc-b", body: "prior project request" });
  const next = await host.register(binding("b", "main-B"), "main-B", host.dir);
  sender.client.close(); await until(() => !(host.broker as any).localPeers().some((p: PeerInfo) => p.id === sender.peer.id));
  const replacement = await host.register(undefined, "prior-sender", host.dir, "native-B");
  await main.client.request("projectMain", { to: next.peer.name });
  await until(() => host.store.unread(main.peer.name, 100, main.peer.frontend).some(m => m.conversationId.startsWith("project-main-")));
  expect((await replacement.client.request("pending", {})).filter(m => m.conversationId.startsWith("project-main-"))).toEqual([]);
  const original = await host.register(undefined, "returned-sender", host.dir, "native-A");
  expect((await original.client.request("pending", {})).some(m => m.conversationId.startsWith("project-main-"))).toBe(true);
});

it("delivers decisions independently to exact frontends and does not settle an unproved native recipient", async () => {
  const host = await persistentHost("pc-b"), first = await host.register(binding("b", "decision-A"), "first", host.dir),
    second = await host.register(binding("b", "decision-B"), "second", host.dir), unknown = await host.register(undefined, "unknown", host.dir, null);
  const result = await first.client.request("decide", { topic: "ownership scope", text: "Every intended frontend must see this", scope: { project: host.dir } });
  for (const recipient of [first, second]) expect((await recipient.client.request("pending", {})).some(m => m.conversationId === `decision-${result.decision.id}`)).toBe(true);
  expect((await unknown.client.request("pending", {})).filter(m => m.conversationId === `decision-${result.decision.id}`)).toEqual([]);
  await unknown.client.request("updatePeer", { sessionId: "now-proven-native" });
  expect((await unknown.client.request("pending", {})).some(m => m.conversationId === `decision-${result.decision.id}`)).toBe(true);
});

it("replays handoff notices against the owner captured at commit rather than a replacement name", async () => {
  const host = await persistentHost("pc-b"), source = await host.register(binding("b", "source"), "source", host.dir),
    target = await host.register(undefined, "target", host.dir, "target-A");
  const jobsPath = join(host.dir, "jobs.json"), job = { id: randomUUID(), name: "fixture-job", agent: "codex", owner: source.peer.name,
    supervisor: "fixture-root", rootSession: "fixture-root", rootName: source.peer.name, projectRoot: host.dir, status: "done", startedAt: Date.now(), args: { cwd: host.dir } };
  writeJsonStore(jobsPath, { jobs: [job] }, null);
  const receipt = commitHandoff(jobsPath, source.peer, target.peer, { to: target.peer.name, jobs: [job.name] });
  target.client.close(); await until(() => !(host.broker as any).localPeers().some((p: PeerInfo) => p.id === target.peer.id));
  const replacement = await host.register(undefined, "target", host.dir, "target-B");
  (host.broker as any).jobsPath = jobsPath; (host.broker as any).applyHandoffs();
  expect((await replacement.client.request("pending", {})).filter(m => m.conversationId === `handoff-${receipt.id}`)).toEqual([]);
  const original = await host.register(undefined, "returned-target", host.dir, "target-A");
  expect((await original.client.request("pending", {})).some(m => m.conversationId === `handoff-${receipt.id}`)).toBe(true);
});

it.each([false, true])("recovers a persisted job completion through its captured owner without launching a provider (%s)", async hosted => {
  let host = await persistentHost("pc-b"); const frontend = hosted ? binding("b", "job-owner-A") : undefined;
  const node = liveRecipient(host, frontend); await node.setSessionId("job-owner-A"); await node.start();
  const jobsPath = join(host.dir, "jobs.json"); (host.broker as any).jobsPath = jobsPath;
  const manager = new JobManager(node, nullLogger, jobsPath);
  const job = (manager as any).newJob("codex", null, "offline producer fixture", "job", undefined, { cwd: host.dir });
  job.status = "done"; job.report = "private completion"; job.finishedAt = Date.now();
  (manager as any).history.set(job.id, job); (manager as any).own.add(job.id);
  const socket = (node as any).client.socket, write = socket.write.bind(socket); let reached!: () => void;
  const interrupted = new Promise<void>(resolve => reached = resolve);
  vi.spyOn(socket, "write").mockImplementation(((data: any, ...args: any[]) => {
    if (String(data).includes('"op":"inlineJobReport"')) { (node as any).client.close(); reached(); throw new Error("fixture stopped before completion dispatch"); }
    return write(data, ...args);
  }) as any);
  const id = (manager as any).post(job, "Subagent fixture done after 1s.\nprivate completion");
  await interrupted; expect(host.store.byId(id)).toBeNull(); await node.stop(); await host.close();
  host = await persistentHost("pc-b"); (host.broker as any).jobsPath = jobsPath;
  const replacement = await host.register(frontend ? binding("b", "job-owner-B") : undefined, "destination", host.dir, "job-owner-B");
  await (host.broker as any).routePendingJobMail();
  expect((await replacement.client.request("pending", {})).map(m => m.id)).not.toContain(id);
  const original = await host.register(frontend, "returned-owner", host.dir, "job-owner-A");
  await (host.broker as any).routePendingJobMail();
  expect((await original.client.request("pending", {})).find(m => m.id === id)?.body).toContain("private completion");
  expect((host.store as any).db.prepare("SELECT recipient FROM job_delivery_routes WHERE id=?").get(id)?.recipient).toBe(original.peer.name);
});

it("fences native-child mail by its incarnation and retains recovery for its original parent", async () => {
  let host = await persistentHost("pc-b"), parent = await host.register(undefined, "parent", host.dir, "parent-A", { agent: "claude" });
  const child = await parent.client.request("nativeChild", { agentId: "worker", action: "start" });
  const id = randomUUID(); await parent.client.request("trackedSend", { messageId: id, to: child!.address, body: "old child private mail" });
  const original = (await parent.client.request("nativeChildPending", { agentId: "worker" })).find(m => m.id === id)!;
  expect(original.id).toBe(id);
  await host.close(); host = await persistentHost("pc-b");
  const next = await host.register(undefined, "parent", host.dir, "parent-B", { agent: "claude" });
  await next.client.request("nativeChild", { agentId: "worker", action: "start" });
  expect(await next.client.request("nativeChildAck", { agentId: "worker", ids: [id], mailboxProofs: proof(original) })).toEqual({ acked: 0 });
  expect((await next.client.request("pending", {})).map(m => m.id)).not.toContain(id);
  next.client.close(); await until(() => !(host.broker as any).localPeers().length);
  parent = await host.register(undefined, "returned-parent", host.dir, "parent-A", { agent: "claude" });
  expect((await parent.client.request("pending", {})).map(m => m.id)).toContain(id);
});

it("refuses a previous child's send identity after the same parent session creates another child incarnation", async () => {
  const host = await persistentHost("pc-b"); let parent = await host.register(undefined, "parent", host.dir, "same-parent", { agent: "claude" });
  await host.register(binding("b", "receiver"), "receiver");
  await parent.client.request("nativeChild", { agentId: "worker", action: "start" });
  await parent.client.request("nativeChild", { agentId: "worker", action: "grant", sendTo: ["receiver"] });
  const args = { agentId: "worker", messageId: randomUUID(), to: "receiver", body: "original child operation" };
  await parent.client.request("nativeChildSend", args);
  parent.client.close(); await until(() => !(host.broker as any).localPeers().some((p: PeerInfo) => p.name === "parent"));
  parent = await host.register(undefined, "parent", host.dir, "same-parent", { agent: "claude" });
  await parent.client.request("nativeChild", { agentId: "worker", action: "start" });
  await parent.client.request("nativeChild", { agentId: "worker", action: "grant", sendTo: ["receiver"] });
  await expect(parent.client.request("nativeChildSend", args)).rejects.toThrow(/ownership|identity|sender/i);
});
async function pairPersistent(a: Awaited<ReturnType<typeof persistentHost>>, b: Awaited<ReturnType<typeof persistentHost>>, invite = b.network.keys.invite()) {
  await a.admin.request("networkLink", { code: invite, host: "127.0.0.1", port: b.network.port });
  return invite;
}

it("refuses paired-host receipt borrowing for child senders with colliding parent/session IDs", async () => {
  const a = await persistentHost("pc-a"), b = await persistentHost("pc-b");
  const parents = await Promise.all([a, b].map(host => host.register(undefined, "parent", host.dir, "same-parent", { agent: "claude", id: "same-registration" })));
  const receiver = await a.register(undefined, "receiver", a.dir, "receiver-session");
  for (const parent of parents) {
    await parent.client.request("nativeChild", { agentId: "worker", action: "start" });
    await parent.client.request("nativeChild", { agentId: "worker", action: "grant", sendTo: ["receiver"] });
  }
  await pairPersistent(a, b);
  const id = randomUUID();
  await parents[0]!.client.request("nativeChildSend", { agentId: "worker", to: "receiver", body: "Local child proof", messageId: id });
  const copy = (await receiver.client.request("pending", {})).find(m => m.id === id)!;
  expect(copy.senderMailbox).toEqual(localMailbox(a.store.namespace));
  expect(await parents[0]!.client.request("messageReceipt", { id, nativeChild: "worker" })).toEqual([{ recipient: "receiver", readAt: null }]);
  await expect(parents[1]!.client.request("messageReceipt", { id, nativeChild: "worker" })).rejects.toMatchObject({ code: "unauthorized" });
  // Real authenticated receipt wire: B's advertised colliding parent identity
  // cannot act as A's virtual child or turn a local source into a remote one.
  await expect(link(b.network).receipt(id, parents[1]!.peer.id, "receiver")).rejects.toThrow(/original.*sender|ownership|host/i);
  expect(a.store.receipts(id)).toEqual([{ recipient: "receiver", readAt: null }]);
  expect(await receiver.client.request("ack", { ids: [id], mailboxProofs: proof(copy), nativeOwners: { [id]: copy.recipientNative! } })).toEqual({ acked: 1 });
  expect((await parents[0]!.client.request("messageReceipt", { id, nativeChild: "worker" }))[0]!.readAt).toBeTypeOf("number");
});

it("attests a detached infrastructure sender by its own process incarnation when its former parent is unknown", async () => {
  const host = await persistentHost("pc-a"), recipient = await host.register(binding("a", "ui-destination"));
  vi.spyOn(processIdentities, "parentProcessIdentity").mockResolvedValue(null);
  const node = new LiveBridgeNode({ pipePath: host.pipe, dbPath: host.db, token: host.token, agent: "other", name: "infrastructure",
    cwd: host.dir, autoWake: false, canHostBroker: false, log: nullLogger }); cleanup.push(() => node.stop());
  await node.start();
  const sent = await node.send({ to: recipient.peer.name, body: "detached UI accepted bytes" });
  expect((await recipient.client.request("pending", {})).find(m => m.id === sent.messages[0]!.id)?.body).toBe("detached UI accepted bytes");
  expect(sent.messages[0]!.senderOwner).toContain(`"pid":${process.pid}`);
  expect(sent.messages[0]!.senderOwner).toContain('"startedAt":"fixture-process-identity"');
});

it("recovers a completed transfer reoffer without duplicate mail and rejects replacement bindings", async () => {
  const a = await persistentHost("pc-a"), b = await persistentHost("pc-b");
  const sender = await a.register(binding("a", "file-sender"), "sender", a.dir), recipient = await b.register(binding("b", "file-recipient"), "destination", b.dir);
  await pairPersistent(a, b); const file = join(a.dir, "payload.txt"); writeFileSync(file, "retained file bytes");
  const replies: Record<string, any>[] = [], send = b.network.sendExtension.bind(b.network); let lost = false;
  vi.spyOn(b.network, "sendExtension").mockImplementation(async (remote, type, payload) => {
    replies.push(payload);
    if (type === "file-stream" && payload.kind === "response" && (payload.data as any)?.status === "completed" && !lost) { lost = true; return; }
    return send(remote, type, payload);
  });
  const started = await sender.client.request("sendFiles", { to: "pc-b/destination", paths: [file] });
  await until(() => lost && !!b.store.byId(started.id));
  const offer = { kind: "request", op: "offer", rid: randomUUID(), id: started.id, from: { id: sender.peer.id, name: sender.peer.name, agent: sender.peer.agent }, to: recipient.peer.name,
    entries: [{ kind: "file", path: "payload.txt", size: Buffer.byteLength("retained file bytes") }] };
  await a.network.sendExtension("pc-b", "file-stream", offer);
  await until(() => replies.some(reply => reply.rid === offer.rid));
  expect(replies.find(reply => reply.rid === offer.rid)).toMatchObject({ data: { status: "completed" } });
  expect(replies.find(reply => reply.rid === offer.rid)?.error).toBeUndefined();
  expect(b.store.messagesById(started.id)).toHaveLength(1);
  expect(recipient.events.filter(message => message.id === started.id)).toHaveLength(1);
  expect(readFileSync(join(b.dir, "inbox", started.id, "payload.txt"), "utf8")).toBe("retained file bytes");
  sender.client.close(); await until(() => !(a.broker as any).localPeers().some((p: PeerInfo) => p.id === sender.peer.id));
  const nextSender = await a.register(binding("a", "replacement-file-sender"), "sender", a.dir);
  await until(() => b.network.peers().some(p => p.frontend?.threadId === "replacement-file-sender"));
  const wrongSender = { ...offer, rid: randomUUID(), from: { id: nextSender.peer.id, name: nextSender.peer.name, agent: nextSender.peer.agent } };
  await a.network.sendExtension("pc-b", "file-stream", wrongSender);
  await until(() => replies.some(reply => reply.rid === wrongSender.rid));
  expect(replies.find(reply => reply.rid === wrongSender.rid)?.error).toMatch(/ownership|binding/i);
  nextSender.client.close(); await until(() => !(a.broker as any).localPeers().some((p: PeerInfo) => p.id === nextSender.peer.id));
  const returnedSender = await a.register(binding("a", "file-sender"), "sender", a.dir);
  await until(() => b.network.peers().some(p => p.frontend?.threadId === "file-sender"));
  offer.from = { id: returnedSender.peer.id, name: returnedSender.peer.name, agent: returnedSender.peer.agent };
  const reconnect = { ...offer, rid: randomUUID() }; await a.network.sendExtension("pc-b", "file-stream", reconnect);
  await until(() => replies.some(reply => reply.rid === reconnect.rid));
  expect(replies.find(reply => reply.rid === reconnect.rid)).toMatchObject({ data: { status: "completed" } });
  expect(b.store.messagesById(started.id)).toHaveLength(1); expect(recipient.events.filter(m => m.id === started.id)).toHaveLength(1);
  recipient.client.close(); await until(() => !(b.broker as any).localPeers().some((p: PeerInfo) => p.name === recipient.peer.name));
  const replacement = await b.register(binding("b", "replacement"), "destination", b.dir);
  const retry = { ...offer, rid: randomUUID() }; await a.network.sendExtension("pc-b", "file-stream", retry);
  await until(() => replies.some(reply => reply.rid === retry.rid));
  expect(replies.find(reply => reply.rid === retry.rid)?.error).toMatch(/ownership|binding|destination/i);
  expect((await replacement.client.request("pending", {})).map(message => message.id)).not.toContain(started.id);
});

it("pins transfer notification ownership before file publication across recipient replacement", async () => {
  const a = await persistentHost("pc-a"), b = await persistentHost("pc-b");
  const sender = await a.register(binding("a", "transfer-owner"), "sender", a.dir), recipient = await b.register(binding("b", "original-transfer-owner"), "destination", b.dir);
  await pairPersistent(a, b); const file = join(a.dir, "private-file.txt"); writeFileSync(file, "original transfer bytes");
  let release!: () => void, entered = false; const gate = new Promise<void>(resolve => release = resolve), send = a.network.sendExtension.bind(a.network);
  vi.spyOn(a.network, "sendExtension").mockImplementation(async (remote, type, payload) => {
    if (type === "file-stream" && payload.op === "finish") { entered = true; await gate; }
    return send(remote, type, payload);
  });
  cleanup.push(release); const started = await sender.client.request("sendFiles", { to: "pc-b/destination", paths: [file] });
  await until(() => entered); recipient.client.close();
  await until(() => !(b.broker as any).localPeers().some((p: PeerInfo) => p.id === recipient.peer.id));
  const replacement = await b.register(binding("b", "replacement-transfer-owner"), "destination", b.dir);
  release(); await until(() => a.network.transfers.list().some(t => t.id === started.id && ["completed", "failed"].includes(t.status)));
  expect((await replacement.client.request("pending", {})).map(m => m.id)).not.toContain(started.id);
  expect(replacement.events.some(m => m.id === started.id)).toBe(false);
  expect(readFileSync(join(b.dir, "inbox", started.id, "private-file.txt"), "utf8")).toBe("original transfer bytes");
});

it("queues authenticated remote control before first runner registration under its exact durable job principal", async () => {
  const a = await persistentHost("pc-a"), sender = await a.register(binding("a", "controller"), "controller", a.dir, "control-session");
  let b = await persistentHost("pc-b");
  const job = { ...durableJob(b, "remote-controlled", `${a.network.keys.identity.id}/control-session`), id: "a1b2c3d4", owner: "pc-a/controller" };
  await b.close();
  writeJsonStore(join(b.dir, "remote-jobs.json"), { jobs: [{ pair: a.network.keys.identity.id, peer: "control-session", owner: job.owner, job, args: job.args }] }, null);
  writeFileSync(join(b.dir, "config.json"), JSON.stringify({ network: { ...DEFAULT_CONFIG.network, enabled: true, name: "pc-b", bind: "127.0.0.1", port: 0, discovery: false,
    remoteJobs: { ...DEFAULT_CONFIG.network.remoteJobs, enabled: true, allowPeers: ["pc-a"], allowRoots: [b.dir] } } }));
  b = await persistentHost("pc-b"); await pairPersistent(a, b);
  const control = { type: "message" as const, body: "before first runner registration", cid: randomUUID() };
  await sender.client.request("remoteJob", { host: "pc-b", request: { op: "control", job: job.id, control } });
  const queued = b.store.messagesById(control.cid);
  expect(queued).toHaveLength(1);
  expect(queued[0]?.recipientNative).toBe(JSON.stringify({ kind: "job", agent: "codex", id: `job:${job.id}` }));
  const replacement = await b.register(undefined, job.name, b.dir, "native-impostor");
  expect((await replacement.client.request("pending", {})).map(m => m.id)).not.toContain(control.cid);
  await expect(registerJob(b, job, "wrong-session")).rejects.toThrow(/supervisor|registration/);
  await expect(registerJob(b, { ...job, id: "deadbeef" })).rejects.toThrow(/incarnation|registration/);
  replacement.client.close(); await until(() => !(b.broker as any).localPeers().some((p: PeerInfo) => p.name === job.name));
  const runner = await registerJob(b, job), copy = (await runner.client.request("pending", {})).find(m => m.id === control.cid)!;
  expect(copy.body).toBe(JSON.stringify(control));
  expect(await runner.client.request("ack", { ids: [copy.id], mailboxProofs: proof(copy), nativeOwners: { [copy.id]: copy.recipientNative! } })).toEqual({ acked: 1 });
  await sender.client.request("remoteJob", { host: "pc-b", request: { op: "control", job: job.id, control } });
  expect(b.store.messagesById(control.cid)).toHaveLength(1);
  expect((await runner.client.request("pending", {})).map(m => m.id)).not.toContain(control.cid);
  await sender.client.request("updatePeer", { sessionId: "wrong-controller-session" });
  await expect(sender.client.request("remoteJob", { host: "pc-b", request: { op: "control", job: job.id, control: { ...control, cid: randomUUID() } } })).rejects.toThrow(/supervisor/);
});

it("claims only explicit local project role mail once, pins the concrete owner, and preserves ambiguous exact mail", async () => {
  const a = await persistentHost("pc-a"), b = await persistentHost("pc-b"), sender = await a.register(binding("a", "role-sender"), "sender", a.dir);
  const args = { messageId: randomUUID(), to: "agent:codex", body: "explicit project role bytes" };
  await sender.client.request("trackedSend", args);
  const role = a.store.byId(args.messageId)!; expect(role.recipientRole).toMatchObject({ kind: "agent-role", namespace: a.store.namespace, agent: "codex", project: a.dir });
  expect(() => b.store.insert({ ...role })).toThrow(/namespace/);
  const exact = randomUUID(); await sender.client.request("trackedSend", { messageId: exact, to: "never-seen", body: "exact mail remains quarantined" });
  const wrongKind = await a.register(undefined, "wrong-kind", a.dir, "wrong-kind", { agent: "claude" });
  const foreign = join(home, "foreign-role-project"); mkdirSync(foreign);
  const wrongProject = await a.register(undefined, "wrong-project", foreign, "wrong-project");
  await expect(a.register(undefined, "child", a.dir, "child", { subagent: true })).rejects.toThrow(/subagents.*register/);
  for (const peer of [wrongKind, wrongProject]) expect((await peer.client.request("pending", {})).map(m => m.id)).not.toContain(args.messageId);
  await wrongKind.client.request("nativeChild", { agentId: "role-child", action: "start" });
  await expect(wrongKind.client.request("nativeChildSend", { agentId: "role-child", messageId: randomUUID(), to: "agent:codex", body: "child cannot grant roles" })).rejects.toThrow(/child|grant|target|permitted|authorized/i);
  const correct = await a.register(undefined, "never-seen", a.dir, "role-owner-A");
  const copy = (await correct.client.request("pending", {})).find(m => m.id === args.messageId)!;
  expect(copy.body).toBe(args.body); expect(copy.recipientRole).toBeUndefined();
  expect(copy.recipientNative).toContain('"sessionId":"role-owner-A"');
  expect((await correct.client.request("pending", {})).map(m => m.id)).not.toContain(exact);
  await sender.client.request("trackedSend", args);
  const retained = a.store.messagesById(args.messageId); expect(retained).toHaveLength(2);
  expect(retained.find(m => m.recipient === "agent:codex")).toMatchObject({ body: args.body, readAt: null, recipientRole: role.recipientRole });
  expect(retained.filter(m => !m.recipientRole)).toHaveLength(1);
  expect(await correct.client.request("ack", { ids: [copy.id], mailboxProofs: proof(copy), nativeOwners: { [copy.id]: copy.recipientNative! } })).toEqual({ acked: 1 });
  correct.client.close(); await until(() => !(a.broker as any).localPeers().some((p: PeerInfo) => p.id === correct.peer.id));
  const replacement = await a.register(undefined, "never-seen", a.dir, "role-owner-B");
  expect((await replacement.client.request("pending", {})).map(m => m.id)).not.toContain(args.messageId);
  expect(await replacement.client.request("ack", { ids: [copy.id], mailboxProofs: proof(copy), nativeOwners: { [copy.id]: copy.recipientNative! } })).toEqual({ acked: 0 });
  expect(a.store.byId(exact)?.recipientAmbiguous).toBe(true);
});

it("retains the original role row and every proof through concrete claim, archive, backup and same-binding recovery", async () => {
  let host = await persistentHost("retained-role"), sender = await host.register(binding("a", "sender"), "sender", host.dir);
  const id = randomUUID(), args = { messageId: id, to: "agent:codex", body: "original role body, UUID and address survive claim" };
  await sender.client.request("trackedSend", args);
  const db = new DatabaseSync(host.db), original = db.prepare("SELECT * FROM messages WHERE id=?").get(id)!, proofBefore = db.prepare("SELECT * FROM message_frontends WHERE id=?").get(id)!;
  let observerClosed = false; cleanup.push(() => { if (!observerClosed) db.close(); });
  const first = await host.register(undefined, "selected", host.dir, "selected-session");
  const copy = (await first.client.request("pending", {})).find(m => m.id === id)!;
  expect(db.prepare("SELECT * FROM messages WHERE id=? AND recipient='agent:codex'").get(id)).toEqual(original);
  expect(db.prepare("SELECT * FROM message_frontends WHERE id=? AND recipient='agent:codex'").get(id)).toEqual({ ...proofBefore, state: "role-claimed" });
  expect(copy.body).toBe(original.body); expect(copy.recipientNative).toContain('"sessionId":"selected-session"');
  // The exact intermediate reader's role-candidate predicate cannot reclaim
  // retained rows; the unknown state also grants no native/frontend authority.
  expect(db.prepare("SELECT COUNT(*) n FROM messages m JOIN message_frontends f USING(id,recipient) WHERE m.id=? AND f.state='role'").get(id)!.n).toBe(0);
  const other = await host.register(undefined, "other", host.dir, "different-session");
  expect((await other.client.request("pending", {})).map(m => m.id)).not.toContain(id);
  await sender.client.request("trackedSend", args); expect(host.store.messagesById(id)).toHaveLength(2);
  expect(host.store.receipts(id)).toEqual([{ recipient: "selected", readAt: null }]);
  expect(host.store.expireQueued("agent:codex", Date.now() + 1)).toBe(1);
  const archived = new DatabaseSync(join(host.dir, "archive.db"), { readOnly: true });
  try { expect(archived.prepare("SELECT * FROM messages WHERE id=? AND recipient='agent:codex'").get(id)).toEqual({ ...original, archive_reason: "stale queue", archived_at: expect.any(Number) }); } finally { archived.close(); }
  const backup = await messageBackupIfDue(host.dir, { checkpoint: async () => {} });
  const restored = restoreMessageBackup(backup.path!, "role-restore");
  expect(restored.messagesById(id).find(m => m.recipient === "agent:codex")?.recipientRole).toEqual(host.store.messagesById(id).find(m => m.recipient === "agent:codex")?.recipientRole);
  expect(restored.messagesById(id).every(m => m.body === args.body)).toBe(true);
  expect(restored.claimRole(fixturePeer(restored, "new-owner", { cwd: host.dir }), host.dir)).toBe(0);
  expect(restored.receipts(id)).toEqual([{ recipient: "selected", readAt: null }]);
  db.close(); observerClosed = true; // Close this owned observer before broker restart.
  await host.close(); host = await persistentHost("retained-role");
  const returned = await host.register(undefined, "selected", host.dir, "selected-session");
  const recovered = (await returned.client.request("pending", {})).find(m => m.id === id)!;
  expect(recovered.body).toBe(args.body); expect(recovered.recipientNative).toBe(copy.recipientNative);
  expect(await returned.client.request("ack", fixtureAck([recovered]))).toEqual({ acked: 1 });
  expect(host.store.receipts(id)).toEqual([{ recipient: "selected", readAt: expect.any(Number) }]);
  const all = host.store.messagesById(id); expect(all).toHaveLength(2); expect(all.find(m => m.recipient === "agent:codex")?.readAt).toBeNull();
});

it.each(["copy", "tombstone"])("rolls back a failed role %s without losing source bytes, proof or claim authority", phase => {
  const file = join(home, "role-rollback.db"), store = new MessageStore(file, nullLogger); cleanup.push(() => store.close());
  const sender = fixturePeer(store, "sender", { agent: "claude", cwd: home }), selected = fixturePeer(store, "selected", { cwd: home });
  const role = fixtureRoleMessage(store, sender, "codex", message(sender, "agent:codex")); store.insert(role);
  const db = new DatabaseSync(file); cleanup.push(() => db.close());
  const before = db.prepare("SELECT * FROM messages WHERE id=?").get(role.id), ownership = db.prepare("SELECT * FROM message_frontends WHERE id=?").get(role.id);
  db.exec(phase === "copy" ? "CREATE TRIGGER role_fault BEFORE INSERT ON messages WHEN NEW.recipient='selected' BEGIN SELECT RAISE(ABORT,'fixture role copy failure'); END"
    : "CREATE TRIGGER role_fault BEFORE UPDATE OF state ON message_frontends WHEN OLD.recipient='agent:codex' BEGIN SELECT RAISE(ABORT,'fixture role tombstone failure'); END");
  expect(() => store.claimRole(selected, home)).toThrow(/fixture role/);
  expect(db.prepare("SELECT * FROM messages WHERE id=?").all(role.id)).toEqual([before]);
  expect(db.prepare("SELECT * FROM message_frontends WHERE id=?").all(role.id)).toEqual([ownership]);
  expect(unreadOwned(store, selected)).toEqual([]);
  db.exec("DROP TRIGGER role_fault");
  const other = fixturePeer(store, "reentrant-successor", { cwd: home });
  let entered = false, reentrantClaim = -1;
  store.historyMessageSink = () => { if (!entered) { entered = true; reentrantClaim = store.claimRole(other, home); } };
  expect(store.claimRole(selected, home)).toBe(1); expect(store.claimRole(selected, home)).toBe(0);
  expect(reentrantClaim).toBe(0); expect(unreadOwned(store, other)).toEqual([]);
  expect(unreadOwned(store, selected).map(m => m.id)).toEqual([role.id]);
  expect(db.prepare("SELECT * FROM messages WHERE id=? AND recipient='agent:codex'").get(role.id)).toEqual(before);
});

it("keeps first tracked intent pending under an owned writer lock and commits original bytes once", async () => {
  const host = await persistentHost("pc-a"), sender = await host.register(binding("a", "lock-sender"), "sender", host.dir),
    recipient = await host.register(binding("a", "lock-recipient"), "destination", host.dir);
  const lock = new DatabaseSync(host.db), args = { messageId: randomUUID(), to: recipient.peer.name, body: "accepted first intent bytes" };
  let pending: Promise<unknown> | undefined;
  let entered!: () => void; const admitted = new Promise<void>(resolve => entered = resolve), remember = host.store.rememberSendIntent.bind(host.store);
  vi.spyOn(host.store, "rememberSendIntent").mockImplementation((...args) => { entered(); return remember(...args); });
  try {
    lock.exec("BEGIN IMMEDIATE"); pending = sender.client.request("trackedSend", args); void pending.catch(() => {});
    await admitted;
    expect((await sender.client.request("sendState", { id: args.messageId })).state).toBe("pending");
    lock.exec("COMMIT"); await pending;
    await sender.client.request("trackedSend", args);
    expect(host.store.messagesById(args.messageId)).toHaveLength(1);
    expect((await recipient.client.request("pending", {})).find(m => m.id === args.messageId)?.body).toBe(args.body);
  } finally { if (lock.isTransaction) lock.exec("ROLLBACK"); lock.close(); await pending?.catch(() => {}); }
});

it("keeps the explicitly owned project main through a same-connection session update and rename", async () => {
  const host = await persistentHost("rename-project"), other = await host.register(undefined, "other", host.dir, "other-session"), main = await host.register(undefined, "main", host.dir, "main-session");
  await other.client.request("projectMain", { to: main.peer.name });
  await main.client.request("updatePeer", { name: "renamed", sessionId: "resumed-main-session" });
  await host.register(undefined, "main", host.dir, "different-session");
  const sent = await other.client.request("trackedSend", { messageId: randomUUID(), to: "project:rename-project", body: "project role follows the owning connection" });
  expect(sent.projectRoute?.main).toBe("renamed");
  expect((await main.client.request("pending", {})).some(m => m.body === "project role follows the owning connection")).toBe(true);
});

it("fences owner dashboard sends by the actual reply listener registration without borrowing its control authority", async () => {
  const host = await persistentHost("dashboard-project"), supervisor = await host.register(undefined, "main", host.dir, "main-session");
  const listener = await host.register(undefined, "dashboard", host.dir, "dashboard-session", { agent: "other" });
  const job = durableJob(host, "controlled-job"); recordJobs(host, [job]);
  const args = { senderId: listener.peer.id, to: supervisor.peer.name, messageId: randomUUID(), conversationId: "jobctl-dashboard",
    body: JSON.stringify({ type: "message", requestId: randomUUID(), job: job.id, text: "owner command" }) };
  const sent = await host.admin.request("dashboardJobSend", args);
  expect(sent.messages).toHaveLength(1); expect(sent.messages[0]?.jobControlAuthorized).toBe(true);
  expect((await supervisor.client.request("pending", {})).find(m => m.id === args.messageId)?.body).toBe(args.body);
  await expect(listener.client.request("dashboardJobSend", { ...args, messageId: randomUUID() })).rejects.toThrow(/owner dashboard/i);
  // An ordinary listener's send must still use ordinary job-master authorization.
  await expect(listener.client.request("trackedSend", { ...args, messageId: randomUUID() })).rejects.toThrow(/owner dashboard|controlling job master/i);
  listener.client.close(); await until(() => !(host.broker as any).localPeers().some((p: PeerInfo) => p.id === listener.peer.id));
  const replacement = await host.register(undefined, "dashboard", host.dir, "replacement-dashboard", { agent: "other" });
  await expect(host.admin.request("dashboardJobSend", args)).rejects.toThrow(/listener/i);
  await expect(host.admin.request("dashboardJobSend", { ...args, senderId: replacement.peer.id })).rejects.toThrow(/ownership|sender|identity/i);
  expect(host.store.messagesById(args.messageId)).toHaveLength(1);
});

it.each([false, true])("serializes exact job report ACK against authorized local succession without consuming retired copies (ACK first %s)", async ackFirst => {
  const host = await persistentHost("succession-project"), owner = await host.register(undefined, "main", host.dir, "original-owner"), fallback = await host.register(undefined, "fallback", host.dir, "fallback-owner");
  const job = durableJob(host, "codex-succession", "original-owner"), originalEvidence = host.store.recipientOwnership("main", owner.peer);
  const originalOwner = `native:${originalEvidence.recipientNative}`;
  Object.assign(job, { deliveryOwner: originalOwner, deliveryOwners: { main: originalOwner } }); recordJobs(host, [job]);
  const runner = await registerJob(host, job), id = randomUUID();
  const sent = await runner.client.request("trackedSend", { messageId: id, to: "main", body: "accepted job report UUID and bytes", conversationId: `job-${job.id}` });
  const first = sent.messages[0]!; expect(first.jobRoute).toEqual({ grant: id, generation: 0 });
  if (ackFirst) expect(await owner.client.request("ack", fixtureAck([first]))).toEqual({ acked: 1 });
  await fallback.client.request("projectMain", { to: "fallback" }); await owner.client.request("updatePeer", { unavailable: true });
  await host.broker.routePendingJobMail(); await host.broker.routePendingJobMail();
  const copies = host.store.messagesById(id), original = copies.find(copy => copy.recipient === "main")!;
  expect(original.body).toBe(first.body); expect(original.recipientNative).toBe(first.recipientNative); expect(original.recipientMailbox).toEqual(first.recipientMailbox);
  if (ackFirst) {
    expect(copies).toHaveLength(1); expect((await fallback.client.request("pending", {})).map(m => m.id)).not.toContain(id);
  } else {
    expect(original.readAt).toBeNull();
    const selected = (await fallback.client.request("pending", {})).find(m => m.id === id)!;
    expect(selected).toBeDefined(); expect(selected.body).toBe(first.body); expect(selected.jobRoute).toEqual({ grant: id, generation: 1 });
    expect(await owner.client.request("ack", fixtureAck([first]))).toEqual({ acked: 0 });
    expect(await fallback.client.request("ack", { ...fixtureAck([selected]), jobRoutes: { [id]: first.jobRoute! } })).toEqual({ acked: 0 });
    expect(await fallback.client.request("ack", fixtureAck([selected]))).toEqual({ acked: 1 });
    expect(await fallback.client.request("ack", fixtureAck([selected]))).toEqual({ acked: 0 });
    expect(host.store.receipts(id).find(r => r.recipient === "main")?.readAt).toBeNull();
    expect(host.store.receipts(id).find(r => r.recipient === "fallback")?.readAt).not.toBeNull();
  }
  await owner.client.request("updatePeer", { unavailable: false }); await host.broker.routePendingJobMail();
  expect((await owner.client.request("pending", {})).map(m => m.id)).not.toContain(id);
  const db = new DatabaseSync(host.db, { readOnly: true });
  try {
    expect(db.prepare("SELECT body FROM messages WHERE id=? AND recipient='main'").get(id)?.body).toBe(first.body);
    expect(db.prepare("SELECT COUNT(*) n FROM job_mail_succession WHERE id=?").get(id)?.n).toBe(ackFirst ? 1 : 2);
    expect(db.prepare("SELECT COUNT(*) n FROM job_mail_retirements WHERE id=?").get(id)?.n).toBe(ackFirst ? 0 : 1);
  } finally { db.close(); }
});

it.each(["project", "replacement", "revoked", "incarnation"] as const)("refuses job report succession across %s authority changes at write admission", async change => {
  const host = await persistentHost("grant-project"), owner = await host.register(undefined, "main", host.dir, "original-owner");
  const otherProject = join(home, "unrelated-project"); mkdirSync(otherProject);
  const candidate = await host.register(undefined, change === "replacement" ? "main" : "fallback", change === "project" ? otherProject : host.dir, "candidate-owner");
  const job = durableJob(host, "codex-guarded", "original-owner"), ownerKey = `native:${host.store.recipientOwnership("main", owner.peer).recipientNative}`;
  Object.assign(job, { deliveryOwner: ownerKey, deliveryOwners: { main: ownerKey } }); recordJobs(host, [job]);
  const runner = await registerJob(host, job), id = randomUUID();
  await runner.client.request("trackedSend", { messageId: id, to: "main", body: "retained original report", conversationId: `job-${job.id}` });
  const route = host.broker.routePendingJobMail.bind(host.broker), automatic = vi.spyOn(host.broker, "routePendingJobMail").mockResolvedValue();
  if (change === "replacement") {
    candidate.client.close(); await until(() => !(host.broker as any).localPeers().some((p: PeerInfo) => p.id === candidate.peer.id));
    owner.client.close(); await until(() => !(host.broker as any).localPeers().some((p: PeerInfo) => p.id === owner.peer.id));
    const wrong = await host.register(undefined, "main", host.dir, "replacement-owner");
    await route(); expect((await wrong.client.request("pending", {})).map(m => m.id)).not.toContain(id);
  } else {
    await owner.client.request("updatePeer", { unavailable: true });
    const retry = host.store.retryWrite.bind(host.store); let release!: () => void, blocked = false;
    const gate = new Promise<void>(resolve => release = resolve); cleanup.push(release);
    const delayed = vi.spyOn(host.store, "retryWrite").mockImplementation(async operation => {
      if (!blocked) { blocked = true; await gate; }
      return retry(operation);
    });
    const pending = route(); await until(() => blocked);
    if (change === "revoked") projectSharing(host.dir, false);
    if (change === "incarnation") { job.startedAt++; recordJobs(host, [job]); }
    release(); await pending; delayed.mockRestore();
    expect((await candidate.client.request("pending", {})).map(m => m.id)).not.toContain(id);
  }
  automatic.mockRestore();
  const copy = host.store.messagesById(id); expect(copy).toHaveLength(1); expect(copy[0]!.recipientNative).toBe(ownerKey.slice(7)); expect(copy[0]!.readAt).toBeNull();
});

it.each([false, true])("recovers only a current producer's durable report evidence after source loss before first mailbox acceptance (original consumed %s)", async consumed => {
  const host = await persistentHost("draft-project"), path = join(host.dir, "jobs.json"); (host.broker as any).jobsPath = path;
  const source = new LiveBridgeNode({ pipePath: host.pipe, dbPath: host.db, token: host.token, agent: "codex", name: "main", cwd: host.dir, autoWake: false, canHostBroker: false, log: nullLogger });
  cleanup.push(() => source.stop()); await source.setSessionId("producer-owner"); await source.start();
  const route = host.broker.routePendingJobMail.bind(host.broker), automatic = vi.spyOn(host.broker, "routePendingJobMail").mockResolvedValue();
  vi.spyOn(source, "reportInlineJob").mockRejectedValue(new Error("fixture source lost before broker acceptance"));
  const manager = new JobManager(source, nullLogger, path), tracked = manager.track("codex", null, "durable offline report"), id = randomUUID();
  cleanup.push(() => { manager.setDormant(true); manager.cancelAll(); });
  (manager as any).post(tracked.job, "original accepted report bytes", null, "", id); manager.persist();
  await until(() => !!JSON.parse(readFileSync(path, "utf8")).jobs.find((j: any) => j.id === tracked.job.id)?.reportRouting?.[id]);
  if (consumed) {
    const retained = JSON.parse(readFileSync(path, "utf8")).jobs.find((j: any) => j.id === tracked.job.id).deliveryHistory.find((m: BridgeMessage) => m.id === id);
    source.deliverLocal({ ...retained, jobRoute: { grant: id, generation: 0 } }); source.markRead([id]);
  }
  manager.setDormant(true); await source.stop();
  const fallback = await host.register(undefined, "fallback", host.dir, "fallback-owner");
  automatic.mockRestore(); await route();
  const copy = (await fallback.client.request("pending", {})).find(m => m.id === id)!;
  if (consumed) {
    expect(copy).toBeUndefined(); expect(host.store.messagesById(id)).toHaveLength(1);
    expect(host.store.byId(id)?.recipient).toBe("main"); expect(host.store.receipts(id)[0]?.readAt).toBeTypeOf("number");
    return;
  }
  expect(copy).toBeDefined(); expect(copy.body).toBe("original accepted report bytes"); expect(copy.jobRoute).toEqual({ grant: id, generation: 0 });
  const original = JSON.parse(readFileSync(path, "utf8")).jobs.find((j: any) => j.id === tracked.job.id);
  expect(original.deliveryHistory.find((m: BridgeMessage) => m.id === id)).toMatchObject({ recipient: "main", body: copy.body });
  expect(original.reportRouting[id].grant.creator).toContain('"sessionId":"producer-owner"');
  expect(await fallback.client.request("ack", fixtureAck([copy]))).toEqual({ acked: 1 });
});

it("does not mint a job routing grant from caller flags or a job-prefixed conversation", async () => {
  const host = await persistentHost("spoof-project"), owner = await host.register(undefined, "main", host.dir, "owner"), sender = await host.register(undefined, "sender", host.dir, "sender");
  const id = randomUUID();
  await (sender.client.request as any)("trackedSend", { messageId: id, to: "main", body: "ordinary exact-owner mail", conversationId: "job-spoof",
    jobRoute: { grant: id, generation: 0 }, reportRouting: { [id]: { owner: "sender" } } });
  await owner.client.request("updatePeer", { unavailable: true }); await host.broker.routePendingJobMail();
  expect(host.store.jobRoutingGrant(id)).toBeNull(); expect(host.store.messagesById(id)).toHaveLength(1);
  expect((await sender.client.request("pending", {})).map(m => m.id)).not.toContain(id);
});

it("excludes authenticated remote job mail and foreign store namespaces from local supervisor grants", async () => {
  const a = await persistentHost("grant-source"), b = await persistentHost("grant-destination"), owner = await a.register(undefined, "main", a.dir, "same-owner"), recipient = await b.register(undefined, "main", b.dir, "same-owner");
  const job = durableJob(a, "remote-report", "same-owner"), originalOwner = `native:${a.store.recipientOwnership("main", owner.peer).recipientNative}`;
  Object.assign(job, { deliveryOwner: originalOwner, deliveryOwners: { main: originalOwner } }); recordJobs(a, [job]);
  const runner = await registerJob(a, job); await pairPersistent(a, b);
  const remoteId = randomUUID();
  await (runner.client.request as any)("trackedSend", { messageId: remoteId, to: "grant-destination/main", body: "remote copies stay immutable", conversationId: `job-${job.id}`, jobRoute: { grant: remoteId, generation: 0 } });
  const remote = (await recipient.client.request("pending", {})).find(m => m.id === remoteId)!;
  expect(remote.jobRoute).toBeUndefined(); expect(a.store.jobRoutingGrant(remoteId)).toBeNull(); expect(b.store.jobRoutingGrant(remoteId)).toBeNull();
  const localId = randomUUID();
  const local = (await runner.client.request("trackedSend", { messageId: localId, to: "main", body: "local grant never leaves its namespace", conversationId: `job-${job.id}` })).messages[0]!;
  const grant = a.store.jobRoutingGrant(localId)!;
  expect(() => b.store.insertJobDelivery(local, grant.grant)).toThrow(/local-origin|different local store/);
  expect(b.store.byId(localId)).toBeNull();
  expect(await recipient.client.request("ack", fixtureAck([remote]))).toEqual({ acked: 1 });
});

it("restarts a same-binding job recipient without applying its retired generation's lost-ACK journal to a later route", async () => {
  const host = await persistentHost("journal-succession"), owner = await host.register(undefined, "main", host.dir, "original-owner");
  const makeFallback = () => new LiveBridgeNode({ pipePath: host.pipe, dbPath: host.db, token: host.token, agent: "codex", name: "fallback", cwd: host.dir,
    autoWake: false, canHostBroker: false, log: nullLogger });
  const first = makeFallback(); cleanup.push(() => first.stop()); await first.setSessionId("fallback-owner"); await first.start();
  const job = durableJob(host, "journal-job", "original-owner"), originalOwner = `native:${host.store.recipientOwnership("main", owner.peer).recipientNative}`;
  Object.assign(job, { deliveryOwner: originalOwner, deliveryOwners: { main: originalOwner } }); recordJobs(host, [job]);
  const runner = await registerJob(host, job), id = randomUUID();
  await runner.client.request("trackedSend", { messageId: id, to: "main", body: "same report, distinct consumption generations", conversationId: `job-${job.id}` });
  await owner.client.request("updatePeer", { unavailable: true }); await host.broker.routePendingJobMail(); await first.refreshPending();
  expect(first.get(id)?.jobRoute?.generation).toBe(1);
  // Context was handed out before the reader disconnected. Its completion/read
  // callback may arrive after succession, while there is no transport for ACK.
  await first.stop();
  expect(host.store.receipts(id).every(receipt => receipt.readAt === null)).toBe(true);
  await owner.client.request("updatePeer", { unavailable: false }); await host.broker.routePendingJobMail();
  expect((await owner.client.request("pending", {})).find(m => m.id === id)?.jobRoute?.generation).toBe(2);
  first.markRead([id]);
  await owner.client.request("updatePeer", { unavailable: true });
  const restarted = makeFallback(); cleanup.push(() => restarted.stop()); await restarted.setSessionId("fallback-owner"); await restarted.start();
  await host.broker.routePendingJobMail(); await restarted.refreshPending();
  expect(restarted.get(id)?.jobRoute).toEqual({ grant: id, generation: 3 });
  expect(host.store.receipts(id).every(receipt => receipt.readAt === null)).toBe(true);
  restarted.markRead([id]); await restarted.refreshPending();
  await until(() => host.store.receipts(id).find(receipt => receipt.recipient === "fallback")?.readAt !== null);
  expect(host.store.receipts(id).find(receipt => receipt.recipient === "main")?.readAt).toBeNull();
});

it("preserves schema13 proof and consumed route evidence through interrupted, repeated schema14 admission", async () => {
  const host = await persistentHost("schema13-source"), recipient = await host.register(binding("b", "migration-owner"), "main"), sender = await host.register(binding("a", "sender"), "sender");
  const id = randomUUID(); await sender.client.request("trackedSend", { messageId: id, to: "main", body: "schema13 original bytes" });
  const namespace = host.store.namespace; await host.close();
  const db = new DatabaseSync(host.db); cleanup.push(() => { try { db.close(); } catch { /* Already closed after admission. */ } });
  db.exec("DROP TABLE job_mail_grants; DROP TABLE job_mail_succession; DROP TABLE job_mail_retirements; PRAGMA user_version=13");
  db.prepare("INSERT INTO job_delivery_routes VALUES (?,?,?,?)").run(id, recipient.peer.name, 1234, namespace);
  const tables = ["messages", "message_frontends", "job_delivery_routes", "mailbox_store"], before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
  const exec = db.exec.bind(db); let interrupted = false;
  const fault = vi.spyOn(db, "exec").mockImplementation(sql => {
    if (!interrupted && sql.includes("CREATE TABLE job_mail_grants")) {
      interrupted = true; exec(sql.slice(0, sql.indexOf(";", sql.indexOf("CREATE TABLE job_mail_grants")) + 1));
      throw new Error("fixture interruption between new routing ledgers");
    }
    return exec(sql);
  });
  expect(() => migrateMessageSchema(db, host.db, true, nullLogger)).toThrow(/fixture interruption/); fault.mockRestore();
  expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(13);
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='job_mail_grants'").get()).toBeUndefined();
  expect(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  migrateMessageSchema(db, host.db, true, nullLogger); migrateMessageSchema(db, host.db, true, nullLogger);
  expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(14);
  expect(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
  for (const table of ["job_mail_grants", "job_mail_succession", "job_mail_retirements"]) expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n).toBe(0);
  db.close();
  const restored = new MessageStore(host.db, nullLogger); cleanup.push(() => restored.close());
  expect(restored.byId(id)?.body).toBe("schema13 original bytes"); expect(restored.jobRoutingGrant(id)).toBeNull();
});

it("backs up and restores nonempty grant, succession and retirement evidence at one boundary while the live route advances", async () => {
  const host = await persistentHost("grant-backup"), owner = await host.register(undefined, "main", host.dir, "original-owner"), fallback = await host.register(undefined, "fallback", host.dir, "fallback-owner");
  const job = durableJob(host, "backup-job", "original-owner"), originalOwner = `native:${host.store.recipientOwnership("main", owner.peer).recipientNative}`;
  Object.assign(job, { deliveryOwner: originalOwner, deliveryOwners: { main: originalOwner } }); recordJobs(host, [job]);
  const runner = await registerJob(host, job), id = randomUUID();
  const first = (await runner.client.request("trackedSend", { messageId: id, to: "main", body: "backup original accepted bytes", conversationId: `job-${job.id}` })).messages[0]!;
  await owner.client.request("updatePeer", { unavailable: true }); await host.broker.routePendingJobMail();
  const selected = (await fallback.client.request("pending", {})).find(m => m.id === id)!; expect(selected.jobRoute?.generation).toBe(1);
  let interleaved = false;
  const backup = await messageBackupIfDue(host.dir, { checkpoint: async () => {
    if (interleaved || !existsSync(join(host.dir, "message-backups"))) return;
    const pending = readdirSync(join(host.dir, "message-backups")).find(name => name.startsWith(".pending-")); if (!pending) return;
    const file = join(host.dir, "message-backups", pending, "bridge.messages.db"); if (!existsSync(file)) return;
    const check = new DatabaseSync(file, { readOnly: true });
    const copying = check.prepare("SELECT 1 FROM sqlite_master WHERE name='job_mail_grants'").get(); check.close();
    if (!copying) return;
    interleaved = true; await owner.client.request("updatePeer", { unavailable: false }); await host.broker.routePendingJobMail();
  } });
  expect(interleaved).toBe(true); expect((await owner.client.request("pending", {})).find(m => m.id === id)?.jobRoute?.generation).toBe(2);
  const restored = restoreMessageBackup(backup.path!, "restored-job-grant");
  const db = new DatabaseSync(restored.file, { readOnly: true });
  try {
    expect(db.prepare("SELECT COUNT(*) n FROM job_mail_grants").get()!.n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM job_mail_succession").get()!.n).toBe(2);
    expect(db.prepare("SELECT COUNT(*) n FROM job_mail_retirements").get()!.n).toBe(1);
    expect(JSON.parse(String(db.prepare("SELECT original_envelope FROM job_mail_grants").get()!.original_envelope))).toMatchObject({ id, recipient: "main", body: first.body, recipientNative: first.recipientNative });
  } finally { db.close(); }
  expect(restored.namespace).toBe(host.store.namespace);
  expect(restored.unread("main", 100, undefined, first.recipientNative)).toEqual([]);
  const active = restored.unread("fallback", 100, undefined, selected.recipientNative).find(m => m.id === id)!;
  expect(active.body).toBe(first.body); expect(active.jobRoute).toEqual(selected.jobRoute);
  expect(restored.markRead("main", [id], Date.now(), undefined, { [id]: first.recipientNative! }, first.recipientNative, { [id]: first.jobRoute! })).toBe(0);
  expect(restored.markRead("fallback", [id], Date.now(), undefined, { [id]: active.recipientNative! }, active.recipientNative, { [id]: active.jobRoute! })).toBe(1);
});

it("does not touch a closed mailbox from deferred replay readiness", async () => {
  const host = await persistentHost("closing-replay"), registered = await host.register(undefined, "reader"), conn = (host.broker as any).connByName("reader");
  expect((host.broker as any).queueReady(conn, conn.peer)).toBe(true);
  await host.close();
  expect(() => (host.broker as any).queueReady(conn, registered.peer)).not.toThrow();
  expect((host.broker as any).queueReady(conn, registered.peer)).toBe(false);
});

it("recovers an unacknowledged supervisor succession after broker restart and exact tracked retry without creating another generation", async () => {
  let host = await persistentHost("succession-restart");
  const owner = await host.register(undefined, "main", host.dir, "original-owner"), fallback = await host.register(undefined, "fallback", host.dir, "fallback-owner");
  const job = durableJob(host, "restart-job", "original-owner"), originalOwner = `native:${host.store.recipientOwnership("main", owner.peer).recipientNative}`;
  Object.assign(job, { deliveryOwner: originalOwner, deliveryOwners: { main: originalOwner } }); recordJobs(host, [job]);
  const runner = await registerJob(host, job), args = { messageId: randomUUID(), to: "main", body: "original tracked UUID across restart", conversationId: `job-${job.id}` };
  await runner.client.request("trackedSend", args); await owner.client.request("updatePeer", { unavailable: true }); await host.broker.routePendingJobMail();
  const selected = (await fallback.client.request("pending", {})).find(m => m.id === args.messageId)!;
  expect(selected.jobRoute?.generation).toBe(1); await host.close(); host = await persistentHost("succession-restart");
  (host.broker as any).jobsPath = join(host.dir, "jobs.json");
  const replacement = await host.register(undefined, "main", host.dir, "replacement-owner"), returned = await host.register(undefined, "fallback", host.dir, "fallback-owner");
  const reconnectedRunner = await registerJob(host, job);
  await reconnectedRunner.client.request("trackedSend", args); await host.broker.routePendingJobMail();
  expect((await replacement.client.request("pending", {})).map(m => m.id)).not.toContain(args.messageId);
  const recovered = (await returned.client.request("pending", {})).find(m => m.id === args.messageId)!;
  expect(recovered.jobRoute).toEqual(selected.jobRoute); expect(recovered.body).toBe(args.body);
  const db = new DatabaseSync(host.db, { readOnly: true });
  try { expect(db.prepare("SELECT COUNT(*) n FROM job_mail_succession WHERE id=?").get(args.messageId)!.n).toBe(2); } finally { db.close(); }
  expect(await returned.client.request("ack", fixtureAck([recovered]))).toEqual({ acked: 1 });
  expect(host.store.receipts(args.messageId).find(receipt => receipt.recipient === "main")?.readAt).toBeNull();
});

it("fences a fresh proven job question to its authorized project fallback without reassigning older private copies", async () => {
  const host = await persistentHost("job-project"), owner = await host.register(undefined, "main", host.dir, "original-owner"), fallback = await host.register(undefined, "fallback", host.dir, "fallback-owner");
  const job = durableJob(host, "codex-job-fallback", "original-owner"), evidence = host.store.recipientOwnership(owner.peer.name, owner.peer);
  Object.assign(job, { deliveryOwner: `native:${evidence.recipientNative}`, deliveryOwners: { main: `native:${evidence.recipientNative}` } }); recordJobs(host, [job]);
  const runner = await registerJob(host, job), oldId = randomUUID(), nextId = randomUUID();
  await fallback.client.request("trackedSend", { messageId: oldId, to: "main", body: "original private copy", conversationId: `job-${job.id}` });
  await fallback.client.request("projectMain", { to: "fallback" }); owner.client.close();
  await until(() => !(host.broker as any).localPeers().some((p: PeerInfo) => p.name === "main"));
  const args = { messageId: nextId, to: "main", body: "fresh authorized fallback question", conversationId: `job-${job.id}:question` };
  const sent = await runner.client.request("trackedSend", args);
  expect(sent.deliveredTo).toEqual(["fallback"]);
  const copy = host.store.byId(nextId)!; expect(copy.recipientNative).toContain('"sessionId":"fallback-owner"');
  expect((await fallback.client.request("pending", {})).map(m => m.id)).not.toContain(oldId);
  fallback.client.close(); await until(() => !(host.broker as any).localPeers().some((p: PeerInfo) => p.name === "fallback"));
  const replacement = await host.register(undefined, "fallback", host.dir, "replacement-fallback");
  await runner.client.request("trackedSend", args);
  expect(host.store.messagesById(nextId)).toHaveLength(1);
  expect((await replacement.client.request("pending", {})).map(m => m.id)).not.toContain(nextId);
  expect(await replacement.client.request("ack", { ids: [nextId], mailboxProofs: proof(copy), nativeOwners: { [nextId]: copy.recipientNative! } })).toEqual({ acked: 0 });
  const original = await host.register(undefined, "returned-owner", host.dir, "original-owner");
  expect((await original.client.request("pending", {})).map(m => m.id)).toContain(oldId);
  // Existing authorized supervisor-return routing creates a separate exact
  // copy for the original principal. It cannot rewrite the fallback ledger.
  const copies = host.store.messagesById(nextId);
  expect(copies.find(m => m.recipient === "fallback")?.recipientNative).toBe(copy.recipientNative);
  expect(copies.find(m => m.recipient === original.peer.name)?.recipientNative).toContain('"sessionId":"original-owner"');
});

it.each([false, true])("isolates outbound remote copies from colliding local owners and ACKs (%s)", async hosted => {
  const a = await persistentHost("pc-a"), b = await persistentHost("pc-b");
  const frontend = hosted ? binding("b", "deliberately-reused-app-thread") : undefined;
  const recipient = await b.register(frontend, "destination", b.dir, "colliding-native-session");
  const sender = await a.register(binding("a", "sender"), "sender"); await pairPersistent(a, b);
  const id = randomUUID(); await sender.client.request("trackedSend", { messageId: id, to: "pc-b/destination", body: "only remote host may consume" });
  const local = await a.register(frontend, "local-collision", a.dir, "colliding-native-session");
  expect((await local.client.request("pending", {})).map(m => m.id)).not.toContain(id);
  expect(local.events.filter(m => m.id === id)).toEqual([]);
  const ledger = JSON.stringify((a.store as any).db.prepare("SELECT * FROM message_frontends WHERE id=?").all(id));
  await migrateHistoryStore(a.db, a.store.history.storageDatabase);
  a.store.history.tick();
  const ingestor = new ConversationIngestor(a.store.history.storageDatabase, a.dir, transcriptPaths(), (a.store as any).db);
  try { ingestor.tick(); } finally { ingestor.close(); }
  const shared = await local.client.request("searchHistory", { query: "only remote host may consume" });
  expect(shared.hits).toEqual(expect.arrayContaining([expect.objectContaining({ snippet: expect.stringContaining("only remote host may consume") })])); // Independently authorized shared archive.
  const conversations = a.store.history.storageDatabase.prepare("SELECT id FROM conversations WHERE kind='message'").all();
  expect(conversations.length).toBeGreaterThan(0);
  const archived = await local.client.request("getConversation", { id: String(conversations[0]!.id) });
  expect(archived.records.some(record => record.text.includes("only remote host may consume"))).toBe(true);
  expect(JSON.stringify((a.store as any).db.prepare("SELECT * FROM message_frontends WHERE id=?").all(id))).toBe(ledger);
  expect(a.store.receipts(id).every(receipt => receipt.readAt === null)).toBe(true);
  await expect(local.client.request("nativeChildPending", { agentId: "unowned" })).rejects.toThrow(/child|owner|parent|registered/i);
  expect(await local.client.request("claimMail", { names: ["pc-b/destination"] })).toEqual({ moved: 0 });
  const remoteCopy = (await recipient.client.request("pending", {})).find(m => m.id === id)!;
  expect(await local.client.request("ack", { ids: [id], mailboxProofs: proof(remoteCopy), nativeOwners: { [id]: remoteCopy.recipientNative! } })).toEqual({ acked: 0 });
  expect(a.store.messagesById(id).map(m => m.recipient)).toEqual(["pc-b/destination"]);
  expect((await sender.client.request("messageReceipt", { id }))[0]!.readAt).toBeNull();
  expect(await recipient.client.request("ack", { ids: [id], mailboxProofs: proof(remoteCopy), nativeOwners: { [id]: remoteCopy.recipientNative! } })).toEqual({ acked: 1 });
  expect((await sender.client.request("messageReceipt", { id }))[0]!.readAt).not.toBeNull();
  await a.close(); const restarted = await persistentHost("pc-a");
  const again = await restarted.register(frontend, "local-collision", restarted.dir, "colliding-native-session");
  expect((await again.client.request("pending", {})).map(m => m.id)).not.toContain(id);
  expect(restarted.store.messagesById(id).map(m => m.recipient)).toEqual(["pc-b/destination"]);
});

function durableJob(host: Awaited<ReturnType<typeof persistentHost>>, name: string, supervisor = "main-session") {
  return { id: randomUUID() as string, startedAt: Date.now(), name, agent: "codex", owner: "main", rootName: "main", supervisor, rootSession: supervisor,
    projectRoot: host.dir, workdir: host.dir, status: "running", createdAt: Date.now(), host: { pid: null, peer: name, startedAt: Date.now() }, args: { title: "fixture recorded job", cwd: host.dir } };
}
function recordJobs(host: Awaited<ReturnType<typeof persistentHost>>, jobs: ReturnType<typeof durableJob>[]) {
  const file = join(host.dir, "jobs.json"), previous = readJsonStore(file);
  writeJsonStore(file, { ...(previous as Record<string, unknown> | null), jobs }, previous); (host.broker as any).jobsPath = file;
}
function projectSharing(root: string, enabled: boolean) {
  mkdirSync(join(root, ".agent-bridge"), { recursive: true });
  writeFileSync(join(root, ".agent-bridge", "config.json"), JSON.stringify({ projectGroups: enabled }));
}
function registerJob(host: Awaited<ReturnType<typeof persistentHost>>, job: ReturnType<typeof durableJob>, supervisor = job.supervisor) {
  return host.register(undefined, job.name, host.dir, null, { id: `job:${job.id}`, agent: "other", jobAgent: "codex", jobOwner: supervisor, jobParent: job.owner });
}

it("validates owned runner project identity independently of disabled sharing", async () => {
  const host = await persistentHost("pc-b"), job = durableJob(host, "sharing-off"); recordJobs(host, [job]);
  projectSharing(host.dir, false);
  const other = join(home, "foreign-project"); mkdirSync(other);
  await expect(host.register(undefined, job.name, other, null, { id: `job:${job.id}`, agent: "other", jobAgent: "codex", jobOwner: job.supervisor })).rejects.toThrow(/project|registration/i);
  expect((await registerJob(host, job)).peer.name).toBe(job.name);
});

it("retains an explicitly controlled remote-job owner question without granting local job ownership", async () => {
  const host = await persistentHost("pc-a"), main = await host.register(binding("a", "main"), "main", host.dir, "main-session");
  const base = durableJob(host, "source-proxy"), job = { ...base, args: { ...base.args, host: "paired-host" } };
  recordJobs(host, [job]); projectSharing(host.dir, false);
  const q = (await main.client.request("askOwner", { ...ownerQuestion(), project: host.dir, job: job.name })).question;
  expect(q.askers[0]!.jobOwner).toBeUndefined();
  await host.admin.request("answerOwner", { id: q.id, answer: { text: "retain source-side answer" } });
  const replacement = await host.register(undefined, job.name, host.dir, "local-impostor");
  expect((await replacement.client.request("pending", {})).filter(m => m.replyTo === q.id)).toEqual([]);
  expect((await main.client.request("pending", {})).find(m => m.replyTo === q.id)?.body).toContain("retain source-side answer");
  const retained = (host.broker as any).ownerQuestions().store.list().find((item: any) => item.id === q.id);
  expect(retained.deliveries.some((d: any) => d.recipient === job.name && d.state === "pending" && !d.owner && !d.messageId)).toBe(true);
});

it("reconnects a collision-allocated BridgeNode job alias and recovers only its durable incarnation", async () => {
  let host = await persistentHost("pc-b"); const job = durableJob(host, "collision-job"); recordJobs(host, [job]);
  await host.register(undefined, job.name, host.dir, "unrelated-native");
  const node = new LiveBridgeNode({ pipePath: host.pipe, token: host.token, dbPath: host.db, id: `job:${job.id}`, agent: "other",
    name: job.name, cwd: host.dir, jobAgent: "codex", jobOwner: job.supervisor, jobParent: job.owner, autoWake: false, canHostBroker: false, log: nullLogger });
  cleanup.push(() => node.stop()); await node.start(); expect(node.name).toBe(`${job.name}-2`);
  const alias = node.name;
  // Restart the real broker; BridgeNode retains its allocated alias in hello.
  await host.close(); await until(() => !node.isConnected);
  host = await persistentHost("pc-b"); recordJobs(host, [job]);
  const occupied = await host.register(undefined, job.name, host.dir, "unrelated-native");
  await expect(node.ensureConnected()).resolves.toBeUndefined(); expect(node.name).toBe(alias);
  (node as any).client.close(); await until(() => !(host.broker as any).localPeers().some((p: PeerInfo) => p.id === `job:${job.id}`));
  const main = await host.register(binding("b", "main"), "main", host.dir, "main-session");
  await main.client.request("projectMain", { to: main.peer.name });
  const q = (await main.client.request("askOwner", { ...ownerQuestion(), job: alias })).question;
  await host.admin.request("answerOwner", { id: q.id, answer: { text: "offline alias answer" } });
  const impostor = { id: `job:${job.id}`, agent: "other" as const, jobAgent: "codex" as const, jobOwner: job.supervisor };
  await expect(host.register(undefined, `${job.name}-99`, host.dir, null, impostor)).rejects.toThrow(/registration|alias/i);
  const other = durableJob(host, "different-job"); recordJobs(host, [job, other]);
  await expect(host.register(undefined, alias, host.dir, null, { ...impostor, id: `job:${other.id}` })).rejects.toThrow(/registration|alias/i);
  const sibling = await registerJob(host, other);
  const siblingSend = await sibling.client.request("sendSibling", { to: alias, body: "offline assigned alias", maxHops: 4 });
  await expect(node.ensureConnected()).resolves.toBeUndefined(); expect(node.name).toBe(alias);
  const pending = await (node as any).client.request("pending", {});
  expect(pending.find((m: BridgeMessage) => m.replyTo === q.id)?.body).toContain("offline alias answer");
  expect(pending.find((m: BridgeMessage) => m.id === siblingSend.messages[0]!.id)?.body).toContain("offline assigned alias");
  expect((await occupied.client.request("pending", {})).filter(m => m.replyTo === q.id)).toEqual([]);
  expect(host.store.messagesById(pending.find((m: BridgeMessage) => m.replyTo === q.id)!.id).some(m => m.recipient === alias && m.recipientNative === JSON.stringify({ kind: "job", agent: "codex", id: `job:${job.id}` }))).toBe(true);
  expect(JSON.parse(readFileSync(join(host.dir, "jobs.json"), "utf8")).jobs.find((j: any) => j.id === job.id).name).toBe(job.name);
  const next = await host.register(binding("b", "next-main"), "next-main", host.dir, "next-supervisor");
  commitHandoff(join(host.dir, "jobs.json"), main.peer, next.peer, { to: next.peer.name, jobs: [job.name] });
  (host.broker as any).applyHandoffs();
  expect((host.broker as any).localPeers().find((p: PeerInfo) => p.id === node.id).jobOwner).toBe("next-supervisor");
  expect(host.store.broadcastNames()).not.toContain(alias);
});

it("retains proven native job ownership through the real network peer projection and reconnect", async () => {
  const a = await persistentHost("pc-a"), b = await persistentHost("pc-b"), left = durableJob(a, "job-sender"), right = durableJob(b, "job-recipient");
  right.id = left.id; // Job IDs and supervisor strings need not be globally unique across hosts.
  recordJobs(a, [left]); recordJobs(b, [right]); let sender = await registerJob(a, left), recipient = await registerJob(b, right);
  await pairPersistent(a, b);
  expect(a.network.localPeers().find(p => p.id === `job:${left.id}`)?.nativeOwner).toBe(JSON.stringify({ kind: "job", agent: "codex", id: `job:${left.id}` }));
  const id = randomUUID(); await sender.client.request("trackedSend", { messageId: id, to: "pc-b/job-recipient", body: "proven jobs across hosts" });
  const copy = (await recipient.client.request("pending", {})).find(m => m.id === id)!; expect(copy.body).toBe("proven jobs across hosts");
  await recipient.client.request("ack", { ids: [id], mailboxProofs: proof(copy), nativeOwners: { [id]: copy.recipientNative! } });
  sender.client.close(); await until(() => !(a.broker as any).localPeers().length); sender = await registerJob(a, left);
  expect((await sender.client.request("pending", {})).map(m => m.id)).not.toContain(id);
  expect((await sender.client.request("messageReceipt", { id }))[0]!.readAt).not.toBeNull();
});

it.each([true, false])("captures the authorized offline linked job's durable identity before answering and refuses replacements (sharing %s)", async sharing => {
  const host = await persistentHost("pc-b"), main = await host.register(binding("b", "main"), "main", host.dir, "main-session");
  projectSharing(host.dir, sharing);
  const job = durableJob(host, "offline-linked"); recordJobs(host, [job]);
  const q = (await main.client.request("askOwner", { ...ownerQuestion(), job: job.name })).question;
  expect(q.askers[0]!.jobOwner).toBe(`native:${JSON.stringify({ kind: "job", agent: "codex", id: `job:${job.id}` })}`);
  await host.admin.request("answerOwner", { id: q.id, answer: { text: "offline job answer" } });
  const replacement = await host.register(undefined, job.name, host.dir, "unrelated-native");
  expect((await replacement.client.request("pending", {})).filter(m => m.replyTo === q.id)).toEqual([]);
  replacement.client.close(); await until(() => !(host.broker as any).localPeers().some((p: PeerInfo) => p.name === job.name));
  const actual = await registerJob(host, job);
  expect((await actual.client.request("pending", {})).find(m => m.replyTo === q.id)?.body).toContain("offline job answer");
});

it.each([true, false])("queues authorized never-registered sibling mail for its exact durable job incarnation (sharing %s)", async sharing => {
  const host = await persistentHost("pc-b"), left = durableJob(host, "left"), right = durableJob(host, "right"); recordJobs(host, [left, right]);
  const sender = await registerJob(host, left);
  projectSharing(host.dir, sharing);
  const result = await sender.client.request("sendSibling", { to: right.name, body: "first registration must recover this", maxHops: 4 });
  const id = result.messages[0]!.id;
  expect(host.store.byId(id)?.recipientNative).toBe(JSON.stringify({ kind: "job", agent: "codex", id: `job:${right.id}` }));
  const replacement = await host.register(undefined, right.name, host.dir, "unrelated-native");
  expect((await replacement.client.request("pending", {})).map(m => m.id)).not.toContain(id);
  replacement.client.close(); await until(() => !(host.broker as any).localPeers().some((p: PeerInfo) => p.name === right.name));
  const actual = await registerJob(host, right);
  expect((await actual.client.request("pending", {})).find(m => m.id === id)?.body).toContain("first registration must recover this");
});

it.each([false, true])("requires exact per-copy mailbox ACK proofs with colliding local/remote broadcast owners (%s)", async hosted => {
  const a = await persistentHost("pc-a"), b = await persistentHost("pc-b"), frontend = hosted ? binding("b", "broadcast-collision") : undefined;
  const local = await a.register(frontend, "local", a.dir, "same-id"), remote = await b.register(frontend, "remote", b.dir, "same-id"), sender = await a.register(binding("a", "sender"), "sender");
  await pairPersistent(a, b); const id = randomUUID(); await sender.client.request("trackedSend", { messageId: id, to: "*", body: "separate host copies" });
  const localCopy = (await local.client.request("pending", {})).find(m => m.id === id)!, remoteCopy = (await remote.client.request("pending", {})).find(m => m.id === id)!;
  const nativeOwners = { [id]: localCopy.recipientNative! };
  expect(await local.client.request("ack", { ids: [id], nativeOwners })).toEqual({ acked: 0 });
  expect(await local.client.request("ack", { ids: [id], nativeOwners, mailboxProofs: proof(remoteCopy) })).toEqual({ acked: 0 });
  expect(a.store.receipts(id).every(r => r.readAt === null)).toBe(true);
  expect(await local.client.request("ack", { ids: [id], nativeOwners, mailboxProofs: proof(localCopy) })).toEqual({ acked: 1 });
  expect(a.store.messagesById(id).map(m => m.recipient).sort()).toEqual(["local", "pc-b/remote"]);
  expect(a.store.receipts(id).find(r => r.recipient === "pc-b/remote")?.readAt).toBeNull();
  expect((await remote.client.request("pending", {})).map(m => m.id)).toContain(id);
});

it("refuses a forged job owner/session/project while the exact durable incarnation reconnects", async () => {
  const host = await persistentHost("pc-b"), job = durableJob(host, "strict-job"); recordJobs(host, [job]);
  await expect(registerJob(host, job, "wrong-supervisor")).rejects.toThrow(/job.*registration|supervisor/i);
  await expect(registerJob(host, { ...job, id: randomUUID() })).rejects.toThrow(/job.*registration|incarnation/i);
  const wrongProject = join(home, "other-project"); mkdirSync(wrongProject);
  await expect(host.register(undefined, job.name, wrongProject, null, { id: `job:${job.id}`, agent: "other", jobAgent: "codex", jobOwner: job.supervisor })).rejects.toThrow(/project|job.*registration/i);
  await expect(host.register(undefined, job.name, host.dir, null, { id: `job:${job.id}`, agent: "other", jobAgent: "opencode", jobOwner: job.supervisor })).rejects.toThrow(/job.*registration/i);
  const actual = await registerJob(host, job); actual.client.close(); await until(() => !(host.broker as any).localPeers().length);
  expect((await registerJob(host, job)).peer.id).toBe(`job:${job.id}`);
});

it.each(["send", "receipt"])("refuses inbound %s with missing mailboxProvenanceV1 before effects", async operation => {
  const sender = peer("sender"), destination = peer("destination"), received = vi.fn(() => ({ delivered: true }));
  const a = service("pc-a", [sender], () => ({ delivered: true })), b = service("pc-b", [destination], received);
  const hello = a.extensionHelloCapabilities.bind(a); vi.spyOn(a, "extensionHelloCapabilities").mockImplementation(() => ({ ...hello(), mailboxProvenanceV1: false }));
  const receipt = vi.fn(() => 123); (b as any).broker.receipt = receipt;
  await connect(a, b);
  if (operation === "send") await expect(a.send(message(sender, "pc-b/destination"))).rejects.toThrow(/mailboxProvenanceV1/);
  else await expect(a.receipt("pc-b/destination", randomUUID(), sender.id)).rejects.toThrow(/mailboxProvenanceV1/);
  expect(received).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled();
});

it("withholds outbound payloads and receipts when a paired host omits mailbox provenance", async () => {
  const sender = peer("sender"), destination = peer("destination"), received = vi.fn(() => ({ delivered: true }));
  const a = service("pc-a", [sender], () => ({ delivered: true })), b = service("pc-b", [destination], received);
  const hello = b.extensionHelloCapabilities.bind(b); vi.spyOn(b, "extensionHelloCapabilities").mockImplementation(() => ({ ...hello(), mailboxProvenanceV1: false }));
  await connect(a, b);
  await expect(a.send(message(sender, "pc-b/destination"))).rejects.toThrow(/mailboxProvenanceV1/);
  await expect(a.receipt("pc-b/destination", randomUUID(), sender.id)).rejects.toThrow(/mailboxProvenanceV1/);
  expect(received).not.toHaveBeenCalled();
});

it("preserves intermediate12 rows and proof strings through interrupted additive13 migration without attributing direction", async () => {
  const host = await persistentHost("pc-b"), native = await host.register(undefined, "native", host.dir, "native-A"), sender = await host.register(binding("a", "sender"), "sender");
  const id = randomUUID(); await sender.client.request("trackedSend", { messageId: id, to: "native", body: "historical direction unknown" });
  const originalProof = host.store.byId(id)!.recipientNative!; await host.close();
  const db = new DatabaseSync(host.db); let closed = false; cleanup.push(() => { if (!closed) db.close(); }); removeFixtureProvenance(db); db.exec("PRAGMA user_version=12");
  const rows = db.prepare("SELECT * FROM messages").all(), owners = db.prepare("SELECT * FROM message_frontends").all(), intents = db.prepare("SELECT * FROM send_intents").all();
  const exec = db.exec.bind(db); let interrupted = false;
  const fault = vi.spyOn(db, "exec").mockImplementation(sql => {
    if (!interrupted && sql.includes("ADD COLUMN mailbox")) { interrupted = true; exec(sql.slice(0, sql.indexOf(";") + 1)); throw new Error("fixture namespace migration interruption"); }
    return exec(sql);
  });
  expect(() => migrateMessageSchema(db, host.db, true, nullLogger)).toThrow(/namespace migration interruption/); fault.mockRestore();
  expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(12); expect(db.prepare("SELECT * FROM message_frontends").all()).toEqual(owners);
  migrateMessageSchema(db, host.db, true, nullLogger); const namespace = db.prepare("SELECT namespace FROM mailbox_store").get()!.namespace;
  migrateMessageSchema(db, host.db, true, nullLogger);
  expect(db.prepare("SELECT namespace FROM mailbox_store").get()!.namespace).toBe(namespace);
  expect(db.prepare("SELECT * FROM messages").all()).toEqual(rows);
  expect(db.prepare("SELECT id,recipient,binding,state,identity,owner,sender FROM message_frontends").all()).toEqual(owners);
  expect(db.prepare("SELECT id,owner,fingerprint FROM send_intents").all()).toEqual(intents);
  db.close(); closed = true; const restored = new MessageStore(host.db, nullLogger); cleanup.push(() => restored.close());
  expect(restored.unread(native.peer.name, 100, undefined, originalProof)).toEqual([]);
  expect(restored.markRead(native.peer.name, [id], Date.now(), undefined, { [id]: originalProof }, originalProof)).toBe(0);
  expect(restored.blockedOwnership().records.map(r => r.id)).toContain(id);
  expect(restored.byId(id)?.body).toBe("historical direction unknown");
  expect(() => restored.sendIntentOwner(id)).toThrow(/namespace.*unproven/i);
});

it("preserves legacy supplemental job routes through schema13 merge without inventing namespace or settled delivery", async () => {
  const host = await persistentHost("pc-b"); const id = randomUUID(); await host.close();
  const db = new DatabaseSync(host.db); let closed = false; cleanup.push(() => { if (!closed) db.close(); });
  attachStoreCompatibility(db, host.db, nullLogger, true);
  db.prepare("INSERT INTO store_compatibility.job_delivery_routes VALUES (?,?,?)").run(id, "historical-owner", 1234);
  db.close(); closed = true;
  const reopened = new MessageStore(host.db, nullLogger); cleanup.push(() => reopened.close());
  const raw = (reopened as any).db.prepare("SELECT * FROM job_delivery_routes WHERE id=?").get(id);
  expect(raw).toMatchObject({ id, recipient: "historical-owner", consumed_at: 1234, namespace: "" });
  expect(() => reopened.insertJobDelivery({ ...message(peer("job"), "historical-owner"), id, recipientFrontend: binding("b", "historical-owner") })).toThrow(/route provenance.*unproven|pending report/i);
});

it.each([true, false])("registers a receiver-side durable remote Bridge runner without trusting a source-side mirror or caller owner (sharing %s)", async sharing => {
  const a = await persistentHost("pc-a"); let b = await persistentHost("pc-b");
  const job = { ...durableJob(b, "received-bridge-job"), owner: "pc-a/main", supervisor: `${a.network.status().identity!.id}/remote-root` };
  await b.close(); writeJsonStore(join(b.dir, "remote-jobs.json"), { jobs: [{ pair: a.network.status().identity!.id, peer: "remote-root", owner: job.owner, job, args: job.args }] }, null);
  b = await persistentHost("pc-b"); await pairPersistent(a, b);
  projectSharing(b.dir, sharing);
  await expect(registerJob(b, job, "wrong-remote-root")).rejects.toThrow(/supervisor|job registration/i);
  const service = (b.broker as any).remoteJobs;
  service.pendingStarts.set(job.id, { committed: false });
  await expect(registerJob(b, job)).rejects.toThrow(/job registration|incarnation/i);
  service.pendingStarts.delete(job.id);
  const runner = await registerJob(b, job);
  expect(b.network.localPeers().find(p => p.id === runner.peer.id)?.nativeOwner).toBe(JSON.stringify({ kind: "job", agent: "codex", id: `job:${job.id}` }));
});

it("retains immutable per-copy namespace evidence through the actual native-child pending and ACK client paths", async () => {
  const host = await persistentHost("pc-b");
  const node = new LiveBridgeNode({ pipePath: host.pipe, token: host.token, dbPath: host.db, agent: "claude", name: "parent", cwd: host.dir, autoWake: false, log: nullLogger });
  cleanup.push(() => node.stop()); await node.setSessionId("parent-session"); await node.start();
  const child = await node.nativeChild({ agentId: "worker", action: "start" });
  const id = randomUUID(); await node.send({ messageId: id, to: child!.address, body: "owned child queue" });
  const messages = await node.nativeChildPending("worker"), copy = messages.find(m => m.id === id)!;
  expect(copy.recipientMailbox?.kind).toBe("local");
  if (copy.recipientMailbox?.kind === "local") copy.recipientMailbox.namespace = "0".repeat(64);
  expect(await node.nativeChildAck("worker", [id])).toEqual({ acked: 1 });
  expect((await node.nativeChildPending("worker")).map(m => m.id)).not.toContain(id);
});

it.each([false, true])("quarantines a partial mailbox restore without its original namespace (%s)", async hosted => {
  const a = await persistentHost("pc-a"), b = await persistentHost("pc-b"), frontend = hosted ? binding("b", "same-thread") : undefined;
  const recipient = await a.register(frontend, "destination", a.dir, "same-session"), sender = await a.register(binding("a", "sender"), "sender"), id = randomUUID();
  await sender.client.request("trackedSend", { messageId: id, to: recipient.peer.name, body: "namespace must restore with the ledger" });
  const original = a.store.byId(id)!;
  const db = (b.store as any).db as DatabaseSync; db.prepare("ATTACH DATABASE ? AS partial_fixture").run(a.db);
  try {
    db.prepare("INSERT INTO main.messages SELECT * FROM partial_fixture.messages WHERE id=?").run(id);
    db.prepare("INSERT INTO main.message_frontends SELECT * FROM partial_fixture.message_frontends WHERE id=?").run(id);
  } finally { db.exec("DETACH DATABASE partial_fixture"); }
  const replacement = await b.register(frontend, "destination", b.dir, "same-session");
  expect((await replacement.client.request("pending", {})).map(m => m.id)).not.toContain(id);
  expect(a.store.namespace).not.toBe(b.store.namespace);
  expect(await replacement.client.request("ack", { ids: [id], nativeOwners: { [id]: original.recipientNative! }, mailboxProofs: proof(original) })).toEqual({ acked: 0 });
  expect(b.store.byId(id)?.body).toBe("namespace must restore with the ledger");
  expect(b.store.blockedOwnership().records.map(row => row.id)).toContain(id);
});

it("keeps a persisted tracked remote intent fenced across missing-provenance reconnect and source restart", async () => {
  let a = await persistentHost("pc-a"), b = await persistentHost("pc-b");
  const without = (service: NetworkService) => { const hello = service.extensionHelloCapabilities.bind(service); vi.spyOn(service, "extensionHelloCapabilities").mockImplementation(() => ({ ...hello(), mailboxProvenanceV1: false })); };
  await b.register(undefined, "destination", b.dir, "remote-native");
  let sender = await a.register(binding("a", "sender"), "sender"); const invite = await pairPersistent(a, b), id = randomUUID();
  const request = { messageId: id, to: "pc-b/destination", body: "capability backlog must not become local mail" };
  // Admit the exact authenticated destination while both hosts are compatible,
  // then lose transport before the receiver stores it. Capability refusal on a
  // first attempt must not create a partial/request-only intent.
  const dispatch = vi.spyOn(link(a.network), "send").mockRejectedValueOnce(new Error("fixture transport lost after atomic admission"));
  try { await expect(sender.client.request("trackedSend", request)).rejects.toThrow(/transport lost after atomic admission/); }
  finally { dispatch.mockRestore(); }
  const original = a.store.pinnedSends(id);
  expect(original).toHaveLength(1); expect(a.store.sendIntentOwner(id)).toBeDefined(); expect(b.store.byId(id)).toBeNull();
  await a.close(); await b.close(); a = await persistentHost("pc-a"); b = await persistentHost("pc-b"); without(b.network);
  await b.register(undefined, "destination", b.dir, "remote-native"); sender = await a.register(binding("a", "sender"), "sender");
  const local = await a.register(undefined, "destination", a.dir, "remote-native"); await pairPersistent(a, b, invite);
  await expect(sender.client.request("trackedSend", request)).rejects.toThrow(/mailboxProvenanceV1/);
  expect(a.store.pinnedSends(id)).toEqual(original);
  expect((await local.client.request("pending", {})).map(m => m.id)).not.toContain(id); expect(b.store.byId(id)).toBeNull();
  const unadmitted = { ...request, messageId: randomUUID() };
  await expect(sender.client.request("trackedSend", unadmitted)).rejects.toThrow(/mailboxProvenanceV1/);
  expect(a.store.sendIntentOwner(unadmitted.messageId)).toBeUndefined(); expect(a.store.pinnedSends(unadmitted.messageId)).toEqual([]);
  await a.close(); await b.close(); a = await persistentHost("pc-a"); b = await persistentHost("pc-b");
  const actual = await b.register(undefined, "destination", b.dir, "remote-native"); sender = await a.register(binding("a", "sender"), "sender"); await pairPersistent(a, b, invite);
  await sender.client.request("trackedSend", request);
  expect((await actual.client.request("pending", {})).find(m => m.id === id)?.body).toBe(request.body);
  expect(a.store.pinnedSends(id)).toEqual(original); expect(b.store.messagesById(id)).toHaveLength(1);
  await sender.client.request("trackedSend", request); expect(b.store.messagesById(id)).toHaveLength(1);
});

it("binds remote sender receipts to the authenticated fingerprint even if a newly paired host reuses its ID and native session", async () => {
  const a = await persistentHost("pc-a"), b = await persistentHost("pc-b"), sender = await a.register(undefined, "sender", a.dir, "sender-A"), recipient = await b.register(undefined, "destination", b.dir, "recipient");
  await pairPersistent(a, b); const identity = a.network.status().identity!, id = randomUUID();
  await sender.client.request("trackedSend", { messageId: id, to: "pc-b/destination", body: "source key identity is immutable" });
  const copy = (await recipient.client.request("pending", {})).find(m => m.id === id)!;
  await recipient.client.request("ack", { ids: [id], nativeOwners: { [id]: copy.recipientNative! }, mailboxProofs: proof(copy) });
  await a.close(); b.network.unlink(identity.id); await until(() => b.network.activeLinks === 0);
  const replacement = await persistentHost("pc-a", "different-authenticated-host");
  // Only generated fixture identities are mutated: no real key/config is read.
  (replacement.network.keys as any).state.identity.id = identity.id;
  const next = await replacement.register(undefined, "sender", replacement.dir, "sender-A");
  await pairPersistent(replacement, b);
  await expect(link(replacement.network).receipt(id, next.peer.id, "destination")).rejects.toThrow(/original.*sender|authenticated.*host/i);
  expect(b.store.byId(id)?.body).toBe("source key identity is immutable");
});

it.each(["source", "destination"])("keeps receipt authority stable through an authenticated %s display rename", async renamed => {
  let a = await persistentHost("pc-a"), b = await persistentHost("pc-b");
  let sender = await a.register(undefined, "sender", a.dir, "sender-A"), recipient = await b.register(undefined, "destination", b.dir, "recipient");
  await pairPersistent(a, b); const oldA = a.network.status().identity!, oldB = b.network.status().identity!, id = randomUUID();
  await sender.client.request("trackedSend", { messageId: id, to: "pc-b/destination", body: "host display is not authority" });
  const copy = (await recipient.client.request("pending", {})).find(m => m.id === id)!;
  await recipient.client.request("ack", { ids: [id], nativeOwners: { [id]: copy.recipientNative! }, mailboxProofs: proof(copy) });
  await a.close(); await b.close();
  a = await persistentHost(renamed === "source" ? "pc-a-renamed" : "pc-a", "pc-a");
  b = await persistentHost(renamed === "destination" ? "pc-b-renamed" : "pc-b", "pc-b");
  a.network.keys.remove(oldB.id); b.network.keys.remove(oldA.id); // Explicit fixture re-pair is required by the unchanged pairing contract.
  sender = await a.register(undefined, "sender", a.dir, "sender-A"); recipient = await b.register(undefined, "destination", b.dir, "recipient");
  await pairPersistent(a, b);
  expect((await sender.client.request("messageReceipt", { id }))[0]!.readAt).not.toBeNull();
  expect(a.store.messagesById(id).map(m => m.recipient)).toEqual(["pc-b/destination"]);
});

it.each(["destination", "*"])("preserves verified offline hosted ownership for %s through restart and native name reuse", async to => {
  let host = await persistentHost("pc-b");
  const original = binding("b", "offline-thread"), first = await host.register(original);
  first.client.close(); await until(() => !(host.broker as any).localPeers().length);
  await host.close(); host = await persistentHost("pc-b");
  const sender = await host.register(binding("a", "sender"), "sender"), id = randomUUID();
  await sender.client.request("trackedSend", { messageId: id, to, body: "private offline hosted mail" });
  await host.close(); host = await persistentHost("pc-b");
  const native = await host.register();
  expect((await native.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(id);
  expect(native.events.filter(m => m.id === id)).toEqual([]);
  expect(await native.client.request("ack", { ids: [id] })).toEqual({ acked: 0 });
  for (const wrong of [{ ...original, threadId: "wrong" }, { ...original, scope: "c".repeat(64) }, { ...original, providerInstanceId: "wrong" }]) {
    const claimant = await host.register(wrong);
    expect(await claimant.client.request("claimMail", { names: ["destination"] })).toEqual({ moved: 0 });
    expect((await claimant.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(id);
    expect(await claimant.client.request("ack", { ids: [id] })).toEqual({ acked: 0 });
  }
  const recovered = await host.register(original, "renamed-owner");
  expect((await recovered.client.request("pending", { limit: 100 })).map(m => m.id)).toContain(id);
  expect(await recovered.client.request("ack", { ids: [id], mailboxProofs: proof(host.store.byId(id)!) })).toEqual({ acked: 1 });
});

it("quarantines a new unknown destination while preserving proven offline native traffic", async () => {
  let host = await persistentHost("pc-b");
  const native = await host.register(undefined, "known-native", home, "known-native-session"); native.client.close();
  await until(() => !(host.broker as any).localPeers().length); await host.close(); host = await persistentHost("pc-b");
  const sender = await host.register(binding("a", "sender"), "sender"), known = randomUUID(), unknown = randomUUID();
  await sender.client.request("trackedSend", { messageId: known, to: "known-native", body: "verified native offline mail" });
  await sender.client.request("trackedSend", { messageId: unknown, to: "unknown", body: "no recipient evidence" });
  expect(await sender.client.request("sendState", { id: unknown })).toMatchObject({ state: "stored", blockedRecipients: [{ recipient: "unknown", reason: "recipient_ownership_unproven" }] });
  const successor = await host.register(undefined, "unknown", home, "unknown-native-session"),
    original = await host.register(undefined, "known-native", home, "known-native-session");
  expect((await successor.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(unknown);
  expect(await successor.client.request("ack", { ids: [unknown] })).toEqual({ acked: 0 });
  expect((await original.client.request("pending", { limit: 100 })).map(m => m.id)).toContain(known);
  expect(await original.client.request("ack", { ids: [known], mailboxProofs: proof(host.store.byId(known)!), nativeOwners: { [known]: host.store.byId(known)!.recipientNative! } })).toEqual({ acked: 1 });
  expect(host.store.byId(unknown)?.body).toBe("no recipient evidence");
});

it("refuses an unadvertised remote native destination before releasing its payload", async () => {
  const a = await persistentHost("pc-a"), b = await persistentHost("pc-b");
  const sender = await a.register(undefined, "native-sender"); await pairPersistent(a, b);
  const id = randomUUID();
  await expect(sender.client.request("trackedSend", { messageId: id, to: "pc-b/unknown", body: "unproven remote destination" })).rejects.toThrow(/ownership|destination/i);
  expect(b.store.byId(id)).toBeNull();
  expect(a.store.byId(id)).toBeNull();
});

it("does not infer native provenance from an older host lacking ownership negotiation", async () => {
  const sender = peer("sender"), destination = peer("native-target"), received = vi.fn(() => ({ delivered: true }));
  const a = service("pc-a", [sender], () => ({ delivered: true })), b = service("pc-b", [destination], received);
  const hello = b.extensionHelloCapabilities.bind(b);
  vi.spyOn(b, "extensionHelloCapabilities").mockImplementation(() => ({ ...hello(), recipientOwnershipV1: false }));
  await connect(a, b);
  await expect(a.send(message(sender, "pc-b/native-target"))).rejects.toThrow(/ownership|native fallback/i);
  expect(received).not.toHaveBeenCalled();
  const link = [...(a as any).links.values()][0], receipt = vi.spyOn(link, "receipt");
  await expect(a.receipt("pc-b/native-target", randomUUID(), "sender", true)).rejects.toThrow(/ownership/i);
  expect(receipt).not.toHaveBeenCalled();
});

it.each(["send", "receipt"])("refuses inbound %s from a peer without recipientOwnershipV1 before mailbox effects", async operation => {
  const sender = peer("sender"), destination = peer("native-target"), received = vi.fn(() => ({ delivered: true }));
  const a = service("pc-a", [sender], () => ({ delivered: true })), b = service("pc-b", [destination], received);
  const hello = a.extensionHelloCapabilities.bind(a);
  vi.spyOn(a, "extensionHelloCapabilities").mockImplementation(() => ({ ...hello(), recipientOwnershipV1: false }));
  vi.spyOn(b, "supportsReceipts", "get").mockReturnValue(true);
  const receipt = vi.spyOn(b, "readReceipt").mockReturnValue(1234);
  await connect(a, b);
  // The lower transport simulates an older sender which does not apply the new outbound gate.
  const request = operation === "send" ? link(a).send(message(sender, "native-target")) : link(a).receipt(randomUUID(), "sender", "native-target");
  await expect(request).rejects.toThrow(/recipientOwnershipV1|ownership/i);
  expect(received).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled();
});

it.each(["outbound-send", "outbound-receipt", "inbound-send", "inbound-receipt"])("requires nativeOwnershipV1 for %s before payload or receipt effects", async scenario => {
  const sender = peer("sender"), destination = peer("destination"), received = vi.fn(() => ({ delivered: true }));
  const a = service("pc-a", [sender], () => ({ delivered: true })), b = service("pc-b", [destination], received);
  const old = scenario.startsWith("inbound") ? a : b, hello = old.extensionHelloCapabilities.bind(old);
  vi.spyOn(old, "extensionHelloCapabilities").mockImplementation(() => ({ ...hello(), nativeOwnershipV1: false }));
  vi.spyOn(b, "supportsReceipts", "get").mockReturnValue(true); const receipt = vi.spyOn(b, "readReceipt").mockReturnValue(1234);
  await connect(a, b);
  const operation = scenario.startsWith("inbound") ? scenario.endsWith("send") ? link(a).send(message(sender, "destination")) : link(a).receipt(randomUUID(), "sender", "destination") :
    scenario.endsWith("send") ? a.send(message(sender)) : a.receipt("pc-b/destination", randomUUID(), "sender");
  await expect(operation).rejects.toThrow(/nativeOwnershipV1/);
  expect(received).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled();
});

it.each([2, 3, 4, 5, 6])("refuses protocol%s clients before registration, mailbox effects or daemon handover", async oldProtocol => {
  const host = await persistentHost("pc-b"), handover = vi.fn(); host.broker.onNewerClient(handover);
  const client = await BridgeClient.connect(host.pipe, nullLogger); cleanup.push(() => client.close());
  await expect(client.request("auth", { protocol: oldProtocol, token: host.token, canHost: true })).rejects.toThrow(/protocol|upgrade/i);
  await expect(client.request("hello", { protocol: oldProtocol, token: host.token, canHost: true, peer: peer("old-reader") })).rejects.toThrow();
  for (const operation of ["pending", "ack", "trackedSend"] as const) {
    await expect((client.request as any)(operation, { ids: ["absent"], messageId: "absent", to: "target", body: "must not store" })).rejects.toThrow();
  }
  expect(host.store.byId("absent")).toBeNull(); expect((host.broker as any).localPeers()).toEqual([]);
  expect(handover).not.toHaveBeenCalled(); expect(PROTOCOL_VERSION).toBe(7);
});

it.each([2, 3, 4, 5, 6])("new clients refuse a protocol%s endpoint without granting handover or later demand-start", async oldProtocol => {
  const dir = join(home, "old-endpoint"); mkdirSync(dir); const pipe = resolvePipePath(dir, {}), operations: string[] = [], auth: any[] = [];
  const sockets = new Set<import("node:net").Socket>();
  // Protocol2's exact auth refusal is sufficient; this endpoint implements no mailbox handlers.
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); const decoder = new FrameDecoder(1024 * 1024);
    socket.setEncoding("utf8"); socket.on("data", bytes => { for (const frame of decoder.push(String(bytes))) if (frame.t === "req") {
      operations.push(frame.op); auth.push(frame.args);
      if (frame.op === "auth" && (frame.args as any).protocol !== oldProtocol)
        socket.write(encodeFrame({ t: "res", id: frame.id, ok: false, error: { code: "protocol_mismatch", message: `broker speaks protocol ${oldProtocol}; coordinated upgrade required`, details: { brokerProtocol: oldProtocol } } }));
      else {
        const args = frame.args as any;
        const result = frame.op === "auth" ? { brokerPid: process.pid } : frame.op === "ping" ? { brokerPid: process.pid, protocol: oldProtocol } : frame.op === "peers" || frame.op === "pending" ? [] :
          args.peer ? { brokerPid: process.pid, name: args.peer.name, sessionId: args.peer.sessionId, nativeOwner: JSON.stringify({ kind: "session", agent: "codex", sessionId: args.peer.sessionId }), peers: [] } : {};
        socket.write(encodeFrame({ t: "res", id: frame.id, ok: true, result }));
      }
    } });
  });
  let closed = false; const close = async () => { if (closed) return; closed = true; for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); };
  cleanup.push(close); await new Promise<void>(resolve => server.listen(pipe, resolve));
  const launch = vi.fn(async () => { throw new Error("daemon launch forbidden"); });
  const node = new LiveBridgeNode({ pipePath: pipe, token: "isolated-fixture-token", dbPath: join(dir, "bridge.db"), agent: "codex", name: "new-client", cwd: dir,
    autoWake: false, daemon: { cli: "fixture-never-launch", launch }, log: nullLogger });
  cleanup.push(() => node.stop()); cleanup.push(() => closeMetadataDb(dir));
  await node.setSessionId("new-client-session");
  await expect(node.start()).rejects.toThrow(`protocol ${oldProtocol}`);
  expect(operations).toEqual(["auth"]); expect(auth[0].protocol).toBe(7); expect(auth[0].canHost).toBeUndefined();
  expect(server.listening).toBe(true); await close();
  await expect(node.ensureConnected()).rejects.toThrow(`protocol ${oldProtocol}`); expect(launch).not.toHaveBeenCalled();
});

it.each([2, 3, 4, 5, 6])("blocks a live prior protocol%s endpoint before shared mailbox migration or daemon launch", async oldProtocol => {
  const dir = join(home, `prior-${oldProtocol}`); mkdirSync(dir, { mode: 0o700 });
  const dbPath = join(dir, "bridge.db"), seed = new MessageStore(dbPath, nullLogger);
  const retained = message(peer("historical-sender"), "unknown"); seed.insert(retained); seed.close(); closeMetadataDb(dir);
  const db = new DatabaseSync(dbPath); db.exec("PRAGMA journal_mode=DELETE; PRAGMA user_version=12"); db.close();
  const before = readFileSync(dbPath), snapshots = () => existsSync(join(dir, ".migration-snapshots")) ? readdirSync(join(dir, ".migration-snapshots")).sort() : [];
  const backups = snapshots(), pipe = resolvePipePath(dir, {}).replace(new RegExp(`-p${PROTOCOL_VERSION}(?=\\.sock$|$)`), `-p${oldProtocol}`), operations: any[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.setEncoding("utf8");
    const decoder = new FrameDecoder(64 * 1024);
    socket.on("data", bytes => { for (const frame of decoder.push(String(bytes))) if (frame.t === "req") {
      operations.push({ op: frame.op, args: frame.args });
      socket.end(encodeFrame({ t: "res", id: frame.id, ok: false, error: { code: "protocol_mismatch", message: `broker speaks protocol ${oldProtocol}`, details: { brokerProtocol: oldProtocol } } }));
    } });
  });
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(pipe, resolve));
  const launch = vi.fn(async () => { throw new Error("daemon launch forbidden"); });
  const node = new LiveBridgeNode({ pipePath: resolvePipePath(dir, {}), dbPath, token: "isolated-fixture-token", agent: "codex", name: "new-client", cwd: dir,
    autoWake: false, daemon: { cli: "never-launch", launch }, log: nullLogger });
  cleanup.push(() => node.stop()); cleanup.push(() => closeMetadataDb(dir)); await node.setSessionId("current-session");
  await expect(node.start()).rejects.toThrow(/owner.coordinated shutdown/i);
  expect(launch).not.toHaveBeenCalled(); expect(server.listening).toBe(true);
  // Named-pipe ownership cannot be established with POSIX stat; an active
  // unknown pipe must be refused without disclosing the authentication token.
  if (process.platform !== "win32") expect(operations).toEqual([{ op: "auth", args: { protocol: PROTOCOL_VERSION, token: "isolated-fixture-token" } }]);
  expect(readFileSync(dbPath).equals(before)).toBe(true); expect(snapshots()).toEqual(backups);
});

it("refuses migration before backups when an old reader has opened the mailbox but has not bound an endpoint", async () => {
  const dir = join(home, "lease-before-endpoint"); mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, "bridge.db"), seed = new MessageStore(file, nullLogger), mail = message(peer("historical"), "unknown");
  seed.insert(mail); seed.close(); closeMetadataDb(dir);
  const old = new DatabaseSync(file); removeFixtureProvenance(old); old.exec("PRAGMA user_version=12; PRAGMA journal_mode=DELETE"); old.close();
  const users = join(dir, ".storage-users"); mkdirSync(users, { recursive: true });
  const lease = join(users, `${process.pid}-legacy-before-bind`); writeFileSync(lease, "", { flag: "wx", mode: 0o600 });
  const before = readFileSync(file), snapshots = () => existsSync(join(dir, ".migration-snapshots")) ? readdirSync(join(dir, ".migration-snapshots")).sort() : [];
  const backups = snapshots();
  expect(() => new MessageStore(file, nullLogger)).toThrow(/owner.coordinated shutdown/i);
  expect(readFileSync(file).equals(before)).toBe(true); expect(snapshots()).toEqual(backups); expect(readFileSync(lease).length).toBe(0);
  rmSync(lease); // This isolated fixture's own simulated legacy lease only.
  const migrated = new MessageStore(file, nullLogger); cleanup.push(() => migrated.close());
  expect(migrated.byId(mail.id)?.body).toBe(mail.body);
  expect(migrated.unread("unknown", 10)).toEqual([]);
});

it.each([["v0.27.0", 2], ["v0.28.2", 3]] as const)("requires explicit isolated offline admission for pre-lease %s schema%s", async (release, version) => {
  const dir = join(home, "pre-lease"); mkdirSync(dir, { mode: 0o700 });
  const file = join(dir, "bridge.db"); copyFileSync(join(import.meta.dirname, "fixtures/sqlite-upgrade", release, "bridge.db"), file);
  const original = readFileSync(file), launch = vi.fn(async () => { throw new Error("daemon launch forbidden"); });
  const node = new LiveBridgeNode({ pipePath: resolvePipePath(dir, {}), dbPath: file, token: "isolated-fixture-token", agent: "codex", name: "new-client", cwd: dir,
    autoWake: false, daemon: { cli: "never-launch", launch }, log: nullLogger }); cleanup.push(() => node.stop()); cleanup.push(() => closeMetadataDb(dir));
  await expect(node.start()).rejects.toThrow(/explicit offline migration/); expect(launch).not.toHaveBeenCalled();
  expect(() => new MessageStore(file, nullLogger)).toThrow(/explicit offline migration/);
  expect(readFileSync(file).equals(original)).toBe(true); expect(existsSync(join(dir, ".migration-snapshots"))).toBe(false);
  const db = new DatabaseSync(file);
  try {
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(version);
    const rows = db.prepare("SELECT * FROM messages").all();
    expect(() => migrateMessageSchema(db, file, true, nullLogger)).toThrow(/explicit offline migration/);
    expect(() => migrateMessageSchema(db, file, true, nullLogger, { kind: "offline-isolated", home })).toThrow(/explicit offline migration/);
    migrateMessageSchema(db, file, true, nullLogger, { kind: "offline-isolated", home: dir });
    expect(db.prepare("SELECT * FROM messages").all()).toEqual(rows);
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(14);
    expect(db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
  } finally { db.close(); }
});

it("rechecks admission when a current store is restored to a lease-aware older schema before writable open", () => {
  const dir = join(home, "restore-race"), other = join(home, "restore-source"); mkdirSync(dir); mkdirSync(other);
  const file = join(dir, "bridge.db"), replacement = join(other, "bridge.db");
  for (const path of [file, replacement]) {
    const store = new MessageStore(path, nullLogger); store.insert({ ...message(peer("historical"), "unknown"), id: "accepted-restore-bytes" }); store.close();
  }
  const older = new DatabaseSync(replacement); removeFixtureProvenance(older); older.exec("PRAGMA user_version=12; PRAGMA journal_mode=DELETE"); older.close();
  const expected = readFileSync(replacement), retained = join(dir, "original-v13.db"), close = DatabaseSync.prototype.close;
  let restored = false, reader: DatabaseSync | undefined;
  const lease = join(dir, ".storage-users", `${process.pid}-legacy-restore-reader`);
  const fault = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
    close.call(this);
    if (!restored) {
      restored = true; renameSync(file, retained); renameSync(replacement, file);
      writeFileSync(lease, "", { flag: "wx", mode: 0o600 }); reader = new DatabaseSync(file);
      expect(reader.prepare("SELECT body FROM messages WHERE id='accepted-restore-bytes'").get()!.body).toBe("remote mail");
    }
  });
  let opened: MessageStore | undefined;
  try {
    expect(() => { opened = new MessageStore(file, nullLogger); }).toThrow(/exclusion|owner.coordinated shutdown/i);
    expect(restored).toBe(true); expect(readFileSync(file).equals(expected)).toBe(true);
    expect(existsSync(join(dir, ".migration-snapshots"))).toBe(false); expect(existsSync(retained)).toBe(true);
  } finally { fault.mockRestore(); opened?.close(); reader?.close(); if (existsSync(lease)) rmSync(lease); }
});

it.each(["wrong-copy", "registration-change"])("fences native ACK replay across %s", async change => {
  const host = await persistentHost("pc-b"), native = await host.register(undefined, "destination"), sender = await host.register(binding("a", "sender"), "sender");
  const id = randomUUID(); await sender.client.request("trackedSend", { messageId: id, to: "destination", body: "native ownership proof" });
  const copy = (await native.client.request("pending", {})).find(m => m.id === id)!;
  if (change === "wrong-copy") {
    expect(await native.client.request("ack", { ids: [id], mailboxProofs: proof(copy), nativeOwners: { [id]: "another-copy" } })).toEqual({ acked: 0 });
    expect(host.store.receipts(id)[0]!.readAt).toBeNull();
    expect(await native.client.request("ack", { ids: [id], mailboxProofs: proof(copy), nativeOwners: { [id]: copy.recipientNative! } })).toEqual({ acked: 1 });
    return;
  }
  let release!: () => void, enter!: () => void; const gate = new Promise<void>(resolve => release = resolve), entered = new Promise<void>(resolve => enter = resolve);
  const original = host.store.retryWrite.bind(host.store); let held = false;
  vi.spyOn(host.store, "retryWrite").mockImplementation((async (operation: any, ...rest: any[]) => {
    if (!held) { held = true; enter(); await gate; }
    return (original as any)(operation, ...rest);
  }) as any);
  const ack = native.client.request("ack", { ids: [id], mailboxProofs: proof(copy), nativeOwners: { [id]: copy.recipientNative! } }).catch(error => error);
  await entered; await native.client.request("updatePeer", { name: "renamed-native" }); release();
  expect(await ack).toBeInstanceOf(Error); expect(host.store.receipts(id).every(r => r.readAt === null)).toBe(true);
  expect(await native.client.request("ack", { ids: [id], mailboxProofs: proof(copy), nativeOwners: { [id]: copy.recipientNative! } })).toEqual({ acked: 1 });
});

it("retains the native copy owner in queued ACK replay when the node reconnects as another recipient", async () => {
  const host = await persistentHost("pc-b"), first = liveRecipient(host), second = liveRecipient(host);
  const otherProject = join(host.dir, "other-native-project"); mkdirSync(otherProject);
  await first.setSessionId("first-session"); await first.start(); await second.relocate(otherProject); await second.setSessionId("second-session"); await second.start();
  const sender = await host.register(binding("a", "sender"), "sender"), id = randomUUID();
  await sender.client.request("trackedSend", { messageId: id, to: "*", body: "separate native broadcast copy" });
  await first.refreshPending(); await second.refreshPending(); const originalName = first.name, otherName = second.name;
  first.markRead([id]); (first as any).client.close();
  await until(() => !first.isConnected);
  await first.setSessionId("second-session"); await first.relocate(otherProject, otherName);
  await first.ensureConnected(); await first.refreshPending(); await first.refreshPending();
  expect(first.name).toBe(otherName); expect(first.get(id)?.body).toBe("separate native broadcast copy");
  expect(host.store.receipts(id).find(r => r.recipient === otherName)?.readAt).toBeNull();
  expect(host.store.receipts(id).find(r => r.recipient === originalName)?.readAt).toBeNull();
  first.markRead([id]); await first.refreshPending();
  await until(() => host.store.receipts(id).find(r => r.recipient === otherName)?.readAt !== null);
  expect(host.store.receipts(id).find(r => r.recipient === originalName)?.readAt).toBeNull();
});

it("retains schema10 hosted proofs without guessing historical mailbox direction", async () => {
  let host = await persistentHost("pc-b"); const frontend = binding("b", "schema10-owner");
  const owner = await host.register(frontend), native = await host.register(undefined, "old-native"), sender = await host.register(binding("a", "sender"), "sender");
  const hostedId = randomUUID(), nativeId = randomUUID();
  await sender.client.request("trackedSend", { messageId: hostedId, to: owner.peer.name, body: "proven hosted ledger" });
  await sender.client.request("trackedSend", { messageId: nativeId, to: native.peer.name, body: "no historical native provenance" });
  await host.close();
  const old = new DatabaseSync(host.db);
  removeFixtureProvenance(old);
  old.exec("ALTER TABLE message_frontends RENAME TO fixture_v11; CREATE TABLE message_frontends(id TEXT NOT NULL,recipient TEXT NOT NULL,binding TEXT NOT NULL,PRIMARY KEY(id,recipient)); INSERT INTO message_frontends SELECT id,recipient,binding FROM fixture_v11 WHERE binding<>''; DROP TABLE fixture_v11; DROP TABLE IF EXISTS recipient_registrations; PRAGMA user_version=10;");
  old.close(); host = await persistentHost("pc-b");
  const nativeSuccessor = await host.register(undefined, "old-native");
  expect((await nativeSuccessor.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(nativeId);
  expect(await nativeSuccessor.client.request("ack", { ids: [nativeId] })).toEqual({ acked: 0 });
  const recovered = await host.register(frontend, "recovered-hosted");
  expect((await recovered.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(hostedId);
  expect(host.store.byId(hostedId)?.recipientFrontend).toEqual(frontend);
  expect(host.store.byId(hostedId)?.recipientAmbiguous).toBe(true);
  expect(host.store.blockedOwnership(100).records.map(m => m.id)).toContain(hostedId);
  const fresh = randomUUID(); const newSender = await host.register(binding("a", "new-sender"), "new-sender");
  await newSender.client.request("trackedSend", { messageId: fresh, to: recovered.peer.name, body: "new verified local direction" });
  expect((await recovered.client.request("pending", {})).map(m => m.id)).toContain(fresh);
});

it("migrates intermediate schema11 through13 additively, rolls back interruption, preserves backups and quarantines untyped native proofs", async () => {
  const host = await persistentHost("pc-b"), frontend = binding("b", "migration-owner");
  const hosted = await host.register(frontend), native = await host.register(undefined, "native", host.dir, "opaque-native"), sender = await host.register(binding("a", "sender"), "sender");
  const hostedId = randomUUID(), nativeId = randomUUID();
  await sender.client.request("trackedSend", { messageId: hostedId, to: hosted.peer.name, body: "retain hosted columns" });
  await sender.client.request("trackedSend", { messageId: nativeId, to: native.peer.name, body: "retain native proof bytes" });
  await host.close(); const db = new DatabaseSync(host.db); let closed = false; cleanup.push(() => { if (!closed) db.close(); });
  removeFixtureProvenance(db);
  const has = (table: string, column: string) => db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column);
  for (const column of ["owner", "sender"]) if (has("message_frontends", column)) db.exec(`ALTER TABLE message_frontends DROP COLUMN ${column}`);
  if (has("recipient_registrations", "owner")) db.exec("ALTER TABLE recipient_registrations DROP COLUMN owner");
  const proof = JSON.stringify(["native-copy", "native", "codex", JSON.stringify(["codex", 111111, "created", host.dir, "native"])]);
  db.prepare("UPDATE message_frontends SET identity=? WHERE id=?").run(proof, nativeId);
  db.prepare("UPDATE messages SET read_at=1234 WHERE id=?").run(nativeId); db.exec("PRAGMA user_version=11");
  const originalRows = db.prepare("SELECT * FROM messages ORDER BY id").all(), originalOwners = db.prepare("SELECT * FROM message_frontends ORDER BY id").all();
  const exec = db.exec.bind(db); let interrupted = false;
  const fault = vi.spyOn(db, "exec").mockImplementation(sql => {
    if (!interrupted && sql.includes("ALTER TABLE message_frontends ADD COLUMN owner")) {
      interrupted = true; exec(sql.slice(0, sql.indexOf(";") + 1)); throw new Error("fixture interruption after first additive column");
    }
    return exec(sql);
  });
  expect(() => migrateMessageSchema(db, host.db, true, nullLogger)).toThrow(/fixture interruption/); fault.mockRestore();
  expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(11); expect(has("message_frontends", "owner")).toBe(false);
  expect(db.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(originalRows);
  expect(db.prepare("SELECT * FROM message_frontends ORDER BY id").all()).toEqual(originalOwners);
  expect(readdirSync(join(host.dir, ".migration-snapshots")).length).toBeGreaterThan(0);
  migrateMessageSchema(db, host.db, true, nullLogger); migrateMessageSchema(db, host.db, true, nullLogger);
  expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(14);
  expect(db.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(originalRows);
  expect(db.prepare("SELECT id,recipient,binding,state,identity FROM message_frontends ORDER BY id").all()).toEqual(originalOwners);
  expect(db.prepare("SELECT owner FROM message_frontends WHERE id=?").get(nativeId)!.owner).toBe("");
  db.close(); closed = true;
  const reopened = new MessageStore(host.db, nullLogger); cleanup.push(() => reopened.close());
  expect(reopened.unread(hosted.peer.name, 100, frontend).map(m => m.id)).not.toContain(hostedId);
  expect(reopened.byId(hostedId)?.recipientFrontend).toEqual(frontend);
  expect(reopened.byId(hostedId)?.recipientAmbiguous).toBe(true);
  expect(reopened.byId(nativeId)?.recipientAmbiguous).toBe(true); expect(reopened.receipts(nativeId)[0]!.readAt).toBeNull();
  expect(reopened.blockedOwnership().records.some(row => row.id === nativeId && row.readAt === 1234)).toBe(true);
});

it.each([false, true])("quarantines schema9 hosted-era copies without attributing historical read marks (%s)", async read => {
  let host = await persistentHost("pc-b");
  const owner = binding("b", "old-hosted"), first = liveRecipient(host, owner);
  await first.start(); const sender = await host.register(binding("a", "sender"), "sender"), id = randomUUID();
  await sender.client.request("trackedSend", { messageId: id, to: first.name, body: "schema9 private hosted bytes" });
  await first.refreshPending(); expect(first.get(id)).toBeDefined();
  if (read) {
    // Historical v9 bytes: hosted readers wrote name/session marks before an ACK.
    const journal = new ReadJournal(host.dir);
    journal.append("name:destination", [id]); journal.append("session:old-native-session", [id]);
  }
  await first.stop(); await host.close();
  const old = new DatabaseSync(host.db);
  removeFixtureProvenance(old);
  old.exec("DROP TABLE IF EXISTS recipient_registrations; DROP TABLE message_frontends; DROP TABLE send_intents; DROP TABLE send_destinations; PRAGMA user_version=9;");
  const rows = old.prepare("SELECT * FROM messages").all(); old.close();
  host = await persistentHost("pc-b");
  const native = liveRecipient(host); await native.setSessionId("old-native-session"); await native.start(); await native.refreshPending();
  await native.refreshPending(); // Flush even a queued replay auto-ACK before checking isolation.
  expect(host.store.receipts(id)[0]?.readAt).toBeNull();
  expect(native.get(id)).toBeUndefined();
  const raw = new DatabaseSync(host.db, { readOnly: true });
  expect(raw.prepare("SELECT * FROM messages").all()).toEqual(rows); raw.close();
  expect((await host.register(owner, "original-binding")).events.filter(m => m.id === id)).toEqual([]);
  expect(host.store.blockedOwnership(100).records.map(m => m.id)).toContain(id);
  if (read) {
    expect(new ReadJournal(host.dir).read("name:destination")).toContain(id);
    const history = new DatabaseSync(host.db); history.prepare("UPDATE messages SET read_at=1234 WHERE id=?").run(id); history.close();
    expect(host.store.receipts(id)[0]?.readAt).toBeNull();
    expect(host.store.blockedOwnership(100).records.find(m => m.id === id)?.readAt).toBe(1234);
  }
});

it("does not infer native authority when an ownership row is missing after archive/reopen", async () => {
  let host = await persistentHost("pc-b");
  const owner = await host.register(binding("b", "owner"));
  const sender = await host.register(binding("a", "sender"), "sender"), id = randomUUID();
  await sender.client.request("trackedSend", { messageId: id, to: owner.peer.name, body: "missing ledger stays private" });
  await host.close();
  const damaged = new DatabaseSync(host.db); damaged.prepare("DELETE FROM message_frontends WHERE id=?").run(id); damaged.close();
  host = await persistentHost("pc-b"); const native = await host.register();
  expect((await native.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(id);
  expect(await native.client.request("ack", { ids: [id] })).toEqual({ acked: 0 });
  expect(host.store.byId(id)?.body).toBe("missing ledger stays private");
});

it("does not use historical hosted-era read marks to consume a newly proven native copy", async () => {
  const host = await persistentHost("pc-b"), id = randomUUID();
  new ReadJournal(host.dir).append("name:destination", [id]);
  const native = liveRecipient(host); await native.start();
  const sender = await host.register(binding("a", "sender"), "sender");
  await sender.client.request("trackedSend", { messageId: id, to: native.name, body: "native consumption needs native provenance" });
  await native.refreshPending();
  expect(native.get(id)?.body).toBe("native consumption needs native provenance");
  expect(host.store.receipts(id)[0]?.readAt).toBeNull();
  native.markRead([id]); await native.stop();
  const restarted = liveRecipient(host); await restarted.start(); await restarted.refreshPending();
  await until(() => host.store.receipts(id)[0]?.readAt !== null);
  expect(restarted.get(id)).toBeUndefined();
});

it.each(["insert", "claim"])("backs up mail and authorization at a consistent boundary during %s/archive interleaving", async mode => {
  const host = await persistentHost("pc-b"), frontend = binding("b", "archive-owner");
  const registration = await host.register(frontend, "offline-owner"); registration.client.close();
  await until(() => !(host.broker as any).localPeers().length);
  const initial = { ...message(peer("sender"), "old-recipient"), recipientFrontend: frontend };
  host.store.insert(initial);
  const later = { ...message(peer("sender"), "new-recipient"), recipientFrontend: frontend };
  const pin = { hostId: randomUUID(), hostFingerprint: "f".repeat(64), name: "new-recipient", frontend };
  let interleaved = false;
  const backup = await messageBackupIfDue(host.dir, { checkpoint: async () => {
    if (interleaved || !existsSync(join(host.dir, "message-backups"))) return;
    const pending = readdirSync(join(host.dir, "message-backups")).find(f => f.startsWith(".pending-"));
    if (!pending) return;
    const path = join(host.dir, "message-backups", pending, "bridge.messages.db"); if (!existsSync(path)) return;
    const check = new DatabaseSync(path, { readOnly: true });
    const complete = check.prepare("SELECT 1 FROM sqlite_master WHERE name='send_destinations'").get(); check.close();
    if (!complete) return;
    interleaved = true;
    if (mode === "insert") {
      host.store.rememberSendIntent(later.id, "fixture-owner", "fixture-request"); host.store.pinDestination(later, pin); host.store.insert(later);
    } else expect(host.store.claim("old-recipient", "new-recipient", frontend)).toBe(1);
    host.store.expireQueued("new-recipient", Date.now() + 1000);
  } });
  expect(interleaved).toBe(true); expect(backup.path).toBeTruthy();
  const primary = new DatabaseSync(join(backup.path!, "bridge.messages.db"), { readOnly: true });
  const archived = new DatabaseSync(join(backup.path!, "archive.messages.db"), { readOnly: true });
  try {
    const copies = [...primary.prepare("SELECT id,recipient FROM messages").all(), ...archived.prepare("SELECT id,recipient FROM messages").all()];
    expect(copies.some(row => row.id === initial.id)).toBe(true);
    for (const row of copies) {
      expect(primary.prepare("SELECT binding FROM message_frontends WHERE id=? AND recipient=?").get(row.id!, row.recipient!)?.binding).toBe(JSON.stringify(frontend));
      if (row.id === later.id) {
        expect(primary.prepare("SELECT owner FROM send_intents WHERE id=?").get(later.id)?.owner).toBe("fixture-owner");
        expect(JSON.parse(String(primary.prepare("SELECT destination FROM send_destinations WHERE id=?").get(later.id)?.destination))).toEqual(pin);
      }
    }
  } finally { primary.close(); archived.close(); }
  // Restore the documented selected-table group into fresh production stores,
  // then use their actual ownership decoder/read filters.
  const restoredDir = join(home, "restored"); mkdirSync(restoredDir);
  const restored = new MessageStore(join(restoredDir, "bridge.db"), nullLogger); cleanup.push(() => restored.close());
  expect(restored.namespace).not.toBe(host.store.namespace);
  for (const [snapshot, destination] of [["bridge.messages.db", "bridge.db"], ["archive.messages.db", "archive.db"]]) {
    const db = new DatabaseSync(join(restoredDir, destination!));
    try {
      db.prepare("ATTACH DATABASE ? AS selected_snapshot").run(join(backup.path!, snapshot!));
      const names = db.prepare("SELECT name FROM selected_snapshot.sqlite_master WHERE type='table'").all().map(row => String(row.name));
      for (const name of names) {
        if (!/^[a-z_]+$/.test(name)) throw new Error("unexpected snapshot table");
        if (name === "mailbox_store") db.exec("DELETE FROM main.mailbox_store"); // Isolated fresh restore adopts the complete selected namespace.
        db.exec(`INSERT OR IGNORE INTO main.${name} SELECT * FROM selected_snapshot.${name}`);
      }
    } finally { db.close(); }
  }
  expect(restored.byId(initial.id)?.recipientFrontend).toEqual(frontend);
  expect(restored.namespace).toBe(host.store.namespace);
  expect(restored.unread("old-recipient", 100).map(m => m.id)).not.toContain(initial.id);
  expect(restored.unread("old-recipient", 100, frontend).map(m => m.id)).toContain(initial.id);
  expect(restored.recipientOwnership("offline-owner").recipientFrontend).toEqual(frontend);
});

it("refuses a verified backup while a source writer prevents a stable boundary and recovers afterward", async () => {
  const host = await persistentHost("pc-b"), writer = new DatabaseSync(host.db);
  writer.exec("BEGIN IMMEDIATE");
  try {
    await expect(messageBackupIfDue(host.dir, { checkpoint: async () => {} })).rejects.toThrow(/locked|busy/i);
    expect(readdirSync(join(host.dir, "message-backups")).filter(name => name.startsWith("messages-"))).toEqual([]);
  } finally { writer.exec("ROLLBACK"); writer.close(); }
  const recovered = await messageBackupIfDue(host.dir, { checkpoint: async () => {} });
  expect(recovered.path).toBeTruthy();
  expect(JSON.parse(readFileSync(join(recovered.path!, "manifest.json"), "utf8")).files.some((file: {tables: {name: string}[]}) =>
    file.tables.some(table => table.name === "message_archive_conflicts"))).toBe(true);
});

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
  expect(await reconnected.client.request("ack", { ids: [id], mailboxProofs: proof(b.store.byId(id)!) })).toEqual({ acked: 1 });
  expect((await impostor.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(id);
});
it.each(["hosted", "native", "original-online"])("keeps the pinned remote project authority when a local %s recipient appears", async kind => {
  let a = await persistentHost("pc-a"); const b = await persistentHost("pc-b");
  const remoteProject = join(b.dir, "target"); mkdirSync(remoteProject);
  await b.register(binding("b", "original-thread"), "destination", remoteProject);
  const sender = new LiveBridgeNode({ pipePath: a.pipe, token: a.token, dbPath: a.db, agent: "codex", name: "sender", cwd: a.dir,
    frontend: binding("a", "sender-thread"), autoWake: false, canHostBroker: false, log: nullLogger });
  cleanup.push(() => sender.stop()); await sender.start(); await pairPersistent(a, b);
  expect((await sender.peers()).some(p => p.host && p.projectAddress === "project:target")).toBe(true);
  const id = randomUUID(); let reached!: () => void, resume!: () => void;
  const intercepted = new Promise<void>(resolve => { reached = resolve; }), resumed = new Promise<void>(resolve => { resume = resolve; });
  const connected = sender.ensureConnected.bind(sender); let retrying = false;
  vi.spyOn(sender, "ensureConnected").mockImplementation(async () => { if (retrying) await resumed; return connected(); });
  const transport = link(a.network), write = transport.write.bind(transport);
  vi.spyOn(transport, "write").mockImplementation((frame: any) => {
    if (frame.type !== "send") return write(frame);
    retrying = true; (sender as any).client.close(); reached();
    throw new Error("fixture source crash before dispatch");
  });
  const sent = sender.send({ messageId: id, to: "project:target", body: "remote authority must remain remote" }).catch(error => error);
  try {
    await intercepted;
    expect(a.store.pinnedDestinations(id)).toHaveLength(1);
    expect(a.store.byId(id)).toBeNull(); expect(b.store.byId(id)).toBeNull();
    await a.close();
    if (kind === "original-online") await until(() => b.network.peers().length === 0);
    else await b.close();
    a = await persistentHost("pc-a");
    const localProject = join(a.dir, "target"); mkdirSync(localProject);
    const local = await a.register(kind !== "native" ? binding("a", "new-local-thread") : undefined, "destination", localProject);
    // The source's persisted pairing reconnects automatically when B stayed online.
    if (kind === "original-online") await until(() => a.network.peers().some(p => p.frontend?.threadId === "original-thread"));
    resume();
    const result = await sent;
    if (kind === "original-online") {
      expect(result).not.toBeInstanceOf(Error);
      expect(b.store.byId(id)?.recipientFrontend).toEqual(binding("b", "original-thread"));
    } else expect(result).toBeInstanceOf(Error);
    expect(local.events.filter(m => m.id === id)).toEqual([]);
    expect((await local.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(id);
    if (kind !== "original-online") expect(a.store.byId(id)).toBeNull();
  } finally { resume(); await sent; }
});

function liveRecipient(host: Awaited<ReturnType<typeof persistentHost>>, frontend?: T3Binding, name = "destination") {
  const node = new LiveBridgeNode({ pipePath: host.pipe, token: host.token, dbPath: host.db, agent: "codex", name, cwd: host.dir,
    frontend, autoWake: false, canHostBroker: false, log: nullLogger });
  cleanup.push(() => node.stop()); return node;
}

it.each(["project:target", "*"])("refuses restart retry with missing destination evidence for %s", async to => {
  let host = await persistentHost("pc-a");
  let sender = await host.register(binding("a", "sender"), "sender");
  const args = { messageId: randomUUID(), to, body: "cannot discover a new destination on retry" };
  await expect(sender.client.request("trackedSend", args)).rejects.toThrow(/routing failed/);
  expect(host.store.byId(args.messageId)).toBeNull();
  await host.close(); host = await persistentHost("pc-a");
  sender = await host.register(binding("a", "sender"), "sender");
  const project = join(host.dir, "target"); mkdirSync(project);
  const replacement = await host.register(binding("a", "new-recipient"), "destination", project);
  await expect(sender.client.request("trackedSend", args)).rejects.toThrow(/Original destination/);
  expect(replacement.events).toEqual([]);
  expect(host.store.byId(args.messageId)).toBeNull();
});

it("does not redispatch a stored alias through alternate send entry points", async () => {
  const host = await persistentHost("pc-a"), sender = await host.register(binding("a", "sender"), "sender");
  const first = await host.register(binding("a", "first"), "first");
  const anchor = randomUUID();
  await first.client.request("trackedSend", { messageId: anchor, to: sender.peer.name, body: "reply anchor" });
  const args = { messageId: randomUUID(), to: "codex", body: "only the original alias destination", ifNoNewerThan: anchor };
  await sender.client.request("trackedSend", args);
  first.client.close(); await until(() => !(host.broker as any).localPeers().some((p: PeerInfo) => p.id === first.peer.id));
  const later = await host.register(binding("a", "later"), "later");
  await sender.client.request("send", args);
  await sender.client.request("guardedSend", args);
  expect((await later.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(args.messageId);
  expect(later.events.filter(m => m.id === args.messageId)).toEqual([]);
  expect(host.store.messagesById(args.messageId).map(m => m.recipient)).toEqual(["first"]);
  await expect(sender.client.request("send", { ...args, to: later.peer.name })).rejects.toThrow(/different/);
  await sender.client.request("modeSend", { ...args, mode: "auto" });
  expect(host.store.messagesById(args.messageId)).toHaveLength(1);
});

it.each(["thread", "provider", "scope", "hosted-to-native", "native-to-hosted", "native-to-native"])("isolates broadcast read recovery across %s and retains same-binding lost ACK recovery", async changed => {
  const host = await persistentHost("pc-b"), firstBinding = changed.startsWith("native-to-") ? undefined : binding("b", "first");
  const nextBinding = changed === "hosted-to-native" || changed === "native-to-native" ? undefined : { ...binding("b", "first"),
    ...(changed === "provider" ? { providerInstanceId: "other-provider" } : changed === "scope" ? { scope: "c".repeat(64) } : { threadId: "second" }) };
  const first = liveRecipient(host, firstBinding), second = liveRecipient(host, nextBinding);
  await first.setSessionId("shared-native-session"); await first.start();
  const secondSession = changed === "native-to-native" ? "second-native-session" : "shared-native-session";
  await second.setSessionId(secondSession); await second.start();
  expect(first.name).not.toBe(second.name);
  const sender = await host.register(binding("a", "sender"), "sender"), id = randomUUID();
  await sender.client.request("trackedSend", { messageId: id, to: "*", body: "independent broadcast reads" });
  await first.refreshPending(); await second.refreshPending();
  expect(first.get(id)).toBeDefined(); expect(second.get(id)).toBeDefined();
  first.markRead([id]); await until(() => host.store.receipts(id).some(r => r.recipient === first.name && r.readAt !== null));
  await second.stop();
  const restarted = liveRecipient(host, nextBinding);
  await restarted.setSessionId(secondSession); await restarted.start(); await restarted.refreshPending();
  expect(restarted.get(id)?.body).toBe("independent broadcast reads");
  expect(host.store.receipts(id).find(r => r.recipient === restarted.name)?.readAt).toBeNull();
  const tail = randomUUID();
  await sender.client.request("trackedSend", { messageId: tail, to: "*", body: "still unread after recovery" });
  await restarted.refreshPending();
  // Lose the ACK after the durable read mark, then recover through a fresh node,
  // registration and production replay/ACK; its ephemeral peer id is different.
  restarted.markRead([id]); await restarted.stop();
  expect(host.store.receipts(id).find(r => r.recipient === restarted.name)?.readAt).toBeNull();
  const recovered = liveRecipient(host, nextBinding, nextBinding ? "renamed-destination" : "destination");
  await recovered.setSessionId(nextBinding ? "changed-native-session" : secondSession); await recovered.start(); await recovered.refreshPending();
  await until(() => host.store.receipts(id).filter(r => r.readAt !== null).length === 2);
  expect(recovered.get(id)).toBeUndefined();
  expect(recovered.get(tail)?.body).toBe("still unread after recovery");
});

it("retains legacy journal bytes and native evidence without inferring hosted reads", async () => {
  const dir = join(home, "pc-b"), legacyDir = join(dir, "read-state"); mkdirSync(legacyDir, { recursive: true });
  const id = randomUUID(), raw = JSON.stringify({ ids: [id], at: 1234 }) + '\n["interrupted';
  const file = createHash("sha256").update("name:destination").digest("hex") + ".jsonl";
  writeFileSync(join(legacyDir, file), raw);
  const host = await persistentHost("pc-b"), hosted = liveRecipient(host, binding("b", "target"));
  await hosted.start();
  const sender = await host.register(binding("a", "sender"), "sender");
  await sender.client.request("trackedSend", { messageId: id, to: "*", body: "legacy mark is not hosted ownership" });
  await hosted.refreshPending();
  expect(hosted.get(id)?.body).toBe("legacy mark is not hosted ownership");
  expect(host.store.receipts(id)[0]?.readAt).toBeNull();
  expect(new ReadJournal(dir).read("name:destination")).toContain(id);
  const retained = metadataDb(dir).prepare("SELECT cold_path FROM bridge_imports WHERE path=?").get(`read-state/${file}`);
  expect(readFileSync(String(retained?.cold_path), "utf8")).toBe(raw);
  await hosted.stop();
  const native = liveRecipient(host); await native.start();
  // Historical hosted/native marks share a namespace and grant neither successor.
  expect(native.hasSeen(id)).toBe(false);
});

it("binds locally delivered result receipts to the hosted reader and preserves old native marks", async () => {
  const host = await persistentHost("pc-b"), id = randomUUID();
  new ReadJournal(host.dir).append("name:destination", [id]);
  const frontend = binding("b", "local-result-thread"), node = liveRecipient(host, frontend);
  await node.start();
  const result = { ...message(peer("job-name"), node.name), id,
    from: { id: "job:fixture", name: "job-name", agent: "codex" as const }, body: "Subagent job-name done after 1s.\nresult" };
  node.deliverLocal(result);
  expect(node.get(id)?.body).toBe(result.body);
  expect(localResultReceipt(host.dir, "job-name", node.name, 0, Date.now() + 1)?.status).toBe("delivered");
  node.markRead([id]);
  expect(localResultReceipt(host.dir, "job-name", node.name, 0, Date.now() + 1)?.status).toBe("read");
  expect(new ReadJournal(host.dir).read("name:destination")).toContain(id);
  expect(() => node.deliverLocal({ ...result, id: randomUUID(), recipientFrontend: binding("b", "foreign") })).toThrow(/frontend/);
});

it("quarantines unfenced mail and refuses native or hosted stand-in claims", async () => {
  const b = await persistentHost("pc-b");
  const legacy = message(peer("legacy"), "destination"); b.store.insert(legacy);
  const bound = await b.register(binding("b", "original-thread"));
  expect((await bound.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(legacy.id);
  bound.client.close(); await until(() => !(b.broker as any).localPeers().length);
  const native = await b.register();
  expect((await native.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(legacy.id);
  expect(await native.client.request("ack", { ids: [legacy.id] })).toEqual({ acked: 0 });
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
  expect(await other.client.request("ack", { ids: [id], mailboxProofs: proof(b.store.byId(id)!) })).toEqual({ acked: 1 });
  expect(b.store.receipts(id).find(r => r.recipient === "destination")?.readAt).toBeNull();
});

it("migrates v9 additively without attributing legacy rows and retains ownership through archive/reopen", async () => {
  let b = await persistentHost("pc-b");
  const legacy = message(peer("legacy"), "destination"); b.store.insert(legacy);
  const file = b.db; await b.close();
  const old = new DatabaseSync(file);
  removeFixtureProvenance(old);
  old.exec("DROP TABLE IF EXISTS recipient_registrations; DROP TABLE message_frontends; DROP TABLE send_intents; DROP TABLE send_destinations; PRAGMA user_version=9;");
  const before = old.prepare("SELECT * FROM messages").all(); old.close();
  b = await persistentHost("pc-b");
  const current = new DatabaseSync(file, { readOnly: true });
  try {
    expect(current.prepare("PRAGMA user_version").get()!.user_version).toBe(14);
    expect(current.prepare("SELECT * FROM messages").all()).toEqual(before);
  } finally { current.close(); }
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

it.each(["thread", "host", "same-binding", "native-session", "native-process", "native-host", "native-same"])("pins first dispatch across source broker loss and automatic tracked retry (%s)", async changed => {
  let a = await persistentHost("pc-a"), b = await persistentHost("pc-b");
  const native = changed.startsWith("native-"), original = native ? undefined : binding("b", "original-thread");
  const first = await b.register(original, "destination", b.dir, changed === "native-process" ? null : "native-A",
    changed === "native-process" ? { agentPid: 111111, agentStartedAt: "fixture-process-identity" } : {});
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
  expect(intent).toMatchObject({ hostId: b.network.keys.identity.id, hostFingerprint: b.network.keys.identity.fingerprint, ...(original ? { frontend: original } : {}) });
  persisted.close();
  await a.close(); first.client.close(); await b.close();
  const changedHost = changed === "host" || changed === "native-host";
  b = await persistentHost("pc-b", changedHost ? "replacement-pc-b" : "pc-b");
  const next = await b.register(changed === "thread" ? binding("b", "new-thread") : original, "destination", b.dir,
    changed === "native-process" ? null : changed === "native-session" ? "native-B" : "native-A",
    changed === "native-process" ? { agentPid: 222222, agentStartedAt: "fixture-process-identity" } : {});
  a = await persistentHost("pc-a");
  if (changedHost) {
    const old = a.network.status().paired[0]!;
    await a.admin.request("networkUnlink", { id: old.id });
    await pairPersistent(a, b);
  } else await pairPersistent(a, b, invite);
  resume();
  const result = await sent;
  if (changed === "same-binding" || changed === "native-same") {
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
  readProcessIdentities: async (pids: number[]) => new Map(pids.map(pid => [pid, "fixture-process-identity"])),
}));
vi.mock("../src/core/muse-context.js", async original => ({
  ...await original<typeof import("../src/core/muse-context.js")>(),
  registerMuseContext: () => () => {}, registerMuseContextAsync: async () => () => {},
  writeMusePrivateJsonAsync: async () => { throw new Error("unrelated Muse TCP discovery disabled in fixture"); },
}));

let home: string;
let cleanup: (() => void | Promise<void>)[];
beforeEach(() => {
  vi.stubEnv("AGENT_BRIDGE_HISTORY_INGEST", "0");
  vi.stubEnv("AGENT_BRIDGE_AUTO_BACKUP", "0");
  vi.spyOn(process, "kill").mockImplementation((_pid, signal) => { if (signal === 0) return true; throw new Error("process termination forbidden in fixture"); });
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
  vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllEnvs();
});

const binding = (host: "a" | "b", threadId: string): T3Binding => ({
  kind: "t3", scope: host.repeat(64), threadId, providerInstanceId: `provider-${host}`,
});
function peer(name: string, frontend?: T3Binding): PeerInfo {
  return { id: randomUUID(), name, agent: "codex", cwd: home, pid: process.pid, agentPid: null,
    sessionId: "same-native-provider-id", startedAt: Date.now(), autoWake: false, frontend };
}
function proof(message: BridgeMessage): NonNullable<import("../src/core/protocol.js").AckArgs["mailboxProofs"]> {
  return message.recipientMailbox ? { [message.id]: message.recipientMailbox } : {};
}
function removeFixtureProvenance(db: DatabaseSync) {
  db.exec("DROP TABLE IF EXISTS job_mail_grants; DROP TABLE IF EXISTS job_mail_succession; DROP TABLE IF EXISTS job_mail_retirements");
  db.exec("DROP INDEX IF EXISTS idx_message_mailbox_owner; DROP TABLE IF EXISTS mailbox_store");
  for (const [table, columns] of [["message_frontends", ["mailbox", "source"]], ["send_intents", ["namespace"]], ["send_destinations", ["namespace"]], ["job_delivery_routes", ["namespace"]]] as const)
    for (const column of columns) if (db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
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

it("delivers explicitly owned native mail with nativeOwnershipV1 independently of T3 routing capability", async () => {
  const sender = peer("native-sender"), destination = peer("destination");
  const received = vi.fn(() => ({ delivered: true }));
  const a = service("pc-a", [sender], () => ({ delivered: true })), b = service("pc-b", [destination], received);
  const hello = b.extensionHelloCapabilities.bind(b);
  vi.spyOn(b, "extensionHelloCapabilities").mockImplementation(() => ({ ...hello(), t3ThreadRouting: false }));
  await connect(a, b);
  expect(await a.send(message(sender))).toMatchObject({ deliveredTo: ["pc-b/destination"] });
  expect(received).toHaveBeenCalledTimes(1);
  expect(JSON.parse((received.mock.calls as any)[0][1].native)).toMatchObject({ kind: "session", agent: "codex", sessionId: destination.sessionId });
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
  await expect(link(a).send({ ...message(sender), senderOwner: `hosted:${JSON.stringify(sender.frontend)}`, recipient: "destination" })).rejects.toThrow(/binding|destination|thread/i);
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
