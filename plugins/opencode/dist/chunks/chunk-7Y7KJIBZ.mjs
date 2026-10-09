import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  DelegateError,
  runProcess
} from "./chunk-6RGRWK7M.mjs";
import {
  loadConfig
} from "./chunk-QI6BOSWF.mjs";
import {
  nullLogger
} from "./chunk-EVPBD2NK.mjs";

// src/core/worktree.ts
import { createHash, randomUUID } from "node:crypto";
import { existsSync as existsSync2, lstatSync as lstatSync2, mkdirSync as mkdirSync2, readFileSync, realpathSync as realpathSync2, rmSync as rmSync2 } from "node:fs";
import { basename as basename2, isAbsolute as isAbsolute2, join as join2, relative as relative2, resolve as resolve2, toNamespacedPath as toNamespacedPath2 } from "node:path";

// src/core/worktree-links.ts
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from "node:path";
var WORKTREE_LINK_HINT = "(agent-bridge: worktree isolation is mandatory for source and writable files. External directory links may be used only for read-only access to Git-ignored caches: node_modules, .vs, __pycache__, or Library beside a Unity ProjectSettings/ProjectVersion.txt. Never write, delete, truncate or change permissions in a linked source, including through an internal link chain. A junction does not enforce read-only access: do not run Unity imports, package installers or other cache-writing tools through it. Prefer a project's external-cache env/config option (e.g. ANIMASKY_LIBRARY_ROOT) when available; never substitute an incomplete cache copy. Other external links remain forbidden. Cleanup must unlink only the link itself and never recurse into its target. Request cleanup approval through the supervisor and report the link and target if cleanup is denied.)";
function ignoredCacheLink(root, path) {
  const name = basename(path);
  const cache = ["node_modules", ".vs", "__pycache__"].includes(name) || name === "Library" && existsSync(join(dirname(path), "ProjectSettings", "ProjectVersion.txt"));
  if (!cache || path === root) return false;
  const rel = relative(root, path).split(sep).join("/");
  try {
    root = realpathSync.native(root);
    const args = ["-c", `safe.directory=${root.split(sep).join("/")}`];
    const tracked = execFileSync("git", [...args, "ls-files", "-z", "--", `:(literal)${rel}`], { cwd: root, encoding: "utf8", timeout: 1e4, stdio: ["pipe", "pipe", "pipe"] });
    if (tracked) return false;
    const gitDir = execFileSync("git", [...args, "rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf8", timeout: 1e4, stdio: ["pipe", "pipe", "pipe"] }).trim();
    let excludes = "";
    try {
      excludes = execFileSync("git", [...args, "config", "--path", "--get", "core.excludesFile"], { cwd: root, encoding: "utf8", timeout: 1e4, stdio: ["pipe", "pipe", "pipe"] }).trim();
    } catch (err) {
      if (err.status !== 1) throw err;
    }
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
      execFileSync("git", [...ignoreArgs, `--git-dir=${gitDir}`, `--work-tree=${probe}`, "check-ignore", "--no-index", "--quiet", "--", `${rel}/`], { cwd: probe, timeout: 1e4, stdio: ["pipe", "pipe", "pipe"] });
      return true;
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  } catch {
    return false;
  }
}
function resolveWorktreeRemovalPath(path, managedRoot = path) {
  const boundary = resolve(managedRoot);
  const rel = relative(boundary, resolve(path));
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel) || dirname(boundary) === boundary) {
    throw new Error(`Refusing cleanup outside the managed worktree area: ${path}`);
  }
  let checked = join(realpathSync.native(dirname(boundary)), basename(boundary));
  for (const part of ["", ...rel ? rel.split(sep) : []]) {
    checked = join(checked, part);
    if (lstatSync(toNamespacedPath(checked)).isSymbolicLink()) throw new Error(`Refusing cleanup through a linked path: ${checked}`);
  }
  return checked;
}
function unlinkLinks(dir, managedRoot = dir) {
  return unlinkChildren(resolveWorktreeRemovalPath(dir, managedRoot));
}
function unlinkChildren(dir) {
  dir = toNamespacedPath(resolve(dir));
  if (lstatSync(dir).isSymbolicLink()) throw new Error(`Refusing cleanup through a linked worktree root: ${dir}`);
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      try {
        unlinkSync(path);
      } catch {
        rmdirSync(path);
      }
      count++;
    } else if (stat.isDirectory()) count += unlinkChildren(path);
  }
  return count;
}
function scanWorktreeLinks(root) {
  const scan = { externalLinks: [], errors: [] };
  const canonicalRoot = lstatSync(toNamespacedPath(root)).isSymbolicLink() ? resolve(root) : realpathSync.native(root);
  const inside = (target) => {
    const rel = relative(canonicalRoot, target);
    return rel === "" || rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
  };
  const visit = (path) => {
    try {
      const stat = lstatSync(toNamespacedPath(path));
      if (stat.isSymbolicLink()) {
        const raw = readlinkSync(toNamespacedPath(path));
        let target = resolve(dirname(path), raw);
        try {
          target = realpathSync.native(path);
        } catch {
        }
        if (!inside(target)) {
          const link = { path, target };
          scan.externalLinks.push(link);
          let directory = false;
          try {
            directory = lstatSync(toNamespacedPath(target)).isDirectory();
          } catch {
          }
          if (directory && ignoredCacheLink(resolve(root), path)) (scan.readOnlyCacheLinks ??= []).push(link);
        }
      } else if (stat.isDirectory()) {
        for (const entry of readdirSync(toNamespacedPath(path))) visit(join(path, entry));
      }
    } catch (err) {
      scan.errors.push(`${path}: ${err.message}`);
    }
  };
  visit(resolve(root));
  return scan;
}
function worktreeLinkWarning(scan) {
  const caches = new Set(scan.readOnlyCacheLinks?.map((link) => link.path));
  const lines = scan.externalLinks.filter((link) => !caches.has(link.path)).map((link) => `${link.path} -> ${link.target}`);
  if (lines.length) lines.unshift("WARNING: external worktree links/reparse points found. Do not run tools through these links; unlink the link itself without recursively deleting its target:");
  if (caches.size) lines.push("Read-only ignored cache links (never modify the source; unlink only the link itself without recursively deleting its target):", ...scan.readOnlyCacheLinks.map((link) => `${link.path} -> ${link.target}`));
  if (scan.errors.length) lines.push(`WARNING: worktree link inspection incomplete:
${scan.errors.join("\n")}`);
  return lines.length ? lines.join("\n") : null;
}

