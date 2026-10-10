import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  CLAUDE_PERMISSION_MODES,
  CODEX_APPROVALS_REVIEWERS,
  CODEX_SANDBOXES,
  MODEL_NAME_PATTERN,
  NETWORK_NAME_PATTERN
} from "./chunk-6KUEP77F.mjs";
import {
  CODING_AGENTS
} from "./chunk-4QXHCXBU.mjs";
import {
  external_exports
} from "./chunk-FDMEMG4Z.mjs";
import {
  MAX_BODY_CHARS,
  MAX_CODEX_SUBAGENTS,
  MAX_JOB_TIMEOUT_SEC
} from "./chunk-GWP4RZPO.mjs";

// src/network/remote-job-protocol.ts
var REMOTE_JOB_CAPABILITY = "remote-jobs-v1";
var REMOTE_JOB_CANCELLED_CAPABILITY = "remote-jobs-cancelled-v1";
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
  notes: external_exports.enum(["none", "milestones", "blockers"]).optional(),
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
function remoteSnapshotForPeer(snapshot, supportsCancelled) {
  if (!snapshot.state || snapshot.state.status !== "cancelled" || supportsCancelled) return snapshot;
  return { ...snapshot, state: { ...snapshot.state, status: "failed", report: snapshot.state.report ? snapshot.state.report.replace(/^(Subagent .+) cancelled after /, "$1 failed after ") + "\n\nCause: cancelled (legacy paired broker status compatibility)." : "Cancelled (legacy paired broker status compatibility)." } };
}
var worktreeSchema = external_exports.object({ repoRoot: external_exports.string(), path: external_exports.string(), cwd: external_exports.string(), branch: external_exports.string(), base: external_exports.string(), baseBranch: external_exports.string().nullable().optional() });
var remoteJobSnapshotSchema = external_exports.object({
  alive: external_exports.boolean(),
  state: external_exports.object({
    pid: external_exports.number().int().nonnegative(),
    peer: external_exports.string().regex(NETWORK_NAME_PATTERN),
    status: external_exports.enum(["running", "done", "failed", "cancelled"]),
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
  REMOTE_JOB_CAPABILITY,
  REMOTE_JOB_CANCELLED_CAPABILITY,
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
  remoteSnapshotForPeer,
  remoteJobSnapshotSchema,
  remoteJobWireSchema
};
