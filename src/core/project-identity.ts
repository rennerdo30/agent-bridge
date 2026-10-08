import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isPluginCacheCwd } from "./session-visibility.js";

const projectRoots = new Map<string, { root: string | null; expiresAt: number; marker: string }>();
const PROJECT_ROOT_CACHE_MS = 30_000;

/** The common Git directory identifies linked worktrees; physical paths unify subst aliases. */
export function canonicalProjectRoot(cwd: string): string | null {
  if (isPluginCacheCwd(cwd)) return null;
  const visibleRoot = (root: string): string | null => isPluginCacheCwd(root) ? null : root;
  try {
    const physical = realpathSync.native(cwd);
    if (isPluginCacheCwd(physical)) return null;
    if (!statSync(physical).isDirectory()) return null;
    const cached = projectRoots.get(physical), now = Date.now(), discovery = discoverProjectRoot(physical);
    if (cached && cached.expiresAt > now && cached.marker === discovery.marker) return cached.root;
    const root = discovery.fallback ? resolveProjectRoot(physical, visibleRoot) : discovery.root === null ? null : visibleRoot(discovery.root);
    if (projectRoots.size >= 256) projectRoots.delete(projectRoots.keys().next().value!);
    projectRoots.set(physical, { root, expiresAt: now + PROJECT_ROOT_CACHE_MS, marker: discovery.marker });
    return root;
  } catch { return null; }
}

interface ProjectDiscovery { marker: string; root: string | null; fallback?: boolean }

/** Git excludes strict ancestor ceilings. Empty list entries disable later canonicalization. */
function discoveryCeiling(physical: string, configured: string | undefined): string | null {
  if (!configured) return null;
  const cwd = physical.replace(/\\/g, "/");
  let canonicalize = true, ceiling: string | null = null;
  for (const entry of configured.split(delimiter)) {
    if (!entry) { canonicalize = false; continue; }
    if (!isAbsolute(entry)) continue;
    let candidate = entry;
    if (canonicalize) {
      try { candidate = realpathSync.native(entry).replace(/\\/g, "/"); } catch { continue; }
    }
    // Git compares uncanonicalized entries literally, including separator/case spelling.
    if (candidate.endsWith("/")) candidate = candidate.slice(0, -1);
    if (!cwd.startsWith(`${candidate}/`) || cwd.length <= candidate.length + 1) continue;
    if (ceiling === null || candidate.length > ceiling.length) ceiling = candidate;
  }
  return ceiling;
}

/** Standard Git layouts have tiny authoritative pointer files. Never spawn Git
 * for ordinary/linked worktrees or damaged known layouts on the broker thread.
 */
