import { currentDelegateDepth, isClaudeReadOnly } from "../core/delegate.js";
import type { ClaudePermissionMode } from "../core/config.js";
import { MAX_DELEGATE_DEPTH_LIMIT } from "../core/constants.js";
import { requestIdentity, type PermissionRequest } from "../core/relay.js";
import { mcpToolOf, isOwnServerCall, shortServer } from "../core/tool-allow.js";
import type { ApprovalOrigin, Job } from "./jobs.js";

/**
 * Reuse of identical approvals within one job (AB-402). When a job asks its supervisor for an approval that is
 * identical to one the supervisor or the owner already allowed in that same job, the earlier grant answers it
 * and the reuse is logged with the original approval id. Only what is provably the same action is reused:
 *
 * - the identity is the exact request as its source encodes it (every field of the tool input, the raw command
 *   line with its shell wrapper and folder), bound to the text the supervisor was shown; a request without one
 *   (a summary, a file change, a reviewer refusal, a sandbox permission request) is always asked;
 * - a grant never crosses jobs, a change of access, sandbox or permission settings, or a change of supervisor
 *   (read from the durable job store, so a handoff ends it); it ends when the job's turn finishes;
 * - a command grant (anything but an MCP tool) is kept and reused only while the job's settings are read-only
 *   (see readOnlyJob), checked when it is granted and again when it is reused. What a command runs can change
 *   only through files; a read-only job changes files only through an approval it asks for, so any allowed file
 *   change, other command, request without an exact identity or MCP call to a server other than the Pair Desk
 *   (allowed in any way) ends the job's command grants. A call to the job's own agent-bridge server other than a
 *   read or status tool (spawn_*, ask_*, message_subagent, decide, ...) ends them and blocks new ones for the rest
 *   of the turn: a child job may change the job's files. Nothing on this path
 *   runs Git or reads the job's files: job-controlled repositories can run code through Git (core.fsmonitor,
 *   filters) and hide files from it;
 * - a deny is never reused, and any later deny of the same request revokes its grant.
 */

/** Who may stand behind a reusable "allow": the supervisor (decide) or the owner (dashboard, native dialog). */
const EXPLICIT_DECIDERS: ReadonlySet<string> = new Set(["MCP decide", "dashboard", "user in session"]);
/** Grants kept per job; the oldest goes first. */
export const MAX_APPROVAL_GRANTS = 64;
/** Requests that change files, by source: Codex app-server, Claude and Codex hooks, opencode. */
const FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set(["edit", "Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch", "write", "patch", "multiedit"]);

export interface ApprovalGrant {
  identity: string;
  /** The approval id of the explicit decision that granted it. */
  approvalId: string;
  by: string;
  at: number;
  /** A command grant (anything but an MCP tool): reused only in a read-only job. */
  command: boolean;
  /** How often it was reused; the first reuse wakes the supervisor. */
  reuses: number;
}

/** Memory only: a job's grants for one scope (its access, sandbox and permission settings and its supervisor). */
export interface ApprovalGrants {
  jobId: string;
  scope: string;
  grants: ApprovalGrant[];
}

/**
 * The exact identity of a request, or null when it has none: a reviewer refusal that needs an explicit decision, a
 * summary or file change (`inexact`), cut text, a source that sent no identity, or a sandbox permission request.
 * It binds the asking agent, the tool, the folder, the text the supervisor saw and the source's exact identity;
 * nothing is normalized beyond the source's own encoding.
 */
export function approvalIdentity(r: PermissionRequest): string | null {
  if (r.automaticReview || r.inexact || r.detailLength !== undefined) return null;
  if (!r.identity || !r.detail) return null;
  if (!r.tool || r.tool === "unknown" || r.tool === "approval" || r.tool === "permissions") return null;
  return requestIdentity([r.agent, r.tool, r.cwd ?? "", r.detail, r.identity]);
}

