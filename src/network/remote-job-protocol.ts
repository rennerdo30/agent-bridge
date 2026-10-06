import { z } from "zod";
import { MODEL_NAME_PATTERN, CLAUDE_PERMISSION_MODES, CODEX_SANDBOXES } from "../core/config.js";
import { MAX_BODY_CHARS, MAX_JOB_TIMEOUT_SEC } from "../core/constants.js";
import { CODING_AGENTS } from "../core/protocol.js";
import { NETWORK_NAME_PATTERN } from "./constants.js";

export const REMOTE_JOB_CAPABILITY = "remote-jobs-v1";
export const REMOTE_JOB_FRAME = "remote-job";
export const REMOTE_JOB_POLL_MS = 2_000;
export const REMOTE_JOB_REQUEST_TIMEOUT_MS = 30_000;
export const REMOTE_JOB_LOCAL_TIMEOUT_MS = REMOTE_JOB_REQUEST_TIMEOUT_MS + 5_000;
export const REMOTE_JOB_RATE_WINDOW_MS = 60_000;
export const REMOTE_JOB_RATE_LIMIT = 600;
export const REMOTE_JOB_SPAWN_LIMIT = 10;
export const MAX_REMOTE_JOBS = 200;
const MAX_PATH_CHARS = 4_096;
const MAX_TITLE_CHARS = 120;

/** The wire accepts only documented spawn options, never binaries, env, shell commands or internal args. */
export const remoteSpawnArgsSchema = z.object({
  prompt: z.string().min(1).max(MAX_BODY_CHARS), title: z.string().min(1).max(MAX_TITLE_CHARS),
  cwd: z.string().min(1).max(MAX_PATH_CHARS), model: z.string().regex(MODEL_NAME_PATTERN).optional(),
  effort: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/).optional(),
  session_id: z.string().min(1).max(MAX_PATH_CHARS).optional(),
  timeout_sec: z.number().int().min(10).max(MAX_JOB_TIMEOUT_SEC).optional(),
  access: z.enum(["read", "ask", "edit"]).optional(), worktree: z.boolean().optional(),
  allow_tools: z.array(z.string().min(1).max(200)).max(50).optional(),
  sandbox: z.enum(CODEX_SANDBOXES).optional(), permission_mode: z.enum(CLAUDE_PERMISSION_MODES).optional(),
  auto_approve: z.boolean().optional(),
}).strict();
const settingsSchema = z.record(z.string(), z.unknown());
export const remoteControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), body: z.string().min(1).max(MAX_BODY_CHARS), cid: z.uuid() }).strict(),
  z.object({ type: z.literal("cancel") }).strict(),
  z.object({ type: z.literal("attach") }).strict(),
  z.object({ type: z.literal("title"), title: z.string().min(1).max(MAX_TITLE_CHARS) }).strict(),
  z.object({ type: z.literal("effort"), effort: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/) }).strict(),
  z.object({ type: z.literal("settings"), settings: settingsSchema }).strict(),
]);
export const remoteJobRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("spawn"), job: z.string().regex(/^[0-9a-f]{8}$/), target: z.enum(CODING_AGENTS), args: remoteSpawnArgsSchema }).strict(),
  z.object({ op: z.literal("state"), job: z.string().regex(/^[0-9a-f]{8}$/) }).strict(),
  z.object({ op: z.literal("control"), job: z.string().regex(/^[0-9a-f]{8}$/), control: remoteControlSchema }).strict(),
  z.object({ op: z.literal("approval"), job: z.string().regex(/^[0-9a-f]{8}$/), id: z.uuid(), decision: z.enum(["allow", "deny"]), reason: z.string().max(4_000).optional() }).strict(),
]);
export type RemoteJobRequest = z.infer<typeof remoteJobRequestSchema>;
const worktreeSchema = z.object({ repoRoot: z.string(), path: z.string(), cwd: z.string(), branch: z.string(), base: z.string(), baseBranch: z.string().nullable().optional() });
export const remoteJobSnapshotSchema = z.object({
  alive: z.boolean(),
  state: z.object({ pid: z.number().int().nonnegative(), peer: z.string().regex(NETWORK_NAME_PATTERN), status: z.enum(["running", "done", "failed"]), updatedAt: z.number().nonnegative(),
    model: z.string().nullable().optional(), sessionId: z.string().nullable().optional(), workdir: z.string().nullable().optional(), worktree: worktreeSchema.nullable().optional(),
    progress: z.string().nullable().optional(), percent: z.number().min(0).max(100).optional(), progressNote: z.string().optional(), asking: z.boolean().optional(), live: z.boolean().optional(),
    seen: z.array(z.string()).optional(), report: z.string().optional(), delivered: z.boolean().optional(), finishedAt: z.number().optional() }).nullable(),
  approvals: z.array(z.object({ id: z.uuid(), owner: z.string(), job: z.string(), agent: z.string(), tool: z.string(), command: z.string(), reason: z.string(), askedAt: z.number(), deadline: z.number() })).max(50),
});
export const remoteJobWireSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request"), rid: z.uuid(), peer: z.object({ id: z.string().min(1).max(MAX_PATH_CHARS), name: z.string().regex(NETWORK_NAME_PATTERN), supervisor: z.string().min(1).max(MAX_PATH_CHARS) }).strict(), request: remoteJobRequestSchema }).strict(),
  z.object({ kind: z.literal("response"), rid: z.uuid(), value: z.unknown().optional(), error: z.string().max(MAX_PATH_CHARS).optional() }).strict(),
]);
