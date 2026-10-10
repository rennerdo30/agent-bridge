import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  worktreeLease
} from "./chunk-3MADE7LO.mjs";
import {
  t
} from "./chunk-BG6KJS4H.mjs";
import {
  BRANCH_PREFIX,
  git,
  removeWorktreeDirectory,
  resolveWorktreeRemovalPath,
  scanWorktreeLinks,
  trustArgs,
  unlinkLinks,
  worktreeLinkWarning,
  worktreeRoots
} from "./chunk-BZBROCKK.mjs";
import {
  readStore
} from "./chunk-GQYBHUNQ.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-NY45KO7G.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-M26SH6VN.mjs";
import "./chunk-V4WDBMEN.mjs";
import "./chunk-NAIKP65T.mjs";
import "./chunk-CZNWCZNZ.mjs";
import "./chunk-5I7IJLKF.mjs";
import "./chunk-4QXHCXBU.mjs";
import "./chunk-DAI2VPPJ.mjs";
import "./chunk-CCQJERHQ.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-OK4AKY67.mjs";
import "./chunk-JCI74XRN.mjs";
import "./chunk-TFQZM67X.mjs";
import "./chunk-S4W4VZWF.mjs";
import "./chunk-5KYAJ3AQ.mjs";
import {
  JOBS_FILE
} from "./chunk-XTHHW5FU.mjs";
import "./chunk-HHAVWD7J.mjs";

// src/cli/cleanup.ts
import { join as join2 } from "node:path";

