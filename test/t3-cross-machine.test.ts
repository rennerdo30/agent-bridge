import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import type { BridgeMessage, PeerInfo } from "../src/core/protocol.js";
import { encodeFrame, FrameDecoder } from "../src/core/protocol.js";
import { MessageStore } from "../src/core/store.js";
import { ReadJournal } from "../src/core/read-journal.js";
import { closeMetadataDb, metadataDb } from "../src/core/metadata-db.js";
import { localResultReceipt } from "../src/core/local-result-receipts.js";
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
  cleanup.push(() => closeMetadataDb(dir));
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
  const register = async (frontend?: T3Binding, name = "destination", cwd = home, sessionId = "same-native-provider-id") => {
    const client = await BridgeClient.connect(pipe, nullLogger); cleanup.push(() => client.close());
    await client.request("auth", { protocol: PROTOCOL_VERSION, token });
    const events: BridgeMessage[] = [];
    client.on("event", (event, data) => { if (event === "message") events.push(data as BridgeMessage); });
    const registration = peer(name, frontend);
    registration.cwd = cwd;
    registration.sessionId = sessionId;
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
  expect(await recovered.client.request("ack", { ids: [id] })).toEqual({ acked: 1 });
});

it("quarantines a new unknown destination while preserving proven offline native traffic", async () => {
  let host = await persistentHost("pc-b");
  const native = await host.register(undefined, "known-native", home, "known-native-session"); native.client.close();
  await until(() => !(host.broker as any).localPeers().length); await host.close(); host = await persistentHost("pc-b");
  const sender = await host.register(binding("a", "sender"), "sender"), known = randomUUID(), unknown = randomUUID();
  await sender.client.request("trackedSend", { messageId: known, to: "known-native", body: "verified native offline mail" });
  await sender.client.request("trackedSend", { messageId: unknown, to: "unknown", body: "no recipient evidence" });
  const successor = await host.register(undefined, "unknown", home, "unknown-native-session"),
    original = await host.register(undefined, "known-native", home, "known-native-session");
  expect((await successor.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(unknown);
  expect(await successor.client.request("ack", { ids: [unknown] })).toEqual({ acked: 0 });
  expect((await original.client.request("pending", { limit: 100 })).map(m => m.id)).toContain(known);
  expect(await original.client.request("ack", { ids: [known], nativeOwners: { [known]: host.store.byId(known)!.recipientNative! } })).toEqual({ acked: 1 });
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

it("refuses protocol2 clients before registration, mailbox effects or daemon handover", async () => {
  const host = await persistentHost("pc-b"), handover = vi.fn(); host.broker.onNewerClient(handover);
  const client = await BridgeClient.connect(host.pipe, nullLogger); cleanup.push(() => client.close());
  await expect(client.request("auth", { protocol: 2, token: host.token, canHost: true })).rejects.toThrow(/protocol|upgrade/i);
  await expect(client.request("hello", { protocol: 2, token: host.token, canHost: true, peer: peer("old-reader") })).rejects.toThrow();
  for (const operation of ["pending", "ack", "trackedSend"] as const) {
    await expect((client.request as any)(operation, { ids: ["absent"], messageId: "absent", to: "target", body: "must not store" })).rejects.toThrow();
  }
  expect(host.store.byId("absent")).toBeNull(); expect((host.broker as any).localPeers()).toEqual([]);
  expect(handover).not.toHaveBeenCalled(); expect(PROTOCOL_VERSION).toBe(3);
});

it("new clients refuse a protocol2 endpoint without granting handover or later demand-start", async () => {
  const dir = join(home, "old-endpoint"); mkdirSync(dir); const pipe = resolvePipePath(dir, {}), operations: string[] = [], auth: any[] = [];
  const sockets = new Set<import("node:net").Socket>();
  // Protocol2's exact auth refusal is sufficient; this endpoint implements no mailbox handlers.
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); const decoder = new FrameDecoder(1024 * 1024);
    socket.setEncoding("utf8"); socket.on("data", bytes => { for (const frame of decoder.push(String(bytes))) if (frame.t === "req") {
      operations.push(frame.op); auth.push(frame.args);
      socket.write(encodeFrame({ t: "res", id: frame.id, ok: false, error: { code: "protocol_mismatch", message: "broker speaks protocol 2; coordinated upgrade required", details: { brokerProtocol: 2 } } }));
    } });
  });
  let closed = false; const close = async () => { if (closed) return; closed = true; for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); };
  cleanup.push(close); await new Promise<void>(resolve => server.listen(pipe, resolve));
  const launch = vi.fn(async () => { throw new Error("daemon launch forbidden"); });
  const node = new LiveBridgeNode({ pipePath: pipe, token: "isolated-fixture-token", dbPath: join(dir, "bridge.db"), agent: "codex", name: "new-client", cwd: dir,
    autoWake: false, daemon: { cli: "fixture-never-launch", launch }, log: nullLogger });
  cleanup.push(() => node.stop()); cleanup.push(() => closeMetadataDb(dir));
  await expect(node.start()).rejects.toThrow(/protocol 2/);
  expect(operations).toEqual(["auth"]); expect(auth[0].protocol).toBe(3); expect(auth[0].canHost).toBeUndefined();
  expect(server.listening).toBe(true); await close();
  await expect(node.ensureConnected()).rejects.toThrow(/protocol 2/); expect(launch).not.toHaveBeenCalled();
});

