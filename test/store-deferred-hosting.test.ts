import { METADATA_STORE_VERSION } from "../src/core/metadata-db.js";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { closeMetadataDb } from "../src/core/metadata-db.js";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageStore, SQLITE_STORE_VERSION } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { CONVERSATION_MIGRATION } from "../src/core/conversation-schema.js";
import { recordStorePeer } from "../src/core/store-compatibility.js";
import { APP_VERSION } from "../src/core/constants.js";
import { processIdentity } from "../src/core/process-identity.js";
import * as identities from "../src/core/process-identity.js";
import * as compatibility from "../src/core/store-compatibility.js";
import { ReadJournal } from "../src/core/read-journal.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { markOwned, ownedMessage, unreadOwned } from "./owned-mail.js";

let env: TestEnv;
let runner: ChildProcess | undefined;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => {
  vi.restoreAllMocks();
  if (runner && runner.exitCode === null && runner.signalCode === null) {
    await new Promise<void>(resolve => { runner!.once("exit", () => resolve()); runner!.kill(); });
  }
  runner = undefined;
  await env.cleanup();
});

it("hosts the compatible schema while process identity discovery is still pending", async () => {
  // Compatibility means the current mailbox contract, not the old archive-only
  // schema8 contract. Initialize it before deliberately holding identity scan.
  new MessageStore(env.db, nullLogger).close();
  vi.spyOn(identities, "processIdentity").mockReturnValue(undefined);
  vi.spyOn(compatibility, "refreshStorePeerIdentities").mockImplementation(() => new Promise<void>(() => {}));
  const node = env.node("available-before-scan");
  // The mocked scan never settles, so any completed start proves it did not wait for the scan.
  // The bound only turns a hang into a clear failure; it does not measure start latency.
  await Promise.race([node.start(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("broker waited for process scan")), 20_000))]);
  expect(node.isBroker).toBe(true);
  expect((await node.send({ to: "offline", body: "Serve before schema upgrade" })).messages).toHaveLength(1);
  const check = new DatabaseSync(env.db, { readOnly: true });
  try { expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(SQLITE_STORE_VERSION); } finally { check.close(); }
});

it("keeps read marks while the metadata store is deferred and imports them once it opens", async () => {
  // Without a verifiable own identity the fail-closed metadata migration lease cannot be taken.
  const identity = vi.spyOn(identities, "processIdentity").mockReturnValue(undefined);
  const journal = new ReadJournal(env.home);
  journal.append("name:reader", ["deferred-mark"]);
  expect(journal.read("name:reader")).toEqual(["deferred-mark"]);
  expect(journal.receipt("name:reader", "deferred-mark")).toMatchObject({ read: true });
  identity.mockRestore();
  // Resolve (and cache) the real identity now, so the background retry does not wait on a slow probe.
  expect(identities.processIdentity(process.pid)).toBeTruthy();
  // The journal retries in the background; the mark becomes a metadata row without another call.
  await vi.waitFor(() => {
    const db = new DatabaseSync(env.db, { readOnly: true });
    try { expect(db.prepare("SELECT message_id FROM bridge_read_receipts").all().map(r => r.message_id)).toEqual(["deferred-mark"]); }
    finally { db.close(); }
  }, { timeout: 15_000, interval: 100 });
  expect(new ReadJournal(env.home).read("name:reader")).toEqual(["deferred-mark"]);
});

it("a background metadata retry after the last reader closed imports the marks without keeping bridge.db open", async () => {
  const identity = vi.spyOn(identities, "processIdentity").mockReturnValue(undefined);
  new ReadJournal(env.home).append("name:reader", ["late-retry-mark"]);
  identity.mockRestore();
  expect(identities.processIdentity(process.pid)).toBeTruthy();
  closeMetadataDb(env.home);
  // The first background retry is due after one second; wait until it has imported the mark.
  await vi.waitFor(() => {
    const db = new DatabaseSync(env.db, { readOnly: true });
    try { expect(db.prepare("SELECT message_id FROM bridge_read_receipts").all().map(r => r.message_id)).toEqual(["late-retry-mark"]); }
    finally { db.close(); }
  }, { timeout: 15_000, interval: 100 });
  // No owner is left to close a handle the retry cached; on Windows it would lock the file.
  const moved = `${env.db}.moved-fixture`;
  renameSync(env.db, moved); renameSync(moved, env.db);
});

