import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openMessageStore, type MessageStore } from "../src/core/store.js";
import { closeMetadataDbs, metadataDb } from "../src/core/metadata-db.js";
import { nullLogger } from "../src/core/logger.js";
import * as migrations from "../src/core/sqlite-migrations.js";
import { inspectBootstrapJournal, readBootstrapEvidence } from "../src/core/store-bootstrap-journal.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const wire = vi.hoisted(() => ({ starts: 0, before: undefined as undefined | (() => Promise<void>),
  after: undefined as undefined | (() => Promise<void>), wrong: false, workers: [] as any[], stage: "idle", kernelThread: 0, error: undefined as unknown, exitedBeforeMessage: false, wrongThread: false,
  beforeMaintenance: undefined as undefined | (() => void) }));
const directoryIo = vi.hoisted(() => ({ next: 2_000_000_000, handles: new Map<number, string>(), files: new Map<number, string>(), failure: "", syncs: [] as string[], onSync: undefined as undefined | (() => void), mutateRead: undefined as undefined | ((path: string) => void), onCopy: undefined as undefined | ((source: string, target: string) => void) }));
// Explicit simulated directory-durability capability, never evidence that a
// Windows filesystem supports directory fsync. Ordinary file IO stays real.
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, constants: { ...actual.constants, O_DIRECTORY: actual.constants.O_DIRECTORY || 0x10000 },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const path = String(args[0]);
      if (actual.existsSync(path) && actual.lstatSync(path).isDirectory()) { const fd = directoryIo.next++; directoryIo.handles.set(fd, path); return fd; }
      const fd = actual.openSync(...args); directoryIo.files.set(fd, path); return fd;
    },
    fstatSync: (fd: number, options?: any) => directoryIo.handles.has(fd) ? actual.lstatSync(directoryIo.handles.get(fd)!, options) : actual.fstatSync(fd, options),
    fsyncSync: (fd: number) => { const path = directoryIo.handles.get(fd); if (!path) return actual.fsyncSync(fd);
      directoryIo.syncs.push(path); directoryIo.onSync?.(); if (directoryIo.failure && (directoryIo.failure === "all" || path.endsWith(".store-bootstrap"))) throw Object.assign(new Error("Controlled directory publication unavailable"), { code: "ENOTSUP" }); },
    closeSync: (fd: number) => { if (directoryIo.handles.delete(fd)) return; directoryIo.files.delete(fd); return actual.closeSync(fd); },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      const count = actual.readSync(fd, buffer, offset, length, position), path = directoryIo.files.get(fd);
      if (path) directoryIo.mutateRead?.(path); return count;
    },
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => { actual.copyFileSync(...args); directoryIo.onCopy?.(String(args[0]), String(args[1])); },
  };
});
vi.mock("node:worker_threads", async original => {
  const actual = await original<typeof import("node:worker_threads")>(), { EventEmitter } = await import("node:events");
  return { ...actual, get threadId() { return wire.kernelThread; }, Worker: class extends EventEmitter {
    threadId = 100 + wire.starts++; terminated = false; finished = false; running = false; exit!: () => void; exited = new Promise<number>(resolve => { this.exit = () => resolve(this.terminated ? 1 : 0); });
    constructor(entry: URL, options: any) {
      super(); wire.workers.push(this);
      wire.stage = "transport-created";
      if (!String(entry).endsWith("/store-bootstrap-worker.mjs")) throw new Error("Unexpected native worker request; no fallback permitted");
      queueMicrotask(() => { if (wire.error) { this.emit("error", wire.error); this.finish(1); } else void this.run(options.workerData.plan); });
    }
    finish(code: number) { if (this.finished) return; this.finished = true; this.threadId = -1; this.exit(); this.emit("exit", code); }
    async run(plan: any) {
      try {
        await wire.before?.(); if (this.terminated) return;
        this.running = true;
        wire.stage = "importing-kernel";
        const { runColdStoreBootstrap } = await import("../src/core/store-bootstrap-worker.js");
        wire.stage = "running-kernel";
        wire.kernelThread = this.threadId + (wire.wrongThread ? 1 : 0);
        await runColdStoreBootstrap(plan); this.running = false;
        wire.stage = "kernel-returned";
        if (this.terminated) { this.finish(1); return; }
        if (wire.exitedBeforeMessage) this.threadId = -1;
        this.emit("message", { attempt: wire.wrong ? "foreign-attempt" : plan.record.attempt, state: "prepared" });
        await wire.after?.(); this.finish(this.terminated ? 1 : 0);
      } catch (error) {
        const failure = error as { code?: unknown; stack?: unknown };
        console.error("Mock cold-bootstrap failure", { code: typeof failure?.code === "string" && /^[A-Z_]{1,40}$/.test(failure.code) ? failure.code : "unclassified",
          source: typeof failure?.stack === "string" ? [...failure.stack.matchAll(/src[\\/]core[\\/]([a-z-]+\.ts:\d+:\d+)/g)].slice(0, 4).map(match => match[1]) : [] });
        const { bootstrapKernelFailure } = await import("../src/core/store-bootstrap-journal.js");
        const safe = bootstrapKernelFailure(error, "reader-admission") as any;
        this.running = false; this.emit("message", { attempt: plan.record.attempt, state: "failed", bootstrapStage: safe.bootstrapStage, bootstrapFailure: safe.bootstrapFailure }); this.finish(1);
      }
    }
    terminate() { this.terminated = true; if (!this.running) this.finish(1); return this.exited; }
  } };
});
vi.mock("../src/core/storage-lock.js", async original => {
  const actual = await original<typeof import("../src/core/storage-lock.js")>();
  return { ...actual, maintenanceLock: (...args: Parameters<typeof actual.maintenanceLock>) => {
    const before = wire.beforeMaintenance; wire.beforeMaintenance = undefined; before?.();
    return actual.maintenanceLock(...args);
  } };
});
vi.mock("node:net", async original => {
  const actual = await original<typeof import("node:net")>(), { EventEmitter } = await import("node:events");
  return { ...actual, connect: () => {
    const socket = Object.assign(new EventEmitter(), { destroyed: false, setEncoding() { return this; },
      destroy(this: EventEmitter & { destroyed: boolean }) { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; }, end() { return this; },
      write() { throw new Error("No authenticated current peer in isolated bootstrap fixture"); } });
    queueMicrotask(() => socket.emit("error", Object.assign(new Error("Fixture endpoint absent"), { code: "ENOENT" })));
    return socket;
  } };
});
let env: TestEnv, opened: MessageStore | undefined, clock: number, start: number, schemaMs: number, ddl: number;
let pendingDiagnostic: ReturnType<typeof setTimeout>, fixtureNumber = 0;
const deferred = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; };
beforeEach(() => {
  directoryIo.failure = ""; directoryIo.syncs = []; directoryIo.onSync = undefined; directoryIo.mutateRead = undefined; directoryIo.onCopy = undefined;
  const number = ++fixtureNumber; wire.stage = "setup"; wire.beforeMaintenance = undefined;
  pendingDiagnostic = setTimeout(() => console.error("Mock cold-bootstrap pending", { fixture: number, stage: wire.stage }), 1000);
  env = makeEnv(); schemaMs = 2400; ddl = 0; wire.starts = 0; wire.workers = []; wire.before = undefined; wire.after = undefined; wire.wrong = false; wire.error = undefined; wire.exitedBeforeMessage = false; wire.wrongThread = false;
  start = clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock); vi.spyOn(performance, "now").mockImplementation(() => clock - start);
  const migrate = migrations.migrateSqlite;
  vi.spyOn(migrations, "migrateSqlite").mockImplementation((...args) => {
    const version = Number(args[0].prepare("PRAGMA user_version").get()!.user_version);
    migrate(...args);
    if (args[1] === env.db && version < 14) { ddl++; clock += schemaMs; }
  });
});
afterEach(async () => {
  clearTimeout(pendingDiagnostic);
  opened?.close(); opened = undefined; closeMetadataDbs(); vi.useRealTimers(); vi.restoreAllMocks(); await env.cleanup();
  expect(wire.workers.every(worker => worker.threadId === -1)).toBe(true);
  expect(directoryIo.handles.size).toBe(0);
});
const open = (signal?: AbortSignal) => openMessageStore(env.db, nullLogger, "fixture-current", "fixture-only-token", signal, start + 10000);
const stageOrFailure = (stage: Promise<void>, pending: Promise<unknown>) => Promise.race([stage, pending.then(error => { throw error instanceof Error ? error : new Error("Original operation settled before the required stage"); })]);