/** A request that changes files: never reused, and it ends every command grant of the job. */
export function isFileChangeRequest(r: Pick<PermissionRequest, "tool">): boolean {
  return FILE_CHANGE_TOOLS.has(r.tool);
}

/** A command request: anything but an MCP tool. Its effect depends on the job's files. */
export function isCommandRequest(r: Pick<PermissionRequest, "tool">): boolean {
  return !r.tool.startsWith("mcp:");
}

/** The settings a grant was made under (the Codex reviewer included); any change of them starts with no grants. */
export function approvalScope(parts: { access?: string; sandbox?: string; permission: string; reviewer?: string; supervisor: string }): string {
  return JSON.stringify([parts.access ?? "default", parts.sandbox ?? "", parts.permission, parts.reviewer ?? "", parts.supervisor]);
}

/** Whether an MCP server (as a request names it) is the Pair Desk server, which writes only to the desk. */
export function isDeskServer(server: string): boolean {
  return shortServer(server) === "pair-desk";
}

/** Tools of the job's own agent-bridge server that only read or report status: they cannot reach the job's files. */
const OWN_READ_TOOLS: ReadonlySet<string> = new Set(["send", "report_progress", "peers", "health", "search_history", "get_conversation",
  "inbox", "wait_for_message", "decisions", "list_models", "usage_limits", "network_status", "resource_slots"]);

/**
 * What an allowed MCP call means for the job's command grants (AB-402): "keep" for a Pair Desk call or a read or
 * status tool of the job's own agent-bridge server, "block" for any other own-server call (spawn_*, ask_*,
 * message_subagent, decide: a child job may change files; the grants end and none are kept for the rest of the
 * turn), "drop" for any other MCP call (its server may write files). Null for a request that is no MCP call.
 */
export function mcpCallEffect(r: Pick<PermissionRequest, "tool" | "detail">): "keep" | "drop" | "block" | null {
  const call = mcpToolOf(r);
  if (!call) return null;
  if (isOwnServerCall(r)) return call.tool && OWN_READ_TOOLS.has(call.tool) ? "keep" : "block";
  return isDeskServer(call.server) ? "keep" : "drop";
}

/**
 * Whether a job started from this process can start or continue subagents of its own: its bridge server registers
 * spawn_*, ask_*, message_subagent and decide while the job's depth (this process's + 1) is below the limit
 * (server.ts). Such a job may change files through a child job that it approves itself.
 */
export function jobCanSpawn(maxDelegateDepth: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return currentDelegateDepth(env) + 1 < Math.min(maxDelegateDepth, MAX_DELEGATE_DEPTH_LIMIT);
}

/** An allow pattern that cannot reach the job's files: the Pair Desk server writes only to the desk. */
function deskOnlyPattern(pattern: string): boolean {
  const p = pattern.trim();
  return p === "pair-desk:worker" || p === "pair-desk" || /^pair-desk\.[\w*.-]+$/.test(p);
}

/**
 * Whether the job's settings let it change files only through an approval it asks for (AB-402), from its target,
 * effective permission (DelegationTarget.permission), the patterns of MCP tools it may call without asking, the MCP
 * servers already allowed for the rest of the job, and whether it can start subagents. Read-only:
 * - The job cannot start or continue subagents (canSpawn false: its delegate depth reached the limit). A job with
 *   spawn_* or message_subagent may start a child job with edit access in the same folder and answer that child's
 *   approvals itself.
 * - No MCP server other than the Pair Desk is in allowedServers (one "allow" of a server covers the rest of the job).
 * - Codex: the effective sandbox is "read-only" (access read or ask, or sandbox "read-only", or the configured
 *   codexSandbox when neither is given) and the approvals reviewer is "user" (auto_review lets a reviewer model
 *   approve requests). workspace-write and danger-full-access are not.
 * - Claude: the permission mode is default, manual or plan (the bridge denies Write, Edit, MultiEdit,
 *   NotebookEdit, Bash and PowerShell in these). acceptEdits, auto, dontAsk and bypassPermissions are not.
 * - opencode: the effective permission is "read-only" (edit and bash need a permission request, which is asked or
 *   refused). auto-approve is not.
 * - Antigravity: access read or ask, without bypass_permissions (true or false). Muse: access read or ask, without
 *   a permission_profile.
 * - Every auto-approved MCP pattern (autoApproveTools, allow_tools or the default allowance) names only the Pair
 *   Desk server ("pair-desk", "pair-desk.<tool>" or "pair-desk:worker"); any other pattern may let the job write
 *   files without asking.
 * Anything else, including an unknown target or permission, is not read-only (fail closed).
 */
