import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, toNamespacedPath } from "node:path";

export const WORKTREE_LINK_HINT =
  "(agent-bridge: worktree isolation is mandatory. Never create symlinks, directory junctions or other reparse points whose targets leave this worktree, including Unity Library folders in the owner's main checkout. Copy caches if needed; do not share them through links. Never follow an existing external link to modify its target. Request cleanup approval through the supervisor and report the link and target if cleanup is denied.)";

export interface WorktreeLinkScan {
  externalLinks: { path: string; target: string }[];
  errors: string[];
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
        if (!inside(target)) scan.externalLinks.push({ path, target });
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
  const lines = scan.externalLinks.map((link) => `${link.path} -> ${link.target}`);
  if (lines.length) lines.unshift("WARNING: external worktree links/reparse points found. Do not run tools through these links; unlink the link itself without recursively deleting its target:");
  if (scan.errors.length) lines.push(`WARNING: worktree link inspection incomplete:\n${scan.errors.join("\n")}`);
  return lines.length ? lines.join("\n") : null;
}