it.each(["all", "record-directory"])("refuses unsupported directory publication before schema effects: %s", async failure => {
  schemaMs = 0; directoryIo.failure = failure;
  const error = await open().then(store => { opened = store; return undefined; }, error => error);
  expect(error).toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  expect(ddl).toBe(0); expect(existsSync(env.db)).toBe(false);
});

it("does not publish a journal or schema after the supported home flush exhausts the original deadline", async () => {
  schemaMs = 0; directoryIo.onSync = () => { clock = start + 10001; };
  await expect(open()).rejects.toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  expect(ddl).toBe(0); expect(existsSync(env.db)).toBe(false); expect(existsSync(join(env.home, ".store-bootstrap"))).toBe(false);
});

it("retains an uncertain published preparing record and never reexecutes after directory flush failure", async () => {
  schemaMs = 0; const dir = join(env.home, ".store-bootstrap");
  directoryIo.onSync = () => { if (existsSync(dir) && readdirSync(dir).some(name => name.endsWith(".preparing.json"))) throw new Error("Controlled post-file directory flush failure"); };
  await expect(open()).rejects.toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  expect(ddl).toBe(0); const name = readdirSync(dir).find(name => name.endsWith(".preparing.json"))!, original = readFileSync(join(dir, name));
  directoryIo.onSync = undefined;
  await expect(open()).rejects.toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  expect(wire.starts).toBe(1); expect(ddl).toBe(0); expect(readFileSync(join(dir, name))).toEqual(original);
});

