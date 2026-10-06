import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadConfig } from "../core/config.js";
import { bundledCli } from "../core/delegate.js";
import { isRecord, readJsonStore, writeJsonStore } from "../core/json-store.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import type { PeerInfo } from "../core/protocol.js";
import { answerPendingApproval, listPendingApprovals, publishApproval, type PendingApproval } from "../core/relay.js";
import { startRunFeed, type RunFeed } from "../core/runfeed.js";
import { createWorktree, git, gitDirsOutside, type Worktree } from "../core/worktree.js";
import { isInside, resumeArgs, type DelegateArgs } from "../mcp/delegate-run.js";
import { JobRunners, readRunnerState } from "../mcp/job-host.js";
import { parseJobSettings } from "../mcp/job-settings.js";
import type { Job, RunnerControl, RunnerState } from "../mcp/jobs.js";
import type { NetworkService } from "./link.js";
import type { NetworkPair } from "./pairing.js";
import { MAX_REMOTE_JOBS, REMOTE_JOB_CAPABILITY, REMOTE_JOB_FRAME, REMOTE_JOB_RATE_LIMIT, REMOTE_JOB_RATE_WINDOW_MS, REMOTE_JOB_REQUEST_TIMEOUT_MS, REMOTE_JOB_SPAWN_LIMIT, remoteJobRequestSchema, remoteJobWireSchema, remoteJobSnapshotSchema, type RemoteJobRequest } from "./remote-job-protocol.js";

export interface RemoteJobSnapshot { state: RunnerState | null; alive: boolean; approvals: PendingApproval[] }
interface RemoteRecord { pair: string; peer: string; owner: string; job: Job; args: DelegateArgs }
type StoredRemoteRecord = Omit<RemoteRecord, "job"> & { job: Omit<Job, "controller" | "queue"> };
const REMOTE_JOBS_FILE = "remote-jobs.json";
interface Pending { host: string; resolve: (value: RemoteJobSnapshot) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

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
  private readonly approvals = new Map<string, () => void>();
  private readonly publishingApprovals = new Set<string>();
  private readonly starting = new Set<string>();
  private readonly runners: JobRunners | null;
  private closed = false;

  constructor(private readonly network: NetworkService, private readonly home: string, private readonly log: Logger,
    private readonly control: (record: { owner: string; name: string; id: string }, control: RunnerControl) => Promise<void>,
  ) {
    const cli = bundledCli();
    this.runners = cli ? new JobRunners({} as BridgeNode, home, cli, log) : null;
    const stored = readJsonStore(join(home, REMOTE_JOBS_FILE));
    if (isRecord(stored) && Array.isArray(stored.jobs)) for (const r of stored.jobs as StoredRemoteRecord[]) {
      if (typeof r.pair !== "string" || typeof r.peer !== "string" || !r.job?.id || !r.args) continue;
      this.records.set(r.job.id, { ...r, job: { ...r.job, controller: new AbortController(), queue: [] } });
    }
    network.registerExtension(REMOTE_JOB_FRAME, REMOTE_JOB_CAPABILITY, (payload, pair) => this.receive(payload, pair));
  }

