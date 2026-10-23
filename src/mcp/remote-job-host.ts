import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { metadataDb } from "../core/metadata-db.js";
import { writeJsonStore } from "../core/json-store.js";
import { readRemoteOperationEvidence, type PendingRemoteOperation, type RemoteOperationCache as Cached } from "../core/remote-operation-evidence.js";
import type { BridgeNode } from "../core/node.js";
import type { Logger } from "../core/logger.js";
import type { CodingAgent } from "../core/protocol.js";
import type { RemoteJobSnapshot } from "../network/remote-jobs.js";
import { REMOTE_JOB_POLL_MS, remoteJobRequestSchema, remoteJobSnapshotSchema, remoteSpawnArgsSchema, unsupportedRunnerLedger, type RemoteJobRequest } from "../network/remote-job-protocol.js";
import type { DelegateArgs } from "./delegate-run.js";
import type { Job, JobHostInfo, RunnerControl, RunnerState } from "./jobs.js";
import { RunnerRetentionUnsettled } from "./runner-delivery-retention.js";
import { deliveryFailure } from "./delivery-evidence.js";

interface LiveOperation {
  id: string; job: Job; controller: AbortController; context: string; host: string;
  request: RemoteJobRequest; sequence: number; record?: string;
}
const recordKey = (op: PendingRemoteOperation) => JSON.stringify([op.id, op.turn, op.request]);