it("fences every opener including no-deadline and cached metadata before admitting an unsettled preparation", async () => {
  schemaMs = 0; const db = metadataDb(env.home); db.exec("CREATE TABLE accepted_original(body BLOB); INSERT INTO accepted_original VALUES(x'00ff')");
  const dir = join(env.home, ".store-bootstrap"); mkdirSync(dir); writeFileSync(join(dir, "retained-malformed.json"), "original incomplete evidence");
  const bytes = readFileSync(env.db);
  const error = await openMessageStore(env.db, nullLogger, "fixture-current", "fixture-token").then(store => { opened = store; return undefined; }, error => error);
  expect(error).toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  expect(() => metadataDb(env.home)).toThrow(/preparation/i);
  const { MessageStore } = await import("../src/core/store.js"); expect(() => new MessageStore(env.db, nullLogger)).toThrow(/preparation/i);
  expect(readFileSync(env.db)).toEqual(bytes); expect(readFileSync(join(dir, "retained-malformed.json"), "utf8")).toBe("original incomplete evidence");
});

it.each(["preparing-missing", "prepared-replaced", "prepared-in-place"])("revalidates retained original records after worker exit: %s", async mutation => {
  schemaMs = 0; const seen = deferred(), gate = deferred(); wire.after = async () => { seen.release(); await gate.promise; };
  const pending = open().then(store => { opened = store; return undefined; }, error => error);
  await stageOrFailure(seen.promise, pending);
  const dir = join(env.home, ".store-bootstrap"), preparing = readdirSync(dir).find(name => name.endsWith(".preparing.json"))!, prepared = readdirSync(dir).find(name => name.endsWith(".prepared.json"))!;
  const target = join(dir, mutation === "preparing-missing" ? preparing : prepared), original = readFileSync(target);
  if (mutation !== "prepared-in-place") { renameSync(target, target + ".retained-original"); if (mutation === "prepared-replaced") writeFileSync(target, original); }
  else { const row = JSON.parse(original.toString()); row.namespace = "a".repeat(64); writeFileSync(target, JSON.stringify(row)); }
  gate.release(); const error = await pending;
  expect(error).toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" }); expect(opened).toBeUndefined();
  expect(readdirSync(dir).some(name => name.endsWith(".exited.json"))).toBe(false); expect(ddl).toBe(1);
});

it("rejects an in-place journal mutation during its descriptor read and retains the original bytes separately", async () => {
  schemaMs = 0; opened = await open(); opened.close(); opened = undefined; closeMetadataDbs();
  const dir = join(env.home, ".store-bootstrap"), path = join(dir, readdirSync(dir).find(name => name.endsWith(".prepared.json"))!);
  const original = readFileSync(path); writeFileSync(join(env.home, "retained-original-proof"), original);
  directoryIo.mutateRead = changed => { if (changed !== path) return; directoryIo.mutateRead = undefined; writeFileSync(path, Buffer.concat([original, Buffer.from(" ")])); };
  expect(() => readBootstrapEvidence(path)).toThrow(/preparation/i);
  expect(readFileSync(join(env.home, "retained-original-proof"))).toEqual(original);
});

it("checks complete evidence again at final construction rather than trusting exit publication", async () => {
  schemaMs = 0;
  const policy = await import("../src/core/sqlite-policy.js"), configure = policy.configureSqlite; let changed = false;
  vi.spyOn(policy, "configureSqlite").mockImplementation((...args) => {
    configure(...args);
    if (!changed && wire.workers.length && wire.workers[0].threadId === -1) {
      changed = true; const dir = join(env.home, ".store-bootstrap"), path = join(dir, readdirSync(dir).find(name => name.endsWith(".preparing.json"))!);
      renameSync(path, join(env.home, "retained-preparing-proof"));
    }
  });
  await expect(open()).rejects.toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  expect(changed).toBe(true); expect(opened).toBeUndefined(); expect(existsSync(join(env.home, "retained-preparing-proof"))).toBe(true); expect(ddl).toBe(1);
});

it("refuses a parent-directory publication failure before journal or schema effects", async () => {
  schemaMs = 0; directoryIo.onSync = () => { if (directoryIo.syncs.at(-1) === dirname(env.home)) throw new Error("Controlled parent publication failure"); };
  const failure = await open().then(value => { opened = value; return undefined; }, error => error);
  expect(failure).toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  expect(ddl).toBe(0); expect(existsSync(env.db)).toBe(false); expect(existsSync(join(env.home, ".store-bootstrap"))).toBe(false);
});

