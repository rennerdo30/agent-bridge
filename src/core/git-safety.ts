import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
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
 *   editors `true`, no signature display, no automatic gc/maintenance (which would spawn more git), and no
 *   recursion into submodules for checkout, fetch or push;
 * - commands that can run filters (status, add, diff, commit, reset, checkout, worktree add/remove/move, stash, …):
 *   the configuration is read first with `git config -z --list --show-scope` (which executes nothing) in every
 *   repository the command can reach: the repository itself, every populated gitlink in its index (submodules,
 *   embedded repositories without `.gitmodules`, `.git` files pointing anywhere), recursively, and for
 *   `worktree remove|move` the target worktree with its own `config.worktree` and gitlinks. Every filter driver
 *   defined there in repository-local or worktree config (directly or through an include) is emptied with
 *   `-c filter.<name>.clean= …`; an empty command runs nothing, and the `-c` values reach the child git processes
 *   (submodule status, the status inside `worktree remove`) through GIT_CONFIG_PARAMETERS. A repository that
 *   cannot be read is refused rather than guessed;
 * - Git LFS: a repository-local `filter.lfs` driver whose values are exactly what `git lfs install --local` writes
 *   (`git-lfs clean -- %f`, `git-lfs smudge [--skip] -- %f`, `git-lfs filter-process [--skip]`, required
 *   true/false: a bare `git-lfs` from PATH) is kept, like the owner's global one. git-lfs itself reads
 *   repository-local configuration, so while an LFS driver is active the call is refused when any reached
 *   repository's local or worktree config sets `lfs.extension.*` or `lfs.customtransfer.*` (programs) or
 *   `lfs.standalonetransferagent`; commands that write working-tree files (and so make git-lfs download: checkout,
 *   switch, restore, reset, stash, merge, pull, rebase, cherry-pick, revert, am, read-tree, checkout-index,
 *   worktree add) are also refused for a network key below (transport programs, credential helpers, proxies, TLS
 *   settings LFS transfers use). A refused status is "unknown" to its callers (cleanup keeps the worktree, change
 *   snapshots report unknown); a refused write (worktree add, WIP commit) fails. While LFS is active the guarded
 *   command also runs with GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=Never in its own environment, so an LFS
 *   endpoint taken from repository config (lfs.url, remote.<n>.lfsurl, a remote URL) cannot open a login prompt.
 *   `.lfsconfig` in the tree needs no guard: git-lfs (verified with 3.7.1) ignores its program, transfer-agent and
 *   ssh keys with a warning. Refusals are `GitSafetyRefusal` errors;
 * - includes: the configuration is read with `--includes`, so active includes are scanned. A plain or conditional
 *   include (`include.path`, `includeIf.<condition>.path`) in any reached repository's local or worktree config
 *   refuses every filter-capable command: a condition such as `onbranch:` or `gitdir:` can be inactive here and
 *   active in the checkout git really runs (the new worktree of `worktree add`), with drivers the guard never saw;
 * - lazy fetches: every command that is not meant to reach the network runs with GIT_NO_LAZY_FETCH=1 (process
 *   environment only) and `-c protocol.allow=never` plus `protocol.<ext|file|git|http|https|ssh>.allow=never`, so a
 *   promisor remote (`remote.<n>.promisor`, `extensions.partialClone`) cannot fetch a missing object through a
 *   planted transport behind a diff, show, status or checkout. With git before 2.44 (no GIT_NO_LAZY_FETCH; the
 *   version is read once per process) any promisor configuration refuses the command;
 * - commands that create commits: signing is switched off when repository-local config names a signing program;
 * - diff-like commands get `--no-ext-diff --no-textconv`;
 * - network commands (fetch, ls-remote, pull, push) are refused when repository-local config names a transport,
 *   credential or proxy program, a proxy, or any `http.*` setting other than pure transfer tuning (postBuffer,
 *   lowSpeedLimit, lowSpeedTime, maxRequests); the callers treat that like an offline remote.
 *
 * Global and system configuration belong to the owner and are trusted: Git LFS and the owner's credential helper
 * keep working. `safe.directory` arguments from the caller are kept and applied to the configuration reads too.
 * Command-line `-c` values win over every configuration file.
 *
 * Remaining window (time of check to time of use): the configuration is read right before the call it guards. A
 * process that can still write the repository's configuration between that read and the call (a job that is
 * still running in it) could add a driver in between. The bridge's guarded calls on a job's repository happen
 * after the job's process has ended (WIP commits, cleanup, change snapshots after the run) or before it starts
 * (worktree creation, the first snapshot); the exception is a working copy another job still runs in, which the
 * bridge cannot lock against.
 */

