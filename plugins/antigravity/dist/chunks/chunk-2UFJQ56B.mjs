import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  git,
  trustArgs
} from "./chunk-SHRG22WS.mjs";
import {
  RESULT_HEADER,
  localResultReceipt
} from "./chunk-5QC4IROA.mjs";
import {
  readHistoryJson,
  readStore
} from "./chunk-EIBZH3O5.mjs";
import {
  resolveDbPath
} from "./chunk-I5ATHBYL.mjs";
import {
  archiveDbPath
} from "./chunk-JSAVG5BJ.mjs";
import {
  isRecord,
  mergeStoreFields,
  readJsonStore,
  writeJsonStore
} from "./chunk-TPCM6ZR4.mjs";
import {
  JOBS_FILE
} from "./chunk-6PRX5EOQ.mjs";

// src/core/job-outcomes.ts
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var MAX_HOLD_REASON_CHARS = 2e3;
var JOB_OUTCOMES_DIR = "job-outcomes";
var JOB_OUTCOME_CONTRACT_VERSION = 1;
function decisionPath(home, job) {
  const key = createHash("sha256").update(`${job.name}:${job.startedAt}`).digest("hex");
  return join(home, JOB_OUTCOMES_DIR, `${key}.json`);
}
function readOutcomeDecision(home, job) {
  const data = readHistoryJson(decisionPath(home, job));
  if (!isRecord(data) || !isRecord(data.decision)) return null;
  const d = data.decision;
  return (d.state === "held" || d.state === "discarded") && typeof d.at === "number" && typeof d.by === "string" && (d.reason === null || typeof d.reason === "string") ? d : null;
}
function setJobOutcome(home, job, supervisor, state, reason, now = Date.now()) {
  if (job.owner !== supervisor) throw new Error("Only this job's owning supervisor can set its outcome.");
  if (job.status !== "done" && job.status !== "failed") throw new Error("Only finished jobs can be held or discarded.");
  if (state !== "held" && state !== "discarded") throw new Error("Outcome must be held or discarded.");
  const trimmed = reason?.trim() || null;
  if (state === "held" && !trimmed) throw new Error("A held outcome requires a reason.");
  if (trimmed && trimmed.length > MAX_HOLD_REASON_CHARS) throw new Error(`Reason must be at most ${MAX_HOLD_REASON_CHARS} characters.`);
  const path = decisionPath(home, job);
  const previous = readJsonStore(path);
  const decision = { state, reason: trimmed, at: now, by: supervisor };
  const history = isRecord(previous) && Array.isArray(previous.history) ? previous.history : [];
  const prior = isRecord(previous) && isRecord(previous.decision) ? [previous.decision] : [];
  writeJsonStore(path, mergeStoreFields(isRecord(previous) ? previous : {}, { job: job.name, startedAt: job.startedAt, decision, history: [...history, ...prior] }), previous);
  return decision;
}
function resultDelivery(home, job, before) {
  const unknown = { status: "unknown", messageId: null, recipient: null, deliveredAt: null, readAt: null };
  const local = localResultReceipt(home, job.name, job.owner, job.startedAt, before);
  const path = resolveDbPath(home);
  const rows = [];
  for (const file of [path, archiveDbPath(path)]) {
    if (!existsSync(file)) continue;
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true, timeout: 50 });
      for (const table of ["messages", "archived_messages"]) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
        rows.push(...db.prepare(`SELECT id, recipient, body, created_at, read_at FROM ${table}
          WHERE from_name = ? AND conversation_id = ? AND created_at >= ? AND created_at < ?`).all(job.name, `job-${job.id}`, job.startedAt, before));
      }
    } catch {
    } finally {
      db?.close();
    }
  }
  rows.sort((a, b) => b.created_at - a.created_at);
  const row = rows.find((r) => (!job.owner || r.recipient === job.owner) && RESULT_HEADER.test(r.body.split("\n")[0]));
  if (!row || local && local.deliveredAt > row.created_at) return local ?? unknown;
  const readAt = rows.filter((r) => r.id === row.id && r.recipient === row.recipient).reduce((at, r) => r.read_at === null ? at : Math.max(at ?? 0, r.read_at), null);
  return { status: readAt === null ? "delivered" : "read", messageId: row.id, recipient: row.recipient, deliveredAt: row.created_at, readAt };
}
async function deriveJobOutcome(home, job, log, opts = {}) {
  const decision = readOutcomeDecision(home, job);
  const branch = opts.branch ?? job.worktree?.branch ?? null;
  const baseBranch = opts.baseBranch !== void 0 ? opts.baseBranch : job.worktree?.baseBranch ?? null;
  const repoRoot = opts.repoRoot ?? job.worktree?.repoRoot;
  let branchHead = opts.branchHead ?? job.worktree?.branchHead ?? null;
  const merge = {
    state: decision?.state ?? "unmerged",
    branch,
    baseBranch,
    branchHead,
    reason: decision?.reason ?? null,
    checkedAt: Date.now(),
    decisionAt: decision?.at ?? null,
    decisionBy: decision?.by ?? null
  };
  if (job.remote) {
    if (!decision) merge.reason = `Merge and receipt evidence is on paired PC ${job.remote.host}; local Git was not inspected.`;
    return { delivery: { status: "unknown", messageId: null, recipient: null, deliveredAt: null, readAt: null }, merge };
  }
  if (!decision) {
    if (!branch || !repoRoot || !baseBranch) merge.reason = "Branch, repository, or base branch is unknown.";
    else {
      const run = (args) => git([...trustArgs(repoRoot), ...args], repoRoot, log);
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
async function listJobOutcomes(home, log, names) {
  const jobs = readStore(join(home, JOBS_FILE), log, true);
  const out = {};
  for (const job of jobs) {
    if (names && !names.has(job.name)) continue;
    if (job.status !== "done" && job.status !== "failed") continue;
    out[job.name] = { startedAt: job.startedAt, status: job.status, outcome: await deriveJobOutcome(home, job, log) };
  }
  return out;
}

export {
  MAX_HOLD_REASON_CHARS,
  JOB_OUTCOME_CONTRACT_VERSION,
  readOutcomeDecision,
  setJobOutcome,
  deriveJobOutcome,
  listJobOutcomes
};
