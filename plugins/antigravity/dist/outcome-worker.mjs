import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  outcomeSignature,
  pendingOutcome
} from "./chunks/chunk-HZAGME3J.mjs";
import {
  deriveJobOutcome
} from "./chunks/chunk-JWVT32AI.mjs";
import "./chunks/chunk-C4526LA5.mjs";
import "./chunks/chunk-X4B2TYR3.mjs";
import "./chunks/chunk-YIC6PP7C.mjs";
import "./chunks/chunk-A2SWCN6M.mjs";
import "./chunks/chunk-D5ZW6VFT.mjs";
import "./chunks/chunk-L4M5HEV4.mjs";
import "./chunks/chunk-JTZGNEMM.mjs";
import "./chunks/chunk-7OVAI3PR.mjs";
import "./chunks/chunk-PCXGTT2Z.mjs";
import {
  readRunStarts
} from "./chunks/chunk-2KLFTBBJ.mjs";
import "./chunks/chunk-ETHEYCLK.mjs";
import "./chunks/chunk-CUZHUOFY.mjs";
import "./chunks/chunk-QI6BOSWF.mjs";
import "./chunks/chunk-L3WJOWYS.mjs";
import "./chunks/chunk-NSTCMPSE.mjs";
import "./chunks/chunk-JNVJDIQM.mjs";
import "./chunks/chunk-FDMEMG4Z.mjs";
import {
  nullLogger
} from "./chunks/chunk-EVPBD2NK.mjs";
import "./chunks/chunk-SFW3GO73.mjs";
import "./chunks/chunk-7EOIPV3B.mjs";
import "./chunks/chunk-HHAVWD7J.mjs";

// src/core/outcome-worker.ts
import { parentPort } from "node:worker_threads";
import { stat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
var cache = /* @__PURE__ */ new Map();
var cacheBytes = 0;
async function gitPaths(inputs) {
  const paths = /* @__PURE__ */ new Set();
  for (const input of inputs) {
    const repo = input.opts.repoRoot ?? input.job.worktree?.repoRoot;
    if (!repo || input.job.remote) continue;
    const marker = join(repo, ".git");
    let dir = marker;
    try {
      if ((await stat(marker)).isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(marker, "utf8"));
        if (!pointer) continue;
        dir = resolve(repo, pointer[1].trim());
      }
      const commonFile = join(dir, "commondir");
      paths.add(marker);
      paths.add(commonFile);
      let common = dir;
      try {
        common = resolve(dir, (await readFile(commonFile, "utf8")).trim());
      } catch {
      }
      for (const root of /* @__PURE__ */ new Set([dir, common])) {
        for (const name of ["", "HEAD", "config", "packed-refs", "shallow", "info/grafts", "refs/replace", "objects/info/alternates", "objects/pack"])
          paths.add(join(root, name));
        for (const branch of [input.opts.branch ?? input.job.worktree?.branch, input.opts.baseBranch ?? input.job.worktree?.baseBranch]) {
          if (!branch || !/^[\w./-]+$/.test(branch) || branch.split("/").includes("..")) continue;
          let ref = join(root, "refs", "heads", branch);
          for (let depth = 0; depth < 8; depth++) {
            paths.add(ref);
            paths.add(dirname(ref));
            let symbolic;
            try {
              symbolic = /^ref:\s*(refs\/[\w./-]+)\s*$/.exec(await readFile(ref, "utf8"));
            } catch {
              break;
            }
            if (!symbolic || symbolic[1].split("/").includes("..")) break;
            ref = join(root, symbolic[1]);
          }
        }
      }
    } catch {
    }
  }
  return [...paths].sort();
}
var turn = Promise.resolve();
parentPort?.on("message", (message) => {
  turn = turn.then(async () => {
    const inputs = message.inputs;
    if (await outcomeSignature(message.home, inputs, message.gitPaths) !== message.signature) throw new Error("Outcome inputs changed before inspection");
    const paths = await gitPaths(inputs);
    const sourceSignature = await outcomeSignature(message.home, inputs, paths);
    if (await outcomeSignature(message.home, inputs, message.gitPaths) !== message.signature) throw new Error("Outcome inputs changed while resolving Git");
    const starts = inputs.some((input) => input.kind === "run") ? await readRunStarts(message.home) : [];
    const result = {};
    for (const input of inputs) {
      const next = input.kind === "run" ? starts.filter((run) => run.job === input.job.name && (run.jobStartedAt ?? run.startedAt) > input.job.startedAt).sort((a, b) => (a.jobStartedAt ?? a.startedAt) - (b.jobStartedAt ?? b.startedAt))[0] : void 0;
      const signature = sourceSignature + JSON.stringify(input);
      const key = `${message.home}:${input.kind}:${input.key}`;
      let saved = cache.get(key);
      if (saved?.signature !== signature || Date.now() - saved.at >= 5e3) {
        try {
          const outcome = await deriveJobOutcome(message.home, input.job, nullLogger, { ...input.opts, before: next?.jobStartedAt ?? next?.startedAt });
          saved = {
            signature,
            at: Date.now(),
            outcome: { ...outcome, observation: { state: "ready", checkedAt: Date.now() } },
            bytes: Buffer.byteLength(JSON.stringify(outcome) + signature + key)
          };
          const previous = cache.get(key);
          if (previous) cacheBytes -= previous.bytes;
          cache.delete(key);
          if (saved.bytes <= 8 * 1024 * 1024) {
            cache.set(key, saved);
            cacheBytes += saved.bytes;
          }
          while (cache.size > 1024 || cacheBytes > 8 * 1024 * 1024) {
            const oldest = cache.keys().next().value;
            cacheBytes -= cache.get(oldest).bytes;
            cache.delete(oldest);
          }
        } catch {
          saved = void 0;
        }
      }
      result[input.key] = saved?.outcome ?? pendingOutcome(input);
      await new Promise((resolve2) => setTimeout(resolve2, 2));
    }
    if (await outcomeSignature(message.home, inputs, paths) !== sourceSignature) {
      for (const input of inputs) result[input.key] = pendingOutcome(input);
    }
    parentPort?.postMessage({ id: message.id, result, signature: sourceSignature, gitPaths: paths });
  }).catch(() => parentPort?.postMessage({ id: message.id, error: true }));
});
