import { Worker } from "node:worker_threads";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";
import { atomicPluginWrite } from "./plugin-runtime.js";

/** One resumable migration per broker election, independent of history.ingest. */
export class JobArchiveBackground {
  private worker: Worker;
  readonly finished: Promise<void>;
  constructor(path: string, log: Logger) {
    let entry = new URL("./job-archive-worker.mjs", import.meta.url);
    if (import.meta.url.endsWith(".ts")) {
      const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      const output = join(root, ".agent-bridge-test", "job-archive-worker.mjs");
      const inputs = ["job-archive-worker.ts", "job-archive-index.ts", "job-archive-migration.ts", "archive-bundle.ts", "store-compatibility.ts", "sqlite-migrations.ts"];
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
    this.worker = new Worker(entry, { workerData: { path }, execArgv: [] });
    this.finished = new Promise(resolve => {
      this.worker.on("message", message => message.error ? log.warn("job archive migration deferred; originals retained", { error: message.error }) : log.info("job archive migration", message.result));
      this.worker.on("error", error => log.warn("job archive worker failed; migration resumes next election", { error: String(error) }));
      this.worker.once("exit", () => resolve());
    });
    this.worker.unref();
  }
  async close(): Promise<void> {
    // Let the worker release its migration lease. Termination while its process
    // remains alive would strand that lease and obstruct a same-process election.
    await this.finished;
  }
}
