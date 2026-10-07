import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  git,
  removeWorktreeDirectory,
  trustArgs
} from "./chunk-3BS5BGPD.mjs";
import {
  archiveDbPath
} from "./chunk-HJBA32EE.mjs";
import {
  resolveDbPath
} from "./chunk-AAHUVIX2.mjs";
import {
  assertPhysicalPath,
  permissionRepairPlan
} from "./chunk-R3TJGIIC.mjs";
import {
  killPid,
  pidAlive,
  readHistoryJson,
  readStore
} from "./chunk-QA5RZM2I.mjs";
import {
  CLAUDE_PERMISSION_MODES,
  CODEX_APPROVALS_REVIEWERS,
  CODEX_SANDBOXES,
  MODEL_NAME_PATTERN,
  NETWORK_NAME_PATTERN
} from "./chunk-IUXF4RKH.mjs";
import {
  CODING_AGENTS
} from "./chunk-SOPZATYP.mjs";
import {
  external_exports
} from "./chunk-JYWG6ADH.mjs";
import {
  JSON_STORE_VERSION,
  archiveFile,
  assertWritableStore,
  isRecord,
  mergeStoreFields,
  readJsonStore,
  retentionLimit,
  storageLease,
  writeJsonStore
} from "./chunk-CLF3ZYME.mjs";
import {
  JOBS_FILE,
  MAX_BODY_CHARS,
  MAX_CODEX_SUBAGENTS,
  MAX_JOB_TIMEOUT_SEC
} from "./chunk-DQEWVRBU.mjs";

// src/core/job-outcomes.ts
import { createHash as createHash3 } from "node:crypto";
import { existsSync as existsSync2 } from "node:fs";
import { join as join3 } from "node:path";
import { DatabaseSync } from "node:sqlite";

// src/core/local-result-receipts.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join as join2 } from "node:path";

// src/core/read-journal.ts
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
var ReadJournal = class {
  constructor(home) {
    this.home = home;
    this.dir = join(home, "read-state");
  }
  home;
  dir;
  path(identity) {
    return join(this.dir, `${createHash("sha256").update(identity).digest("hex")}.jsonl`);
  }
  read(identity) {
    return this.entries(identity).flatMap((entry) => entry.ids);
  }
  receipt(identity, id) {
    const entries = this.entries(identity).filter((entry) => entry.ids.includes(id));
    const times = entries.flatMap((entry) => entry.at === null ? [] : [entry.at]);
    return { read: entries.length > 0, at: times.length ? Math.min(...times) : null };
  }
  entries(identity) {
    let raw;
    try {
      raw = readFileSync(this.path(identity), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    return raw.split("\n").flatMap((line) => {
      if (!line) return [];
      try {
        const value = JSON.parse(line);
        const timed = value && typeof value === "object" && !Array.isArray(value) ? value : null;
        const ids = timed?.ids ?? value;
        return Array.isArray(ids) ? [{ ids: ids.filter((id) => typeof id === "string"), at: typeof timed?.at === "number" ? timed.at : null }] : [];
      } catch {
        return [];
      }
    });
  }
  append(identity, ids) {
    const release = storageLease(this.home);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 448 });
      appendFileSync(this.path(identity), `
${JSON.stringify({ ids, at: Date.now() })}
`, { mode: 384, flush: true });
    } finally {
      release();
    }
  }
};