/**
 * A guard refused the command (or could not check it). Callers treat it as git's own refusal, never as a
 * permission or I/O failure, even when its text quotes git's stderr or a path.
 */
export class GitSafetyRefusal extends Error {
  override name = "GitSafetyRefusal";
}

/** Below the bridge home: an always-empty directory used as `core.hooksPath`. */
export const EMPTY_HOOKS_DIR_NAME = "git-hooks-empty";

export function emptyHooksDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = join(resolve(env[ENV.home]?.trim() || DEFAULT_HOME), EMPTY_HOOKS_DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Fail closed: a hook placed here would run on every bridge git call.
  if (readdirSync(dir).length) throw new GitSafetyRefusal(`refusing to run git: the bridge hooks directory ${dir} must be empty (AB-422)`);
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
    // Never check out, fetch or push inside submodules (their own configuration would apply there).
    "submodule.recurse=false",
    "fetch.recurseSubmodules=false",
    "push.recurseSubmodules=no",
    "diff.submodule=short",
    "status.submoduleSummary=false",
  ].flatMap((value) => ["-c", value]);
}

/** Subcommands that can run clean/smudge/process filters on working-tree files. */
const FILTER_COMMANDS = new Set(["add", "am", "apply", "checkout", "checkout-index", "cherry-pick", "commit", "diff", "merge", "mv", "pull",
  "read-tree", "rebase", "reset", "restore", "revert", "rm", "stash", "status", "switch", "update-index", "worktree"]);
/** `git worktree` subcommands that check out files or run a status in a worktree. */
const FILTER_WORKTREE_COMMANDS = new Set(["add", "remove", "move"]);
/** Subcommands that write working-tree files and so can make git-lfs download objects (and `worktree add`). */
const SMUDGE_COMMANDS = new Set(["am", "checkout", "checkout-index", "cherry-pick", "merge", "pull", "read-tree", "rebase", "reset", "restore",
  "revert", "stash", "switch"]);
/** Subcommands that can create a signed commit or tag. */
const SIGNING_COMMANDS = new Set(["am", "cherry-pick", "commit", "merge", "pull", "rebase", "revert", "stash", "tag"]);
/** Subcommands that can show a patch and so run an external diff or textconv driver. */
const DIFF_COMMANDS = new Set(["diff", "log", "show"]);
/** Subcommands that contact a remote and may start a transport, credential or proxy program. */
const NETWORK_COMMANDS = new Set(["fetch", "ls-remote", "pull", "push"]);
/** Repository-local keys that name a program a transport may start, or redirect or weaken its connection. */
const NETWORK_KEYS = /^(core\.(sshcommand|gitproxy|askpass|alternaterefscommand)|credential\..*|remote\..+\.(uploadpack|receivepack|vcs|proxy|proxyauthmethod)|url\..+\.(insteadof|pushinsteadof)|protocol\..*|ssh\.variant|http\..*)$/;
/** `http.*` keys that only tune transfers (no proxy, TLS, header, cookie or resolve setting). */
const HTTP_TUNING_KEYS = /^http\.(.+\.)?(postbuffer|lowspeedlimit|lowspeedtime|maxrequests)$/;
/** Repository-local git-lfs keys that start programs or select a transfer agent. */
const LFS_PROGRAM_KEYS = /^lfs\.(extension\..+|customtransfer\..+|standalonetransferagent)$/;
/** Section and variable names are case-insensitive; the driver name (subsection) keeps its case. */
const FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process|required)$/i;
const REPOSITORY_SCOPES = new Set(["local", "worktree"]);
/** What `git lfs install --local` writes (optionally with --skip-smudge): a bare `git-lfs` from PATH, no other arguments. */
const CANONICAL_LFS: Record<string, readonly string[]> = {
  clean: ["git-lfs clean -- %f"],
  smudge: ["git-lfs smudge -- %f", "git-lfs smudge --skip -- %f"],
  process: ["git-lfs filter-process", "git-lfs filter-process --skip"],
  required: ["true", "false"],
};
/** Nested repositories deeper than this are refused rather than scanned. */
const MAX_NESTING = 8;

