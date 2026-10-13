import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HistoryBackground, HistoryWorkerCheckpoint } from "../src/core/history-background.js";
import type { Logger } from "../src/core/logger.js";
import type { PeerInfo } from "../src/core/protocol.js";

type Message = Record<string, any>;
type OwnedWorker = EventEmitter & { sent: Message[]; postMessage: Mock<(message: Message) => void>; terminate: Mock<() => Promise<number>> };
type FixturePort = EventEmitter & { postMessage: Mock<(message: Message) => boolean | undefined>; close: ReturnType<typeof vi.fn> };
const fixture = vi.hoisted(() => ({
  workers: [] as OwnedWorker[], port: null as FixturePort | null,
  workerData: {} as Message, connected: false, nativeFixture: false,
  budget: vi.fn(), metadata: vi.fn(), migration: vi.fn(), reconcile: vi.fn(),
  indexReset: vi.fn(), indexPeer: vi.fn(), indexTick: vi.fn(), indexWake: vi.fn(), indexClose: vi.fn(),
  ingestTick: vi.fn(), ingestClose: vi.fn(), dbClose: vi.fn(), metadataClose: vi.fn(), leaseRelease: vi.fn(),
  ingestors: [] as Array<{ onChange?: () => void }>,
}));

// Owned IPC fixture. It executes the actual source handlers with controlled stores,
// not a second model of their lifecycle algorithm. No native worker/store is opened.
vi.mock("node:worker_threads", async importOriginal => {
  const { EventEmitter } = await import("node:events");
  const native = await importOriginal<typeof import("node:worker_threads")>();
  class Worker extends EventEmitter {
    sent: Message[] = [];
    postMessage = vi.fn((message: Message) => {
      const bytes = structuredClone(message);
      this.sent.push(bytes);
      if (fixture.connected) fixture.port?.emit("message", bytes);
    });
    terminate = vi.fn(async () => 0);
    unref() {}
    constructor(_entry: unknown, options: Message) {
      super(); fixture.workerData = options.workerData;
      if (fixture.nativeFixture) {
        // Hosted-only fault fixture. Its error/exit callbacks come from an actual
        // owned Node worker, never emit("exit"), timeout or a synthetic exit flag.
        const actual = new native.Worker(`
          const { parentPort } = require('node:worker_threads');
          const accepted = [];
          parentPort.on('message', message => {
            if (message.fixtureFault) throw new Error('owned fixture IPC fault');
            if (message.fixtureExit) { process.exitCode = message.code; parentPort.close(); return; }
            if (message.fixtureCheckpoint) { parentPort.postMessage({ historyCheckpoint: message.fixtureCheckpoint }); return; }
            accepted.push(message);
          });
        `, { eval: true, execArgv: [], workerData: options.workerData });
        const sent: Message[] = [], post = actual.postMessage.bind(actual);
        const owned = Object.assign(actual, { sent });
        owned.postMessage = vi.fn((message: Message) => { sent.push(structuredClone(message)); post(message); });
        owned.terminate = vi.fn(actual.terminate.bind(actual));
        fixture.workers.push(owned as unknown as OwnedWorker);
        return owned as unknown as Worker;
      }
      fixture.workers.push(this);
    }
  }
  const port = Object.assign(new EventEmitter(), {
    postMessage: vi.fn((message: Message) => fixture.workers[0]?.emit("message", structuredClone(message))), close: vi.fn(),
  });
  fixture.port = port;
  return { Worker, parentPort: port, get workerData() { return fixture.workerData; } };
});
vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(), existsSync: vi.fn(() => true), statSync: vi.fn(() => ({ mtimeMs: 0 })), mkdirSync: vi.fn(),
}));
vi.mock("node:sqlite", () => ({ DatabaseSync: class { exec() {} close = fixture.dbClose; } }));
vi.mock("node:timers/promises", () => ({ setTimeout: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) }));
vi.mock("../src/core/history-store.js", () => ({
  HISTORY_IO_BYTES_PER_SECOND: 64 * 1024 * 1024, historyDbPath: (file: string) => file.replace("bridge.db", "history.db"),
  releaseExitedHistoryLease: fixture.leaseRelease, openHistoryStore: () => ({ close: fixture.dbClose }),
  historyMigrationFailure: () => null, copyLegacyConversationTail: () => 0, legacyTailConflicts: () => 0, migrateHistoryStore: fixture.migration,
}));
vi.mock("../src/core/metadata-db.js", () => ({ checkpointOwnedMetadataConnections: fixture.metadata, closeMetadataDbs: fixture.metadataClose }));
vi.mock("../src/core/history.js", () => ({ HISTORY_TICK_MS: 100, HistoryIndex: class {
  reset = fixture.indexReset; rememberPeer = fixture.indexPeer; tick = fixture.indexTick; wake = fixture.indexWake; close = fixture.indexClose;
} }));
vi.mock("../src/core/conversations.js", () => ({ ConversationIngestor: class {
  onChange?: () => void; discovering = false; tick = fixture.ingestTick; close = fixture.ingestClose;
  constructor() { fixture.ingestors.push(this); }
} }));
vi.mock("../src/core/transcripts/common.js", () => ({ transcriptPaths: () => ({ claude: "/fixture/claude", codex: "/fixture/codex", opencode: "/fixture/opencode" }) }));
vi.mock("../src/core/config.js", () => ({ loadConfig: () => ({ history: { ingest: true, budgetBytes: 1024 } }) }));
vi.mock("../src/core/history-migration.js", () => ({ readHistoryMigrationProgress: () => ({ phase: "starting", error: null }) }));
vi.mock("../src/core/history-budget.js", () => ({ historyBudget: fixture.budget }));
vi.mock("../src/core/project-store.js", () => ({ ownsProjectMirrors: () => false, projectDatabasePath: () => "/fixture/mirror" }));
vi.mock("../src/core/ask-completion.js", () => ({ reconcileAskCompletions: fixture.reconcile }));
vi.mock("../src/core/run-history.js", () => ({ readHistoryJson: () => null }));
vi.mock("../src/core/json-store.js", () => ({ isRecord: () => false, writeJsonStore: vi.fn() }));
vi.mock("../src/core/file-cache.js", () => ({ fileSignature: () => "owned-fixture" }));

