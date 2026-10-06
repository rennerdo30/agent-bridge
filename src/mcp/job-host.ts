import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "../core/config.js";
import { killPid, pidAlive } from "../core/delegate.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import type { AgentKind, CodingAgent } from "../core/protocol.js";
import type { DelegateArgs } from "./delegate-run.js";
import type { Job, JobHost, JobHostInfo, RunnerControl, RunnerState } from "./jobs.js";
import { archiveFile, assertWritableStore, isRecord, mergeStoreFields, readJsonStore, retentionLimit, writeJsonStore } from "../core/json-store.js";

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
/** A runner writes its state at least this often; one that stopped writing for STALE_MS is gone. */
export const RUNNER_HEARTBEAT_MS = 15_000;
const STALE_MS = 6 * RUNNER_HEARTBEAT_MS;
/** How long a starting runner may take to report in. */
const START_GRACE_MS = 30_000;
/** Runner files of jobs that ended long ago are archived. Zero disables the limit. */
const KEEP_FILES_MS = 7 * 24 * 60 * 60 * 1000;
/** Windows: a short-lived launcher keeps the runner out of the session's process tree. */
const DETACH_LAUNCHER = "require('node:child_process').spawn(process.execPath,process.argv.slice(1),{detached:true,stdio:'ignore',windowsHide:true}).unref()";

/** Everything a runner needs to run one job (written by the server next to the state file). */
export interface RunnerSpec {
  home: string;
  target: CodingAgent;
  /** This turn's arguments, and the job's original ones (follow-ups within the runner continue from them). */
  args: DelegateArgs;
  base: DelegateArgs;
  job: Pick<Job, "id" | "name" | "agent" | "model" | "prompt" | "startedAt" | "args" | "sessionId" | "workdir" | "worktree" | "owner"> & { allowedServers: string[] };
  /** Peer name of the session (it may change; the session's control messages carry the current one). */
  owner: string;
  byAgent: AgentKind;
  /** The session's project folder: the default working directory. */
  cwd: string;
  /** The session's settings when the turn started. */
  cfg: BridgeConfig;
}

export function runnerStatePath(home: string, id: string): string {
  return join(home, RUNNERS_DIR_NAME, `${id}.json`);
}

function specPath(home: string, id: string): string {
  return join(home, RUNNERS_DIR_NAME, `${id}.spec.json`);
}

export function readRunnerState(home: string, id: string): RunnerState | null {
  try {
    const s = readJsonStore(runnerStatePath(home, id), undefined, (value) => isRecord(value) && typeof value.pid === "number" && typeof value.status === "string") as RunnerState | null;
    return s && typeof s.pid === "number" && typeof s.status === "string" ? s : null;
  } catch {
    return null;
  }
}

/** Atomic, so the server never reads half a file. */
export function writeRunnerState(home: string, id: string, state: RunnerState): void {
  const path = runnerStatePath(home, id);
  const previous = readJsonStore(path);
  writeJsonStore(path, mergeStoreFields(isRecord(previous) ? previous : {}, { ...state }), previous);
}

/** The session's side: starts runners and talks to them. */
export class JobRunners implements JobHost {
  constructor(
    private readonly node: BridgeNode,
    private readonly home: string,
    /** The bundled CLI (dist/cli.mjs) that runs `job-runner`. */
    private readonly cli: string,
    private readonly log: Logger,
  ) {
    try {
      const dir = join(home, RUNNERS_DIR_NAME);
      const keepMs = retentionLimit("AGENT_BRIDGE_RUNNER_KEEP_MS", KEEP_FILES_MS);
      if (!keepMs) return;
      for (const f of readdirSync(dir)) {
        const path = join(dir, f);
        if (!f.endsWith(".json") || f.endsWith(".spec.json") || Date.now() - statSync(path).mtimeMs <= keepMs) continue;
        const id = f.replace(/\.json$/, "");
        const state = readRunnerState(home, id);
        if (state?.status === "done" || state?.status === "failed") {
          archiveFile(path);
          archiveFile(specPath(home, id));
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.log.warn("could not archive runner files", { err: String(err) });
    }
  }

  /** Start a turn of this job in a new runner; null when that is not possible (the turn then runs in the server). */
  start(job: Job, spec: Omit<RunnerSpec, "home" | "job">): JobHostInfo | null {
    try {
      mkdirSync(join(this.home, RUNNERS_DIR_NAME), { recursive: true });
      // An earlier turn's final state must not count for this one.
      const statePath = runnerStatePath(this.home, job.id);
      const file = specPath(this.home, job.id);
      assertWritableStore(readJsonStore(statePath, this.log));
      assertWritableStore(readJsonStore(file, this.log));
      archiveFile(statePath);
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
          allowedServers: [...(job.allowedServers ?? [])],
        },
      };
      archiveFile(file);
      writeJsonStore(file, { ...full }, null);
      const args = [this.cli, "job-runner", file];
      let pid: number | null = null;
      if (process.platform === "win32") {
        const launcher = spawn(process.execPath, ["-e", DETACH_LAUNCHER, ...args], { stdio: "ignore", windowsHide: true });
        launcher.on("error", (err) => this.log.warn("could not start a job runner", { job: job.name, err: err.message }));
      } else {
        const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
        child.on("error", (err) => this.log.warn("could not start a job runner", { job: job.name, err: err.message }));
        child.unref();
        pid = child.pid ?? null;
      }
      this.log.info("job runner started", { job: job.name, pid });
      return { pid, peer: job.name, startedAt: Date.now() };
    } catch (err) {
      this.log.warn("job runner unavailable; the subagent runs inside this server", { job: job.name, err: (err as Error).message });
      return null;
    }
  }

  state(job: Job): RunnerState | null {
    return readRunnerState(this.home, job.id);
  }

  alive(job: Job, state: RunnerState | null): boolean {
    if (!state) {
      // Not reported in yet: still starting, for a while.
      const host = job.host;
      return Boolean(host) && Date.now() - host!.startedAt < START_GRACE_MS && (host!.pid === null || pidAlive(host!.pid));
    }
    return pidAlive(state.pid) && Date.now() - state.updatedAt < STALE_MS;
  }

  send(job: Job, control: RunnerControl): void {
    const to = this.state(job)?.peer ?? job.host?.peer ?? job.name;
    // Not a conversation of this session's agent: no listen window, no awaited reply.
    this.node
      .send({ to, body: JSON.stringify(control), conversationId: `${CONTROL_CONVERSATION_PREFIX}${job.id}` }, { quiet: true })
      .catch((err) => this.log.warn("could not reach the job runner", { job: job.name, control: control.type, err: (err as Error).message }));
  }

  kill(job: Job): void {
    const pid = this.state(job)?.pid ?? job.host?.pid;
    if (pid) killPid(pid);
  }
}
