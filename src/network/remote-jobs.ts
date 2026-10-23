import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadConfig } from "../core/config.js";
import { markerSafe } from "../core/approval-display.js";
import { checkUsagePreflight, usageAdmissionText, usageSubmissionReceipt } from "../core/usage.js";
import { usageProbeFor } from "../mcp/targets.js";
import { REMOTE_RUNNER_LEDGER_CAPABILITY, unsupportedRunnerLedger, REMOTE_JOB_USAGE_CAPABILITY } from "./remote-job-protocol.js";
import { bundledCli } from "../core/delegate.js";
import { isRecord, JSON_STORE_VERSION, readJsonStore, writeJsonStore } from "../core/json-store.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import { BridgeError, type PeerInfo } from "../core/protocol.js";
import { mailboxSchema, recipientKey, type InternalMessageOrigin } from "../core/recipient-ownership.js";
import { answerPendingApproval, listPendingApprovals, publishApproval, type PendingApproval } from "../core/relay.js";
import { startRunFeedReady, type RunFeed, type RunFeedOptions } from "../core/runfeed.js";
import { createWorktree, git, gitDirsOutside, type Worktree } from "../core/worktree.js";
import { isInside, resumeArgs, type DelegateArgs } from "../mcp/delegate-run.js";
import { JobRunners, readRunnerState } from "../mcp/job-host.js";
import { changedJobArgs, JOB_SETTING_KEYS, parseJobSettings, type JobSettings } from "../mcp/job-settings.js";
import type { Job, RunnerControl, RunnerState } from "../mcp/jobs.js";
import { hasUnsettledRunnerRetention } from "../mcp/runner-delivery-retention.js";
import { verifyOwnedRunnerRetention } from "../mcp/runner-ledger-recovery.js";
import { deliveryFailure } from "../mcp/delivery-evidence.js";
import { metadataDb } from "../core/metadata-db.js";
import { assertRemoteOperationAdmission, readRemoteOperationEvidence } from "../core/remote-operation-evidence.js";
import { runnerLedgerNamespace } from "../core/runner-store.js";
import type { NetworkService, RemoteDestination } from "./link.js";
import type { NetworkPair } from "./pairing.js";
import { MAX_REMOTE_JOBS, REMOTE_JOB_ANTIGRAVITY_OPTIONS_CAPABILITY, REMOTE_JOB_CAPABILITY, REMOTE_JOB_CANCELLED_CAPABILITY, REMOTE_JOB_FRAME, REMOTE_JOB_RATE_LIMIT, REMOTE_JOB_RATE_WINDOW_MS, REMOTE_JOB_REQUEST_TIMEOUT_MS, REMOTE_JOB_SPAWN_LIMIT, remoteJobRequestSchema, remoteJobWireSchema, remoteJobSnapshotSchema, remoteSnapshotForPeer, type RemoteJobRequest } from "./remote-job-protocol.js";

export interface RemoteJobSnapshot { state: RunnerState | null; alive: boolean; approvals: PendingApproval[]; usageTurn?: string }
/** Registration authority is deliberately not a local Job routing record. */
export interface RemoteRegistrationPrincipal extends Record<string, unknown> {
  kind: "remote-registration"; id: string; name: string; agent: Job["agent"]; supervisor: string; workdir: string | null; ownerAddress: string;
}
interface RemoteSupervisorRoute { kind: "remote-supervisor"; address: string; supervisor: string; destination: RemoteDestination }
interface RemoteRecord { pair: string; peer: string; owner: string; job: Job; args: DelegateArgs; returnRoute?: RemoteSupervisorRoute; usageRefusal?: RunnerState; usageTurn?: string }
type StoredRemoteRecord = Omit<RemoteRecord, "job"> & { job: Omit<Job, "controller" | "queue"> };
const REMOTE_JOBS_FILE = "remote-jobs.json";
interface Pending { host: string; resolve: (value: RemoteJobSnapshot) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
interface MirrorIntent { options: RunFeedOptions; snapshot: RemoteJobSnapshot; controller?: AbortController; task?: Promise<void> }
interface StartingOperation {
  pair: string; peer: string; supervisor: string; route: RemoteSupervisorRoute; settled: Promise<void>; release: () => void; record?: RemoteRecord;
  controller: AbortController; turn: number; incarnation: string; request: Extract<RemoteJobRequest, { op: "spawn" }>;
  cancelRequested?: boolean; cancelEvidence?: boolean; effectAttempted?: boolean; result?: RemoteJobSnapshot;
}

/** Canonical containment rejects traversal, sibling-prefix paths and symlink/junction escapes. */
export function allowedRemoteDirectory(directory: string, roots: string[]): string {
  if (!isAbsolute(directory)) throw new Error("Remote cwd must be an absolute path on the paired PC.");
  // Native resolution expands Windows 8.3 names too: Git and Node may spell the same temp root differently.
  const canonical = realpathSync.native(directory);
  if (!statSync(canonical).isDirectory() || !roots.some((root) => isAbsolute(root) && isInside(canonical, realpathSync.native(root)))) {
    throw new Error("Remote folder is outside network.remoteJobs.allowRoots.");
  }
  return canonical;
}

/** One per elected broker. The requester can choose spawn args, never the executable or runner config. */
export class RemoteJobs {
  private readonly records = new Map<string, RemoteRecord>();
  private readonly pending = new Map<string, Pending>();
  private readonly rates = new Map<string, { at: number; requests: number; spawns: number }>();
  private readonly feeds = new Map<string, RunFeed>();
  private readonly mirrorIntents = new Map<string, MirrorIntent>();
  private readonly mirrorTurns = new Map<string, object>();
  private readonly mirrorStates = new Map<string, RunnerState>();
  private readonly approvals = new Map<string, () => void>();
  private readonly publishingApprovals = new Set<string>();
  private readonly starting = new Map<string, StartingOperation>();
  /** A remote request awaiting its answer, or a spawn still being admitted or started: a daemon must not exit idle. */
  get busy(): boolean { return this.pending.size > 0 || this.starting.size > 0 || this.pendingStarts.size > 0; }
  /** A local Bridge runner may register from this durable receiver-side record.
   * Source-side mirrors are not local jobs, and no public advertisement grants control. */
  jobForRegistration(id: string): RemoteRegistrationPrincipal | undefined {
    const record = this.records.get(id);
    if (!record || this.pendingStarts.get(id)?.committed === false || record.job.id !== id || record.job.supervisor !== `${record.pair}/${record.peer}` ||
        typeof record.owner !== "string" || !record.owner.includes("/") || record.job.owner !== record.owner) return undefined;
    return { kind: "remote-registration", id, name: record.job.name, agent: record.job.agent, supervisor: record.job.supervisor, workdir: record.job.workdir, ownerAddress: record.owner };
  }
  /** Original paired-host evidence, never a route rebuilt from today's names. */
  jobReturnRoute(id: string): RemoteSupervisorRoute | undefined {
    const record = this.records.get(id), route = record?.returnRoute;
    if (!record || !this.jobForRegistration(id) || !route || route.kind !== "remote-supervisor" || route.address !== record.owner ||
        route.supervisor !== record.job.supervisor || route.destination?.hostId !== record.pair ||
        route.address.slice(route.address.indexOf("/") + 1) !== route.destination.name ||
        !mailboxSchema.safeParse({ kind: "remote", hostId: route.destination.hostId, hostFingerprint: route.destination.hostFingerprint }).success ||
        !recipientKey(route.destination.frontend, route.destination.native)) return undefined;
    return route;
  }

