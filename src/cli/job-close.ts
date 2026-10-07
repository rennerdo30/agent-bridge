import { join } from "node:path";
import type { BridgeConfig } from "../core/config.js";
import { JOBS_FILE } from "../core/constants.js";
import { RUNNERS_DIR_NAME } from "../mcp/job-host.js";
import { closeJobWorktree } from "../core/job-close.js";
import { readWorktreeState } from "../core/worktree-state.js";
import type { Logger } from "../core/logger.js";
import type { Job } from "../mcp/jobs.js";
import { readHistoryJson } from "../core/run-history.js";
import { isRecord, JSON_STORE_VERSION } from "../core/json-store.js";
import { readOutcomeDecision } from "../core/job-outcomes.js";

const DAY_MS = 24 * 60 * 60_000;
export async function runJobClose(command: "job-state" | "job-close" | "close-idle-jobs", args: string[], home: string, cfg: BridgeConfig, log: Logger, out: (line: string) => void): Promise<number> {
  const document = readHistoryJson(join(home, JOBS_FILE));
  if (isRecord(document) && typeof document.version === "number" && document.version > JSON_STORE_VERSION) throw new Error("Unsupported job store version; all worktrees are kept.");
  const values = Array.isArray(document) ? document : isRecord(document) && Array.isArray(document.jobs) ? document.jobs : null;
  if (!values) throw new Error("Job store is unavailable or unreadable; all worktrees are kept.");
  const jobs = values.filter((job) => isRecord(job) && typeof job.id === "string" && typeof job.name === "string" && typeof job.startedAt === "number" && typeof job.status === "string") as Job[];
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
    if (command === "job-state") { out(JSON.stringify({ job: job.name, status: job.status, finishedAt: job.finishedAt ?? null, lastContinuation: state?.lastContinuation ?? null, closedAt: state?.closedAt ?? null, reapedAt: state?.reapedAt ?? null, decision, runnerStatus: runner?.status ?? null })); continue; }
    if (command === "close-idle-jobs" && (!state || decision?.state === "held" || Math.max(state.lastContinuation, job.finishedAt ?? Date.now()) > Date.now() - DAY_MS)) continue;
    // A live runner is kept even if jobs.json still shows a prior finished turn.
    let live = false;
    if (typeof runner?.pid === "number") { try { process.kill(runner.pid, 0); live = true; } catch (err) { live = (err as NodeJS.ErrnoException).code !== "ESRCH"; } }
    if (!apply) { out(`${job.name}: dry run; no push, cache removal or reap. Config enabled: ${cfg.jobCloseCleanup}`); continue; }
    const result = live || decision?.state === "held" ? { action: "kept", reason: "Live runner or held job retained." } : await closeJobWorktree({ home, job, enabled: cfg.jobCloseCleanup, log });
    out(`${job.name}: ${result.action}: ${result.reason}`);
    if (result.action === "kept") failures++;
  }
  return failures ? 1 : 0;
}