function discoverProjectRoot(physical: string): ProjectDiscovery {
  const configuredCeilings = process.env.GIT_CEILING_DIRECTORIES;
  const ceiling = discoveryCeiling(physical, configuredCeilings);
  const markers: string[] = [JSON.stringify(["ceiling", configuredCeilings, ceiling])];
  const checkedDirectories = new Set<string>();
  const stamp = (path: string) => {
    const stat = lstatSync(path);
    markers.push(`${path}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}:${stat.size}`);
    if (stat.isSymbolicLink()) throw new Error("linked Git metadata");
    return stat;
  };
  const text = (path: string, maxBytes = 8192) => {
    const stat = stamp(path);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("unsupported Git metadata file");
    const value = readFileSync(path, "utf8"); markers.push(value); return value.trim();
  };
  const directory = (path: string) => {
    const result = realpathSync.native(path);
    for (let at = resolve(path);; at = dirname(at)) {
      if (checkedDirectories.has(at)) break;
      if (!stamp(at).isDirectory()) throw new Error("unsupported Git metadata directory");
      checkedDirectories.add(at);
      if (dirname(at) === at) break;
    }
    return result;
  };
  const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const repository = (common: string): "ordinary" | "bare" | "unusual" => {
    if (!/^(ref: refs\/[^\r\n]+|[0-9a-fA-F]{40,64})$/.test(text(join(common, "HEAD")))) throw new Error("invalid Git HEAD");
    directory(join(common, "objects")); directory(join(common, "refs"));
    const config = text(join(common, "config"), 64 * 1024);
    let core = false, bare: string | undefined, unusual = false;
    for (const line of config.split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)\]/.exec(line);
      if (section) { core = section[1]!.toLowerCase() === "core"; if (/^include(?:if)?(?:\s|$)/i.test(section[1]!)) unusual = true; continue; }
      if (!core) continue;
      const option = /^\s*([\w.-]+)\s*=\s*(.*?)\s*(?:[#;].*)?$/.exec(line);
      if (option?.[1]?.toLowerCase() === "bare") bare = option[2]?.toLowerCase();
      if (option?.[1]?.toLowerCase() === "worktree") unusual = true;
    }
    if (bare === "true") return "bare";
    return unusual || bare !== "false" ? "unusual" : "ordinary";
  };
  for (let root = physical;; root = dirname(root)) {
    if (root !== physical && root.replace(/\\/g, "/").replace(/\/$/, "") === ceiling)
      return { marker: markers.join("|"), root: physical };
    const pointer = join(root, ".git");
    let stat;
    try { stat = stamp(pointer); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { if (dirname(root) === root) return { marker: markers.join("|"), root: physical }; continue; }
      return { marker: markers.join("|"), root: null };
    }
    try {
      if (stat.isDirectory()) {
        const gitDir = directory(pointer), layout = repository(gitDir);
        return { marker: markers.join("|"), root: layout === "bare" ? physical : root, fallback: layout === "unusual" };
      }
      const match = /^gitdir:\s+([^\r\n]+)$/.exec(text(pointer));
      if (!match) throw new Error("invalid Git directory pointer");
      const gitDir = directory(resolve(root, match[1]!));
      if (!/^(ref: refs\/[^\r\n]+|[0-9a-fA-F]{40,64})$/.test(text(join(gitDir, "HEAD")))) throw new Error("invalid Git worktree HEAD");
      let commonPointer: string;
      try { commonPointer = text(join(gitDir, "commondir")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Separate Git directories/submodules retain the existing Git fallback.
        repository(gitDir);
        return { marker: markers.join("|"), root: null, fallback: true };
      }
      if (!commonPointer || /[\r\n]/.test(commonPointer)) throw new Error("invalid Git common directory pointer");
      const common = directory(resolve(gitDir, commonPointer)), layout = repository(common);
      if (layout !== "ordinary" || basename(common).toLowerCase() !== ".git") return { marker: markers.join("|"), root: null, fallback: true };
      const entry = relative(join(common, "worktrees"), gitDir);
      if (!entry || entry === ".." || entry.startsWith("..\\") || entry.startsWith("../") || /[\\/]/.test(entry)) throw new Error("Git worktree pointer is outside its common directory");
      const backPointer = text(join(gitDir, "gitdir"));
      if (!backPointer || /[\r\n]/.test(backPointer) || !samePath(realpathSync.native(resolve(gitDir, backPointer)), realpathSync.native(pointer))) throw new Error("Git worktree pointer does not identify this checkout");
      return { marker: markers.join("|"), root: dirname(common) };
    } catch { return { marker: markers.join("|"), root: null }; }
  }
}

/** Bound repeated legacy-record migration without retaining missing paths or stale Git roots forever. */
function resolveProjectRoot(physical: string, visibleRoot: (root: string) => string | null): string | null {
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

const conversationRoots = new Map<string, string>();
export function conversationProject(cwd: string): string {
  if (!cwd || isPluginCacheCwd(cwd)) return "";
  try { if (isPluginCacheCwd(realpathSync.native(cwd))) return ""; } catch {}
  const cacheKey = JSON.stringify([cwd, process.env.GIT_CEILING_DIRECTORIES]);
  const known = conversationRoots.get(cacheKey);
  if (known !== undefined) return known;
  const canonical = canonicalProjectRoot(cwd);
  const root = canonical ? projectKey(canonical) : existsSync(cwd) ? "" : projectKey(resolve(cwd));
  if (conversationRoots.size >= 256) conversationRoots.delete(conversationRoots.keys().next().value!);
  conversationRoots.set(cacheKey, root);
  return root;
}
