import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join, resolve, toNamespacedPath } from "node:path";
import { JOBS_FILE } from "./constants.js";
import type { Logger } from "./logger.js";
import { BRANCH_PREFIX, git, removeWorktreeDirectory, trustArgs, type Worktree } from "./worktree.js";
import { readStore } from "../mcp/jobs.js";
import { scanWorktreeLinks, worktreeLinkWarning, type WorktreeLinkScan } from "./worktree-links.js";

/**
 * `agent-bridge cleanup`: remove the worktrees of finished agent-bridge jobs (~/.agent-bridge/worktrees) whose
 * work is safe elsewhere: branch fully merged into its base, nothing uncommitted. Everything else is kept.
 */
export interface CleanupEntry {
  path: string;
  branch: string | null;
  action: "removed" | "would remove" | "kept" | "failed";
  reason: string;
  externalLinks?: WorktreeLinkScan["externalLinks"];
}

type StoredJob = { name?: string; status?: string; worktree?: Worktree | null };

function readJobs(home: string): StoredJob[] {
  try {
    return readStore(join(home, JOBS_FILE));
  } catch {
    return [];
  }
}

const samePath = (a: string, b: string) =>
  process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

/**
 * Remove every symlink and junction below `dir` without following it (a worktree may link to a big shared
 * folder, e.g. a Unity Library): deleting the tree afterwards cannot reach through them. Returns the count.
 */
export function unlinkLinks(dir: string): number {
  dir = toNamespacedPath(resolve(dir));
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    // lstat as well: never trust the directory entry alone to tell a junction from a folder.
    const link = entry.isSymbolicLink() || ((entry.isDirectory() || !entry.isFile()) && lstatSync(path).isSymbolicLink());
    if (link) {
      try {
        unlinkSync(path);
      } catch {
        // Windows removes directory links (junctions, directory symlinks) with rmdir; it never touches the target.
        rmdirSync(path);
      }
      count++;
    } else if (entry.isDirectory()) count += unlinkLinks(path);
  }
  return count;
}

/**
 * Whether `dir` holds nothing but folders and links (what a half-removed worktree with a junction leaves).
 * A folder it cannot read counts as holding files: unknown content is never deleted.
 */
function onlyFoldersAndLinks(dir: string): boolean {
  dir = toNamespacedPath(resolve(dir));
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.every((e) => {
    const path = join(dir, e.name);
    if (e.isSymbolicLink() || lstatSync(path).isSymbolicLink()) return true;
    return e.isDirectory() && onlyFoldersAndLinks(path);
  });
}

/** Whether `branch` is fully contained in one of `targets`. */
async function mergedInto(branch: string, targets: string[], cwd: string, trust: string[], log: Logger): Promise<string | null> {
  for (const t of targets) {
    try {
      await git([...trust, "merge-base", "--is-ancestor", branch, t], cwd, log);
      return t;
    } catch {
      // not merged there (or no such branch)
    }
  }
  return null;
}

