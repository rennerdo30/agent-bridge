import { existsSync, lstatSync, realpathSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
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
  repository?: string | null;
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

export interface CleanupScope {
  all: boolean;
  repository: string | null;
  projects: { repository: string | null; paths: string[] }[];
}

/** Common directory identifies a repository even from one of its linked worktrees. */
export async function repositoryCommonDir(cwd: string, log: Logger): Promise<string> {
  const common = await git([...trustArgs(cwd), "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, log);
  return realpathSync(resolve(cwd, common));
}

/** Resolve and announce the complete scope before any mutation. Unknown repositories stay scoped out. */
export async function cleanupWorktrees(opts: {
  home: string; apply: boolean; log: Logger; cwd?: string; repo?: string; all?: boolean;
  onScope?: (scope: CleanupScope) => void;
}): Promise<CleanupEntry[]> {
  if (opts.all && opts.repo) throw new Error("Use either --all or --repo, not both.");
  const repository = opts.all ? null : await repositoryCommonDir(opts.repo ?? opts.cwd ?? process.cwd(), opts.log);
  const dir = join(opts.home, "worktrees");
  const jobs = readJobs(opts.home);
  const candidates: { path: string; repository: string | null }[] = [];
  for (const d of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
    const path = join(dir, d.name);
    if (!d.isDirectory() || lstatSync(path).isSymbolicLink()) continue;
    let common = await repositoryCommonDir(path, opts.log).catch(() => null);
    // A removed worktree may still have a durable job record. Never guess by folder/branch name.
    if (!common && !existsSync(join(path, ".git"))) {
      const job = jobs.find((j) => j.worktree && samePath(j.worktree.path, path));
      if (job?.worktree) common = await repositoryCommonDir(job.worktree.repoRoot, opts.log).catch(() => null);
    }
    if (opts.all || (common && repository && samePath(common, repository))) candidates.push({ path, repository: common });
  }
  const projects: CleanupScope["projects"] = [];
  for (const candidate of candidates) {
    let project = projects.find((p) => p.repository === candidate.repository);
    if (!project) { project = { repository: candidate.repository, paths: [] }; projects.push(project); }
    project.paths.push(candidate.path);
  }
  opts.onScope?.({ all: Boolean(opts.all), repository, projects });
  if (opts.apply && projects.length > 1 && !opts.all) throw new Error("Removing worktrees from multiple repositories requires --all --yes.");
  const out: CleanupEntry[] = [];
  for (const candidate of candidates) {
    // Verify identity again immediately before inspection/deletion in case the scope changed meanwhile.
    const current = await repositoryCommonDir(candidate.path, opts.log).catch(() => null);
    if (!opts.all && current && repository && !samePath(current, repository)) {
      out.push({ ...candidate, branch: null, action: "kept", reason: "repository changed after scope selection" });
      continue;
    }
    const entry = await inspect(candidate.path, jobs, opts.apply, opts.log).catch((err): CleanupEntry => ({ path: candidate.path, branch: null, action: "kept", reason: `cannot read it: ${(err as Error).message.split("\n")[0]}` }));
    out.push({ ...entry, repository: candidate.repository });
  }
  return out;
}