export function readOnlyJob(job: {
  target: string;
  permission: string;
  permissionProfile?: string;
  bypassPermissions?: boolean;
  approvalsReviewer?: string;
  allowPatterns: readonly string[];
  allowedServers: readonly string[];
  canSpawn: boolean;
}): boolean {
  if (job.canSpawn) return false;
  if (!job.allowPatterns.every(deskOnlyPattern)) return false;
  if (!job.allowedServers.every((tool) => tool.startsWith("mcp:") && isDeskServer(tool.slice("mcp:".length)))) return false;
  const lookOrAsk = job.permission === "read" || job.permission === "ask";
  switch (job.target) {
    case "codex": return job.permission === "read-only" && job.approvalsReviewer === "user";
    case "claude": return isClaudeReadOnly(job.permission as ClaudePermissionMode);
    case "opencode": return job.permission === "read-only";
    case "antigravity": return job.bypassPermissions === undefined && lookOrAsk;
    case "muse": return job.permissionProfile === undefined && lookOrAsk;
    default: return false;
  }
}

/** The job's grants under this scope; grants from another scope (or another job) are dropped. */
function current(job: Job, scope: string): ApprovalGrants | undefined {
  const grants = job.approvalGrants;
  if (grants && (grants.jobId !== job.id || grants.scope !== scope)) job.approvalGrants = undefined;
  return job.approvalGrants;
}

/** The earlier grant of an identical request in this job and scope, if any. */
export function reusableGrant(job: Job, scope: string, identity: string): ApprovalGrant | undefined {
  return current(job, scope)?.grants.find((grant) => grant.identity === identity);
}

/** Drop every command grant of the job (it may have changed files); MCP tool grants stay. */
export function dropCommandGrants(job: Job): number {
  const grants = job.approvalGrants;
  if (!grants) return 0;
  const before = grants.grants.length;
  grants.grants = grants.grants.filter((grant) => !grant.command);
  return before - grants.grants.length;
}

/** Forget all grants of the job (its turn finished). */
export function clearApprovalGrants(job: Job): void {
  job.approvalGrants = undefined;
}

/**
 * Remember an explicit "allow" by the supervisor or the owner. Any deny of the same request revokes its grant.
 * command: a command grant, kept only when readOnly (the job's settings when it was granted).
 */
export function recordGrant(job: Job, scope: string, identity: string, answer: { allow: boolean }, origin: ApprovalOrigin | undefined, command: boolean, readOnly: boolean): boolean {
  if (!answer.allow) {
    const grants = job.approvalGrants;
    if (grants) grants.grants = grants.grants.filter((grant) => grant.identity !== identity);
    return false;
  }
  if (!origin || !EXPLICIT_DECIDERS.has(origin.by) || (command && !readOnly)) return false;
  const grants = current(job, scope) ?? (job.approvalGrants = { jobId: job.id, scope, grants: [] });
  grants.grants = grants.grants.filter((grant) => grant.identity !== identity);
  grants.grants.push({ identity, approvalId: origin.approvalId, by: origin.by, at: Date.now(), command, reuses: 0 });
  while (grants.grants.length > MAX_APPROVAL_GRANTS) grants.grants.shift();
  return true;
}