// src/core/local-result-receipts.ts
var RESULT_HEADER = /^Subagent .+ (?:done|failed) after \d+s\./;
var LOCAL_RESULTS_DIR = "local-result-receipts";
var key = (name) => createHash2("sha256").update(name).digest("hex");
function recordLocalResult(home, message) {
  if (!message.from.id.startsWith("job:") || !RESULT_HEADER.test(message.body.split("\n")[0])) return;
  const path = join2(home, LOCAL_RESULTS_DIR, key(message.from.name), `${key(message.id)}.json`);
  const previous = readJsonStore(path);
  if (previous) return;
  writeJsonStore(path, { id: message.id, name: message.from.name, recipient: message.recipient, deliveredAt: message.createdAt }, previous);
}
function localResultReceipt(home, name, owner, after, before) {
  const dir = join2(home, LOCAL_RESULTS_DIR, key(name));
  if (!existsSync(dir)) return null;
  const records = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJsonStore(join2(dir, f))).filter((r) => isRecord(r) && typeof r.id === "string" && typeof r.recipient === "string" && typeof r.deliveredAt === "number" && (!owner || r.recipient === owner) && r.deliveredAt >= after && r.deliveredAt < before).sort((a, b) => b.deliveredAt - a.deliveredAt);
  const record = records[0];
  if (!record) return null;
  const receipt = new ReadJournal(home).receipt(`name:${record.recipient}`, record.id);
  return {
    status: receipt.read ? "read" : "delivered",
    messageId: record.id,
    recipient: record.recipient,
    deliveredAt: record.deliveredAt,
    readAt: receipt.at
  };
}

// src/core/job-outcomes.ts
var MAX_HOLD_REASON_CHARS = 2e3;
var JOB_OUTCOMES_DIR = "job-outcomes";
var JOB_OUTCOME_CONTRACT_VERSION = 1;
function decisionPath(home, job) {
  const key3 = createHash3("sha256").update(`${job.name}:${job.startedAt}`).digest("hex");
  return join3(home, JOB_OUTCOMES_DIR, `${key3}.json`);
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
    if (!existsSync2(file)) continue;
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
  const jobs = readStore(join3(home, JOBS_FILE), log, true);
  const out = {};
  for (const job of jobs) {
    if (names && !names.has(job.name)) continue;
    if (job.status !== "done" && job.status !== "failed") continue;
    out[job.name] = { startedAt: job.startedAt, status: job.status, outcome: await deriveJobOutcome(home, job, log) };
  }
  return out;
}

// src/core/worktree-state.ts
import { createHash as createHash4 } from "node:crypto";
import { lstatSync, mkdirSync as mkdirSync2 } from "node:fs";
import { join as join4, resolve } from "node:path";
var WORKTREE_STATE_CONTRACT = 1;
var key2 = (wt) => createHash4("sha256").update(resolve(wt.path).toLowerCase()).digest("hex");
var statePath = (home, wt) => join4(home, "worktree-state", `${key2(wt)}.json`);
var rootId = (path) => {
  const stat = lstatSync(path);
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
};
function readWorktreeState(home, wt) {
  const value = readHistoryJson(statePath(home, wt));
  if (!isRecord(value) || typeof value.version === "number" && value.version > JSON_STORE_VERSION || value.contractVersion !== WORKTREE_STATE_CONTRACT || value.path !== wt.path || value.repoRoot !== wt.repoRoot || value.base !== wt.base || typeof value.rootId !== "string" || !Array.isArray(value.libraries) || !value.libraries.every((p) => typeof p === "string") || typeof value.lastContinuation !== "number") return null;
  return value;
}
function saveWorktreeState(home, wt, value) {
  const path = statePath(home, wt);
  writeJsonStore(path, { ...value }, readJsonStore(path));
}
function recordWorktreeProcessProof(home, wt, stopped) {
  const state = readWorktreeState(home, wt);
  if (state) saveWorktreeState(home, wt, { ...state, processesStopped: stopped });
}
function invalidateWorktreePathProof(home, path) {
  const value = readHistoryJson(statePath(home, { path }));
  if (!isRecord(value) || typeof value.repoRoot !== "string" || typeof value.base !== "string") return;
  const wt = { path, cwd: path, repoRoot: value.repoRoot, base: value.base, branch: "" };
  const state = readWorktreeState(home, wt);
  if (state) saveWorktreeState(home, wt, { ...state, processesStopped: false, lastContinuation: Date.now() });
}
function worktreeLease(home, wt) {
  const dir = join4(home, "worktree-leases");
  mkdirSync2(dir, { recursive: true });
  const path = join4(dir, key2(wt));
  try {
    mkdirSync2(path);
  } catch {
    throw new Error("Worktree is running, closing, or has an unreconciled lease; kept unchanged.");
  }
  return () => {
    archiveFile(path);
  };
}

