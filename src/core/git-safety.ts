import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_HOME, ENV } from "./constants.js";

/**
 * AB-422: the bridge runs git as the owner, outside any job sandbox, in repositories whose `.git/config`,
 * `.gitattributes` and hooks a delegated job can write (job worktrees, the job's cwd, the owner's project).
 * Git executes programs named in that configuration: `core.fsmonitor`, filter drivers, hooks, editors, signing
 * programs, diff drivers and transport commands. Every bridge git call goes through these helpers so none of
 * them runs:
 *
 * - always: `core.fsmonitor=false`, `core.untrackedCache=false`, `core.hooksPath=<empty bridge directory>`, both
 *   editors `true`, no signature display, and no automatic gc/maintenance (which would spawn more git);
 * - commands that can run filters (status, add, diff, commit, reset, checkout, worktree, stash, …): the effective
 *   configuration is read first with `git config -z --list --show-scope` (which executes nothing) and every filter
 *   driver defined in repository-local or worktree config (directly or through an include) is emptied with
 *   `-c filter.<name>.clean= …`; an empty command runs nothing;
 * - commands that create commits: signing is switched off when repository-local config names a signing program;
 * - diff-like commands get `--no-ext-diff --no-textconv`;
 * - network commands (fetch, ls-remote, pull, push) are refused when repository-local config names a transport,
 *   credential or proxy program; the callers treat that like an offline remote.
 *
 * Global and system configuration belong to the owner and are trusted: Git LFS and the owner's credential helper
 * keep working. `safe.directory` arguments from the caller are kept and applied to the configuration read too.
 * Command-line `-c` values win over every configuration file, and child git processes (submodules, upload-pack)
 * inherit them through GIT_CONFIG_PARAMETERS.
 */

/** Below the bridge home: an always-empty directory used as `core.hooksPath`. */
export const EMPTY_HOOKS_DIR_NAME = "git-hooks-empty";

export function emptyHooksDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = join(resolve(env[ENV.home]?.trim() || DEFAULT_HOME), EMPTY_HOOKS_DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Fail closed: a hook placed here would run on every bridge git call.
  if (readdirSync(dir).length) throw new Error(`refusing to run git: the bridge hooks directory ${dir} must be empty (AB-422)`);
  return dir;
}

/** Arguments every bridge git call starts with, after the caller's own `-c` options (so these win). */
export function gitSafetyArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    "core.fsmonitor=false",
    "core.untrackedCache=false",
    `core.hooksPath=${emptyHooksDir(env).replace(/\\/g, "/")}`,
    "core.editor=true",
    "sequence.editor=true",
    "log.showSignature=false",
    "gc.auto=0",
    "maintenance.auto=false",
  ].flatMap((value) => ["-c", value]);
}

/** Subcommands that can run clean/smudge/process filters on working-tree files. */
const FILTER_COMMANDS = new Set(["add", "am", "apply", "checkout", "checkout-index", "cherry-pick", "commit", "diff", "merge", "mv", "pull",
  "read-tree", "rebase", "reset", "restore", "revert", "rm", "stash", "status", "switch", "update-index", "worktree"]);
/** Subcommands that can create a signed commit or tag. */
const SIGNING_COMMANDS = new Set(["am", "cherry-pick", "commit", "merge", "pull", "rebase", "revert", "stash", "tag"]);
/** Subcommands that can show a patch and so run an external diff or textconv driver. */
const DIFF_COMMANDS = new Set(["diff", "log", "show"]);
/** Subcommands that contact a remote and may start a transport, credential or proxy program. */
const NETWORK_COMMANDS = new Set(["fetch", "ls-remote", "pull", "push"]);
/** Repository-local keys that name a program a transport may start. */
const NETWORK_KEYS = /^(core\.(sshcommand|gitproxy|askpass|alternaterefscommand)|credential\..*|remote\..+\.(uploadpack|receivepack|vcs)|url\..+\.(insteadof|pushinsteadof)|protocol\..*|ssh\.variant)$/;
/** Section and variable names are case-insensitive; the driver name (subsection) keeps its case. */
const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process)$/i;
const REPOSITORY_SCOPES = new Set(["local", "worktree"]);

/** `key` as git prints it (subsection case kept); `lower` for case-insensitive matching. */
export interface RepositoryConfigEntry { scope: string; origin: string; key: string; lower: string; value: string | null }

