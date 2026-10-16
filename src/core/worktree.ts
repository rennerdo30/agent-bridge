import { loadConfig } from "./config.js";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, toNamespacedPath } from "node:path";
import { DelegateError, runProcess } from "./delegate.js";
import { nullLogger, type Logger } from "./logger.js";
import { resolveWorktreeRemovalPath, unlinkLinks } from "./worktree-links.js";
import { displayPathText } from "./display-paths.js";
import { diffSafety, GitSafetyRefusal, gitSafetyArgs, repositoryGuards, splitGitArgs } from "./git-safety.js";

/**
 * Git worktrees for editing subagents: each one works on its own branch in its own checkout, so
 * parallel subagents never touch each other's files or the user's working copy.
 */
const GIT = "git";
const LONG_PATH_ARGS = ["-c", "core.longpaths=true"];
/** Upper bound for one guard read (`ls-files -s` of a very large index), below V8's maximum string length; larger
 * output is refused, never truncated. */
const GUARD_READ_MAX_BYTES = 256 * 1024 * 1024;
const REMOVE_RETRIES = 3;
/** Most git commands; generous, since many parallel subagents (and virus scanners) slow the disk down. */
const GIT_TIMEOUT_MS = 180_000;
/** `git worktree add` checks out the whole tree: on a large repository under load that takes minutes. */
const WORKTREE_ADD_TIMEOUT_MS = 600_000;
/** Network discovery and fetch each have a short, independent bound. */
export const WORKTREE_FETCH_TIMEOUT_MS = 10_000;
export const BRANCH_PREFIX = "agent-bridge/";
const MAX_DIFFSTAT_CHARS = 4_000;

export interface Worktree {
  repoRoot: string;
  path: string;
  /** Working directory inside the worktree matching the caller's cwd. */
  cwd: string;
  branch: string;
  /** Commit the branch started from. */
  base: string;
  /** Selected ref and selection facts (optional for older saved worktrees). */
  baseRef?: string;
  baseNotes?: string[];
  /** Branch checked out where the worktree was created (null: detached HEAD, or a job saved by an older version). */
  baseBranch?: string | null;
  /** Last finished tip, retained when its branch is removed. */
  branchHead?: string;
}

/**
 * `-c safe.directory=<dir>` for folders we created: a worktree may end up owned by another account (Codex's
 * Windows sandbox user), and git then refuses to work in it ("dubious ownership").
 */
export function trustArgs(...dirs: string[]): string[] {
  return dirs.flatMap((d) => ["-c", `safe.directory=${resolve(d).replace(/\\/g, "/")}`]);
}

/**
 * Every bridge git call. The repositories it works in (job worktrees, a job's cwd, the owner's project) may carry
 * configuration a job wrote, so each call is hardened centrally (AB-422, see git-safety.ts): fsmonitor, hooks,
 * editors and auto-gc are off, repository-local filter drivers and signing programs are neutralised, diffs use
 * no external or textconv driver, and network access is refused when repository-local config names a program.
 */