// src/core/job-close.ts
import { existsSync as existsSync3, lstatSync as lstatSync2 } from "node:fs";
import { dirname, isAbsolute, join as join5, relative, resolve as resolve2, sep } from "node:path";
async function recordWorktreeOrigin(home, wt, log) {
  assertPhysicalPath(wt.path);
  const files = (await git([...trustArgs(wt.path), "ls-files", "-z"], wt.path, log)).split("\0").filter(Boolean);
  const libraries = files.filter((file) => /(^|\/)ProjectSettings\/ProjectVersion\.txt$/.test(file)).map((file) => join5(dirname(dirname(file)), "Library")).filter((path) => {
    try {
      lstatSync2(join5(wt.path, path));
      return false;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      return true;
    }
  });
  saveWorktreeState(home, wt, { contractVersion: 1, path: wt.path, repoRoot: wt.repoRoot, base: wt.base, rootId: rootId(wt.path), libraries, lastContinuation: Date.now(), processesStopped: false });
}
var inside = (path, parent) => {
  const rel = relative(parent, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
async function inspect(wt, state, log) {
  assertPhysicalPath(wt.path);
  if (rootId(wt.path) !== state.rootId) throw new Error("Worktree root was replaced; provenance no longer applies.");
  if (permissionRepairPlan(wt.path).skipped.length) throw new Error("Linked or shared contents are kept.");
  const run = (args) => git([...trustArgs(wt.path), ...args], wt.path, log);
  if (await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) throw new Error("Uncommitted or non-ignored untracked files are kept.");
  const libraries = [];
  for (const file of state.libraries) {
    const path = resolve2(wt.path, file);
    if (!inside(path, wt.path) || path === resolve2(wt.path) || !/(^|[\\/])Library$/.test(file)) throw new Error("Invalid cache provenance; kept.");
    if (!existsSync3(path)) continue;
    if (!lstatSync2(path).isDirectory() || !existsSync3(join5(dirname(path), "ProjectSettings", "ProjectVersion.txt"))) throw new Error("Cache is no longer a Unity Library.");
    if (await run(["ls-files", "-z", "--", `:(literal)${file.replace(/\\/g, "/")}`])) throw new Error("Tracked Library contents are kept.");
    libraries.push(path);
  }
  const ignored = (await run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  for (const file of ignored) if (!libraries.some((lib) => inside(resolve2(wt.path, file), lib))) throw new Error("Unknown ignored files may contain user data; kept.");
  const head = await run(["rev-parse", "HEAD"]);
  const currentBranch = await run(["symbolic-ref", "--short", "HEAD"]);
  const reflog = await run(["reflog", "show", "--format=%H", "HEAD"]);
  if (!reflog) throw new Error("Worktree commit history unavailable; kept.");
  const branch = await run(["rev-parse", "--verify", wt.branch]);
  const commits = [.../* @__PURE__ */ new Set([head, branch, ...reflog.split(/\r?\n/).filter(Boolean)])];
  if (!commits.every((sha) => /^[a-f0-9]{40,64}$/.test(sha))) throw new Error("Invalid commit history; kept.");
  return { libraries, head, branch: currentBranch, commits };
}
async function closeJobWorktree(opts) {
  if (!opts.enabled) return { action: "disabled", reason: "jobCloseCleanup is off" };
  const wt = opts.job.worktree;
  if (!wt || opts.job.remote || !["done", "failed"].includes(opts.job.status) || opts.job.queue?.length) return { action: "kept", reason: "Only a finished local worktree job without queued continuations can close." };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(opts.job.name)) return { action: "kept", reason: "Invalid job branch name." };
  let release;
  try {
    release = worktreeLease(opts.home, wt);
    const state = readWorktreeState(opts.home, wt);
    if (!state) return { action: "kept", reason: "No supported worktree provenance; legacy worktrees are kept." };
    if (state.reapedAt && !existsSync3(wt.path)) return { action: "reaped", reason: "Already safely reaped.", pushed: state.pushed };
    if (state.processesStopped !== true) return { action: "kept", reason: "Job process shutdown is unproven; worktree retained." };
    const before = await inspect(wt, state, opts.log);
    const run = (args) => git([...trustArgs(wt.repoRoot), ...args], wt.repoRoot, opts.log);
    const pushed = [{ ref: `refs/heads/wip/${opts.job.name}`, sha: before.head }];
    for (const sha of before.commits) {
      try {
        await run(["merge-base", "--is-ancestor", sha, before.head]);
      } catch {
        pushed.push({ ref: `refs/heads/wip/${opts.job.name}-history-${sha}`, sha });
      }
    }
    await run(["push", "origin", ...pushed.map(({ ref, sha }) => `${sha}:${ref}`)]);
    const remote = await run(["ls-remote", "--heads", "origin", ...pushed.map((p) => p.ref)]);
    const refs = new Map(remote.split(/\r?\n/).filter(Boolean).map((line) => {
      const [sha, ref] = line.split(/\s+/);
      return [ref, sha];
    }));
    if (!pushed.every((p) => refs.get(p.ref) === p.sha)) throw new Error("Remote commit verification failed; kept.");
    const after = await inspect(wt, state, opts.log);
    if (after.head !== before.head || after.branch !== before.branch || after.commits.join() !== before.commits.join() || after.libraries.join() !== before.libraries.join()) throw new Error("Worktree changed while pushing; kept.");
    saveWorktreeState(opts.home, wt, { ...state, closedAt: Date.now(), pushed, resumeBranch: before.branch });
    for (const path of after.libraries) removeWorktreeDirectory(path, wt.path);
    await run(["worktree", "remove", wt.path]);
    saveWorktreeState(opts.home, wt, { ...state, closedAt: Date.now(), reapedAt: Date.now(), pushed, resumeBranch: before.branch });
    return { action: "reaped", reason: "All worktree commits verified on pushed branches; clean checkout removed; local branches retained.", pushed };
  } catch (err) {
    return { action: "kept", reason: err.message };
  } finally {
    release?.();
  }
}
async function prepareWorktreeContinuation(home, wt, log) {
  let state = readWorktreeState(home, wt);
  if (!existsSync3(wt.path)) {
    if (!state?.reapedAt || !state.pushed?.length) throw new Error("Worktree is missing without a verified reap record; recreate it explicitly.");
    const branch = state.resumeBranch ?? wt.branch;
    await git([...trustArgs(wt.repoRoot), "worktree", "add", wt.path, branch], wt.repoRoot, log);
    wt.branch = branch;
    await recordWorktreeOrigin(home, wt, log);
    state = readWorktreeState(home, wt);
  }
  assertPhysicalPath(wt.path);
  if (state && rootId(wt.path) !== state.rootId) throw new Error("Worktree root was replaced; restore isolation before continuing.");
  if (state) saveWorktreeState(home, wt, { ...state, lastContinuation: Date.now(), closedAt: void 0, reapedAt: void 0, processesStopped: false });
}

// src/mcp/job-host.ts
import { spawn } from "node:child_process";
import { mkdirSync as mkdirSync3, readdirSync as readdirSync2, statSync } from "node:fs";
import { join as join7 } from "node:path";

// src/mcp/remote-job-host.ts
import { join as join6 } from "node:path";

// src/network/remote-job-protocol.ts
var REMOTE_JOB_CAPABILITY = "remote-jobs-v1";
var REMOTE_JOB_FRAME = "remote-job";
var REMOTE_JOB_POLL_MS = 2e3;
var REMOTE_JOB_REQUEST_TIMEOUT_MS = 3e4;
var REMOTE_JOB_LOCAL_TIMEOUT_MS = REMOTE_JOB_REQUEST_TIMEOUT_MS + 5e3;
var REMOTE_JOB_RATE_WINDOW_MS = 6e4;
var REMOTE_JOB_RATE_LIMIT = 600;
var REMOTE_JOB_SPAWN_LIMIT = 10;
var MAX_REMOTE_JOBS = 200;
var MAX_PATH_CHARS = 4096;
var MAX_TITLE_CHARS = 120;
var remoteSpawnArgsSchema = external_exports.object({
  prompt: external_exports.string().min(1).max(MAX_BODY_CHARS),
  title: external_exports.string().min(1).max(MAX_TITLE_CHARS),
  cwd: external_exports.string().min(1).max(MAX_PATH_CHARS),
  model: external_exports.string().regex(MODEL_NAME_PATTERN).optional(),
  effort: external_exports.string().regex(/^[A-Za-z0-9_-]{1,20}$/).optional(),
  session_id: external_exports.string().min(1).max(MAX_PATH_CHARS).optional(),
  timeout_sec: external_exports.number().int().min(10).max(MAX_JOB_TIMEOUT_SEC).optional(),
  access: external_exports.enum(["read", "ask", "edit"]).optional(),
  worktree: external_exports.boolean().optional(),
  allow_tools: external_exports.array(external_exports.string().min(1).max(200)).max(50).optional(),
  sandbox: external_exports.enum(CODEX_SANDBOXES).optional(),
  permission_mode: external_exports.enum(CLAUDE_PERMISSION_MODES).optional(),
  auto_approve: external_exports.boolean().optional(),
  native_subagents: external_exports.number().int().min(0).max(MAX_CODEX_SUBAGENTS).optional(),
  approvals_reviewer: external_exports.enum(CODEX_APPROVALS_REVIEWERS).optional()
}).strict();
var settingsSchema = external_exports.record(external_exports.string(), external_exports.unknown());
var remoteControlSchema = external_exports.discriminatedUnion("type", [
  external_exports.object({ type: external_exports.literal("message"), body: external_exports.string().min(1).max(MAX_BODY_CHARS), cid: external_exports.uuid() }).strict(),
  external_exports.object({ type: external_exports.literal("cancel") }).strict(),
  external_exports.object({ type: external_exports.literal("attach") }).strict(),
  external_exports.object({ type: external_exports.literal("title"), title: external_exports.string().min(1).max(MAX_TITLE_CHARS) }).strict(),
  external_exports.object({ type: external_exports.literal("effort"), effort: external_exports.string().regex(/^[A-Za-z0-9_-]{1,20}$/) }).strict(),
  external_exports.object({ type: external_exports.literal("settings"), settings: settingsSchema }).strict()
]);
var remoteJobRequestSchema = external_exports.discriminatedUnion("op", [
  external_exports.object({ op: external_exports.literal("spawn"), job: external_exports.string().regex(/^[0-9a-f]{8}$/), target: external_exports.enum(CODING_AGENTS), args: remoteSpawnArgsSchema }).strict(),
  external_exports.object({ op: external_exports.literal("state"), job: external_exports.string().regex(/^[0-9a-f]{8}$/) }).strict(),
  external_exports.object({ op: external_exports.literal("control"), job: external_exports.string().regex(/^[0-9a-f]{8}$/), control: remoteControlSchema }).strict(),
  external_exports.object({ op: external_exports.literal("approval"), job: external_exports.string().regex(/^[0-9a-f]{8}$/), id: external_exports.uuid(), decision: external_exports.enum(["allow", "deny"]), reason: external_exports.string().max(4e3).optional() }).strict()
]);
var worktreeSchema = external_exports.object({ repoRoot: external_exports.string(), path: external_exports.string(), cwd: external_exports.string(), branch: external_exports.string(), base: external_exports.string(), baseBranch: external_exports.string().nullable().optional() });
var remoteJobSnapshotSchema = external_exports.object({
  alive: external_exports.boolean(),
  state: external_exports.object({
    pid: external_exports.number().int().nonnegative(),
    peer: external_exports.string().regex(NETWORK_NAME_PATTERN),
    status: external_exports.enum(["running", "done", "failed"]),
    updatedAt: external_exports.number().nonnegative(),
    model: external_exports.string().nullable().optional(),
    sessionId: external_exports.string().nullable().optional(),
    workdir: external_exports.string().nullable().optional(),
    worktree: worktreeSchema.nullable().optional(),
    progress: external_exports.string().nullable().optional(),
    percent: external_exports.number().min(0).max(100).optional(),
    progressNote: external_exports.string().optional(),
    etaAt: external_exports.number().finite().nonnegative().optional(),
    etaReportedAt: external_exports.number().finite().nonnegative().optional(),
    asking: external_exports.boolean().optional(),
    live: external_exports.boolean().optional(),
    seen: external_exports.array(external_exports.string()).optional(),
    report: external_exports.string().optional(),
    delivered: external_exports.boolean().optional(),
    finishedAt: external_exports.number().optional()
  }).nullable(),
  approvals: external_exports.array(external_exports.object({ id: external_exports.uuid(), owner: external_exports.string(), job: external_exports.string(), agent: external_exports.string(), tool: external_exports.string(), command: external_exports.string(), reason: external_exports.string(), askedAt: external_exports.number(), deadline: external_exports.number() })).max(50)
});
var remoteJobWireSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("request"), rid: external_exports.uuid(), peer: external_exports.object({ id: external_exports.string().min(1).max(MAX_PATH_CHARS), name: external_exports.string().regex(NETWORK_NAME_PATTERN), supervisor: external_exports.string().min(1).max(MAX_PATH_CHARS) }).strict(), request: remoteJobRequestSchema }).strict(),
  external_exports.object({ kind: external_exports.literal("response"), rid: external_exports.uuid(), value: external_exports.unknown().optional(), error: external_exports.string().max(MAX_PATH_CHARS).optional() }).strict()
]);