/** Parse `git config -z --list --show-origin --show-scope`: scope NUL origin NUL key [LF value] NUL. */
export function parseConfigList(raw: string): RepositoryConfigEntry[] {
  const parts = raw.split("\0");
  const out: RepositoryConfigEntry[] = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const [scope, origin, item] = [parts[i]!, parts[i + 1]!, parts[i + 2]!];
    const newline = item.indexOf("\n");
    const key = newline < 0 ? item : item.slice(0, newline);
    out.push({ scope, origin, key, lower: key.toLowerCase(), value: newline < 0 ? null : item.slice(newline + 1) });
  }
  return out;
}

/** Leading `-c name=value` pairs the caller passed (safe.directory, long paths); the rest starts at the subcommand. */
export function splitGitArgs(args: readonly string[]): { options: string[]; rest: string[] } {
  let i = 0;
  while (args[i] === "-c" && i + 1 < args.length) i += 2;
  return { options: args.slice(0, i), rest: args.slice(i) };
}

/** Submodule configs of this repository (`<common dir>/modules/**\/config`): their filters run in child status calls. */
function submoduleConfigFiles(commonDir: string): string[] {
  const out: string[] = [];
  const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      try { if (!statSync(path).isDirectory()) continue; } catch { continue; }
      // A submodule's git directory (names may contain slashes, so others are walked into); nested ones live in its modules/.
      if (isFile(join(path, "HEAD")) && isFile(join(path, "config"))) {
        out.push(join(path, "config"));
        walk(join(path, "modules"), depth + 1);
      } else walk(path, depth + 1);
    }
  };
  walk(join(commonDir, "modules"), 0);
  return out;
}

export type RunGit = (args: string[]) => Promise<string>;

/**
 * The extra `-c` options (and refusals) a subcommand needs in this repository. `run` executes a hardened,
 * read-only git command in the same directory with the caller's options.
 */
export async function repositoryGuards(sub: string, run: RunGit): Promise<string[]> {
  const filters = FILTER_COMMANDS.has(sub), signing = SIGNING_COMMANDS.has(sub), network = NETWORK_COMMANDS.has(sub);
  if (!filters && !signing && !network) return [];
  // Reading configuration executes nothing (no hooks, filters or fsmonitor), includes are expanded and shown.
  const entries = parseConfigList(await run(["config", "-z", "--list", "--show-origin", "--show-scope"]));
  const local = entries.filter((e) => REPOSITORY_SCOPES.has(e.scope));
  if (network) {
    const risky = [...new Set(local.filter((e) => NETWORK_KEYS.test(e.lower)).map((e) => e.key))];
    if (risky.length) throw new Error(`refused: repository-local git config sets ${risky.join(", ")}, which can start programs during network access (AB-422)`);
  }
  const out: string[] = [];
  if (filters) {
    const names = new Set(local.map((e) => FILTER_KEY.exec(e.key)?.[1]).filter((n): n is string => Boolean(n)));
    if (local.some((e) => e.lower.startsWith("submodule."))) {
      const common = await run(["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(() => "");
      for (const file of common ? submoduleConfigFiles(common.trim()) : []) {
        // Reading executes nothing; the submodule's own includes are expanded. Unreadable: refuse rather than guess.
        const raw = await run(["config", "-z", "--list", "--includes", "--show-origin", "--show-scope", "--file", file]).catch(() => null);
        if (raw === null) throw new Error(`refused: cannot read submodule git config ${file} (AB-422)`);
        for (const e of parseConfigList(raw)) { const n = FILTER_KEY.exec(e.key)?.[1]; if (n) names.add(n); }
      }
    }
    for (const name of names) {
      // `-c` splits at the first "=": a driver name containing one could not be overridden reliably.
      if (/[=\r\n]/.test(name)) throw new Error(`refused: repository-local git config defines a filter driver whose name cannot be neutralised: ${JSON.stringify(name)} (AB-422)`);
      out.push("-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`);
    }
  }
  if (signing && local.some((e) => e.lower.startsWith("gpg.") || e.lower === "user.signingkey")) out.push("-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false");
  return out;
}

/** `--no-ext-diff --no-textconv` right after a diff-like subcommand. */
export function diffSafety(rest: readonly string[]): string[] {
  const [sub, ...tail] = rest;
  if (!sub || !DIFF_COMMANDS.has(sub)) return [...rest];
  return [sub, ...["--no-ext-diff", "--no-textconv"].filter((flag) => !tail.includes(flag)), ...tail];
}
