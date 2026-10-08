import { fork, type ChildProcess } from "node:child_process";
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
  private schedule(delay: number): void {
    if (!this.enabled || this.stopped || this.failed) return;
    this.timer = setTimeout(() => { this.timer = null; this.start(); }, delay);
    this.timer.unref();
  }
  private start(): void {
    if (!this.enabled || this.stopped || this.worker || this.failed) return;
    if (this.pending || Date.now() < this.pauseUntil) { this.schedule(30_000); return; }
    let entry = new URL("./backup-worker.mjs", import.meta.url);
    if (import.meta.url.endsWith(".ts")) {
      const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      const path = join(root, ".agent-bridge-test", "backup-worker.mjs");
      const inputs = ["backup-worker.ts", "message-backups.ts", "backups.ts", "storage-lock.ts", "json-store.ts"];
      if (!existsSync(path) || inputs.some(name => statSync(join(root, "src/core", name)).mtimeMs > statSync(path).mtimeMs)) {
        mkdirSync(dirname(path), { recursive: true });
        createRequire(import.meta.url)("esbuild").buildSync({ entryPoints: [join(root, "src/core/backup-worker.ts")], outfile: path, bundle: true, platform: "node", format: "esm", target: "node22", external: ["node:*"], logLevel: "silent" });
      }
      entry = pathToFileURL(path);
    }
    const worker = this.worker = fork(fileURLToPath(entry), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], windowsHide: true });
    worker.on("message", (message: any) => {
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
    worker.on("error", error => { this.failed = true; this.lastError = "worker_failed"; this.log.warn("automatic backup process failed", { err: String(error) }); });
    worker.on("exit", (code, signal) => {
      if (!this.stopped && (code !== 0 || signal)) { this.failed = true; this.lastError = "worker_failed"; }
      if (this.worker === worker) this.worker = null;
      const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
      if (interval) this.schedule(Math.min(interval, 60 * 60 * 1_000));
    });
    worker.send({ type: "pressure", pending: this.pending, pauseUntil: this.pauseUntil }, () => {});
    worker.send({ type: "start", home: this.home }, () => {});
    worker.unref();
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const worker = this.worker;
    if (worker?.connected) worker.send({ type: "stop" }, () => {});
    if (worker) await new Promise<void>(resolve => worker.once("exit", () => resolve()));
  }
}