  async request(host: string, peer: Pick<PeerInfo, "id" | "name">, raw: RemoteJobRequest, supervisor = peer.id, localJobName?: string): Promise<RemoteJobSnapshot> {
    const request = remoteJobRequestSchema.parse(raw);
    if (!this.network.peerSupports(host, REMOTE_JOB_CAPABILITY)) throw new Error("Remote broker update needed or paired PC disconnected: install remote-jobs-v1 support and restart its hosting sessions.");
    if (this.pending.size >= REMOTE_JOB_RATE_LIMIT) throw new Error("Too many pending remote job requests.");
    const rid = randomUUID();
    const response = new Promise<RemoteJobSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error("Remote job request timed out; check the paired PC before retrying a spawn.")); }, REMOTE_JOB_REQUEST_TIMEOUT_MS);
      this.pending.set(rid, { host, resolve, reject, timer });
    });
    void response.catch(() => {});
    try {
      await this.network.sendExtension(host, REMOTE_JOB_FRAME, { kind: "request", rid, peer: { id: peer.id, name: peer.name, supervisor }, request });
      const snapshot = await response;
      await this.mirror(host, peer, request, snapshot, supervisor, localJobName);
      return snapshot;
    } catch (err) {
      const p = this.pending.get(rid);
      if (p) { clearTimeout(p.timer); this.pending.delete(rid); p.reject(err as Error); }
      throw err;
    }
  }

  private async receive(payload: Record<string, unknown>, pair: NetworkPair): Promise<void> {
    const parsed = remoteJobWireSchema.safeParse(payload);
    if (!parsed.success) { this.log.warn("invalid remote job frame", { host: pair.name }); return; }
    const frame = parsed.data;
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
      const cfg = loadConfig(this.home, "other", this.log, {});
      const policy = cfg.network.remoteJobs;
      if (!policy.enabled || !policy.allowPeers.includes(pair.name)) throw new Error("Remote jobs are disabled for this pair; enable network.remoteJobs and explicitly allow its instance name.");
      const now = Date.now();
      let rate = this.rates.get(pair.id);
      if (!rate || now - rate.at >= REMOTE_JOB_RATE_WINDOW_MS) { rate = { at: now, requests: 0, spawns: 0 }; this.rates.set(pair.id, rate); }
      if (++rate.requests > REMOTE_JOB_RATE_LIMIT || (frame.request.op === "spawn" && ++rate.spawns > REMOTE_JOB_SPAWN_LIMIT)) throw new Error("Remote job rate limit reached; try again later.");
      if (frame.request.op === "spawn" && this.starting.has(frame.request.job)) throw new Error("Remote job is already starting.");
      if (frame.request.op === "spawn") this.starting.add(frame.request.job);
      let value: RemoteJobSnapshot;
      try { value = await this.handle(pair, frame.peer, frame.request); }
      finally { if (frame.request.op === "spawn") this.starting.delete(frame.request.job); }
      await this.network.sendExtension(pair.id, REMOTE_JOB_FRAME, { kind: "response", rid: frame.rid, value });
    } catch (err) {
      await this.network.sendExtension(pair.id, REMOTE_JOB_FRAME, { kind: "response", rid: frame.rid, error: String((err as Error).message).slice(0, 4_096) });
    }
  }

  private async handle(pair: NetworkPair, peer: { id: string; name: string; supervisor: string }, request: RemoteJobRequest): Promise<RemoteJobSnapshot> {
    let record = this.records.get(request.job);
    if (record && (record.pair !== pair.id || record.peer !== peer.supervisor)) throw new Error("Remote job belongs to another supervisor.");
    if (request.op === "spawn") {
      const cfg = loadConfig(this.home, request.target, this.log, {});
      const policy = loadConfig(this.home, "other", this.log, {}).network.remoteJobs;
      if (!policy.agents.includes(request.target)) throw new Error("Remote agent is not allowed by network.remoteJobs.agents.");
      if (record && record.job.agent !== request.target) throw new Error("Cannot change a remote job's agent.");
      if (record && this.snapshot(record).alive) throw new Error("Remote job is already running.");
      if ([...this.records.values()].filter((r) => this.snapshot(r).alive).length + this.starting.size > cfg.maxJobs) throw new Error("Remote subagent limit reached.");
      if (!record && this.records.size >= MAX_REMOTE_JOBS) throw new Error("Remote job registry is full.");
      if (!record && request.args.session_id) throw new Error("Remote session continuation requires a job owned by this supervisor.");
      const settings = Object.fromEntries(["model", "effort", "access", "sandbox", "permission_mode", "auto_approve"].filter((key) => key in request.args).map((key) => [key, (request.args as Record<string, unknown>)[key]]));
      if (Object.keys(settings).length) { const parsed = parseJobSettings(settings, request.target); if (typeof parsed === "string") throw new Error(parsed); }
      let args: DelegateArgs = { ...request.args };
      let cwd = allowedRemoteDirectory(args.cwd!, policy.allowRoots);
      for (const directory of await gitDirsOutside(cwd, this.log) ?? []) allowedRemoteDirectory(directory, policy.allowRoots);
      let worktree: Worktree | null = null;
      if (record) {
        const state = this.snapshot(record).state;
        if (!state?.sessionId) throw new Error("Remote job has no session to continue.");
        cwd = allowedRemoteDirectory(state.workdir ?? cwd, policy.allowRoots);
        worktree = state.worktree ?? null;
        args = resumeArgs(args, record.job.name, args.prompt, state.sessionId, cwd, worktree, { ...args });
      } else if (args.worktree) {
        const repo = allowedRemoteDirectory(await git(["rev-parse", "--show-toplevel"], cwd, this.log), policy.allowRoots);
        if (existsSync(join(repo, "worktrees"))) allowedRemoteDirectory(join(repo, "worktrees"), policy.allowRoots);
        // Managed checkouts remain under an allowed root, including their git metadata.
        worktree = await createWorktree({ cwd, home: repo, jobId: request.job, log: this.log });
        cwd = allowedRemoteDirectory(worktree.cwd, policy.allowRoots);
        args = { ...args, cwd, worktree: false, _worktree: worktree };
      }
      const owner = `${pair.name}/${peer.name}`;
      const job: Job = { id: request.job, name: `${request.target}-job-${request.job}`, agent: request.target,
        model: args.model ?? null, prompt: args.prompt, args: { ...args }, owner, supervisor: `${pair.id}/${peer.supervisor}`,
        startedAt: Date.now(), controller: new AbortController(), queue: [], status: "running", progress: null,
        sessionId: args.session_id ?? null, workdir: cwd, worktree };
      const previous = this.records.get(request.job);
      record = { pair: pair.id, peer: peer.supervisor, owner, job, args: { ...args, cwd, _job: job.name } };
      this.records.set(job.id, record);
      try {
        if (this.closed) throw new Error("Remote broker closed while the job was starting.");
        const host = this.runners?.start(job, { target: request.target, args: record.args, base: record.args, owner, byAgent: "other", cwd, cfg });
        if (!host) throw new Error("Remote job runner is unavailable; update the remote broker's bundled CLI.");
        job.host = host;
      } catch (err) { if (previous) this.records.set(job.id, previous); else this.records.delete(job.id); throw err; }
      this.persist();
      this.log.info("remote job started", { host: pair.name, owner, job: job.name, cwd });
    } else {
      if (!record) throw new Error("Unknown remote job.");
      if (request.op === "control") {
        if (request.control.type === "settings") {
          const settings = parseJobSettings(request.control.settings, record.job.agent);
          if (typeof settings === "string") throw new Error(settings);
        }
        await this.control({ owner: record.owner, name: record.job.name, id: record.job.id }, request.control as RunnerControl);
        this.log.info("remote job control", { job: record.job.name, control: request.control.type, host: pair.name });
      } else if (request.op === "approval") {
        if (!listPendingApprovals(this.home).some((a) => a.id === request.id && a.job === record!.job.name && a.owner === record!.owner)) throw new Error("Remote approval expired or belongs to another job.");
        const outcome = await answerPendingApproval(this.home, request.id, { decision: request.decision, reason: request.reason });
        if (outcome !== "answered") throw new Error(`Remote approval ${outcome}.`);
      }
    }
    return this.snapshot(record!);
  }

  private snapshot(record: RemoteRecord): RemoteJobSnapshot {
    const state = readRunnerState(this.home, record.job.id);
    const alive = this.runners?.alive(record.job, state) ?? Boolean(state && state.status === "running");
    return { state, alive, approvals: listPendingApprovals(this.home).filter((a) => a.job === record.job.name && a.owner === record.owner) };
  }

  private persist(): void {
    writeJsonStore(join(this.home, REMOTE_JOBS_FILE), { jobs: [...this.records.values()].map((r) => {
      const { controller, queue, ...job } = r.job;
      return { ...r, job };
    }) }, readJsonStore(join(this.home, REMOTE_JOBS_FILE)));
  }

  private async mirror(host: string, peer: Pick<PeerInfo, "id" | "name">, request: RemoteJobRequest, snapshot: RemoteJobSnapshot, supervisor: string, localJobName?: string): Promise<void> {
    const owner = peer.name;
    const key = `${host}/${request.job}`;
    if (request.op === "spawn") {
      this.feeds.get(key)?.end("interrupted");
      this.feeds.set(key, startRunFeed({ home: this.home, name: `${request.target}-${request.job}`, header: `${request.target} on ${host}, by ${owner}\n${request.args.prompt}\n---`,
        meta: { by: owner, job: localJobName ?? `${request.target}-job-${request.job}`, title: request.args.title, remote: { host, name: `${request.target}-job-${request.job}` }, model: request.args.model, effort: request.args.effort, access: request.args.access ?? (request.args.worktree ? "edit" : "default"), workdir: request.args.cwd } }));
      this.log.info("requested remote job", { host, job: request.job, owner });
    }
    const state = snapshot.state;
    if (!this.feeds.has(key) && state?.status === "running") {
      this.feeds.set(key, startRunFeed({ home: this.home, name: state.peer, header: `Reattached remote job on ${host}, by ${owner}`,
        meta: { by: owner, job: localJobName ?? state.peer, remote: { host, name: state.peer } } }));
    }
    const feed = this.feeds.get(key);
    if (state) {
      feed?.meta({ session: state.sessionId, workdir: state.workdir ?? undefined, model: state.model, percent: state.percent, progressNote: state.progressNote });
      if (state.progress) feed?.report(state.progress);
      if (state.status !== "running") { feed?.end(state.status, state.report); this.feeds.delete(key); }
    }
    const active = new Set(snapshot.approvals.map((a) => `${key}/${a.id}`));
    for (const [id, close] of this.approvals) if (id.startsWith(`${key}/`) && !active.has(id)) { close(); this.approvals.delete(id); }
    for (const approval of snapshot.approvals) {
      const id = `${key}/${approval.id}`;
      if (this.approvals.has(id) || this.publishingApprovals.has(id)) continue;
      this.publishingApprovals.add(id);
      try {
        const close = await publishApproval(this.home, { ...approval, owner, job: `${host}/${approval.job}` }, async (body) => {
          if (Date.now() >= approval.deadline) return false;
          try {
            await this.request(host, peer, { op: "approval", job: request.job, id: approval.id, decision: body.startsWith("allow") ? "allow" : "deny", reason: body.includes(":") ? body.slice(body.indexOf(":") + 1).trim() : undefined }, supervisor);
            return true;
          } catch { return false; }
        });
        if (this.closed) close(); else this.approvals.set(id, close);
      } finally { this.publishingApprovals.delete(id); }
    }
  }

  close(): void {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Remote jobs link closed.")); }
    this.pending.clear();
    for (const close of this.approvals.values()) close(); this.approvals.clear();
    for (const feed of this.feeds.values()) feed.end("interrupted"); this.feeds.clear();
  }
}
