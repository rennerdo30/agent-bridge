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

export async function git(args: string[], cwd: string, log: Logger, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
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
  const baseBranch = (await git(["symbolic-ref", "-q", "--short", "HEAD"], repoRoot, opts.log).catch(() => "")) || null;
  let branch = `${BRANCH_PREFIX}${opts.jobId}`;
  const dir = join(opts.home, "worktrees");
  mkdirSync(dir, { recursive: true });
  let path = join(dir, `${basename(repoRoot)}-${opts.jobId}`);
  // This runs in the MCP server (as the user), never inside the sandboxed agent, so the worktree is the user's.
  try {
    await git(["worktree", "add", "-b", branch, path, base], repoRoot, opts.log, WORKTREE_ADD_TIMEOUT_MS);
  } catch (err) {
    // A failed add leaves a worktree locked "initializing": remove it, so nothing piles up.
    if (!(err instanceof DelegateError && err.kind === "timeout")) {
      await removeWorktree(repoRoot, path, branch, opts.log);
      throw new Error(`could not create a worktree for the subagent: ${(err as Error).message}`);
    }
    // A slow disk under load: clean up the half-made checkout and try once more.
    opts.log.warn("git worktree add timed out; retrying once", { path });
    await removeWorktree(repoRoot, path, branch, opts.log);
    // Under a fresh name: the slow first attempt may still hold its branch and folder.
    branch = `${branch}-r2`;
    path = `${path}-r2`;
    try {
      await git(["worktree", "add", "-b", branch, path, base], repoRoot, opts.log, WORKTREE_ADD_TIMEOUT_MS);
    } catch (again) {
      await removeWorktree(repoRoot, path, branch, opts.log);
      throw new Error(`could not create a worktree for the subagent (tried twice): ${(again as Error).message}`);
    }
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

/** Best effort: remove a worktree and its branch (a failed or half-made checkout). */
async function removeWorktree(repoRoot: string, path: string, branch: string, log: Logger): Promise<void> {
  await git([...trustArgs(path), "worktree", "remove", "--force", "--force", path], repoRoot, log).catch(() => {});
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
  /** The branch holding the job's work: the one checked out at the end (the job may have made its own). */
  branch: string;
  /** Other branches committed from this worktree that carry work of their own, with their commit counts. */
  otherBranches: { name: string; commits: number }[];
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
export async function reviewBase(wt: Worktree, log: Logger, branch = wt.branch): Promise<string> {
  const run = (args: string[]) => git(args, wt.repoRoot, log);
  const tip = await run(["rev-parse", branch]);
  // The branch of the main checkout (the first entry of `git worktree list`).
  const list = await run(["worktree", "list", "--porcelain"]).catch(() => "");
  const main = /^branch refs\/heads\/(.+)$/m.exec(list.split(/\r?\n\r?\n/)[0] ?? "")?.[1];
  const candidates = new Set([wt.base]);
  for (const b of new Set([wt.baseBranch, main])) {
    if (!b || b === branch) continue;
    const mb = await run(["merge-base", b, branch]).catch(() => "");
    // A fork point at the tip itself means the branch is already merged there: nothing to learn from it.
    if (mb && mb !== tip) candidates.add(mb);
  }
  let best = wt.base;
  let fewest = Infinity;
  for (const c of candidates) {
    const n = Number(await run(["rev-list", "--count", `${c}..${branch}`]).catch(() => "NaN"));
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
  // The job may have switched to (or created) a branch of its own: its work is wherever it committed.
  const current = (await git([...trust, "branch", "--show-current"], wt.path, log).catch(() => "")) || wt.branch;
  const work = await workBranches(wt, current, log);
  // The job's branch: the checked-out one, unless only another branch of this worktree carries work.
  const branch = work.has(current) || !work.size ? current : [...work.keys()][0]!;
  const from = await reviewBase(wt, log, branch);
  const diffStat = await git(["diff", "--stat", `${from}..${branch}`], wt.repoRoot, log);
  const files = (await git(["diff", "--name-only", `${from}..${branch}`], wt.repoRoot, log)).split(/\r?\n/).filter(Boolean);
  const otherBranches = [...work].filter(([name]) => name !== branch).map(([name, commits]) => ({ name, commits }));
  return { changed: diffStat.length > 0 || otherBranches.length > 0, branch, otherBranches, diffStat: diffStat.slice(0, MAX_DIFFSTAT_CHARS), reviewBase: from, files };
}

/**
 * Branches committed from this worktree that carry work beyond their base, with their commit counts: the
 * worktree's branch, the one checked out now, and every branch whose tip this worktree's HEAD has been on
 * (its own reflog), so a branch the job made and then left is found too.
 */
async function workBranches(wt: Worktree, current: string, log: Logger): Promise<Map<string, number>> {
  const trust = trustArgs(wt.path);
  const visited = new Set((await git([...trust, "log", "-g", "--format=%H", "HEAD"], wt.path, log).catch(() => "")).split(/\r?\n/).filter(Boolean));
  const refs = (await git(["for-each-ref", "refs/heads", "--format=%(refname:short) %(objectname)"], wt.repoRoot, log).catch(() => ""))
    .split(/\r?\n/)
    .map((l) => l.split(" "))
    .filter((p): p is [string, string] => p.length === 2);
  // Branches checked out in another worktree (the main checkout, other jobs) are never this job's, whatever
  // its HEAD touched: a report must not offer to delete them.
  const list = await git(["worktree", "list", "--porcelain"], wt.repoRoot, log).catch(() => "");
  const here = resolve(wt.path).toLowerCase();
  const elsewhere = new Set(
    list
      .split(/\r?\n\r?\n/)
      .filter((block) => resolve(/^worktree (.+)$/m.exec(block)?.[1] ?? "").toLowerCase() !== here)
      .map((block) => /^branch refs\/heads\/(.+)$/m.exec(block)?.[1])
      .filter((b): b is string => Boolean(b)),
  );
  for (const b of [wt.baseBranch]) if (b) elsewhere.add(b);
  const candidates = new Set(
    [wt.branch, current, ...refs.filter(([, sha]) => visited.has(sha) && sha !== wt.base).map(([name]) => name)].filter((b) => b === wt.branch || !elsewhere.has(b)),
  );
  const out = new Map<string, number>();
  for (const name of candidates) {
    const from = await reviewBase(wt, log, name).catch(() => null);
    const commits = from ? Number(await git(["rev-list", "--count", `${from}..${name}`], wt.repoRoot, log).catch(() => "0")) : 0;
    if (commits > 0) out.set(name, commits);
  }
  return out;
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
  const branch = outcome.branch ?? wt.branch;
  // Only a worktree without any work of its own may be removed.
  if (!outcome.changed) return `Worktree ${wt.path} (branch ${branch}) has no changes; remove it with: git worktree remove "${wt.path}" && git branch -D ${branch}`;
  const others = outcome.otherBranches ?? [];
  const lines = [
    `Changes are committed on branch ${branch} (worktree ${wt.path}), not in your working copy` +
      (branch !== wt.branch ? ` (the job worked on its own branch; ${wt.branch} was its starting branch)` : "") +
      ":",
  ];
  if (outcome.diffStat) lines.push(outcome.diffStat);
  if (others.length) lines.push(`Also committed from this worktree: ${others.map((o) => `${o.name} (${o.commits} commit${o.commits === 1 ? "" : "s"})`).join(", ")}. Review those before removing anything.`);
  lines.push(...[handoffWarning(outcome.files)].filter((w): w is string => Boolean(w)));
  if (outcome.diffStat) {
    lines.push(`Review: git diff ${outcome.reviewBase.slice(0, 12)}..${branch}`);
    lines.push(`Take them: git merge ${branch}   (or git cherry-pick ${branch})`);
  }
  lines.push(`Discard: git worktree remove --force "${wt.path}" && git branch -D ${[branch, ...others.map((o) => o.name)].join(" ")}`);
  return lines.join("\n");
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