const isNetworkKey = (lower: string) => NETWORK_KEYS.test(lower) && !HTTP_TUNING_KEYS.test(lower);
/** Plain and conditional includes: a conditional one can be inactive here and active in another checkout. */
const INCLUDE_KEY = /^(include|includeif\..+)\.path$/;
/** Configuration that makes git fetch missing objects from a promisor remote on an ordinary read. */
const PROMISOR_KEY = /^(remote\..+\.(promisor|partialclonefilter)|extensions\.partialclone)$/;

/**
 * For every command that is not meant to reach the network: no transport may start, whatever repository-local
 * `protocol.*` keys say (per-protocol keys beat `protocol.allow`, and `-c` beats local config). Together with
 * GIT_NO_LAZY_FETCH=1 this stops a promisor remote from fetching a missing object behind an ordinary read.
 */
export const NO_LAZY_FETCH_ARGS: readonly string[] = ["protocol.allow=never",
  ...["ext", "file", "git", "http", "https", "ssh"].map((name) => `protocol.${name}.allow=never`)].flatMap((value) => ["-c", value]);

/** Whether the installed git honours GIT_NO_LAZY_FETCH (git 2.44 and later); read once per process. */
let lazyFetchSwitch: boolean | undefined;
/** Forget the cached git version (tests). */
export function resetGitFeatureCache(): void { lazyFetchSwitch = undefined; }
function supportsNoLazyFetch(versionText: string): boolean | undefined {
  const match = /git version (\d+)\.(\d+)/.exec(versionText);
  if (!match) return undefined;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 2 || (major === 2 && minor >= 44);
}

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

/** One read-only git command the guards need: run in `dir` (absolute, via `-C`), or in the caller's directory. */
export interface GuardRead { args: string[]; dir: string | null }
/** Runs a hardened, read-only git command with the caller's `-c` options and returns its complete stdout. */
export type GuardRunner<T> = (args: string[], dir: string | null) => T;

interface ScannedRepository { label: string; entries: RepositoryConfigEntry[]; local: RepositoryConfigEntry[] }
type Plan<T> = Generator<GuardRead, T, string>;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];

function* readRepository(dir: string | null, label: string): Plan<ScannedRepository> {
  let raw: string;
  // Reading configuration executes nothing (no hooks, filters or fsmonitor); includes are expanded and shown.
  try { raw = yield { args: ["config", "-z", "--list", "--includes", "--show-origin", "--show-scope"], dir }; }
  catch (err) { throw new GitSafetyRefusal(`refused: cannot read the git config of ${label}: ${message(err)} (AB-422)`); }
  const entries = parseConfigList(raw);
  return { label, entries, local: entries.filter((e) => REPOSITORY_SCOPES.has(e.scope)) };
}

/**
 * Every populated gitlink (mode 160000) in the index of the repository at `dir`, recursively: git runs a status
 * with that repository's own configuration inside each one. Populated means `<path>/.git` exists (a directory
 * or a `.git` file pointing anywhere), the same test git uses before it recurses.
 */
function* nestedRepositories(dir: string | null, label: string, found: ScannedRepository[], seen: Set<string>, depth: number): Plan<void> {
  let raw: string;
  // Paths relative to the top of the work tree, which core.worktree can put anywhere (not below `dir`).
  try { raw = yield { args: ["ls-files", "--full-name", "-s", "-z", "--", ":/"], dir }; }
  catch (err) {
    // Only a repository without a work tree (bare, or a git directory) has no index to read.
    let inside = "";
    try { inside = (yield { args: ["rev-parse", "--is-inside-work-tree"], dir }).trim(); } catch { /* refused below */ }
    if (inside === "false") return;
    throw new GitSafetyRefusal(`refused: cannot list the gitlinks of ${label}: ${message(err)} (AB-422)`);
  }
  // "<mode> <object> <stage>\t<path>"
  const gitlinks = raw.split("\0").filter((record) => record.startsWith("160000 ") && record.includes("\t"));
  if (!gitlinks.length) return;
  let top = "";
  try { top = (yield { args: ["rev-parse", "--show-toplevel"], dir }).trim(); } catch { /* refused below */ }
  if (!top) throw new GitSafetyRefusal(`refused: cannot find the work tree of ${label} to check its gitlinks (AB-422)`);
  for (const record of gitlinks) {
    const path = resolve(top, record.slice(record.indexOf("\t") + 1));
    try { lstatSync(join(path, ".git")); } catch { continue; }
    let key: string;
    try { key = realpathSync.native(path); } catch { key = path; }
    if (process.platform === "win32") key = key.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (depth >= MAX_NESTING) throw new GitSafetyRefusal(`refused: repositories nested deeper than ${MAX_NESTING} levels at ${path} (AB-422)`);
    found.push(yield* readRepository(path, `the nested repository ${path}`));
    yield* nestedRepositories(path, `the nested repository ${path}`, found, seen, depth + 1);
  }
}

