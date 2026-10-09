import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "../core/config.js";
import { killPid, pidAlive } from "../core/delegate.js";
import { identityStartedAfter, processIdentity } from "../core/process-identity.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import type { AgentKind, CodingAgent } from "../core/protocol.js";
import type { DelegateArgs } from "./delegate-run.js";
import type { Job, JobHost, JobHostInfo, RunnerControl, RunnerState } from "./jobs.js";
import { archiveFile, assertWritableStore, readJsonStore, retentionLimit } from "../core/json-store.js";
import { existingMetadataDb } from "../core/metadata-db.js";
import { legacyRunnerPeers, publishRunnerSpec, readRunnerStateRecord, runnerFilesImported, runnerSpecPath, runnerStatePath as storeStatePath, writeRunnerStateRecord } from "../core/runner-store.js";
import { RemoteJobHost } from "./remote-job-host.js";
import { jobEnvironment } from "../core/job-environment.js";
import { setTimeout as delay } from "node:timers/promises";
import { assertStoreUpgrade, refreshStorePeerIdentities } from "../core/store-compatibility.js";
import { JSON_STORE_VERSION } from "../core/json-store.js";
import type { HostedAdmission } from "./jobs.js";

/**
 * Job runners: a background subagent runs in a detached process of its own (`agent-bridge job-runner`), not
 * inside the session's MCP server. Claude Code restarts that server on /reload-plugins (and with the session);
 * the runner, and the subagent it runs, keep going. The runner joins the bridge as a hidden peer named after
 * the job: its result, answers and approval questions reach the session as messages from the job (they wait
 * in the store while no server of the session is there), and it gets the session's messages for the subagent
 * as control messages. What the session needs to know about it (progress, its session, its end) is in a
 * small state file only the runner writes. The next server of the session finds it there and takes it over.
 */
export const RUNNERS_DIR_NAME = "jobs";
/** A runner's peer id: messages from it look like those of a job run inside the server (see JobManager.post). */
export const JOB_PEER_PREFIX = "job:";
/** Conversation of the session's control messages to a runner, so they are told apart from chat. */
export const CONTROL_CONVERSATION_PREFIX = "jobctl-";
/** A runner writes its state at least this often; heartbeat delay alone never proves process exit. */
export const RUNNER_HEARTBEAT_MS = 15_000;
/** How long a starting runner may take to report in. */
const START_GRACE_MS = 30_000;
/** Runner files of jobs that ended long ago are archived. Zero disables the limit. */
const KEEP_FILES_MS = 7 * 24 * 60 * 60 * 1000;
/** Windows: a short-lived launcher keeps the runner out of the session's process tree. */
const DETACH_LAUNCHER = "const c=require('node:child_process').spawn(process.execPath,process.argv.slice(1),{detached:true,stdio:'ignore',windowsHide:true});c.on('error',()=>process.exit(1));if(c.pid)process.stdout.write(String(c.pid));c.unref()";

/** Everything a runner needs to run one job (written by the server next to the state file). */
export interface RunnerSpec {
  home: string;
  target: CodingAgent;
  /** This turn's arguments, and the job's original ones (follow-ups within the runner continue from them). */
  args: DelegateArgs;
  base: DelegateArgs;
  job: Pick<Job, "id" | "name" | "agent" | "model" | "prompt" | "startedAt" | "args" | "sessionId" | "workdir" | "worktree" | "owner" | "supervisor" | "metadataVersion" | "parentJob" | "rootSession" | "rootName"> & { allowedServers: string[] };
  /** Peer name of the session (it may change; the session's control messages carry the current one). */
  owner: string;
  byAgent: AgentKind;
  /** The session's project folder: the default working directory. */
  cwd: string;
  /** The session's settings when the turn started. */
  cfg: BridgeConfig;
}

export function runnerStatePath(home: string, id: string): string {
  return storeStatePath(home, id);
}

