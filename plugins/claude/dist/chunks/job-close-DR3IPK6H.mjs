import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  closeJobWorktree
} from "./chunk-ME37T4ZK.mjs";
import {
  readWorktreeState
} from "./chunk-2DXR4UWB.mjs";
import "./chunk-PIUJVSBK.mjs";
import {
  readOutcomeDecision
} from "./chunk-JFXJRZ6U.mjs";
import "./chunk-JFVHVXKY.mjs";
import "./chunk-26AIKQES.mjs";
import {
  runnerProcessAlive
} from "./chunk-JTJOFBZ5.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-GUU6GAX6.mjs";
import "./chunk-65Q7CKMQ.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-DNAUDSOJ.mjs";
import "./chunk-6ACJ6BBT.mjs";
import "./chunk-Y3R7DNYE.mjs";
import "./chunk-F23PXWJA.mjs";
import "./chunk-ZNK2PPN3.mjs";
import "./chunk-ILTKWOC4.mjs";
import "./chunk-AAI35QKV.mjs";
import "./chunk-MICPYU3I.mjs";
import {
  readHistoryJson,
  readRunnerStateRecord
} from "./chunk-TSXRAYDD.mjs";
import "./chunk-UEE6Z4PJ.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import {
  JSON_STORE_VERSION,
  isRecord
} from "./chunk-F2RFTLGV.mjs";
import "./chunk-P4CW6EX2.mjs";
import {
  JOBS_FILE
} from "./chunk-5YJKJBJW.mjs";
import "./chunk-AAH2UEC3.mjs";
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