export async function git(args: string[], cwd: string, log: Logger, timeoutMs = GIT_TIMEOUT_MS, env = process.env): Promise<string> {
  // Name the command in errors ("git worktree add timed out after 600s"), not the -c options before it.
  const what = `git ${args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-c").slice(0, 2).join(" ")}`;
  const { options, rest } = splitGitArgs(args);
  const prefix = [...LONG_PATH_ARGS, ...options, ...gitSafetyArgs()];
  const exec = async (argv: string[], runEnv: NodeJS.ProcessEnv, label: string) => {
    const res = await runProcess({ bin: GIT, args: argv, stdin: "", cwd, timeoutMs, env: runEnv, log, what: label });
    if (res.code !== 0) throw new Error(`${label} failed: ${(res.stderr || res.stdout).trim().slice(0, 500)}`);
    return res.stdout;
  };
  const sub = rest[0] ?? "";
  // Guard reads need their complete output (a gitlink listing of a large index is bigger than runProcess keeps).
  // All reads of one call share a single deadline: the call's own timeout, not a new one per read.
  const deadline = Date.now() + timeoutMs;
  const read = (argv: string[], dir: string | null) => new Promise<string>((done, fail) => {
    const left = deadline - Date.now();
    if (left <= 0) { fail(new Error(`git ${argv[0]} not started: the guard checks used up ${Math.round(timeoutMs / 1000)}s`)); return; }
    execFile(GIT, [...prefix, ...(dir ? ["-C", dir] : []), ...argv], { cwd, env, timeout: left, windowsHide: true, encoding: "utf8", maxBuffer: GUARD_READ_MAX_BYTES },
      (err, stdout, stderr) => err ? fail(new Error(`git ${argv[0]} failed: ${(stderr || err.message).trim().slice(0, 500)}`)) : done(stdout));
  });
  // Every guard failure is a refusal (GitSafetyRefusal), whatever text from git it quotes.
  const guards = await repositoryGuards(rest, cwd, read)
    .catch((err: Error) => { throw new GitSafetyRefusal(`${what} refused: ${err.message}`); });
  // A prompt can never be answered here; the owner's GIT_SSH_COMMAND and global helpers stay in effect. The
  // guards add process-local variables of their own (no prompts while Git LFS is active).
  const network = sub === "fetch" || sub === "ls-remote" || sub === "pull" || sub === "push";
  const runEnv = network || Object.keys(guards.env).length ? { ...env, ...(network ? { GIT_TERMINAL_PROMPT: "0" } : {}), ...guards.env } : env;
  // Only trailing whitespace: leading spaces are meaningful in `git status --porcelain`.
  return (await exec([...prefix, ...guards.args, ...diffSafety(rest)], runEnv, what)).trimEnd();
}

export function worktreeBaseReport(wt: Pick<Worktree, "base" | "baseRef" | "baseNotes">): string {
  return [`Base: ${wt.baseRef ?? "saved fork point"} ${wt.base}`, ...(wt.baseNotes ?? [])].join("\n");
}

