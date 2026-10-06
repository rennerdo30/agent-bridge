import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_MAX_JOBS } from "../core/constants.js";
import { DelegateError, failureCause, type DelegateResult } from "../core/delegate.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import type { AgentKind, BridgeMessage } from "../core/protocol.js";
import type { Worktree } from "../core/worktree.js";
import { archiveFile, assertWritableStore, isRecord, mergeStoreFields, readJsonStore, retentionLimit, writeJsonStore } from "../core/json-store.js";
import { changedJobArgs, type JobSettings } from "./job-settings.js";
import { newApprovalId, publishApproval, type PermissionDecision, type PermissionRequest } from "../core/relay.js";
import { notifyJobEvent } from "../core/notifications.js";

const JOB_ID_LENGTH = 8;
const PROMPT_PREVIEW_CHARS = 120;
/** Finished subagents stay addressable (message_subagent) for this many jobs. */
const HISTORY_LIMIT = 50;
/** Finished jobs kept in the active store; overflow is archived. Zero disables the limit. */
const STORE_LIMIT = 200;
/** Status note ids remembered (they are read long before this many pile up). */
const MAX_NOTES = 500;
/** Interrupted jobs stay listed (to be recovered) this long. */
const INTERRUPTED_LISTED_MS = 24 * 60 * 60 * 1000;
/** A job runner's status note travels as conversation "job-<id>" plus this. */
export const NOTE_CONVERSATION_SUFFIX = ":note";
/** Follow-up sent when a subagent is resumed without a message (e.g. after a failure). */
export const DEFAULT_FOLLOW_UP = "Continue where you stopped and finish the task. Then give your final answer.";

/** A delegated run's result, plus the folder it worked in (a worktree, for example). */
export type RunResult = DelegateResult & { workdir?: string; worktree?: Worktree };
/**
 * Runs a subagent turn; `job` is the job it belongs to (its name labels the run in the dashboard).
 * `hosted`, when given, first tries to start the turn in a detached job runner (see job-host.ts) instead.
 */
export type Run = ((signal: AbortSignal, onProgress: (message: string, full?: string) => void, job: Job) => Promise<RunResult>) & {
  hosted?: (job: Job) => JobHostInfo | null;
};
/** Continue a subagent's own session with a new message and its saved next-turn settings. */
export type Resume = (message: string, sessionId: string, workdir: string | null, worktree: Worktree | null) => Run;

export interface Job {
  id: string;
  /** Pseudo peer name the result arrives from, e.g. "codex-job-1a2b3c4d". */
  name: string;
  agent: AgentKind;
  model: string | null;
  prompt: string;
  startedAt: number;
  controller: AbortController;
  /** Latest status line reported by the subagent, e.g. "running: npm test". */
  progress: string | null;
  /** ask_* runs: the caller waits for the result itself; shown in peers, no result message. */
  foreground?: boolean;
  /** "interrupted": it was running when its session ended (agent-bridge restarted); it can be recovered. */
  status: "running" | "done" | "failed" | "interrupted";
  /** Saved options (access, model, folder, ...), including changes for its next turn. */
  args?: Record<string, unknown>;
  /** Peer name of the session that started it. */
  owner?: string;
  /** Stable session identity used to restrict direct sibling chat, including after a server reload. */
  supervisor?: string;
  /** The subagent's own session (Codex thread, Claude session, opencode session) once known. */
  sessionId: string | null;
  workdir: string | null;
  worktree: Worktree | null;
  resume?: Resume;
  /** Follow-ups that arrived while the job was running; sent as soon as it finishes. */
  queue: string[];
  /** While it runs: show a new title in the current turn too (dashboard). */
  retitle?: ((title: string) => void) | null;
  /** The subagent's own estimate of how far it is (report_progress), and its note. */
  percent?: number;
  progressNote?: string;
  /** This session sent it a live message and its answer is still to come (that answer wakes the session). */
  awaitingAnswer?: boolean;
  /** MCP servers the parent allowed for this job (kept across its follow-ups). */
  allowedServers?: Set<string>;
  /** An approval question the subagent is waiting on; the next message to the job answers it. */
  pendingApproval?: ((answer: string, by?: string) => boolean | void) | null;
  /** While it runs: delivers a message into the running subagent (see parent-link.ts). */
  live?: { post: (message: string, sibling?: BridgeMessage) => void } | null;
  finishedAt?: number;
  /** Runs in a detached job runner, so it outlives a restart of this session's server (see job-host.ts). */
  host?: JobHostInfo | null;
  /** Messages forwarded to its runner that it has not confirmed yet; they become a follow-up if it never saw them. */
  forwarded?: { cid: string; body: string }[];
}

/** The job runner process hosting a job: its pid (null until it reported in) and peer name on the bridge. */
export interface JobHostInfo {
  pid: number | null;
  peer: string;
  startedAt: number;
}

