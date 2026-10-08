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
  await Promise.race([node.start(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("broker waited for process scan")), 1_000))]);
  expect(node.isBroker).toBe(true);
  expect((await node.send({ to: "offline", body: "Serve before schema upgrade" })).messages).toHaveLength(1);
  const check = new DatabaseSync(env.db, { readOnly: true });
  try { expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(8); } finally { check.close(); }
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
    import { readFileSync, writeFileSync } from 'node:fs';
    const log={child(){return this},info(){},warn(){},error(){},debug(){}};
    const node=new BridgeNode({pipePath:${JSON.stringify(env.pipe)},dbPath:${JSON.stringify(env.db)},token:${JSON.stringify(token)},agent:'other',name:'codex-job-retained',id:'job:retained',jobAgent:'codex',cwd:${JSON.stringify(env.home)},autoWake:false,canHostBroker:false,log});
    const hello=node.helloArgs.bind(node);node.helloArgs=()=>{const args=hello();args.peer.version='0.29.17';args.peer.storeCapabilities={json:4,sqlite:8};return args};
    const adopted=node.afterHello.bind(node);node.afterHello=(...args)=>{adopted(...args);const path=${JSON.stringify(join(env.home, "storage-capabilities"))}+'/'+process.pid+'.json';const record=JSON.parse(readFileSync(path,'utf8'));writeFileSync(path,JSON.stringify({...record,version:'0.29.17',json:4,sqlite:8}))};
    setInterval(()=>{},1000); console.log('ready'); node.start().then(()=>console.log('connected')).catch(e=>{console.error(e);process.exit(1)});`;
  runner = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  runner.stdout!.on("data", chunk => { output += chunk; });
  runner.stderr!.on("data", chunk => { output += chunk; });
  await until(() => output.includes("ready"));
  const pid = runner.pid!;
  const identity = processIdentity(pid);
  expect(identity).toBeDefined();
  writeFileSync(join(env.home, "storage-capabilities", `${pid}.json`), JSON.stringify({ schemaVersion: 1, pid, name: "codex-job-retained", version: "0.29.17", explicit: true, json: 4, sqlite: 8, processIdentity: identity }));
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