it("preserves the exact cold anchor, journal, namespace and generation in a full backup but refuses full restore before any maintenance effect", async () => {
  schemaMs = 0; opened = await open();
  const namespace = opened.namespace, { createBackup, readBackup, restoreBackup } = await import("../src/core/backups.js");
  const backup = createBackup(env.home, clock, false), manifest = readBackup(backup);
  expect(manifest.bootstrap?.namespace).toBe(namespace); expect(manifest.bootstrap?.metadata.value?.kind).toBe("cold");
  const proofPaths = [".store-bootstrap.expected.json", ...readdirSync(join(env.home, ".store-bootstrap")).map(name => `.store-bootstrap/${name}`)];
  for (const path of proofPaths) expect(readFileSync(join(backup, path))).toEqual(readFileSync(join(env.home, path)));
  const originals = ["bridge.db", "archive.db", "history.db", ...proofPaths].map(path => ({ path, ino: lstatSync(join(env.home, path), { bigint: true }).ino, bytes: readFileSync(join(env.home, path)) }));
  const rootNames = readdirSync(env.home), backupNames = readdirSync(join(env.home, "backups"));
  expect(() => restoreBackup(env.home, backup, true)).toThrow(/owner-coordinated isolated offline restore-generation/i);
  expect(readdirSync(env.home)).toEqual(rootNames); expect(readdirSync(join(env.home, "backups"))).toEqual(backupNames);
  for (const original of originals) { expect(lstatSync(join(env.home, original.path), { bigint: true }).ino).toBe(original.ino); expect(readFileSync(join(env.home, original.path))).toEqual(original.bytes); }
  expect(opened.namespace).toBe(namespace);
});

it("does not publish or certify a backup whose copied journal proof is incomplete, and retains every original byte", async () => {
  schemaMs = 0; opened = await open(); const { createBackup, listBackups } = await import("../src/core/backups.js");
  const dir = join(env.home, ".store-bootstrap"), name = readdirSync(dir).find(name => name.endsWith(".prepared.json"))!, original = readFileSync(join(dir, name));
  directoryIo.onCopy = (source, target) => { if (source === join(dir, name)) writeFileSync(target, "{incomplete copied evidence"); };
  expect(() => createBackup(env.home, clock, false)).toThrow(/preparation/i);
  expect(listBackups(env.home)).toEqual([]); expect(readdirSync(join(env.home, "backups")).some(name => name.startsWith(".pending-"))).toBe(true);
  expect(readFileSync(join(dir, name))).toEqual(original); inspectBootstrapJournal(env.home);
});

it.each(["sync", "background"])("backs up an ordinary alternate mailbox before a concurrent move into its shared archive: %s", async mode => {
  schemaMs = 0; const { MessageStore } = await import("../src/core/store.js"), snapshots = await import("../src/core/sqlite-maintenance.js");
  opened = new MessageStore(join(env.home, "mail.db"), nullLogger);
  opened.insert({ id: "accepted-alternate", recipient: "retained-owner", from: { id: "sender", name: "sender", agent: "codex" }, to: "retained-owner", conversationId: "retained", replyTo: null, hop: 0, body: "original alternate bytes", createdAt: 1, readAt: null });
  const snapshot = snapshots.snapshotDatabase; let archived = false;
  vi.spyOn(snapshots, "snapshotDatabase").mockImplementation((source, target) => {
    snapshot(source, target);
    if (source === join(env.home, "archive.db")) { opened!.purgeOlderThan(2); archived = true; }
  });
  const sqlite = await import("node:sqlite"), incremental = sqlite.backup;
  vi.spyOn(sqlite, "backup").mockImplementation(async (...args) => {
    const result = await incremental(...args);
    if (String(args[1]).endsWith("archive.db")) { opened!.purgeOlderThan(2); archived = true; }
    return result;
  });
  const { createBackup, readBackup, backupIfDueBackground } = await import("../src/core/backups.js");
  const backup = mode === "sync" ? createBackup(env.home, clock, false) : (await backupIfDueBackground(env.home, { checkpoint() {} }, clock))!;
  expect(archived).toBe(true); expect(readBackup(backup).files.map(file => file.path)).toContain("mail.db");
  const bodies: unknown[] = [];
  for (const name of ["mail.db", "archive.db"]) {
    const file = join(backup, name); if (!existsSync(file)) continue;
    const copy = new DatabaseSync(file, { readOnly: true });
    try { bodies.push(...copy.prepare("SELECT body FROM messages WHERE id='accepted-alternate'").all().map(row => row.body)); } finally { copy.close(); }
  }
  expect(bodies).toContain("original alternate bytes");
});

it("rechecks restore authority under the real maintenance lock before closing or displacing a newly bound store", async () => {
  const source = makeEnv();
  try {
    for (const home of [source.home, env.home]) {
      const raw = new DatabaseSync(join(home, "bridge.db")); raw.exec("CREATE TABLE originals(body BLOB); INSERT INTO originals VALUES(x'00ff01')"); raw.close();
    }
    const { createBackup, restoreBackup } = await import("../src/core/backups.js"), backup = createBackup(source.home, clock, false);
    let accepted: Buffer | undefined, current: DatabaseSync | undefined;
    wire.beforeMaintenance = () => {
      current = metadataDb(env.home); current.exec("INSERT INTO originals VALUES(x'11ff22')"); accepted = readFileSync(env.db);
    };
    expect(() => restoreBackup(env.home, backup, true)).toThrow(/restore-generation|authority changed/i);
    expect(current?.isOpen).toBe(true); expect(readFileSync(env.db)).toEqual(accepted);
    expect(current!.prepare("SELECT hex(body) AS body FROM originals").all()).toEqual([{ body: "00FF01" }, { body: "11FF22" }]);
    expect(existsSync(join(env.home, "backups"))).toBe(false);
  } finally { await source.cleanup(); }
});