  private returnRoute(pair: NetworkPair, peer: { id: string; name: string; supervisor: string }): RemoteSupervisorRoute | undefined {
    const advertised = this.network.peers().find(p => p.id === `${pair.id}/${peer.id}` && p.name === `${pair.name}/${peer.name}`);
    if (!advertised || advertised.jobAgent || !recipientKey(advertised.frontend, advertised.nativeOwner) ||
        !mailboxSchema.safeParse({ kind: "remote", hostId: pair.id, hostFingerprint: pair.fingerprint }).success) return undefined;
    return { kind: "remote-supervisor", address: `${pair.name}/${peer.name}`, supervisor: `${pair.id}/${peer.supervisor}`,
      destination: { hostId: pair.id, hostFingerprint: pair.fingerprint, name: peer.name,
        ...(advertised.frontend ? { frontend: advertised.frontend } : { native: advertised.nativeOwner }) } };
  }
  private readonly pendingStarts = new Map<string, { record: RemoteRecord; previous?: RemoteRecord; controller: AbortController; cancelRequested: boolean; committed: boolean }>();
  private readonly runners: JobRunners | null;
  private closed = false;
  private readonly unsubscribeLink?: () => void;

  constructor(private readonly network: NetworkService, private readonly home: string, private readonly log: Logger,
    private readonly control: (record: { owner: string; name: string; id: string }, control: RunnerControl, origin: InternalMessageOrigin) => Promise<void>,
  ) {
    const cli = bundledCli();
    this.runners = cli ? new JobRunners({} as BridgeNode, home, cli, log) : null;
    const stored = readJsonStore(join(home, REMOTE_JOBS_FILE));
    if (isRecord(stored) && Array.isArray(stored.jobs)) for (const r of stored.jobs as StoredRemoteRecord[]) {
      if (typeof r.pair !== "string" || typeof r.peer !== "string" || !r.job?.id || !r.args) continue;
      this.records.set(r.job.id, { ...r, job: { ...r.job, controller: new AbortController(), queue: [] } });
    }
    network.registerExtension(REMOTE_JOB_FRAME, REMOTE_JOB_CAPABILITY, (payload, pair) => this.receive(payload, pair), [REMOTE_JOB_CANCELLED_CAPABILITY, REMOTE_JOB_ANTIGRAVITY_OPTIONS_CAPABILITY, REMOTE_JOB_USAGE_CAPABILITY, REMOTE_RUNNER_LEDGER_CAPABILITY]);
    this.unsubscribeLink = network.onLink?.(pair => {
      if (network.peerSupports(pair.id, REMOTE_RUNNER_LEDGER_CAPABILITY)) return;
      for (const [rid, pending] of this.pending) if (pending.host === pair.id || pending.host === pair.name) {
        clearTimeout(pending.timer); this.pending.delete(rid); pending.reject(unsupportedRunnerLedger(true));
      }
    });
  }