/** What a job runner reports about its job (its state file, written only by the runner). */
export interface RunnerState {
  pid: number;
  peer: string;
  status: "running" | "done" | "failed";
  /** Heartbeat: a runner that stopped writing is gone, even if its pid was reused. */
  updatedAt: number;
  /** Model of its current turn; saved next-turn settings may differ while it runs. */
  model?: string | null;
  sessionId?: string | null;
  workdir?: string | null;
  worktree?: Worktree | null;
  progress?: string | null;
  percent?: number;
  progressNote?: string;
  /** It waits for an answer to an approval question. */
  asking?: boolean;
  /** Messages reach the running subagent live. */
  live?: boolean;
  /** Ids of the forwarded messages it took. */
  seen?: string[];
  /** The final report, and whether it reached the session (as a message on the bridge). */
  report?: string;
  delivered?: boolean;
  finishedAt?: number;
}

/** A message from the session to the runner of one of its jobs. */
export type RunnerControl = { type: "message"; body: string; cid: string } | { type: "title"; title: string } | { type: "effort"; effort: string } | { type: "settings"; settings: JobSettings } | { type: "cancel" } | { type: "attach" };

/** The session's side of job runners (implemented in job-host.ts). */
export interface JobHost {
  state(job: Job): RunnerState | null;
  /** Whether its runner is still at work (or still starting). */
  alive(job: Job, state: RunnerState | null): boolean;
  send(job: Job, control: RunnerControl): void;
  /** Stop the runner and everything it started. */
  kill(job: Job): void;
}

/** How often running runner-hosted jobs are checked (their result also triggers a check at once). */
const HOST_POLL_MS = 2_000;
/** cancel_subagent asks a runner to stop first; after this long it is killed. */
const CANCEL_GRACE_MS = 5_000;
/** Said after a report when follow-ups that arrived meanwhile were sent to the subagent right away. */
export const QUEUED_FOLLOW_UP_NOTE = "(Your queued follow-up was sent to it; its answer will arrive as another message.)";

/** The message a finished turn reports: how it ended, why it failed, and what the subagent said. */
export function jobReport(job: Pick<Job, "name" | "agent" | "model" | "sessionId">, status: "done" | "failed", seconds: number, text: string, cause: string | null): string {
  const how = job.sessionId
    ? status === "failed"
      ? ` To recover it with its context, call message_subagent(job="${job.name}") (optionally with a message).`
      : ` Continue it with its context: message_subagent(job="${job.name}", message=...).`
    : "";
  const header = `Subagent ${job.name} (${job.agent}${job.model ? `, model ${job.model}` : ""}) ${status} after ${seconds}s.${how}`;
  // A failure always says why, before whatever the agent said last (which may be only a progress note).
  return [header, cause ? `Cause: ${cause}` : "", text && cause ? `Its last message:\n${text}` : text].filter(Boolean).join("\n\n");
}

/**
 * Ask the session's agent to approve something a running subagent wants to do; `post` delivers the question
 * as a message from the job. The next message to the job (job.pendingApproval) answers it; none in time is "deny".
 */
const approvalAnswers = new WeakMap<Job, Set<(answer: string, by?: string) => boolean>>();

/** Ending a turn must never leave an approval waiting after the job is gone. */
export function denyPendingApprovals(job: Job, reason = "job finished"): void {
  for (const answer of [...(approvalAnswers.get(job) ?? [])]) answer(reason, "job completion");
}

export function waitForApproval(job: Job, question: string, timeoutMs: number, post: (body: string) => void, log: Logger, home?: string, request?: PermissionRequest, askUser?: () => Promise<PermissionDecision>): Promise<{ allow: boolean; reason: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let cleanup: (() => void) | undefined;
    const askedAt = Date.now();
    const settle = (answer: string, by = "session") => {
      if (settled) return false;
      if (Date.now() >= askedAt + timeoutMs) { answer = "no answer in time"; by = "timeout"; }
      settled = true;
      clearTimeout(timer);
      job.controller.signal.removeEventListener("abort", aborted);
      const answers = approvalAnswers.get(job);
      answers?.delete(settle);
      job.pendingApproval = answers?.values().next().value ?? null;
      if (!answers?.size) approvalAnswers.delete(job);
      try { cleanup?.(); } catch { log.warn("could not remove pending approval", { job: job.name }); }
      const allow = /^\s*(allow|yes|y|approve|approved|ok|okay|go ahead|accept)\b/i.test(answer);
      try { post(`Approval for ${job.name} ${allow ? "allowed" : "denied"} by ${by}.`); }
      catch { log.warn("could not report approval answer", { job: job.name }); }
      resolve({ allow, reason: answer.trim() });
      return true;
    };
    const timer = setTimeout(() => settle("no answer in time", "timeout"), timeoutMs);
    timer.unref?.();
    const aborted = () => settle("job cancelled", "cancellation");
    job.controller.signal.addEventListener("abort", aborted, { once: true });
    let answers = approvalAnswers.get(job);
    if (!answers) { answers = new Set(); approvalAnswers.set(job, answers); }
    answers.add(settle);
    job.pendingApproval = answers.values().next().value!;
    if (job.controller.signal.aborted) { aborted(); return; }
    if (home) {
      void publishApproval(home, {
        id: newApprovalId(), owner: job.owner ?? "", job: job.name, agent: job.agent,
        tool: request?.tool ?? "approval", command: request?.detail ?? question,
        reason: request?.reason ?? question, askedAt, deadline: askedAt + timeoutMs,
      }, settle).then((close) => {
        if (settled) close();
        else { cleanup = close; notifyJobEvent(home, "approvals", log); }
      }).catch(() => log.warn("could not publish pending approval", { job: job.name }));
    }
    log.info("subagent asks for approval", { job: job.name });
    post(
      `Subagent ${job.name} asks for approval: ${question}\n\n` +
        `Decide as its supervisor: answer with message_subagent(job="${job.name}", message="allow") or message="deny" (a reason may follow). ` +
        `It waits for your answer; no answer within ${Math.round(timeoutMs / 60_000)} minutes counts as deny.`,
    );
    if (askUser) {
      void Promise.resolve().then(askUser).then(
        (decision) => settle(decision.allow ? "allow" : `deny: ${decision.message}`, "user in session"),
        () => settle("deny: The permission dialog failed.", "user in session"),
      );
    }
  });
}

