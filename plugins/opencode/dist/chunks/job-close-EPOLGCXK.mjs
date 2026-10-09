import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RUNNERS_DIR_NAME,
  closeJobWorktree,
  readWorktreeState
} from "./chunk-B2UEDMHR.mjs";
import "./chunk-LZRVUOSK.mjs";
import "./chunk-2B56UVWZ.mjs";
import {
  readOutcomeDecision
} from "./chunk-JWVT32AI.mjs";
import "./chunk-C4526LA5.mjs";
import "./chunk-X4B2TYR3.mjs";
import "./chunk-YIC6PP7C.mjs";
import "./chunk-A2SWCN6M.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-L4M5HEV4.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-7OVAI3PR.mjs";
import "./chunk-PCXGTT2Z.mjs";
import {
  readHistoryJson
} from "./chunk-2KLFTBBJ.mjs";
import "./chunk-ETHEYCLK.mjs";
import "./chunk-CUZHUOFY.mjs";
import "./chunk-QI6BOSWF.mjs";
import "./chunk-L3WJOWYS.mjs";
import "./chunk-NSTCMPSE.mjs";
import "./chunk-JNVJDIQM.mjs";
import "./chunk-FDMEMG4Z.mjs";
import {
  JSON_STORE_VERSION,
  isRecord
} from "./chunk-EVPBD2NK.mjs";
import "./chunk-SFW3GO73.mjs";
import {
  JOBS_FILE
} from "./chunk-7EOIPV3B.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/cli/job-close.ts
import { join } from "node:path";
var DAY_MS = 24 * 60 * 6e4;
async function runJobClose(command, args, home, cfg, log, out) {
  const document = readHistoryJson(join(home, JOBS_FILE));
  if (isRecord(document) && typeof document.version === "number" && document.version > JSON_STORE_VERSION) throw new Error("Unsupported job store version; all worktrees are kept.");
  const values = Array.isArray(document) ? document : isRecord(document) && Array.isArray(document.jobs) ? document.jobs : null;
  if (!values) throw new Error("Job store is unavailable or unreadable; all worktrees are kept.");
  const jobs = values.filter((job) => isRecord(job) && typeof job.id === "string" && typeof job.name === "string" && typeof job.startedAt === "number" && typeof job.status === "string");
  const apply = args.includes("--yes") && !args.includes("--dry-run");
  const names = args.filter((arg) => !arg.startsWith("-"));
  if (args.some((arg) => arg.startsWith("-") && !["--yes", "--dry-run"].includes(arg)) || (command === "close-idle-jobs" ? names.length !== 0 : names.length !== 1)) throw new Error(`Usage: agent-bridge ${command}${command === "close-idle-jobs" ? "" : " <job>"} [--yes | --dry-run]`);
  const selected = command === "close-idle-jobs" ? jobs : jobs.filter((job) => job.name === names[0] || job.id === names[0]);
  if (!selected.length && command !== "close-idle-jobs") throw new Error("Unknown job.");
  let failures = 0;
  for (const job of selected) {
    const state = job.worktree ? readWorktreeState(home, job.worktree) : null;
    if (!/^[A-Za-z0-9._-]+$/.test(job.id)) throw new Error("Invalid job id; retained.");
    const data = readHistoryJson(join(home, RUNNERS_DIR_NAME, `${job.id}.json`));
    const runner = isRecord(data) ? data : null;
    const decision = readOutcomeDecision(home, job);
    if (command === "job-state") {
      out(JSON.stringify({ job: job.name, status: job.status, finishedAt: job.finishedAt ?? null, lastContinuation: state?.lastContinuation ?? null, closedAt: state?.closedAt ?? null, reapedAt: state?.reapedAt ?? null, decision, runnerStatus: runner?.status ?? null }));
      continue;
    }
    if (command === "close-idle-jobs" && (!state || decision?.state === "held" || Math.max(state.lastContinuation, job.finishedAt ?? Date.now()) > Date.now() - DAY_MS)) continue;
    let live = false;
    if (typeof runner?.pid === "number") {
      try {
        process.kill(runner.pid, 0);
        live = true;
      } catch (err) {
        live = err.code !== "ESRCH";
      }
    }
    if (!apply) {
      out(`${job.name}: dry run; no push, cache removal or reap. Config enabled: ${cfg.jobCloseCleanup}`);
      continue;
    }
    const result = live || decision?.state === "held" ? { action: "kept", reason: "Live runner or held job retained." } : await closeJobWorktree({ home, job, enabled: cfg.jobCloseCleanup, log });
    out(`${job.name}: ${result.action}: ${result.reason}`);
    if (result.action === "kept") failures++;
  }
  return failures ? 1 : 0;
}
export {
  runJobClose
};
