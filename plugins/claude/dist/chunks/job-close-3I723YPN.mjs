import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  closeJobWorktree,
  runnerProcessAlive
} from "./chunk-2NYV2BYX.mjs";
import {
  readWorktreeState
} from "./chunk-35AJKN2K.mjs";
import "./chunk-HAKFXQK7.mjs";
import "./chunk-4CVWYGKW.mjs";
import {
  readOutcomeDecision
} from "./chunk-XPOMKZ7P.mjs";
import "./chunk-QIMXHKU5.mjs";
import "./chunk-PB5MFDGJ.mjs";
import "./chunk-FZP4L5IJ.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-Z36M4AXO.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-P2QFDD4K.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-CHGUU5ZH.mjs";
import "./chunk-V4WDBMEN.mjs";
import "./chunk-XTNJIED4.mjs";
import "./chunk-GJIKD3BI.mjs";
import "./chunk-JF4RUO76.mjs";
import "./chunk-6BINHEQ6.mjs";
import "./chunk-EROR3PLN.mjs";
import {
  readHistoryJson,
  readRunnerStateRecord
} from "./chunk-M47AHXAM.mjs";
import "./chunk-SANO3VTN.mjs";
import "./chunk-NVDPULGI.mjs";
import "./chunk-HYOPFLLN.mjs";
import {
  JSON_STORE_VERSION,
  isRecord
} from "./chunk-EEV363TZ.mjs";
import "./chunk-DC5UK7YY.mjs";
import {
  JOBS_FILE
} from "./chunk-KVKEQK7G.mjs";
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
