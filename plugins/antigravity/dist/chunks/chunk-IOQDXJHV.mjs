import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  assertPhysicalPath,
  permissionRepairPlan
} from "./chunk-AV4MBWYH.mjs";
import {
  REMOTE_JOB_POLL_MS,
  remoteSpawnArgsSchema
} from "./chunk-CMQ3JLYG.mjs";
import {
  git,
  removeWorktreeDirectory,
  trustArgs
} from "./chunk-QPILQORG.mjs";
import {
  jobEnvironment,
  killPid,
  pidAlive
} from "./chunk-PFAESD67.mjs";
import {
  metadataFileLease,
  readHistoryJson
} from "./chunk-P3D6CPFS.mjs";
import {
  JSON_STORE_VERSION,
  archiveFile,
  assertStoreUpgrade,
  assertWritableStore,
  isRecord,
  mergeStoreFields,
  readJsonStore,
  refreshStorePeerIdentities,
  retentionLimit,
  writeJsonStore
} from "./chunk-GN275QYC.mjs";

// src/core/worktree-state.ts
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
var WORKTREE_STATE_CONTRACT = 1;
var key = (wt) => createHash("sha256").update(resolve(wt.path).toLowerCase()).digest("hex");
var statePath = (home, wt) => join(home, "worktree-state", `${key(wt)}.json`);
var rootId = (path) => {
  const stat = lstatSync(path);
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
};
function readWorktreeState(home, wt) {
  const value = readHistoryJson(statePath(home, wt));
  if (!isRecord(value) || typeof value.version === "number" && value.version > JSON_STORE_VERSION || value.contractVersion !== WORKTREE_STATE_CONTRACT || value.path !== wt.path || value.repoRoot !== wt.repoRoot || value.base !== wt.base || typeof value.rootId !== "string" || !Array.isArray(value.libraries) || !value.libraries.every((p) => typeof p === "string") || typeof value.lastContinuation !== "number") return null;
  return value;
}
function saveWorktreeState(home, wt, value) {
  const path = statePath(home, wt);
  writeJsonStore(path, { ...value }, readJsonStore(path));
}
function recordWorktreeProcessProof(home, wt, stopped) {
  const state = readWorktreeState(home, wt);
  if (state) saveWorktreeState(home, wt, { ...state, processesStopped: stopped });
}
function invalidateWorktreePathProof(home, path) {
  const value = readHistoryJson(statePath(home, { path }));
  if (!isRecord(value) || typeof value.repoRoot !== "string" || typeof value.base !== "string") return;
  const wt = { path, cwd: path, repoRoot: value.repoRoot, base: value.base, branch: "" };
  const state = readWorktreeState(home, wt);
  if (state) saveWorktreeState(home, wt, { ...state, processesStopped: false, lastContinuation: Date.now() });
}
var LEASE_BUSY = "Worktree is running, closing, or has an unreconciled lease; kept unchanged.";
function worktreeLease(home, wt) {
  try {
    return metadataFileLease(join(home, "worktree-leases", key(wt)));
  } catch {
    throw new Error(LEASE_BUSY);
  }
}

