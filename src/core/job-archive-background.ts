import { Worker } from "node:worker_threads";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";
import { bundleDirectory } from "./bundle-directory.js";
import { atomicPluginWrite } from "./plugin-runtime.js";
import { randomUUID } from "node:crypto";

export interface ArchiveLifecycleObservation {
  ownerInstance: string; generation: number; quiesced: boolean; pendingWorkers: number;
  pendingOperations: number; queuedRepack: boolean; unknown: boolean; closed: boolean; settled: boolean;
  /** This additive producer observation does not release/checkpoint store ownership. */
  ownershipReleased: false;
}

/** One resumable migration per broker election, independent of history.ingest.
 * The same worker then packs archived finished runs (AB-208); repack() repeats only that, off the broker thread. */
export class JobArchiveBackground {
  private worker: Worker;
  finished: Promise<void>;
  private running = true;
  private closed = false;
  private readonly entry: URL;
  private readonly lifecycleOwner = randomUUID();
  private lifecycleGeneration = 0;
  private lifecycleQuiesced = false;
  private lifecycleUnknown = false;
  private lifecycleRequest: string | null = null;
  private lifecycleQueuedRepack = false;
  private lifecycleRevision = 0;
  private lifecyclePending = 1;
  private lifecycleAck = false;
  private lifecycleExitedClean = false;
  private lifecycleWaiter: { finish: (observed: boolean) => void } | null = null;
  private readonly lifecycleWitnesses = new WeakMap<ArchiveLifecycleObservation, Worker>();
  constructor(private readonly path: string, private readonly log: Logger) {
    // Shared chunks live in dist/chunks; the worker entry sits beside the bundle entrypoints.
    let entry = pathToFileURL(join(bundleDirectory(import.meta.url), "job-archive-worker.mjs"));
    if (import.meta.url.endsWith(".ts")) {
      const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      const output = join(root, ".agent-bridge-test", "job-archive-worker.mjs");
      const inputs = ["job-archive-worker.ts", "job-archive-index.ts", "job-archive-migration.ts", "archive-bundle.ts", "store-compatibility.ts", "sqlite-migrations.ts",
        "finished-run-bundles.ts", "metadata-import.ts", "metadata-db.ts", "run-archive.ts", "run-log-preview.ts", "runner-store.ts", "json-store.ts", "job-run-index.ts", "run-history.ts"];
      if (!existsSync(output) || inputs.some(name => statSync(join(root, "src/core", name)).mtimeMs > statSync(output).mtimeMs)) {
        mkdirSync(dirname(output), { recursive: true });
        const built = createRequire(import.meta.url)("esbuild").buildSync({ entryPoints: [join(root, "src/core/job-archive-worker.ts")], outfile: output,
          bundle: true, write: false, platform: "node", format: "esm", target: "node22", external: ["node:*"], logLevel: "silent" });
        // Parallel test workers rebuild the same file; Windows refuses to replace one that another worker is running.
        try { atomicPluginWrite(output, built.outputFiles[0].contents); }
        catch (err) { if (!["EPERM", "EBUSY", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "") || !existsSync(output)) throw err; }
      }
      entry = pathToFileURL(output);
    }
    this.entry = entry;
    [this.worker, this.finished] = this.start(false);
  }
  private start(packOnly: boolean): [Worker, Promise<void>] {
    const worker = new Worker(this.entry, { workerData: { path: this.path, packOnly, lifecycleOwner: this.lifecycleOwner }, execArgv: [] });
    this.running = true;
    this.lifecyclePending = 1; this.lifecycleRevision = 0; this.lifecycleAck = false; this.lifecycleExitedClean = false; this.changeLifecycleGeneration();
    const finished = new Promise<void>(resolve => {
      worker.on("message", message => {
        if (this.worker !== worker) return;
        if (message.archiveLifecycle) {
          const state = message.archiveLifecycle;
          if (state.ownerInstance !== this.lifecycleOwner || !Number.isSafeInteger(state.revision) || state.revision <= this.lifecycleRevision ||
            typeof state.quiesced !== "boolean" || typeof state.unknown !== "boolean" || typeof state.settled !== "boolean" ||
            ![0, 1].includes(state.pendingOperations) || state.requestId !== null && typeof state.requestId !== "string") {
            this.lifecycleUnknown = true; this.changeLifecycleGeneration(); return;
          }
          this.lifecycleRevision = state.revision; this.lifecyclePending = state.pendingOperations;
          this.lifecycleUnknown ||= state.unknown;
          this.lifecycleAck = this.lifecycleQuiesced && state.requestId === this.lifecycleRequest && state.quiesced && state.settled && state.pendingOperations === 0 && !state.unknown;
          this.changeLifecycleGeneration(); if (this.lifecycleAck) this.lifecycleWaiter?.finish(true);
          return;
        }
        if (message.runnerImportError || message.error || message.warning || message.packError) { this.lifecycleUnknown = true; this.changeLifecycleGeneration(); }
        if (message.runnerImport) this.log.info("runner file import", message.runnerImport);
        else if (message.runnerImportError) this.log.warn("runner file import deferred; files retained", { error: message.runnerImportError });
        else if (message.error) this.log.warn("job archive migration deferred; originals retained", { error: message.error });
        else if (message.result) this.log.info("job archive migration", message.result);
        else if (message.warning) this.log.warn(message.warning, message.failure);
        else if (message.packError) this.log.warn("archived run packing deferred; runs stay readable in place", { error: message.packError });
        else if (message.packed) this.log.info("archived runs packed", message.packed);
      });
      worker.on("error", error => { if (this.worker === worker) { this.lifecycleUnknown = true; this.changeLifecycleGeneration(); } this.log.warn("job archive worker failed; migration resumes next election", { error: String(error) }); });
      worker.once("exit", code => {
        if (this.worker === worker) {
          this.running = false; this.lifecycleExitedClean = code === 0 && this.lifecycleRevision > 0 && this.lifecyclePending === 0 && !this.lifecycleUnknown;
          if (!this.lifecycleExitedClean) this.lifecycleUnknown = true;
          this.changeLifecycleGeneration(); this.lifecycleWaiter?.finish(this.lifecycleExitedClean);
        }
        resolve();
      });
    });
    worker.unref();
    return [worker, finished];
  }
  /** Pack runs archived since the last pass. A pass still running is left alone. */
  repack(): void {
    if (this.closed) return;
    if (this.lifecycleQuiesced) { this.lifecycleQueuedRepack = true; this.changeLifecycleGeneration(); return; }
    this.lifecycleAck = false; this.lifecyclePending = 1; this.changeLifecycleGeneration();
    // A live worker (it keeps importing runner files) packs on request between its batches.
    if (this.running) { try { this.worker.postMessage({ repack: true }); } catch { /* exiting */ } return; }
    [this.worker, this.finished] = this.start(true);
  }
  private changeLifecycleGeneration(): void {
    if (this.lifecycleGeneration >= Number.MAX_SAFE_INTEGER) this.lifecycleUnknown = true;
    else this.lifecycleGeneration++;
  }
  quiesceLifecycleMaintenance(): void {
    if (this.lifecycleQuiesced || this.closed) return;
    this.lifecycleQuiesced = true; this.lifecycleRequest = randomUUID(); this.lifecycleAck = false; this.changeLifecycleGeneration();
    if (this.running) {
      try { this.worker.postMessage({ archiveLifecycle: { kind: "quiesce", ownerInstance: this.lifecycleOwner, requestId: this.lifecycleRequest } }); }
      catch { this.lifecycleUnknown = true; this.changeLifecycleGeneration(); }
    }
  }
  /** Undo only the seal; accepted work and the same live worker are retained. */
  resumeLifecycleMaintenance(): void {
    if (!this.lifecycleQuiesced || this.closed) return;
    const requestId = this.lifecycleRequest;
    this.lifecycleQuiesced = false; this.lifecycleRequest = null; this.lifecycleAck = false; this.changeLifecycleGeneration(); this.lifecycleWaiter?.finish(false);
    if (this.running) {
      try { this.worker.postMessage({ archiveLifecycle: { kind: "resume", ownerInstance: this.lifecycleOwner, requestId } }); }
      catch { this.lifecycleUnknown = true; this.changeLifecycleGeneration(); }
    }
    if (this.lifecycleQueuedRepack) { this.lifecycleQueuedRepack = false; this.repack(); }
  }
  lifecycleOwnerManifest(): ArchiveLifecycleObservation {
    const state = Object.freeze({ ownerInstance: this.lifecycleOwner, generation: this.lifecycleGeneration, quiesced: this.lifecycleQuiesced,
      pendingWorkers: this.running ? 1 : 0, pendingOperations: this.lifecyclePending, queuedRepack: this.lifecycleQueuedRepack, unknown: this.lifecycleUnknown, closed: this.closed,
      settled: this.lifecycleQuiesced && !this.closed && !this.lifecycleUnknown && !this.lifecycleQueuedRepack && this.lifecyclePending === 0 && (this.running ? this.lifecycleAck : this.lifecycleExitedClean), ownershipReleased: false as const });
    this.lifecycleWitnesses.set(state, this.worker); return state;
  }
  isCurrentLifecycleWitness(witness: ArchiveLifecycleObservation, isAdmissionSealed: () => boolean): boolean {
    if (!this.lifecycleWitnesses.has(witness) || !witness.settled) return false;
    try {
      if (isAdmissionSealed() !== true || this.lifecycleWitnesses.get(witness) !== this.worker) return false;
      const current = this.lifecycleOwnerManifest();
      return current.settled && Object.keys(current).every(key => current[key as keyof ArchiveLifecycleObservation] === witness[key as keyof ArchiveLifecycleObservation]);
    } catch { return false; }
  }
  /** One bounded observer; timeout does not cancel, close or prove checkpoint/exit. */
  settleLifecycleMaintenance(deadline: number): Promise<ArchiveLifecycleObservation> {
    const state = this.lifecycleOwnerManifest(), remaining = deadline - performance.now();
    if (!Number.isFinite(deadline) || remaining <= 0 || !state.quiesced || state.unknown || state.closed || this.lifecycleWaiter) return Promise.resolve({ ...state, settled: false });
    if (state.settled) return Promise.resolve(state);
    const worker = this.worker;
    return new Promise(resolve => {
      const finish = (observed: boolean) => {
        if (this.lifecycleWaiter !== waiter) return;
        clearTimeout(timer); this.lifecycleWaiter = null;
        const current = this.lifecycleOwnerManifest();
        resolve(observed && performance.now() <= deadline && this.worker === worker && current.settled ? current : { ...current, settled: false });
      };
      const waiter = { finish }, timer = setTimeout(() => finish(false), remaining);
      this.lifecycleWaiter = waiter;
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.changeLifecycleGeneration(); this.lifecycleWaiter?.finish(false);
    // Packing and the runner import stop between bounded batches; let the worker release its migration lease.
    // Termination while its process remains alive would strand that lease and obstruct a same-process election.
    if (this.running) this.worker.postMessage({ stop: true });
    await this.finished;
  }
}
