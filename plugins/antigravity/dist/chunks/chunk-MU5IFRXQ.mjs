import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  CLAUDE_PERMISSION_MODES,
  CODEX_APPROVALS_REVIEWERS,
  CODEX_SANDBOXES,
  MODEL_NAME_PATTERN,
  NETWORK_NAME_PATTERN
} from "./chunk-MZMJORKC.mjs";
import {
  CODING_AGENTS
} from "./chunk-SOPZATYP.mjs";
import {
  external_exports
} from "./chunk-FDMEMG4Z.mjs";
import {
  isRecord,
  readJsonStore,
  storageLease,
  writeJsonStore
} from "./chunk-4BCYRJ3A.mjs";
import {
  MAX_BODY_CHARS,
  MAX_CODEX_SUBAGENTS,
  MAX_JOB_TIMEOUT_SEC
} from "./chunk-X27LYYGH.mjs";

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
import { createHash as createHash2 } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join as join2 } from "node:path";
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

export {
  ReadJournal,
  RESULT_HEADER,
  recordLocalResult,
  localResultReceipt,
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
  remoteJobWireSchema
};
