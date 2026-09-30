import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { DelegateError, runProcess } from "./delegate.js";
import type { Logger } from "./logger.js";

/**
 * Git worktrees for editing subagents: each one works on its own branch in its own checkout, so
 * parallel subagents never touch each other's files or the user's working copy.
 */
const GIT = "git";
/** Most git commands; generous, since many parallel subagents (and virus scanners) slow the disk down. */
const GIT_TIMEOUT_MS = 180_000;
/** `git worktree add` checks out the whole tree: on a large repository under load that takes minutes. */
const WORKTREE_ADD_TIMEOUT_MS = 600_000;
const BRANCH_PREFIX = "agent-bridge/";
/** Commit identity for subagent work; local branches only, so a neutral identity is fine. */
const COMMIT_IDENTITY = ["-c", "user.name=agent-bridge", "-c", "user.email=agent-bridge@localhost"];
const MAX_DIFFSTAT_CHARS = 4_000;

export interface Worktree {
  repoRoot: string;
  path: string;
  /** Working directory inside the worktree matching the caller's cwd. */
  cwd: string;
  branch: string;
  base: string;
}

async function git(args: string[], cwd: string, log: Logger, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  // Name the command in errors ("git worktree add timed out after 600s"), not the -c options before it.
  const what = `git ${args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-c").slice(0, 2).join(" ")}`;
  const res = await runProcess({ bin: GIT, args, stdin: "", cwd, timeoutMs, env: process.env, log, what });
  if (res.code !== 0) throw new Error(`${what} failed: ${(res.stderr || res.stdout).trim().slice(0, 500)}`);
  // Only trailing whitespace: leading spaces are meaningful in `git status --porcelain`.
  return res.stdout.trimEnd();
}

