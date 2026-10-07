import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isPluginCacheCwd } from "./session-visibility.js";

/** The common Git directory identifies linked worktrees; physical paths unify subst aliases. */
export function canonicalProjectRoot(cwd: string): string | null {
  if (isPluginCacheCwd(cwd)) return null;
  const visibleRoot = (root: string): string | null => isPluginCacheCwd(root) ? null : root;
  try {
    const physical = realpathSync.native(cwd);
    if (isPluginCacheCwd(physical)) return null;
    if (!statSync(physical).isDirectory()) return null;
    const git = (args: string[]) => execFileSync("git", ["-C", physical, "rev-parse", ...args],
      { encoding: "utf8", timeout: 3_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    try {
      const top = realpathSync.native(git(["--show-toplevel"]));
      const common = realpathSync.native(resolve(physical, git(["--git-common-dir"])));
      // Ordinary repositories and linked worktrees share the main checkout's .git directory.
      if (common.endsWith("/.git") || common.endsWith("\\.git")) return visibleRoot(realpathSync.native(dirname(common)));
      try {
        const configured = execFileSync("git", ["--git-dir", common, "config", "--get", "core.worktree"],
          { encoding: "utf8", timeout: 3_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (configured) return visibleRoot(realpathSync.native(resolve(common, configured)));
      } catch { /* A separate Git directory can instead identify its main through worktree metadata. */ }
      const worktrees = execFileSync("git", ["-C", physical, "worktree", "list", "--porcelain"],
        { encoding: "utf8", timeout: 3_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const main = worktrees.split(/\r?\n\r?\n/).find((entry) => !/^bare$/m.test(entry));
      const root = main && /^worktree (.+)$/m.exec(main)?.[1];
      return visibleRoot(root ? realpathSync.native(root) : top);
    } catch {
      // Non-Git projects share only an identical existing directory, never guessed ancestors.
      return physical;
    }
  } catch { return null; }
}

export function projectKey(root: string): string {
  return process.platform === "win32" ? root.toLowerCase() : root;
}

/** Read-only settings: a malformed opt-out cannot accidentally grant authority. */
export function projectGroupsEnabled(root: string | null, home?: string, agent?: string): boolean {
  if (!root) return false;
  try {
    const records: Record<string, unknown>[] = [];
    for (const path of [home && join(home, "config.json"), join(root, ".agent-bridge", "config.json")]) {
      if (!path || !existsSync(path)) { records.push({}); continue; }
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      records.push(value as Record<string, unknown>);
    }
    const section = (value: Record<string, unknown>): Record<string, unknown> => {
      const local = agent ? value[agent] : undefined;
      return local && typeof local === "object" && !Array.isArray(local) ? local as Record<string, unknown> : {};
    };
    const [globalConfig, projectConfig] = records as [Record<string, unknown>, Record<string, unknown>];
    const enabled = [section(projectConfig).projectGroups, projectConfig.projectGroups,
      section(globalConfig).projectGroups, globalConfig.projectGroups].find((v) => v !== undefined);
    return enabled === undefined || enabled === true;
  } catch { return false; }
}

/** Additive v4 migration. Unknown records and fields are retained; unresolved identities stay closed. */
export function migrateProjectJobs(records: unknown[]): unknown[] {
  const roots = new Map<string, string | null>();
  const rootFor = (cwd: string): string | null => {
    if (!roots.has(cwd)) roots.set(cwd, canonicalProjectRoot(cwd));
    return roots.get(cwd) ?? null;
  };
  return records.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const job = entry as Record<string, unknown>;
    if (typeof job.projectRoot === "string") return entry;
    const worktree = job.worktree as Record<string, unknown> | null;
    for (const value of [worktree?.repoRoot, job.workdir]) {
      if (typeof value !== "string") continue;
      const root = rootFor(value);
      if (root) return { ...job, projectRoot: root };
    }
    return entry;
  });
}
