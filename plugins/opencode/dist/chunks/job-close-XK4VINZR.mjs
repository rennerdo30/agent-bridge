import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  closeJobWorktree
} from "./chunk-YGKOYMWI.mjs";
import {
  readWorktreeState
} from "./chunk-5T4RJ7IQ.mjs";
import "./chunk-72TFE3RP.mjs";
import {
  readOutcomeDecision
} from "./chunk-OYDHKOEV.mjs";
import "./chunk-SPGRZ3MU.mjs";
import "./chunk-NR4D7G7R.mjs";
import {
  runnerProcessAlive
} from "./chunk-L7NKUEJL.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-ZH2USODZ.mjs";
import "./chunk-E5ZSIZVD.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-HJGP2JM4.mjs";
import "./chunk-Q5IQLWCD.mjs";
import "./chunk-QZCBQNZ3.mjs";
import "./chunk-IJB7OPWL.mjs";
import "./chunk-6XRCYILV.mjs";
import "./chunk-AHTV3VZF.mjs";
import "./chunk-IYJ5P7ML.mjs";
import {
  readHistoryJson,
  readRunnerStateRecord
} from "./chunk-VLWA2RF6.mjs";
import "./chunk-OX5J3NNH.mjs";
import "./chunk-HYOPFLLN.mjs";
import {
  JSON_STORE_VERSION,
  isRecord
} from "./chunk-K2GEQFVF.mjs";
import "./chunk-2SAFLVLW.mjs";
import {
  JOBS_FILE
} from "./chunk-HIVVJXLN.mjs";
import "./chunk-HYVC3VSW.mjs";
import "./chunk-6RNADTH4.mjs";

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
    const live = typeof runner?.pid === "number" && runnerProcessAlive({ pid: runner.pid, identity: typeof runner.identity === "string" ? runner.identity : void 0, updatedAt: Number(runner.updatedAt) });
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