function specPath(home: string, id: string): string {
  return runnerSpecPath(home, id);
}

/** Rows in bridge.db (AB-208); the per-job file only while older processes or unimported files remain. */
export function readRunnerState(home: string, id: string): RunnerState | null {
  try {
    const s = readRunnerStateRecord(home, id) as RunnerState | null;
    return s && typeof s.pid === "number" && typeof s.status === "string" ? s : null;
  } catch {
    return null;
  }
}

/** Atomic (one SQLite transaction), so the server never reads half a state. */
export function writeRunnerState(home: string, id: string, state: RunnerState): void {
  // The runner's own creation identity: its PID alone may be reused once it is gone (AB-236).
  const identity = state.identity ?? (state.pid === process.pid ? processIdentity(process.pid) : undefined);
  writeRunnerStateRecord(home, id, { ...state, ...(identity ? { identity } : {}) });
}

/** How long a probed identity of a live runner PID is reused by the frequent liveness checks. */
const IDENTITY_CACHE_MS = 30_000;
const probed = new Map<number, { identity: string | undefined; at: number }>();

/**
 * Whether the process a runner state names is still that runner: no PID reuse (AB-236). With a recorded identity
 * it must match; older states without one need a process that started before the runner's last heartbeat.
 * Unknown answers keep the conservative "alive" (takeover); `fresh` probes again (kill decisions).
 */
export function runnerProcessAlive(state: Pick<RunnerState, "pid" | "identity" | "updatedAt">, fresh = false): boolean {
  if (!pidAlive(state.pid)) return false;
  let entry = probed.get(state.pid);
  if (fresh || !entry || Date.now() - entry.at >= IDENTITY_CACHE_MS) probed.set(state.pid, entry = { identity: processIdentity(state.pid), at: Date.now() });
  if (entry.identity === undefined) return !fresh;
  if (state.identity) return entry.identity === state.identity;
  return !Number.isFinite(state.updatedAt) || !identityStartedAfter(entry.identity, state.updatedAt + 1_000);
}