// src/core/job-close.ts
import { existsSync, lstatSync as lstatSync2 } from "node:fs";
import { dirname, isAbsolute, join as join2, relative, resolve as resolve2, sep } from "node:path";
async function recordWorktreeOrigin(home, wt, log) {
  assertPhysicalPath(wt.path);
  const files = (await git([...trustArgs(wt.path), "ls-files", "-z"], wt.path, log)).split("\0").filter(Boolean);
  const libraries = files.filter((file) => /(^|\/)ProjectSettings\/ProjectVersion\.txt$/.test(file)).map((file) => join2(dirname(dirname(file)), "Library")).filter((path) => {
    try {
      lstatSync2(join2(wt.path, path));
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
    const path = resolve2(wt.path, file);
    if (!inside(path, wt.path) || path === resolve2(wt.path) || !/(^|[\\/])Library$/.test(file)) throw new Error("Invalid cache provenance; kept.");
    if (!existsSync(path)) continue;
    if (!lstatSync2(path).isDirectory() || !existsSync(join2(dirname(path), "ProjectSettings", "ProjectVersion.txt"))) throw new Error("Cache is no longer a Unity Library.");
    if (await run(["ls-files", "-z", "--", `:(literal)${file.replace(/\\/g, "/")}`])) throw new Error("Tracked Library contents are kept.");
    libraries.push(path);
  }
  const ignored = (await run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  for (const file of ignored) if (!libraries.some((lib) => inside(resolve2(wt.path, file), lib))) throw new Error("Unknown ignored files may contain user data; kept.");
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

// src/mcp/job-host.ts
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join as join4 } from "node:path";

// src/mcp/remote-job-host.ts
import { join as join3 } from "node:path";
var REMOTE_STATE_GRACE_MS = 9e4;
var RemoteJobHost = class {
  constructor(node, home, log) {
    this.node = node;
    this.home = home;
    this.log = log;
  }
  node;
  home;
  log;
  busy = /* @__PURE__ */ new Set();
  cache = /* @__PURE__ */ new Map();
  path(job) {
    return join3(this.home, "remote-job-states", `${job.id}.json`);
  }
  read(job) {
    return this.cache.get(job.id) ?? readJsonStore(this.path(job));
  }
  save(job, snapshot) {
    const data = { fetchedAt: Date.now(), snapshot };
    this.cache.set(job.id, data);
    writeJsonStore(this.path(job), data, readJsonStore(this.path(job)));
  }
  start(job, host, target, args) {
    job.remote = { host, name: `${target}-job-${job.id}` };
    this.cache.delete(job.id);
    this.save(job, { state: null, alive: true, approvals: [] });
    const raw = { ...args, cwd: args.cwd ?? job.workdir };
    for (const key2 of ["host", "_job", "_worktree", "send_to"]) delete raw[key2];
    const request = { op: "spawn", job: job.id, target, args: remoteSpawnArgsSchema.parse(raw) };
    this.busy.add(job.id);
    void this.node.remoteJob(host, request).then((snapshot) => {
      this.save(job, snapshot);
      if (job.controller.signal.aborted) this.send(job, { type: "cancel" });
    }, (err) => {
      this.save(job, { state: { pid: 0, peer: `${host}/${job.name}`, status: "failed", updatedAt: Date.now(), report: `Remote job failed: ${err.message}`, delivered: false }, alive: false, approvals: [] });
    }).finally(() => this.busy.delete(job.id));
    return { pid: null, peer: `${host}/${job.name}`, startedAt: Date.now() };
  }
  state(job) {
    const cached = this.read(job);
    if (!this.busy.has(job.id) && (!cached || Date.now() - cached.fetchedAt >= REMOTE_JOB_POLL_MS)) this.sendRequest(job, { op: "state", job: job.id });
    return cached?.snapshot.state ?? null;
  }
  alive(job) {
    const cached = this.read(job);
    return cached ? cached.snapshot.alive && Date.now() - cached.fetchedAt < REMOTE_STATE_GRACE_MS : Date.now() - (job.host?.startedAt ?? 0) < REMOTE_STATE_GRACE_MS;
  }
  send(job, control) {
    this.sendRequest(job, { op: "control", job: job.id, control });
  }
  sendRequest(job, request) {
    if (!job.remote) return;
    if (request.op === "state") this.busy.add(job.id);
    void this.node.remoteJob(job.remote.host, request).then((snapshot) => this.save(job, snapshot), (err) => {
      this.log.warn("remote job request failed", { job: job.name, host: job.remote?.host, operation: request.op, err: err.message });
    }).finally(() => {
      if (request.op === "state") this.busy.delete(job.id);
    });
  }
};

// src/mcp/job-host.ts
import { setTimeout as delay } from "node:timers/promises";
var RUNNERS_DIR_NAME = "jobs";
var JOB_PEER_PREFIX = "job:";
var CONTROL_CONVERSATION_PREFIX = "jobctl-";
var RUNNER_HEARTBEAT_MS = 15e3;
var START_GRACE_MS = 3e4;
var KEEP_FILES_MS = 7 * 24 * 60 * 60 * 1e3;
var DETACH_LAUNCHER = "const c=require('node:child_process').spawn(process.execPath,process.argv.slice(1),{detached:true,stdio:'ignore',windowsHide:true});c.on('error',()=>process.exit(1));if(c.pid)process.stdout.write(String(c.pid));c.unref()";
function runnerStatePath(home, id) {
  return join4(home, RUNNERS_DIR_NAME, `${id}.json`);
}
function specPath(home, id) {
  return join4(home, RUNNERS_DIR_NAME, `${id}.spec.json`);
}
function readRunnerState(home, id) {
  try {
    const s = readJsonStore(runnerStatePath(home, id), void 0, (value) => isRecord(value) && typeof value.pid === "number" && typeof value.status === "string");
    return s && typeof s.pid === "number" && typeof s.status === "string" ? s : null;
  } catch {
    return null;
  }
}
function writeRunnerState(home, id, state) {
  const path = runnerStatePath(home, id);
  const previous = readJsonStore(path);
  writeJsonStore(path, mergeStoreFields(isRecord(previous) ? previous : {}, { ...state }), previous);
}
var JobRunners = class {
  constructor(node, home, cli, log) {
    this.node = node;
    this.home = home;
    this.cli = cli;
    this.log = log;
    this.remote = new RemoteJobHost(node, home, log);
    try {
      const dir = join4(home, RUNNERS_DIR_NAME);
      const keepMs = retentionLimit("AGENT_BRIDGE_RUNNER_KEEP_MS", KEEP_FILES_MS);
      if (!keepMs) return;
      for (const f of readdirSync(dir)) {
        const path = join4(dir, f);
        if (!f.endsWith(".json") || f.endsWith(".spec.json") || Date.now() - statSync(path).mtimeMs <= keepMs) continue;
        const id = f.replace(/\.json$/, "");
        const state = readRunnerState(home, id);
        if (state?.status === "done" || state?.status === "failed" || state?.status === "cancelled") {
          archiveFile(path);
          archiveFile(specPath(home, id));
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") this.log.warn("could not archive runner files", { err: String(err) });
    }
  }
  node;
  home;
  cli;
  log;
  remote;
  /** Start a turn of this job in a new runner; null when that is not possible (the turn then runs in the server). */
  async startAsync(job, spec, admission) {
    const signal = admission?.signal ?? job.controller.signal;
    let attempts = 0;
    for (; ; ) {
      signal.throwIfAborted();
      await refreshStorePeerIdentities(this.home, signal);
      signal.throwIfAborted();
      if (admission && !admission.isCurrent()) throw new Error("Detached job startup lost its supervisor authority before launch");
      try {
        return this.start(job, spec);
      } catch (error) {
        if (error.code !== "STORE_UPGRADE_DEFERRED") throw error;
        job.progress = `queued: ${error.message}`;
        if (attempts++ % 30 === 0) this.log.info("job runner start waits for retained store readers", { job: job.name, reason: String(error) });
        await delay(Math.min(1e3, attempts * 100), void 0, { signal });
      }
    }
  }
  start(job, spec) {
    if (spec.args.host) return this.remote.start(job, spec.args.host, spec.target, spec.args);
    try {
      mkdirSync(join4(this.home, RUNNERS_DIR_NAME), { recursive: true });
      const statePath2 = runnerStatePath(this.home, job.id);
      const file = specPath(this.home, job.id);
      assertWritableStore(readJsonStore(statePath2, this.log));
      assertWritableStore(readJsonStore(file, this.log));
      assertStoreUpgrade(this.home, "json", 0, JSON_STORE_VERSION);
      archiveFile(statePath2);
      const full = {
        ...spec,
        home: this.home,
        job: {
          id: job.id,
          name: job.name,
          agent: job.agent,
          model: job.model,
          prompt: job.prompt,
          startedAt: job.startedAt,
          args: job.args,
          sessionId: job.sessionId,
          workdir: job.workdir,
          worktree: job.worktree,
          owner: job.owner,
          supervisor: job.supervisor,
          metadataVersion: job.metadataVersion,
          parentJob: job.parentJob,
          rootSession: job.rootSession,
          rootName: job.rootName,
          allowedServers: [...job.allowedServers ?? []]
        }
      };
      archiveFile(file);
      writeJsonStore(file, { ...full }, null);
      const args = [this.cli, "job-runner", file];
      const info = { pid: null, peer: job.name, startedAt: Date.now() };
      let pid = null;
      if (process.platform === "win32") {
        const launcher = spawn(process.execPath, ["-e", DETACH_LAUNCHER, ...args], { env: jobEnvironment(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        let output = "";
        launcher.stdout.on("data", (chunk) => {
          output += chunk;
        });
        launcher.on("close", () => {
          const reported = Number(output);
          if (Number.isSafeInteger(reported) && reported > 0) info.pid = reported;
        });
        launcher.on("error", (err) => this.log.warn("could not start a job runner", { job: job.name, err: err.message }));
      } else {
        const child = spawn(process.execPath, args, { env: jobEnvironment(), detached: true, stdio: "ignore" });
        child.on("error", (err) => this.log.warn("could not start a job runner", { job: job.name, err: err.message }));
        child.unref();
        pid = child.pid ?? null;
      }
      this.log.info("job runner started", { job: job.name, pid });
      info.pid = pid;
      return info;
    } catch (err) {
      if (err.code === "STORE_UPGRADE_DEFERRED") throw err;
      this.log.warn("job runner unavailable; the subagent runs inside this server", { job: job.name, err: err.message });
      return null;
    }
  }
  state(job) {
    if (job.remote) return this.remote.state(job);
    return readRunnerState(this.home, job.id);
  }
  alive(job, state) {
    if (job.remote) return this.remote.alive(job);
    if (!state) {
      const host = job.host;
      return Boolean(host) && (host.pid !== null ? pidAlive(host.pid) : Date.now() - host.startedAt < START_GRACE_MS);
    }
    return pidAlive(state.pid);
  }
  send(job, control) {
    if (job.remote) return this.remote.send(job, control);
    const to = this.state(job)?.peer ?? job.host?.peer ?? job.name;
    this.node.send({ to, body: JSON.stringify(control), conversationId: `${CONTROL_CONVERSATION_PREFIX}${job.id}` }, { quiet: true }).catch((err) => this.log.warn("could not reach the job runner", { job: job.name, control: control.type, err: err.message }));
  }
  kill(job) {
    if (job.remote) return this.remote.send(job, { type: "cancel" });
    const pid = this.state(job)?.pid ?? job.host?.pid;
    if (pid) killPid(pid, this.log);
  }
};

export {
  readWorktreeState,
  recordWorktreeProcessProof,
  invalidateWorktreePathProof,
  worktreeLease,
  recordWorktreeOrigin,
  closeJobWorktree,
  prepareWorktreeContinuation,
  RUNNERS_DIR_NAME,
  JOB_PEER_PREFIX,
  CONTROL_CONVERSATION_PREFIX,
  RUNNER_HEARTBEAT_MS,
  readRunnerState,
  writeRunnerState,
  JobRunners
};