  async request(host: string, peer: Pick<PeerInfo, "id" | "name">, raw: RemoteJobRequest, supervisor = peer.id, localJobName?: string): Promise<RemoteJobSnapshot> {
    if (!this.network.peerSupports(host, REMOTE_RUNNER_LEDGER_CAPABILITY)) {
      if (this.network.peerConnected(host)) throw unsupportedRunnerLedger();
      throw new Error("Paired instance is disconnected; no remote request was dispatched");
    }
    const request = remoteJobRequestSchema.parse(raw);
    if (request.op === "spawn") {
      const settings = Object.fromEntries(JOB_SETTING_KEYS.filter((key) => key in request.args).map((key) => [key, (request.args as Record<string, unknown>)[key]]));
      if (Object.keys(settings).length) {
        const parsed = parseJobSettings(settings, request.target);
        if (typeof parsed === "string") throw new Error(parsed);
      }
    }
    const mirrorKey = `${host}/${request.job}`, mirrorTurn = this.mirrorTurns.get(mirrorKey);
    if (!this.network.peerSupports(host, REMOTE_JOB_CAPABILITY)) throw new Error("Remote broker update needed or paired PC disconnected: owner-coordinated compatible host upgrade is required for remote-jobs-v1. No automatic broker replacement is performed.");
    if (request.op === "spawn" && (request.args.terminal_sandbox !== undefined || request.args.bypass_permissions !== undefined) && !this.network.peerSupports(host, REMOTE_JOB_ANTIGRAVITY_OPTIONS_CAPABILITY)) {
      throw new Error("Remote broker update needed: paired PC does not support Antigravity terminal_sandbox or bypass_permissions options.");
    }
    if (this.pending.size >= REMOTE_JOB_RATE_LIMIT) throw new Error("Too many pending remote job requests.");
    const rid = randomUUID();
    const response = new Promise<RemoteJobSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error("Remote job request timed out; check the paired PC before retrying a spawn.")); }, REMOTE_JOB_REQUEST_TIMEOUT_MS);
      this.pending.set(rid, { host, resolve, reject, timer });
    });
    void response.catch(() => {});
    let dispatched = false;
    try {
      let wireRequest = request;
      if (request.op === "spawn" && !this.network.peerSupports(host, REMOTE_JOB_USAGE_CAPABILITY)) {
        if (request.usageControls?.length) throw new Error("Remote broker update needed: submitted steering requires remote-jobs-usage-v1 admission acknowledgments.");
        const { usageTurn, ...legacy } = request;
        wireRequest = legacy;
      }
      dispatched = true; // A failed write/response cannot prove no accepted remote work.
      await this.network.sendExtension(host, REMOTE_JOB_FRAME, { kind: "request", rid, peer: { id: peer.id, name: peer.name, supervisor }, request: wireRequest });
      const snapshot = await response;
      if (!this.network.peerSupports(host, REMOTE_RUNNER_LEDGER_CAPABILITY)) throw unsupportedRunnerLedger(true);
      // The remote result is authoritative even when this PC cannot yet retain its mirror.
      try {
        // An older poll remains a valid RPC result, but cannot rewrite a newer turn's mirror.
        if (request.op === "spawn" || this.mirrorTurns.get(mirrorKey) === mirrorTurn) await this.mirror(host, peer, request, snapshot, supervisor, localJobName);
      }
      catch (error) { this.log.warn("remote result retained; local run mirror unavailable", { host, job: request.job, err: String(error) }); }
      return snapshot;
    } catch (err) {
      const p = this.pending.get(rid);
      if (p) { clearTimeout(p.timer); this.pending.delete(rid); p.reject(err as Error); }
      if (dispatched && request.op === "spawn") throw new BridgeError(err instanceof BridgeError ? err.code : "timeout", String((err as Error).message).slice(0, 8192),
        { ...(err instanceof BridgeError ? err.details : {}), remoteExecutionUnconfirmed: true });
      if (request.op === "spawn" && request.args.base !== undefined) {
        throw new Error(`Remote spawn with explicit base ${request.args.base} failed; an older peer may not support the base option. Check the paired PC before retrying: ${(err as Error).message}`);
      }
      throw err;
    }
  }

  private async receive(payload: Record<string, unknown>, pair: NetworkPair): Promise<void> {
    const parsed = remoteJobWireSchema.safeParse(payload);
    if (!parsed.success) { this.log.warn("invalid remote job frame", { host: pair.name }); return; }
    const frame = parsed.data;
    if (!this.network.peerSupports(pair.id, REMOTE_RUNNER_LEDGER_CAPABILITY)) {
      if (frame.kind === "response") {
        const pending = this.pending.get(frame.rid);
        if (pending && (pending.host === pair.id || pending.host === pair.name)) {
          clearTimeout(pending.timer); this.pending.delete(frame.rid); pending.reject(unsupportedRunnerLedger(true));
        }
      }
      throw unsupportedRunnerLedger(frame.kind === "response");
    }
    if (frame.kind === "response") {
      const p = this.pending.get(frame.rid);
      if (!p || (p.host !== pair.id && p.host !== pair.name)) return;
      clearTimeout(p.timer); this.pending.delete(frame.rid);
      if (frame.error) p.reject(new Error(frame.error));
      else {
        const snapshot = remoteJobSnapshotSchema.safeParse(frame.value);
        if (snapshot.success) p.resolve(snapshot.data);
        else p.reject(new Error("Invalid remote job response."));
      }
      return;
    }
    try {
      const advertised = this.network.peers().find((p) => p.id === `${pair.id}/${frame.peer.id}` && p.name === `${pair.name}/${frame.peer.name}`);
      if (!advertised || advertised.jobAgent) throw new Error("Remote job requester is not an advertised supervisor session.");
      const returnRoute = this.returnRoute(pair, frame.peer);
      if (!returnRoute) throw new Error("Remote supervisor return ownership is unproven; no runner was admitted.");
      const cfg = loadConfig(this.home, "other", this.log, {});
      const policy = cfg.network.remoteJobs;
      if (!policy.enabled || !policy.allowPeers.includes(pair.name)) throw new Error("Remote jobs are disabled for this pair; enable network.remoteJobs and explicitly allow its instance name.");
      const now = Date.now();
      let rate = this.rates.get(pair.id);
      if (!rate || now - rate.at >= REMOTE_JOB_RATE_WINDOW_MS) { rate = { at: now, requests: 0, spawns: 0 }; this.rates.set(pair.id, rate); }
      if (++rate.requests > REMOTE_JOB_RATE_LIMIT || (frame.request.op === "spawn" && ++rate.spawns > REMOTE_JOB_SPAWN_LIMIT)) throw new Error("Remote job rate limit reached; try again later.");
      if (frame.request.op === "spawn" && this.starting.has(frame.request.job)) throw new Error("Remote job is already starting.");
      const starting = this.starting.get(frame.request.job);
      if (frame.request.op !== "spawn" && starting) {
        // Root/worktree/usage admission awaits precede even the provisional
        // record. A concurrent control must not become an Unknown job refusal
        // and poison the requester's exact retained operation. Cancellation
        // interrupts this original admission; other operations wait for it.
        if (starting.pair !== pair.id || starting.peer !== frame.peer.id || starting.supervisor !== frame.peer.supervisor ||
            JSON.stringify(starting.route) !== JSON.stringify(returnRoute)) throw new Error("Remote job belongs to another supervisor.");
        if (frame.request.op === "control" && frame.request.control.type === "cancel") this.cancelAdmission(starting, frame.request);
        await starting.settled;
        if (this.closed) throw new Error("Remote jobs link closed before operation admission.");
        if (!this.network.peerSupports(pair.id, REMOTE_RUNNER_LEDGER_CAPABILITY)) throw unsupportedRunnerLedger();
        if (JSON.stringify(this.returnRoute(pair, frame.peer)) !== JSON.stringify(returnRoute))
          throw new Error("Remote job belongs to the original authenticated supervisor binding.");
        if (frame.request.op === "control" && frame.request.control.type === "cancel" && starting.cancelRequested && starting.result) {
          await this.network.sendExtension(pair.id, REMOTE_JOB_FRAME, { kind: "response", rid: frame.rid,
            value: remoteSnapshotForPeer(starting.result, this.network.peerSupports(pair.id, REMOTE_JOB_CANCELLED_CAPABILITY)) });
          return;
        }
        if (!starting.record || this.records.get(frame.request.job) !== starting.record || this.starting.has(frame.request.job))
          throw new Error("Original remote spawn did not retain its admitted generation; operation remains unconfirmed.");
      }
      let reservation: StartingOperation | undefined;
      if (frame.request.op === "spawn") {
        let release!: () => void;
        const settled = new Promise<void>(resolve => { release = resolve; });
        reservation = { pair: pair.id, peer: frame.peer.id, supervisor: frame.peer.supervisor, route: JSON.parse(JSON.stringify(returnRoute)), settled, release,
          controller: new AbortController(), turn: Date.now(), incarnation: randomUUID(), request: JSON.parse(JSON.stringify(frame.request)) };
        this.starting.set(frame.request.job, reservation);
      }
      let value: RemoteJobSnapshot;
      try {
        try { value = await this.handle(pair, frame.peer, frame.request, returnRoute, reservation); }
        catch (error) {
          // Only this live admission can prove cancellation before the actual
          // publication/launch boundary. An attempted effect stays unknown.
          if (!reservation?.cancelEvidence || reservation.effectAttempted || this.closed ||
              !this.network.peerSupports(pair.id, REMOTE_RUNNER_LEDGER_CAPABILITY) ||
              JSON.stringify(this.returnRoute(pair, frame.peer)) !== JSON.stringify(returnRoute)) throw error;
          value = { state: { pid: 0, peer: `${reservation.request.target}-job-${frame.request.job}`, status: "cancelled", updatedAt: Date.now(), delivered: false },
            alive: false, approvals: [], usageTurn: reservation.request.usageTurn };
        }
        if (reservation) { reservation.record = this.records.get(frame.request.job); reservation.result = value; }
      }
      finally {
        if (reservation && this.starting.get(frame.request.job) === reservation) this.starting.delete(frame.request.job);
        reservation?.release();
      }
      const compatible = remoteSnapshotForPeer(value, this.network.peerSupports(pair.id, REMOTE_JOB_CANCELLED_CAPABILITY));
      await this.network.sendExtension(pair.id, REMOTE_JOB_FRAME, { kind: "response", rid: frame.rid, value: compatible });
    } catch (err) {
      await this.network.sendExtension(pair.id, REMOTE_JOB_FRAME, { kind: "response", rid: frame.rid, error: String((err as Error).message).slice(0, 4_096) });
    }
  }

  /** Capture before accepting cancellation. The existing strict cache fence is
   * also read by prior v2 writers at preclaim/spec publication; no new optional
   * field may be the sole barrier against a restarted or older writer. */
  private cancelAdmission(starting: StartingOperation, request: Extract<RemoteJobRequest, { op: "control" }>): void {
    if (starting.cancelRequested) return;
    if (!starting.effectAttempted) {
      metadataDb(this.home);
      const file = join(this.home, "remote-job-states", `${request.job}.json`), previous = readRemoteOperationEvidence(this.home, request.job);
      if (previous?.operations?.length) throw new Error("Original remote operation evidence requires recovery before cancellation admission");
      const proof = { version: 1, namespace: runnerLedgerNamespace(this.home, true), incarnation: starting.incarnation, turn: starting.turn,
        pair: starting.pair, peer: starting.peer, supervisor: starting.supervisor, route: starting.route, spawn: starting.request, cancel: request };
      const operations = [starting.request, request].map((item, index) => ({
        id: createHash("sha256").update(JSON.stringify([proof, index])).digest("hex"), turn: starting.turn, request: item, state: "blocked" as const }));
      const retained = { ...previous, fetchedAt: Date.now(), snapshot: { state: null, alive: true, approvals: [] }, operations, admissionCancellation: proof };
      if (Buffer.byteLength(JSON.stringify({ ...retained, version: JSON_STORE_VERSION }, null, 2) + "\n") > 8 * 1024 * 1024)
        throw new Error("Remote cancellation evidence capacity reached; original caller must retain its unconfirmed operation");
      writeJsonStore(file, retained, previous);
      starting.cancelEvidence = true;
    }
    starting.cancelRequested = true;
    const pending = this.pendingStarts.get(request.job);
    if (pending?.controller === starting.controller) pending.cancelRequested = true;
    starting.controller.abort(new Error("Remote job not_started: cancelled before detached runner startup"));
  }

  private async handle(pair: NetworkPair, peer: { id: string; name: string; supervisor: string }, request: RemoteJobRequest, returnRoute?: RemoteSupervisorRoute, starting?: StartingOperation): Promise<RemoteJobSnapshot> {
    if (!this.network.peerSupports(pair.id, REMOTE_RUNNER_LEDGER_CAPABILITY)) throw unsupportedRunnerLedger();
    let record = this.records.get(request.job);
    if (record && (record.pair !== pair.id || record.peer !== peer.supervisor)) throw new Error("Remote job belongs to another supervisor.");
    if (record?.returnRoute && (!returnRoute || record.returnRoute.destination.hostFingerprint !== returnRoute.destination.hostFingerprint ||
        record.returnRoute.destination.name !== returnRoute.destination.name ||
        recipientKey(record.returnRoute.destination.frontend, record.returnRoute.destination.native) !== recipientKey(returnRoute.destination.frontend, returnRoute.destination.native)))
      throw new Error("Remote job belongs to the original authenticated supervisor binding.");
    if (request.op === "spawn") {
      assertRemoteOperationAdmission(this.home, request.job);
      const current = () => {
        starting?.controller.signal.throwIfAborted();
        if (this.closed || starting && this.starting.get(request.job) !== starting || !this.network.peerSupports(pair.id, REMOTE_RUNNER_LEDGER_CAPABILITY))
          throw new Error("Remote job startup lost its original admission");
      };
      if (record && hasUnsettledRunnerRetention(readRunnerState(this.home, record.job.id))) {
        if (this.snapshot(record).alive) throw new Error("Remote job is already running; its original evidence remains owned.");
        try { await this.runners?.recoverRetention(record.job, record.job.controller.signal, () => !this.closed && this.records.get(record!.job.id) === record); }
          catch { throw new Error("Remote runner retention is unsettled; original generation requires owned evidence recovery"); }
        throw new Error("Remote runner retention is unsettled; original generation must settle before continuation.");
      }
      const cfg = loadConfig(this.home, request.target, this.log, {});
      const policy = loadConfig(this.home, "other", this.log, {}).network.remoteJobs;
      if (!policy.agents.includes(request.target)) throw new Error("Remote agent is not allowed by network.remoteJobs.agents.");
      if (record && record.job.agent !== request.target) throw new Error("Cannot change a remote job's agent.");
      if (record && this.snapshot(record).alive) throw new Error("Remote job is already running.");
      if ([...this.records.values()].filter((r) => { const snapshot = this.snapshot(r); return snapshot.alive || hasUnsettledRunnerRetention(snapshot.state); }).length + this.starting.size > cfg.maxJobs) throw new Error("Remote subagent limit reached.");
      if (!record && this.records.size >= MAX_REMOTE_JOBS) throw new Error("Remote job registry is full.");
      if (!record && request.args.session_id) throw new Error("Remote session continuation requires a job owned by this supervisor.");
      const settings = Object.fromEntries(JOB_SETTING_KEYS.filter((key) => key in request.args).map((key) => [key, (request.args as Record<string, unknown>)[key]]));
      let parsedSettings: JobSettings = {};
      if (Object.keys(settings).length) { const parsed = parseJobSettings(settings, request.target); if (typeof parsed === "string") throw new Error(parsed); parsedSettings = parsed; }
      let args: DelegateArgs = { ...request.args, ...(request.target === "codex" ? { native_subagents: request.args.native_subagents ?? cfg.codexSubagents } : {}) };
      let cwd = allowedRemoteDirectory(args.cwd!, policy.allowRoots);
      for (const directory of await gitDirsOutside(cwd, this.log) ?? []) allowedRemoteDirectory(directory, policy.allowRoots);
      current();
      let worktree: Worktree | null = null;
      if (record) {
        const state = this.snapshot(record).state;
        if (!state?.sessionId && !record.usageRefusal) throw new Error(state?.status === "cancelled"
          ? "Remote job was cancelled before its session started; start a new job."
          : "Remote job did not start a native session; start a new job.");
        cwd = allowedRemoteDirectory(state?.workdir ?? cwd, policy.allowRoots);
        worktree = state?.worktree ?? null;
        if (state?.sessionId) args = resumeArgs(args, record.job.name, args.prompt, state.sessionId, cwd, worktree, changedJobArgs({ ...record.args }, parsedSettings));
        else if (args.session_id) throw new Error("A refused job has no native session to resume.");
      }
      // Only this executor's authenticated account may decide a remote refusal.
      const usage = !record && args.worktree ? { type: "allow", reason: "unknown" } as const
        : await checkUsagePreflight(usageProbeFor(request.target, cfg, { home: this.home, cwd, log: this.log }, args.model));
      current();
      if (!record && args.worktree && usage.type !== "block") {
        const repo = allowedRemoteDirectory(await git(["rev-parse", "--show-toplevel"], cwd, this.log), policy.allowRoots);
        current();
        if (existsSync(join(repo, "worktrees"))) allowedRemoteDirectory(join(repo, "worktrees"), policy.allowRoots);
        // Managed checkouts remain under an allowed root, including their git metadata.
        worktree = await createWorktree({ cwd, home: repo, worktreeRoot: cfg.worktreeRoot, base: args.base, jobId: request.job, log: this.log });
        current();
        cwd = allowedRemoteDirectory(worktree.cwd, policy.allowRoots);
        args = { ...args, cwd, worktree: false, _worktree: worktree };
      }
      const owner = record?.owner ?? `${pair.name}/${peer.name}`;
      const job: Job = { id: request.job, name: `${request.target}-job-${request.job}`, agent: request.target,
        model: args.model ?? null, prompt: args.prompt, args: { ...args }, owner, supervisor: `${pair.id}/${peer.supervisor}`,
        startedAt: starting?.turn ?? Date.now(), controller: starting?.controller ?? new AbortController(), queue: [], status: "running", progress: null,
        sessionId: args.session_id ?? null, workdir: cwd, worktree, usageRunId: randomUUID(), usagePendingControls: request.usageControls };
      job.providerUsage = { runId: job.usageRunId, turnStartedAt: job.startedAt, decision: usage, warningReported: false,
        ...(usage.type === "block" ? { retainedControls: job.usagePendingControls } : {}) };
      const previous = this.records.get(request.job);
      record = { pair: pair.id, peer: peer.supervisor, owner, job, args: { ...args, cwd, _job: job.name },
        returnRoute: previous ? previous.returnRoute : returnRoute, usageTurn: request.usageTurn };
      this.records.set(job.id, record);
      if (usage.type === "block") {
        job.status = "failed";
        record.usageRefusal = { pid: 0, peer: job.name, status: "failed", updatedAt: Date.now(),
          sessionId: job.sessionId, providerUsage: job.providerUsage, usageSubmission: usageSubmissionReceipt(job), report: usageAdmissionText(usage), delivered: false, finishedAt: Date.now() };
        this.persist();
        return this.snapshot(record);
      }
      const staged = record;
      const admission = { record: staged, previous, controller: job.controller, cancelRequested: false, committed: false };
      this.pendingStarts.set(job.id, admission);
      const timeout = setTimeout(() => admission.controller.abort(new Error("Remote job not_started: store reader admission exceeded 10 seconds; no detached runner was launched")), 10_000);
      timeout.unref();
      try {
        if (this.closed) throw new Error("Remote broker closed while the job was starting.");
        const host = await this.runners?.startAsync(job, { target: request.target, args: staged.args, base: staged.args, owner, byAgent: "other", cwd, cfg }, {
          signal: admission.controller.signal,
          isCurrent: () => !this.closed && this.records.get(job.id) === staged && this.pendingStarts.get(job.id) === admission &&
            staged.job === job && staged.owner === owner && staged.peer === peer.supervisor && staged.pair === pair.id && this.network.peerSupports(pair.id, REMOTE_RUNNER_LEDGER_CAPABILITY),
          onStart: () => { if (starting) starting.effectAttempted = true; },
        });
        if (!host) throw new Error("Remote job runner is unavailable; update the remote broker's bundled CLI.");
        job.host = host;
        admission.committed = true;
        if (admission.cancelRequested) {
          this.persist();
          await this.control({ owner: staged.owner, name: job.name, id: job.id }, { type: "cancel" }, this.controlOrigin(pair, peer, job.id));
        }
      } catch (err) {
        // Admission is ephemeral until the first successful persist. Restore
        // only this generation; never roll back a newer committed job record.
        if (!job.host && this.records.get(job.id) === staged) { if (previous) this.records.set(job.id, previous); else this.records.delete(job.id); }
        throw err;
      } finally {
        clearTimeout(timeout);
        if (this.pendingStarts.get(job.id) === admission) this.pendingStarts.delete(job.id);
      }
      this.persist();
      this.log.info("remote job started", { host: pair.name, owner, job: job.name, cwd });
    } else {
      if (!record) throw new Error("Unknown remote job.");
      if (request.op === "control") {
        const pending = this.pendingStarts.get(record.job.id);
        if (pending?.record === record) {
          if (request.control.type !== "cancel") throw new Error("Remote job not_started: storage admission is still queued; no runner can receive this control yet");
          pending.cancelRequested = true;
          pending.controller.abort(new Error("Remote job not_started: cancelled before detached runner startup"));
          return { state: null, alive: true, approvals: [] }; // admission/cancellation has not settled yet
        }
        let parsedSettings: JobSettings | undefined;
        if (request.control.type === "settings") {
          const settings = parseJobSettings(request.control.settings, record.job.agent);
          if (typeof settings === "string") throw new Error(settings);
          parsedSettings = settings;
        }
        await this.control({ owner: record.owner, name: record.job.name, id: record.job.id }, request.control as RunnerControl, this.controlOrigin(pair, peer, record.job.id));
        if (parsedSettings) {
          record.args = { ...changedJobArgs({ ...record.args }, parsedSettings), prompt: record.args.prompt, title: record.args.title };
          record.job.args = changedJobArgs(record.job.args, parsedSettings);
          this.persist();
        }
        this.log.info("remote job control", { job: record.job.name, control: request.control.type, host: pair.name });
      } else if (request.op === "approval") {
        const approvals = listPendingApprovals(this.home);
        if (!approvals.some((a) => a.id === request.id && a.job === record!.job.name && a.owner === record!.owner)) {
          this.log.warn("remote approval answer refused", { job: record!.job.name, stage: "executor-lookup", idPresent: approvals.some(a => a.id === request.id),
            jobPresent: approvals.some(a => a.id === request.id && a.job === record!.job.name), ownerPresent: approvals.some(a => a.id === request.id && a.owner === record!.owner) });
          throw new Error("Remote approval expired or belongs to another job.");
        }
        // The real decider: a supervisor on the paired PC, not this PC's dashboard (AB-402: never a reusable grant here).
        const outcome = await answerPendingApproval(this.home, request.id, { decision: request.decision, reason: request.reason, source: "remote supervisor" });
        if (outcome !== "answered") { this.log.warn("remote approval answer refused", { job: record!.job.name, stage: "executor-relay", outcome }); throw new Error(`Remote approval ${outcome}.`); }
      }
    }
    const snapshot = this.snapshot(record!);
    // Older snapshot parsers strip unknown state fields. Do not send a terminal
    // report which could be settled without its preceding retention barrier.
    // Existing error responses preserve the requester's last observation and
    // cannot be mistaken for a receipt or positive proof of runner death.
    if (hasUnsettledRunnerRetention(snapshot.state)) {
      try { await this.runners?.recoverRetention(record!.job, record!.job.controller.signal, () => !this.closed && this.records.get(record!.job.id) === record); }
      catch { throw new Error("Remote runner retention is unsettled; original generation requires owned evidence recovery"); }
      throw new Error("Remote runner retention is unsettled; recover original evidence on its execution host before continuation.");
    }
    return snapshot;
  }

  private controlOrigin(pair: NetworkPair, peer: { id: string; name: string }, job: string): InternalMessageOrigin {
    const advertised = this.network.peers().find(p => p.id === `${pair.id}/${peer.id}` && p.name === `${pair.name}/${peer.name}`);
    const owner = advertised && recipientKey(advertised.frontend, advertised.nativeOwner);
    if (!owner) throw new Error("Remote control sender ownership is unproven");
    return { kind: "remote-job-control", operation: job, owner, source: { kind: "remote", hostId: pair.id, hostFingerprint: pair.fingerprint } };
  }

  private snapshot(record: RemoteRecord): RemoteJobSnapshot {
    if (record.usageRefusal) return { state: record.usageRefusal, alive: false, approvals: [], usageTurn: record.usageTurn };
    let state = readRunnerState(this.home, record.job.id);
    const alive = this.runners?.alive(record.job, state) ?? Boolean(state && state.status === "running");
    if (alive && state && hasUnsettledRunnerRetention(state)) {
      verifyOwnedRunnerRetention(this.home, record.job.id, state, record.job as unknown as Record<string, unknown>);
      // A live owned ledger is work in progress, not a dead unknown generation.
      // Even a staged terminal result must not escape as done/delivered while
      // earlier evidence is unsettled. Old snapshot readers also see running.
      state = { pid: state.pid, peer: state.peer, updatedAt: state.updatedAt, status: "running", delivered: false,
        sessionId: state.sessionId, workdir: state.workdir, worktree: state.worktree, asking: state.asking, live: state.live,
        providerUsage: state.providerUsage, usageSubmission: state.usageSubmission, progress: state.progress };
    }
    return { state, alive, approvals: listPendingApprovals(this.home).filter((a) => a.job === record.job.name && a.owner === record.owner), usageTurn: record.usageTurn };
  }

  private persist(): void {
    const committed = [...this.records.values()].flatMap(record => {
      const pending = this.pendingStarts.get(record.job.id);
      return pending?.record === record && !pending.committed ? pending.previous ? [pending.previous] : [] : [record];
    });
    writeJsonStore(join(this.home, REMOTE_JOBS_FILE), { jobs: committed.map((r) => {
      const { controller, queue, ...job } = r.job;
      return { ...r, job };
    }) }, readJsonStore(join(this.home, REMOTE_JOBS_FILE)));
  }

  private async mirror(host: string, peer: Pick<PeerInfo, "id" | "name">, request: RemoteJobRequest, snapshot: RemoteJobSnapshot, supervisor: string, localJobName?: string): Promise<void> {
    if (this.closed) return;
    const owner = peer.name;
    const key = `${host}/${request.job}`;
    if (request.op === "spawn") {
      this.mirrorTurns.set(key, {});
      this.mirrorStates.delete(key);
      this.mirrorIntents.get(key)?.controller?.abort(new Error("Remote mirror replaced by a new turn"));
      this.feeds.get(key)?.end("interrupted");
      this.feeds.delete(key);
      this.mirrorIntents.set(key, { snapshot, options: { home: this.home, name: `${request.target}-${request.job}`, header: `${request.target} on ${host}, by ${owner}\n${request.args.prompt}\n---`,
        meta: { by: owner, job: localJobName ?? `${request.target}-job-${request.job}`, title: request.args.title, remote: { host, name: `${request.target}-job-${request.job}` }, model: request.args.model, effort: request.args.effort, access: request.args.access ?? (request.args.worktree ? "edit" : "default"), workdir: request.args.cwd,
          ...{ remoteSpawnArgs: { ...request.args } } } } });
      this.log.info("requested remote job", { host, job: request.job, owner });
    }
    const previous = this.mirrorStates.get(key);
    if (previous && (!snapshot.state || snapshot.state.updatedAt < previous.updatedAt ||
      snapshot.state.updatedAt === previous.updatedAt && previous.status !== "running" && snapshot.state.status === "running")) snapshot = { ...snapshot, state: previous };
    const state = snapshot.state;
    if (state) this.mirrorStates.set(key, state);
    if (!this.feeds.has(key) && !this.mirrorIntents.has(key) && state?.status === "running") {
      this.mirrorIntents.set(key, { snapshot, options: { home: this.home, name: state.peer, header: `Reattached remote job on ${host}, by ${owner}`,
        meta: { by: owner, job: localJobName ?? state.peer, remote: { host, name: state.peer } } } });
    }
    const intent = this.mirrorIntents.get(key);
    if (intent) {
      intent.snapshot = snapshot;
      this.prepareMirror(key, intent);
    }
    this.updateMirror(key, snapshot);
    const active = new Set(snapshot.approvals.map((a) => `${key}/${a.id}`));
    for (const [id, close] of this.approvals) if (id.startsWith(`${key}/`) && !active.has(id)) { close(); this.approvals.delete(id); }
    for (const approval of snapshot.approvals) {
      const id = `${key}/${approval.id}`;
      if (this.approvals.has(id) || this.publishingApprovals.has(id)) continue;
      this.publishingApprovals.add(id);
      try {
        // AB-417: the remote bridge may be older than the marker guard, so its question text gets the guard here too.
        const close = await publishApproval(this.home, { ...approval, command: markerSafe(approval.command), owner, job: `${host}/${approval.job}` }, async (body) => {
          if (Date.now() >= approval.deadline) { this.log.warn("remote approval answer refused", { job: `${host}/${approval.job}`, stage: "requester-deadline" }); return false; }
          try {
            await this.request(host, peer, { op: "approval", job: request.job, id: approval.id, decision: body.startsWith("allow") ? "allow" : "deny", reason: body.includes(":") ? body.slice(body.indexOf(":") + 1).trim() : undefined }, supervisor);
            return true;
          } catch (error) { this.log.warn("remote approval answer refused", { job: `${host}/${approval.job}`, stage: "requester-rpc", failure: deliveryFailure(error) }); return false; }
        });
        if (this.closed) close(); else this.approvals.set(id, close);
      } finally { this.publishingApprovals.delete(id); }
    }
  }

  /** Context admission is local background work, never a second remote spawn or an RPC wait.
   * A later state poll retries a timed-out intent with its original spawn options and latest facts. */
  private prepareMirror(key: string, intent: MirrorIntent): void {
    if (intent.task || this.closed) return;
    const controller = new AbortController();
    intent.controller = controller;
    const timer = setTimeout(() => controller.abort(new Error("Local remote-run mirror metadata admission exceeded 2 seconds; retry on the next state poll")), 2_000);
    timer.unref();
    intent.task = startRunFeedReady(intent.options, controller.signal).then(feed => {
      if (this.closed || controller.signal.aborted || this.mirrorIntents.get(key) !== intent) {
        // Dispose only this intent's feed using its own retained terminal facts.
        const state = intent.snapshot.state;
        if (state && state.status !== "running") this.updateMirrorFeed(feed, state);
        else feed.end("interrupted");
        return;
      }
      this.feeds.set(key, feed);
      this.updateMirror(key, intent.snapshot);
      this.mirrorIntents.delete(key);
    }).catch(error => {
      if (!this.closed && this.mirrorIntents.get(key) === intent) this.log.warn("remote result retained; local run mirror context pending", { key, err: String(error) });
    }).finally(() => {
      clearTimeout(timer);
      if (intent.controller === controller) { intent.controller = undefined; intent.task = undefined; }
    });
  }

  private updateMirror(key: string, snapshot: RemoteJobSnapshot): void {
    const feed = this.feeds.get(key), state = snapshot.state;
    if (!feed || !state) return;
    this.updateMirrorFeed(feed, state);
    if (state.status !== "running") this.feeds.delete(key);
  }

  private updateMirrorFeed(feed: RunFeed, state: RunnerState): void {
    feed.meta({ session: state.sessionId, workdir: state.workdir ?? undefined, model: state.model, percent: state.percent, progressNote: state.progressNote, etaAt: state.etaAt, etaReportedAt: state.etaReportedAt });
    if (state.progress) feed.report(state.progress);
    if (state.status !== "running") feed.end(state.status, state.report);
  }

  close(): void {
    this.unsubscribeLink?.();
    this.closed = true;
    for (const starting of this.starting.values()) starting.release();
    for (const starting of this.starting.values()) starting.controller.abort(new Error("Remote job startup closed"));
    for (const intent of this.mirrorIntents.values()) intent.controller?.abort(new Error("Remote mirror broker closed"));
    this.mirrorIntents.clear();
    this.mirrorTurns.clear(); this.mirrorStates.clear();
    for (const pending of this.pendingStarts.values()) pending.controller.abort(new Error("Remote job not_started: broker closed before detached runner startup"));
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Remote jobs link closed.")); }
    this.pending.clear();
    for (const close of this.approvals.values()) close(); this.approvals.clear();
    for (const feed of this.feeds.values()) feed.end("interrupted"); this.feeds.clear();
  }
}
