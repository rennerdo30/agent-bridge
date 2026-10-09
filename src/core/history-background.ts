import { bundleDirectory } from "./bundle-directory.js";
import { Worker } from "node:worker_threads";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";
import { transcriptPaths } from "./transcripts/common.js";
import type { PeerInfo } from "./protocol.js";
import { historyDbPath, releaseExitedHistoryLease, HISTORY_IO_BYTES_PER_SECOND, type HistoryMigrationProgress } from "./history-store.js";

type Batch = { work: number; discovering: boolean };
/** One elected worker; no source I/O or indexing writes on message dispatch. */
export class HistoryBackground {
  private progress: HistoryMigrationProgress = { phase: "starting", percent: 0, etaSeconds: null, paused: false, completedRows: 0, totalRows: 0, snapshot: null, ioBytesPerSecond: HISTORY_IO_BYTES_PER_SECOND, error: null };
  private worker!: Worker;
  private stopped = false;
  private exited = false;
  private restart: NodeJS.Timeout | null = null;
  private id = 0;
  private migrationLease: string | null = null;
  private reconcilingAsks: Promise<Batch> | null = null;
  private lastPressure: boolean | undefined;
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
        "savepoint.ts",
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
      this.lastPressure = undefined;
      this.exited = false;
      this.worker = new Worker(entry, {
        workerData: { file: historyDbPath(file), bridge: file, home: dirname(file), paths: transcriptPaths() },
        execArgv: [],
      });
      this.worker.on("message", (message) => {
        if (message.migrationProgress) { this.progress = message.migrationProgress; return; }
        if ("migrationLease" in message) { this.migrationLease = message.migrationLease; return; }
        if (message.id) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) pending?.reject(new Error(message.error));
          else pending?.resolve(message.result);
        } else if (message.error)
          log.warn("history background batch deferred", { err: message.error });
      });
      this.worker.on("error", (err) => {
        log.warn("history worker failed", { err: String(err) });
        for (const p of this.pending.values())
          p.reject(err instanceof Error ? err : new Error(String(err)));
        this.pending.clear();
      });
      this.worker.on("exit", (code) => {
        this.exited = true;
        if (this.migrationLease) {
          try { releaseExitedHistoryLease(file,this.migrationLease); }
          catch (err) { log.warn("history worker lease cleanup deferred",{err:String(err)}); }
          this.migrationLease = null;
        }
        for (const p of this.pending.values())
          p.reject(new Error(`History worker exited (${code})`));
        this.pending.clear();
        if (!this.stopped) {
          log.warn("history worker restarting", { code });
          this.restart = setTimeout(start, 2000);
          this.restart.unref();
        }
      });
      this.worker.unref();
    };
    start();
  }
  status(): HistoryMigrationProgress { return { ...this.progress }; }
  pressure(pending: boolean, lockError = false): void {
    if (!this.stopped && !this.exited && (this.lastPressure !== pending || lockError)) {
      this.lastPressure = pending;
      this.worker.postMessage({ pressure: true, pending, lockError });
    }
  }
  rememberPeer(peer: PeerInfo): void {
    if (!this.stopped && !this.exited) this.worker.postMessage({ peer });
  }
  tick(reset = false): Promise<Batch> {
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
    if (this.stopped || this.exited) return Promise.reject(new Error("Job reconciliation worker unavailable; retry later"));
    this.reconcilingAsks = new Promise<Batch>((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, reconcileAsks: true });
    }).finally(() => { this.reconcilingAsks = null; });
    return this.reconcilingAsks;
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.restart) clearTimeout(this.restart);
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
