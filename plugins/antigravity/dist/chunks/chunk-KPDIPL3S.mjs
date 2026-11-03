import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  DEFAULT_HOME,
  ENV
} from "./chunk-3MVB7JRO.mjs";

// src/core/session-visibility.ts
import { posix } from "node:path";
function isPluginCacheCwd(cwd) {
  const path = posix.normalize(cwd.replace(/\\/g, "/")).toLowerCase().replace(/\/+$/, "");
  return /(?:^|\/)\.(?:codex|claude)\/plugins\/cache(?:\/|$)/.test(path) || /(?:^|\/)(?:\.config\/opencode|\.opencode|opencode)\/plugins?(?:\/|$)/.test(path) || /(?:^|\/)(?:\.gemini\/(?:config|antigravity-cli)|\.agents)\/plugins(?:\/|$)/.test(path);
}
function isInternalBridgeProcess(env = process.env) {
  return env[ENV.internal] === "1";
}

// src/core/git-safety.ts
import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
var GitSafetyRefusal = class extends Error {
  name = "GitSafetyRefusal";
};
var EMPTY_HOOKS_DIR_NAME = "git-hooks-empty";
function emptyHooksDir(env = process.env) {
  const dir = join(resolve(env[ENV.home]?.trim() || DEFAULT_HOME), EMPTY_HOOKS_DIR_NAME);
  mkdirSync(dir, { recursive: true, mode: 448 });
  if (readdirSync(dir).length) throw new GitSafetyRefusal(`refusing to run git: the bridge hooks directory ${dir} must be empty (AB-422)`);
  return dir;
}
function gitSafetyArgs(env = process.env) {
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
    "status.submoduleSummary=false"
  ].flatMap((value) => ["-c", value]);
}
var FILTER_COMMANDS = /* @__PURE__ */ new Set([
  "add",
  "am",
  "apply",
  "checkout",
  "checkout-index",
  "cherry-pick",
  "commit",
  "diff",
  "merge",
  "mv",
  "pull",
  "read-tree",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "status",
  "switch",
  "update-index",
  "worktree"
]);
var FILTER_WORKTREE_COMMANDS = /* @__PURE__ */ new Set(["add", "remove", "move"]);
var SMUDGE_COMMANDS = /* @__PURE__ */ new Set([
  "am",
  "checkout",
  "checkout-index",
  "cherry-pick",
  "merge",
  "pull",
  "read-tree",
  "rebase",
  "reset",
  "restore",
  "revert",
  "stash",
  "switch"
]);
var SIGNING_COMMANDS = /* @__PURE__ */ new Set(["am", "cherry-pick", "commit", "merge", "pull", "rebase", "revert", "stash", "tag"]);
var DIFF_COMMANDS = /* @__PURE__ */ new Set(["diff", "log", "show"]);
var NETWORK_COMMANDS = /* @__PURE__ */ new Set(["fetch", "ls-remote", "pull", "push"]);
var NETWORK_KEYS = /^(core\.(sshcommand|gitproxy|askpass|alternaterefscommand)|credential\..*|remote\..+\.(uploadpack|receivepack|vcs|proxy|proxyauthmethod)|url\..+\.(insteadof|pushinsteadof)|protocol\..*|ssh\.variant|http\..*)$/;
var HTTP_TUNING_KEYS = /^http\.(.+\.)?(postbuffer|lowspeedlimit|lowspeedtime|maxrequests)$/;
var LFS_PROGRAM_KEYS = /^lfs\.(extension\..+|customtransfer\..+|standalonetransferagent)$/;
var FILTER_KEY = /^filter\.(.+)\.(clean|smudge|process|required)$/i;
var REPOSITORY_SCOPES = /* @__PURE__ */ new Set(["local", "worktree"]);
var CANONICAL_LFS = {
  clean: ["git-lfs clean -- %f"],
  smudge: ["git-lfs smudge -- %f", "git-lfs smudge --skip -- %f"],
  process: ["git-lfs filter-process", "git-lfs filter-process --skip"],
  required: ["true", "false"]
};
var MAX_NESTING = 8;
var isNetworkKey = (lower) => NETWORK_KEYS.test(lower) && !HTTP_TUNING_KEYS.test(lower);
var INCLUDE_KEY = /^(include|includeif\..+)\.path$/;
var PROMISOR_KEY = /^(remote\..+\.(promisor|partialclonefilter)|extensions\.partialclone)$/;
var NO_LAZY_FETCH_ARGS = [
  "protocol.allow=never",
  ...["ext", "file", "git", "http", "https", "ssh"].map((name) => `protocol.${name}.allow=never`)
].flatMap((value) => ["-c", value]);
var lazyFetchSwitch;
function supportsNoLazyFetch(versionText) {
  const match = /^git version (\d+)\.(\d+)\.(\d+)(?:[.+-][\w.+-]+| \([^\r\n()]+\))?\s*$/.exec(versionText.trim());
  if (!match) return void 0;
  if (/[.+-]rc\d/i.test(versionText)) return false;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const floors = { 39: 4, 40: 2, 41: 1, 42: 2, 43: 4, 44: 1, 45: 1 };
  return major === 2 && (minor >= 46 || floors[minor] !== void 0 && patch >= floors[minor]);
}
function parseConfigList(raw) {
  const parts = raw.split("\0");
  const out = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const [scope, origin, item] = [parts[i], parts[i + 1], parts[i + 2]];
    const newline = item.indexOf("\n");
    const key = newline < 0 ? item : item.slice(0, newline);
    out.push({ scope, origin, key, lower: key.toLowerCase(), value: newline < 0 ? null : item.slice(newline + 1) });
  }
  return out;
}
function splitGitArgs(args) {
  let i = 0;
  while (args[i] === "-c" && i + 1 < args.length) i += 2;
  return { options: args.slice(0, i), rest: args.slice(i) };
}
var GuardReadFailure = class extends GitSafetyRefusal {
  constructor(operation, kind, code) {
    super(`git ${operation} guard read failed (${kind}${code === void 0 ? "" : ` ${code}`})`);
    this.operation = operation;
    this.kind = kind;
    this.code = code;
  }
  operation;
  kind;
  code;
};
function gitGuardReadFailure(args, error) {
  if (error instanceof GuardReadFailure) return error;
  const info = error !== null && typeof error === "object" ? error : {};
  const operation = ["--version", "config", "ls-files", "rev-parse", "worktree"].includes(args[0] ?? "") ? args[0] : "metadata";
  if (info.killed === true || info.code === "ETIMEDOUT") return new GuardReadFailure(operation, "timeout", void 0);
  if (info.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return new GuardReadFailure(operation, "output limit", void 0);
  if (typeof info.code === "number" && Number.isSafeInteger(info.code)) return new GuardReadFailure(operation, "exit status", info.code);
  if (typeof info.status === "number" && Number.isSafeInteger(info.status)) return new GuardReadFailure(operation, "exit status", info.status);
  const system = ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR", "ENAMETOOLONG", "EMFILE", "ENFILE"];
  return new GuardReadFailure(operation, "system error", typeof info.code === "string" && system.includes(info.code) ? info.code : void 0);
}
function* readRepository(dir, label, check) {
  let raw;
  try {
    raw = yield { args: ["config", "-z", "--list", "--includes", "--show-origin", "--show-scope"], dir };
  } catch (err) {
    throw new GitSafetyRefusal(`refused: cannot read the git config of ${label}: ${gitGuardReadFailure(["config"], err).message} (AB-422)`);
  }
  const entries = parseConfigList(raw);
  const repo = { label, entries, local: entries.filter((e) => REPOSITORY_SCOPES.has(e.scope)) };
  check(repo);
  return repo;
}
function* nestedRepositories(dir, label, found, seen, depth, check) {
  let raw;
  try {
    raw = yield { args: ["ls-files", "--full-name", "-s", "-z", "--", ":/"], dir };
  } catch (err) {
    let inside = "";
    try {
      inside = (yield { args: ["rev-parse", "--is-inside-work-tree"], dir }).trim();
    } catch {
    }
    if (inside === "false") return;
    throw new GitSafetyRefusal(`refused: cannot list the gitlinks of ${label}: ${gitGuardReadFailure(["ls-files"], err).message} (AB-422)`);
  }
  const gitlinks = raw.split("\0").filter((record) => record.startsWith("160000 ") && record.includes("	"));
  if (!gitlinks.length) return;
  let top = "";
  try {
    top = (yield { args: ["rev-parse", "--show-toplevel"], dir }).trim();
  } catch (err) {
    throw new GitSafetyRefusal(`refused: cannot find the work tree of ${label}: ${gitGuardReadFailure(["rev-parse"], err).message} (AB-422)`);
  }
  if (!top) throw new GitSafetyRefusal(`refused: cannot find the work tree of ${label} to check its gitlinks (AB-422)`);
  for (const record of gitlinks) {
    const path = resolve(top, record.slice(record.indexOf("	") + 1));
    try {
      lstatSync(join(path, ".git"));
    } catch {
      continue;
    }
    let key;
    try {
      key = realpathSync.native(path);
    } catch {
      key = path;
    }
    if (process.platform === "win32") key = key.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (depth >= MAX_NESTING) throw new GitSafetyRefusal(`refused: repositories nested deeper than ${MAX_NESTING} levels at ${path} (AB-422)`);
    found.push(yield* readRepository(path, `the nested repository ${path}`, check));
    yield* nestedRepositories(path, `the nested repository ${path}`, found, seen, depth + 1, check);
  }
}
function* targetWorktree(cwd, target) {
  const raw = yield { args: ["worktree", "list", "--porcelain", "-z"], dir: null };
  const paths = raw.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9));
  if (!paths.length || paths.some((path) => !isAbsolute(path))) throw new GitSafetyRefusal("refused: cannot resolve a registered target worktree (AB-422)");
  const ignoreCase = (yield { args: ["config", "--type=bool", "--default=false", "--get", "core.ignoreCase"], dir: null }).trim();
  if (ignoreCase !== "true" && ignoreCase !== "false") throw new GitSafetyRefusal("refused: cannot prove target worktree path comparison settings (AB-422)");
  const fold = (path) => ignoreCase === "true" ? path.replace(/[A-Z]/g, (c) => c.toLowerCase()) : path;
  const suffixes = target ? paths.filter((path) => {
    const start = path.length - target.length;
    return (start === 0 || start > 0 && (path[start - 1] === "/" || process.platform === "win32" && path[start - 1] === "\\")) && fold(path.slice(start)) === fold(target);
  }) : [];
  let selected = suffixes.length === 1 ? suffixes[0] : void 0;
  if (!selected) {
    let canonical;
    try {
      canonical = realpathSync.native(isAbsolute(target) ? target : `${cwd}/${target}`);
    } catch {
      throw new GitSafetyRefusal("refused: target worktree is ambiguous or not registered (AB-422)");
    }
    const matches = paths.filter((path) => {
      try {
        return fold(realpathSync.native(path)) === fold(canonical);
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) throw new GitSafetyRefusal("refused: target worktree is ambiguous or not registered (AB-422)");
    selected = matches[0];
  }
  try {
    lstatSync(join(selected, ".git"));
  } catch {
    throw new GitSafetyRefusal("refused: cannot read the registered target worktree (AB-422)");
  }
  return selected;
}
function lfsActive(repo) {
  const last = /* @__PURE__ */ new Map();
  for (const e of repo.entries) {
    const match = FILTER_KEY.exec(e.key);
    if (match?.[1] === "lfs" && match[2].toLowerCase() !== "required") last.set(match[2].toLowerCase(), e.value ?? "");
  }
  return [...last.values()].some((value) => value.trim() !== "");
}
function* guardPlan(rest, cwd) {
  const sub = rest[0] ?? "";
  const filters = FILTER_COMMANDS.has(sub) && (sub !== "worktree" || FILTER_WORKTREE_COMMANDS.has(rest[1] ?? ""));
  const signing = SIGNING_COMMANDS.has(sub), network = NETWORK_COMMANDS.has(sub);
  const out = network ? [] : [...NO_LAZY_FETCH_ARGS];
  const env = network ? {} : { GIT_NO_LAZY_FETCH: "1" };
  let lazySwitch = network ? true : lazyFetchSwitch;
  if (lazySwitch === void 0) {
    let version = "";
    try {
      version = yield { args: ["--version"], dir: null };
    } catch {
    }
    lazySwitch = supportsNoLazyFetch(version);
    if (lazySwitch !== void 0) lazyFetchSwitch = lazySwitch;
  }
  const protocols = /* @__PURE__ */ new Set(["ext", "file", "git", "http", "https", "ssh"]);
  const check = (repo) => {
    if (!lazySwitch && repo.entries.some((e) => PROMISOR_KEY.test(e.lower))) {
      throw new GitSafetyRefusal(`refused: ${repo.label} has promisor configuration (lazy fetches) and the installed git lacks verified GIT_NO_LAZY_FETCH enforcement (AB-422)`);
    }
    if (network) {
      const risky = [...new Set(repo.local.filter((e) => isNetworkKey(e.lower)).map((e) => e.key))];
      if (risky.length) throw new GitSafetyRefusal(`refused: repository-local git config in ${repo.label} sets ${risky.join(", ")}, which can start programs or redirect the connection during network access (AB-422)`);
    } else for (const entry of repo.entries) {
      const name = /^protocol\.(.+)\.allow$/i.exec(entry.key)?.[1];
      if (!name || protocols.has(name)) continue;
      if (/[=\r\n\0]/.test(name)) throw new GitSafetyRefusal("refused: a protocol permission cannot be safely overridden (AB-422)");
      protocols.add(name);
      out.push("-c", `protocol.${name}.allow=never`);
    }
  };
  const main = yield* readRepository(null, "the repository", check);
  const repos = [main];
  const recurses = rest.some((a) => /^--(?:recurse-submodules|submodule)(?:=|$)/.test(a)) || sub === "submodule";
  if (filters || network || !lazySwitch || recurses) {
    const seen = /* @__PURE__ */ new Set();
    yield* nestedRepositories(null, `the repository at ${cwd}`, repos, seen, 0, check);
    if (sub === "worktree" && (rest[1] === "remove" || rest[1] === "move")) {
      const target = rest.slice(2).find((a) => !a.startsWith("-"));
      if (!target) throw new GitSafetyRefusal("refused: cannot resolve a registered target worktree (AB-422)");
      const path = yield* targetWorktree(cwd, target);
      repos.push(yield* readRepository(path, `the worktree ${path}`, check));
      yield* nestedRepositories(path, `the worktree ${path}`, repos, seen, 0, check);
    }
  }
  let lfs = false;
  if (filters) {
    const includes = [...new Set(repos.flatMap((r) => r.local).filter((e) => INCLUDE_KEY.test(e.lower)).map((e) => e.key))];
    if (includes.length) throw new GitSafetyRefusal(`refused: repository-local git config has ${includes.join(", ")}; included configuration can define filter drivers the bridge cannot check for every checkout, so filter-capable commands are refused (AB-422)`);
    const names = /* @__PURE__ */ new Set();
    let canonicalLfs = true;
    for (const repo of repos) for (const e of repo.local) {
      const match = FILTER_KEY.exec(e.key);
      if (!match) continue;
      const name = match[1], variable = match[2].toLowerCase();
      if (name === "lfs" && !CANONICAL_LFS[variable].includes(e.value ?? "")) canonicalLfs = false;
      if (variable !== "required") names.add(name);
    }
    if (canonicalLfs) names.delete("lfs");
    if (!names.has("lfs") && repos.some(lfsActive)) {
      lfs = true;
      const smudges = SMUDGE_COMMANDS.has(sub) || sub === "worktree" && rest[1] === "add";
      const risky = [...new Set(repos.flatMap((r) => r.local).filter((e) => LFS_PROGRAM_KEYS.test(e.lower) || smudges && isNetworkKey(e.lower)).map((e) => e.key))];
      if (risky.length) throw new GitSafetyRefusal(`refused: Git LFS is active and repository-local git config sets ${risky.join(", ")}, which git-lfs reads and which can start programs or redirect its transfers (AB-422)`);
    }
    for (const name of names) {
      if (/[=\r\n]/.test(name)) throw new GitSafetyRefusal(`refused: repository-local git config defines a filter driver whose name cannot be neutralised: ${JSON.stringify(name)} (AB-422)`);
      out.push("-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`);
    }
  }
  if (signing && main.local.some((e) => e.lower.startsWith("gpg.") || e.lower === "user.signingkey")) out.push("-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false");
  if (lfs) Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" });
  return { args: out, env };
}
async function repositoryGuards(rest, cwd, run) {
  const plan = guardPlan(rest, resolve(cwd));
  let step = plan.next();
  while (!step.done) {
    let output;
    try {
      output = await run(step.value.args, step.value.dir);
    } catch (err) {
      step = plan.throw(gitGuardReadFailure(step.value.args, err));
      continue;
    }
    step = plan.next(output);
  }
  return step.value;
}
function repositoryGuardsSync(rest, cwd, run) {
  const plan = guardPlan(rest, resolve(cwd));
  let step = plan.next();
  while (!step.done) {
    let output;
    try {
      output = run(step.value.args, step.value.dir);
    } catch (err) {
      step = plan.throw(gitGuardReadFailure(step.value.args, err));
      continue;
    }
    step = plan.next(output);
  }
  return step.value;
}
function diffSafety(rest) {
  const [sub, ...tail] = rest;
  if (!sub || !DIFF_COMMANDS.has(sub)) return [...rest];
  return [sub, ...["--no-ext-diff", "--no-textconv"].filter((flag) => !tail.includes(flag)), ...tail];
}

// src/core/project-identity.ts
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync as lstatSync2, readFileSync, realpathSync as realpathSync2, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute as isAbsolute2, join as join2, relative, resolve as resolve2 } from "node:path";
var identity = (s) => s.isDirectory() ? `${s.dev}:${s.ino}:${s.mode}` : `${s.dev}:${s.ino}:${s.mode}:${s.birthtimeMs}:${s.mtimeMs}:${s.size}`;
var failure = (error) => `!${error.code ?? "error"}`;
function probe(path) {
  try {
    return identity(lstatSync2(path));
  } catch (error) {
    return failure(error);
  }
}
var projectRoots = /* @__PURE__ */ new Map();
var PROJECT_ROOT_CACHE_MS = 3e4;
var PROJECT_ROOT_MEMO_MS = 3e5;
var PROJECT_ROOT_MEMO_MAX = 512;
function physicalPath(path, real = realpathSync2.native) {
  try {
    return real(path);
  } catch (error) {
    const rest = [];
    for (let dir = path; ; ) {
      const parent = dirname(dir);
      if (parent === dir) throw error;
      rest.unshift(basename(dir));
      dir = parent;
      try {
        return join2(real(dir), ...rest);
      } catch {
      }
    }
  }
}
function canonicalProjectRoot(cwd, options = {}) {
  if (isPluginCacheCwd(cwd)) return null;
  const visibleRoot = (root) => isPluginCacheCwd(root) ? null : root;
  try {
    const physical = realpathSync2.native(cwd);
    if (isPluginCacheCwd(physical)) return null;
    const stat = statSync(physical);
    if (!stat.isDirectory()) return null;
    const key = JSON.stringify([physical, process.env.GIT_CEILING_DIRECTORIES ?? null, options.discoveryOnly === true]), dir = `${stat.dev}:${stat.ino}`;
    const cached = projectRoots.get(key), now = Date.now();
    if (cached && cached.expiresAt > now && cached.dir === dir && cached.probes.every(([path, identity2]) => probe(path) === identity2)) {
      projectRoots.delete(key);
      projectRoots.set(key, cached);
      return cached.root;
    }
    const discovery = discoverProjectRoot(physical);
    const root = discovery.fallback ? options.discoveryOnly ? null : resolveProjectRoot(physical, visibleRoot) : discovery.root === null ? null : visibleRoot(discovery.root);
    projectRoots.delete(key);
    if (projectRoots.size >= PROJECT_ROOT_MEMO_MAX) projectRoots.delete(projectRoots.keys().next().value);
    projectRoots.set(key, { dir, root, probes: discovery.probes, expiresAt: now + (discovery.fallback ? PROJECT_ROOT_CACHE_MS : PROJECT_ROOT_MEMO_MS) });
    return root;
  } catch {
    return null;
  }
}
function discoveryCeiling(physical, configured, seen = () => {
}) {
  if (!configured) return null;
  const cwd = physical.replace(/\\/g, "/");
  let canonicalize = true, ceiling = null;
  for (const entry of configured.split(delimiter)) {
    if (!entry) {
      canonicalize = false;
      continue;
    }
    if (!isAbsolute2(entry)) continue;
    let candidate = entry;
    seen(entry);
    if (canonicalize) {
      try {
        candidate = realpathSync2.native(entry).replace(/\\/g, "/");
      } catch {
        continue;
      }
    }
    if (candidate.endsWith("/")) candidate = candidate.slice(0, -1);
    if (!cwd.startsWith(`${candidate}/`) || cwd.length <= candidate.length + 1) continue;
    if (ceiling === null || candidate.length > ceiling.length) ceiling = candidate;
  }
  return ceiling;
}
function discoverProjectRoot(physical) {
  const probes = /* @__PURE__ */ new Map();
  const found = walkProjectRoot(physical, probes);
  return { ...found, probes: [...probes] };
}
function walkProjectRoot(physical, probes) {
  const configuredCeilings = process.env.GIT_CEILING_DIRECTORIES;
  const seen = (path) => {
    if (!probes.has(path)) probes.set(path, probe(path));
  };
  const ceiling = discoveryCeiling(physical, configuredCeilings, seen);
  const checkedDirectories = /* @__PURE__ */ new Set();
  const stamp = (path) => {
    let stat;
    try {
      stat = lstatSync2(path);
    } catch (error) {
      if (!probes.has(path)) probes.set(path, failure(error));
      throw error;
    }
    if (!probes.has(path)) probes.set(path, identity(stat));
    if (stat.isSymbolicLink()) throw new Error("linked Git metadata");
    return stat;
  };
  const text = (path, maxBytes = 8192) => {
    const stat = stamp(path);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("unsupported Git metadata file");
    return readFileSync(path, "utf8").trim();
  };
  const directory = (path) => {
    seen(path);
    const result = realpathSync2.native(path);
    for (let at = resolve2(path); ; at = dirname(at)) {
      if (checkedDirectories.has(at)) break;
      if (!stamp(at).isDirectory()) throw new Error("unsupported Git metadata directory");
      checkedDirectories.add(at);
      if (dirname(at) === at) break;
    }
    return result;
  };
  const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  const repository = (common) => {
    if (!/^(ref: refs\/[^\r\n]+|[0-9a-fA-F]{40,64})$/.test(text(join2(common, "HEAD")))) throw new Error("invalid Git HEAD");
    directory(join2(common, "objects"));
    directory(join2(common, "refs"));
    const config = text(join2(common, "config"), 64 * 1024);
    let core = false, bare, unusual = false;
    for (const line of config.split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)\]/.exec(line);
      if (section) {
        core = section[1].toLowerCase() === "core";
        if (/^include(?:if)?(?:\s|$)/i.test(section[1])) unusual = true;
        continue;
      }
      if (!core) continue;
      const option = /^\s*([\w.-]+)\s*=\s*(.*?)\s*(?:[#;].*)?$/.exec(line);
      if (option?.[1]?.toLowerCase() === "bare") bare = option[2]?.toLowerCase();
      if (option?.[1]?.toLowerCase() === "worktree") unusual = true;
    }
    if (bare === "true") return "bare";
    return unusual || bare !== "false" ? "unusual" : "ordinary";
  };
  for (let root = physical; ; root = dirname(root)) {
    if (root !== physical && root.replace(/\\/g, "/").replace(/\/$/, "") === ceiling)
      return { root: physical };
    const pointer = join2(root, ".git");
    let stat;
    try {
      stat = stamp(pointer);
    } catch (error) {
      if (error.code === "ENOENT") {
        if (dirname(root) === root) return { root: physical };
        continue;
      }
      return { root: null };
    }
    try {
      if (stat.isDirectory()) {
        const gitDir2 = directory(pointer), layout2 = repository(gitDir2);
        return { root: layout2 === "bare" ? physical : root, fallback: layout2 === "unusual" };
      }
      const match = /^gitdir:\s+([^\r\n]+)$/.exec(text(pointer));
      if (!match) throw new Error("invalid Git directory pointer");
      const gitDir = directory(resolve2(root, match[1]));
      if (!/^(ref: refs\/[^\r\n]+|[0-9a-fA-F]{40,64})$/.test(text(join2(gitDir, "HEAD")))) throw new Error("invalid Git worktree HEAD");
      let commonPointer;
      try {
        commonPointer = text(join2(gitDir, "commondir"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        repository(gitDir);
        return { root: null, fallback: true };
      }
      if (!commonPointer || /[\r\n]/.test(commonPointer)) throw new Error("invalid Git common directory pointer");
      const common = directory(resolve2(gitDir, commonPointer)), layout = repository(common);
      if (layout !== "ordinary" || basename(common).toLowerCase() !== ".git") return { root: null, fallback: true };
      const entry = relative(join2(common, "worktrees"), gitDir);
      if (!entry || entry === ".." || entry.startsWith("..\\") || entry.startsWith("../") || /[\\/]/.test(entry)) throw new Error("Git worktree pointer is outside its common directory");
      const backPointer = text(join2(gitDir, "gitdir"));
      if (backPointer && !/[\r\n]/.test(backPointer)) seen(resolve2(gitDir, backPointer));
      if (!backPointer || /[\r\n]/.test(backPointer) || !samePath(realpathSync2.native(resolve2(gitDir, backPointer)), realpathSync2.native(pointer))) throw new Error("Git worktree pointer does not identify this checkout");
      return { root: dirname(common) };
    } catch {
      return { root: null };
    }
  }
}
function resolveProjectRoot(physical, visibleRoot) {
  const git = (args) => execFileSync(
    "git",
    [...gitSafetyArgs(), "-C", physical, "rev-parse", ...args],
    { encoding: "utf8", timeout: 3e3, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
  ).trim();
  try {
    const top = realpathSync2.native(git(["--show-toplevel"]));
    const common = realpathSync2.native(resolve2(physical, git(["--git-common-dir"])));
    if (common.endsWith("/.git") || common.endsWith("\\.git")) return visibleRoot(realpathSync2.native(dirname(common)));
    try {
      const configured = execFileSync(
        "git",
        [...gitSafetyArgs(), "--git-dir", common, "config", "--get", "core.worktree"],
        { encoding: "utf8", timeout: 3e3, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      if (configured) return visibleRoot(realpathSync2.native(resolve2(common, configured)));
    } catch {
    }
    const worktrees = execFileSync(
      "git",
      [...gitSafetyArgs(), "-C", physical, "worktree", "list", "--porcelain"],
      { encoding: "utf8", timeout: 3e3, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
    );
    const main = worktrees.split(/\r?\n\r?\n/).find((entry) => !/^bare$/m.test(entry));
    const root = main && /^worktree (.+)$/m.exec(main)?.[1];
    return visibleRoot(root ? realpathSync2.native(root) : top);
  } catch {
    return physical;
  }
}
function projectKey(root) {
  return process.platform === "win32" ? root.toLowerCase() : root;
}
function projectGroupsEnabled(root, home, agent) {
  if (!root) return false;
  try {
    const records = [];
    for (const path of [home && join2(home, "config.json"), join2(root, ".agent-bridge", "config.json")]) {
      if (!path || !existsSync(path)) {
        records.push({});
        continue;
      }
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      records.push(value);
    }
    const section = (value) => {
      const local = agent ? value[agent] : void 0;
      return local && typeof local === "object" && !Array.isArray(local) ? local : {};
    };
    const [globalConfig, projectConfig] = records;
    const enabled = [
      section(projectConfig).projectGroups,
      projectConfig.projectGroups,
      section(globalConfig).projectGroups,
      globalConfig.projectGroups
    ].find((v) => v !== void 0);
    return enabled === void 0 || enabled === true;
  } catch {
    return false;
  }
}
function migrateProjectJobs(records) {
  const roots = /* @__PURE__ */ new Map();
  const rootFor = (cwd) => {
    if (!roots.has(cwd)) roots.set(cwd, canonicalProjectRoot(cwd));
    return roots.get(cwd) ?? null;
  };
  return records.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const job = entry;
    if (typeof job.projectRoot === "string") return entry;
    const worktree = job.worktree;
    for (const value of [worktree?.repoRoot, job.workdir]) {
      if (typeof value !== "string") continue;
      const root = rootFor(value);
      if (root) return { ...job, projectRoot: root };
    }
    return entry;
  });
}
var conversationRoots = /* @__PURE__ */ new Map();
function conversationProject(cwd) {
  if (!cwd || isPluginCacheCwd(cwd)) return "";
  try {
    if (isPluginCacheCwd(realpathSync2.native(cwd))) return "";
  } catch {
  }
  const cacheKey = JSON.stringify([cwd, process.env.GIT_CEILING_DIRECTORIES]);
  const known = conversationRoots.get(cacheKey);
  if (known !== void 0) return known;
  const canonical = canonicalProjectRoot(cwd);
  const root = canonical ? projectKey(canonical) : existsSync(cwd) ? "" : projectKey(resolve2(cwd));
  if (conversationRoots.size >= 256) conversationRoots.delete(conversationRoots.keys().next().value);
  conversationRoots.set(cacheKey, root);
  return root;
}

export {
  isPluginCacheCwd,
  isInternalBridgeProcess,
  GitSafetyRefusal,
  gitSafetyArgs,
  NO_LAZY_FETCH_ARGS,
  splitGitArgs,
  gitGuardReadFailure,
  repositoryGuards,
  repositoryGuardsSync,
  diffSafety,
  physicalPath,
  canonicalProjectRoot,
  projectKey,
  projectGroupsEnabled,
  migrateProjectJobs,
  conversationProject
};