/** "waiting": a finished job, but all slots are taken; it continues as soon as one frees up. */
export type FollowUpOutcome = "started" | "delivered" | "queued" | "waiting" | "answered" | "unknown" | "no-session";

/**
 * Subagents: the other CLI running headlessly. Background jobs report their result as a message from the
 * job's pseudo peer. Every job keeps its session, so it can be continued later with its full context
 * (message_subagent), like a native subagent: follow-ups to a running job are queued. Continuing a finished
 * job while maxJobs are running waits for a free slot (first come, first served) instead of being refused.
 */
export class JobManager {
  private readonly running = new Map<string, Job>();
  private readonly foreground = new Map<string, Job>();
  private readonly history = new Map<string, Job>();
  /** Finished jobs whose continuation waits for a free slot, in arrival order; the messages are in job.queue. */
  private readonly waitingJobs = new Map<string, Job>();
  /** Ids of status notes from running subagents (see fromSubagent). */
  private readonly notes = new Set<string>();
  /** Jobs this manager started, continued or took over: only these are saved (others' entries stay as they are on disk). */
  private readonly own = new Set<string>();
  /** Background jobs run in detached job runners where it can (they survive a restart of this server); null: all here. */
  runners: JobHost | null = null;
  private hostTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly node: BridgeNode,
    private readonly log: Logger,
    /** Where jobs are kept across restarts of the session (~/.agent-bridge/jobs.json); none in tests. */
    private readonly storePath: string | null = null,
    /** Background subagents running at once (config maxJobs; max_subagents changes it while the session runs). */
    private maxJobs: number = DEFAULT_MAX_JOBS,
  ) {
    // A message from a runner-hosted job may be its result: look at its runner right away.
    node.on("message", (m) => {
      if (!m.from.id.startsWith("job:")) return;
      const job = this.running.get(m.from.id.slice("job:".length));
      if (job?.host) this.checkHosted(job);
    });
    // Runners send to this session by name: tell them where it is now (a new server, maybe a new name).
    node.on("connected", () => {
      for (const job of this.running.values()) if (job.host) this.runners?.send(job, { type: "attach" });
    });
  }

  get limit(): number {
    return this.maxJobs;
  }

  /** Change the limit now. A higher one starts waiting continuations; a lower one stops no running subagent. */
  setLimit(max: number): void {
    this.maxJobs = max;
    this.log.info("subagent limit changed", { max });
    this.startWaiting();
  }

  /**
   * A newer server of this session took over (the bridge replaced this one): stay out of the job store and the
   * runners, so two servers never settle or save the same jobs. Ends when this server takes its place back.
   */
  private dormant = false;

  setDormant(dormant: boolean): void {
    if (this.dormant === dormant) return;
    this.dormant = dormant;
    this.log.info(dormant ? "another server of this session took over: jobs paused here" : "this server took its place back: jobs resumed");
    if (dormant && this.hostTimer) {
      clearInterval(this.hostTimer);
      this.hostTimer = null;
    }
    if (!dormant && [...this.running.values()].some((j) => j.host)) this.watchHosted();
  }

  /** Save this session's jobs, merged with those other sessions saved. Best effort: never breaks a run. */
  persist(): void {
    if (!this.storePath || this.dormant) return;
    let lock = () => {};
    try {
      lock = acquireLock(`${this.storePath}.lock`);
      const previous = readJobsDocument(this.storePath, this.log);
      assertWritableStore(previous);
      const entries = Array.isArray(previous) ? previous : isRecord(previous) ? previous.jobs as unknown[] : [];
      const mine = [...this.history.values()].filter((j) => this.own.has(j.id)).map((j) => {
        const old = entries.find((entry) => isRecord(entry) && entry.id === j.id);
        return mergeStoreFields(isRecord(old) ? old : {}, toStored(j)) as StoredJob;
      });
      const ids = new Set(mine.map((j) => j.id));
      const others = entries.filter((j) => !isRecord(j) || !ids.has(j.id as string));
      const all = [...others, ...mine].sort((a, b) => {
        const started = (entry: unknown) => isRecord(entry) && typeof entry.startedAt === "number" ? entry.startedAt : 0;
        return started(a) - started(b);
      });
      const finished = all.filter((j): j is StoredJob => isStoredJob(j) && (j.status === "done" || j.status === "failed"))
        .sort((a, b) => a.startedAt - b.startedAt);
      const limit = retentionLimit("AGENT_BRIDGE_JOB_STORE_LIMIT", STORE_LIMIT);
      const overflow = new Set(limit ? finished.slice(0, Math.max(0, finished.length - limit)) : []);
      if (overflow.size) {
        const archive = `${this.storePath}.overflow.json`;
        writeJsonStore(archive, { jobs: [...overflow] }, null);
        archiveFile(archive);
        this.log.info("archived finished jobs", { count: overflow.size });
      }
      writeJsonStore(this.storePath, { ...(isRecord(previous) ? previous : {}), jobs: all.filter((j) => !overflow.has(j as StoredJob)) }, previous);
    } catch (err) {
      this.log.warn("could not save subagent jobs", { err: (err as Error).message });
    } finally {
      lock();
    }
  }

  /**
   * Load the jobs saved before this session (re)started, so message_subagent can continue them with their
   * context. Jobs that were still running are marked interrupted: a follow-up without a message recovers them.
   * A job of this session whose job runner is still at work (it outlived the old server) is running: this
   * manager takes it over. Another session's runner-hosted job keeps its status for that session to take over.
   */
  restore(makeResume: (agent: AgentKind, args: Record<string, unknown>) => Resume | undefined): void {
    if (!this.storePath) return;
    const stored = readStore(this.storePath, this.log);
    const adopted: Job[] = [];
    // The newest ones, plus every job still marked running however old (its runner may still be at work).
    const recentIds = new Set(stored.slice(-HISTORY_LIMIT).map((s) => s.id));
    for (const s of stored.filter((x) => recentIds.has(x.id) || x.status === "running")) {
      if (this.history.has(s.id)) continue;
      const hosted = s.status === "running" && Boolean(s.host);
      const mine = this.isMine(s.owner);
      const job: Job = {
        ...s,
        status: s.status === "running" && !(hosted && !mine) ? "interrupted" : s.status,
        controller: new AbortController(),
        progress: null,
        queue: [],
        resume: makeResume(s.agent, s.args ?? {}),
      };
      this.history.set(s.id, job);
      if (hosted && mine && this.takeOver(job)) adopted.push(job);
    }
    if (stored.length) this.log.info("restored subagent jobs", { count: Math.min(stored.length, HISTORY_LIMIT), runnerHosted: adopted.length });
    this.settleAdopted(adopted);
  }

  /** Whether a runner-hosted job can be taken over here (its runner lives, or finished and left its report). */
  private takeOver(job: Job): boolean {
    if (!this.runners) return false;
    const state = this.runners.state(job);
    // What the runner learned after the old server last saved (its session, above all) makes it recoverable.
    if (state) Object.assign(job, { sessionId: state.sessionId ?? job.sessionId, workdir: state.workdir ?? job.workdir, worktree: state.worktree ?? job.worktree });
    if (this.runners.alive(job, state) || (state && state.status !== "running")) return true;
    job.status = "interrupted";
    if (state?.sessionId) this.own.add(job.id);
    return false;
  }

  private settleAdopted(adopted: Job[]): void {
    for (const job of adopted) {
      job.status = "running";
      // Under this session's name from now on (it may have been started under a "-N" stand-in).
      job.owner = this.node.name;
      this.running.set(job.id, job);
      this.own.add(job.id);
      // A runner that finished while no server of this session was there is settled now.
      this.checkHosted(job);
    }
    if (adopted.length) {
      this.watchHosted();
      this.persist();
    }
  }

  /** Record facts learned while it runs (its session, its folder), so a restart can continue it. */
  note(job: Job, facts: { sessionId?: string | null; workdir?: string | null; worktree?: Worktree | null }): void {
    if (facts.sessionId) job.sessionId = facts.sessionId;
    if (facts.workdir) job.workdir = facts.workdir;
    if (facts.worktree) job.worktree = facts.worktree;
    this.persist();
  }

  runningCount(): number {
    return this.running.size;
  }

  /** Background jobs plus blocking ask_* runs, so the session (and its coordinator) can see all of them. */
  list(): Job[] {
    // Runner-hosted jobs report their progress through their runner.
    for (const job of [...this.running.values()]) if (job.host) this.checkHosted(job);
    return [...this.running.values(), ...this.foreground.values()];
  }

  /** Continuations waiting for a free slot, first in line first. */
  waiting(): Job[] {
    return [...this.waitingJobs.values()];
  }

  /** Recently finished subagents, newest first (they can still be messaged). */
  /**
   * Whether a job belongs to this session. A session briefly runs under a "-N" stand-in of its name when a
   * reload starts its new server while the old one is still connected; jobs started then are its too.
   */
  private isMine(owner: string | undefined): boolean {
    return !owner || owner === this.node.name || this.adoptedOwners.has(owner);
  }

  /** "-N" stand-in names of this session whose jobs it adopted (see adoptStandIns). */
  private readonly adoptedOwners = new Set<string>();

  /** Whether `owner` is a "-N" stand-in of this session's name ("claude-x-2" for "claude-x"). */
  private isStandIn(owner: string): boolean {
    const base = this.node.name.replace(/-\d+$/, "");
    return owner !== this.node.name && (owner === base || (owner.startsWith(`${base}-`) && /^\d+$/.test(owner.slice(base.length + 1))));
  }

  /**
   * A reload can run a session briefly under a "-N" stand-in name; jobs started then carry it. Once on the
   * bridge, adopt those whose stand-in name no live peer holds (a live "-2" is another session of the folder).
   */
  adoptStandIns(online: ReadonlySet<string>): string[] {
    if (this.dormant) return [];
    const owners = new Set([...this.history.values()].map((j) => j.owner).filter((o): o is string => Boolean(o) && this.isStandIn(o!) && !online.has(o!)));
    if (!owners.size) return [];
    for (const o of owners) this.adoptedOwners.add(o);
    const taken: Job[] = [];
    for (const job of this.history.values()) {
      if (!job.owner || !owners.has(job.owner)) continue;
      if (job.status === "running" && job.host && !this.running.has(job.id) && this.takeOver(job)) taken.push(job);
      else if (job.status === "running" && !this.running.has(job.id)) job.status = "interrupted";
    }
    this.log.info("adopted jobs started under a stand-in name of this session", { owners: [...owners], runnerHosted: taken.length });
    this.settleAdopted(taken);
    return [...owners];
  }

  /** Finished jobs of this session: every interrupted one (they need recovering), then the newest others. */
  recent(limit = 5): Job[] {
    const mine = [...this.history.values()]
      .filter((j) => j.status !== "running" && !this.waitingJobs.has(j.id) && this.isMine(j.owner))
      .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt));
    const interrupted = mine.filter((j) => j.status === "interrupted" && Date.now() - (j.finishedAt ?? j.startedAt) < INTERRUPTED_LISTED_MS);
    return [...interrupted, ...mine.filter((j) => !interrupted.includes(j)).slice(0, limit)];
  }

  find(ref: string): Job | undefined {
    const id = ref.replace(/^.*-(?:job|ask)-/, "");
    return this.history.get(id) ?? [...this.history.values()].find((j) => j.name === ref);
  }

  private remember(job: Job): void {
    this.history.set(job.id, job);
    this.own.add(job.id);
    while (this.history.size > HISTORY_LIMIT) this.history.delete(this.history.keys().next().value!);
    this.persist();
  }

  private newJob(agent: AgentKind, model: string | null, prompt: string, kind: "job" | "ask", resume?: Resume, args?: Record<string, unknown>): Job {
    const id = randomUUID().replace(/-/g, "").slice(0, JOB_ID_LENGTH);
    return {
      id,
      name: `${agent}-${kind}-${id}`,
      agent,
      model,
      prompt,
      startedAt: Date.now(),
      controller: new AbortController(),
      progress: null,
      status: "running",
      sessionId: null,
      workdir: null,
      worktree: null,
      resume,
      queue: [],
      args,
      owner: this.node.name,
      // Keep the first job's identity when hooks learn the session id later, or a server reload adopts it.
      supervisor: [...this.running.values(), ...this.foreground.values()].find((j) => this.isMine(j.owner))?.supervisor ?? this.node.currentSessionId ?? this.node.id,
    };
  }

  /**
   * Register a blocking ask_* run for visibility in peers. Returns a progress sink and `end`, which records
   * the outcome so the run can be continued later with message_subagent.
   */
  track(
    agent: AgentKind,
    model: string | null,
    prompt: string,
    resume?: Resume,
    args?: Record<string, unknown>,
  ): { job: Job; onProgress: (message: string) => void; end: (outcome?: { result?: RunResult; error?: unknown }) => void } {
    const job = { ...this.newJob(agent, model, prompt, "ask", resume, args), foreground: true };
    this.foreground.set(job.id, job);
    this.remember(job);
    return {
      job,
      onProgress: (message) => {
        job.progress = message;
      },
      end: (outcome) => {
        denyPendingApprovals(job);
        this.foreground.delete(job.id);
        job.foreground = false;
        job.finishedAt = Date.now();
        job.status = outcome?.result && !outcome.result.isError ? "done" : "failed";
        if (this.storePath) notifyJobEvent(dirname(this.storePath), job.status === "done" ? "finish" : "fail", this.log);
        job.sessionId = outcome?.result?.sessionId ?? sessionOfError(outcome?.error) ?? job.sessionId;
        job.workdir = outcome?.result?.workdir ?? job.workdir;
        job.worktree = outcome?.result?.worktree ?? job.worktree;
        this.persist();
        // Follow-ups sent while the caller waited continue the session in the background (or wait for a slot).
        if (job.queue.length && job.resume && job.sessionId && !job.controller.signal.aborted) {
          if (this.canStart()) this.launch(job, job.resume(job.queue.splice(0).join("\n\n"), job.sessionId, job.workdir, job.worktree));
          else this.waitForSlot(job);
        }
      },
    };
  }

  canStart(): boolean {
    return this.running.size < this.maxJobs;
  }

  start(agent: AgentKind, model: string | null, prompt: string, run: Run, resume?: Resume, args?: Record<string, unknown>): Job {
    const job = this.newJob(agent, model, prompt, "job", resume, args);
    this.remember(job);
    this.log.info("subagent started", { job: job.name, model, prompt: prompt.slice(0, PROMPT_PREVIEW_CHARS) });
    this.launch(job, run);
    return job;
  }

  /** Save next-turn settings and send them to a runner that continues the job itself. */
  setSettings(ref: string, settings: JobSettings): boolean {
    const job = this.find(ref);
    if (!job) return false;
    job.args = changedJobArgs(job.args, settings);
    if (settings.model !== undefined && job.status !== "running") job.model = settings.model;
    if (this.hostedRunning(job)) this.runners!.send(job, { type: "settings", settings });
    this.own.add(job.id);
    this.persist();
    return true;
  }

  /** Change a job's thinking level for its next turns (a turn already running keeps its own). */
  setEffort(ref: string, effort: string): boolean {
    const job = this.find(ref);
    if (!job) return false;
    job.args = { ...job.args, effort };
    // A runner continues queued follow-ups itself: it needs the new level too.
    if (this.hostedRunning(job)) this.runners!.send(job, { type: "effort", effort });
    this.own.add(job.id);
    this.persist();
    return true;
  }

  /** Name or rename a job; its next turn (and the dashboard) uses the title. */
  setTitle(ref: string, title: string): boolean {
    const job = this.find(ref);
    if (!job) return false;
    job.args = { ...job.args, title };
    job.retitle?.(title);
    if (this.hostedRunning(job)) this.runners!.send(job, { type: "title", title });
    this.own.add(job.id);
    this.persist();
    return true;
  }
  /**
   * Send a follow-up to a subagent: queued while it runs, otherwise its session is resumed in the background,
   * as soon as a slot is free.
   */
  followUp(ref: string, message: string): { outcome: FollowUpOutcome; job?: Job } {
    const job = this.find(ref);
    if (!job) return { outcome: "unknown" };
    // Its runner may have finished just now: then this continues it instead.
    if (this.hostedRunning(job)) this.checkHosted(job);
    if (this.waitingJobs.has(job.id)) {
      job.queue.push(message);
      return { outcome: "waiting", job };
    }
    if (this.hostedRunning(job)) {
      // Its runner decides: an answer to its approval question, a live message, or queued for after this turn.
      const state = this.runners!.state(job);
      const cid = randomUUID();
      (job.forwarded ??= []).push({ cid, body: message });
      this.runners!.send(job, { type: "message", body: message, cid });
      return { outcome: state?.asking ? "answered" : state?.live ? "delivered" : "queued", job };
    }
    if (job.status === "running" && job.pendingApproval) {
      const answer = job.pendingApproval;
      job.pendingApproval = null;
      answer(message, `session ${this.node.name}`);
      return { outcome: "answered", job };
    }
    if (job.status === "running") {
      // Like a native subagent: it sees the message while it works and can answer at once.
      if (job.live) {
        job.awaitingAnswer = true;
      job.live.post(message);
        return { outcome: "delivered", job };
      }
      job.queue.push(message);
      return { outcome: "queued", job };
    }
    if (!job.resume || !job.sessionId) return { outcome: "no-session", job };
    if (!this.canStart()) {
      job.queue.push(message);
      this.waitForSlot(job);
      return { outcome: "waiting", job };
    }
    this.log.info("subagent resumed", { job: job.name, sessionId: job.sessionId });
    this.launch(job, job.resume(message, job.sessionId, job.workdir, job.worktree));
    return { outcome: "started", job };
  }

  /** Continue this finished job (its queued messages) once a slot frees up. */
  private waitForSlot(job: Job): void {
    this.waitingJobs.set(job.id, job);
    this.log.info("subagent continuation waits for a free slot", { job: job.name, running: this.running.size, position: this.waitingJobs.size });
  }

  /** Start waiting continuations while there are free slots, oldest first. */
  private startWaiting(): void {
    for (const job of this.waitingJobs.values()) {
      if (!this.canStart()) return;
      this.waitingJobs.delete(job.id);
      if (!job.queue.length || !job.resume || !job.sessionId) continue;
      this.log.info("subagent resumed (was waiting for a slot)", { job: job.name, sessionId: job.sessionId });
      this.launch(job, job.resume(job.queue.splice(0).join("\n\n"), job.sessionId, job.workdir, job.worktree));
    }
  }

  private launch(job: Job, run: Run): void {
    if (typeof job.args?.model === "string") job.model = job.args.model;
    job.status = "running";
    job.startedAt = Date.now();
    job.controller = new AbortController();
    job.progress = null;
    job.foreground = false;
    this.running.set(job.id, job);
    this.own.add(job.id);
    // A detached job runner where it can: the turn then survives a restart of this server.
    job.host = this.runners ? (run.hosted?.(job) ?? null) : null;
    job.forwarded = [];
    this.persist();
    if (job.host) {
      this.log.info("subagent runs in a job runner", { job: job.name, peer: job.host.peer });
      this.watchHosted();
      return;
    }
    const onProgress = (message: string) => {
      job.progress = message;
      this.log.debug("subagent progress", { job: job.name, message });
    };
    run(job.controller.signal, onProgress, job).then(
      (res) => {
        job.workdir = res.workdir ?? job.workdir;
        job.worktree = res.worktree ?? job.worktree;
        this.finish(job, res.isError ? "failed" : "done", res.text || "(no answer text returned)", res.sessionId, res.isError ? failureCause({ result: res }) : null);
      },
      // The cause is the whole report here: the error says what happened (and, for a worktree, where the work is).
      (err) => this.finish(job, "failed", "", sessionOfError(err), failureCause({ error: err })),
    );
  }

  /** A running job of this manager that a job runner hosts. */
  private hostedRunning(job: Job): boolean {
    return job.status === "running" && Boolean(job.host) && Boolean(this.runners) && this.running.get(job.id) === job;
  }

  /** Check runner-hosted jobs while any runs. */
  private watchHosted(): void {
    if (this.hostTimer || this.dormant) return;
    this.hostTimer = setInterval(() => {
      const hosted = [...this.running.values()].filter((j) => j.host);
      if (!hosted.length && this.hostTimer) {
        clearInterval(this.hostTimer);
        this.hostTimer = null;
      }
      for (const job of hosted) this.checkHosted(job);
    }, HOST_POLL_MS);
    this.hostTimer.unref();
  }

  /**
   * Take what a job's runner reports: its progress and facts, and its end. The runner delivers the report
   * itself (a message on the bridge, so it waits for the session even while no server of it runs); this
   * session only posts it when the runner could not, or says why a runner ended without one.
   */
  private checkHosted(job: Job): void {
    if (!this.hostedRunning(job)) return;
    const runners = this.runners!;
    const state = runners.state(job);
    if (state) {
      job.host!.pid = state.pid;
      if (state.model !== undefined) job.model = state.model;
      job.progress = state.progress ?? job.progress;
      if (state.percent !== undefined) {
        job.percent = state.percent;
        job.progressNote = state.progressNote;
      }
      if ((state.sessionId && state.sessionId !== job.sessionId) || (state.workdir && state.workdir !== job.workdir) || (state.worktree && !job.worktree)) {
        this.note(job, { sessionId: state.sessionId, workdir: state.workdir, worktree: state.worktree });
      }
    }
    const alive = runners.alive(job, state);
    // A finished runner may still be delivering its report: wait for that (or for it to give up).
    if (state && state.status !== "running") {
      if (state.delivered || !alive) this.settleHosted(job, state);
    } else if (!alive) this.settleHosted(job, null);
  }

  /** A runner-hosted job ended: with its runner's final state, or without (the runner is gone). */
  private settleHosted(job: Job, final: RunnerState | null): void {
    // Messages forwarded to the runner that it never took become a follow-up.
    const seen = new Set(final?.seen ?? this.runners?.state(job)?.seen ?? []);
    job.queue.push(...(job.forwarded ?? []).filter((f) => !seen.has(f.cid)).map((f) => f.body));
    job.forwarded = [];
    const pid = job.host?.pid;
    job.host = null;
    if (final) {
      this.finish(job, final.status === "done" ? "done" : "failed", "", final.sessionId ?? null, null, final.delivered ? null : final.report);
      return;
    }
    const cause = job.controller.signal.aborted ? "cancelled" : `its job runner${pid ? ` (process ${pid})` : ""} ended without reporting a result`;
    this.finish(job, "failed", "", job.sessionId, cause);
  }

  /** Cancel a background job, a blocking ask_* run or a continuation waiting for a slot, by name or id. */
  cancel(ref: string): boolean {
    const id = ref.replace(/^.*-(?:job|ask)-/, "");
    const waiting = [...this.waitingJobs.values()].find((j) => j.id === id || j.name === ref);
    if (waiting) {
      this.waitingJobs.delete(waiting.id);
      waiting.queue = [];
      this.log.info("waiting subagent continuation cancelled", { job: waiting.name });
      return true;
    }
    const job = [...this.running.values(), ...this.foreground.values()].find((j) => j.id === id || j.name === ref);
    if (!job) return false;
    job.queue = [];
    job.controller.abort();
    if (this.hostedRunning(job)) {
      // Its runner stops the subagent and reports; one that does not react in time is killed with everything it started.
      job.forwarded = [];
      const runners = this.runners!;
      runners.send(job, { type: "cancel" });
      setTimeout(() => {
        if (!this.hostedRunning(job)) return;
        if (runners.alive(job, runners.state(job))) {
          this.log.warn("job runner did not stop in time; killing it", { job: job.name, pid: job.host?.pid });
          runners.kill(job);
        }
        this.checkHosted(job);
      }, CANCEL_GRACE_MS).unref();
    }
    return true;
  }

  /**
   * Stop every subagent of this process (the server shuts down). Runner-hosted ones keep running: the next
   * server of this session takes them over, and their results wait for it on the bridge.
   */
  cancelAll(): void {
    for (const j of this.waitingJobs.values()) j.queue = [];
    this.waitingJobs.clear();
    for (const j of this.running.values()) if (!j.host) j.controller.abort();
    for (const j of this.foreground.values()) denyPendingApprovals(j, "session closed");
    if (this.hostTimer) clearInterval(this.hostTimer);
    this.hostTimer = null;
  }

  /** `report`: null when the runner already delivered it, a text to post as it is, or undefined to compose it here. */
  private finish(job: Job, status: "done" | "failed", text: string, sessionId: string | null, cause: string | null = null, report?: string | null): void {
    denyPendingApprovals(job);
    this.running.delete(job.id);
    job.status = status;
    job.finishedAt = Date.now();
    job.sessionId = sessionId ?? job.sessionId;
    this.persist();
    const seconds = Math.round((Date.now() - job.startedAt) / 1000);
    this.log.info("subagent finished", { job: job.name, status, seconds, sessionId: job.sessionId, cause });
    if (this.storePath && !job.host) notifyJobEvent(dirname(this.storePath), status === "done" ? "finish" : "fail", this.log);
    const message = report === undefined ? jobReport(job, status, seconds, text, cause) : report;

    // Follow-ups that arrived meanwhile go out right away, into the same session (it keeps its slot).
    if (job.queue.length && job.resume && job.sessionId && !job.controller.signal.aborted) {
      const queued = job.queue.splice(0).join("\n\n");
      if (message !== null) this.post(job, `${message}\n\n${QUEUED_FOLLOW_UP_NOTE}`);
      this.launch(job, job.resume(queued, job.sessionId, job.workdir, job.worktree));
      return;
    }
    if (message !== null) this.post(job, message);
    // Its slot is free: the continuation waiting longest starts now.
    this.startWaiting();
  }

  /**
   * Ask this session's agent to approve something the running subagent wants to do (an MCP tool call, for
   * example). The question arrives as a message from the job; the agent answers with message_subagent.
   * No answer within the time limit counts as "deny".
   */
  askParent(job: Job, question: string, timeoutMs: number, request?: PermissionRequest): Promise<{ allow: boolean; reason: string }> {
    return waitForApproval(job, question, timeoutMs, (body) => this.post(job, body), this.log, this.storePath ? dirname(this.storePath) : undefined, request);
  }

  /**
   * A message the running subagent sent to this session. An answer (to a live message, or marked as a reply)
   * wakes the session; a note it sends on its own ("tests pass, merging next") does not: it waits for the
   * session's next prompt or tool call, so status chatter costs no extra turn.
   */
  fromSubagent(job: Job, body: string, replyTo: string | null, isAnswer = false): void {
    const answer = isAnswer || replyTo !== null || job.awaitingAnswer === true;
    job.awaitingAnswer = false;
    this.log.info("message from subagent", { job: job.name, note: !answer });
    const id = this.post(job, body, replyTo);
    if (!answer) {
      this.notes.add(id);
      if (this.notes.size > MAX_NOTES) this.notes.delete(this.notes.values().next().value!);
    }
  }

  /** Whether a message is a running subagent's own status note (it should not wake the session). */
  isNote(m: Pick<BridgeMessage, "id" | "conversationId">): boolean {
    // A job runner marks its notes in the conversation id (they reach this session over the bridge).
    return this.notes.has(m.id) || m.conversationId.endsWith(NOTE_CONVERSATION_SUFFIX);
  }

  private post(job: Job, body: string, replyTo: string | null = null): string {
    const m: BridgeMessage = {
      id: randomUUID(),
      from: { id: `job:${job.id}`, name: job.name, agent: job.agent },
      to: this.node.name,
      recipient: this.node.name,
      conversationId: `job-${job.id}`,
      replyTo,
      hop: 0,
      body,
      createdAt: Date.now(),
      readAt: null,
    };
    this.node.deliverLocal(m);
    return m.id;
  }
}