it.each(["archive.db", "history.db", "bridge.db"])("refuses a full backup with required %s omitted from its checksum group", async name => {
  schemaMs = 0; opened = await open(); const { createBackup, readBackup } = await import("../src/core/backups.js");
  const backup = createBackup(env.home, clock, false), path = join(backup, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.files = manifest.files.filter((file: any) => file.path !== name);
  writeFileSync(path, JSON.stringify(manifest));
  const { createHash } = await import("node:crypto");
  if (existsSync(join(backup, "publication.json"))) writeFileSync(join(backup, "publication.json"), JSON.stringify({ version: 1, manifest: createHash("sha256").update(readFileSync(path)).digest("hex") }));
  if (name !== "bridge.db") rmSync(join(backup, name)); // Original home is untouched; test only the owned copy.
  expect(() => readBackup(backup)).toThrow();
  expect(opened.namespace).toMatch(/^[a-f0-9]{64}$/);
});

it("compares the selected alternate mailbox namespace with retained prepared evidence", async () => {
  schemaMs = 0; opened = await openMessageStore(join(env.home, "mail.db"), nullLogger, "fixture-current", "fixture-only-token", undefined, start + 10000);
  const { createBackup, readBackup } = await import("../src/core/backups.js"), backup = createBackup(env.home, clock, false);
  const copied = new DatabaseSync(join(backup, "mail.db")); copied.exec("UPDATE mailbox_store SET namespace='foreign-namespace'"); copied.close();
  // Recompute the ordinary file checksum, so the recipient namespace proof is
  // tested independently of generic tamper detection.
  const { createHash } = await import("node:crypto"), path = join(backup, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
  const bytes = readFileSync(join(backup, "mail.db")), entry = manifest.files.find((file: any) => file.path === "mail.db");
  entry.sha256 = createHash("sha256").update(bytes).digest("hex"); entry.bytes = bytes.length; writeFileSync(path, JSON.stringify(manifest));
  if (existsSync(join(backup, "publication.json"))) writeFileSync(join(backup, "publication.json"), JSON.stringify({ version: 1, manifest: createHash("sha256").update(readFileSync(path)).digest("hex") }));
  expect(() => readBackup(backup)).toThrow();
});

it("refuses backup publication when the final rename cannot be made directory-durable and retains all captured bytes", async () => {
  schemaMs = 0; opened = await open(); const { createBackup, listBackups } = await import("../src/core/backups.js");
  const originals = readFileSync(env.db); let reached = false;
  directoryIo.onSync = () => {
    const root = join(env.home, "backups");
    if (directoryIo.syncs.at(-1) === root && readdirSync(root).some(name => name.startsWith("snapshot-"))) {
      reached = true; throw Object.assign(new Error("Controlled final publication failure"), { code: "ENOTSUP" });
    }
  };
  expect(() => createBackup(env.home, clock, false)).toThrow(); expect(reached).toBe(true);
  directoryIo.onSync = undefined;
  expect(readFileSync(env.db)).toEqual(originals); expect(listBackups(env.home)).toEqual([]);
  expect(readdirSync(join(env.home, "backups")).length).toBeGreaterThan(0);
});

it.each([1, 2, 3, 4])("refuses automatic component%s upgrade before effects but preserves originals under explicit isolated offline admission", async version => {
  schemaMs = 0; const legacy = new DatabaseSync(env.db);
  legacy.exec(`CREATE TABLE bridge_components(name TEXT PRIMARY KEY,version INTEGER); INSERT INTO bridge_components VALUES('metadata',${version}); CREATE TABLE accepted_original(body BLOB); INSERT INTO accepted_original VALUES(x'00ff01');`); legacy.close();
  const bytes = readFileSync(env.db);
  expect(() => metadataDb(env.home)).toThrow(/owner-coordinated offline migration/i); expect(readFileSync(env.db)).toEqual(bytes);
  expect(existsSync(join(env.home, ".store-bootstrap"))).toBe(false); expect(existsSync(join(env.home, ".migration-snapshots"))).toBe(false);
  const admitted = metadataDb(env.home, { kind: "offline-isolated", home: env.home });
  expect(admitted.prepare("SELECT body FROM accepted_original").get()!.body).toEqual(new Uint8Array([0,255,1]));
  expect(admitted.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()!.version).toBe(5);
  expect(JSON.parse(String(admitted.prepare("SELECT value FROM bridge_metadata WHERE domain='store-bootstrap' AND key='provenance'").get()!.value)).kind).toBe("ordinary");
  const snapshots = readdirSync(join(env.home, ".migration-snapshots")).filter(name => name.endsWith(".db")); expect(snapshots.length).toBeGreaterThan(0);
});

it("never treats current component missing provenance as ordinary or rebuilds a removed external anchor", async () => {
  schemaMs = 0; opened = await open(); opened.close(); opened = undefined;
  const anchor = join(env.home, ".store-bootstrap.expected.json"), bytes = readFileSync(env.db);
  renameSync(anchor, join(env.home, "retained-original-anchor"));
  expect(() => metadataDb(env.home)).toThrow(/preparation/i);
  await expect(open()).rejects.toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  expect(readFileSync(env.db)).toEqual(bytes); expect(wire.starts).toBe(1); expect(existsSync(anchor)).toBe(false);
});

it("refuses a current component with no provenance row without minting ordinary authority", () => {
  const db = new DatabaseSync(env.db);
  db.exec("CREATE TABLE bridge_components(name TEXT PRIMARY KEY,version INTEGER); INSERT INTO bridge_components VALUES('metadata',5); CREATE TABLE accepted_original(body BLOB); INSERT INTO accepted_original VALUES(x'00ff01');"); db.close();
  const bytes = readFileSync(env.db); expect(() => metadataDb(env.home)).toThrow(/preparation/i);
  expect(readFileSync(env.db)).toEqual(bytes); expect(existsSync(join(env.home, ".store-bootstrap.expected.json"))).toBe(false);
});

it("keeps version-zero capability census read-only without phantom writable lifecycle admissions", async () => {
  const raw = new DatabaseSync(env.db); raw.exec("CREATE TABLE accepted_original(body BLOB); INSERT INTO accepted_original VALUES(x'00ff01');"); raw.close();
  const api = await import("../src/core/metadata-db.js"), bytes = readFileSync(env.db);
  const before = api.observeMetadataClosePrerequisites(performance.now() + 2000);
  expect(api.existingMetadataDb(env.home)).toBeUndefined(); expect(readFileSync(env.db)).toEqual(bytes);
  const after = api.observeMetadataClosePrerequisites(performance.now() + 2000);
  expect(after.admissionGeneration).toBe(before.admissionGeneration);
  expect(after.outcomes.legacyCloseReturns).toBe(before.outcomes.legacyCloseReturns);
  expect(after.outcomes.registeredHandles).toBe(before.outcomes.registeredHandles);
  const current = api.metadataDb(env.home), admitted = api.observeMetadataClosePrerequisites(performance.now() + 2000);
  expect(admitted.admissionGeneration).toBe(before.admissionGeneration + 1);
  expect(admitted.outcomes.legacyCloseReturns).toBe(before.outcomes.legacyCloseReturns);
  expect(current.prepare("SELECT body FROM accepted_original").get()!.body).toEqual(new Uint8Array([0,255,1]));
});

it("refuses a future mailbox schema before metadata publication changes its bytes", async () => {
  const db = new DatabaseSync(env.db); db.exec("CREATE TABLE future_accepted(body BLOB); INSERT INTO future_accepted VALUES(x'00ff01'); PRAGMA user_version=999;"); db.close();
  const bytes = readFileSync(env.db), { MessageStore } = await import("../src/core/store.js");
  expect(() => new MessageStore(env.db, nullLogger)).toThrow(/newer/i); expect(readFileSync(env.db)).toEqual(bytes);
  expect(existsSync(join(env.home, ".migration-snapshots"))).toBe(false);
});

it("preserves a proven existing provenance row byte-for-byte through explicit component upgrade and retry", () => {
  const original = metadataDb(env.home), row = original.prepare("SELECT value,updated_at FROM bridge_metadata WHERE domain='store-bootstrap' AND key='provenance'").get();
  original.exec("UPDATE bridge_components SET version=1 WHERE name='metadata'"); closeMetadataDbs();
  const admitted = metadataDb(env.home, { kind: "offline-isolated", home: env.home });
  expect(admitted.prepare("SELECT value,updated_at FROM bridge_metadata WHERE domain='store-bootstrap' AND key='provenance'").get()).toEqual(row);
  closeMetadataDbs(); expect(metadataDb(env.home).prepare("SELECT value,updated_at FROM bridge_metadata WHERE domain='store-bootstrap' AND key='provenance'").get()).toEqual(row);
});

it("retains a partially published anchor across restart and never reexecutes it as fresh or ordinary", async () => {
  schemaMs = 0; const anchor = join(env.home, ".store-bootstrap.expected.json");
  directoryIo.onSync = () => { if (existsSync(anchor)) throw new Error("Controlled post-anchor publication failure"); };
  await expect(open()).rejects.toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  const bytes = readFileSync(anchor); directoryIo.onSync = undefined;
  await expect(open()).rejects.toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  expect(readFileSync(anchor)).toEqual(bytes); expect(wire.starts).toBe(1); expect(ddl).toBe(0); expect(existsSync(env.db)).toBe(false);
});

it("preserves a bounded supported-directory failure stage across the actual fake-worker IPC", async () => {
  schemaMs = 0; directoryIo.failure = "all";
  const failure = await open().then(value => { opened = value; return undefined; }, error => error);
  expect(failure).toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED", bootstrapStage: "directory-publication", bootstrapFailure: "unsupported-or-unproven" });
  expect(ddl).toBe(0); expect(JSON.stringify(failure)).not.toContain(env.home);
});

it.each(["absent", "replaced"])("retains expected whole-journal identity through final construction: %s", async mode => {
  schemaMs = 0;
  const policy = await import("../src/core/sqlite-policy.js"), configure = policy.configureSqlite; let changed = false;
  vi.spyOn(policy, "configureSqlite").mockImplementation((...args) => {
    configure(...args);
    if (!changed && wire.workers.length && wire.workers[0].threadId === -1) {
      changed = true; const dir = join(env.home, ".store-bootstrap"), retained = join(env.home, "retained-original-journal");
      renameSync(dir, retained);
      if (mode === "replaced") { mkdirSync(dir); for (const name of readdirSync(retained)) copyFileSync(join(retained, name), join(dir, name)); }
    }
  });
  const failure = await open().then(value => { opened = value; return undefined; }, error => error);
  expect(failure).toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" }); expect(opened).toBeUndefined(); expect(changed).toBe(true); expect(ddl).toBe(1);
  expect(readdirSync(join(env.home, "retained-original-journal"))).toHaveLength(3);
});

it("refuses a missing whole journal on restart and cached metadata instead of treating it as never prepared", async () => {
  schemaMs = 0; opened = await open(); opened.close(); opened = undefined;
  const cached = metadataDb(env.home), original = readFileSync(env.db);
  renameSync(join(env.home, ".store-bootstrap"), join(env.home, "retained-original-journal"));
  expect(() => metadataDb(env.home)).toThrow(/preparation/i); expect(cached.isOpen).toBe(true);
  const failure = await open().then(value => { opened = value; return undefined; }, error => error);
  expect(failure).toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" }); expect(ddl).toBe(1); expect(wire.starts).toBe(1);
  expect(readFileSync(env.db)).toEqual(original);
});

it.each([["missing module", "ERR_MODULE_NOT_FOUND"], ["unknown code", "not-allowlisted"], ["oversized code", "x".repeat(4097)]])("retains only a bounded classification for an actual fake Worker error event: %s", async (_label, code) => {
  wire.error = Object.assign(new Error("fixture-private-path-or-body"), { code });
  const failure = await open().then(store => { opened = store; throw new Error("Worker failure must not admit a store"); }, error => error);
  expect(failure).toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED", bootstrapStage: "worker-start-or-module-error",
    bootstrapFailure: code === "ERR_MODULE_NOT_FOUND" ? "module-not-found" : "unclassified" });
  expect(JSON.stringify(failure)).not.toContain("fixture-private-path-or-body");
  expect(existsSync(env.db)).toBe(false); expect(ddl).toBe(0); expect(wire.workers[0].threadId).toBe(-1);
});