/** The session's side: starts runners and talks to them. */
export class JobRunners implements JobHost {
  private readonly remote: RemoteJobHost;
  constructor(
    private readonly node: BridgeNode,
    private readonly home: string,
    /** The bundled CLI (dist/cli.mjs) that runs `job-runner`. */
    private readonly cli: string,
    private readonly log: Logger,
  ) {
    this.remote = new RemoteJobHost(node, home, log);
    try {
      const dir = join(home, RUNNERS_DIR_NAME);
      const keepMs = retentionLimit("AGENT_BRIDGE_RUNNER_KEEP_MS", KEEP_FILES_MS);
      if (!keepMs) return;
      // Imported runner files live in rows and cold storage; only older processes still write files here.
      if (existingMetadataDb(home) && runnerFilesImported(home) && !legacyRunnerPeers(home)) return;
      for (const f of readdirSync(dir)) {
        const path = join(dir, f);
        if (!f.endsWith(".json") || f.endsWith(".spec.json") || Date.now() - statSync(path).mtimeMs <= keepMs) continue;
        const id = f.replace(/\.json$/, "");
        const state = readRunnerState(home, id);
        if (state?.status === "done" || state?.status === "failed" || state?.status === "cancelled") {
          archiveFile(path);
          archiveFile(specPath(home, id));
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.log.warn("could not archive runner files", { err: String(err) });
    }
  }

  /** Start a turn of this job in a new runner; null when that is not possible (the turn then runs in the server). */
  async startAsync(job: Job, spec: Omit<RunnerSpec, "home" | "job">, admission?: HostedAdmission): Promise<JobHostInfo | null> {
    const signal = admission?.signal ?? job.controller.signal;
    let attempts = 0;
    for (;;) {
      signal.throwIfAborted();
      await refreshStorePeerIdentities(this.home, signal);
      signal.throwIfAborted();
      if (admission && !admission.isCurrent()) throw new Error("Detached job startup lost its supervisor authority before launch");
      try { return this.start(job, spec); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "STORE_UPGRADE_DEFERRED") throw error;
        job.progress = `queued: ${(error as Error).message}`;
        if (attempts++ % 30 === 0) this.log.info("job runner start waits for retained store readers", { job: job.name, reason: String(error) });
        await delay(Math.min(1_000, attempts * 100), undefined, { signal });
      }
    }
  }

  start(job: Job, spec: Omit<RunnerSpec, "home" | "job">): JobHostInfo | null {
    if (spec.args.host) return this.remote.start(job, spec.args.host, spec.target, spec.args);
    try {
      mkdirSync(join(this.home, RUNNERS_DIR_NAME), { recursive: true });
      // An earlier turn's final state must not count for this one.
      const statePath = runnerStatePath(this.home, job.id);
      const file = specPath(this.home, job.id);
      assertWritableStore(readJsonStore(statePath, this.log));
      assertWritableStore(readJsonStore(file, this.log));
      // Check before archiving a previous turn. Unknown readers wait in the
      // asynchronous admission path, leaving every existing file in place.
      assertStoreUpgrade(this.home, "json", 0, JSON_STORE_VERSION);
      const full: RunnerSpec = {
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
          allowedServers: [...(job.allowedServers ?? [])],
        },
      };
      // Archives the previous turn's state and spec (rows, and files of older processes), then publishes this one.
      const args = [this.cli, "job-runner", publishRunnerSpec(this.home, job.id, { ...full })];
      const info: JobHostInfo = { pid: null, peer: job.name, startedAt: Date.now() };
      let pid: number | null = null;
      if (process.platform === "win32") {
        const launcher = spawn(process.execPath, ["-e", DETACH_LAUNCHER, ...args], { env: jobEnvironment(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        let output = "";
        launcher.stdout!.on("data", chunk => { output += chunk; });
        launcher.on("close", () => { const reported = Number(output); if (Number.isSafeInteger(reported) && reported > 0) info.pid = reported; });
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
      if ((err as NodeJS.ErrnoException).code === "STORE_UPGRADE_DEFERRED") throw err;
      this.log.warn("job runner unavailable; the subagent runs inside this server", { job: job.name, err: (err as Error).message });
      return null;
    }
  }

  state(job: Job): RunnerState | null {
    if (job.remote) return this.remote.state(job);
    return readRunnerState(this.home, job.id);
  }

  alive(job: Job, state: RunnerState | null): boolean {
    if (job.remote) return this.remote.alive(job);
    if (!state) {
      // Not reported in yet: still starting, for a while.
      const host = job.host;
      return Boolean(host) && (host!.pid !== null ? pidAlive(host!.pid) : Date.now() - host!.startedAt < START_GRACE_MS);
    }
    return runnerProcessAlive(state);
  }

  send(job: Job, control: RunnerControl): void {
    if (job.remote) return this.remote.send(job, control);
    const to = this.state(job)?.peer ?? job.host?.peer ?? job.name;
    // Not a conversation of this session's agent: no listen window, no awaited reply.
    this.node
      .send({ to, body: JSON.stringify(control), conversationId: `${CONTROL_CONVERSATION_PREFIX}${job.id}` }, { quiet: true })
      .catch((err) => this.log.warn("could not reach the job runner", { job: job.name, control: control.type, err: (err as Error).message }));
  }

  kill(job: Job): void {
    if (job.remote) return this.remote.send(job, { type: "cancel" });
    const state = this.state(job);
    if (state) {
      // Never `taskkill /T /F` a process that merely reuses the runner's PID: verify it freshly first.
      if (runnerProcessAlive(state, true)) killPid(state.pid, this.log);
      else this.log.warn("job runner PID no longer belongs to the runner; not killing it", { job: job.name, pid: state.pid });
      return;
    }
    if (job.host?.pid) killPid(job.host.pid, this.log);
  }
}
