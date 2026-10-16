import type { PermissionRequest } from "../core/relay.js";
import type { ApprovalOrigin, Job } from "./jobs.js";

/**
 * Reuse of identical approvals within one job (AB-402). When a job asks its supervisor for an approval that is
 * identical to one the supervisor or the owner already allowed in that same job, the earlier grant answers it
 * and the reuse is logged with the original approval id. A grant never widens: identity is exact, and it never
 * crosses jobs, access or sandbox changes, or a change of supervisor. A deny is never reused (the job asks again).
 */

/** Who may stand behind a reusable "allow": the supervisor (decide) or the owner (dashboard, native dialog). */
const EXPLICIT_DECIDERS: ReadonlySet<string> = new Set(["MCP decide", "dashboard", "user in session"]);
/** Grants kept per job; the oldest goes first. */
export const MAX_APPROVAL_GRANTS = 64;

export interface ApprovalGrant {
  identity: string;
  /** The approval id of the explicit decision that granted it. */
  approvalId: string;
  by: string;
  at: number;
}

/** Memory only: a job's grants for one scope (its access, sandbox and permission settings and its supervisor). */
export interface ApprovalGrants {
  jobId: string;
  scope: string;
  grants: ApprovalGrant[];
}

/**
 * The exact identity of a request: the asking agent, the tool, the working folder and the full request text (the
 * command line, file path, or MCP tool with its arguments), with line endings and surrounding whitespace
 * normalized. Null when the request has no reliable identity: a reviewer refusal that needs an explicit decision,
 * a summary instead of the exact request, cut text, empty text, or a sandbox permission request.
 */
export function approvalIdentity(r: PermissionRequest): string | null {
  if (r.automaticReview || r.inexact || r.detailLength !== undefined) return null;
  if (!r.tool || r.tool === "unknown" || r.tool === "approval" || r.tool === "permissions") return null;
  const detail = r.detail.replace(/\r\n?/g, "\n").trim();
  if (!detail) return null;
  return JSON.stringify([r.agent, r.tool, r.cwd ?? "", detail]);
}

/** The settings a grant was made under; any change of them starts with no grants. */
export function approvalScope(parts: { access?: string; sandbox?: string; permission: string; supervisor: string }): string {
  return JSON.stringify([parts.access ?? "default", parts.sandbox ?? "", parts.permission, parts.supervisor]);
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

/** Remember an explicit "allow" by the supervisor or the owner. Anything else is never recorded. */
export function recordGrant(job: Job, scope: string, identity: string, answer: { allow: boolean }, origin: ApprovalOrigin | undefined): boolean {
  if (!answer.allow || !origin || !EXPLICIT_DECIDERS.has(origin.by)) return false;
  const grants = current(job, scope) ?? (job.approvalGrants = { jobId: job.id, scope, grants: [] });
  grants.grants = grants.grants.filter((grant) => grant.identity !== identity);
  grants.grants.push({ identity, approvalId: origin.approvalId, by: origin.by, at: Date.now() });
  while (grants.grants.length > MAX_APPROVAL_GRANTS) grants.grants.shift();
  return true;
}