async function inspect(path: string, jobs: StoredJob[], apply: boolean, log: Logger): Promise<CleanupEntry> {
  const scan = scanWorktreeLinks(path);
  const warning = worktreeLinkWarning(scan);
  const entry = (branch: string | null, action: CleanupEntry["action"], reason: string): CleanupEntry => ({ path, branch, action, reason: warning ? `${reason}\n${warning}` : reason, externalLinks: scan.externalLinks });
  if (scan.errors.length) return entry(null, "kept", "link inspection incomplete; refusing cleanup");
  if (!existsSync(toNamespacedPath(join(path, ".git")))) {
    if (!onlyFoldersAndLinks(path)) return entry(null, "kept", "not a git worktree (no .git), and it holds files");
    const why = "leftover of a removed worktree: no .git, only empty folders and links";
    if (!apply) return entry(null, "would remove", why);
    try {
      const links = unlinkLinks(path);
      removeWorktreeDirectory(path);
      return entry(null, "removed", links ? `${why}; unlinked ${links} link(s) first` : why);
    } catch (err) {
      return entry(null, "failed", (err as Error).message.split("\n")[0]!);
    }
  }
  const trust = trustArgs(path);
  let branch: string;
  let mainPath: string;
  try {
    branch = await git([...trust, "symbolic-ref", "-q", "--short", "HEAD"], path, log);
    const list = await git([...trust, "worktree", "list", "--porcelain"], path, log);
    mainPath = /^worktree (.+)$/m.exec(list)?.[1] ?? "";
    if (!mainPath) throw new Error("no main worktree");
  } catch (err) {
    return entry(null, "kept", `git cannot read it: ${(err as Error).message.split("\n")[0]}`);
  }
  if (!branch.startsWith(BRANCH_PREFIX)) return entry(branch, "kept", "not on an agent-bridge/ branch");
  const job = jobs.find((j) => j.worktree && (samePath(j.worktree.path, path) || j.worktree.branch === branch));
  if (job?.status === "running") return entry(branch, "kept", `job ${job.name ?? "?"} is running`);
  const status = await git([...trust, "status", "--porcelain"], path, log).catch(() => null);
  if (status === null) return entry(branch, "kept", "git status failed");
  if (status) return entry(branch, "kept", `uncommitted changes (${status.split(/\r?\n/).length} files)`);
  // Its base branch when the job recorded one, else any local branch that is not a job branch.
  const base = job?.worktree?.baseBranch;
  const locals = (await git([...trust, "for-each-ref", "--format=%(refname:short)", "refs/heads"], path, log).catch(() => ""))
    .split(/\r?\n/)
    .filter((b) => b && !b.startsWith(BRANCH_PREFIX));
  const targets = base && locals.includes(base) ? [base] : locals;
  const into = await mergedInto(branch, targets, path, trust, log);
  if (!into) return entry(branch, "kept", base && locals.includes(base) ? `has commits not merged into ${base}` : "has commits not merged into any local branch");
  const why = `merged into ${into}, clean`;
  if (!apply) return entry(branch, "would remove", why);
  try {
    const links = unlinkLinks(path);
    // A lock (e.g. "initializing" left by an interrupted `worktree add`) blocks removal.
    await git([...trust, "worktree", "unlock", path], mainPath, log).catch(() => "");
    await git([...trust, "worktree", "remove", path], mainPath, log).catch(async (err) => {
      // Git could not delete it all (files of another account, open handles): delete what is left ourselves.
      if (!existsSync(toNamespacedPath(path))) return;
      log.warn("git worktree remove failed; deleting the folder", { path, err: (err as Error).message });
      removeWorktreeDirectory(path);
      await git(["worktree", "prune"], mainPath, log);
    });
    await git(["branch", "-D", branch], mainPath, log);
    return entry(branch, "removed", links ? `${why}; unlinked ${links} link(s) inside first` : why);
  } catch (err) {
    return entry(branch, "failed", (err as Error).message.split("\n")[0]!);
  }
}

/** Inspect (and with `apply`, remove) the job worktrees in `home`/worktrees. */
export async function cleanupWorktrees(opts: { home: string; apply: boolean; log: Logger }): Promise<CleanupEntry[]> {
  const dir = join(opts.home, "worktrees");
  if (!existsSync(dir)) return [];
  const jobs = readJobs(opts.home);
  const out: CleanupEntry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    // Links in the worktrees folder itself are not ours to follow either.
    if (!d.isDirectory() || lstatSync(join(dir, d.name)).isSymbolicLink()) continue;
    const path = join(dir, d.name);
    // One unreadable worktree (e.g. files of another account) must not stop the others.
    out.push(await inspect(path, jobs, opts.apply, opts.log).catch((err): CleanupEntry => ({ path, branch: null, action: "kept", reason: `cannot read it: ${(err as Error).message.split("\n")[0]}` })));
  }
  return out;
}
