import { bundleDirectory } from "./bundle-directory.js";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";
import { BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS } from "./backups.js";
import { retentionLimit } from "./json-store.js";
import { AUTO_BACKUP_ENV } from "./message-backups.js";

export interface BackupHealth {
  phase: "disabled" | "scheduled" | "running" | "paused" | "verified" | "failed" | "stopped";
  lastVerifiedAt: number | null;
  lastError: string | null;
}

export interface BackupLifecycleObservation {
  ownerInstance: string;
  quiesced: boolean;
  generation: number;
  pendingWorkers: number;
  unknown: boolean;
  settled: boolean;
  stopped: boolean;
}

/** Opt-in message-table backups start after bind in a separate low-priority process. */
export class BackupBackground {
  private worker: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pending = false;
  private pauseUntil = 0;
  private stopped = false;
  private failed = false;
  private readonly enabled = process.env[AUTO_BACKUP_ENV] === "1" && retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS) > 0;
  private lastVerifiedAt: number | null = null;
  private lastError: string | null = null;
  private lifecycleQuiesced = false;
  private readonly lifecycleOwnerInstance = randomUUID();
  private lifecycleUnknown = false;
  private lifecycleGeneration = 0;
  private timerDueAt: number | null = null;
  private resumeDueAt: number | null = null;
  private lifecycleWaiter: { finish: (settled: boolean) => void } | null = null;
  private lifecycleCapture: ChildProcess | null = null;
  private readonly lifecycleWitnesses = new WeakMap<BackupLifecycleObservation, ChildProcess | null>();
  constructor(private readonly home: string, private readonly log: Logger) {
    if (this.enabled) this.schedule(30_000);
  }
  pressure(pending: boolean, lockError = false): void {
    const changed = this.pending !== pending || lockError;
    this.pending = pending;
    if (lockError) this.pauseUntil = Date.now() + 5_000;
    if (changed && this.worker?.connected) this.worker.send({ type: "pressure", pending, pauseUntil: this.pauseUntil }, () => {});
  }
  status(): BackupHealth {
    const paused = this.pending || Date.now() < this.pauseUntil;
    return { phase: !this.enabled ? "disabled" : this.stopped ? "stopped" : this.failed ? "failed" : paused ? "paused" : this.worker ? "running" : this.lastVerifiedAt ? "verified" : "scheduled",
      lastVerifiedAt: this.lastVerifiedAt, lastError: this.lastError };
  }
  private schedule(delay: number, dueAt = Date.now() + delay): void {
    if (!this.enabled || this.stopped || this.failed) return;
    if (this.lifecycleQuiesced) { this.resumeDueAt = Date.now() + delay; return; }
    this.timerDueAt = dueAt;
    this.timer = setTimeout(() => { this.timer = null; this.timerDueAt = null; this.start(); }, delay);
    this.timer.unref();
  }
  private start(): void {
    if (!this.enabled || this.stopped || this.worker || this.failed || this.lifecycleQuiesced) return;
    if (this.pending || Date.now() < this.pauseUntil) { this.schedule(30_000); return; }
    let entry = pathToFileURL(join(bundleDirectory(import.meta.url), "backup-worker.mjs"));
    if (import.meta.url.endsWith(".ts")) {
      const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      const path = join(process.env.AGENT_BRIDGE_TEST_ROOT ?? join(root, ".agent-bridge-test"), "backup-worker.mjs");
      const inputs = ["backup-worker.ts", "message-backups.ts", "backups.ts", "storage-lock.ts", "json-store.ts"];
      if (!existsSync(path) || inputs.some(name => statSync(join(root, "src/core", name)).mtimeMs > statSync(path).mtimeMs)) {
        mkdirSync(dirname(path), { recursive: true });
        createRequire(import.meta.url)("esbuild").buildSync({ entryPoints: [join(root, "src/core/backup-worker.ts")], outfile: path, bundle: true, platform: "node", format: "esm", target: "node22", external: ["node:*"], logLevel: "silent" });
      }
      entry = pathToFileURL(path);
    }
    const worker = this.worker = fork(fileURLToPath(entry), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], windowsHide: true });
    this.lifecycleCapture = worker;
    this.advanceLifecycleGeneration();
    let completed = false;
    worker.on("message", (message: any) => {
      if (this.lifecycleCapture !== worker) return;
      if (message.error) {
        this.lifecycleUnknown = true;
        this.advanceLifecycleGeneration();
        this.lastError = String(message.error).includes("sustained broker pressure") ? "broker_pressure" : "backup_failed";
        const pressureOnly = this.lastError === "broker_pressure";
        this.failed = !pressureOnly; // Only pressure interruptions may retry at the next quiet interval.
        if (!this.stopped) this.log.warn("automatic backup deferred; original and partial snapshots preserved", { err: message.error });
      } else if (message.path) {
        completed = typeof message.path === "string";
        this.lastVerifiedAt = Date.now(); this.lastError = null;
        this.log.info("automatic backup verified", { backup: message.path });
      } else if (message.path === null && message.skipped === "not-due") {
        completed = true;
      } else {
        // An external lock holder or an unrecognized outcome is not owned settlement proof.
        this.lifecycleUnknown = true;
        this.advanceLifecycleGeneration();
      }
    });
    worker.on("error", error => { if (this.lifecycleCapture !== worker) return; this.lifecycleUnknown = true; this.advanceLifecycleGeneration(); this.failed = true; this.lastError = "worker_failed"; this.log.warn("automatic backup process failed", { err: String(error) }); });
    worker.on("exit", (code, signal) => {
      if (this.lifecycleCapture !== worker) return;
      if (this.worker !== worker) { this.lifecycleUnknown = true; this.advanceLifecycleGeneration(); this.lifecycleWaiter?.finish(false); return; }
      if (code !== 0 || signal || !completed) this.lifecycleUnknown = true;
      this.advanceLifecycleGeneration();
      if (!this.stopped && (code !== 0 || signal)) { this.failed = true; this.lastError = "worker_failed"; }
      if (this.worker === worker) this.worker = null;
      const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
      if (interval) this.schedule(Math.min(interval, 60 * 60 * 1_000));
      this.lifecycleWaiter?.finish(true);
    });
    worker.send({ type: "pressure", pending: this.pending, pauseUntil: this.pauseUntil }, () => {});
    worker.send({ type: "start", home: this.home }, () => {});
    worker.unref();
  }
  /** Inhibit future captures only. An accepted capture is never stopped or rejected here. */
  quiesceLifecycleMaintenance(): void {
    if (this.lifecycleQuiesced) return;
    this.lifecycleQuiesced = true; this.advanceLifecycleGeneration();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.resumeDueAt = this.timerDueAt; this.timerDueAt = null;
  }
  /** Pre-release abort restores the retained schedule; it never creates a second active worker. */
  resumeLifecycleMaintenance(): void {
    if (!this.lifecycleQuiesced) return;
    this.lifecycleQuiesced = false; this.advanceLifecycleGeneration();
    this.lifecycleWaiter?.finish(false);
    const due = this.resumeDueAt; this.resumeDueAt = null;
    if (due !== null && !this.worker) this.schedule(Math.max(0, due - Date.now()), due);
  }
  private advanceLifecycleGeneration(): void {
    if (!Number.isSafeInteger(this.lifecycleGeneration) || this.lifecycleGeneration >= Number.MAX_SAFE_INTEGER) this.lifecycleUnknown = true;
    else this.lifecycleGeneration++;
  }
  lifecycleOwnerManifest(): BackupLifecycleObservation {
    const state = Object.freeze({ ownerInstance: this.lifecycleOwnerInstance, quiesced: this.lifecycleQuiesced, generation: this.lifecycleGeneration, pendingWorkers: this.worker ? 1 : 0,
      unknown: this.lifecycleUnknown, stopped: this.stopped, settled: this.lifecycleQuiesced && !this.worker && !this.lifecycleUnknown && !this.stopped });
    this.lifecycleWitnesses.set(state, this.lifecycleCapture); return state;
  }
  /** Source-owned complete witness, rechecked immediately under the coordinator's producer seal.
   * A serialized/caller-forged snapshot, changed capture, close, error or resumed owner cannot qualify. */
  isCurrentLifecycleWitness(witness: BackupLifecycleObservation, isAdmissionSealed: () => boolean): boolean {
    if (!this.lifecycleWitnesses.has(witness) || !witness.settled) return false;
    try {
      if (isAdmissionSealed() !== true || this.lifecycleWitnesses.get(witness) !== this.lifecycleCapture) return false;
      const current = this.lifecycleOwnerManifest();
      return current.settled && witness.ownerInstance === current.ownerInstance && witness.generation === current.generation &&
        witness.quiesced === current.quiesced && witness.pendingWorkers === current.pendingWorkers && witness.unknown === current.unknown && witness.stopped === current.stopped;
    } catch { return false; }
  }
  /** One bounded observer. Timeout leaves the actual worker/capture and retained bytes untouched.
   * Actual successful backup outcome plus process exit proves this owner's settlement only;
   * it does not certify directory publication, other stores, or the core release witness. */
  settleLifecycleMaintenance(deadline: number): Promise<BackupLifecycleObservation> {
    const state = this.lifecycleOwnerManifest();
    const remaining = deadline - performance.now();
    if (!Number.isFinite(deadline) || remaining <= 0 || !state.quiesced || state.unknown || this.stopped || this.lifecycleWaiter) {
      return Promise.resolve({ ...state, settled: false });
    }
    if (!this.worker) return Promise.resolve(state);
    const capture = this.worker;
    return new Promise(resolve => {
      const finish = (settled: boolean) => {
        if (this.lifecycleWaiter !== waiter) return;
        clearTimeout(timer); this.lifecycleWaiter = null;
        const current = this.lifecycleOwnerManifest();
        resolve(settled && performance.now() <= deadline && current.settled && this.lifecycleCapture === capture ? current : { ...current, settled: false });
      };
      const waiter = { finish };
      const timer = setTimeout(() => finish(false), remaining);
      this.lifecycleWaiter = waiter;
    });
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.advanceLifecycleGeneration();
    this.lifecycleWaiter?.finish(false);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const worker = this.worker;
    if (worker?.connected) worker.send({ type: "stop" }, () => {});
    if (worker) await new Promise<void>(resolve => worker.once("exit", () => resolve()));
  }
}