it.each(["wrong-copy", "registration-change"])("fences native ACK replay across %s", async change => {
  const host = await persistentHost("pc-b"), native = await host.register(undefined, "destination"), sender = await host.register(binding("a", "sender"), "sender");
  const id = randomUUID(); await sender.client.request("trackedSend", { messageId: id, to: "destination", body: "native ownership proof" });
  const copy = (await native.client.request("pending", {})).find(m => m.id === id)!;
  if (change === "wrong-copy") {
    expect(await native.client.request("ack", { ids: [id], nativeOwners: { [id]: "another-copy" } })).toEqual({ acked: 0 });
    expect(host.store.receipts(id)[0]!.readAt).toBeNull();
    expect(await native.client.request("ack", { ids: [id], nativeOwners: { [id]: copy.recipientNative! } })).toEqual({ acked: 1 });
    return;
  }
  let release!: () => void, enter!: () => void; const gate = new Promise<void>(resolve => release = resolve), entered = new Promise<void>(resolve => enter = resolve);
  const original = host.store.retryWrite.bind(host.store); let held = false;
  vi.spyOn(host.store, "retryWrite").mockImplementation((async (operation: any, ...rest: any[]) => {
    if (!held) { held = true; enter(); await gate; }
    return (original as any)(operation, ...rest);
  }) as any);
  const ack = native.client.request("ack", { ids: [id], nativeOwners: { [id]: copy.recipientNative! } }).catch(error => error);
  await entered; await native.client.request("updatePeer", { name: "renamed-native" }); release();
  expect(await ack).toBeInstanceOf(Error); expect(host.store.receipts(id).every(r => r.readAt === null)).toBe(true);
  expect(await native.client.request("ack", { ids: [id], nativeOwners: { [id]: copy.recipientNative! } })).toEqual({ acked: 1 });
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

it("retains proven schema10 hosted ownership while quarantining unproven native-era copies", async () => {
  let host = await persistentHost("pc-b"); const frontend = binding("b", "schema10-owner");
  const owner = await host.register(frontend), native = await host.register(undefined, "old-native"), sender = await host.register(binding("a", "sender"), "sender");
  const hostedId = randomUUID(), nativeId = randomUUID();
  await sender.client.request("trackedSend", { messageId: hostedId, to: owner.peer.name, body: "proven hosted ledger" });
  await sender.client.request("trackedSend", { messageId: nativeId, to: native.peer.name, body: "no historical native provenance" });
  await host.close();
  const old = new DatabaseSync(host.db);
  old.exec("ALTER TABLE message_frontends RENAME TO fixture_v11; CREATE TABLE message_frontends(id TEXT NOT NULL,recipient TEXT NOT NULL,binding TEXT NOT NULL,PRIMARY KEY(id,recipient)); INSERT INTO message_frontends SELECT id,recipient,binding FROM fixture_v11 WHERE binding<>''; DROP TABLE fixture_v11; DROP TABLE IF EXISTS recipient_registrations; PRAGMA user_version=10;");
  old.close(); host = await persistentHost("pc-b");
  const nativeSuccessor = await host.register(undefined, "old-native");
  expect((await nativeSuccessor.client.request("pending", { limit: 100 })).map(m => m.id)).not.toContain(nativeId);
  expect(await nativeSuccessor.client.request("ack", { ids: [nativeId] })).toEqual({ acked: 0 });
  const recovered = await host.register(frontend, "recovered-hosted");
  expect((await recovered.client.request("pending", { limit: 100 })).map(m => m.id)).toContain(hostedId);
  expect(await recovered.client.request("ack", { ids: [hostedId] })).toEqual({ acked: 1 });
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
  for (const [snapshot, destination] of [["bridge.messages.db", "bridge.db"], ["archive.messages.db", "archive.db"]]) {
    const db = new DatabaseSync(join(restoredDir, destination!));
    try {
      db.prepare("ATTACH DATABASE ? AS selected_snapshot").run(join(backup.path!, snapshot!));
      const names = db.prepare("SELECT name FROM selected_snapshot.sqlite_master WHERE type='table'").all().map(row => String(row.name));
      for (const name of names) {
        if (!/^[a-z_]+$/.test(name)) throw new Error("unexpected snapshot table");
        db.exec(`INSERT OR IGNORE INTO main.${name} SELECT * FROM selected_snapshot.${name}`);
      }
    } finally { db.close(); }
  }
  expect(restored.byId(initial.id)?.recipientFrontend).toEqual(frontend);
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
  expect(await reconnected.client.request("ack", { ids: [id] })).toEqual({ acked: 1 });
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
  expect(await other.client.request("ack", { ids: [id] })).toEqual({ acked: 1 });
  expect(b.store.receipts(id).find(r => r.recipient === "destination")?.readAt).toBeNull();
});

it("migrates v9 additively without attributing legacy rows and retains ownership through archive/reopen", async () => {
  let b = await persistentHost("pc-b");
  const legacy = message(peer("legacy"), "destination"); b.store.insert(legacy);
  const file = b.db; await b.close();
  const old = new DatabaseSync(file);
  old.exec("DROP TABLE IF EXISTS recipient_registrations; DROP TABLE message_frontends; DROP TABLE send_intents; DROP TABLE send_destinations; PRAGMA user_version=9;");
  const before = old.prepare("SELECT * FROM messages").all(); old.close();
  b = await persistentHost("pc-b");
  const current = new DatabaseSync(file, { readOnly: true });
  try {
    expect(current.prepare("PRAGMA user_version").get()!.user_version).toBe(11);
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
