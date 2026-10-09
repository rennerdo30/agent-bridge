import { Worker } from "node:worker_threads";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";
import { atomicPluginWrite } from "./plugin-runtime.js";

/** One resumable migration per broker election, independent of history.ingest.
 * The same worker then packs archived finished runs (AB-208); repack() repeats only that, off the broker thread. */
export class JobArchiveBackground {
  private worker: Worker;
  finished: Promise<void>;
  private running = true;
  private closed = false;
  private readonly entry: URL;
  constructor(private readonly path: string, private readonly log: Logger) {
    let entry = new URL("./job-archive-worker.mjs", import.meta.url);
    if (import.meta.url.endsWith(".ts")) {
      const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      const output = join(root, ".agent-bridge-test", "job-archive-worker.mjs");
      const inputs = ["job-archive-worker.ts", "job-archive-index.ts", "job-archive-migration.ts", "archive-bundle.ts", "store-compatibility.ts", "sqlite-migrations.ts",
        "finished-run-bundles.ts", "metadata-import.ts", "metadata-db.ts", "run-archive.ts", "run-log-preview.ts", "runner-store.ts", "json-store.ts"];
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
    const worker = new Worker(this.entry, { workerData: { path: this.path, packOnly }, execArgv: [] });
    this.running = true;
    const finished = new Promise<void>(resolve => {
      worker.on("message", message => {
        if (message.runnerImport) this.log.info("runner file import", message.runnerImport);
        else if (message.runnerImportError) this.log.warn("runner file import deferred; files retained", { error: message.runnerImportError });
        else if (message.error) this.log.warn("job archive migration deferred; originals retained", { error: message.error });
        else if (message.result) this.log.info("job archive migration", message.result);
        else if (message.warning) this.log.warn(message.warning, message.failure);
        else if (message.packError) this.log.warn("archived run packing deferred; runs stay readable in place", { error: message.packError });
        else if (message.packed) this.log.info("archived runs packed", message.packed);
      });
      worker.on("error", error => this.log.warn("job archive worker failed; migration resumes next election", { error: String(error) }));
      worker.once("exit", () => { this.running = false; resolve(); });
    });
    worker.unref();
    return [worker, finished];
  }
  /** Pack runs archived since the last pass. A pass still running is left alone. */
  repack(): void {
    if (this.closed) return;
    // A live worker (it keeps importing runner files) packs on request between its batches.
    if (this.running) { try { this.worker.postMessage({ repack: true }); } catch { /* exiting */ } return; }
    [this.worker, this.finished] = this.start(true);
  }
  async close(): Promise<void> {
    this.closed = true;
    // Packing and the runner import stop between bounded batches; let the worker release its migration lease.
    // Termination while its process remains alive would strand that lease and obstruct a same-process election.
    if (this.running) this.worker.postMessage({ stop: true });
    await this.finished;
  }
}