// src/core/worktree-cleanup.ts
import { existsSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { dirname, join, resolve, toNamespacedPath } from "node:path";
function readJobs(home) {
  try {
    return readStore(join(home, JOBS_FILE), void 0, true);
  } catch {
    return [];
  }
}
var samePath = (a, b) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
function onlyFoldersAndLinks(dir) {
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
async function mergedInto(branch, targets, cwd, trust, log) {
  for (const t2 of targets) {
    try {
      await git([...trust, "merge-base", "--is-ancestor", branch, t2], cwd, log);
      return t2;
    } catch {
    }
  }
  return null;
}
async function inspect(path, jobs, apply, log, home) {
  const removalPath = resolveWorktreeRemovalPath(path, dirname(path));
  const scan = scanWorktreeLinks(path);
  const warning = worktreeLinkWarning(scan);
  const entry = (branch2, action, reason) => ({ path, branch: branch2, action, reason: warning ? `${reason}
${warning}` : reason, externalLinks: scan.externalLinks });
  if (scan.errors.length) return entry(null, "kept", "link inspection incomplete; refusing cleanup");
  if (!existsSync(toNamespacedPath(join(path, ".git")))) {
    if (!onlyFoldersAndLinks(path)) return entry(null, "kept", "not a git worktree (no .git), and it holds files");
    const why2 = "leftover of a removed worktree: no .git, only empty folders and links";
    if (!apply) return entry(null, "would remove", why2);
    try {
      const links = unlinkLinks(removalPath);
      removeWorktreeDirectory(removalPath);
      return entry(null, "removed", links ? `${why2}; unlinked ${links} link(s) first` : why2);
    } catch (err) {
      return entry(null, "failed", err.message.split("\n")[0]);
    }
  }
  const trust = trustArgs(path);
  let branch;
  let mainPath;
  try {
    branch = await git([...trust, "symbolic-ref", "-q", "--short", "HEAD"], path, log);
    const list = await git([...trust, "worktree", "list", "--porcelain"], path, log);
    mainPath = /^worktree (.+)$/m.exec(list)?.[1] ?? "";
    if (!mainPath) throw new Error("no main worktree");
  } catch (err) {
    return entry(null, "kept", `git cannot read it: ${err.message.split("\n")[0]}`);
  }
  if (!branch.startsWith(BRANCH_PREFIX)) return entry(branch, "kept", "not on an agent-bridge/ branch");
  const job = jobs.find((j) => j.worktree && (samePath(j.worktree.path, path) || j.worktree.branch === branch));
  if (job?.status === "running") return entry(branch, "kept", `job ${job.name ?? "?"} is running`);
  const status = await git([...trust, "status", "--porcelain"], path, log).catch(() => null);
  if (status === null) return entry(branch, "kept", "git status failed");
  if (status) return entry(branch, "kept", `uncommitted changes (${status.split(/\r?\n/).length} files)`);
  const ignored = await git([...trust, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], path, log).catch(() => null);
  if (ignored === null) return entry(branch, "kept", "ignored-file inspection failed");
  for (const file of ignored.split("\0").filter(Boolean)) {
    const ignoredPath = toNamespacedPath(join(path, file.replace(/[\\/]+$/, "")));
    try {
      const st = lstatSync(ignoredPath);
      if (st.isSymbolicLink() || st.isDirectory() && onlyFoldersAndLinks(ignoredPath)) continue;
      return entry(branch, "kept", "ignored files may contain unique user data; refusing cleanup");
    } catch {
      return entry(branch, "kept", "ignored-file inspection incomplete; refusing cleanup");
    }
  }
  const base = job?.worktree?.baseBranch;
  const locals = (await git([...trust, "for-each-ref", "--format=%(refname:short)", "refs/heads"], path, log).catch(() => "")).split(/\r?\n/).filter((b) => b && !b.startsWith(BRANCH_PREFIX));
  const targets = base && locals.includes(base) ? [base] : locals;
  const into = await mergedInto(branch, targets, path, trust, log);
  if (!into) return entry(branch, "kept", base && locals.includes(base) ? `has commits not merged into ${base}` : "has commits not merged into any local branch");
  const why = `merged into ${into}, clean`;
  if (!apply) return entry(branch, "would remove", why);
  let release = null;
  try {
    release = worktreeLease(existsSync(home) ? realpathSync.native(home) : home, { path });
  } catch (err) {
    return entry(branch, "kept", err.message.split("\n")[0]);
  }
  try {
    const links = unlinkLinks(removalPath);
    await git([...trust, "worktree", "unlock", removalPath], mainPath, log).catch(() => "");
    let refused = null;
    await git([...trust, "worktree", "remove", removalPath], mainPath, log).catch(async (err) => {
      if (!existsSync(toNamespacedPath(path))) return;
      const message = err.message;
      if (!PERMISSION_FAILURE.test(message)) {
        refused = message.split("\n")[0];
        return;
      }
      if (existsSync(toNamespacedPath(join(path, ".git")))) {
        const again = await git([...trust, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], path, log).catch(() => null);
        if (again !== "") {
          refused = again === null ? "git status failed after a partial removal" : "new uncommitted changes appeared";
          return;
        }
      }
      log.warn("git worktree remove hit a permission error; deleting the rest of the folder", { path, err: message });
      removeWorktreeDirectory(removalPath);
      await git(["worktree", "prune"], mainPath, log);
    });
    if (refused) return entry(branch, "kept", `git refused to remove it, so it is kept: ${refused}`);
    await git(["branch", "-D", branch], mainPath, log);
    return entry(branch, "removed", links ? `${why}; unlinked ${links} link(s) inside first` : why);
  } catch (err) {
    return entry(branch, "failed", err.message.split("\n")[0]);
  } finally {
    release?.();
  }
}
var PERMISSION_FAILURE = /Permission denied|Access is denied|\bEPERM\b|\bEACCES\b|\bEBUSY\b|used by another process|resource busy/i;
async function repositoryCommonDir(cwd, log) {
  const common = await git([...trustArgs(cwd), "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd, log);
  return realpathSync.native(resolve(cwd, common));
}
async function cleanupWorktrees(opts) {
  if (opts.all && opts.repo) throw new Error("Use either --all or --repo, not both.");
  const repository = opts.all ? null : await repositoryCommonDir(opts.repo ?? opts.cwd ?? process.cwd(), opts.log);
  const jobs = readJobs(opts.home);
  const candidates = [];
  const roots = worktreeRoots(opts.home);
  for (const [index, dir] of roots.entries()) {
    if (existsSync(dir)) resolveWorktreeRemovalPath(dir);
    for (const d of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const path = join(dir, d.name);
      if (!d.isDirectory() || lstatSync(path).isSymbolicLink()) continue;
      if (index > 0 && !jobs.some((j) => j.worktree && samePath(j.worktree.path, path)) && !/-[0-9a-f]{8}$/.test(d.name)) continue;
      let common = existsSync(join(path, ".git")) ? await repositoryCommonDir(path, opts.log).catch(() => null) : null;
      if (!common && !existsSync(join(path, ".git"))) {
        const job = jobs.find((j) => j.worktree && samePath(j.worktree.path, path));
        if (job?.worktree) common = await repositoryCommonDir(job.worktree.repoRoot, opts.log).catch(() => null);
      }
      if (opts.all || common && repository && samePath(common, repository)) candidates.push({ path, repository: common });
    }
  }
  const projects = [];
  for (const candidate of candidates) {
    let project = projects.find((p) => p.repository === candidate.repository);
    if (!project) {
      project = { repository: candidate.repository, paths: [] };
      projects.push(project);
    }
    project.paths.push(candidate.path);
  }
  opts.onScope?.({ all: Boolean(opts.all), repository, projects });
  if (opts.apply && projects.length > 1 && !opts.all) throw new Error("Removing worktrees from multiple repositories requires --all --yes.");
  const out = [];
  for (const candidate of candidates) {
    const current = existsSync(join(candidate.path, ".git")) ? await repositoryCommonDir(candidate.path, opts.log).catch(() => null) : null;
    if (!opts.all && current && repository && !samePath(current, repository)) {
      out.push({ ...candidate, branch: null, action: "kept", reason: "repository changed after scope selection" });
      continue;
    }
    const entry = await inspect(candidate.path, jobs, opts.apply, opts.log, opts.home).catch((err) => ({ path: candidate.path, branch: null, action: "kept", reason: `cannot read it: ${err.message.split("\n")[0]}` }));
    out.push({ ...entry, repository: candidate.repository });
  }
  return out;
}

// src/cli/cleanup.ts
async function runCleanup(args, opts) {
  let repo;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") {
      if (repo || !args[i + 1] || args[i + 1].startsWith("-")) throw new Error("--repo requires one repository path.");
      repo = args[++i];
    } else if (!["--all", "--yes", "-y", "--dry-run"].includes(args[i])) throw new Error(`Unknown cleanup option: ${args[i]}`);
  }
  const all = args.includes("--all");
  const apply = (args.includes("--yes") || args.includes("-y")) && !args.includes("--dry-run");
  const entries = await cleanupWorktrees({ ...opts, repo, all, apply, onScope: (scope) => {
    opts.out(`Cleanup scope: ${scope.all ? "all repositories" : scope.repository} (${apply ? "apply" : "dry run"})`);
    for (const project of scope.projects) {
      opts.out(`Repository: ${project.repository ?? "unknown (orphan folders)"}; ${project.paths.length} worktree(s)`);
      for (const path of project.paths) opts.out(`  ${path}`);
    }
  } });
  if (!entries.length) opts.out(t("cli.cleanup.none", { dir: join2(opts.home, "worktrees") }));
  for (const e of entries) opts.out(t("cli.cleanup.line", { action: e.action.padEnd(12), path: e.path, branch: e.branch ?? "-", reason: e.reason }));
  const count = (action) => entries.filter((e) => e.action === action).length;
  opts.out(t("cli.cleanup.summary", { removed: count("removed"), would: count("would remove"), kept: count("kept"), failed: count("failed") }));
  if (count("would remove")) opts.out(t("cli.cleanup.dryRun"));
  return count("failed") ? 1 : 0;
}
export {
  runCleanup
};