it("validates prepared evidence against the captured worker incarnation after the live threadId retires", async () => {
  wire.exitedBeforeMessage = true;
  opened = await open(); expect(opened.namespace).toMatch(/^[a-f0-9]{64}$/);
  expect(wire.workers[0].threadId).toBe(-1); expect(ddl).toBe(1); inspectBootstrapJournal(env.home);
});

it("refuses a prepared record from another thread even after the owned live threadId retires", async () => {
  wire.exitedBeforeMessage = true; wire.wrongThread = true;
  await expect(open()).rejects.toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED", bootstrapStage: "prepared-record-validation", bootstrapFailure: "worker-thread" });
  expect(ddl).toBe(1); const original = readFileSync(env.db);
  await expect(open()).rejects.toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  expect(wire.starts).toBe(1); expect(readFileSync(env.db)).toEqual(original);
});

it("does not invoke a Worker error code accessor or expose its private error data", async () => {
  const getter = vi.fn(() => { throw new Error("private accessor"); });
  wire.error = Object.defineProperty(new Error("fixture-private-path-or-body"), "code", { get: getter });
  const failure = await open().then(store => { opened = store; throw new Error("Must refuse worker error"); }, error => error);
  expect(failure).toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED", bootstrapFailure: "unclassified" });
  expect(getter).not.toHaveBeenCalled(); expect(JSON.stringify(failure)).not.toContain("fixture-private-path-or-body");
});