// src/core/worktree.ts
var GIT = "git";
var LONG_PATH_ARGS = ["-c", "core.longpaths=true"];
var REMOVE_RETRIES = 3;
var GIT_TIMEOUT_MS = 18e4;
var WORKTREE_ADD_TIMEOUT_MS = 6e5;
var BRANCH_PREFIX = "agent-bridge/";
var MAX_DIFFSTAT_CHARS = 4e3;
function trustArgs(...dirs) {
  return dirs.flatMap((d) => ["-c", `safe.directory=${resolve2(d).replace(/\\/g, "/")}`]);
}
async function git(args, cwd, log, timeoutMs = GIT_TIMEOUT_MS, env = process.env) {
  const what = `git ${args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-c").slice(0, 2).join(" ")}`;
  const res = await runProcess({ bin: GIT, args: [...LONG_PATH_ARGS, ...args], stdin: "", cwd, timeoutMs, env, log, what });
  if (res.code !== 0) throw new Error(`${what} failed: ${(res.stderr || res.stdout).trim().slice(0, 500)}`);
  return res.stdout.trimEnd();
}
async function createWorktree(opts) {
  let repoRoot;
  try {
    repoRoot = await git(["rev-parse", "--show-toplevel"], opts.cwd, opts.log);
  } catch {
    throw new Error(`worktree isolation needs a git repository, but ${opts.cwd} is not inside one`);
  }
  const base = await git(["rev-parse", "HEAD"], repoRoot, opts.log);
  const baseBranch = await git(["symbolic-ref", "-q", "--short", "HEAD"], repoRoot, opts.log).catch(() => "") || null;
  let branch = `${BRANCH_PREFIX}${opts.jobId}`;
  const dir = opts.worktreeRoot ?? join2(opts.home, "worktrees");
  let path = join2(dir, `${basename2(repoRoot)}-${opts.jobId}`);
  if (await worktreeLocationExists(repoRoot, branch, path, opts.log)) {
    throw new Error(`could not create a worktree for the subagent; existing branch or path retained: ${branch}, ${path}`);
  }
  mkdirSync2(dir, { recursive: true });
  try {
    await git(["worktree", "add", "-b", branch, path, base], repoRoot, opts.log, WORKTREE_ADD_TIMEOUT_MS);
  } catch (err) {
    if (!(err instanceof DelegateError && err.kind === "timeout")) {
      throw new Error(`could not create a worktree for the subagent; retained branch ${branch} and path ${path}: ${err.message}`);
    }
    opts.log.warn("git worktree add timed out; retaining first attempt and retrying once", { branch, path });
    [branch, path] = await unusedRetryLocation(repoRoot, branch, path, opts.log);
    try {
      await git(["worktree", "add", "-b", branch, path, base], repoRoot, opts.log, WORKTREE_ADD_TIMEOUT_MS);
    } catch (again) {
      throw new Error(`could not create a worktree for the subagent (tried twice); retained both attempts, including branch ${branch} and path ${path}: ${again.message}`);
    }
  }
  await unlockWorktree(repoRoot, path, opts.log);
  const rel = relative2(repoRoot, opts.cwd);
  const cwd = rel && !rel.startsWith("..") && !isAbsolute2(rel) ? join2(path, rel) : path;
  opts.log.info("worktree created", { repoRoot, path, branch });
  return { repoRoot, path, cwd, branch, base, baseBranch };
}
async function unlockWorktree(repoRoot, path, log) {
  await git([...trustArgs(path), "worktree", "unlock", path], repoRoot, log).catch(() => "");
}
async function worktreeLocationExists(repoRoot, branch, path, log) {
  const refs = await git(["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`], repoRoot, log);
  if (refs.split(/\r?\n/).includes(`refs/heads/${branch}`)) return true;
  try {
    lstatSync2(toNamespacedPath2(path));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function unusedRetryLocation(repoRoot, branch, path, log) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = `-r2-${randomUUID()}`;
    const retryBranch = branch + suffix, retryPath = path + suffix;
    if (!await worktreeLocationExists(repoRoot, retryBranch, retryPath, log)) return [retryBranch, retryPath];
  }
  throw new Error(`could not select an unused worktree retry location; retained branch ${branch} and path ${path}`);
}
function removeWorktreeDirectory(path, managedRoot = path) {
  if (!existsSync2(toNamespacedPath2(path))) return;
  path = resolveWorktreeRemovalPath(path, managedRoot);
  unlinkLinks(path);
  rmSync2(toNamespacedPath2(resolve2(path)), { recursive: true, force: true, maxRetries: REMOVE_RETRIES });
}
function subagentCommitMessage(opts) {
  return "Save worktree changes";
}
async function gitDirsOutside(cwd, log) {
  try {
    const [gitDir, common] = (await git(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], cwd, log)).split(/\r?\n/);
    const real = (p) => {
      try {
        return realpathSync2.native(p);
      } catch {
        return resolve2(p);
      }
    };
    const inside = (p) => {
      const rel = relative2(real(cwd), real(p));
      return rel === "" || !rel.startsWith("..") && !isAbsolute2(rel);
    };
    return [...new Set([gitDir, common].filter((p) => Boolean(p) && !inside(p)))];
  } catch {
    return [];
  }
}
async function reviewBase(wt, log, branch = wt.branch) {
  const run = (args) => git(args, wt.repoRoot, log);
  const tip = await run(["rev-parse", branch]);
  const reflog = await git([...trustArgs(wt.path), "log", "-g", "--format=%H%x09%gs", "HEAD"], wt.path, log).catch(() => "");
  const start = reflog.split(/\r?\n/).reverse().find((line) => line.endsWith(` to ${branch}`) && line.includes("	checkout: moving from "))?.split("	")[0];
  const base = branch === wt.branch ? wt.base : start ?? wt.base;
  const created = (await run(["log", "-g", "--format=%H%x09%gs", branch]).catch(() => "")).split(/\r?\n/).reverse().find((line) => line.startsWith(`${base}	branch: Created from `));
  const source = branch !== wt.branch ? created?.split("	branch: Created from ")[1] : null;
  const list = await run(["worktree", "list", "--porcelain"]).catch(() => "");
  const main = /^branch refs\/heads\/(.+)$/m.exec(list.split(/\r?\n\r?\n/)[0] ?? "")?.[1];
  const candidates = /* @__PURE__ */ new Set([base]);
  for (const b of /* @__PURE__ */ new Set([source, wt.baseBranch, main])) {
    if (!b || b === "HEAD" || b === branch) continue;
    const mb = await run(["merge-base", b, branch]).catch(() => "");
    if (mb && mb !== tip) candidates.add(mb);
  }
  let best = base;
  let fewest = Infinity;
  for (const c of candidates) {
    const n = Number(await run(["rev-list", "--count", `${c}..${branch}`]).catch(() => "NaN"));
    if (n < fewest) [best, fewest] = [c, n];
  }
  return best;
}
var GENERATED_DIRECTORIES = /* @__PURE__ */ new Set(["node_modules", ".vs", "__pycache__"]);
var UNITY_GENERATED_DIRECTORIES = /* @__PURE__ */ new Set(["Library", "Temp", "Obj", "Logs", "UserSettings"]);
var GENERATED_FILES = /* @__PURE__ */ new Set([".DS_Store", "Thumbs.db"]);
function generatedNoise(root, file) {
  const parts = file.split("/");
  if (GENERATED_FILES.has(parts.at(-1))) return true;
  return parts.slice(0, -1).some((part, index) => {
    if (GENERATED_DIRECTORIES.has(part)) return true;
    if (!UNITY_GENERATED_DIRECTORIES.has(part)) return false;
    return existsSync2(toNamespacedPath2(join2(root, ...parts.slice(0, index), "ProjectSettings", "ProjectVersion.txt")));
  });
}
async function autoCommitFiles(wt, log) {
  const trust = trustArgs(wt.path);
  const status = await git([...trust, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], wt.path, log);
  const included = [];
  const unstage = [];
  const skipped = [];
  for (const entry of status.split("\0").filter(Boolean)) {
    const file = entry.slice(3);
    const literal = `:(literal)${file}`;
    let reason;
    if (generatedNoise(wt.path, file)) reason = "generated noise";
    else if (entry.startsWith("??")) reason = "untracked; not explicitly staged";
    else if (entry.startsWith("??") || await git([...trust, "diff", "--ignore-all-space", "--ignore-cr-at-eol", "--no-ext-diff", "--no-textconv", "--no-renames", "HEAD", "--", literal], wt.path, log)) {
      if (!entry.startsWith("D ")) included.push(literal);
    } else reason = "whitespace only";
    if (reason) {
      skipped.push({ path: file, reason });
      if (entry[0] !== "?" && entry[0] !== " ") unstage.push(literal);
    }
  }
  for (const file of unstage) await git([...trust, "reset", "-q", "HEAD", "--", file], wt.path, log);
  for (const file of included) await git([...trust, "add", "-A", "--", file], wt.path, log);
  return skipped;
}
async function finishWorktree(wt, message, log) {
  const trust = trustArgs(wt.path);
  const skippedFiles = await autoCommitFiles(wt, log);
  const status = await git([...trust, "diff", "--cached", "--name-only", "-z"], wt.path, log);
  if (status) {
    for (const key of ["user.name", "user.email"]) {
      if (!(await git([...trust, "config", "--get", key], wt.path, log).catch(() => "")).trim()) throw new Error(`Configure ${key} before saving worktree changes.`);
    }
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)$/i.test(key)) delete env[key];
    await git([...trust, "-c", `core.hooksPath=${resolve2(wt.path).replace(/\\/g, "/")}/.git/checkpoint-hooks-disabled`, "commit", "-q", "--no-verify", "-m", "Save worktree changes"], wt.path, log, GIT_TIMEOUT_MS, env);
  }
  await unlockWorktree(wt.repoRoot, wt.path, log);
  const current = await git([...trust, "branch", "--show-current"], wt.path, log).catch(() => "") || wt.branch;
  const work = await workBranches(wt, current, log);
  const branch = work.has(current) || !work.size ? current : [...work.keys()][0];
  const from = await reviewBase(wt, log, branch);
  const diffStat = await git(["diff", "--stat", `${from}..${branch}`], wt.repoRoot, log);
  const files = (await git(["diff", "--name-only", "-z", `${from}..${branch}`], wt.repoRoot, log)).split("\0").filter(Boolean);
  const otherBranches = [...work].filter(([name]) => name !== branch).map(([name, commits]) => ({ name, commits }));
  return { changed: diffStat.length > 0 || otherBranches.length > 0, branch, otherBranches, diffStat: diffStat.slice(0, MAX_DIFFSTAT_CHARS), reviewBase: from, files, skippedFiles };
}
async function workBranches(wt, current, log) {
  const trust = trustArgs(wt.path);
  const visited = new Set((await git([...trust, "log", "-g", "--format=%H%x09%gs", "HEAD"], wt.path, log).catch(() => "")).split(/\r?\n/).filter((line) => line && !line.includes("	checkout: ")).map((line) => line.split("	")[0]));
  const refs = (await git(["for-each-ref", "refs/heads", "--format=%(refname:short) %(objectname)"], wt.repoRoot, log).catch(() => "")).split(/\r?\n/).map((l) => l.split(" ")).filter((p) => p.length === 2);
  const list = await git(["worktree", "list", "--porcelain"], wt.repoRoot, log).catch(() => "");
  const here = resolve2(wt.path).toLowerCase();
  const elsewhere = new Set(
    list.split(/\r?\n\r?\n/).filter((block) => resolve2(/^worktree (.+)$/m.exec(block)?.[1] ?? "").toLowerCase() !== here).map((block) => /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]).filter((b) => Boolean(b))
  );
  for (const b of [wt.baseBranch]) if (b) elsewhere.add(b);
  const candidates = new Set(
    [wt.branch, current, ...refs.filter(([, sha]) => visited.has(sha) && sha !== wt.base).map(([name]) => name)].filter((b) => b === wt.branch || !elsewhere.has(b))
  );
  const out = /* @__PURE__ */ new Map();
  for (const name of candidates) {
    const from = await reviewBase(wt, log, name).catch(() => null);
    const commits = from ? Number(await git(["rev-list", "--count", `${from}..${name}`], wt.repoRoot, log).catch(() => "0")) : 0;
    if (commits > 0) out.set(name, commits);
  }
  return out;
}
var HANDOFF_FILE = /(^|\/)(HANDOFF|TODO)\.md$/i;
function handoffWarning(files) {
  const hit = files.filter((f) => HANDOFF_FILE.test(f.replace(/\\/g, "/")));
  return hit.length ? `WARNING: this job changed ${hit.join(", ")}. Delegated jobs should report in their answer and leave handoff and TODO files to you: check these changes before you take them.` : null;
}
function worktreeReport(wt, outcome) {
  const branch = outcome.branch ?? wt.branch;
  const skipped = outcome.skippedFiles ?? [];
  const rule = skipped.length ? `Auto-commit skipped whitespace/line-ending-only changes, generated noise and unstaged untracked files; left on disk: ${skipped.map((f) => `${f.path} (${f.reason})`).join(", ")}.` : "";
  const remove = "git -c core.longpaths=true worktree remove";
  if (!outcome.changed) return [
    skipped.length ? `Worktree ${wt.path} (branch ${branch}) has no real changes committed; excluded files remain on disk. Keep this worktree for review.` : `Worktree ${wt.path} (branch ${branch}) has no changes; remove it with: ${remove} "${wt.path}" && git branch -D ${branch}`,
    rule
  ].filter(Boolean).join("\n");
  const others = outcome.otherBranches ?? [];
  const lines = [
    `Changes are committed on branch ${branch} (worktree ${wt.path}), not in your working copy` + (branch !== wt.branch ? ` (the job worked on its own branch; ${wt.branch} was its starting branch)` : "") + ":"
  ];
  if (outcome.diffStat) lines.push(outcome.diffStat);
  if (rule) lines.push(rule);
  if (others.length) lines.push(`Also committed from this worktree: ${others.map((o) => `${o.name} (${o.commits} commit${o.commits === 1 ? "" : "s"})`).join(", ")}. Review those before removing anything.`);
  lines.push(...[handoffWarning(outcome.files)].filter((w) => Boolean(w)));
  if (outcome.diffStat) {
    lines.push(`Review base: ${outcome.reviewBase} (job fork point).`);
    lines.push(`Review: git diff ${outcome.reviewBase.slice(0, 12)}..${branch}`);
    lines.push(`Take them: git merge ${branch}   (or git cherry-pick ${branch})`);
  }
  lines.push(skipped.length ? "Excluded files remain on disk. Keep this worktree until they have been reviewed and preserved." : `Discard: ${remove} --force "${wt.path}" && git branch -D ${[branch, ...others.map((o) => o.name)].join(" ")}`);
  return lines.join("\n");
}
async function gitChangeSnapshot(cwd, log) {
  let status;
  try {
    status = await git(["status", "--porcelain", "--untracked-files=all"], cwd, log);
  } catch {
    return null;
  }
  let root;
  try {
    root = await git(["rev-parse", "--show-toplevel"], cwd, log);
  } catch {
    return null;
  }
  const snap = /* @__PURE__ */ new Map();
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    const file = line.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, "");
    let fp = line.slice(0, 2);
    try {
      fp += ":" + createHash("sha1").update(readFileSync(join2(root, file))).digest("hex");
    } catch {
      fp += ":missing";
    }
    snap.set(file, fp);
  }
  return snap;
}
function changedFiles(before, after) {
  const out = /* @__PURE__ */ new Set();
  for (const [f, fp] of after) if (before.get(f) !== fp) out.add(f);
  for (const f of before.keys()) if (!after.has(f)) out.add(f);
  return [...out].sort();
}
function worktreeRoots(home) {
  const roots = [join2(home, "worktrees")];
  const configured = loadConfig(home, "other", nullLogger).worktreeRoot;
  if (configured && resolve2(configured).toLowerCase() !== resolve2(roots[0]).toLowerCase()) roots.push(configured);
  return roots;
}

export {
  WORKTREE_LINK_HINT,
  resolveWorktreeRemovalPath,
  unlinkLinks,
  scanWorktreeLinks,
  worktreeLinkWarning,
  BRANCH_PREFIX,
  trustArgs,
  git,
  createWorktree,
  removeWorktreeDirectory,
  subagentCommitMessage,
  gitDirsOutside,
  finishWorktree,
  handoffWarning,
  worktreeReport,
  gitChangeSnapshot,
  changedFiles,
  worktreeRoots
};