async function selectWorktreeBase(repo: string, log: Logger, explicit?: string): Promise<Pick<Worktree, "base" | "baseRef" | "baseNotes">> {
  const run = (args: string[]) => git(args, repo, log);
  const explicitBase = explicit ? await run(["rev-parse", "--verify", "--end-of-options", `${explicit}^{commit}`]) : undefined;
  const head = await run(["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => "");
  if (!head && !explicitBase) throw new Error("worktree isolation needs a valid HEAD commit or an explicit base; HEAD is unborn or unavailable");
  const remotes = (await run(["remote"])).split(/\r?\n/).filter(Boolean);
  const baseNotes: string[] = [];
  let reference: string | undefined;
  if (remotes.length) {
    const branch = await run(["branch", "--show-current"]);
    const upstreamRemote = await run(["config", "--get", `branch.${branch}.remote`]).catch(() => "");
    const merge = await run(["config", "--get", `branch.${branch}.merge`]).catch(() => "");
    const remote = remotes.includes(upstreamRemote) ? upstreamRemote : remotes.includes("origin") ? "origin" : remotes[0]!;
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" };
    let source: string | undefined;
    if (upstreamRemote === "." && merge) reference = merge;
    else if (remotes.includes(upstreamRemote) && merge.startsWith("refs/heads/")) {
      source = merge;
      reference = `refs/remotes/${remote}/${merge.slice("refs/heads/".length)}`;
    } else {
      let defaultBranch = (await run(["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`]).catch(() => "")).replace(`refs/remotes/${remote}/`, "");
      try {
        const advertised = await git(["ls-remote", "--symref", "--", remote, "HEAD"], repo, log, WORKTREE_FETCH_TIMEOUT_MS, env);
        defaultBranch = /^ref: refs\/heads\/(.+)\tHEAD\r?$/m.exec(advertised)?.[1] ?? defaultBranch;
      } catch { baseNotes.push("WARNING: remote default discovery failed or offline."); }
      if (defaultBranch) {
        source = `refs/heads/${defaultBranch}`;
        reference = `refs/remotes/${remote}/${defaultBranch}`;
      }
    }
    if (source && reference) {
      try {
        // Fetch only the needed upstream/default. Never prune or change local branches.
        await git(["fetch", "--no-tags", "--no-prune", "--no-prune-tags", "--refmap=", "--no-recurse-submodules", "--no-write-fetch-head", "--", remote, `${source}:${reference}`], repo, log, WORKTREE_FETCH_TIMEOUT_MS, env);
      } catch {
        baseNotes.push(`WARNING: fetch failed or offline; using last fetched remote ref ${reference.replace("refs/remotes/", "")} if available.`);
      }
    }
    if (!reference || !await run(["rev-parse", "--verify", `${reference}^{commit}`]).catch(() => "")) {
      reference = undefined;
      if (!explicit) baseNotes.push("WARNING: no remote default tracking ref available; falling back to local HEAD.");
    }
  } else baseNotes.push("Repository has no remote.");
  let baseRef = explicit ?? "local HEAD";
  let base = explicitBase ?? head;
  if (reference && head) {
    const tip = await run(["rev-parse", "--verify", `${reference}^{commit}`]);
    const [ahead, behind] = (await run(["rev-list", "--left-right", "--count", `${head}...${tip}`])).split(/\s+/).map(Number);
    if (behind! > 0) {
      const ancestor = await run(["merge-base", "--is-ancestor", head, tip]).then(() => true, () => false);
      if (ancestor) {
        if (!explicit) {
          base = tip; baseRef = reference;
          baseNotes.push(`cwd HEAD was ${behind} behind ${reference}; using ${reference}.`);
        } else baseNotes.push(`WARNING: cwd HEAD ${head} is behind ${reference} by ${behind} commit(s); explicit base wins.`);
      } else baseNotes.push(`WARNING: DIVERGED cwd HEAD ${head} and ${reference} ${tip}: ${behind} behind, ${ahead} ahead; ${explicit ? "explicit base wins" : "keeping local HEAD"}.`);
    }
  }
  return { base, baseRef, baseNotes };
}

export async function createWorktree(opts: { cwd: string; home: string; jobId: string; log: Logger; worktreeRoot?: string | null; base?: string }): Promise<Worktree> {
  let repoRoot: string;
  try {
    repoRoot = await git(["rev-parse", "--show-toplevel"], opts.cwd, opts.log);
  } catch {
    throw new Error(`worktree isolation needs a git repository, but ${opts.cwd} is not inside one`);
  }
  const baseBranch = (await git(["symbolic-ref", "-q", "--short", "HEAD"], repoRoot, opts.log).catch(() => "")) || null;
  let branch = `${BRANCH_PREFIX}${opts.jobId}`;
  const dir = opts.worktreeRoot ?? join(opts.home, "worktrees");
  let path = join(dir, `${basename(repoRoot)}-${opts.jobId}`);
  if (await worktreeLocationExists(repoRoot, branch, path, opts.log)) {
    throw new Error(`could not create a worktree for the subagent; existing branch or path retained: ${branch}, ${path}`);
  }
  const selection = await selectWorktreeBase(repoRoot, opts.log, opts.base);
  const { base } = selection;
  mkdirSync(dir, { recursive: true });
  // This runs in the MCP server (as the user), never inside the sandboxed agent, so the worktree is the user's.
  try {
    await git(["worktree", "add", "-b", branch, path, base], repoRoot, opts.log, WORKTREE_ADD_TIMEOUT_MS);
  } catch (err) {
    // The branch/path may predate this call or contain partial work. A failed add
    // grants no authority to remove, unlock, prune, or overwrite either of them.
    if (!(err instanceof DelegateError && err.kind === "timeout")) {
      throw new Error(`could not create a worktree for the subagent; retained branch ${branch} and path ${path}: ${(err as Error).message}`);
    }
    opts.log.warn("git worktree add timed out; retaining first attempt and retrying once", { branch, path });
    // Check fresh names without changing the first attempt. Git's non-forcing add
    // also rejects a collision that occurs after these checks.
    [branch, path] = await unusedRetryLocation(repoRoot, branch, path, opts.log);
    try {
      await git(["worktree", "add", "-b", branch, path, base], repoRoot, opts.log, WORKTREE_ADD_TIMEOUT_MS);
    } catch (again) {
      throw new Error(`could not create a worktree for the subagent (tried twice); retained both attempts, including branch ${branch} and path ${path}: ${(again as Error).message}`);
    }
  }
  // `worktree add` holds an "initializing" lock while it works; make sure none is left behind.
  await unlockWorktree(repoRoot, path, opts.log);
  const rel = relative(repoRoot, opts.cwd);
  // Different spellings of the same folder (drive mappings, junctions) make rel absolute or "..": use the root.
  const cwd = rel && !rel.startsWith("..") && !isAbsolute(rel) ? join(path, rel) : path;
  opts.log.info("worktree created", { repoRoot, path, branch });
  return { repoRoot, path, cwd, branch, ...selection, baseBranch };
}

/** Release a lock on a worktree (best effort: usually there is none). */
async function unlockWorktree(repoRoot: string, path: string, log: Logger): Promise<void> {
  await git([...trustArgs(path), "worktree", "unlock", path], repoRoot, log).catch(() => "");
}

async function worktreeLocationExists(repoRoot: string, branch: string, path: string, log: Logger): Promise<boolean> {
  const refs = await git(["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`], repoRoot, log);
  if (refs.split(/\r?\n/).includes(`refs/heads/${branch}`)) return true;
  try { lstatSync(toNamespacedPath(path)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function unusedRetryLocation(repoRoot: string, branch: string, path: string, log: Logger): Promise<[string, string]> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = `-r2-${randomUUID()}`;
    const retryBranch = branch + suffix, retryPath = path + suffix;
    if (!await worktreeLocationExists(repoRoot, retryBranch, retryPath, log)) return [retryBranch, retryPath];
  }
  throw new Error(`could not select an unused worktree retry location; retained branch ${branch} and path ${path}`);
}

/** Node's namespaced Windows paths also cover deep ignored folders that Git could not remove. */
export function removeWorktreeDirectory(path: string, managedRoot = path): void {
  if (!existsSync(toNamespacedPath(path))) return;
  path = resolveWorktreeRemovalPath(path, managedRoot);
  unlinkLinks(path);
  rmSync(toNamespacedPath(resolve(path)), { recursive: true, force: true, maxRetries: REMOVE_RETRIES });
}

type SkippedFile = { path: string; reason: "whitespace only" | "generated noise" | "generated bundle; excluded atomically" | "untracked; not explicitly staged" | "possible secret; never auto-committed" | "larger than 5 MB; not auto-committed" };

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
  /** Auto-commit exclusions left on disk for the supervisor to inspect or discard. */
  skippedFiles?: SkippedFile[];
}

/**
 * Automatic checkpoints use a fixed plain message. Task/answer text may contain attribution,
 * model names or instructions and must never become commit metadata.
 */
export function subagentCommitMessage(opts: { answer: string; task: string; job?: string | null; agent: string; model?: string | null }): string {
  return "Save worktree changes";
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
  // A checkout into a job-created branch records its actual starting commit, even from another base.
  const reflog = await git([...trustArgs(wt.path), "log", "-g", "--format=%H%x09%gs", "HEAD"], wt.path, log).catch(() => "");
  const start = reflog.split(/\r?\n/).reverse().find((line) => line.endsWith(` to ${branch}`) && line.includes("\tcheckout: moving from "))?.split("\t")[0];
  const base = branch === wt.branch ? wt.base : start ?? wt.base;
  const created = (await run(["log", "-g", "--format=%H%x09%gs", branch]).catch(() => ""))
    .split(/\r?\n/).reverse().find((line) => line.startsWith(`${base}\tbranch: Created from `));
  const source = branch !== wt.branch ? created?.split("\tbranch: Created from ")[1] : null;
  // The branch of the main checkout (the first entry of `git worktree list`).
  const list = await run(["worktree", "list", "--porcelain"]).catch(() => "");
  const main = /^branch refs\/heads\/(.+)$/m.exec(list.split(/\r?\n\r?\n/)[0] ?? "")?.[1];
  const candidates = new Set([base]);
  for (const b of new Set([source, wt.baseBranch, main])) {
    if (!b || b === "HEAD" || b === branch) continue;
    const mb = await run(["merge-base", b, branch]).catch(() => "");
    // A fork point at the tip itself means the branch is already merged there: nothing to learn from it.
    if (mb && mb !== tip) candidates.add(mb);
  }
  let best = base;
  let fewest = Infinity;
  for (const c of candidates) {
    const n = Number(await run(["rev-list", "--count", `${c}..${branch}`]).catch(() => "NaN"));
    if (n < fewest) [best, fewest] = [c, n];
  }
  return best;
}

const GENERATED_DIRECTORIES = new Set(["node_modules", ".vs", "__pycache__"]);
const UNITY_GENERATED_DIRECTORIES = new Set(["Library", "Temp", "Obj", "Logs", "UserSettings"]);
const GENERATED_FILES = new Set([".DS_Store", "Thumbs.db"]);

function generatedNoise(root: string, file: string): boolean {
  const parts = file.split("/");
  if (GENERATED_FILES.has(parts.at(-1)!)) return true;
  return parts.slice(0, -1).some((part, index) => {
    if (GENERATED_DIRECTORIES.has(part)) return true;
    if (!UNITY_GENERATED_DIRECTORIES.has(part)) return false;
    // Unity's settings are source files; only its known generated folders in a Unity project are noise.
    return existsSync(toNamespacedPath(join(root, ...parts.slice(0, index), "ProjectSettings", "ProjectVersion.txt")));
  });
}

/** Untracked files above this size stay on disk: a WIP checkpoint must not bloat the job branch. */
export const MAX_UNTRACKED_CHECKPOINT_BYTES = 5 * 1024 * 1024;
const SECRET_DIRECTORIES = new Set([".ssh", ".aws", ".gnupg", ".azure"]);
const SECRET_NAMES = new Set([".npmrc", ".pypirc", ".netrc", ".git-credentials", "auth.json"]);

/** Case-insensitive basename deny list for untracked files: keys, credentials and token-bearing tool config. */
export function secretLikePath(file: string): boolean {
  const parts = file.replace(/\\/g, "/").toLowerCase().split("/");
  if (parts.slice(0, -1).some((part) => SECRET_DIRECTORIES.has(part))) return true;
  const name = parts.at(-1)!;
  if (name === ".env") return true;
  if (name.startsWith(".env.")) return !/\.(example|sample|template)$/.test(name);
  if (SECRET_NAMES.has(name)) return true;
  if (/\.(pem|key|p8|p12|pfx|ppk|jks|keystore|secret|secrets|kdbx|mobileprovision)$/.test(name)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(name)) return true;
  if (name.startsWith("credentials") || /credentials.*\.json$/.test(name) || /^service-account.*\.json$/.test(name) || name.startsWith("secrets.")) return true;
  return name.includes(".tfstate");
}

function oversized(root: string, file: string): boolean {
  try { return lstatSync(toNamespacedPath(join(root, file))).size > MAX_UNTRACKED_CHECKPOINT_BYTES; }
  catch { return false; }
}

/**
 * A checkpoint commit is refused while git is mid-operation or HEAD is detached: committing then would
 * finish or corrupt the job's merge, rebase, cherry-pick or revert. The caller lists the dirty files instead.
 */
async function checkpointBlocker(wt: Worktree, log: Logger, includeUntracked: boolean): Promise<string | undefined> {
  const trust = trustArgs(wt.path);
  const gitDir = await git([...trust, "rev-parse", "--absolute-git-dir"], wt.path, log);
  const states: [string, string][] = [["index.lock", "an index.lock is present"], ["MERGE_HEAD", "a merge is in progress"],
    ["CHERRY_PICK_HEAD", "a cherry-pick is in progress"], ["REVERT_HEAD", "a revert is in progress"],
    ["rebase-merge", "a rebase is in progress"], ["rebase-apply", "a rebase is in progress"]];
  for (const [name, why] of states) if (existsSync(toNamespacedPath(join(gitDir, name)))) return why;
  if (includeUntracked && !(await git([...trust, "symbolic-ref", "-q", "HEAD"], wt.path, log).catch(() => ""))) return "HEAD is detached";
  return undefined;
}

async function autoCommitFiles(wt: Worktree, log: Logger, includeUntracked = false): Promise<SkippedFile[]> {
  const trust = trustArgs(wt.path);
  const status = await git([...trust, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], wt.path, log);
  const included: string[] = [];
  const unstage: string[] = [];
  const skipped: SkippedFile[] = [];
  for (const entry of status.split("\0").filter(Boolean)) {
    const file = entry.slice(3);
    const literal = `:(literal)${file}`;
    const untracked = entry.startsWith("??");
    // A file the job staged itself (index state A: added, not in HEAD) gets the same secret and size filter as an
    // untracked one; a skipped one is unstaged below, never deleted from disk (AB-398 N2).
    // Intent-to-add (`git add -N`, worktree state A) counts too: `git diff HEAD` would show it as new content.
    const added = entry[0] === "A" || entry[1] === "A";
    let reason: SkippedFile["reason"] | undefined;
    // Entrypoints and hashed chunks form one generated set. Exclude every change,
    // including staged additions/deletions, so a checkpoint retains the HEAD bundle.
    if (/^plugins\/[^/]+\/dist\//.test(file)) reason = "generated bundle; excluded atomically";
    else if (generatedNoise(wt.path, file)) reason = "generated noise";
    else if (untracked && !includeUntracked) reason = "untracked; not explicitly staged";
    else if ((untracked || added) && secretLikePath(file)) reason = "possible secret; never auto-committed";
    else if ((untracked || added) && oversized(wt.path, file)) reason = "larger than 5 MB; not auto-committed";
    else if (untracked || await git([...trust, "diff", "--ignore-all-space", "--ignore-cr-at-eol", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", "--", literal], wt.path, log)) {
      // An already staged deletion has no path left in the index for `git add` to match.
      if (!entry.startsWith("D ")) included.push(literal);
    } else reason = "whitespace only";
    if (reason) {
      skipped.push({ path: file, reason });
      if (added || entry[0] !== "?" && entry[0] !== " ") unstage.push(literal);
    }
  }
  // The job may already have staged noise. Unstage it without changing the files on disk.
  for (const file of unstage) await git([...trust, "reset", "-q", "HEAD", "--", file], wt.path, log);
  for (const file of included) await git([...trust, "add", "-A", "--", file], wt.path, log);
  return skipped;
}

/**
 * Checkpoint subjects that may become commit metadata: subagentCommitMessage's sanitized subject for a finished
 * turn, "WIP: " plus that subject for a real WIP checkpoint, and the legacy WIP subject. Any other text (task or
 * answer text, which may carry attribution or instructions) falls back to the plain default for its mode.
 */
const SANITIZED_SUBJECT = subagentCommitMessage({ answer: "", task: "", agent: "" });
export const CHECKPOINT_MESSAGES = new Set([SANITIZED_SUBJECT, `WIP: ${SANITIZED_SUBJECT}`, "WIP: save job work"]);

/** A linked worktree keeps a `.git` file, never a directory: the disabled-hooks path below relies on that. */
async function assertLinkedWorktree(wt: Worktree, log: Logger): Promise<void> {
  const trust = trustArgs(wt.path);
  const dotGit = join(wt.path, ".git");
  let file = false;
  try { file = lstatSync(toNamespacedPath(dotGit)).isFile(); } catch { /* missing */ }
  const [gitDir, common] = (await git([...trust, "rev-parse", "--absolute-git-dir", "--git-common-dir"], wt.path, log)).split(/\r?\n/);
  if (!file || !gitDir || !common || resolve(wt.path, common).toLowerCase() === resolve(gitDir).toLowerCase())
    throw new Error(`${wt.path} is not a linked job worktree; refusing to make a checkpoint commit there.`);
}

/** Commit substantive, non-generated changes and summarize the diff of the job's work. */
export async function finishWorktree(wt: Worktree, message: string, log: Logger, includeUntracked = false): Promise<WorktreeOutcome> {
  const trust = trustArgs(wt.path);
  await assertLinkedWorktree(wt, log);
  const blocker = await checkpointBlocker(wt, log, includeUntracked);
  if (blocker) throw new Error(`Checkpoint commit skipped: ${blocker}.`);
  const subject = CHECKPOINT_MESSAGES.has(message) ? message : includeUntracked ? "WIP: save job work" : "Save worktree changes";
  const skippedFiles = await autoCommitFiles(wt, log, includeUntracked);
  const status = await git([...trust, "diff", "--cached", "--name-only", "-z"], wt.path, log);
  if (status) {
    // Never invent an identity. Keep the checkout and report missing repository configuration.
    for (const key of ["user.name", "user.email"]) {
      if (!(await git([...trust, "config", "--get", key], wt.path, log).catch(() => "")).trim()) throw new Error(`Configure ${key} before saving worktree changes.`);
    }
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)$/i.test(key)) delete env[key];
    // --no-verify alone still runs prepare-commit-msg, which can append forbidden attribution: git() points
    // core.hooksPath at the bridge's empty hooks directory for every call (AB-422), so no hook runs.
    await git([...trust, "commit", "-q", "--no-verify", "-m", subject], wt.path, log, GIT_TIMEOUT_MS, env);
  }
  await unlockWorktree(wt.repoRoot, wt.path, log);
  // The job may have switched to (or created) a branch of its own: its work is wherever it committed.
  const current = (await git([...trust, "branch", "--show-current"], wt.path, log).catch(() => "")) || wt.branch;
  const work = await workBranches(wt, current, log);
  // The job's branch: the checked-out one, unless only another branch of this worktree carries work.
  const branch = work.has(current) || !work.size ? current : [...work.keys()][0]!;
  const from = await reviewBase(wt, log, branch);
  const diffStat = await git(["diff", "--stat", `${from}..${branch}`], wt.repoRoot, log);
  const files = (await git(["diff", "--name-only", "-z", `${from}..${branch}`], wt.repoRoot, log)).split("\0").filter(Boolean);
  const otherBranches = [...work].filter(([name]) => name !== branch).map(([name, commits]) => ({ name, commits }));
  return { changed: diffStat.length > 0 || otherBranches.length > 0, branch, otherBranches, diffStat: diffStat.slice(0, MAX_DIFFSTAT_CHARS), reviewBase: from, files, skippedFiles };
}

/**
 * Branches committed from this worktree that carry work beyond their base, with their commit counts: the
 * worktree's branch, the one checked out now, and every branch whose tip this worktree's HEAD has been on
 * (its own reflog), so a branch the job made and then left is found too.
 */
async function workBranches(wt: Worktree, current: string, log: Logger): Promise<Map<string, number>> {
  const trust = trustArgs(wt.path);
  const visited = new Set((await git([...trust, "log", "-g", "--format=%H%x09%gs", "HEAD"], wt.path, log).catch(() => ""))
    .split(/\r?\n/).filter((line) => line && !line.includes("\tcheckout: ")).map((line) => line.split("\t")[0]));
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

/** At most this many skipped paths (or directory groups) are listed in a report (AB-380). */
export const MAX_LISTED_SKIPPED_PATHS = 50;

/** The skipped files, bounded: every path when few, else counts per top-level directory, then "… and N more". */
function skippedSummary(skipped: readonly SkippedFile[]): string {
  const list = (items: string[]) => items.slice(0, MAX_LISTED_SKIPPED_PATHS).join(", ") +
    (items.length > MAX_LISTED_SKIPPED_PATHS ? `, … and ${items.length - MAX_LISTED_SKIPPED_PATHS} more` : "");
  if (skipped.length <= MAX_LISTED_SKIPPED_PATHS) return list(skipped.map((f) => `${f.path} (${f.reason})`));
  const groups = new Map<string, { dir: string; reason: string; count: number }>();
  for (const f of skipped) {
    const path = f.path.replace(/\\/g, "/"), slash = path.indexOf("/");
    const dir = slash > 0 ? path.slice(0, slash + 1) : path, key = `${dir}\0${f.reason}`;
    const group = groups.get(key) ?? { dir, reason: f.reason, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  const entries = [...groups.values()].sort((a, b) => b.count - a.count)
    .map((g) => g.count > 1 ? `${g.dir} (${g.count} files, ${g.reason})` : `${g.dir} (${g.reason})`);
  return `${skipped.length} files: ${list(entries)}`;
}

/** Human/agent-readable instructions for taking or discarding the subagent's work. */
export function worktreeReport(wt: Worktree, outcome: WorktreeOutcome): string {
  const branch = outcome.branch ?? wt.branch;
  const skipped = outcome.skippedFiles ?? [];
  const rule = skipped.length
    ? `Auto-commit skipped whitespace/line-ending-only changes, generated noise, possible secrets, files over 5 MB and unstaged untracked files; left on disk: ${skippedSummary(skipped)}.`
    : "";
  const remove = "git -c core.longpaths=true worktree remove";
  // Only a worktree without any work of its own may be removed.
  if (!outcome.changed) return displayPathText([
    skipped.length ? `Worktree ${wt.path} (branch ${branch}) has no real changes committed; excluded files remain on disk. Keep this worktree for review.`
      : `Worktree ${wt.path} (branch ${branch}) has no changes; remove it with: ${remove} "${wt.path}" && git branch -D ${branch}`,
    rule,
  ].filter(Boolean).join("\n"));
  const others = outcome.otherBranches ?? [];
  const lines = [
    `Changes are committed on branch ${branch} (worktree ${wt.path}), not in your working copy` +
      (branch !== wt.branch ? ` (the job worked on its own branch; ${wt.branch} was its starting branch)` : "") +
      ":",
  ];
  if (outcome.diffStat) lines.push(outcome.diffStat);
  if (rule) lines.push(rule);
  if (others.length) lines.push(`Also committed from this worktree: ${others.map((o) => `${o.name} (${o.commits} commit${o.commits === 1 ? "" : "s"})`).join(", ")}. Review those before removing anything.`);
  lines.push(...[handoffWarning(outcome.files)].filter((w): w is string => Boolean(w)));
  if (outcome.diffStat) {
    lines.push(`Review base: ${outcome.reviewBase} (job fork point).`);
    lines.push(`Review: git diff ${outcome.reviewBase.slice(0, 12)}..${branch}`);
    lines.push(`Take them: git merge ${branch}   (or git cherry-pick ${branch})`);
  }
  lines.push(skipped.length ? "Excluded files remain on disk. Keep this worktree until they have been reviewed and preserved."
    : `Discard: ${remove} --force "${wt.path}" && git branch -D ${[branch, ...others.map((o) => o.name)].join(" ")}`);
  return displayPathText(lines.join("\n"));
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

/** The files changed since `before`, or null (unknown) when the later snapshot could not be taken (AB-422). */
export function snapshotChanges(before: Map<string, string>, after: Map<string, string> | null): string[] | null {
  return after ? changedFiles(before, after) : null;
}

/** The working-copy report after a job: an unknown comparison is never reported as "No files changed". */
export function changedFilesNote(changed: string[] | null, access?: string): string | null {
  if (changed === null) return "Files changed in your working copy: unknown. git status was refused or failed before or after the job (for example because the folder is not a git repository, or repository-local git config could run programs, AB-422), so the working copy could not be compared; check it yourself.";
  if (changed.length) return `Files changed in your working copy:\n${changed.join("\n")}`;
  return access === "edit" ? "No files changed." : null;
}

/**
 * What a Codex ask-mode run tells about its permission hook, given a before snapshot was taken: the hook asked
 * ("verified"); files changed without it asking, or the working copy turned into one git refuses to compare
 * (the job changed repository state, AB-422), so it was bypassed ("failed"); or nothing to tell (null).
 */
export function codexHookObservation(relayCalls: number, changed: string[] | null): "verified" | "failed" | null {
  if (relayCalls > 0) return "verified";
  return changed === null || changed.length ? "failed" : null;
}

/** Every root that can hold bridge-managed worktrees: the default and the configured worktreeRoot (AB-177).
 * Detection, cleanup and the dashboard use all of them, so trees under a custom root are not missed. */
export function worktreeRoots(home: string): string[] {
  const roots = [join(home, "worktrees")];
  const configured = loadConfig(home, "other", nullLogger).worktreeRoot;
  if (configured && resolve(configured).toLowerCase() !== resolve(roots[0]!).toLowerCase()) roots.push(configured);
  return roots;
}
