import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JOBS_FILE } from "./constants.js";
import { readHistoryJson } from "./run-history.js";
import { isRecord, mergeStoreFields, readJsonStore, writeJsonStore } from "./json-store.js";
import type { Logger } from "./logger.js";
import { resolveDbPath } from "./paths.js";
import { readStore } from "../mcp/jobs.js";
import { git, trustArgs, type Worktree } from "./worktree.js";
import { archiveDbPath } from "./sqlite-maintenance.js";
import { localResultReceipt, RESULT_HEADER } from "./local-result-receipts.js";

export const MAX_HOLD_REASON_CHARS = 2_000;
export const JOB_OUTCOMES_DIR = "job-outcomes";
export const JOB_OUTCOME_CONTRACT_VERSION = 1;

export interface OutcomeJob {
  id: string;
  name: string;
  owner?: string;
  startedAt: number;
  status: string;
  worktree?: Worktree | null;
  /** A requester projection may carry paths that only exist on the paired PC. */
  remote?: { host: string; name: string };
}

export interface OutcomeDecision {
  state: "held" | "discarded";
  reason: string | null;
  at: number;
  by: string;
}

export interface JobOutcome {
  delivery: {
    status: "unknown" | "delivered" | "read";
    messageId: string | null;
    recipient: string | null;
    deliveredAt: number | null;
    readAt: number | null;
  };
  merge: {
    state: "merged" | "held" | "unmerged" | "discarded";
    branch: string | null;
    baseBranch: string | null;
    branchHead: string | null;
    reason: string | null;
    checkedAt: number;
    decisionAt: number | null;
    decisionBy: string | null;
  };
}

function decisionPath(home: string, job: Pick<OutcomeJob, "name" | "startedAt">): string {
  const key = createHash("sha256").update(`${job.name}:${job.startedAt}`).digest("hex");
  return join(home, JOB_OUTCOMES_DIR, `${key}.json`);
}

export function readOutcomeDecision(home: string, job: OutcomeJob): OutcomeDecision | null {
  const data = readHistoryJson(decisionPath(home, job));
  if (!isRecord(data) || !isRecord(data.decision)) return null;
  const d = data.decision;
  return (d.state === "held" || d.state === "discarded") && typeof d.at === "number" && typeof d.by === "string"
    && (d.reason === null || typeof d.reason === "string") ? d as unknown as OutcomeDecision : null;
}

/** Only the owning supervisor can set a decision; a new turn gets a separate decision record. */
export function setJobOutcome(home: string, job: OutcomeJob, supervisor: string, state: "held" | "discarded", reason?: string, now = Date.now()): OutcomeDecision {
  if (job.owner !== supervisor) throw new Error("Only this job's owning supervisor can set its outcome.");
  if (job.status !== "done" && job.status !== "failed") throw new Error("Only finished jobs can be held or discarded.");
  if (state !== "held" && state !== "discarded") throw new Error("Outcome must be held or discarded.");
  const trimmed = reason?.trim() || null;
  if (state === "held" && !trimmed) throw new Error("A held outcome requires a reason.");
  if (trimmed && trimmed.length > MAX_HOLD_REASON_CHARS) throw new Error(`Reason must be at most ${MAX_HOLD_REASON_CHARS} characters.`);
  const path = decisionPath(home, job);
  const previous = readJsonStore(path);
  const decision: OutcomeDecision = { state, reason: trimmed, at: now, by: supervisor };
  // Preserve earlier decisions and unknown fields instead of replacing history.
  const history = isRecord(previous) && Array.isArray(previous.history) ? previous.history : [];
  const prior = isRecord(previous) && isRecord(previous.decision) ? [previous.decision] : [];
  writeJsonStore(path, mergeStoreFields(isRecord(previous) ? previous : {}, { job: job.name, startedAt: job.startedAt, decision, history: [...history, ...prior] }), previous);
  return decision;
}

