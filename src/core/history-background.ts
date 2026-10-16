import { bundleDirectory } from "./bundle-directory.js";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";
import { transcriptPaths } from "./transcripts/common.js";
import type { PeerInfo } from "./protocol.js";
import { historyDbPath, releaseExitedHistoryLease, HISTORY_IO_BYTES_PER_SECOND, type HistoryMigrationProgress } from "./history-store.js";
import { processIdentity } from "./process-identity.js";

type Batch = { work: number; discovering: boolean };
export interface HistoryWorkerCheckpoint {
  ownerInstance: string;
  generation: number;
  requestId: string;
  quiesced: boolean;
  pendingOperations: number;
  retainedPeers: number;
  retainedReset: boolean;
  retainedSchedule: boolean;
  pressureWaiters: number;
  pressurePending: boolean;
  budgetRunning: boolean;
  unknown: boolean;
  producerSettled: boolean;
  reason: "owner_unsupported" | "pending" | "unknown";
  metadata: Readonly<import("./metadata-db.js").MetadataCheckpointObservation> | null;
  handlesRetained: true;
  ownershipReleased: false;
}
export interface HistoryLifecycleObservation {
  ownerInstance: string;
  generation: number;
  quiesced: boolean;
  pendingOperations: number;
  pendingWorkers: number;
  unknown: boolean;
  stopped: boolean;
  settled: boolean;
  workSettled: boolean;
  blocker: "owner_unsupported";
  callbackGeneration: number;
  workerExited: boolean;
  retainedWake: boolean;
  checkpoint: Readonly<HistoryWorkerCheckpoint> | null;
  reason: "owner_unsupported" | "pending" | "unknown" | "not_sealed" | "budget" | "observer_busy";
  handlesRetained: true;
  ownershipReleased: false;
}
type HistoryCapture = {
  worker: Worker;
  revision: number;
  protected: boolean;
  exited: boolean;
  checkpoint: Readonly<HistoryWorkerCheckpoint> | null;
  request: { id: string; generation: number; deadline: number; disposition: "pending" | "completed" | "failed" } | null;
};
/** One elected worker; no source I/O or indexing writes on message dispatch. */
/** At most one message wake per this interval while messages stream in. */
const WAKE_COALESCE_MS = 250;
export class HistoryBackground {
  private progress: HistoryMigrationProgress = { phase: "starting", percent: 0, etaSeconds: null, paused: false, completedRows: 0, totalRows: 0, snapshot: null, ioBytesPerSecond: HISTORY_IO_BYTES_PER_SECOND, error: null };
  private worker!: Worker;
  private stopped = false;
  private exited = false;
  private restart: NodeJS.Timeout | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private wakeAgain = false;
  private id = 0;
  private migrationLease: string | null = null;
  private reconcilingAsks: Promise<Batch> | null = null;
  private reconcilingId: number | null = null;
  private lastPressure: boolean | undefined;
  private readonly lifecycleOwnerInstance = randomUUID();
  private lifecycleGeneration = 0;
  private lifecycleQuiesced = false;
  private lifecycleUnknown = false;
  private lifecycleCapture: HistoryCapture | null = null;
  private readonly lifecycleWitnesses = new WeakMap<HistoryLifecycleObservation, {
    capture: HistoryCapture | null; request: HistoryCapture["request"]; worker: Worker | null; revision: number;
  }>();
  private lifecycleWaiter: { finish: (reason?: HistoryLifecycleObservation["reason"]) => void } | null = null;
  private retainedRestart: (() => void) | null = null;
  private pending = new Map<
    number,
    { resolve: (b: Batch) => void; reject: (e: Error) => void }
  >();
  constructor(file: string, log: Logger) {
    let entry = pathToFileURL(join(bundleDirectory(import.meta.url), "history-worker.mjs"));
    if (import.meta.url.endsWith(".ts")) {
      // Source-mode tests/dev use their own checkout's dependency and ignored output.
      const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      const path = join(process.env.AGENT_BRIDGE_TEST_ROOT ?? join(root, ".agent-bridge-test"), "history-worker.mjs");
      const inputs = [
        "config.ts",
        "history-store.ts",
        "history-migration.ts",
        "history-schema.ts",
        "conversation-schema.ts",
        "history-worker.ts",
        "history.ts",
        "conversations.ts",
        "project-store.ts",
        "ask-completion.ts",
        "history-budget.ts",
        "process-identity.ts",
        "savepoint.ts",
        "store-compatibility.ts",
        "metadata-db.ts",
        "history-sources.ts",
        "byte-source.ts",
      ];
      if (
        !existsSync(path) ||
        inputs.some(
          (name) =>
            statSync(join(root, "src/core", name)).mtimeMs >
            statSync(path).mtimeMs,
        )
      ) {
        mkdirSync(dirname(path), { recursive: true });
        createRequire(import.meta.url)("esbuild").buildSync({
          entryPoints: [join(root, "src/core/history-worker.ts")],
          outfile: path,
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node22",
          external: ["node:*"],
          logLevel: "silent",
        });
      }
      entry = pathToFileURL(path);
    }
    const start = () => {
      if (this.lifecycleQuiesced) { this.retainedRestart = start; return; }
      this.restart = null;
      this.lastPressure = undefined;
      this.exited = false;
      // Threads share the parent's PID, but not its module cache. Reuse the
      // verified birth identity rather than cold-probing PowerShell in migrationLock.
      const identity = processIdentity(process.pid);
      this.worker = new Worker(entry, {
        workerData: { file: historyDbPath(file), bridge: file, home: dirname(file), paths: transcriptPaths(), lifecycleOwnerInstance: this.lifecycleOwnerInstance,
          ...(identity ? { ownProcessIdentity: { pid: process.pid, identity } } : {}) },
        execArgv: [],
      });
      const worker = this.worker;
      const capture: HistoryCapture = { worker, revision: 0, protected: false, exited: false, checkpoint: null, request: null };
      this.lifecycleCapture = capture;
      worker.on("message", (message) => {
        if (this.lifecycleCapture !== capture || this.worker !== worker) { this.lifecycleUnknown = true; this.lifecycleWaiter?.finish("unknown"); return; }
        if (message.historyTiming) { log.debug("history worker phase timings", message.historyTiming); return; }
        if (message.historyCheckpoint) {
          capture.revision++;
          this.acceptLifecycleCheckpoint(capture, message.historyCheckpoint);
          return;
        }
        capture.revision++;
        capture.checkpoint = null;
        if (message.migrationProgress) { this.progress = message.migrationProgress; return; }
        if ("migrationLease" in message) { this.migrationLease = message.migrationLease; return; }
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending && capture.protected) { this.lifecycleUnknown = true; this.lifecycleWaiter?.finish("unknown"); return; }
          this.pending.delete(message.id);
          capture.checkpoint = null;
          if (message.error) pending?.reject(new Error(message.error));
          else pending?.resolve(message.result);
        } else if (message.error) {
          if (this.lifecycleQuiesced) { this.lifecycleUnknown = true; this.lifecycleWaiter?.finish("unknown"); }
          log.warn("history background batch deferred", { err: message.error });
        }
      });
      worker.on("error", (err) => {
        if (this.lifecycleCapture !== capture || this.worker !== worker) return;
        log.warn("history worker failed", { err: String(err) });
        capture.revision++;
        this.lifecycleUnknown = true;
        capture.checkpoint = null;
        this.lifecycleWaiter?.finish("unknown");
        if (capture.protected) return; // Accepted waiters/bytes stay owned, never rejected to pass drain.
        for (const p of this.pending.values())
          p.reject(err instanceof Error ? err : new Error(String(err)));
        this.pending.clear();
      });
      worker.on("exit", (code) => {
        if (this.lifecycleCapture !== capture || this.worker !== worker) return;
        capture.revision++;
        capture.exited = true;
        this.exited = true;
        if (capture.protected && !this.stopped) {
          // This persistent worker has no supported natural checkpoint-and-exit protocol.
          // Exact exit alone cannot certify its stores or release its migration ownership.
          this.lifecycleUnknown = true;
          capture.checkpoint = null;
          this.lifecycleWaiter?.finish("unknown");
          this.retainedRestart = start;
          return;
        }
        if (this.migrationLease) {
          try { releaseExitedHistoryLease(file,this.migrationLease); }
          catch (err) { log.warn("history worker lease cleanup deferred",{err:String(err)}); }
          this.migrationLease = null;
        }
        for (const p of this.pending.values())
          p.reject(new Error(`History worker exited (${code})`));
        this.pending.clear();
        if (!this.stopped) {
          this.retainedRestart = start;
          log.warn("history worker restarting", { code });
          this.restart = setTimeout(start, 2000);
          this.restart.unref();
        }
      });
      worker.unref();
    };
    start();
  }
  status(): HistoryMigrationProgress { return { ...this.progress }; }
  pressure(pending: boolean, lockError = false): void {
    // A pressure-clear continuation belongs to an already accepted write. Let it
    // release the worker's original waiter while refusing new pressure producers.
    if (this.lifecycleQuiesced && (pending || lockError)) return;
    if (!this.stopped && !this.exited && (this.lastPressure !== pending || lockError)) {
      if (this.lifecycleCapture) { this.lifecycleCapture.revision++; this.lifecycleCapture.checkpoint = null; }
      this.lastPressure = pending;
      if (this.lifecycleQuiesced) this.postLifecycle({ pressure: true, pending, lockError });
      else this.worker.postMessage({ pressure: true, pending, lockError });
    }
  }
  /**
   * New bridge messages wake a backed-off worker (AB-147 backs idle sweeps off to 30 s), so a
   * just-sent message is searchable promptly. Event driven, so an idle bridge still does nothing.
   * The post waits for the current turn (the sending transaction commits first), and a stream of
   * messages yields at most one wake per WAKE_COALESCE_MS.
   */
  messageArrived(): void {
    if (this.lifecycleQuiesced) return;
    if (this.stopped || this.exited) return;
    if (this.wakeTimer) { this.wakeAgain = true; return; }
    this.wakeTimer = setTimeout(() => {
      if (!this.stopped && !this.exited) this.worker.postMessage({ wake: true });
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = null;
        if (this.wakeAgain) { this.wakeAgain = false; this.messageArrived(); }
      }, WAKE_COALESCE_MS);
      this.wakeTimer.unref();
    }, 0);
    this.wakeTimer.unref();
  }
  rememberPeer(peer: PeerInfo): void {
    if (this.lifecycleQuiesced) return;
    if (!this.stopped && !this.exited) this.worker.postMessage({ peer });
  }
  tick(reset = false): Promise<Batch> {
    if (this.lifecycleQuiesced) return Promise.reject(new Error("History lifecycle admission sealed; retry after resume"));
    if (this.stopped || this.exited)
      return Promise.reject(
        new Error("History worker unavailable; backfill will resume"),
      );
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, reset });
    });
  }
  reconcileAsks(): Promise<Batch> {
    if (this.reconcilingAsks) return this.reconcilingAsks;
    if (this.lifecycleQuiesced) return Promise.reject(new Error("History lifecycle admission sealed; retry after resume"));
    if (this.stopped || this.exited) return Promise.reject(new Error("Job reconciliation worker unavailable; retry later"));
    this.reconcilingAsks = new Promise<Batch>((resolve, reject) => {
      const id = ++this.id;
      this.reconcilingId = id;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, reconcileAsks: true });
    }).finally(() => { this.reconcilingAsks = null; this.reconcilingId = null; });
    return this.reconcilingAsks;
  }
  /** Trusted local adapter; never accept a caller-supplied worker/owner/checkpoint. */
  quiesceLifecycleMaintenance(): void {
    if (this.lifecycleQuiesced) return;
    this.lifecycleQuiesced = true;
    this.advanceLifecycleGeneration();
    if (this.restart) clearTimeout(this.restart);
    this.restart = null;
    if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeAgain = true; }
    this.wakeTimer = null;
    const capture = this.lifecycleCapture;
    if (capture) {
      capture.protected = true;
      capture.checkpoint = null;
      capture.request = null;
      if (!capture.exited) this.postLifecycle({ historyLifecycle: "quiesce", ownerInstance: this.lifecycleOwnerInstance, generation: this.lifecycleGeneration });
    }
  }
  /** Pre-release abort only: keep the exact active worker, queued bytes and original cursors. */
  resumeLifecycleMaintenance(): void {
    if (!this.lifecycleQuiesced) return;
    this.lifecycleQuiesced = false;
    this.advanceLifecycleGeneration();
    this.lifecycleWaiter?.finish("not_sealed");
    const capture = this.lifecycleCapture;
    if (capture) {
      capture.checkpoint = null;
      capture.request = null;
      if (!capture.exited) this.postLifecycle({ historyLifecycle: "resume", ownerInstance: this.lifecycleOwnerInstance, generation: this.lifecycleGeneration });
    }
    if (this.wakeAgain && !this.exited && !this.stopped) { this.wakeAgain = false; this.messageArrived(); }
    if (this.exited && !this.stopped && !this.pending.size && !this.lifecycleUnknown) this.retainedRestart?.();
  }
  private advanceLifecycleGeneration(): void {
    if (this.lifecycleGeneration >= Number.MAX_SAFE_INTEGER) this.lifecycleUnknown = true;
    else this.lifecycleGeneration++;
  }
  private postLifecycle(message: object): void {
    try { this.worker.postMessage(message); }
    catch { this.lifecycleUnknown = true; this.lifecycleWaiter?.finish("unknown"); }
  }
  lifecycleOwnerManifest(reason?: HistoryLifecycleObservation["reason"]): HistoryLifecycleObservation {
    const capture = this.lifecycleCapture, checkpoint = capture?.checkpoint ?? null;
    const unknown = this.lifecycleUnknown || Boolean(checkpoint?.unknown);
    const state = Object.freeze({ ownerInstance: this.lifecycleOwnerInstance, generation: this.lifecycleGeneration,
      quiesced: this.lifecycleQuiesced, pendingOperations: this.pending.size +
        Number(this.reconcilingAsks !== null && this.reconcilingId !== null && !this.pending.has(this.reconcilingId)) + (checkpoint?.pendingOperations ?? 0),
      pendingWorkers: capture && !capture.exited ? 1 : 0, unknown, stopped: this.stopped,
      // History/project store closure is unsupported in the read-only dependency API.
      settled: false, workSettled: Boolean(this.lifecycleQuiesced && !unknown && !this.stopped && !this.pending.size && !this.reconcilingAsks && checkpoint?.producerSettled),
      blocker: "owner_unsupported" as const, callbackGeneration: capture?.revision ?? 0,
      workerExited: capture?.exited ?? false, retainedWake: this.wakeAgain, checkpoint,
      reason: reason ?? (unknown ? "unknown" : !this.lifecycleQuiesced ? "not_sealed" : checkpoint?.reason ?? "pending"),
      handlesRetained: true as const, ownershipReleased: false as const });
    this.lifecycleWitnesses.set(state, { capture, request: capture?.request ?? null, worker: capture?.worker ?? null, revision: capture?.revision ?? 0 });
    return state;
  }
  /** Full source-owned manifest is checked immediately, including nested checkpoint identity. */
  isCurrentLifecycleWitness(witness: HistoryLifecycleObservation, isAdmissionSealed: () => boolean): boolean {
    if (!this.lifecycleWitnesses.has(witness) || !witness.settled) return false;
    try {
      const capture = this.lifecycleCapture;
      const owned = this.lifecycleWitnesses.get(witness)!;
      if (isAdmissionSealed() !== true || owned.capture !== capture || owned.request !== (capture?.request ?? null) ||
          owned.worker !== (capture?.worker ?? null) || owned.revision !== (capture?.revision ?? 0)) return false;
      const current = this.lifecycleOwnerManifest();
      return current.settled && witness.checkpoint === current.checkpoint && JSON.stringify(witness) === JSON.stringify(current) &&
        isAdmissionSealed() === true && this.lifecycleCapture === capture;
    } catch { return false; }
  }
  private acceptLifecycleCheckpoint(capture: HistoryCapture, value: HistoryWorkerCheckpoint): void {
    const request = capture.request;
    // A resumed owner's old ACK is expected but cannot certify the new generation.
    if (!request || !this.lifecycleQuiesced) return;
    if (request.disposition !== "pending" || this.lifecycleUnknown || capture.checkpoint || !value || value.ownerInstance !== this.lifecycleOwnerInstance || value.generation !== request.generation || value.requestId !== request.id ||
        request.generation !== this.lifecycleGeneration || capture.exited || performance.now() >= request.deadline ||
        value.quiesced !== true || value.handlesRetained !== true || value.ownershipReleased !== false ||
        !Number.isSafeInteger(value.pendingOperations) || value.pendingOperations < 0 ||
        !Number.isSafeInteger(value.retainedPeers) || value.retainedPeers < 0 ||
        !Number.isSafeInteger(value.pressureWaiters) || value.pressureWaiters < 0 ||
        typeof value.retainedReset !== "boolean" || typeof value.retainedSchedule !== "boolean" || typeof value.budgetRunning !== "boolean" || typeof value.pressurePending !== "boolean" ||
        typeof value.unknown !== "boolean" || typeof value.producerSettled !== "boolean" ||
        !["owner_unsupported", "pending", "unknown"].includes(value.reason) ||
        value.producerSettled && (value.pendingOperations !== 0 || value.budgetRunning || value.pressureWaiters !== 0 || value.pressurePending || value.unknown)) {
      this.lifecycleUnknown = true; capture.checkpoint = null; this.lifecycleWaiter?.finish("unknown"); return;
    }
    if (value.metadata && (value.metadata.ownerInstance !== value.ownerInstance || value.metadata.generation !== value.generation ||
        value.metadata.handlesRetained !== true || value.metadata.ownershipReleased !== false)) {
      this.lifecycleUnknown = true; this.lifecycleWaiter?.finish("unknown"); return;
    }
    capture.checkpoint = Object.freeze({ ...value, metadata: value.metadata ? Object.freeze({ ...value.metadata }) : null });
    if (value.unknown) this.lifecycleUnknown = true;
    this.lifecycleWaiter?.finish();
  }
  /** One observer, one absolute monotonic phase deadline, no stop/terminate/close path.
   * Timeout retains the capture/request, so an expired ACK cannot qualify later.
   * No store fsync, directory durability, native handle binding or ownership release is claimed. */
  settleLifecycleMaintenance(deadline: number): Promise<HistoryLifecycleObservation> {
    const remaining = deadline - performance.now();
    if (!Number.isFinite(deadline) || remaining <= 0) return Promise.resolve(this.lifecycleOwnerManifest("budget"));
    if (this.lifecycleWaiter) return Promise.resolve(this.lifecycleOwnerManifest("observer_busy"));
    const capture = this.lifecycleCapture;
    if (!this.lifecycleQuiesced || this.stopped || this.lifecycleUnknown || !capture || capture.exited) return Promise.resolve(this.lifecycleOwnerManifest());
    // Reobservation never gives an active/expired request a fresh nested allowance.
    if (capture.request) return Promise.resolve(this.lifecycleOwnerManifest(capture.checkpoint ? undefined : "budget"));
    const request: NonNullable<HistoryCapture["request"]> = { id: randomUUID(), generation: this.lifecycleGeneration, deadline, disposition: "pending" };
    capture.request = request;
    return new Promise(resolve => {
      const finish = (reason?: HistoryLifecycleObservation["reason"]) => {
        if (this.lifecycleWaiter !== waiter) return;
        if (capture.request === request && request.disposition === "pending") {
          request.disposition = reason !== undefined || this.lifecycleUnknown || performance.now() >= deadline || !capture.checkpoint ? "failed" : "completed";
          capture.revision++;
        }
        clearTimeout(timer); this.lifecycleWaiter = null;
        resolve(this.lifecycleOwnerManifest(performance.now() >= deadline ? "budget" : reason));
      };
      const waiter = { finish };
      const timer = setTimeout(() => finish("budget"), remaining);
      this.lifecycleWaiter = waiter;
      this.postLifecycle({ historyLifecycle: "checkpoint", ownerInstance: this.lifecycleOwnerInstance, ...request, requestId: request.id });
    });
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.advanceLifecycleGeneration();
    this.lifecycleWaiter?.finish("unknown");
    if (this.restart) clearTimeout(this.restart);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    for (const p of this.pending.values())
      p.reject(new Error("History worker closed"));
    this.pending.clear();
    if (this.exited) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void this.worker.terminate().then(() => resolve());
      }, 2000);
      this.worker.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.worker.postMessage({ stop: true });
    });
  }
}
