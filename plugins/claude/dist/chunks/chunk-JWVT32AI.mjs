import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  git,
  trustArgs
} from "./chunk-C4526LA5.mjs";
import {
  RESULT_HEADER,
  localResultReceipt
} from "./chunk-X4B2TYR3.mjs";
import {
  resolveDbPath
} from "./chunk-L4M5HEV4.mjs";
import {
  JSON_STORE_VERSION,
  archiveDbPath,
  assertWritableStore,
  importMetadataDomain,
  isRecord,
  mergeStoreFields,
  metadataValue,
  saveMetadataValue
} from "./chunk-EVPBD2NK.mjs";

// src/core/job-outcomes.ts
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inflateSync } from "node:zlib";
function localHeads(repo, branches) {
  if (["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_SHALLOW_FILE", "GIT_REPLACE_REF_BASE"].some((key) => process.env[key])) return null;
  if (branches.some((branch) => !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock") || part.includes("..")))) return null;
  try {
    const dir = join(repo, ".git");
    if (!lstatSync(dir).isDirectory() || /\brefStorage\s*=|\[\s*include/i.test(readFileSync(join(dir, "config"), "utf8"))) return null;
    const packed = /* @__PURE__ */ new Map();
    try {
      for (const line of readFileSync(join(dir, "packed-refs"), "utf8").split("\n")) {
        const match = /^((?:[a-f0-9]{40}|[a-f0-9]{64})) (refs\/heads\/.+)$/i.exec(line.trim());
        if (match) packed.set(match[2], match[1]);
      }
    } catch (err) {
      if (err.code !== "ENOENT") return null;
    }
    const heads = /* @__PURE__ */ new Map();
    for (const branch of branches) {
      const ref = `refs/heads/${branch}`;
      let head = packed.get(ref);
      try {
        head = readFileSync(join(dir, "refs", "heads", branch), "utf8").trim();
      } catch (err) {
        if (err.code !== "ENOENT") return null;
      }
      if (head === void 0) continue;
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) return null;
      heads.set(ref, head);
    }
    return heads;
  } catch {
    return null;
  }
}
function localAncestor(repo, ancestor, descendant) {
  const dir = join(repo, ".git"), limit = 64 * 1024;
  try {
    if (["shallow", "info/grafts", "refs/replace", "objects/info/alternates"].some((file) => existsSync(join(dir, file)))) return null;
    try {
      if (/ refs\/replace\//m.test(readFileSync(join(dir, "packed-refs"), "utf8"))) return null;
    } catch (err) {
      if (err.code !== "ENOENT") return null;
    }
    let reads = 0;
    const parents = (head) => {
      if (reads++ >= 16 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) return null;
      const file = join(dir, "objects", head.slice(0, 2), head.slice(2));
      if (!lstatSync(file).isFile()) return null;
      const fd = openSync(file, "r");
      let compressed;
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
      } finally {
        closeSync(fd);
      }
      const object = inflateSync(compressed, { maxOutputLength: limit });
      if (createHash(head.length === 40 ? "sha1" : "sha256").update(object).digest("hex") !== head.toLowerCase()) return null;
      const zero = object.indexOf(0), header = /^commit (\d+)$/.exec(object.subarray(0, zero).toString("utf8"));
      if (zero < 0 || !header || Number(header[1]) !== object.length - zero - 1) return null;
      const body = object.subarray(zero + 1).toString("utf8"), end = body.indexOf("\n\n");
      if (end < 0 || !new RegExp(`^tree [a-f0-9]{${head.length}}\\n`, "i").test(body)) return null;
      const result = [];
      let parentBlock = true;
      for (const line of body.slice(0, end).split("\n").slice(1)) {
        if (!line.startsWith("parent ")) {
          parentBlock = false;
          continue;
        }
        if (!parentBlock) return null;
        const parent = line.slice(7);
        if (parent.length !== head.length || !/^[a-f0-9]+$/i.test(parent) || result.length >= 16) return null;
        result.push(parent);
      }
      return result;
    };
    if (parents(ancestor) === null) return null;
    const pending = [descendant], seen = /* @__PURE__ */ new Set();
    while (pending.length) {
      const head = pending.pop();
      if (head === ancestor) return true;
      if (seen.has(head)) continue;
      if (seen.size >= 16) return null;
      seen.add(head);
      const next = parents(head);
      if (next === null || pending.length + next.length > 16) return null;
      pending.push(...next);
    }
    return false;
  } catch {
    return null;
  }
}
var MAX_HOLD_REASON_CHARS = 2e3;
var JOB_OUTCOMES_DIR = "job-outcomes";
var JOB_OUTCOME_CONTRACT_VERSION = 1;
function readOutcomeDecision(home, job) {
  importMetadataDomain(home, JOB_OUTCOMES_DIR);
  const data = metadataValue(home, JOB_OUTCOMES_DIR, createHash("sha256").update(`${job.name}:${job.startedAt}`).digest("hex"));
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
  importMetadataDomain(home, JOB_OUTCOMES_DIR);
  const key = createHash("sha256").update(`${job.name}:${job.startedAt}`).digest("hex");
  const previous = metadataValue(home, JOB_OUTCOMES_DIR, key);
  assertWritableStore(previous);
  const decision = { state, reason: trimmed, at: now, by: supervisor };
  const history = isRecord(previous) && Array.isArray(previous.history) ? previous.history : [];
  const prior = isRecord(previous) && isRecord(previous.decision) ? [previous.decision] : [];
  saveMetadataValue(home, JOB_OUTCOMES_DIR, key, mergeStoreFields(isRecord(previous) ? previous : {}, { version: JSON_STORE_VERSION, job: job.name, startedAt: job.startedAt, decision, history: [...history, ...prior] }));
  return decision;
}
function readResultDelivery(home, job, before = Number.MAX_SAFE_INTEGER) {
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
      let heads = localHeads(repoRoot, [branch, baseBranch]);
      const ordinaryFiles = heads !== null;
      if (!heads) {
        const refs = await run([
          "for-each-ref",
          "--format=%(refname)%09%(objectname)",
          `refs/heads/${branch}`,
          `refs/heads/${baseBranch}`
        ]).catch(() => "");
        heads = new Map(refs.split("\n").map((line) => line.trim().split("	")));
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

export {
  MAX_HOLD_REASON_CHARS,
  JOB_OUTCOME_CONTRACT_VERSION,
  readOutcomeDecision,
  setJobOutcome,
  deriveJobOutcome
};