// src/mcp/remote-job-host.ts
var REMOTE_STATE_GRACE_MS = 9e4;
var RemoteJobHost = class {
  constructor(node, home, log) {
    this.node = node;
    this.home = home;
    this.log = log;
  }
  node;
  home;
  log;
  busy = /* @__PURE__ */ new Set();
  cache = /* @__PURE__ */ new Map();
  path(job) {
    return join6(this.home, "remote-job-states", `${job.id}.json`);
  }
  read(job) {
    return this.cache.get(job.id) ?? readJsonStore(this.path(job));
  }
  save(job, snapshot) {
    const data = { fetchedAt: Date.now(), snapshot };
    this.cache.set(job.id, data);
    writeJsonStore(this.path(job), data, readJsonStore(this.path(job)));
  }
  start(job, host, target, args) {
    job.remote = { host, name: `${target}-job-${job.id}` };
    this.cache.delete(job.id);
    this.save(job, { state: null, alive: true, approvals: [] });
    const raw = { ...args, cwd: args.cwd ?? job.workdir };
    for (const key3 of ["host", "_job", "_worktree", "send_to"]) delete raw[key3];
    const request = { op: "spawn", job: job.id, target, args: remoteSpawnArgsSchema.parse(raw) };
    this.busy.add(job.id);
    void this.node.remoteJob(host, request).then((snapshot) => {
      this.save(job, snapshot);
      if (job.controller.signal.aborted) this.send(job, { type: "cancel" });
    }, (err) => {
      this.save(job, { state: { pid: 0, peer: `${host}/${job.name}`, status: "failed", updatedAt: Date.now(), report: `Remote job failed: ${err.message}`, delivered: false }, alive: false, approvals: [] });
    }).finally(() => this.busy.delete(job.id));
    return { pid: null, peer: `${host}/${job.name}`, startedAt: Date.now() };
  }
  state(job) {
    const cached = this.read(job);
    if (!this.busy.has(job.id) && (!cached || Date.now() - cached.fetchedAt >= REMOTE_JOB_POLL_MS)) this.sendRequest(job, { op: "state", job: job.id });
    return cached?.snapshot.state ?? null;
  }
  alive(job) {
    const cached = this.read(job);
    return cached ? cached.snapshot.alive && Date.now() - cached.fetchedAt < REMOTE_STATE_GRACE_MS : Date.now() - (job.host?.startedAt ?? 0) < REMOTE_STATE_GRACE_MS;
  }
  send(job, control) {
    this.sendRequest(job, { op: "control", job: job.id, control });
  }
  sendRequest(job, request) {
    if (!job.remote) return;
    if (request.op === "state") this.busy.add(job.id);
    void this.node.remoteJob(job.remote.host, request).then((snapshot) => this.save(job, snapshot), (err) => {
      this.log.warn("remote job request failed", { job: job.name, host: job.remote?.host, operation: request.op, err: err.message });
    }).finally(() => {
      if (request.op === "state") this.busy.delete(job.id);
    });
  }
};

