import { createHash } from "node:crypto";
import type { Logger } from "../core/logger.js";
import { canonicalJson, requestIdentity, type PermissionRequest } from "../core/relay.js";
import { gitChangeSnapshot } from "../core/worktree.js";
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
 * - a command grant (anything but an MCP tool) is dropped as soon as the job's files change: a file change request,
 *   or any difference in the working folder's Git state (tracked and untracked, not ignored, files and their
 *   content) since the grant was made;
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
  /** For a command grant: the Git state of its folders when it was granted. Undefined for an MCP tool. */
  tree?: string;
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

/** A grant whose effect depends on the job's files (anything but an MCP tool). */
export function isFileSensitive(r: Pick<PermissionRequest, "tool">): boolean {
  return !r.tool.startsWith("mcp:");
}

/** The settings a grant was made under; any change of them starts with no grants. */
export function approvalScope(parts: { access?: string; sandbox?: string; permission: string; supervisor: string }): string {
  return JSON.stringify([parts.access ?? "default", parts.sandbox ?? "", parts.permission, parts.supervisor]);
}

/**
 * The Git state of these folders (status and content hash of every changed, untracked or deleted file that is not
 * ignored), or null when one of them is not in a Git repository or cannot be read: then a command grant is not kept.
 */
export async function treeState(dirs: readonly string[], log: Logger): Promise<string | null> {
  const states: unknown[] = [];
  for (const dir of [...new Set(dirs.filter(Boolean))].sort()) {
    const snapshot = await gitChangeSnapshot(dir, log);
    if (!snapshot) return null;
    states.push([dir, [...snapshot.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)]);
  }
  if (!states.length) return null;
  return createHash("sha256").update(canonicalJson(states)).digest("hex");
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

/** Drop every command grant of the job (its files changed); MCP tool grants stay. */
export function dropFileSensitiveGrants(job: Job): number {
  const grants = job.approvalGrants;
  if (!grants) return 0;
  const before = grants.grants.length;
  grants.grants = grants.grants.filter((grant) => grant.tree === undefined);
  return before - grants.grants.length;
}

/** Forget all grants of the job (its turn finished). */
export function clearApprovalGrants(job: Job): void {
  job.approvalGrants = undefined;
}

/**
 * Remember an explicit "allow" by the supervisor or the owner. Any deny of the same request revokes its grant.
 * tree: the Git state for a command grant (null when unknown: then nothing is kept), undefined for an MCP tool.
 */
export function recordGrant(job: Job, scope: string, identity: string, answer: { allow: boolean }, origin: ApprovalOrigin | undefined, tree?: string | null): boolean {
  if (!answer.allow) {
    const grants = job.approvalGrants;
    if (grants) grants.grants = grants.grants.filter((grant) => grant.identity !== identity);
    return false;
  }
  if (!origin || !EXPLICIT_DECIDERS.has(origin.by) || tree === null) return false;
  const grants = current(job, scope) ?? (job.approvalGrants = { jobId: job.id, scope, grants: [] });
  grants.grants = grants.grants.filter((grant) => grant.identity !== identity);
  grants.grants.push({ identity, approvalId: origin.approvalId, by: origin.by, at: Date.now(), reuses: 0, ...(tree !== undefined ? { tree } : {}) });
  while (grants.grants.length > MAX_APPROVAL_GRANTS) grants.grants.shift();
  return true;
}
