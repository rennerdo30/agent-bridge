import { join } from "node:path";
import { readJsonStore, writeJsonStore } from "../core/json-store.js";
import type { BridgeNode } from "../core/node.js";
import type { Logger } from "../core/logger.js";
import type { CodingAgent } from "../core/protocol.js";
import type { RemoteJobSnapshot } from "../network/remote-jobs.js";
import { REMOTE_JOB_POLL_MS, remoteSpawnArgsSchema, type RemoteJobRequest } from "../network/remote-job-protocol.js";
import type { DelegateArgs } from "./delegate-run.js";
import type { Job, JobHostInfo, RunnerControl, RunnerState } from "./jobs.js";

interface Cached { fetchedAt: number; snapshot: RemoteJobSnapshot }

/** Runner facade on the requesting PC. A remote PID is metadata, never a local process handle. */
export class RemoteJobHost {
  private readonly busy = new Set<string>();
  private readonly cache = new Map<string, Cached>();
  /** The turn each job's pause was sent for (job id -> "id:startedAt"). */
  private readonly pauseSent = new Map<string, string>();
  constructor(private readonly node: BridgeNode, private readonly home: string, private readonly log: Logger) {}
  private path(job: Job): string { return join(this.home, "remote-job-states", `${job.id}.json`); }
  private read(job: Job): Cached | null {
    return this.cache.get(job.id) ?? readJsonStore(this.path(job)) as Cached | null;
  }
  private save(job: Job, snapshot: RemoteJobSnapshot): void {
    if (snapshot.state) {
      const current = snapshot.usageTurn === `${job.id}:${job.startedAt}`;
      snapshot = { ...snapshot, state: { ...snapshot.state,
        providerUsage: current && snapshot.state.providerUsage ? { ...snapshot.state.providerUsage, runId: job.usageRunId, turnStartedAt: job.startedAt } : undefined,
        usageSubmission: current && snapshot.state.usageSubmission ? { ...snapshot.state.usageSubmission, runId: job.usageRunId, turnStartedAt: job.startedAt } : undefined } };
    }
    // The turn ended (or its runner is gone): its pause bookkeeping is no longer needed.
    if (!snapshot.alive || snapshot.state && snapshot.state.status !== "running" && snapshot.state.status !== "paused") this.pauseSent.delete(job.id);
    const data = { fetchedAt: Date.now(), snapshot };
    this.cache.set(job.id, data);
    writeJsonStore(this.path(job), data, readJsonStore(this.path(job)));
  }
  start(job: Job, host: string, target: CodingAgent, args: DelegateArgs): JobHostInfo {
    job.remote = { host, name: `${target}-job-${job.id}` };
    this.cache.delete(job.id);
    this.pauseSent.delete(job.id);
    this.save(job, { state: null, alive: true, approvals: [] });
    // Internal continuation fields belong to the remote registry; only public spawn args cross the link.
    const raw = { ...args, cwd: args.cwd ?? job.workdir } as Record<string, unknown>;
    for (const key of ["host", "_job", "_worktree", "send_to"]) delete raw[key];
    const request = { op: "spawn", job: job.id, target, args: remoteSpawnArgsSchema.parse(raw), usageTurn: `${job.id}:${job.startedAt}`, usageControls: job.usagePendingControls } as const;
    this.busy.add(job.id);
    void this.node.remoteJob(host, request).then((snapshot) => {
      this.save(job, snapshot);
      if (job.pausePending) this.send(job, { type: "pause", reason: job.pauseReason });
      else if (job.controller.signal.aborted) this.send(job, { type: "cancel" });
    }, (err) => {
      this.save(job, { state: { pid: 0, peer: `${host}/${job.name}`, status: "failed", updatedAt: Date.now(), report: `Remote job failed: ${(err as Error).message}`, delivered: false }, alive: false, approvals: [] });
    }).finally(() => this.busy.delete(job.id));
    return { pid: null, peer: `${host}/${job.name}`, startedAt: Date.now() };
  }
  state(job: Job): RunnerState | null {
    const cached = this.read(job);
    if (!this.busy.has(job.id) && (!cached || Date.now() - cached.fetchedAt >= REMOTE_JOB_POLL_MS)) this.sendRequest(job, { op: "state", job: job.id });
    return cached?.snapshot.state ?? null;
  }
  alive(job: Job): boolean {
    const cached = this.read(job);
    // Lost observations do not prove runner loss. In this boolean facade, unknown must
    // keep the job hosted until a remote snapshot supplies positive evidence of death.
    return cached?.snapshot.alive ?? true;
  }
  send(job: Job, control: RunnerControl): void {
    // One pause per turn reaches the remote runner; repeated polls or retries never resend it (AB-398).
    if (control.type === "pause") {
      const turn = `${job.id}:${job.startedAt}`;
      if (this.pauseSent.get(job.id) === turn) return;
      this.pauseSent.set(job.id, turn);
    }
    this.sendRequest(job, { op: "control", job: job.id, control });
  }
  private sendRequest(job: Job, request: RemoteJobRequest): void {
    if (!job.remote) return;
    if (request.op === "state") this.busy.add(job.id);
    void this.node.remoteJob(job.remote.host, request).then((snapshot) => this.save(job, snapshot), (err) => {
      this.log.warn("remote job request failed", { job: job.name, host: job.remote?.host, operation: request.op, err: (err as Error).message });
    }).finally(() => { if (request.op === "state") this.busy.delete(job.id); });
  }
}
