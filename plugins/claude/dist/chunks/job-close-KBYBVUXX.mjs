import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  closeJobWorktree
} from "./chunk-GS4DWRJ5.mjs";
import {
  readWorktreeState
} from "./chunk-ITOQSHK6.mjs";
import "./chunk-MQGFL2OS.mjs";
import {
  readOutcomeDecision
} from "./chunk-ZUNWNXUT.mjs";
import "./chunk-5TDOZG2J.mjs";
import "./chunk-TFVNH3A3.mjs";
import "./chunk-KWUM4FZP.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-KYK3XDP2.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-BVTRXPA5.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-M26SH6VN.mjs";
import "./chunk-V4WDBMEN.mjs";
import "./chunk-ZBKQCI2L.mjs";
import "./chunk-Y5OCTQFF.mjs";
import "./chunk-EVQHXDRX.mjs";
import "./chunk-4QXHCXBU.mjs";
import "./chunk-MQP6K4NJ.mjs";
import "./chunk-QI5MA53T.mjs";
import "./chunk-FDMEMG4Z.mjs";
import {
  readHistoryJson,
  readRunnerStateRecord
} from "./chunk-OG3EDS6T.mjs";
import "./chunk-2BSEKRNX.mjs";
import "./chunk-TFQZM67X.mjs";
import {
  JSON_STORE_VERSION,
  isRecord
} from "./chunk-OMBGRGBY.mjs";
import "./chunk-ENZISWMO.mjs";
import {
  JOBS_FILE
} from "./chunk-Q372BWBW.mjs";
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
    const data = readRunnerStateRecord(home, job.id);
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
