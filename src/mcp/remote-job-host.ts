import { join } from "node:path";
import { readJsonStore, writeJsonStore } from "../core/json-store.js";
import type { BridgeNode } from "../core/node.js";
import type { Logger } from "../core/logger.js";
import type { CodingAgent } from "../core/protocol.js";
import type { RemoteJobSnapshot } from "../network/remote-jobs.js";
import { REMOTE_JOB_POLL_MS, remoteSpawnArgsSchema, type RemoteJobRequest } from "../network/remote-job-protocol.js";
import type { DelegateArgs } from "./delegate-run.js";
import type { Job, JobHostInfo, RunnerControl, RunnerState } from "./jobs.js";

const REMOTE_STATE_GRACE_MS = 90_000;
interface Cached { fetchedAt: number; snapshot: RemoteJobSnapshot }

/** Runner facade on the requesting PC. A remote PID is metadata, never a local process handle. */
export class RemoteJobHost {
  private readonly busy = new Set<string>();
  private readonly cache = new Map<string, Cached>();
  constructor(private readonly node: BridgeNode, private readonly home: string, private readonly log: Logger) {}
  private path(job: Job): string { return join(this.home, "remote-job-states", `${job.id}.json`); }
  private read(job: Job): Cached | null {
    return this.cache.get(job.id) ?? readJsonStore(this.path(job)) as Cached | null;
  }
  private save(job: Job, snapshot: RemoteJobSnapshot): void {
    const data = { fetchedAt: Date.now(), snapshot };
    this.cache.set(job.id, data);
    writeJsonStore(this.path(job), data, readJsonStore(this.path(job)));
  }
  start(job: Job, host: string, target: CodingAgent, args: DelegateArgs): JobHostInfo {
    job.remote = { host, name: `${target}-job-${job.id}` };
    this.cache.delete(job.id);
    this.save(job, { state: null, alive: true, approvals: [] });
    // Internal continuation fields belong to the remote registry; only public spawn args cross the link.
    const raw = { ...args, cwd: args.cwd ?? job.workdir } as Record<string, unknown>;
    for (const key of ["host", "_job", "_worktree", "send_to"]) delete raw[key];
    const request = { op: "spawn", job: job.id, target, args: remoteSpawnArgsSchema.parse(raw) } as const;
    this.busy.add(job.id);
    void this.node.remoteJob(host, request).then((snapshot) => {
      this.save(job, snapshot);
      if (job.controller.signal.aborted) this.send(job, { type: "cancel" });
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
    return cached ? cached.snapshot.alive && Date.now() - cached.fetchedAt < REMOTE_STATE_GRACE_MS : Date.now() - (job.host?.startedAt ?? 0) < REMOTE_STATE_GRACE_MS;
  }
  send(job: Job, control: RunnerControl): void {
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
