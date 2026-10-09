import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageStore, SQLITE_STORE_VERSION } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { CONVERSATION_MIGRATION } from "../src/core/conversation-schema.js";
import { recordStorePeer } from "../src/core/store-compatibility.js";
import { APP_VERSION } from "../src/core/constants.js";
import { processIdentity } from "../src/core/process-identity.js";
import * as identities from "../src/core/process-identity.js";
import * as compatibility from "../src/core/store-compatibility.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { ReadJournal } from "../src/core/read-journal.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import type { PeerInfo } from "../src/core/protocol.js";

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
  seed(8);
  vi.spyOn(identities, "processIdentity").mockReturnValue(undefined);
  vi.spyOn(compatibility, "refreshStorePeerIdentities").mockImplementation(() => new Promise<void>(() => {}));
  const node = env.node("available-before-scan");
  // The mocked scan never settles, so any completed start proves it did not wait for the scan.
  // The bound only turns a hang into a clear failure; it does not measure start latency.
  await Promise.race([node.start(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("broker waited for process scan")), 20_000))]);
  expect(node.isBroker).toBe(true);
  expect((await node.send({ to: "offline", body: "Serve before schema upgrade" })).messages).toHaveLength(1);
  const check = new DatabaseSync(env.db, { readOnly: true });
  try { expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(8); } finally { check.close(); }
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

it("hosts the earliest released 0.29 schema using durable supplemental routing tables", () => {
  copyFileSync(join(import.meta.dirname, "fixtures/sqlite-upgrade/v0.29.0/bridge.db"), env.db);
  recordStorePeer(env.home, { pid: process.pid, name: "early-retained-runner", version: "0.29.0" });
  let store = new MessageStore(env.db, nullLogger);
  try {
    const peer = { id: "fixture-peer", name: "fixture-session", agent: "codex", cwd: env.home, sessionId: "fixture-thread", pid: process.pid, startedAt: Date.now() } as PeerInfo;
    store.rememberName(peer, Date.now());
    expect(store.broadcastRecipients(Date.now(), new Set()).queued).toContain("fixture-session");
    store.insert({ id: "compat-mail", recipient: "fixture-session", from: { id: "fixture-sender", name: "fixture-sender", agent: "claude" }, to: "fixture-session", conversationId: "compat-fixture", replyTo: null, hop: 0, body: "retained supplemental route", createdAt: Date.now(), readAt: null });
    expect(store.unread("fixture-session", 10)[0]?.body).toBe("retained supplemental route");
    const original = new DatabaseSync(env.db, { readOnly: true });
    try { expect(original.prepare("PRAGMA user_version").get()!.user_version).toBe(4); } finally { original.close(); }
  } finally { store.close(); }
  store = new MessageStore(env.db, nullLogger);
  try {
    expect(store.broadcastRecipients(Date.now(), new Set()).queued).toContain("fixture-session");
    expect(store.byId("compat-mail")?.body).toBe("retained supplemental route");
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
  recordStorePeer(env.home, { pid: process.pid, name: "reloaded-session", version: APP_VERSION, storeCapabilities: { json: 4, sqlite: SQLITE_STORE_VERSION } });
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

it("elects a broker after every session reloads while only a legacy non-hosting job runner remains", async () => {
  seed(8);
  const bundle = join(env.home, "legacy-runner-fixture.mjs");
  await build({ entryPoints: [join(import.meta.dirname, "../src/core/node.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const token = loadOrCreateToken(env.home);
  const script = `import { BridgeNode } from ${JSON.stringify(pathToFileURL(bundle).href)};
    import { DatabaseSync } from 'node:sqlite';
    const log={child(){return this},info(){},warn(){},error(){},debug(){}};
    const node=new BridgeNode({pipePath:${JSON.stringify(env.pipe)},dbPath:${JSON.stringify(env.db)},token:${JSON.stringify(token)},agent:'other',name:'codex-job-retained',id:'job:retained',jobAgent:'codex',cwd:${JSON.stringify(env.home)},autoWake:false,canHostBroker:false,log});
    const hello=node.helloArgs.bind(node);node.helloArgs=()=>{const args=hello();args.peer.version='0.29.17';args.peer.storeCapabilities={json:4,sqlite:8};return args};
    const adopted=node.afterHello.bind(node);node.afterHello=(...args)=>{adopted(...args);const db=new DatabaseSync(${JSON.stringify(env.db)},{timeout:5000});try{const key=String(process.pid),row=db.prepare("SELECT value FROM bridge_metadata WHERE domain='storage-capabilities' AND key=?").get(key);db.prepare("UPDATE bridge_metadata SET value=? WHERE domain='storage-capabilities' AND key=?").run(JSON.stringify({...JSON.parse(row.value),version:'0.29.17',json:4,sqlite:8}),key)}finally{db.close()}};
    setInterval(()=>{},1000); console.log('ready'); node.start().then(()=>console.log('connected')).catch(e=>{console.error(e);process.exit(1)});`;
  runner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  runner.stdout!.on("data", chunk => { output += chunk; });
  runner.stderr!.on("data", chunk => { output += chunk; });
  await until(() => output.includes("ready"));
  const pid = runner.pid!;
  const identity = processIdentity(pid);
  expect(identity).toBeDefined();
  // AB-208: capability records are bridge.db metadata rows keyed by PID.
  const capabilities = new DatabaseSync(env.db, { timeout: 5_000 });
  try {
    capabilities.prepare(`INSERT INTO bridge_metadata VALUES ('storage-capabilities',?,?,?) ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value`)
      .run(String(pid), JSON.stringify({ schemaVersion: 1, pid, name: "codex-job-retained", version: "0.29.17", explicit: true, json: 4, sqlite: 8, processIdentity: identity }), Date.now());
  } finally { capabilities.close(); }
  const first = env.node("reloaded-first", "claude");
  const second = env.node("reloaded-second", "codex");
  await Promise.all([first.start(), second.start()]);
  expect(first.isBroker || second.isBroker).toBe(true);
  await until(() => output.includes("connected"));
  await first.stop(); await second.stop();
  const replacement = env.node("reloaded-again", "claude");
  await replacement.start();
  expect(replacement.isBroker).toBe(true);
  expect(runner.exitCode, output).toBeNull();
  const check = new DatabaseSync(env.db, { readOnly: true });
  try {
    expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(8);
    expect(check.prepare("SELECT body FROM messages WHERE id='retained-mail'").get()!.body).toBe("keep this message");
    expect(check.prepare("SELECT body FROM owner_data").get()!.body).toBe("keep unknown data");
  } finally { check.close(); }
}, 30_000);