/** Failed runs often still have a session (timeouts, aborts, errors after progress): keep it for recovery. */
export function sessionOfError(err: unknown): string | null {
  return err instanceof DelegateError ? (err.sessionId ?? null) : null;
}

type StoredJob = Pick<Job, "id" | "name" | "agent" | "model" | "prompt" | "startedAt" | "status" | "sessionId" | "workdir" | "worktree" | "args" | "owner" | "supervisor" | "finishedAt" | "host">;

function toStored(j: Job): StoredJob {
  return {
    id: j.id,
    name: j.name,
    agent: j.agent,
    model: j.model,
    prompt: j.prompt,
    startedAt: j.startedAt,
    status: j.status,
    sessionId: j.sessionId,
    workdir: j.workdir,
    worktree: j.worktree,
    args: j.args,
    owner: j.owner,
    supervisor: j.supervisor,
    finishedAt: j.finishedAt,
    host: j.host ?? null,
  };
}

function isStoredJob(j: unknown): j is StoredJob {
  return isRecord(j) && typeof j.id === "string" && typeof j.name === "string";
}

export function readJobsDocument(path: string, log?: Logger): unknown {
  return readJsonStore(path, log, (data) => Array.isArray(data) || (isRecord(data) && Array.isArray(data.jobs)));
}

export function readStore(path: string, log?: Logger): StoredJob[] {
  try {
    const data = readJobsDocument(path, log);
    const jobs = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.jobs) ? data.jobs : [];
    return jobs.filter(isStoredJob);
  } catch (err) {
    log?.warn("could not read jobs store", { path, err: String(err) });
    return [];
  }
}

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 20;

/**
 * Serialize read-merge-write of the job store across sessions (processes). Returns the release function.
 * Gives up waiting after a short time (saving is best effort) and breaks locks left by a crashed process.
 */
function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      closeSync(openSync(path, "wx"));
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { force: true });
      } catch {
        // gone meanwhile
      }
      if (Date.now() > deadline) throw new Error("timed out locking jobs store");
      Atomics.wait(pause, 0, 0, LOCK_RETRY_MS);
    }
  }
}