let background: HistoryBackground, worker: OwnedWorker;
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  fixture.workers.length = 0; fixture.ingestors.length = 0; fixture.connected = false; fixture.nativeFixture = false; fixture.port = null;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  fixture.budget.mockResolvedValue({ paused: false, bytes: 0, budgetBytes: 1024 });
  fixture.migration.mockResolvedValue(undefined); fixture.reconcile.mockReturnValue(7);
  fixture.indexTick.mockReturnValue({ work: 0, discovering: false }); fixture.ingestTick.mockReturnValue(1);
  fixture.metadata.mockImplementation((owner: Message) => ({ ownerInstance: owner.ownerInstance, generation: owner.generation,
    ownedConnections: 1, registryGeneration: 1, physicalFiles: 1, nonWalFiles: 0, noWalFiles: 0, completedCheckpoints: 1,
    checkpointed: true, reason: "settled", fileIdentityDigest: "a".repeat(64), handlesRetained: true, ownershipReleased: false }));
  const { HistoryBackground } = await import("../src/core/history-background.js");
  fixture.port = (await import("node:worker_threads")).parentPort as unknown as FixturePort | null;
  fixture.port?.removeAllListeners();
  background = new HistoryBackground("/fixture/bridge.db", { warn: vi.fn() } as unknown as Logger);
  worker = fixture.workers[0]!;
});
afterEach(async () => {
  fixture.connected = false; fixture.port?.removeAllListeners(); vi.clearAllTimers(); vi.useRealTimers();
  // Retire only a still-live test thread if an assertion interrupted its fixture.
  for (const owned of fixture.workers) {
    if (Number(Reflect.get(owned, "threadId")) > 0) {
      const exit = new Promise<void>(resolve => owned.once("exit", () => resolve()));
      owned.postMessage({ fixtureExit: true, code: 0 }); await exit;
    }
  }
});
async function connectWorker() {
  fixture.connected = true;
  await import("../src/core/history-worker.js");
}
async function actualOwnedThread() {
  vi.useRealTimers(); fixture.nativeFixture = true; fixture.workers.length = 0;
  const { HistoryBackground } = await import("../src/core/history-background.js");
  background = new HistoryBackground("/fixture/bridge.db", { warn: vi.fn() } as unknown as Logger);
  worker = fixture.workers[0]!;
  await new Promise<void>(resolve => worker.once("online", resolve));
}
const checkpoints = () => worker.sent.filter(message => message.historyLifecycle === "checkpoint");
function acknowledgement(request: Message, fields: Partial<HistoryWorkerCheckpoint> = {}): HistoryWorkerCheckpoint {
  return { ownerInstance: request.ownerInstance, generation: request.generation, requestId: request.requestId,
    quiesced: true, pendingOperations: 0, retainedPeers: 0, retainedReset: false, retainedSchedule: true,
    pressureWaiters: 0, pressurePending: false, budgetRunning: false, unknown: false, producerSettled: true, reason: "owner_unsupported",
    metadata: null, handlesRetained: true, ownershipReleased: false, ...fields };
}
const peer = { id: "fixture-peer", name: "fixture-peer", agent: "codex", retainedBytes: new Uint8Array([0, 255, 1]) } as unknown as PeerInfo;
function noRetirement() {
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(worker.sent.some(message => message.stop)).toBe(false);
  expect(fixture.dbClose).not.toHaveBeenCalled(); expect(fixture.metadataClose).not.toHaveBeenCalled();
  expect(fixture.indexClose).not.toHaveBeenCalled(); expect(fixture.ingestClose).not.toHaveBeenCalled();
  expect(fixture.leaseRelease).not.toHaveBeenCalled();
}

