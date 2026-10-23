import { EventEmitter } from "node:events";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openMessageStore, type MessageStore } from "../src/core/store.js";
import { closeMetadataDbs, metadataDb } from "../src/core/metadata-db.js";
import { nullLogger } from "../src/core/logger.js";
import * as migrations from "../src/core/sqlite-migrations.js";
import { inspectBootstrapJournal } from "../src/core/store-bootstrap-journal.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const wire = vi.hoisted(() => ({ starts: 0, before: undefined as undefined | (() => Promise<void>),
  after: undefined as undefined | (() => Promise<void>), wrong: false, workers: [] as any[], stage: "idle", kernelThread: 0, error: undefined as unknown, exitedBeforeMessage: false, wrongThread: false }));
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
        this.running = false; this.emit("message", { attempt: plan.record.attempt, state: "failed" }); this.finish(1);
      }
    }
    terminate() { this.terminated = true; if (!this.running) this.finish(1); return this.exited; }
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
  const number = ++fixtureNumber; wire.stage = "setup";
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
});
const open = (signal?: AbortSignal) => openMessageStore(env.db, nullLogger, "fixture-current", "fixture-only-token", signal, start + 10000);
const stageOrFailure = (stage: Promise<void>, pending: Promise<unknown>) => Promise.race([stage, pending.then(error => { throw error instanceof Error ? error : new Error("Original operation settled before the required stage"); })]);

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
