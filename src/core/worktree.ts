import { mkdirSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { runProcess } from "./delegate.js";
import type { Logger } from "./logger.js";

/**
 * Git worktrees for editing subagents: each one works on its own branch in its own checkout, so
 * parallel subagents never touch each other's files or the user's working copy.
 */
const GIT = "git";
const GIT_TIMEOUT_MS = 60_000;
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

async function git(args: string[], cwd: string, log: Logger): Promise<string> {
  const res = await runProcess({ bin: GIT, args, stdin: "", cwd, timeoutMs: GIT_TIMEOUT_MS, env: process.env, log });
  if (res.code !== 0) throw new Error(`git ${args[0]} failed: ${(res.stderr || res.stdout).trim().slice(0, 500)}`);
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
  await git(["worktree", "add", "-b", branch, path, base], repoRoot, opts.log);
  const rel = relative(repoRoot, opts.cwd);
  // Different spellings of the same folder (drive mappings, junctions) make rel absolute or "..": use the root.
  const cwd = rel && !rel.startsWith("..") && !isAbsolute(rel) ? join(path, rel) : path;
  opts.log.info("worktree created", { repoRoot, path, branch });
  return { repoRoot, path, cwd, branch, base };
}

export interface WorktreeOutcome {
  changed: boolean;
  diffStat: string;
}

/** Commit whatever the subagent changed onto its branch and summarize the diff against the base. */
export async function finishWorktree(wt: Worktree, summary: string, log: Logger): Promise<WorktreeOutcome> {
  await git(["add", "-A"], wt.path, log);
  const status = await git(["status", "--porcelain"], wt.path, log);
  if (status) {
    const message = `agent-bridge: ${summary.replace(/\s+/g, " ").slice(0, 72)}`;
    await git([...COMMIT_IDENTITY, "commit", "-q", "--no-verify", "-m", message], wt.path, log);
  }
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