function seed(version: number): void {
  const db = new DatabaseSync(env.db);
  try {
    db.exec(readFileSync(join(import.meta.dirname, "fixtures/store-v0.29.10.sql"), "utf8"));
    if (version >= 7) db.exec("CREATE TABLE job_delivery_routes(id TEXT PRIMARY KEY,recipient TEXT NOT NULL,consumed_at INTEGER);");
    if (version >= 8) db.exec(CONVERSATION_MIGRATION);
    db.exec(`PRAGMA user_version=${version};
      INSERT INTO peer_name_owners VALUES('offline-peer','unidentified:offline-peer');
      INSERT INTO peer_names VALUES('retained-identity','offline-peer',NULL,'claude',1);
      INSERT INTO messages VALUES('retained-mail','offline-peer','old-sender','old-sender','codex','offline-peer','retained-conversation',NULL,0,'keep this message',${Date.now()},NULL);
      CREATE TABLE owner_data(body); INSERT INTO owner_data VALUES('keep unknown data');`);
  } finally { db.close(); }
  writeFileSync(join(env.home, "config.json"), JSON.stringify({ version: 4, history: { ingest: false } }));
}

it("retains the earliest released 0.29 schema for inspection without granting supplemental mailbox authority", () => {
  copyFileSync(join(import.meta.dirname, "fixtures/sqlite-upgrade/v0.29.0/bridge.db"), env.db);
  recordStorePeer(env.home, { pid: process.pid, name: "early-retained-runner", version: "0.29.0" });
  let store = new MessageStore(env.db, nullLogger);
  const peer = { id: "fixture-peer", name: "fixture-session", agent: "codex", cwd: env.home, sessionId: "fixture-thread", pid: process.pid, startedAt: Date.now() } as PeerInfo;
  const message = { id: "compat-mail", recipient: peer.name, from: { id: "fixture-sender", name: "fixture-sender", agent: "claude" as const }, to: peer.name, conversationId: "compat-fixture", replyTo: null, hop: 0, body: "retained supplemental route", createdAt: Date.now(), readAt: null };
  let retained: unknown[];
  try {
    const original = new DatabaseSync(env.db, { readOnly: true });
    try {
      retained = original.prepare("SELECT * FROM messages ORDER BY id,recipient").all();
      const schema = original.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
      const sql = vi.spyOn(DatabaseSync.prototype, "prepare");
      try { expect(() => store.insert(message)).toThrow(/ownership storage upgrade is required/); expect(sql).not.toHaveBeenCalled(); }
      finally { sql.mockRestore(); }
      expect(original.prepare("SELECT * FROM messages ORDER BY id,recipient").all()).toEqual(retained);
      expect(original.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
      expect(original.prepare("PRAGMA user_version").get()!.user_version).toBe(4);
      expect(store.byId(message.id)).toBeNull(); expect(store.unread(peer.name, 10)).toEqual([]);
    } finally { original.close(); }
  } finally { store.close(); }
  // Inspection can coexist with the retained reader, but fresh mailbox effects
  // require its explicit current capability and an exclusive migration reopen.
  store = new MessageStore(env.db, nullLogger);
  try {
    expect(store.byId(message.id)).toBeNull(); expect(() => store.insert(message)).toThrow(/ownership storage upgrade/);
  } finally { store.close(); }
  recordStorePeer(env.home, { pid: process.pid, name: "exclusive-current-reader", version: APP_VERSION, storeCapabilities: { json: 4, sqlite: SQLITE_STORE_VERSION, metadata: METADATA_STORE_VERSION } });
  store = new MessageStore(env.db, nullLogger);
  try {
    expect(store.frontendOwnership).toBe(true);
    const current = new DatabaseSync(env.db, { readOnly: true });
    try { expect(current.prepare("PRAGMA user_version").get()!.user_version).toBe(SQLITE_STORE_VERSION); expect(current.prepare("SELECT * FROM messages ORDER BY id,recipient").all()).toEqual(retained!); }
    finally { current.close(); }
    store.rememberName(peer, Date.now()); store.insert(ownedMessage(store, peer, message));
    expect(unreadOwned(store, peer).map(m => m.id)).toEqual([message.id]); expect(markOwned(store, peer, [message.id], 123)).toBe(1);
    expect(store.broadcastRecipients(Date.now(), new Set()).queued).toContain(peer.name);
    expect(store.byId(message.id)?.body).toBe(message.body);
  } finally { store.close(); }
});

it.each([6, 7, 8])("hosts schema %i without an upgrade, persists supplemental metadata, then upgrades backup-first", version => {
  seed(version);
  recordStorePeer(env.home, { pid: process.pid, name: "retained-job-runner", version: version === 8 ? "0.29.17" : "0.29.14" });
  let store = new MessageStore(env.db, nullLogger);
  try {
    expect(store.byId("retained-mail")?.body).toBe("keep this message");
    store.markPeerSeen("offline-peer", Date.now());
    expect(store.broadcastNames()).toContain("offline-peer");
    expect(store.broadcastRecipients(Date.now(), new Set()).queued).toContain("offline-peer");
    const primary = new DatabaseSync(env.db, { readOnly: true });
    try {
      expect(primary.prepare("PRAGMA user_version").get()!.user_version).toBe(version);
      expect(primary.prepare("SELECT name FROM sqlite_master WHERE name='peer_last_seen'").get()).toBeUndefined();
      expect(primary.prepare("SELECT body FROM owner_data").get()!.body).toBe("keep unknown data");
    } finally { primary.close(); }
    expect(existsSync(join(env.home, ".migration-snapshots"))).toBe(false);
  } finally { store.close(); }
  store = new MessageStore(env.db, nullLogger);
  try { expect(store.broadcastRecipients(Date.now(), new Set()).queued).toContain("offline-peer"); } finally { store.close(); }
  recordStorePeer(env.home, { pid: process.pid, name: "reloaded-session", version: APP_VERSION, storeCapabilities: { json: 4, sqlite: SQLITE_STORE_VERSION, metadata: METADATA_STORE_VERSION } });
  store = new MessageStore(env.db, nullLogger);
  try {
    expect(store.broadcastNames()).toContain("offline-peer");
    expect(store.broadcastRecipients(Date.now(), new Set()).queued).toContain("offline-peer");
    expect(store.byId("retained-mail")?.body).toBe("keep this message");
    const primary = new DatabaseSync(env.db, { readOnly: true });
    try {
      expect(primary.prepare("PRAGMA user_version").get()!.user_version).toBe(SQLITE_STORE_VERSION);
      expect(primary.prepare("SELECT name FROM peer_last_seen WHERE name='offline-peer'").get()!.name).toBe("offline-peer");
    } finally { primary.close(); }
    expect(existsSync(join(env.home, ".migration-snapshots"))).toBe(true);
    expect(existsSync(join(env.home, "store-compatibility.db"))).toBe(true);
  } finally { store.close(); }
});

it("refuses mailbox startup while a retained older non-hosting reader blocks provenance migration", async () => {
  seed(8);
  // CI-only retained-reader process. Model the shipped lease-aware storage
  // primitive directly; a current BridgeNode cannot masquerade as a protocol2
  // job runner, nor can this old schema assume bridge_metadata already exists.
  const script = `import { DatabaseSync } from 'node:sqlite';
    import { mkdirSync,writeFileSync,rmSync } from 'node:fs'; import { randomUUID } from 'node:crypto';
    const dir=${JSON.stringify(join(env.home, ".storage-users"))}; mkdirSync(dir,{recursive:true});
    const lease=dir+'/'+process.pid+'-'+randomUUID(); writeFileSync(lease,'',{flag:'wx'});
    const db=new DatabaseSync(${JSON.stringify(env.db)}); db.prepare('SELECT * FROM messages').all();
    console.log('ready pid='+process.pid);
    setTimeout(()=>{db.close();rmSync(lease);process.exit(0)},25000);`;
  runner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  runner.stdout!.on("data", chunk => { output += chunk; });
  runner.stderr!.on("data", chunk => { output += chunk; });
  await until(() => output.includes("ready"));
  const pid = runner.pid!;
  const identity = processIdentity(pid);
  expect(identity).toBeDefined();
  expect(output).toContain(`ready pid=${pid}`);
  const first = env.node("reloaded-first", "claude");
  const second = env.node("reloaded-second", "codex");
  // An empty historical lease proves neither compatibility nor a completed old
  // declaration. The bounded census expires; it must not expose timers/promises'
  // ABORT_ERR as if this were caller cancellation, or admit migration.
  await expect(first.start()).rejects.toMatchObject({ code: "timeout" }); await first.stop();
  await expect(second.start()).rejects.toMatchObject({ code: "timeout" });
  expect(output).not.toContain("connected");
  await first.stop(); await second.stop();
  const replacement = env.node("reloaded-again", "claude");
  await expect(replacement.start()).rejects.toMatchObject({ code: "timeout" });
  expect(replacement.isBroker).toBe(false);
  expect(runner.exitCode, output).toBeNull();
  const check = new DatabaseSync(env.db, { readOnly: true });
  try {
    expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(8);
    expect(check.prepare("SELECT body FROM messages WHERE id='retained-mail'").get()!.body).toBe("keep this message");
    expect(check.prepare("SELECT body FROM owner_data").get()!.body).toBe("keep unknown data");
    expect(check.prepare("SELECT read_at FROM messages WHERE id='retained-mail'").get()!.read_at).toBeNull();
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name='message_frontends'").get()).toBeUndefined();
  } finally { check.close(); }
  expect(existsSync(join(env.home, ".migration-snapshots"))).toBe(false);
}, 30_000);