// src/mcp/job-host.ts
var RUNNERS_DIR_NAME = "jobs";
var JOB_PEER_PREFIX = "job:";
var CONTROL_CONVERSATION_PREFIX = "jobctl-";
var RUNNER_HEARTBEAT_MS = 15e3;
var STALE_MS = 6 * RUNNER_HEARTBEAT_MS;
var START_GRACE_MS = 3e4;
var KEEP_FILES_MS = 7 * 24 * 60 * 60 * 1e3;
var DETACH_LAUNCHER = "require('node:child_process').spawn(process.execPath,process.argv.slice(1),{detached:true,stdio:'ignore',windowsHide:true}).unref()";
function runnerStatePath(home, id) {
  return join7(home, RUNNERS_DIR_NAME, `${id}.json`);
}
function specPath(home, id) {
  return join7(home, RUNNERS_DIR_NAME, `${id}.spec.json`);
}
function readRunnerState(home, id) {
  try {
    const s = readJsonStore(runnerStatePath(home, id), void 0, (value) => isRecord(value) && typeof value.pid === "number" && typeof value.status === "string");
    return s && typeof s.pid === "number" && typeof s.status === "string" ? s : null;
  } catch {
    return null;
  }
}
function writeRunnerState(home, id, state) {
  const path = runnerStatePath(home, id);
  const previous = readJsonStore(path);
  writeJsonStore(path, mergeStoreFields(isRecord(previous) ? previous : {}, { ...state }), previous);
}
var JobRunners = class {
  constructor(node, home, cli, log) {
    this.node = node;
    this.home = home;
    this.cli = cli;
    this.log = log;
    this.remote = new RemoteJobHost(node, home, log);
    try {
      const dir = join7(home, RUNNERS_DIR_NAME);
      const keepMs = retentionLimit("AGENT_BRIDGE_RUNNER_KEEP_MS", KEEP_FILES_MS);
      if (!keepMs) return;
      for (const f of readdirSync2(dir)) {
        const path = join7(dir, f);
        if (!f.endsWith(".json") || f.endsWith(".spec.json") || Date.now() - statSync(path).mtimeMs <= keepMs) continue;
        const id = f.replace(/\.json$/, "");
        const state = readRunnerState(home, id);
        if (state?.status === "done" || state?.status === "failed") {
          archiveFile(path);
          archiveFile(specPath(home, id));
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") this.log.warn("could not archive runner files", { err: String(err) });
    }
  }
  node;
  home;
  cli;
  log;
  remote;
  /** Start a turn of this job in a new runner; null when that is not possible (the turn then runs in the server). */
  start(job, spec) {
    if (spec.args.host) return this.remote.start(job, spec.args.host, spec.target, spec.args);
    try {
      mkdirSync3(join7(this.home, RUNNERS_DIR_NAME), { recursive: true });
      const statePath2 = runnerStatePath(this.home, job.id);
      const file = specPath(this.home, job.id);
      assertWritableStore(readJsonStore(statePath2, this.log));
      assertWritableStore(readJsonStore(file, this.log));
      archiveFile(statePath2);
      const full = {
        ...spec,
        home: this.home,
        job: {
          id: job.id,
          name: job.name,
          agent: job.agent,
          model: job.model,
          prompt: job.prompt,
          startedAt: job.startedAt,
          args: job.args,
          sessionId: job.sessionId,
          workdir: job.workdir,
          worktree: job.worktree,
          owner: job.owner,
          supervisor: job.supervisor,
          metadataVersion: job.metadataVersion,
          parentJob: job.parentJob,
          rootSession: job.rootSession,
          rootName: job.rootName,
          allowedServers: [...job.allowedServers ?? []]
        }
      };
      archiveFile(file);
      writeJsonStore(file, { ...full }, null);
      const args = [this.cli, "job-runner", file];
      let pid = null;
      if (process.platform === "win32") {
        const launcher = spawn(process.execPath, ["-e", DETACH_LAUNCHER, ...args], { stdio: "ignore", windowsHide: true });
        launcher.on("error", (err) => this.log.warn("could not start a job runner", { job: job.name, err: err.message }));
      } else {
        const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
        child.on("error", (err) => this.log.warn("could not start a job runner", { job: job.name, err: err.message }));
        child.unref();
        pid = child.pid ?? null;
      }
      this.log.info("job runner started", { job: job.name, pid });
      return { pid, peer: job.name, startedAt: Date.now() };
    } catch (err) {
      this.log.warn("job runner unavailable; the subagent runs inside this server", { job: job.name, err: err.message });
      return null;
    }
  }
  state(job) {
    if (job.remote) return this.remote.state(job);
    return readRunnerState(this.home, job.id);
  }
  alive(job, state) {
    if (job.remote) return this.remote.alive(job);
    if (!state) {
      const host = job.host;
      return Boolean(host) && Date.now() - host.startedAt < START_GRACE_MS && (host.pid === null || pidAlive(host.pid));
    }
    return pidAlive(state.pid) && Date.now() - state.updatedAt < STALE_MS;
  }
  send(job, control) {
    if (job.remote) return this.remote.send(job, control);
    const to = this.state(job)?.peer ?? job.host?.peer ?? job.name;
    this.node.send({ to, body: JSON.stringify(control), conversationId: `${CONTROL_CONVERSATION_PREFIX}${job.id}` }, { quiet: true }).catch((err) => this.log.warn("could not reach the job runner", { job: job.name, control: control.type, err: err.message }));
  }
  kill(job) {
    if (job.remote) return this.remote.send(job, { type: "cancel" });
    const pid = this.state(job)?.pid ?? job.host?.pid;
    if (pid) killPid(pid, this.log);
  }
};

export {
  ReadJournal,
  recordLocalResult,
  MAX_HOLD_REASON_CHARS,
  JOB_OUTCOME_CONTRACT_VERSION,
  readOutcomeDecision,
  setJobOutcome,
  deriveJobOutcome,
  listJobOutcomes,
  readWorktreeState,
  recordWorktreeProcessProof,
  invalidateWorktreePathProof,
  worktreeLease,
  recordWorktreeOrigin,
  closeJobWorktree,
  prepareWorktreeContinuation,
  REMOTE_JOB_CAPABILITY,
  REMOTE_JOB_FRAME,
  REMOTE_JOB_POLL_MS,
  REMOTE_JOB_REQUEST_TIMEOUT_MS,
  REMOTE_JOB_LOCAL_TIMEOUT_MS,
  REMOTE_JOB_RATE_WINDOW_MS,
  REMOTE_JOB_RATE_LIMIT,
  REMOTE_JOB_SPAWN_LIMIT,
  MAX_REMOTE_JOBS,
  remoteSpawnArgsSchema,
  remoteJobRequestSchema,
  remoteJobSnapshotSchema,
  remoteJobWireSchema,
  RUNNERS_DIR_NAME,
  JOB_PEER_PREFIX,
  CONTROL_CONVERSATION_PREFIX,
  RUNNER_HEARTBEAT_MS,
  readRunnerState,
  writeRunnerState,
  JobRunners
};
