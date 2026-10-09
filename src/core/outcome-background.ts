import { bundleDirectory } from "./bundle-directory.js";
import { Worker } from "node:worker_threads";
import { mkdir, stat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Logger } from "./logger.js";
import type { JobOutcome, OutcomeJob, deriveJobOutcome } from "./job-outcomes.js";

export interface OutcomeInput {
  key: string;
  kind: "job" | "run";
  job: OutcomeJob;
  opts: NonNullable<Parameters<typeof deriveJobOutcome>[3]>;
}
const CACHE_LIMIT = 1024;
const CACHE_BYTES = 8 * 1024 * 1024;
const REFRESH_MS = 1_000;
const WAIT_MS = 250;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Stat-only and asynchronous: no database opens, body reads or Git processes. */
export async function outcomeSignature(home: string, inputs: OutcomeInput[], gitPaths: string[] = []): Promise<string> {
  const paths = new Set([...gitPaths, join(home, "jobs.json"), ...["bridge.db", "archive.db"].flatMap(name => [join(home, name), join(home, `${name}-wal`)])]);
  for (const input of inputs) {
    const job = input.job;
    paths.add(join(home, "job-outcomes", `${digest(`${job.name}:${job.startedAt}`)}.json`));
    const receipts = join(home, "local-result-receipts", digest(job.name));
    paths.add(receipts);
    try { for (const name of await readdir(receipts)) paths.add(join(receipts, name)); } catch { /* Missing receipts are unknown evidence. */ }
    if (job.owner) paths.add(join(home, "read-state", `${digest(`name:${job.owner}`)}.jsonl`));
    const repo = input.opts.repoRoot ?? job.worktree?.repoRoot;
    if (repo && !job.remote) {
      const root = join(repo, ".git");
      for (const name of ["", "HEAD", "config", "commondir", "packed-refs", "shallow", "info/grafts", "refs/replace", "objects/info/alternates", "objects/pack"])
        paths.add(join(root, name));
      for (const branch of [input.opts.branch ?? job.worktree?.branch, input.opts.baseBranch ?? job.worktree?.baseBranch])
        if (branch && /^[\w./-]+$/.test(branch) && !branch.split("/").includes("..")) paths.add(join(root, "refs", "heads", branch));
    }
  }
  // Later-turn metadata and archiving can change the result receipt boundary.
  for (const folder of [join(home, "runs"), join(home, "runs", "archive")]) {
    paths.add(folder);
    try { for (const name of await readdir(folder)) if (/\.json(?:-\d+-[\w-]+)?$/.test(name)) paths.add(join(folder, name)); } catch { /* Empty history. */ }
  }
  const signatures = await Promise.all([...paths].sort().map(async path => {
    try { const s = await stat(path); return `${path}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`; }
    catch { return `${path}:unavailable`; }
  }));
  return digest(JSON.stringify(inputs) + signatures.join("\n"));
}

export function pendingOutcome(input: OutcomeInput): JobOutcome {
  return { observation: { state: "pending", checkedAt: null },
    delivery: { status: "unknown", messageId: null, recipient: null, deliveredAt: null, readAt: null },
    merge: { state: "unmerged", branch: input.opts.branch ?? input.job.worktree?.branch ?? null,
      baseBranch: input.opts.baseBranch ?? input.job.worktree?.baseBranch ?? null,
      branchHead: input.opts.branchHead ?? input.job.worktree?.branchHead ?? null,
      reason: "Outcome verification pending; cached display evidence is not cleanup authority.", checkedAt: 0, decisionAt: null, decisionBy: null } };
}

