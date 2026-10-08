import { Worker } from "node:worker_threads";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";
import { BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS } from "./backups.js";
import { retentionLimit } from "./json-store.js";

export interface BackupHealth {
  phase: "scheduled" | "running" | "paused" | "verified" | "failed" | "stopped";
  lastVerifiedAt: number | null;
  lastError: string | null;
}

/** Automatic full backups start only after the broker binds, in an isolated worker. */
export class BackupBackground {
  private worker: Worker | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly pressureState = new SharedArrayBuffer(16);
  private readonly state = new Int32Array(this.pressureState, 0, 2);
  private readonly pauseUntil = new BigInt64Array(this.pressureState, 8, 1);
  private stopped = false;
  private failed = false;
  private lastVerifiedAt: number | null = null;
  private lastError: string | null = null;
  constructor(private readonly home: string, private readonly log: Logger) {
    const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
    if (interval) this.schedule(30_000);
  }
  pressure(pending: boolean, lockError = false): void {
    Atomics.store(this.state, 0, pending ? 1 : 0);
    if (lockError) Atomics.store(this.pauseUntil, 0, BigInt(Date.now() + 5_000));
    Atomics.notify(this.state, 0);
  }
  status(): BackupHealth {
    const paused = !!Atomics.load(this.state, 0) || Date.now() < Number(Atomics.load(this.pauseUntil, 0));
    return { phase: this.stopped ? "stopped" : this.failed ? "failed" : paused ? "paused" : this.worker ? "running" : this.lastVerifiedAt ? "verified" : "scheduled",
      lastVerifiedAt: this.lastVerifiedAt, lastError: this.lastError };
  }
  private schedule(delay: number): void {
    if (this.stopped || this.failed) return;
    this.timer = setTimeout(() => { this.timer = null; this.start(); }, delay);
    this.timer.unref();
  }
  private start(): void {
    if (this.stopped || this.worker || this.failed) return;
    if (Atomics.load(this.state, 0) || Date.now() < Number(Atomics.load(this.pauseUntil, 0))) { this.schedule(30_000); return; }
    let entry = new URL("./backup-worker.mjs", import.meta.url);
    if (import.meta.url.endsWith(".ts")) {
      const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      const path = join(root, ".agent-bridge-test", "backup-worker.mjs");
      const inputs = ["backup-worker.ts", "backups.ts", "storage-lock.ts", "json-store.ts", "sqlite-maintenance.ts"];
      if (!existsSync(path) || inputs.some(name => statSync(join(root, "src/core", name)).mtimeMs > statSync(path).mtimeMs)) {
        mkdirSync(dirname(path), { recursive: true });
        createRequire(import.meta.url)("esbuild").buildSync({ entryPoints: [join(root, "src/core/backup-worker.ts")], outfile: path, bundle: true, platform: "node", format: "esm", target: "node22", external: ["node:*"], logLevel: "silent" });
      }
      entry = pathToFileURL(path);
    }
    const worker = this.worker = new Worker(entry, { workerData: { home: this.home, pressure: this.pressureState }, execArgv: [] });
    worker.on("message", message => {
      if (message.error) {
        this.lastError = String(message.error).includes("sustained broker pressure") ? "broker_pressure" : "backup_failed";
        const pressureOnly = this.lastError === "broker_pressure";
        this.failed = !pressureOnly; // Only pressure interruptions may retry at the next quiet interval.
        if (!this.stopped) this.log.warn("automatic backup deferred; original and partial snapshots preserved", { err: message.error });
      } else if (message.path) {
        this.lastVerifiedAt = Date.now(); this.lastError = null;
        this.log.info("automatic backup verified", { backup: message.path });
      }
    });
    worker.on("error", error => { this.failed = true; this.lastError = "worker_failed"; this.log.warn("automatic backup worker failed", { err: String(error) }); });
    worker.on("exit", () => {
      if (this.worker === worker) this.worker = null;
      const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
      if (interval) this.schedule(Math.min(interval, 60 * 60 * 1_000));
    });
    worker.unref();
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    Atomics.store(this.state, 1, 1); Atomics.notify(this.state, 0); Atomics.notify(this.state, 1);
    const worker = this.worker;
    if (worker) await new Promise<void>(resolve => worker.once("exit", () => resolve()));
  }
}
