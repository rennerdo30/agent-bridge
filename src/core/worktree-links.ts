import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from "node:path";

export const WORKTREE_LINK_HINT =
  "(agent-bridge: worktree isolation is mandatory for source and writable files. External directory links may be used only for read-only access to Git-ignored caches: node_modules, .vs, __pycache__, or Library beside a Unity ProjectSettings/ProjectVersion.txt. Never write, delete, truncate or change permissions in a linked source, including through an internal link chain. A junction does not enforce read-only access: do not run Unity imports, package installers or other cache-writing tools through it. Prefer a project's external-cache env/config option (e.g. ANIMASKY_LIBRARY_ROOT) when available; never substitute an incomplete cache copy. Other external links remain forbidden. Cleanup must unlink only the link itself and never recurse into its target. Request cleanup approval through the supervisor and report the link and target if cleanup is denied.)";

export interface WorktreeLinkScan {
  externalLinks: { path: string; target: string }[];
  /** Eligible for reads only; this is a policy classification, not a filesystem write barrier. */
  readOnlyCacheLinks?: { path: string; target: string }[];
  errors: string[];
}

/** Fail closed when Git cannot prove the link is ignored and has no tracked contents. */
function ignoredCacheLink(root: string, path: string): boolean {
  const name = basename(path);
  const cache = ["node_modules", ".vs", "__pycache__"].includes(name) ||
    (name === "Library" && existsSync(join(dirname(path), "ProjectSettings", "ProjectVersion.txt")));
  if (!cache || path === root) return false;
  const rel = relative(root, path).split(sep).join("/");
  try {
    root = realpathSync.native(root);
    const args = ["-c", `safe.directory=${root.split(sep).join("/")}`];
    const tracked = execFileSync("git", [...args, "ls-files", "-z", "--", `:(literal)${rel}`], { cwd: root, encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
    if (tracked) return false;
    // POSIX Git refuses cache/ through a symlink; cache alone cannot match directory-only rules.
    // Ask Git about an empty physical directory in a private view of the ancestor ignore files.
    // Keep the real git-dir so repository/global excludes and Git's own matching semantics apply.
    const gitDir = execFileSync("git", [...args, "rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    let excludes = "";
    try {
      excludes = execFileSync("git", [...args, "config", "--path", "--get", "core.excludesFile"], { cwd: root, encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    } catch (err) { if ((err as { status?: number }).status !== 1) throw err; }
    const ignoreArgs = excludes ? [...args, "-c", `core.excludesFile=${resolve(root, excludes)}`] : args;
    const probe = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-cache-ignore-")));
    try {
      mkdirSync(join(probe, rel), { recursive: true });
      const parts = rel.split("/");
      for (let i = 0; i < parts.length; i++) {
        const parent = join(root, ...parts.slice(0, i));
        const ignore = join(parent, ".gitignore");
        if (existsSync(ignore) && lstatSync(ignore).isFile()) copyFileSync(ignore, join(probe, ...parts.slice(0, i), ".gitignore"));
      }
      execFileSync("git", [...ignoreArgs, `--git-dir=${gitDir}`, `--work-tree=${probe}`, "check-ignore", "--no-index", "--quiet", "--", `${rel}/`], { cwd: probe, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
      return true;
    } finally {
      // Only the private mkdtemp view (empty cache directories and copied ignore rules), never source.
      rmSync(probe, { recursive: true, force: true });
    }
  } catch { return false; }
}

/**
 * Resolve aliases above a protected boundary and check every component at/below it without following
 * links. Shared by every worktree removal path, including failed worktree creation.
 */
export function resolveWorktreeRemovalPath(path: string, managedRoot = path): string {
  const boundary = resolve(managedRoot);
  const rel = relative(boundary, resolve(path));
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel) || dirname(boundary) === boundary) {
    throw new Error(`Refusing cleanup outside the managed worktree area: ${path}`);
  }
  // System/home aliases above the explicit boundary are legitimate. Resolve them once, then never
  // follow a link at or below the boundary (including a worktree-container/root replacement).
  let checked = join(realpathSync.native(dirname(boundary)), basename(boundary));
  for (const part of ["", ...(rel ? rel.split(sep) : [])]) {
    checked = join(checked, part);
    if (lstatSync(toNamespacedPath(checked)).isSymbolicLink()) throw new Error(`Refusing cleanup through a linked path: ${checked}`);
  }
  return checked;
}

/** Pass the worktree/container root when unlinking a nested directory. */
export function unlinkLinks(dir: string, managedRoot = dir): number {
  return unlinkChildren(resolveWorktreeRemovalPath(dir, managedRoot));
}

function unlinkChildren(dir: string): number {
  dir = toNamespacedPath(resolve(dir));
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`Refusing cleanup through a linked worktree root: ${dir}`);
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      try { unlinkSync(path); }
      catch {
        // Nonrecursive rmdir removes a Windows directory link itself, never the destination.
        rmdirSync(path);
      }
      count++;
    } else if (stat.isDirectory()) count += unlinkChildren(path);
  }
  return count;
}

/** Inspect ignored folders too, but never recurse through a symlink or directory junction. */
export function scanWorktreeLinks(root: string): WorktreeLinkScan {
  const scan: WorktreeLinkScan = { externalLinks: [], errors: [] };
  const canonicalRoot = lstatSync(toNamespacedPath(root)).isSymbolicLink() ? resolve(root) : realpathSync.native(root);
  const inside = (target: string) => {
    const rel = relative(canonicalRoot, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel));
  };
  const visit = (path: string) => {
    try {
      const stat = lstatSync(toNamespacedPath(path));
      if (stat.isSymbolicLink()) {
        const raw = readlinkSync(toNamespacedPath(path));
        let target = resolve(dirname(path), raw);
        try { target = realpathSync.native(path); } catch { /* Retain a dangling link's declared target. */ }
        if (!inside(target)) {
          const link = { path, target };
          scan.externalLinks.push(link);
          // Do not inspect target contents. A broken or file link cannot qualify as a directory cache.
          let directory = false;
          try { directory = lstatSync(toNamespacedPath(target)).isDirectory(); } catch { /* Unavailable cache. */ }
          if (directory && ignoredCacheLink(resolve(root), path)) (scan.readOnlyCacheLinks ??= []).push(link);
        }
      } else if (stat.isDirectory()) {
        for (const entry of readdirSync(toNamespacedPath(path))) visit(join(path, entry));
      }
    } catch (err) {
      scan.errors.push(`${path}: ${(err as Error).message}`);
    }
  };
  visit(resolve(root));
  return scan;
}

export function worktreeLinkWarning(scan: WorktreeLinkScan): string | null {
  const caches = new Set(scan.readOnlyCacheLinks?.map((link) => link.path));
  const lines = scan.externalLinks.filter((link) => !caches.has(link.path)).map((link) => `${link.path} -> ${link.target}`);
  if (lines.length) lines.unshift("WARNING: external worktree links/reparse points found. Do not run tools through these links; unlink the link itself without recursively deleting its target:");
  if (caches.size) lines.push("Read-only ignored cache links (never modify the source; unlink only the link itself without recursively deleting its target):", ...scan.readOnlyCacheLinks!.map((link) => `${link.path} -> ${link.target}`));
  if (scan.errors.length) lines.push(`WARNING: worktree link inspection incomplete:\n${scan.errors.join("\n")}`);
  return lines.length ? lines.join("\n") : null;
}