type Entry = { signature: string; gitPaths: string[]; result: Record<string, JobOutcome>; checkedAt: number; bytes: number };
type Inspection = { result: Record<string, JobOutcome>; signature: string; gitPaths: string[] };
/** One reused worker and bounded/coalesced display cache for this process. */
class OutcomeBackground {
  private worker: Promise<Worker> | null = null;
  private readonly cache = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly requests = new Map<number, { resolve(value: Inspection): void; reject(error: Error): void }>();
  private id = 0;
  private bytes = 0;
  private async start(): Promise<Worker> {
    let entry = pathToFileURL(join(bundleDirectory(import.meta.url), "outcome-worker.mjs"));
    if (import.meta.url.endsWith(".ts")) {
      const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      const path = join(process.env.AGENT_BRIDGE_TEST_ROOT ?? join(root, ".agent-bridge-test"), `outcome-worker-${process.pid}.mjs`);
      await mkdir(dirname(path), { recursive: true });
      await createRequire(import.meta.url)("esbuild").build({ entryPoints: [join(root, "src/core/outcome-worker.ts")], outfile: path,
        bundle: true, platform: "node", format: "esm", target: "node22", external: ["node:*"], logLevel: "silent" });
      entry = pathToFileURL(path);
    }
    const worker = new Worker(entry, { execArgv: [] });
    worker.on("message", message => {
      const pending = this.requests.get(message.id); this.requests.delete(message.id);
      if (message.error) pending?.reject(new Error("Outcome worker inspection unavailable"));
      else pending?.resolve(message);
    });
    const failed = () => {
      for (const pending of this.requests.values()) pending.reject(new Error("Outcome worker exited"));
      this.requests.clear(); this.worker = null;
    };
    worker.on("error", failed); worker.on("exit", failed); worker.unref();
    return worker;
  }
  async read(home: string, inputs: OutcomeInput[], log: Logger): Promise<Record<string, JobOutcome>> {
    if (!inputs.length) return {};
    const key = digest(home + JSON.stringify(inputs));
    const cached = this.cache.get(key);
    const signature = await outcomeSignature(home, inputs, cached?.gitPaths);
    if (cached?.signature === signature && Date.now() - cached.checkedAt < REFRESH_MS) return structuredClone(cached.result);
    let refresh = this.pending.get(key);
    if (!refresh && this.pending.size < 32) {
      refresh = (async () => {
        this.worker ??= this.start().catch(error => { this.worker = null; throw error; });
        const worker = await this.worker;
        const id = ++this.id;
        const inspected = await new Promise<Inspection>((resolve, reject) => {
          this.requests.set(id, { resolve, reject }); worker.postMessage({ id, home, inputs, signature, gitPaths: cached?.gitPaths ?? [] });
        });
        // An older inspection must not publish against newer file/input signatures.
        if (await outcomeSignature(home, inputs, inspected.gitPaths) !== inspected.signature) return;
        const result = inspected.result;
        const bytes = Buffer.byteLength(JSON.stringify({ result, gitPaths: inspected.gitPaths }));
        const previous = this.cache.get(key); if (previous) this.bytes -= previous.bytes;
        this.cache.delete(key);
        if (bytes <= CACHE_BYTES) { this.cache.set(key, { signature: inspected.signature, gitPaths: inspected.gitPaths, result, checkedAt: Date.now(), bytes }); this.bytes += bytes; }
        while (this.cache.size > CACHE_LIMIT || this.bytes > CACHE_BYTES) {
          const oldest = this.cache.keys().next().value!; this.bytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
        }
      })().catch(() => log.debug("outcome display refresh deferred")).finally(() => this.pending.delete(key));
      this.pending.set(key, refresh);
    }
    if (refresh) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, WAIT_MS); timer.unref();
      void refresh!.finally(() => { clearTimeout(timer); resolve(); });
    });
    const ready = this.cache.get(key);
    const currentSignature = ready?.gitPaths !== cached?.gitPaths ? await outcomeSignature(home, inputs, ready?.gitPaths) : signature;
    if (ready?.signature === currentSignature && Date.now() - ready.checkedAt < REFRESH_MS) return structuredClone(ready.result);
    if (ready?.signature === currentSignature) return Object.fromEntries(Object.entries(ready.result).map(([name, value]) => [name,
      { ...structuredClone(value), observation: { state: "stale", checkedAt: ready.checkedAt } }]));
    return Object.fromEntries(inputs.map(input => [input.key, pendingOutcome(input)]));
  }
}
const background = new OutcomeBackground();
export const cachedOutcomes = (home: string, inputs: OutcomeInput[], log: Logger) => background.read(home, inputs, log);
