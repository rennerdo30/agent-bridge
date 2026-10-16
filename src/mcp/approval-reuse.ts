import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Logger } from "../core/logger.js";
import { physicalPath } from "../core/project-identity.js";
import { canonicalJson, requestIdentity, type PermissionRequest } from "../core/relay.js";
import { git } from "../core/worktree.js";
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
 *   or any difference in the Git state of the job folder and the request's folder since the grant was made (HEAD and
 *   the current branch, and every changed, staged, untracked or deleted file that is not ignored, with its content);
 *   a repository with submodules, a file over 64 MiB or a state that cannot be read keeps no command grant. Ignored
 *   files (node_modules, .env, generated config), the job's other writable folders and scripts outside these
 *   folders are not covered;
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

/** Above this size a file's content is not hashed and no command grant is kept (fail closed). Mutable for tests. */
export const approvalReuseLimits = { maxFileBytes: 64 * 1024 * 1024 };

/** One spelling per physical folder: subst and mapped-drive aliases, separators and (on Windows) case. */
function folderKey(dir: string): string {
  const key = physicalPath(resolve(dir)).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? key.toLowerCase() : key;
}

/** The SHA-256 of a file's content, streamed; "missing" when it is gone; null when it is not a regular file or too big. */
async function fileFingerprint(path: string): Promise<string | null> {
  let info;
  try { info = await stat(path); }
  catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : null; }
  if (!info.isFile() || info.size > approvalReuseLimits.maxFileBytes) return null;
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      bytes += (chunk as Buffer).length;
      // The file grew past the cap while it was read.
      if (bytes > approvalReuseLimits.maxFileBytes) return null;
      hash.update(chunk as Buffer);
    }
  } catch { return null; }
  return hash.digest("hex");
}

/**
 * One repository's state: its HEAD commit and symbolic ref, and the status line and content hash of every changed,
 * staged, untracked or deleted file that is not ignored. Null when it cannot be read completely: a repository with
 * submodules (a .gitmodules file, or a gitlink whose commit or content changed), an untracked folder that holds its
 * own repository, a file that is not regular or over the size cap.
 */
async function repoState(root: string, log: Logger): Promise<unknown[] | null> {
  if (existsSync(join(root, ".gitmodules"))) return null;
  let status: string;
  try {
    // A gitlink without .gitmodules shows as a submodule entry below. (`git submodule` is a shell script: not used.)
    status = await git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], root, log);
  } catch { return null; }
  const tokens = status.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  let oid: string | null = null, head: string | null = null;
  const files: [string, string, string][] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith("# ")) {
      const [key, ...value] = token.slice(2).split(" ");
      if (key === "branch.oid") oid = value.join(" ");
      else if (key === "branch.head") head = value.join(" ");
      continue;
    }
    let header: string, path: string;
    if (token.startsWith("? ")) { header = "?"; path = token.slice(2); }
    else {
      // "1 XY sub mH mI mW hH hI path", "2 ... Xscore path" + NUL + origPath, "u XY sub m1 m2 m3 mW h1 h2 h3 path".
      const fields = token[0] === "1" ? 8 : token[0] === "2" ? 9 : token[0] === "u" ? 10 : -1;
      if (fields < 0) return null;
      const parts = token.split(" ");
      header = parts.slice(0, fields).join(" ");
      path = parts.slice(fields).join(" ");
      if (token[0] === "2") header += "\0" + (tokens[++i] ?? "");
      // A submodule entry (sub field "S...").
      if (parts[2]?.startsWith("S")) return null;
    }
    // An untracked folder listed as such holds its own repository: its content is not visible here.
    if (path.endsWith("/")) return null;
    const content = await fileFingerprint(join(root, path));
    if (content === null) return null;
    files.push([path, header, content]);
  }
  if (oid === null || head === null) return null;
  files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return [oid, head, files];
}

/**
 * The Git state of these folders, or null when one of them is not in a Git repository or cannot be read completely:
 * then a command grant is not kept. Each repository counts once, however its folders are spelled (AB-402). It covers
 * HEAD and the current branch (a commit or a branch switch changes it) and every changed, staged, untracked or deleted
 * file that is not ignored, with its content; not ignored files (node_modules, .env, generated config) and not
 * scripts outside these repositories.
 */
export async function treeState(dirs: readonly string[], log: Logger): Promise<string | null> {
  const roots = new Map<string, string>();
  for (const dir of dirs.filter(Boolean)) {
    let root: string;
    try { root = await git(["rev-parse", "--show-toplevel"], physicalPath(resolve(dir)), log); }
    catch { return null; }
    if (!root) return null;
    const key = folderKey(root);
    if (!roots.has(key)) roots.set(key, physicalPath(root));
  }
  if (!roots.size) return null;
  const states: unknown[] = [];
  for (const key of [...roots.keys()].sort()) {
    const state = await repoState(roots.get(key)!, log);
    if (!state) return null;
    states.push([key, state]);
  }
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
