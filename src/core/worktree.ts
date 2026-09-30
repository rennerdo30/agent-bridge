import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { runProcess } from "./delegate.js";
import type { Logger } from "./logger.js";

/**
 * Git worktrees for editing subagents: each one works on its own branch in its own checkout, so
 * parallel subagents never touch each other's files or the user's working copy.
 */
const GIT = "git";
const GIT_TIMEOUT_MS = 60_000;
export const BRANCH_PREFIX = "agent-bridge/";
/** Commit identity for subagent work; local branches only, so a neutral identity is fine. */
const COMMIT_IDENTITY = ["-c", "user.name=agent-bridge", "-c", "user.email=agent-bridge@localhost"];
const MAX_DIFFSTAT_CHARS = 4_000;

export interface Worktree {
  repoRoot: string;
  path: string;
  /** Working directory inside the worktree matching the caller's cwd. */
  cwd: string;
  branch: string;
  /** Commit the branch started from. */
  base: string;
  /** Branch checked out where the worktree was created (null: detached HEAD, or a job saved by an older version). */
  baseBranch?: string | null;
}

/**
 * `-c safe.directory=<dir>` for folders we created: a worktree may end up owned by another account (Codex's
 * Windows sandbox user), and git then refuses to work in it ("dubious ownership").
 */
export function trustArgs(...dirs: string[]): string[] {
  return dirs.flatMap((d) => ["-c", `safe.directory=${resolve(d).replace(/\\/g, "/")}`]);
}

export async function git(args: string[], cwd: string, log: Logger): Promise<string> {
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
  const baseBranch = (await git(["symbolic-ref", "-q", "--short", "HEAD"], repoRoot, opts.log).catch(() => "")) || null;
  const branch = `${BRANCH_PREFIX}${opts.jobId}`;
  const dir = join(opts.home, "worktrees");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${basename(repoRoot)}-${opts.jobId}`);
  // This runs in the MCP server (as the user), never inside the sandboxed agent, so the worktree is the user's.
  try {
    await git(["worktree", "add", "-b", branch, path, base], repoRoot, opts.log);
  } catch (err) {
    // A failed add leaves a worktree locked "initializing": remove it, so nothing piles up.
    await git([...trustArgs(path), "worktree", "remove", "--force", "--force", path], repoRoot, opts.log).catch(() => "");
    await git(["branch", "-D", branch], repoRoot, opts.log).catch(() => "");
    throw err;
  }
  // `worktree add` holds an "initializing" lock while it works; make sure none is left behind.
  await unlockWorktree(repoRoot, path, opts.log);
  const rel = relative(repoRoot, opts.cwd);
  // Different spellings of the same folder (drive mappings, junctions) make rel absolute or "..": use the root.
  const cwd = rel && !rel.startsWith("..") && !isAbsolute(rel) ? join(path, rel) : path;
  opts.log.info("worktree created", { repoRoot, path, branch });
  return { repoRoot, path, cwd, branch, base, baseBranch };
}

/** Release a lock on a worktree (best effort: usually there is none). */
async function unlockWorktree(repoRoot: string, path: string, log: Logger): Promise<void> {
  await git([...trustArgs(path), "worktree", "unlock", path], repoRoot, log).catch(() => "");
}

export interface WorktreeOutcome {
  changed: boolean;
  diffStat: string;
  /** The commit the review diff starts from (see reviewBase). */
  reviewBase: string;
  /** Files the job's diff touches. */
  files: string[];
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

/**
 * Where the job's own work starts. Usually the commit its branch started from; but when the job merged a
 * newer state of its base branch (or of the main checkout's branch) into its branch, a diff from there would
 * list all of that too. So: the fork point with each of those branches, whichever leaves the fewest commits.
 */
export async function reviewBase(wt: Worktree, log: Logger): Promise<string> {
  const run = (args: string[]) => git(args, wt.repoRoot, log);
  const tip = await run(["rev-parse", wt.branch]);
  // The branch of the main checkout (the first entry of `git worktree list`).
  const list = await run(["worktree", "list", "--porcelain"]).catch(() => "");
  const main = /^branch refs\/heads\/(.+)$/m.exec(list.split(/\r?\n\r?\n/)[0] ?? "")?.[1];
  const candidates = new Set([wt.base]);
  for (const b of new Set([wt.baseBranch, main])) {
    if (!b || b === wt.branch) continue;
    const mb = await run(["merge-base", b, wt.branch]).catch(() => "");
    // A fork point at the tip itself means the branch is already merged there: nothing to learn from it.
    if (mb && mb !== tip) candidates.add(mb);
  }
  let best = wt.base;
  let fewest = Infinity;
  for (const c of candidates) {
    const n = Number(await run(["rev-list", "--count", `${c}..${wt.branch}`]).catch(() => "NaN"));
    if (n < fewest) [best, fewest] = [c, n];
  }
  return best;
}

/** Commit whatever the subagent changed onto its branch and summarize the diff of its work. */
export async function finishWorktree(wt: Worktree, message: string, log: Logger): Promise<WorktreeOutcome> {
  const trust = trustArgs(wt.path);
  await git([...trust, "add", "-A"], wt.path, log);
  const status = await git([...trust, "status", "--porcelain"], wt.path, log);
  if (status) await git([...trust, ...COMMIT_IDENTITY, "commit", "-q", "--no-verify", "-m", message], wt.path, log);
  await unlockWorktree(wt.repoRoot, wt.path, log);
  const from = await reviewBase(wt, log);
  const diffStat = await git(["diff", "--stat", `${from}..${wt.branch}`], wt.repoRoot, log);
  const files = (await git(["diff", "--name-only", `${from}..${wt.branch}`], wt.repoRoot, log)).split(/\r?\n/).filter(Boolean);
  return { changed: diffStat.length > 0, diffStat: diffStat.slice(0, MAX_DIFFSTAT_CHARS), reviewBase: from, files };
}

/** Project handoff and TODO files: the session that started a job owns them, a job must not write them. */
const HANDOFF_FILE = /(^|\/)(HANDOFF|TODO)\.md$/i;

/** A warning when a job changed project handoff or TODO files, else null. */
export function handoffWarning(files: readonly string[]): string | null {
  const hit = files.filter((f) => HANDOFF_FILE.test(f.replace(/\\/g, "/")));
  return hit.length
    ? `WARNING: this job changed ${hit.join(", ")}. Delegated jobs should report in their answer and leave handoff and TODO files to you: check these changes before you take them.`
    : null;
}

/** Human/agent-readable instructions for taking or discarding the subagent's work. */
export function worktreeReport(wt: Worktree, outcome: WorktreeOutcome): string {
  if (!outcome.changed) return `Worktree ${wt.path} (branch ${wt.branch}) has no changes; remove it with: git worktree remove "${wt.path}" && git branch -D ${wt.branch}`;
  return [
    `Changes are committed on branch ${wt.branch} (worktree ${wt.path}), not in your working copy:`,
    outcome.diffStat,
    ...[handoffWarning(outcome.files)].filter((w): w is string => Boolean(w)),
    `Review: git diff ${outcome.reviewBase.slice(0, 12)}..${wt.branch}`,
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