/** Runner facade on the requesting PC. A remote PID is metadata, never a local process handle. */
export class RemoteJobHost {
  private readonly live = new Map<string, LiveOperation>();
  private readonly observed = new WeakMap<Job, { context: string; sequence: number }>();
  private sequence = 0;
  /** The turn each job's pause was sent for (job id -> "id:startedAt"). */
  private readonly pauseSent = new Map<string, string>();
  constructor(private readonly node: BridgeNode, private readonly home: string, private readonly log: Logger) {}
  private path(job: Job): string { return join(this.home, "remote-job-states", `${job.id}.json`); }
  private read(job: Job): Cached | null {
    return readRemoteOperationEvidence(this.home, job.id);
  }
  assertTurnAdmission(job: Job): void {
    if (this.blocked(job) || this.hasLive(job, true)) throw unsupportedRunnerLedger(true);
    // Restored remote jobs skip the local spec path. They still must prove the
    // current metadata writer contract before cache or remote effects.
    metadataDb(this.home);
  }
  private context(job: Job): string {
    return JSON.stringify([job.id, job.name, job.agent, job.startedAt, job.owner, job.supervisor, job.parentJob, job.rootSession,
      job.remote?.host, job.remote?.name]);
  }
  private current(op: LiveOperation): boolean {
    return this.live.get(op.id) === op && op.controller === op.job.controller && op.context === this.context(op.job);
  }
  private hasLive(job: Job, mutatingOnly = false): boolean {
    return [...this.live.values()].some(op => op.job === job && this.current(op) && (!mutatingOnly || op.request.op !== "state"));
  }
  private blocked(job: Job): boolean {
    return Boolean(this.read(job)?.operations?.some(op => {
      const live = this.live.get(op.id);
      return op.state === "blocked" || op.state === "pending" &&
        (!live || live.job !== job || !this.current(live) || live.record !== recordKey(op));
    }));
  }
  private write(job: Job, data: Cached): void {
    metadataDb(this.home);
    writeJsonStore(this.path(job), { ...data }, this.read(job));
  }
  private track(job: Job, request: RemoteJobRequest): string {
    const cached = this.read(job) ?? { fetchedAt: Date.now(), snapshot: { state: null, alive: true, approvals: [] } };
    const captured = remoteJobRequestSchema.parse(JSON.parse(JSON.stringify(request)));
    let id = createHash("sha256").update(JSON.stringify([job.id, job.startedAt, job.remote?.host, captured])).digest("hex");
    const operations = cached.operations ?? [];
    const same = operations.filter(op => op.turn === job.startedAt && JSON.stringify(op.request) === JSON.stringify(captured)).at(-1);
    if (captured.op === "control" && captured.control.type === "message") {
      const cid = captured.control.cid;
      const original = operations.find(op => op.turn === job.startedAt && op.request.op === "control" && op.request.control.type === "message" && op.request.control.cid === cid);
      if (original && JSON.stringify(original.request) !== JSON.stringify(captured)) throw new RunnerRetentionUnsettled("invalid-evidence");
      if (original) return original.id;
    }
    if (same && (same.state === "pending" || same.state === "blocked")) return same.id;
    // Repeated explicit non-CID controls (for example pause after a terminal
    // observation) are new operations. Keep the earlier confirmed proof intact.
    if (same) id = createHash("sha256").update(JSON.stringify([id, randomUUID()])).digest("hex");
    if (!operations.some(op => op.id === id)) {
      if (operations.length >= 128 || Buffer.byteLength(JSON.stringify([...operations, captured])) > 8 * 1024 * 1024)
        throw new Error("Remote operation evidence capacity reached; caller retains unaccepted input and owner recovery is required");
      this.write(job, { ...cached, operations: [...operations, { id, turn: job.startedAt, request: captured, state: "pending" }] });
    }
    return id;
  }
  private block(job: Job, id: string): void {
    const cached = this.read(job)!;
    this.write(job, { ...cached, snapshot: { ...cached.snapshot, alive: true }, operations: cached.operations?.map(op => op.id === id && op.state === "pending" ? { ...op, state: "blocked" } : op) });
    job.progress = "Remote runner-ledger contract unconfirmed; original operation retained for owner-coordinated recovery";
  }
  private unsupported(error: unknown): boolean {
    const failure = error as {code?: string; details?: {runnerLedgerUnsupported?: boolean; remoteExecutionUnconfirmed?: boolean}};
    return failure?.code === "protocol_mismatch" || failure?.details?.runnerLedgerUnsupported === true || failure?.details?.remoteExecutionUnconfirmed === true;
  }
  private save(job: Job, snapshot: RemoteJobSnapshot, completed?: LiveOperation): void {
    snapshot = remoteJobSnapshotSchema.parse(snapshot);
    if (completed && !this.current(completed)) throw new RunnerRetentionUnsettled("invalid-evidence");
    const cached = this.read(job), operations = cached?.operations ?? [];
    if (completed?.record && !operations.some(op => op.state === "pending" && recordKey(op) === completed.record)) throw new RunnerRetentionUnsettled("invalid-evidence");
    if (snapshot.state) {
      const current = snapshot.usageTurn === `${job.id}:${job.startedAt}`;
      snapshot = { ...snapshot, state: { ...snapshot.state,
        providerUsage: current && snapshot.state.providerUsage ? { ...snapshot.state.providerUsage, runId: job.usageRunId, turnStartedAt: job.startedAt } : undefined,
        usageSubmission: current && snapshot.state.usageSubmission ? { ...snapshot.state.usageSubmission, runId: job.usageRunId, turnStartedAt: job.startedAt } : undefined } };
    }
    const observed = this.observed.get(job);
    const terminal = (value: RemoteJobSnapshot) => !value.alive || value.state && ["done", "failed", "cancelled"].includes(value.state.status);
    const stale = completed && observed?.context === completed.context && cached &&
      (terminal(cached.snapshot) && !terminal(snapshot) || Boolean(terminal(cached.snapshot)) === Boolean(terminal(snapshot)) &&
        ((snapshot.state?.updatedAt ?? 0) < (cached.snapshot.state?.updatedAt ?? 0) ||
          (snapshot.state?.updatedAt ?? 0) === (cached.snapshot.state?.updatedAt ?? 0) && observed.sequence > completed.sequence));
    this.write(job, { fetchedAt: stale ? cached!.fetchedAt : Date.now(), snapshot: stale ? cached!.snapshot : snapshot,
      operations: operations.map(op => completed?.record === recordKey(op) ? { ...op, state: "confirmed" } : op) });
    if (!stale) {
      if (completed) this.observed.set(job, { context: completed.context, sequence: completed.sequence });
      if (!snapshot.alive || snapshot.state && snapshot.state.status !== "running" && snapshot.state.status !== "paused") this.pauseSent.delete(job.id);
    }
  }
  /** The token owns only this exact RPC, original job object/controller and
   * immutable context. Pending evidence without its token is NEVER live. */
  private dispatch(job: Job, request: RemoteJobRequest, operation?: string, after?: () => void): void {
    const host = job.remote!.host, captured = remoteJobRequestSchema.parse(JSON.parse(JSON.stringify(request)));
    const stored = operation ? this.read(job)!.operations!.find(op => op.id === operation)! : undefined;
    if (operation && !stored) throw new RunnerRetentionUnsettled("invalid-evidence");
    if (stored?.state === "confirmed") return; // A repeated message CID cannot execute again.
    if (stored && stored.state !== "pending") return;
    const id = operation ?? createHash("sha256").update(JSON.stringify([this.context(job), captured])).digest("hex");
    const prior = this.live.get(id);
    if (prior) {
      if (prior.job === job && this.current(prior) && prior.record === (stored && recordKey(stored))) return;
      throw new RunnerRetentionUnsettled("invalid-evidence");
    }
    const token: LiveOperation = { id, job, controller: job.controller, context: this.context(job), host, request: captured, sequence: ++this.sequence,
      ...(stored ? { record: recordKey(stored) } : {}) };
    this.live.set(id, token);
    let response: Promise<RemoteJobSnapshot>;
    try { response = this.node.remoteJob(host, JSON.parse(JSON.stringify(captured))); }
    catch (error) { response = Promise.reject(error); }
    void response.then(snapshot => { this.save(job, snapshot, token); after?.(); }, error => {
      if (!this.current(token)) throw new RunnerRetentionUnsettled("invalid-evidence");
      // A rejected mutating RPC cannot prove nonacceptance. Keep its exact
      // original bytes unknown; a read-only transient poll retains the last
      // authoritative observation and may be explicitly polled again.
      if (operation || this.unsupported(error)) this.block(job, operation ?? this.track(job, captured));
      this.log.warn("remote job request failed", { operation: captured.op, failure: deliveryFailure(error) });
    }).finally(() => {
      if (this.live.get(id) === token) this.live.delete(id);
    }).catch(() => { job.progress = "Remote operation evidence remains unsettled; original request retained"; });
  }
  start(job: Job, host: string, target: CodingAgent, args: DelegateArgs): JobHostInfo {
    // Validate the exact public request before changing the job/cache projection.
    const raw = { ...args, cwd: args.cwd ?? job.workdir } as Record<string, unknown>;
    for (const key of ["host", "_job", "_worktree", "send_to"]) delete raw[key];
    const request = { op: "spawn", job: job.id, target, args: remoteSpawnArgsSchema.parse(raw), usageTurn: `${job.id}:${job.startedAt}`, usageControls: job.usagePendingControls } as const;
    if (this.blocked(job)) throw new Error("Original remote operation remains unconfirmed; owner-coordinated recovery is required before another spawn/continuation");
    this.assertTurnAdmission(job);
    if (this.read(job)?.operations?.some(op => op.turn === job.startedAt && op.request.op === "spawn"))
      throw new Error("Original remote turn is already recorded; no automatic reexecution");
    job.remote = { host, name: `${target}-job-${job.id}` };
    this.pauseSent.delete(job.id);
    this.save(job, { state: null, alive: true, approvals: [] });
    const operation = this.track(job, request);
    this.dispatch(job, request, operation, () => {
      if (job.pausePending) this.send(job, { type: "pause", reason: job.pauseReason });
      else if (job.controller.signal.aborted) this.send(job, { type: "cancel" });
    });
    return { pid: null, peer: `${host}/${job.name}`, startedAt: Date.now() };
  }
  state(job: Job): RunnerState | null {
    const cached = this.read(job);
    const blocked = this.blocked(job);
    if (blocked) job.progress = "Remote operation remains unconfirmed; original request retained for owner-coordinated recovery";
    if (!blocked && !this.hasLive(job) && (!cached || Date.now() - cached.fetchedAt >= REMOTE_JOB_POLL_MS)) this.sendRequest(job, { op: "state", job: job.id });
    if (blocked && cached?.snapshot.state) return { ...cached.snapshot.state, status: "running", report: undefined, delivered: false };
    return cached?.snapshot.state ?? null;
  }
  alive(job: Job): boolean {
    const cached = this.read(job);
    // Lost observations do not prove runner loss. In this boolean facade, unknown must
    // keep the job hosted until a remote snapshot supplies positive evidence of death.
    return this.blocked(job) || (cached?.snapshot.alive ?? true);
  }
  send(job: Job, control: RunnerControl): void {
    // One pause per turn reaches the remote runner; repeated polls or retries never resend it (AB-398).
    if (control.type === "pause") {
      const turn = this.context(job);
      if (this.pauseSent.get(job.id) === turn) return;
    }
    this.sendRequest(job, { op: "control", job: job.id, control });
    if (control.type === "pause") this.pauseSent.set(job.id, this.context(job));
  }
  private sendRequest(job: Job, request: RemoteJobRequest): void {
    if (!job.remote) return;
    const wasBlocked = this.blocked(job);
    const operation = request.op === "state" ? undefined : this.track(job, request);
    if (wasBlocked) { if (operation) this.block(job, operation); return; }
    this.dispatch(job, request, operation);
  }
}
