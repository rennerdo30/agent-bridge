import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  readWorktreeState,
  rootId,
  saveWorktreeState,
  worktreeLease
} from "./chunk-YWCSJN6E.mjs";
import {
  assertPhysicalPath,
  permissionRepairPlan
} from "./chunk-VBI722PL.mjs";
import {
  git,
  removeWorktreeDirectory,
  trustArgs
} from "./chunk-AUHFUJG3.mjs";

// src/core/job-close.ts
import { existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
async function recordWorktreeOrigin(home, wt, log) {
  assertPhysicalPath(wt.path);
  const files = (await git([...trustArgs(wt.path), "ls-files", "-z"], wt.path, log)).split("\0").filter(Boolean);
  const libraries = files.filter((file) => /(^|\/)ProjectSettings\/ProjectVersion\.txt$/.test(file)).map((file) => join(dirname(dirname(file)), "Library")).filter((path) => {
    try {
      lstatSync(join(wt.path, path));
      return false;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      return true;
    }
  });
  saveWorktreeState(home, wt, { contractVersion: 1, path: wt.path, repoRoot: wt.repoRoot, base: wt.base, rootId: rootId(wt.path), libraries, lastContinuation: Date.now(), processesStopped: false });
}
var inside = (path, parent) => {
  const rel = relative(parent, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
async function inspect(wt, state, log) {
  assertPhysicalPath(wt.path);
  if (rootId(wt.path) !== state.rootId) throw new Error("Worktree root was replaced; provenance no longer applies.");
  if (permissionRepairPlan(wt.path).skipped.length) throw new Error("Linked or shared contents are kept.");
  const run = (args) => git([...trustArgs(wt.path), ...args], wt.path, log);
  if (await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) throw new Error("Uncommitted or non-ignored untracked files are kept.");
  const libraries = [];
  for (const file of state.libraries) {
    const path = resolve(wt.path, file);
    if (!inside(path, wt.path) || path === resolve(wt.path) || !/(^|[\\/])Library$/.test(file)) throw new Error("Invalid cache provenance; kept.");
    if (!existsSync(path)) continue;
    if (!lstatSync(path).isDirectory() || !existsSync(join(dirname(path), "ProjectSettings", "ProjectVersion.txt"))) throw new Error("Cache is no longer a Unity Library.");
    if (await run(["ls-files", "-z", "--", `:(literal)${file.replace(/\\/g, "/")}`])) throw new Error("Tracked Library contents are kept.");
    libraries.push(path);
  }
  const ignored = (await run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  for (const file of ignored) if (!libraries.some((lib) => inside(resolve(wt.path, file), lib))) throw new Error("Unknown ignored files may contain user data; kept.");
  const head = await run(["rev-parse", "HEAD"]);
  const currentBranch = await run(["symbolic-ref", "--short", "HEAD"]);
  const reflog = await run(["reflog", "show", "--format=%H", "HEAD"]);
  if (!reflog) throw new Error("Worktree commit history unavailable; kept.");
  const branch = await run(["rev-parse", "--verify", wt.branch]);
  const commits = [.../* @__PURE__ */ new Set([head, branch, ...reflog.split(/\r?\n/).filter(Boolean)])];
  if (!commits.every((sha) => /^[a-f0-9]{40,64}$/.test(sha))) throw new Error("Invalid commit history; kept.");
  return { libraries, head, branch: currentBranch, commits };
}
async function closeJobWorktree(opts) {
  if (!opts.enabled) return { action: "disabled", reason: "jobCloseCleanup is off" };
  const wt = opts.job.worktree;
  if (!wt || opts.job.remote || !["done", "failed"].includes(opts.job.status) || opts.job.queue?.length) return { action: "kept", reason: "Only a finished local worktree job without queued continuations can close." };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(opts.job.name)) return { action: "kept", reason: "Invalid job branch name." };
  let release;
  try {
    release = worktreeLease(opts.home, wt);
    const state = readWorktreeState(opts.home, wt);
    if (!state) return { action: "kept", reason: "No supported worktree provenance; legacy worktrees are kept." };
    if (state.reapedAt && !existsSync(wt.path)) return { action: "reaped", reason: "Already safely reaped.", pushed: state.pushed };
    if (state.processesStopped !== true) return { action: "kept", reason: "Job process shutdown is unproven; worktree retained." };
    const before = await inspect(wt, state, opts.log);
    const run = (args) => git([...trustArgs(wt.repoRoot), ...args], wt.repoRoot, opts.log);
    const pushed = [{ ref: `refs/heads/wip/${opts.job.name}`, sha: before.head }];
    for (const sha of before.commits) {
      try {
        await run(["merge-base", "--is-ancestor", sha, before.head]);
      } catch {
        pushed.push({ ref: `refs/heads/wip/${opts.job.name}-history-${sha}`, sha });
      }
    }
    await run(["push", "origin", ...pushed.map(({ ref, sha }) => `${sha}:${ref}`)]);
    const remote = await run(["ls-remote", "--heads", "origin", ...pushed.map((p) => p.ref)]);
    const refs = new Map(remote.split(/\r?\n/).filter(Boolean).map((line) => {
      const [sha, ref] = line.split(/\s+/);
      return [ref, sha];
    }));
    if (!pushed.every((p) => refs.get(p.ref) === p.sha)) throw new Error("Remote commit verification failed; kept.");
    const after = await inspect(wt, state, opts.log);
    if (after.head !== before.head || after.branch !== before.branch || after.commits.join() !== before.commits.join() || after.libraries.join() !== before.libraries.join()) throw new Error("Worktree changed while pushing; kept.");
    saveWorktreeState(opts.home, wt, { ...state, closedAt: Date.now(), pushed, resumeBranch: before.branch });
    for (const path of after.libraries) removeWorktreeDirectory(path, wt.path);
    await run(["worktree", "remove", wt.path]);
    saveWorktreeState(opts.home, wt, { ...state, closedAt: Date.now(), reapedAt: Date.now(), pushed, resumeBranch: before.branch });
    return { action: "reaped", reason: "All worktree commits verified on pushed branches; clean checkout removed; local branches retained.", pushed };
  } catch (err) {
    return { action: "kept", reason: err.message };
  } finally {
    release?.();
  }
}
async function prepareWorktreeContinuation(home, wt, log) {
  let state = readWorktreeState(home, wt);
  if (!existsSync(wt.path)) {
    if (!state?.reapedAt || !state.pushed?.length) throw new Error("Worktree is missing without a verified reap record; recreate it explicitly.");
    const branch = state.resumeBranch ?? wt.branch;
    await git([...trustArgs(wt.repoRoot), "worktree", "add", wt.path, branch], wt.repoRoot, log);
    wt.branch = branch;
    await recordWorktreeOrigin(home, wt, log);
    state = readWorktreeState(home, wt);
  }
  assertPhysicalPath(wt.path);
  if (state && rootId(wt.path) !== state.rootId) throw new Error("Worktree root was replaced; restore isolation before continuing.");
  if (state) saveWorktreeState(home, wt, { ...state, lastContinuation: Date.now(), closedAt: void 0, reapedAt: void 0, processesStopped: false });
}

export {
  recordWorktreeOrigin,
  closeJobWorktree,
  prepareWorktreeContinuation
};