export async function createWorktree(opts: { cwd: string; home: string; jobId: string; log: Logger }): Promise<Worktree> {
  let repoRoot: string;
  try {
    repoRoot = await git(["rev-parse", "--show-toplevel"], opts.cwd, opts.log);
  } catch {
    throw new Error(`worktree isolation needs a git repository, but ${opts.cwd} is not inside one`);
  }
  const base = await git(["rev-parse", "HEAD"], repoRoot, opts.log);
  const branch = `${BRANCH_PREFIX}${opts.jobId}`;
  const dir = join(opts.home, "worktrees");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${basename(repoRoot)}-${opts.jobId}`);
  try {
    await git(["worktree", "add", "-b", branch, path, base], repoRoot, opts.log, WORKTREE_ADD_TIMEOUT_MS);
  } catch (err) {
    if (!(err instanceof DelegateError && err.kind === "timeout")) throw new Error(`could not create a worktree for the subagent: ${(err as Error).message}`);
    // A slow disk under load: clean up the half-made checkout and try once more.
    opts.log.warn("git worktree add timed out; retrying once", { path });
    await removeWorktree(repoRoot, path, branch, opts.log);
    try {
      await git(["worktree", "add", "-b", branch, path, base], repoRoot, opts.log, WORKTREE_ADD_TIMEOUT_MS);
    } catch (again) {
      await removeWorktree(repoRoot, path, branch, opts.log);
      throw new Error(`could not create a worktree for the subagent (tried twice): ${(again as Error).message}`);
    }
  }
  const rel = relative(repoRoot, opts.cwd);
  // Different spellings of the same folder (drive mappings, junctions) make rel absolute or "..": use the root.
  const cwd = rel && !rel.startsWith("..") && !isAbsolute(rel) ? join(path, rel) : path;
  opts.log.info("worktree created", { repoRoot, path, branch });
  return { repoRoot, path, cwd, branch, base };
}

/** Best effort: remove a worktree and its branch (a failed or half-made checkout). */
async function removeWorktree(repoRoot: string, path: string, branch: string, log: Logger): Promise<void> {
  await git(["worktree", "remove", "--force", path], repoRoot, log).catch(() => {});
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // files still locked: prune below forgets it anyway
  }
  await git(["worktree", "prune"], repoRoot, log).catch(() => {});
  await git(["branch", "-D", branch], repoRoot, log).catch(() => {});
}

export interface WorktreeOutcome {
  changed: boolean;
  diffStat: string;
}

const SUBJECT_CHARS = 72;

/**
 * Commit message for work a subagent left uncommitted: the subject from its answer (what it did), not from
 * the task; the task and the job in the body; the agent as co-author.
 */
export function subagentCommitMessage(opts: { answer: string; task: string; job?: string | null; agent: string; model?: string | null }): string {
  const plain = (s: string) => s.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  const firstLine = (s: string) => s.split(/\r?\n/).map(plain).find((l) => l.length > 0) ?? "";
  const clip = (s: string) => (s.length > SUBJECT_CHARS ? `${s.slice(0, SUBJECT_CHARS - 1).trimEnd()}…` : s);
  const subject = clip(firstLine(opts.answer) || firstLine(opts.task) || "subagent changes");
  const email = { codex: "noreply@openai.com", claude: "noreply@anthropic.com", opencode: "noreply@opencode.ai" }[opts.agent] ?? "noreply@localhost";
  const who = opts.model ? `${opts.model} via ${opts.agent}` : opts.agent;
  return [
    subject,
    "",
    `Committed by agent-bridge for ${opts.job ?? "a subagent"} (${who}).`,
    `Task: ${clip(firstLine(opts.task))}`,
    "",
    `Co-Authored-By: ${who} <${email}>`,
  ].join("\n");
}

/**
 * A linked worktree keeps its git data in the main repository (.git/worktrees/<name> and the shared .git).
 * Sandboxed agents need these folders writable to commit; returns them when they lie outside `cwd`.
 */
export async function gitDirsOutside(cwd: string, log: Logger): Promise<string[]> {
  try {
    const [gitDir, common] = (await git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], cwd, log)).split(/\r?\n/);
    // Git reports resolved paths: compare real paths (symlinked temp dirs, Windows 8.3 short names).
    const real = (p: string) => {
      try {
        return realpathSync.native(p);
      } catch {
        return resolve(p);
      }
    };
    const inside = (p: string) => {
      const rel = relative(real(cwd), real(p));
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    };
    return [...new Set([gitDir, common].filter((p): p is string => Boolean(p) && !inside(p!)))];
  } catch {
    return [];
  }
}

/** Commit whatever the subagent changed onto its branch and summarize the diff against the base. */
export async function finishWorktree(wt: Worktree, message: string, log: Logger): Promise<WorktreeOutcome> {
  await git(["add", "-A"], wt.path, log);
  const status = await git(["status", "--porcelain"], wt.path, log);
  if (status) await git([...COMMIT_IDENTITY, "commit", "-q", "--no-verify", "-m", message], wt.path, log);
  const diffStat = await git(["diff", "--stat", `${wt.base}..${wt.branch}`], wt.repoRoot, log);
  return { changed: diffStat.length > 0, diffStat: diffStat.slice(0, MAX_DIFFSTAT_CHARS) };
}

/** Human/agent-readable instructions for taking or discarding the subagent's work. */
export function worktreeReport(wt: Worktree, outcome: WorktreeOutcome): string {
  if (!outcome.changed) return `Worktree ${wt.path} (branch ${wt.branch}) has no changes; remove it with: git worktree remove "${wt.path}" && git branch -D ${wt.branch}`;
  return [
    `Changes are committed on branch ${wt.branch} (worktree ${wt.path}), not in your working copy:`,
    outcome.diffStat,
    `Review: git diff ${wt.base.slice(0, 12)}..${wt.branch}`,
    `Take them: git merge ${wt.branch}   (or git cherry-pick ${wt.branch})`,
    `Discard: git worktree remove --force "${wt.path}" && git branch -D ${wt.branch}`,
  ].join("\n");
}

/** Files that changed in a plain (non-worktree) run: `git status` lines that are new after the run. */
export async function gitStatusSnapshot(cwd: string, log: Logger): Promise<Set<string> | null> {
  try {
    const out = await git(["status", "--porcelain"], cwd, log);
    return new Set(out.split(/\r?\n/).filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Dirty and untracked files with a fingerprint of their content. Comparing two snapshots finds every file
 * a subagent changed, also files that were already modified before it started.
 */
export async function gitChangeSnapshot(cwd: string, log: Logger): Promise<Map<string, string> | null> {
  let status: string;
  try {
    status = await git(["status", "--porcelain", "--untracked-files=all"], cwd, log);
  } catch {
    return null;
  }
  let root: string;
  try {
    root = await git(["rev-parse", "--show-toplevel"], cwd, log);
  } catch {
    return null;
  }
  const snap = new Map<string, string>();
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    const file = line.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, "");
    let fp = line.slice(0, 2);
    try {
      fp += ":" + createHash("sha1").update(readFileSync(join(root, file))).digest("hex");
    } catch {
      fp += ":missing";
    }
    snap.set(file, fp);
  }
  return snap;
}

/** Files whose state or content differs between two snapshots (new, changed, or no longer dirty). */
export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const out = new Set<string>();
  for (const [f, fp] of after) if (before.get(f) !== fp) out.add(f);
  for (const f of before.keys()) if (!after.has(f)) out.add(f);
  return [...out].sort();
}