describe("trusted history owner observation; unsupported store closure stays blocked", () => {
  it("keeps default tick/reconcile/peer admission and normal results before a lifecycle seal", async () => {
    background.rememberPeer(peer); const tick = background.tick(true), reconcile = background.reconcileAsks();
    expect(background.reconcileAsks()).toBe(reconcile);
    expect(worker.sent).toContainEqual({ peer });
    const requests = worker.sent.filter(message => message.id);
    worker.emit("message", { id: requests[0]!.id, result: { work: 2, discovering: false } });
    worker.emit("message", { id: requests[1]!.id, result: { work: 7, discovering: false } });
    expect(await tick).toEqual({ work: 2, discovering: false });
    expect(await reconcile).toEqual({ work: 7, discovering: false });
    expect(worker.sent.some(message => message.historyLifecycle)).toBe(false); noRetirement();
  });

  it("one observer expires at the original deadline without cancelling accepted reset/reconcile/wake bytes", async () => {
    background.pressure(true); background.rememberPeer(peer); background.messageArrived();
    const tick = background.tick(true), reconcile = background.reconcileAsks();
    const pending = Reflect.get(background, "pending"), capture = Reflect.get(background, "lifecycleCapture");
    let tickDone = false; void tick.then(() => { tickDone = true; });
    background.quiesceLifecycleMaintenance();
    await expect(background.tick()).rejects.toThrow("sealed");
    expect(background.reconcileAsks()).toBe(reconcile);
    background.rememberPeer({ ...peer, id: "not-admitted" }); background.messageArrived(); background.pressure(true, true);
    const first = background.settleLifecycleMaintenance(performance.now() + 2000);
    expect(await background.settleLifecycleMaintenance(performance.now() + 2000)).toMatchObject({ reason: "observer_busy", settled: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await first).toMatchObject({ reason: "budget", pendingWorkers: 1, settled: false, unknown: false, retainedWake: true });
    expect(tickDone).toBe(false); expect(Reflect.get(background, "pending")).toBe(pending);
    expect(Reflect.get(background, "lifecycleCapture")).toBe(capture);
    expect(await background.settleLifecycleMaintenance(performance.now() + 2000)).toMatchObject({ reason: "budget", settled: false });
    expect(checkpoints()).toHaveLength(1); expect(worker.sent.filter(message => message.peer)).toEqual([{ peer }]);
    background.pressure(false); expect(worker.sent).toContainEqual({ pressure: true, pending: false, lockError: false });
    const requests = worker.sent.filter(message => message.id && !message.historyLifecycle);
    worker.emit("message", { id: requests[0]!.id, result: { work: 1, discovering: false } });
    worker.emit("message", { id: requests[1]!.id, result: { work: 7, discovering: false } });
    await tick; await reconcile; noRetirement();
  });

  it("late exact checkpoint, actual owned thread error and exact exit cannot convert a timeout into a witness", async () => {
    await actualOwnedThread();
    const tick = background.tick(true); let completed = false; void tick.then(() => { completed = true; });
    background.quiesceLifecycleMaintenance(); const observation = background.settleLifecycleMaintenance(performance.now() + 20);
    await observation;
    const result = new Promise<void>(resolve => worker.once("message", () => resolve()));
    worker.postMessage({ fixtureCheckpoint: acknowledgement(checkpoints()[0]!) }); await result;
    expect(background.lifecycleOwnerManifest()).toMatchObject({ unknown: true, checkpoint: null, settled: false, pendingWorkers: 1 });
    const capture = Reflect.get(background, "lifecycleCapture"), pending = Reflect.get(background, "pending");
    const exit = new Promise<number>(resolve => worker.once("exit", resolve));
    worker.postMessage({ fixtureFault: true }); expect(await exit).toBe(1);
    expect(background.lifecycleOwnerManifest()).toMatchObject({ unknown: true, workerExited: true, pendingWorkers: 0, settled: false });
    expect(completed).toBe(false); expect(Reflect.get(background, "pending")).toBe(pending); expect(pending.size).toBe(1);
    expect(Reflect.get(background, "lifecycleCapture")).toBe(capture);
    background.resumeLifecycleMaintenance();
    expect(fixture.workers).toHaveLength(1); expect(background.lifecycleOwnerManifest().unknown).toBe(true); noRetirement();
  });

  it.each(["ownerInstance", "generation", "requestId"] as const)("rejects a checkpoint with the wrong %s for this exact capture", async field => {
    background.quiesceLifecycleMaintenance(); const waiting = background.settleLifecycleMaintenance(performance.now() + 2000);
    const ack = acknowledgement(checkpoints()[0]!); Reflect.set(ack, field, field === "generation" ? ack.generation + 1 : "foreign");
    worker.emit("message", { historyCheckpoint: ack });
    expect(await waiting).toMatchObject({ unknown: true, checkpoint: null, settled: false }); noRetirement();
  });

  it("a full source-owned manifest remains ineligible even with a timely worker/metadata stage result", async () => {
    background.quiesceLifecycleMaintenance(); const waiting = background.settleLifecycleMaintenance(performance.now() + 2000);
    worker.emit("message", { historyCheckpoint: acknowledgement(checkpoints()[0]!) });
    const manifest = await waiting;
    expect(manifest).toMatchObject({ workSettled: true, settled: false, blocker: "owner_unsupported", handlesRetained: true, ownershipReleased: false });
    expect(Object.isFrozen(manifest)).toBe(true); expect(Object.isFrozen(manifest.checkpoint)).toBe(true);
    expect(background.isCurrentLifecycleWitness(manifest, () => true)).toBe(false);
    for (const field of ["ownerInstance", "generation", "quiesced", "pendingOperations", "pendingWorkers", "unknown", "stopped", "settled", "checkpoint", "callbackGeneration"]) {
      expect(background.isCurrentLifecycleWitness({ ...manifest, [field]: field === "settled" ? true : null } as any, () => true)).toBe(false);
    }
    expect(background.isCurrentLifecycleWitness(manifest, () => false)).toBe(false);
    const generation = manifest.callbackGeneration; worker.emit("message", { migrationProgress: { phase: "verified" } });
    expect(background.lifecycleOwnerManifest().callbackGeneration).toBeGreaterThan(generation);
    expect(background.lifecycleOwnerManifest().checkpoint).toBeNull(); noRetirement();
  });

  it("pre-abort resume retains the active worker, accepted waiters and coalesced wake without duplicate workers", async () => {
    background.messageArrived(); const tick = background.tick(true); const pending = Reflect.get(background, "pending");
    background.quiesceLifecycleMaintenance(); const waiting = background.settleLifecycleMaintenance(performance.now() + 2000);
    const oldRequest = checkpoints()[0]!; background.resumeLifecycleMaintenance();
    expect(await waiting).toMatchObject({ quiesced: false, settled: false });
    worker.emit("message", { historyCheckpoint: acknowledgement(oldRequest) });
    expect(background.lifecycleOwnerManifest()).toMatchObject({ unknown: false, checkpoint: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.workers).toHaveLength(1); expect(Reflect.get(background, "pending")).toBe(pending);
    expect(worker.sent.filter(message => message.wake)).toHaveLength(1);
    const request = worker.sent.find(message => message.reset)!;
    worker.emit("message", { id: request.id, result: { work: 1, discovering: false } }); await tick; noRetirement();
  });

  it("a queued normal restart stays inhibited and resumes once without replacing an active worker", async () => {
    await actualOwnedThread(); const exit = new Promise<number>(resolve => worker.once("exit", resolve));
    worker.postMessage({ fixtureExit: true, code: 1 }); expect(await exit).toBe(1);
    background.quiesceLifecycleMaintenance(); expect(Reflect.get(background, "restart")).toBeNull();
    expect(fixture.workers).toHaveLength(1); fixture.nativeFixture = false;
    background.resumeLifecycleMaintenance(); expect(fixture.workers).toHaveLength(2);
    background.resumeLifecycleMaintenance(); expect(fixture.workers).toHaveLength(2);
  });

  it("a real zero-code exit after a timely owned worker-stage ACK still cannot certify history/project closure", async () => {
    await actualOwnedThread(); background.quiesceLifecycleMaintenance();
    const waiting = background.settleLifecycleMaintenance(performance.now() + 2000);
    worker.postMessage({ fixtureCheckpoint: acknowledgement(checkpoints()[0]!) });
    const observation = await waiting;
    expect(observation).toMatchObject({ workSettled: true, settled: false, blocker: "owner_unsupported" });
    const capture = Reflect.get(background, "lifecycleCapture");
    const exit = new Promise<number>(resolve => worker.once("exit", resolve));
    worker.postMessage({ fixtureExit: true, code: 0 }); expect(await exit).toBe(0);
    expect(Reflect.get(background, "lifecycleCapture")).toBe(capture);
    expect(background.lifecycleOwnerManifest()).toMatchObject({ unknown: true, workerExited: true, settled: false, ownershipReleased: false });
    expect(background.isCurrentLifecycleWitness(observation, () => true)).toBe(false); noRetirement();
  });
});

describe("connected production history worker queues with controlled dependencies", () => {
  it("settles accepted peer/reconcile/reset/tick while admission is sealed and keeps all store handles", async () => {
    await connectWorker(); background.rememberPeer(peer);
    const tick = background.tick(true), reconcile = background.reconcileAsks();
    background.quiesceLifecycleMaintenance(); const waiting = background.settleLifecycleMaintenance(performance.now() + 2000);
    expect(fixture.metadata).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20); await tick; expect(await reconcile).toEqual({ work: 7, discovering: false });
    const observation = await waiting;
    expect(fixture.indexPeer).toHaveBeenCalledExactlyOnceWith(peer); expect(fixture.indexReset).toHaveBeenCalledOnce();
    expect(observation).toMatchObject({ workSettled: true, settled: false, reason: "owner_unsupported", pendingWorkers: 1 });
    expect(observation.checkpoint).toMatchObject({ pendingOperations: 0, retainedPeers: 0, retainedReset: false, metadata: { checkpointed: true, handlesRetained: true, ownershipReleased: false } });
    expect(fixture.metadata).toHaveBeenCalledOnce(); noRetirement();
  });

  it("retains a pressure-blocked accepted timer and releases only on the original writer's pressure-clear continuation", async () => {
    await connectWorker(); background.pressure(true); background.rememberPeer(peer);
    // The peer wake timer is actually admitted and suspended on pressure before sealing.
    await vi.advanceTimersByTimeAsync(0);
    background.quiesceLifecycleMaintenance(); const waiting = background.settleLifecycleMaintenance(performance.now() + 2000);
    await vi.advanceTimersByTimeAsync(30); expect(fixture.metadata).not.toHaveBeenCalled(); expect(fixture.indexPeer).not.toHaveBeenCalled();
    background.pressure(false); await vi.advanceTimersByTimeAsync(20);
    expect(await waiting).toMatchObject({ settled: false, workSettled: true, reason: "owner_unsupported" });
    expect(fixture.indexPeer).toHaveBeenCalledExactlyOnceWith(peer); noRetirement();
  });

  it("retains a deferred accepted reset and exact peer bytes through a budget pause and resumes them on the same worker", async () => {
    await connectWorker(); fixture.budget.mockResolvedValue({ paused: true, bytes: 1024, budgetBytes: 1024 });
    background.rememberPeer(peer); const tick = background.tick(true);
    expect(await tick).toEqual({ work: 0, discovering: true });
    background.quiesceLifecycleMaintenance();
    const observation = await background.settleLifecycleMaintenance(performance.now() + 2000);
    expect(observation).toMatchObject({ workSettled: false, settled: false, reason: "pending" });
    expect(observation.checkpoint).toMatchObject({ retainedReset: true, retainedPeers: 1, pendingOperations: 2 });
    expect(fixture.metadata).not.toHaveBeenCalled(); expect(fixture.indexReset).not.toHaveBeenCalled();
    fixture.budget.mockResolvedValue({ paused: false, bytes: 0, budgetBytes: 1024 });
    background.resumeLifecycleMaintenance(); await vi.advanceTimersByTimeAsync(20);
    expect(fixture.workers).toHaveLength(1); expect(fixture.indexPeer).toHaveBeenCalledExactlyOnceWith(peer); expect(fixture.indexReset).toHaveBeenCalledOnce();
    expect((fixture.indexPeer.mock.calls[0]![0] as Message).retainedBytes).toEqual(new Uint8Array([0, 255, 1])); noRetirement();
  });

  it("waits for an admitted asynchronous storage-budget continuation and preserves its original observer deadline", async () => {
    await connectWorker(); let release!: (value: Message) => void;
    fixture.budget.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const tick = background.tick(); background.quiesceLifecycleMaintenance();
    const waiting = background.settleLifecycleMaintenance(performance.now() + 20);
    await vi.advanceTimersByTimeAsync(20); expect(await waiting).toMatchObject({ reason: "budget", pendingWorkers: 1, settled: false });
    expect(fixture.metadata).not.toHaveBeenCalled(); release({ paused: false, bytes: 0, budgetBytes: 1024 });
    await vi.advanceTimersByTimeAsync(20); await tick;
    expect(background.lifecycleOwnerManifest()).toMatchObject({ unknown: true, settled: false, checkpoint: null });
    expect(checkpoints()).toHaveLength(1); noRetirement();
  });

  it("includes a previously admitted periodic budget check rather than treating a completed tick as the whole queue", async () => {
    await connectWorker(); let finishMigration!: () => void, finishBudget!: (value: Message) => void;
    fixture.migration.mockImplementationOnce(() => new Promise<void>(resolve => { finishMigration = resolve; }));
    const tick = background.tick(); await Promise.resolve();
    fixture.budget.mockImplementationOnce(() => new Promise(resolve => { finishBudget = resolve; }));
    await vi.advanceTimersByTimeAsync(1000);
    background.quiesceLifecycleMaintenance(); const waiting = background.settleLifecycleMaintenance(performance.now() + 2000);
    finishMigration(); await vi.advanceTimersByTimeAsync(20); await tick;
    expect(fixture.metadata).not.toHaveBeenCalled();
    finishBudget({ paused: false, bytes: 0, budgetBytes: 1024 }); await Promise.resolve(); await Promise.resolve();
    expect(await waiting).toMatchObject({ settled: false, workSettled: true, checkpoint: { budgetRunning: false } }); noRetirement();
  });

  it("resumes during an owned active tick and restores its retained timer only after the accepted work completes", async () => {
    await connectWorker(); let release!: (value: Message) => void;
    fixture.budget.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const tick = background.tick(true); background.quiesceLifecycleMaintenance();
    const waiting = background.settleLifecycleMaintenance(performance.now() + 2000);
    background.resumeLifecycleMaintenance(); expect(await waiting).toMatchObject({ quiesced: false, settled: false });
    release({ paused: false, bytes: 0, budgetBytes: 1024 }); await vi.advanceTimersByTimeAsync(20); await tick;
    expect(fixture.workers).toHaveLength(1); expect(fixture.indexReset).toHaveBeenCalledOnce();
    expect(fixture.ingestTick).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(fixture.ingestTick.mock.calls.length).toBeGreaterThan(1); noRetirement();
  });

  it("retains an accepted reset if pressure defers it after migration and applies it once on pre-abort resume", async () => {
    await connectWorker(); let finishMigration!: () => void;
    fixture.migration.mockImplementationOnce(() => new Promise<void>(resolve => { finishMigration = resolve; }));
    const tick = background.tick(true); await vi.advanceTimersByTimeAsync(0);
    background.pressure(true); background.quiesceLifecycleMaintenance();
    const waiting = background.settleLifecycleMaintenance(performance.now() + 2000);
    finishMigration(); await vi.advanceTimersByTimeAsync(0); await tick;
    expect(await waiting).toMatchObject({ settled: false, workSettled: false, checkpoint: { retainedReset: true } });
    expect(fixture.indexReset).not.toHaveBeenCalled(); background.pressure(false);
    background.resumeLifecycleMaintenance(); await vi.advanceTimersByTimeAsync(20);
    expect(fixture.indexReset).toHaveBeenCalledOnce(); noRetirement();
  });

  it("a retained transcript change invalidates a prior worker-stage manifest while its watcher remains owned", async () => {
    await connectWorker(); const tick = background.tick(); await vi.advanceTimersByTimeAsync(20); await tick;
    background.quiesceLifecycleMaintenance();
    const observation = await background.settleLifecycleMaintenance(performance.now() + 2000);
    expect(observation.workSettled).toBe(true); const revision = observation.callbackGeneration;
    fixture.ingestors[0]!.onChange!();
    expect(background.lifecycleOwnerManifest()).toMatchObject({ checkpoint: null, workSettled: false, settled: false });
    expect(background.lifecycleOwnerManifest().callbackGeneration).toBeGreaterThan(revision);
    expect(background.isCurrentLifecycleWitness(observation, () => true)).toBe(false); noRetirement();
  });

  it("does not treat a sealed but still pressured owner as settled merely because no tick was running", async () => {
    await connectWorker(); background.pressure(true); background.quiesceLifecycleMaintenance();
    const observation = await background.settleLifecycleMaintenance(performance.now() + 2000);
    expect(observation).toMatchObject({ workSettled: false, settled: false, checkpoint: { pressurePending: true, pendingOperations: 1 } });
    expect(fixture.metadata).not.toHaveBeenCalled(); background.pressure(false);
    expect(background.lifecycleOwnerManifest()).toMatchObject({ checkpoint: null, workSettled: false }); noRetirement();
  });

  it("metadata failure remains sticky across resume; a successful metadata stage never claims history/project closure", async () => {
    await connectWorker(); fixture.metadata.mockImplementationOnce((owner: Message) => ({ ownerInstance: owner.ownerInstance,
      generation: owner.generation, checkpointed: false, reason: "identity_unknown", handlesRetained: true, ownershipReleased: false }));
    background.quiesceLifecycleMaintenance();
    expect(await background.settleLifecycleMaintenance(performance.now() + 2000)).toMatchObject({ unknown: true, settled: false });
    background.resumeLifecycleMaintenance(); background.quiesceLifecycleMaintenance();
    expect(await background.settleLifecycleMaintenance(performance.now() + 2000)).toMatchObject({ unknown: true, settled: false });
    expect(fixture.metadata).toHaveBeenCalledOnce(); noRetirement();
  });
});
