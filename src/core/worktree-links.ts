import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, toNamespacedPath } from "node:path";

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
  const rel = relative(root, path).replace(/\\/g, "/");
  try {
    const args = ["-c", `safe.directory=${root.replace(/\\/g, "/")}`];
    const tracked = execFileSync("git", [...args, "ls-files", "-z", "--", `:(literal)${rel}`], { cwd: root, encoding: "utf8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
    if (tracked) return false;
    execFileSync("git", [...args, "check-ignore", "--quiet", "--", `${rel}/`], { cwd: root, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch { return false; }
}

/**
 * Remove only link entries, never their contents. Refuse a linked root before reading its target.
 * Shared by every worktree removal path, including failed worktree creation.
 */
export function unlinkLinks(dir: string): number {
  // lstat on the leaf alone would follow a junction in a parent component into owner data.
  const parents: string[] = [];
  for (let parent = resolve(dir); ; parent = dirname(parent)) {
    if (dirname(parent) === parent) break;
    parents.push(parent);
  }
  // Inspect from the volume root down, so even metadata reads cannot cross a linked parent.
  for (const parent of parents.reverse()) {
    if (lstatSync(toNamespacedPath(parent)).isSymbolicLink()) throw new Error(`Refusing cleanup through a linked path: ${parent}`);
  }
  return unlinkChildren(dir);
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
