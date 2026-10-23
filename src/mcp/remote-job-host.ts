import { createHash } from "node:crypto";
import { join } from "node:path";
import { metadataDb } from "../core/metadata-db.js";
import { writeJsonStore } from "../core/json-store.js";
import { readRemoteOperationEvidence, type RemoteOperationCache as Cached } from "../core/remote-operation-evidence.js";
import type { BridgeNode } from "../core/node.js";
import type { Logger } from "../core/logger.js";
import type { CodingAgent } from "../core/protocol.js";
import type { RemoteJobSnapshot } from "../network/remote-jobs.js";
import { REMOTE_JOB_POLL_MS, remoteSpawnArgsSchema, unsupportedRunnerLedger, type RemoteJobRequest } from "../network/remote-job-protocol.js";
import type { DelegateArgs } from "./delegate-run.js";
import type { Job, JobHostInfo, RunnerControl, RunnerState } from "./jobs.js";


/** Runner facade on the requesting PC. A remote PID is metadata, never a local process handle. */
export class RemoteJobHost {
  private readonly busy = new Set<string>();
  /** The turn each job's pause was sent for (job id -> "id:startedAt"). */
  private readonly pauseSent = new Map<string, string>();
  constructor(private readonly node: BridgeNode, private readonly home: string, private readonly log: Logger) {}
  private path(job: Job): string { return join(this.home, "remote-job-states", `${job.id}.json`); }
  private read(job: Job): Cached | null {
    return readRemoteOperationEvidence(this.home, job.id);
  }
  assertTurnAdmission(job: Job): void {
    if (this.blocked(job)) throw unsupportedRunnerLedger(true);
    // Restored remote jobs skip the local spec path. They still must prove the
    // current metadata writer contract before cache or remote effects.
    metadataDb(this.home);
  }
  private blocked(job: Job): boolean { return Boolean(this.read(job)?.operations?.some(op => op.state === "blocked" || op.state === "pending" && !this.busy.has(job.id))); }
  private write(job: Job, data: Cached): void {
    metadataDb(this.home);
    writeJsonStore(this.path(job), { ...data }, this.read(job));
  }
  private track(job: Job, request: RemoteJobRequest): string {
    const cached = this.read(job) ?? { fetchedAt: Date.now(), snapshot: { state: null, alive: true, approvals: [] } };
    const captured = JSON.parse(JSON.stringify(request)) as RemoteJobRequest;
    const id = createHash("sha256").update(JSON.stringify([job.id, job.startedAt, job.remote?.host, captured])).digest("hex");
    const operations = cached.operations ?? [];
    if (!operations.some(op => op.id === id)) {
      if (operations.length >= 128 || Buffer.byteLength(JSON.stringify([...operations, captured])) > 8 * 1024 * 1024)
        throw new Error("Remote operation evidence capacity reached; caller retains unaccepted input and owner recovery is required");
      this.write(job, { ...cached, operations: [...operations, { id, turn: job.startedAt, request: captured, state: "pending" }] });
    }
    return id;
  }
  private block(job: Job, id: string): void {
    const cached = this.read(job)!;
    this.write(job, { ...cached, snapshot: { ...cached.snapshot, alive: true }, operations: cached.operations?.map(op => op.id === id ? { ...op, state: "blocked" } : op) });
    job.progress = "Remote runner-ledger contract unconfirmed; original operation retained for owner-coordinated recovery";
  }
  private unsupported(error: unknown): boolean {
    const failure = error as {code?: string; details?: {runnerLedgerUnsupported?: boolean; remoteExecutionUnconfirmed?: boolean}};
    return failure?.code === "protocol_mismatch" || failure?.details?.runnerLedgerUnsupported === true || failure?.details?.remoteExecutionUnconfirmed === true;
  }
  private save(job: Job, snapshot: RemoteJobSnapshot, completed?: string, refused = false): void {
    if (snapshot.state) {
      const current = snapshot.usageTurn === `${job.id}:${job.startedAt}`;
      snapshot = { ...snapshot, state: { ...snapshot.state,
        providerUsage: current && snapshot.state.providerUsage ? { ...snapshot.state.providerUsage, runId: job.usageRunId, turnStartedAt: job.startedAt } : undefined,
        usageSubmission: current && snapshot.state.usageSubmission ? { ...snapshot.state.usageSubmission, runId: job.usageRunId, turnStartedAt: job.startedAt } : undefined } };
    }
    // The turn ended (or its runner is gone): its pause bookkeeping is no longer needed.
    if (!snapshot.alive || snapshot.state && snapshot.state.status !== "running" && snapshot.state.status !== "paused") this.pauseSent.delete(job.id);
    const operations = this.read(job)?.operations?.map(op => op.id === completed ? { ...op, state: refused ? "refused" as const : "confirmed" as const } : op) ?? [];
    this.write(job, { fetchedAt: Date.now(), snapshot, operations });
  }
  start(job: Job, host: string, target: CodingAgent, args: DelegateArgs): JobHostInfo {
    if (this.blocked(job)) throw new Error("Original remote operation remains unconfirmed; owner-coordinated recovery is required before another spawn/continuation");
    this.assertTurnAdmission(job);
    job.remote = { host, name: `${target}-job-${job.id}` };
    this.pauseSent.delete(job.id);
    this.save(job, { state: null, alive: true, approvals: [] });
    // Internal continuation fields belong to the remote registry; only public spawn args cross the link.
    const raw = { ...args, cwd: args.cwd ?? job.workdir } as Record<string, unknown>;
    for (const key of ["host", "_job", "_worktree", "send_to"]) delete raw[key];
    const request = { op: "spawn", job: job.id, target, args: remoteSpawnArgsSchema.parse(raw), usageTurn: `${job.id}:${job.startedAt}`, usageControls: job.usagePendingControls } as const;
    const operation = this.track(job, request);
    this.busy.add(job.id);
    void this.node.remoteJob(host, request).then((snapshot) => {
      this.save(job, snapshot, operation);
      if (job.pausePending) this.send(job, { type: "pause", reason: job.pauseReason });
      else if (job.controller.signal.aborted) this.send(job, { type: "cancel" });
    }, (err) => {
      if (this.unsupported(err)) { this.block(job, operation); return; }
      this.save(job, { state: { pid: 0, peer: `${host}/${job.name}`, status: "failed", updatedAt: Date.now(), report: `Remote job failed: ${(err as Error).message}`, delivered: false }, alive: false, approvals: [] }, operation, true);
    }).finally(() => this.busy.delete(job.id)).catch(() => { job.progress = "Remote operation evidence remains unsettled; original request retained"; });
    return { pid: null, peer: `${host}/${job.name}`, startedAt: Date.now() };
  }
  state(job: Job): RunnerState | null {
    const cached = this.read(job);
    if (this.blocked(job)) job.progress = "Remote operation remains unconfirmed; original request retained for owner-coordinated recovery";
    if (!this.blocked(job) && !this.busy.has(job.id) && (!cached || Date.now() - cached.fetchedAt >= REMOTE_JOB_POLL_MS)) this.sendRequest(job, { op: "state", job: job.id });
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
    const wasBlocked = this.blocked(job);
    const operation = request.op === "state" ? undefined : this.track(job, request);
    if (wasBlocked) { if (operation) this.block(job, operation); return; }
    if (request.op === "state") this.busy.add(job.id);
    void this.node.remoteJob(job.remote.host, request).then((snapshot) => this.save(job, snapshot, operation), (err) => {
      if (this.unsupported(err)) {
        const identity = operation ?? this.track(job, request); this.block(job, identity);
        this.log.warn("remote runner-ledger compatibility lost; operations retained", { operation: request.op }); return;
      }
      this.log.warn("remote job request failed", { job: job.name, host: job.remote?.host, operation: request.op, err: (err as Error).message });
    }).finally(() => { if (request.op === "state") this.busy.delete(job.id); }).catch(() => { job.progress = "Remote operation evidence remains unsettled; original request retained"; });
  }
}