/** Uses the same durable read_at receipt as wait_for_message; consumed does not mean reviewed. */
function resultDelivery(home: string, job: OutcomeJob, before: number): JobOutcome["delivery"] {
  const unknown: JobOutcome["delivery"] = { status: "unknown", messageId: null, recipient: null, deliveredAt: null, readAt: null };
  const local = localResultReceipt(home, job.name, job.owner, job.startedAt, before);
  const path = resolveDbPath(home);
  const rows: { id: string; recipient: string; body: string; created_at: number; read_at: number | null }[] = [];
  for (const file of [path, archiveDbPath(path)]) {
    if (!existsSync(file)) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      for (const table of ["messages", "archived_messages"]) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
        rows.push(...db.prepare(`SELECT id, recipient, body, created_at, read_at FROM ${table}
          WHERE from_name = ? AND conversation_id = ? AND created_at >= ? AND created_at < ?`)
          .all(job.name, `job-${job.id}`, job.startedAt, before) as unknown as typeof rows);
      }
    } catch { /* Unavailable evidence stays unknown; the other store can still be read. */ }
    finally { db?.close(); }
  }
  rows.sort((a, b) => b.created_at - a.created_at);
  const row = rows.find((r) => (!job.owner || r.recipient === job.owner) && RESULT_HEADER.test(r.body.split("\n")[0]!));
  if (!row || (local && local.deliveredAt > row.created_at)) return local ?? unknown;
  const readAt = rows.filter((r) => r.id === row.id && r.recipient === row.recipient).reduce<number | null>((at, r) => r.read_at === null ? at : Math.max(at ?? 0, r.read_at), null);
  return { status: readAt === null ? "delivered" : "read", messageId: row.id, recipient: row.recipient, deliveredAt: row.created_at, readAt };
}

export async function deriveJobOutcome(home: string, job: OutcomeJob, log: Logger, opts: {
  branch?: string; baseBranch?: string | null; repoRoot?: string; branchHead?: string; before?: number;
} = {}): Promise<JobOutcome> {
  const decision = readOutcomeDecision(home, job);
  const branch = opts.branch ?? job.worktree?.branch ?? null;
  const baseBranch = opts.baseBranch !== undefined ? opts.baseBranch : job.worktree?.baseBranch ?? null;
  const repoRoot = opts.repoRoot ?? job.worktree?.repoRoot;
  let branchHead = opts.branchHead ?? job.worktree?.branchHead ?? null;
  const merge: JobOutcome["merge"] = { state: decision?.state ?? "unmerged", branch, baseBranch, branchHead, reason: decision?.reason ?? null,
    checkedAt: Date.now(), decisionAt: decision?.at ?? null, decisionBy: decision?.by ?? null };
  if (job.remote) {
    if (!decision) merge.reason = `Merge and receipt evidence is on paired PC ${job.remote.host}; local Git was not inspected.`;
    return { delivery: { status: "unknown", messageId: null, recipient: null, deliveredAt: null, readAt: null }, merge };
  }
  if (!decision) {
    if (!branch || !repoRoot || !baseBranch) merge.reason = "Branch, repository, or base branch is unknown.";
    else {
      const run = (args: string[]) => git([...trustArgs(repoRoot), ...args], repoRoot, log);
      // A saved tip still proves ancestry after the branch/worktree was removed.
      branchHead ??= await run(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]).catch(() => null);
      merge.branchHead = branchHead;
      if (!branchHead) merge.reason = "Branch is missing and no saved tip is available.";
      else {
        const base = await run(["rev-parse", "--verify", `refs/heads/${baseBranch}^{commit}`]).catch(() => null);
        if (!base) merge.reason = "Base branch is unavailable.";
        else {
          const merged = await run(["merge-base", "--is-ancestor", branchHead, base]).then(() => true, () => false);
          merge.state = merged ? "merged" : "unmerged";
          merge.reason = merged ? null : `Has commits not merged into ${baseBranch}.`;
        }
      }
    }
  }
  return { delivery: resultDelivery(home, job, opts.before ?? Number.MAX_SAFE_INTEGER), merge };
}

export async function listJobOutcomes(home: string, log: Logger, names?: Set<string>): Promise<Record<string, { startedAt: number; status: string; outcome: JobOutcome }>> {
  const jobs = readStore(join(home, JOBS_FILE), log, true);
  const out: Record<string, { startedAt: number; status: string; outcome: JobOutcome }> = {};
  for (const job of jobs) {
    if (names && !names.has(job.name)) continue;
    if (job.status !== "done" && job.status !== "failed") continue;
    out[job.name] = { startedAt: job.startedAt, status: job.status, outcome: await deriveJobOutcome(home, job, log) };
  }
  return out;
}