it("requires the archive profile workflow to build the actual bootstrap entry before running the unchanged regression", () => {
  const workflow = readFileSync(".github/workflows/ab319-archive-profile.yml", "utf8");
  const regression = workflow.indexOf("run: node node_modules/vitest/vitest.mjs run test/jobs-archive-persist.test.ts");
  const build = workflow.indexOf("run: npm run build");
  expect(regression).toBeGreaterThan(0); expect(build).toBeGreaterThan(0); expect(build).toBeLessThan(regression);
  expect(readFileSync("scripts/build.mjs", "utf8")).toContain('ENTRIES["store-bootstrap-worker"] = "src/core/store-bootstrap-worker.ts"');
});

it("admits slow preparation over two seconds only after exact worker exit and a fresh final opener within one outer budget", async () => {
  const diagnostic = setTimeout(() => console.error("Mock cold-bootstrap pending stage", wire.stage), 1000);
  try { opened = await open(); } finally { clearTimeout(diagnostic); }
  expect(clock - start).toBe(2400); expect(wire.starts).toBe(1); expect(ddl).toBe(1);
  expect(readdirSync(join(env.home, ".store-bootstrap"))).toHaveLength(3); inspectBootstrapJournal(env.home);
  const namespace = opened.namespace; opened.close(); opened = undefined;
  opened = await open(); expect(opened.namespace).toBe(namespace); expect(wire.starts).toBe(1); expect(ddl).toBe(1);
});
it("cannot turn a prepared IPC into admission before the exact owned exit", async () => {
  const gate = deferred(), seen = deferred(); wire.after = async () => { seen.release(); await gate.promise; };
  let admitted = false; const pending = open().then(store => { admitted = true; return store; }, error => error);
  try {
    await stageOrFailure(seen.promise, pending); expect(admitted).toBe(false); expect(readdirSync(join(env.home, ".store-bootstrap"))).toHaveLength(2);
    gate.release(); opened = await pending; expect(opened).not.toBeInstanceOf(Error); expect(admitted).toBe(true);
  } finally { gate.release(); await pending; }
});
it.each(["cancel", "expired"])("revokes cold startup before its first effect: %s", async kind => {
  if (kind === "expired") { clearTimeout(pendingDiagnostic); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); }
  const gate = deferred(), entered = deferred(), controller = new AbortController();
  wire.before = async () => { entered.release(); await gate.promise; };
  const pending = open(controller.signal).then(store => { opened = store; return undefined; }, error => error);
  try {
    await stageOrFailure(entered.promise, pending);
    if (kind === "cancel") controller.abort(new Error("original caller cancellation"));
    else { clock = start + 10001; await vi.advanceTimersByTimeAsync(10001); }
    const error = await pending;
    if (kind === "cancel") expect(error.message).toBe("original caller cancellation"); else expect(error).toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
    expect(existsSync(env.db)).toBe(false); expect(ddl).toBe(0); expect(wire.workers[0].threadId).toBe(-1);
    gate.release(); await Promise.resolve(); expect(existsSync(env.db)).toBe(false);
  } finally { gate.release(); await pending; }
});
it("retains accepted metadata and incomplete preparation at outer expiry without a later archive phase or repeat DDL", async () => {
  const original = metadataDb(env.home); original.exec("CREATE TABLE accepted_original(id TEXT,body BLOB); INSERT INTO accepted_original VALUES('original-uuid',x'00ff01')"); closeMetadataDbs();
  schemaMs = 10001;
  await expect(open()).rejects.toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  expect(existsSync(join(env.home, "archive.db"))).toBe(false); expect(ddl).toBe(1);
  const bytes = readFileSync(env.db), files = readdirSync(join(env.home, ".store-bootstrap")); expect(files).toHaveLength(1);
  clock = start + 10002; start = clock;
  await expect(open()).rejects.toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  expect(wire.starts).toBe(1); expect(ddl).toBe(1); expect(readFileSync(env.db)).toEqual(bytes);
  const retained = new DatabaseSync(env.db, { readOnly: true });
  try { expect(retained.prepare("SELECT * FROM accepted_original").all()).toEqual([{ id: "original-uuid", body: new Uint8Array([0,255,1]) }]); } finally { retained.close(); }
});
it("refuses a foreign result and preserves prepared evidence without automatically reexecuting it", async () => {
  wire.wrong = true;
  await expect(open()).rejects.toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  const bytes = readFileSync(env.db); expect(readdirSync(join(env.home, ".store-bootstrap"))).toHaveLength(2);
  await expect(open()).rejects.toMatchObject({ code: "STORE_BOOTSTRAP_UNSETTLED" });
  expect(wire.starts).toBe(1); expect(readFileSync(env.db)).toEqual(bytes); expect(ddl).toBe(1);
});
it("rechecks an incompatible reader arriving after preparation and never admits that store", async () => {
  const gate = deferred(), seen = deferred(); wire.after = async () => { seen.release(); await gate.promise; };
  const pending = open().then(store => { opened = store; return undefined; }, error => error);
  await stageOrFailure(seen.promise, pending);
  const fs = await import("node:fs"), dir = join(env.home, ".storage-users"); fs.mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}-foreign`), JSON.stringify({ pid: process.pid, nonce: "foreign", createdAt: clock, mailboxProtocol: 7, mailboxSchema: 14 }));
  gate.release(); const refusal = await pending; expect(refusal).toMatchObject({ code: "protocol_mismatch" }); expect(opened).toBeUndefined(); expect(ddl).toBe(1);
});
it("caps the genuinely fresh final opener by outer remaining time without replaying preparation", async () => {
  schemaMs = 9850;
  const policy = await import("../src/core/sqlite-policy.js"), configure = policy.configureSqlite;
  vi.spyOn(policy, "configureSqlite").mockImplementation((...args) => {
    configure(...args);
    if (wire.workers.length && wire.workers[0].threadId === -1) clock += 151;
  });
  await expect(open()).rejects.toMatchObject({ code: "timeout" });
  expect(ddl).toBe(1); expect(wire.starts).toBe(1); expect(opened).toBeUndefined();
  expect(readdirSync(join(env.home, ".store-bootstrap"))).toHaveLength(3); inspectBootstrapJournal(env.home);
});
