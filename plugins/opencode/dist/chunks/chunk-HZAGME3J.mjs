import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  bundleDirectory
} from "./chunk-D5ZW6VFT.mjs";

// src/core/outcome-background.ts
import { Worker } from "node:worker_threads";
import { mkdir, stat, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var CACHE_LIMIT = 1024;
var CACHE_BYTES = 8 * 1024 * 1024;
var REFRESH_MS = 1e3;
var WAIT_MS = 250;
var digest = (text) => createHash("sha256").update(text).digest("hex");
async function outcomeSignature(home, inputs, gitPaths = []) {
  const paths = /* @__PURE__ */ new Set([...gitPaths, join(home, "jobs.json"), ...["bridge.db", "archive.db"].flatMap((name) => [join(home, name), join(home, `${name}-wal`)])]);
  for (const input of inputs) {
    const job = input.job;
    paths.add(join(home, "job-outcomes", `${digest(`${job.name}:${job.startedAt}`)}.json`));
    const receipts = join(home, "local-result-receipts", digest(job.name));
    paths.add(receipts);
    try {
      for (const name of await readdir(receipts)) paths.add(join(receipts, name));
    } catch {
    }
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
  for (const folder of [join(home, "runs"), join(home, "runs", "archive")]) {
    paths.add(folder);
    try {
      for (const name of await readdir(folder)) if (/\.json(?:-\d+-[\w-]+)?$/.test(name)) paths.add(join(folder, name));
    } catch {
    }
  }
  const signatures = await Promise.all([...paths].sort().map(async (path) => {
    try {
      const s = await stat(path);
      return `${path}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`;
    } catch {
      return `${path}:unavailable`;
    }
  }));
  return digest(JSON.stringify(inputs) + signatures.join("\n"));
}
function pendingOutcome(input) {
  return {
    observation: { state: "pending", checkedAt: null },
    delivery: { status: "unknown", messageId: null, recipient: null, deliveredAt: null, readAt: null },
    merge: {
      state: "unmerged",
      branch: input.opts.branch ?? input.job.worktree?.branch ?? null,
      baseBranch: input.opts.baseBranch ?? input.job.worktree?.baseBranch ?? null,
      branchHead: input.opts.branchHead ?? input.job.worktree?.branchHead ?? null,
      reason: "Outcome verification pending; cached display evidence is not cleanup authority.",
      checkedAt: 0,
      decisionAt: null,
      decisionBy: null
    }
  };
}
var OutcomeBackground = class {
  worker = null;
  cache = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  requests = /* @__PURE__ */ new Map();
  id = 0;
  bytes = 0;
  async start() {
    let entry = pathToFileURL(join(bundleDirectory(import.meta.url), "outcome-worker.mjs"));
    if (import.meta.url.endsWith(".ts")) {
      const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      const path = join(process.env.AGENT_BRIDGE_TEST_ROOT ?? join(root, ".agent-bridge-test"), `outcome-worker-${process.pid}.mjs`);
      await mkdir(dirname(path), { recursive: true });
      await createRequire(import.meta.url)("esbuild").build({
        entryPoints: [join(root, "src/core/outcome-worker.ts")],
        outfile: path,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        external: ["node:*"],
        logLevel: "silent"
      });
      entry = pathToFileURL(path);
    }
    const worker = new Worker(entry, { execArgv: [] });
    worker.on("message", (message) => {
      const pending = this.requests.get(message.id);
      this.requests.delete(message.id);
      if (message.error) pending?.reject(new Error("Outcome worker inspection unavailable"));
      else pending?.resolve(message);
    });
    const failed = () => {
      for (const pending of this.requests.values()) pending.reject(new Error("Outcome worker exited"));
      this.requests.clear();
      this.worker = null;
    };
    worker.on("error", failed);
    worker.on("exit", failed);
    worker.unref();
    return worker;
  }
  async read(home, inputs, log) {
    if (!inputs.length) return {};
    const key = digest(home + JSON.stringify(inputs));
    const cached = this.cache.get(key);
    const signature = await outcomeSignature(home, inputs, cached?.gitPaths);
    if (cached?.signature === signature && Date.now() - cached.checkedAt < REFRESH_MS) return structuredClone(cached.result);
    let refresh = this.pending.get(key);
    if (!refresh && this.pending.size < 32) {
      refresh = (async () => {
        this.worker ??= this.start().catch((error) => {
          this.worker = null;
          throw error;
        });
        const worker = await this.worker;
        const id = ++this.id;
        const inspected = await new Promise((resolve, reject) => {
          this.requests.set(id, { resolve, reject });
          worker.postMessage({ id, home, inputs, signature, gitPaths: cached?.gitPaths ?? [] });
        });
        if (await outcomeSignature(home, inputs, inspected.gitPaths) !== inspected.signature) return;
        const result = inspected.result;
        const bytes = Buffer.byteLength(JSON.stringify({ result, gitPaths: inspected.gitPaths }));
        const previous = this.cache.get(key);
        if (previous) this.bytes -= previous.bytes;
        this.cache.delete(key);
        if (bytes <= CACHE_BYTES) {
          this.cache.set(key, { signature: inspected.signature, gitPaths: inspected.gitPaths, result, checkedAt: Date.now(), bytes });
          this.bytes += bytes;
        }
        while (this.cache.size > CACHE_LIMIT || this.bytes > CACHE_BYTES) {
          const oldest = this.cache.keys().next().value;
          this.bytes -= this.cache.get(oldest).bytes;
          this.cache.delete(oldest);
        }
      })().catch(() => log.debug("outcome display refresh deferred")).finally(() => this.pending.delete(key));
      this.pending.set(key, refresh);
    }
    if (refresh) await new Promise((resolve) => {
      const timer = setTimeout(resolve, WAIT_MS);
      timer.unref();
      void refresh.finally(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    const ready = this.cache.get(key);
    const currentSignature = ready?.gitPaths !== cached?.gitPaths ? await outcomeSignature(home, inputs, ready?.gitPaths) : signature;
    if (ready?.signature === currentSignature && Date.now() - ready.checkedAt < REFRESH_MS) return structuredClone(ready.result);
    if (ready?.signature === currentSignature) return Object.fromEntries(Object.entries(ready.result).map(([name, value]) => [
      name,
      { ...structuredClone(value), observation: { state: "stale", checkedAt: ready.checkedAt } }
    ]));
    return Object.fromEntries(inputs.map((input) => [input.key, pendingOutcome(input)]));
  }
};
var background = new OutcomeBackground();
var cachedOutcomes = (home, inputs, log) => background.read(home, inputs, log);

export {
  outcomeSignature,
  pendingOutcome,
  cachedOutcomes
};
