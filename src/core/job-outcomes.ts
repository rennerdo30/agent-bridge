import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inflateSync } from "node:zlib";
import { JOBS_FILE } from "./constants.js";
import { readHistoryJson } from "./run-history.js";
import { isRecord, mergeStoreFields, readJsonStore, writeJsonStore } from "./json-store.js";
import type { Logger } from "./logger.js";
import { resolveDbPath } from "./paths.js";
import { readStore } from "../mcp/jobs.js";
import { git, trustArgs, type Worktree } from "./worktree.js";
import { archiveDbPath } from "./sqlite-maintenance.js";
import { localResultReceipt, RESULT_HEADER } from "./local-result-receipts.js";

/** Resolve the ordinary files ref store without starting Git twice for one receipt.
 * Symbolic refs, linked Git directories and alternate ref stores retain Git's resolver. */
function localHeads(repo: string, branches: string[]): Map<string, string> | null {
  if (["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE"].some((key) => process.env[key])) return null;
  if (branches.some((branch) => !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock") || part.includes("..")))) return null;
  try {
    const dir = join(repo, ".git");
    if (!lstatSync(dir).isDirectory() || /\brefStorage\s*=|\[\s*include/i.test(readFileSync(join(dir, "config"), "utf8"))) return null;
    const packed = new Map<string, string>();
    try {
      for (const line of readFileSync(join(dir, "packed-refs"), "utf8").split("\n")) {
        const match = /^((?:[a-f0-9]{40}|[a-f0-9]{64})) (refs\/heads\/.+)$/i.exec(line.trim());
        if (match) packed.set(match[2]!, match[1]!);
      }
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null; }
    const heads = new Map<string, string>();
    for (const branch of branches) {
      const ref = `refs/heads/${branch}`;
      let head = packed.get(ref);
      try { head = readFileSync(join(dir, "refs", "heads", branch), "utf8").trim(); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null; }
      if (head === undefined) continue;
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) return null;
      heads.set(ref, head);
    }
    return heads;
  } catch { return null; }
}

/** A small complete loose-object walk avoids cold Git startup. Unsupported or
 * incomplete evidence always uses Git, including packed objects and altered ancestry. */
function localAncestor(repo: string, ancestor: string, descendant: string): boolean | null {
  const dir = join(repo, ".git"), limit = 64 * 1024;
  try {
    if (["shallow", "info/grafts", "refs/replace", "objects/info/alternates"].some((file) => existsSync(join(dir, file)))) return null;
    try {
      if (/ refs\/replace\//m.test(readFileSync(join(dir, "packed-refs"), "utf8"))) return null;
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null; }
    let reads = 0;
    const parents = (head: string): string[] | null => {
      if (reads++ >= 16 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) return null;
      const file = join(dir, "objects", head.slice(0, 2), head.slice(2));
      if (!lstatSync(file).isFile()) return null;
      const fd = openSync(file, "r");
      let compressed: Buffer;
      try {
        const stat = fstatSync(fd), size = stat.size;
        if (!stat.isFile() || size > limit) return null;
        compressed = Buffer.alloc(size);
        let at = 0;
        while (at < size) {
          const n = readSync(fd, compressed, at, size - at, at);
          if (!n) return null;
          at += n;
        }
      } finally { closeSync(fd); }
      const object = inflateSync(compressed, { maxOutputLength: limit });
      if (createHash(head.length === 40 ? "sha1" : "sha256").update(object).digest("hex") !== head.toLowerCase()) return null;
      const zero = object.indexOf(0), header = /^commit (\d+)$/.exec(object.subarray(0, zero).toString("utf8"));
      if (zero < 0 || !header || Number(header[1]) !== object.length - zero - 1) return null;
      const body = object.subarray(zero + 1).toString("utf8"), end = body.indexOf("\n\n");
      if (end < 0 || !new RegExp(`^tree [a-f0-9]{${head.length}}\\n`, "i").test(body)) return null;
      const result: string[] = [];
      let parentBlock = true;
      for (const line of body.slice(0, end).split("\n").slice(1)) {
        if (!line.startsWith("parent ")) { parentBlock = false; continue; }
        if (!parentBlock) return null;
        const parent = line.slice(7);
        if (parent.length !== head.length || !/^[a-f0-9]+$/i.test(parent) || result.length >= 16) return null;
        result.push(parent);
      }
      return result;
    };
    // A missing or malformed selected commit is not sufficient ancestry evidence.
    if (parents(ancestor) === null) return null;
    const pending = [descendant], seen = new Set<string>();
    while (pending.length) {
      const head = pending.pop()!;
      if (head === ancestor) return true;
      if (seen.has(head)) continue;
      if (seen.size >= 16) return null;
      seen.add(head);
      const next = parents(head);
      if (next === null || pending.length + next.length > 16) return null;
      pending.push(...next);
    }
    return false;
  } catch { return null; }
}

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
  /** Display-only cache state. Never use this projection as cleanup or merge authority. */
  observation?: { state: "ready" | "pending" | "stale"; checkedAt: number | null };
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
export function readResultDelivery(home: string, job: OutcomeJob, before = Number.MAX_SAFE_INTEGER): JobOutcome["delivery"] {
  const unknown: JobOutcome["delivery"] = { status: "unknown", messageId: null, recipient: null, deliveredAt: null, readAt: null };
  const local = localResultReceipt(home, job.name, job.owner, job.startedAt, before);
  const path = resolveDbPath(home);
  const rows: { id: string; recipient: string; body: string; created_at: number; read_at: number | null }[] = [];
  for (const file of [path, archiveDbPath(path)]) {
    if (!existsSync(file)) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: true, timeout: 50 });
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
  /** A frozen unknown receipt avoids scanning unrelated turn metadata when no evidence exists. */
  delivery?: JobOutcome["delivery"];
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
      // Resolve both exact refs in one process; a saved tip remains authoritative.
      let heads = localHeads(repoRoot, [branch, baseBranch]);
      const ordinaryFiles = heads !== null;
      if (!heads) {
        const refs = await run(["for-each-ref", "--format=%(refname)%09%(objectname)",
          `refs/heads/${branch}`, `refs/heads/${baseBranch}`]).catch(() => "");
        heads = new Map(refs.split("\n").map((line) => line.trim().split("\t") as [string, string]));
      }
      branchHead ??= heads.get(`refs/heads/${branch}`) ?? null;
      merge.branchHead = branchHead;
      if (!branchHead) merge.reason = "Branch is missing and no saved tip is available.";
      else {
        const base = heads.get(`refs/heads/${baseBranch}`);
        if (!base) merge.reason = "Base branch is unavailable.";
        else {
          const local = branchHead === base ? true : ordinaryFiles ? localAncestor(repoRoot, branchHead, base) : null;
          const merged = branchHead === base || (local ?? await run(["merge-base", "--is-ancestor", branchHead, base]).then(() => true, () => false));
          merge.state = merged ? "merged" : "unmerged";
          merge.reason = merged ? null : `Has commits not merged into ${baseBranch}.`;
        }
      }
    }
  }
  return { delivery: opts.delivery ?? readResultDelivery(home, job, opts.before ?? Number.MAX_SAFE_INTEGER), merge };
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