/** Whether git would start a `filter.lfs` program here: its last clean, smudge or process value is not empty. */
function lfsActive(repo: ScannedRepository): boolean {
  const last = new Map<string, string>();
  for (const e of repo.entries) {
    const match = FILTER_KEY.exec(e.key);
    if (match?.[1] === "lfs" && match[2]!.toLowerCase() !== "required") last.set(match[2]!.toLowerCase(), e.value ?? "");
  }
  return [...last.values()].some((value) => value.trim() !== "");
}

/** Extra `-c` arguments for the guarded command, and process-local environment for it (never persisted). */
export interface GitGuards { args: string[]; env: Record<string, string> }

function* guardPlan(rest: readonly string[], cwd: string): Plan<GitGuards> {
  const sub = rest[0] ?? "";
  const filters = FILTER_COMMANDS.has(sub) && (sub !== "worktree" || FILTER_WORKTREE_COMMANDS.has(rest[1] ?? ""));
  const signing = SIGNING_COMMANDS.has(sub), network = NETWORK_COMMANDS.has(sub);
  // Every command not meant to reach the network gets no transport and no lazy fetch (promisor remotes).
  const out: string[] = network ? [] : [...NO_LAZY_FETCH_ARGS];
  const env: Record<string, string> = network ? {} : { GIT_NO_LAZY_FETCH: "1" };
  let lazySwitch = network ? true : lazyFetchSwitch;
  if (lazySwitch === undefined) {
    let version = "";
    try { version = yield { args: ["--version"], dir: null }; } catch { /* unknown: treated as too old */ }
    lazySwitch = supportsNoLazyFetch(version);
    if (lazySwitch !== undefined) lazyFetchSwitch = lazySwitch;
  }
  // Without GIT_NO_LAZY_FETCH support (git before 2.44) a promisor repository is refused for every command.
  if (!filters && !signing && !network && lazySwitch) return { args: out, env };
  const main = yield* readRepository(null, "the repository");
  if (!lazySwitch) {
    const promisor = [...new Set(main.entries.filter((e) => PROMISOR_KEY.test(e.lower)).map((e) => e.key))];
    if (promisor.length) throw new GitSafetyRefusal(`refused: git config sets ${promisor.join(", ")} (lazy fetches from a promisor remote) and the installed git cannot switch lazy fetching off (GIT_NO_LAZY_FETCH needs git 2.44 or later) (AB-422)`);
  }
  if (network) {
    const risky = [...new Set(main.local.filter((e) => isNetworkKey(e.lower)).map((e) => e.key))];
    if (risky.length) throw new GitSafetyRefusal(`refused: repository-local git config sets ${risky.join(", ")}, which can start programs or redirect the connection during network access (AB-422)`);
  }
  let lfs = false;
  if (filters) {
    const repos = [main];
    const seen = new Set<string>();
    // A status or diff told to ignore submodules never enters them.
    const ignoresSubmodules = (sub === "status" || sub === "diff") && rest.some((a) => a === "--ignore-submodules" || a === "--ignore-submodules=all");
    if (!ignoresSubmodules) yield* nestedRepositories(null, `the repository at ${cwd}`, repos, seen, 0);
    if (sub === "worktree" && (rest[1] === "remove" || rest[1] === "move")) {
      // Git runs a status inside the target worktree, with that worktree's own config.worktree and gitlinks.
      const target = rest.slice(2).find((a) => !a.startsWith("-"));
      if (target) {
        const path = resolve(cwd, target);
        let exists = true;
        try { lstatSync(path); } catch { exists = false; }
        if (exists) {
          repos.push(yield* readRepository(path, `the worktree ${path}`));
          yield* nestedRepositories(path, `the worktree ${path}`, repos, seen, 0);
        }
      }
    }
    // An include, above all a conditional one (onbranch:, gitdir:), can be inactive in this checkout and active in
    // the context git really runs in (the new worktree's checkout, a target worktree): its drivers were never seen.
    const includes = [...new Set(repos.flatMap((r) => r.local).filter((e) => INCLUDE_KEY.test(e.lower)).map((e) => e.key))];
    if (includes.length) throw new GitSafetyRefusal(`refused: repository-local git config has ${includes.join(", ")}; included configuration can define filter drivers the bridge cannot check for every checkout, so filter-capable commands are refused (AB-422)`);
    const names = new Set<string>();
    let canonicalLfs = true;
    for (const repo of repos) for (const e of repo.local) {
      const match = FILTER_KEY.exec(e.key);
      if (!match) continue;
      const name = match[1]!, variable = match[2]!.toLowerCase();
      if (name === "lfs" && !CANONICAL_LFS[variable]!.includes(e.value ?? "")) canonicalLfs = false;
      if (variable !== "required") names.add(name);
    }
    // The standard local Git LFS driver stays; any other value of it is treated like every other local driver.
    if (canonicalLfs) names.delete("lfs");
    if (!names.has("lfs") && repos.some(lfsActive)) {
      lfs = true;
      // Programs (extensions, transfer agents) can run on every clean; transport, credential and proxy settings
      // matter only when git-lfs downloads, which happens only when a command writes working-tree files.
      const smudges = SMUDGE_COMMANDS.has(sub) || (sub === "worktree" && rest[1] === "add");
      const risky = [...new Set(repos.flatMap((r) => r.local).filter((e) => LFS_PROGRAM_KEYS.test(e.lower) || (smudges && isNetworkKey(e.lower))).map((e) => e.key))];
      if (risky.length) throw new GitSafetyRefusal(`refused: Git LFS is active and repository-local git config sets ${risky.join(", ")}, which git-lfs reads and which can start programs or redirect its transfers (AB-422)`);
    }
    for (const name of names) {
      // `-c` splits at the first "=": a driver name containing one could not be overridden reliably.
      if (/[=\r\n]/.test(name)) throw new GitSafetyRefusal(`refused: repository-local git config defines a filter driver whose name cannot be neutralised: ${JSON.stringify(name)} (AB-422)`);
      out.push("-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`);
    }
  }
  if (signing && main.local.some((e) => e.lower.startsWith("gpg.") || e.lower === "user.signingkey")) out.push("-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false");
  // An LFS endpoint from repository config (lfs.url, remote.<n>.lfsurl, a remote URL) may point anywhere: git-lfs
  // and the credential manager must never open a login prompt or dialog for it.
  if (lfs) Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" });
  return { args: out, env };
}

/**
 * The extra `-c` options (and refusals) the command `rest` (subcommand first) needs when run in `cwd`. `run`
 * executes a hardened, read-only git command with the caller's options, in `dir` or in `cwd`.
 */
export async function repositoryGuards(rest: readonly string[], cwd: string, run: GuardRunner<Promise<string>>): Promise<GitGuards> {
  const plan = guardPlan(rest, resolve(cwd));
  let step = plan.next();
  while (!step.done) {
    let output: string;
    try { output = await run(step.value.args, step.value.dir); }
    catch (err) { step = plan.throw(err); continue; }
    step = plan.next(output);
  }
  return step.value;
}

/** The same guards for synchronous callers (the marketplace clone update). */
export function repositoryGuardsSync(rest: readonly string[], cwd: string, run: GuardRunner<string>): GitGuards {
  const plan = guardPlan(rest, resolve(cwd));
  let step = plan.next();
  while (!step.done) {
    let output: string;
    try { output = run(step.value.args, step.value.dir); }
    catch (err) { step = plan.throw(err); continue; }
    step = plan.next(output);
  }
  return step.value;
}

/** `--no-ext-diff --no-textconv` right after a diff-like subcommand. */
export function diffSafety(rest: readonly string[]): string[] {
  const [sub, ...tail] = rest;
  if (!sub || !DIFF_COMMANDS.has(sub)) return [...rest];
  return [sub, ...["--no-ext-diff", "--no-textconv"].filter((flag) => !tail.includes(flag)), ...tail];
}
