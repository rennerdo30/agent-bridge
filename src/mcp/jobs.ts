import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_MAX_JOBS } from "../core/constants.js";
import { DelegateError, type DelegateResult } from "../core/delegate.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import type { AgentKind, BridgeMessage } from "../core/protocol.js";
import type { Worktree } from "../core/worktree.js";

const JOB_ID_LENGTH = 8;
const PROMPT_PREVIEW_CHARS = 120;
/** Finished subagents stay addressable (message_subagent) for this many jobs. */
const HISTORY_LIMIT = 50;
/** Jobs kept on disk (all sessions together), and how much of each task: the file stays small. */
const STORE_LIMIT = 200;
const STORED_PROMPT_CHARS = 1_000;
/** Follow-up sent when a subagent is resumed without a message (e.g. after a failure). */
export const DEFAULT_FOLLOW_UP = "Continue where you stopped and finish the task. Then give your final answer.";

/** A delegated run's result, plus the folder it worked in (a worktree, for example). */
export type RunResult = DelegateResult & { workdir?: string; worktree?: Worktree };
/** Runs a subagent turn; `job` is the job it belongs to (its name labels the run in the dashboard). */
export type Run = (signal: AbortSignal, onProgress: (message: string, full?: string) => void, job: Job) => Promise<RunResult>;
/** Continue a subagent's own session with a new message (same agent, model, access and folder). */
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
  /** The options it was started with (access, model, folder, ...), to continue it the same way after a restart. */
  args?: Record<string, unknown>;
  /** Peer name of the session that started it. */
  owner?: string;
  /** The subagent's own session (Codex thread, Claude session, opencode session) once known. */
  sessionId: string | null;
  workdir: string | null;
  worktree: Worktree | null;
  resume?: Resume;
  /** Follow-ups that arrived while the job was running; sent as soon as it finishes. */
  queue: string[];
  /** An approval question the subagent is waiting on; the next message to the job answers it. */
  pendingApproval?: ((answer: string) => void) | null;
  /** While it runs: delivers a message into the running subagent (see parent-link.ts). */
  live?: { post: (message: string) => void } | null;
  finishedAt?: number;
}

export type FollowUpOutcome = "started" | "delivered" | "queued" | "answered" | "unknown" | "no-session" | "busy";

/**
 * Subagents: the other CLI running headlessly. Background jobs report their result as a message from the
 * job's pseudo peer. Every job keeps its session, so it can be continued later with its full context
 * (message_subagent), like a native subagent: follow-ups to a running job are queued.
 */
export class JobManager {
  private readonly running = new Map<string, Job>();
  private readonly foreground = new Map<string, Job>();
  private readonly history = new Map<string, Job>();

  constructor(
    private readonly node: BridgeNode,
    private readonly log: Logger,
    /** Where jobs are kept across restarts of the session (~/.agent-bridge/jobs.json); none in tests. */
    private readonly storePath: string | null = null,
    /** Background subagents running at once (config maxJobs). */
    readonly maxJobs: number = DEFAULT_MAX_JOBS,
  ) {}

  /** Save this session's jobs, merged with those other sessions saved. Best effort: never breaks a run. */
  persist(): void {
    if (!this.storePath) return;
    const lock = acquireLock(`${this.storePath}.lock`);
    try {
      const mine = [...this.history.values()].map(toStored);
      const ids = new Set(mine.map((j) => j.id));
      const others = readStore(this.storePath).filter((j) => !ids.has(j.id));
      const all = [...others, ...mine].sort((a, b) => a.startedAt - b.startedAt).slice(-STORE_LIMIT);
      mkdirSync(dirname(this.storePath), { recursive: true });
      const tmp = `${this.storePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
      renameSync(tmp, this.storePath);
    } catch (err) {
      this.log.warn("could not save subagent jobs", { err: (err as Error).message });
    } finally {
      lock();
    }
  }

  /**
   * Load the jobs saved before this session (re)started, so message_subagent can continue them with their
   * context. Jobs that were still running are marked interrupted: a follow-up without a message recovers them.
   */
  restore(makeResume: (agent: AgentKind, args: Record<string, unknown>) => Resume | undefined): void {
    if (!this.storePath) return;
    const stored = readStore(this.storePath);
    for (const s of stored.slice(-HISTORY_LIMIT)) {
      if (this.history.has(s.id)) continue;
      this.history.set(s.id, {
        ...s,
        status: s.status === "running" ? "interrupted" : s.status,
        controller: new AbortController(),
        progress: null,
        queue: [],
        resume: makeResume(s.agent, s.args ?? {}),
      });
    }
    if (stored.length) this.log.info("restored subagent jobs", { count: Math.min(stored.length, HISTORY_LIMIT) });
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
    return [...this.running.values(), ...this.foreground.values()];
  }

  /** Recently finished subagents, newest first (they can still be messaged). */
  recent(limit = 5): Job[] {
    return [...this.history.values()]
      .filter((j) => j.status !== "running" && (!j.owner || j.owner === this.node.name))
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      .slice(0, limit);
  }

  find(ref: string): Job | undefined {
    const id = ref.replace(/^.*-(?:job|ask)-/, "");
    return this.history.get(id) ?? [...this.history.values()].find((j) => j.name === ref);
  }

  private remember(job: Job): void {
    this.history.set(job.id, job);
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
        this.foreground.delete(job.id);
        job.foreground = false;
        job.finishedAt = Date.now();
        job.status = outcome?.result && !outcome.result.isError ? "done" : "failed";
        job.sessionId = outcome?.result?.sessionId ?? sessionOfError(outcome?.error) ?? job.sessionId;
        job.workdir = outcome?.result?.workdir ?? job.workdir;
        job.worktree = outcome?.result?.worktree ?? job.worktree;
        this.persist();
        // Follow-ups sent while the caller waited continue the session in the background.
        if (job.queue.length && job.resume && job.sessionId && !job.controller.signal.aborted) {
          this.launch(job, job.resume(job.queue.splice(0).join("\n\n"), job.sessionId, job.workdir, job.worktree));
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

  /** Send a follow-up to a subagent: queued while it runs, otherwise its session is resumed in the background. */
  followUp(ref: string, message: string): { outcome: FollowUpOutcome; job?: Job } {
    const job = this.find(ref);
    if (!job) return { outcome: "unknown" };
    if (job.status === "running" && job.pendingApproval) {
      const answer = job.pendingApproval;
      job.pendingApproval = null;
      answer(message);
      return { outcome: "answered", job };
    }
    if (job.status === "running") {
      // Like a native subagent: it sees the message while it works and can answer at once.
      if (job.live) {
        job.live.post(message);
        return { outcome: "delivered", job };
      }
      job.queue.push(message);
      return { outcome: "queued", job };
    }
    if (!job.resume || !job.sessionId) return { outcome: "no-session", job };
    if (!this.canStart()) return { outcome: "busy", job };
    this.log.info("subagent resumed", { job: job.name, sessionId: job.sessionId });
    this.launch(job, job.resume(message, job.sessionId, job.workdir, job.worktree));
    return { outcome: "started", job };
  }

  private launch(job: Job, run: Run): void {
    job.status = "running";
    job.startedAt = Date.now();
    job.controller = new AbortController();
    job.progress = null;
    job.foreground = false;
    this.running.set(job.id, job);
    this.persist();
    const onProgress = (message: string) => {
      job.progress = message;
      this.log.debug("subagent progress", { job: job.name, message });
    };
    run(job.controller.signal, onProgress, job).then(
      (res) => {
        job.workdir = res.workdir ?? job.workdir;
        job.worktree = res.worktree ?? job.worktree;
        this.finish(job, res.isError ? "failed" : "done", res.text || "(no answer text returned)", res.sessionId);
      },
      (err) => this.finish(job, "failed", String((err as Error)?.message ?? err), sessionOfError(err)),
    );
  }

  /** Cancel a background job or a blocking ask_* run, by name or id. */
  cancel(ref: string): boolean {
    const id = ref.replace(/^.*-(?:job|ask)-/, "");
    const job = [...this.running.values(), ...this.foreground.values()].find((j) => j.id === id || j.name === ref);
    if (!job) return false;
    job.queue = [];
    job.controller.abort();
    return true;
  }

  cancelAll(): void {
    for (const j of this.running.values()) j.controller.abort();
  }

  private finish(job: Job, status: "done" | "failed", text: string, sessionId: string | null): void {
    this.running.delete(job.id);
    job.status = status;
    job.finishedAt = Date.now();
    job.sessionId = sessionId ?? job.sessionId;
    this.persist();
    const seconds = Math.round((Date.now() - job.startedAt) / 1000);
    this.log.info("subagent finished", { job: job.name, status, seconds, sessionId: job.sessionId });

    // Follow-ups that arrived meanwhile go out right away, into the same session.
    if (job.queue.length && job.resume && job.sessionId && !job.controller.signal.aborted) {
      const queued = job.queue.splice(0).join("\n\n");
      this.post(job, `${this.header(job, status, seconds)}\n\n${text}\n\n(Your queued follow-up was sent to it; its answer will arrive as another message.)`);
      this.launch(job, job.resume(queued, job.sessionId, job.workdir, job.worktree));
      return;
    }
    this.post(job, `${this.header(job, status, seconds)}\n\n${text}`);
  }

  private header(job: Job, status: string, seconds: number): string {
    const how = job.sessionId
      ? status === "failed"
        ? ` To recover it with its context, call message_subagent(job="${job.name}") (optionally with a message).`
        : ` Continue it with its context: message_subagent(job="${job.name}", message=...).`
      : "";
    return `Subagent ${job.name} (${job.agent}${job.model ? `, model ${job.model}` : ""}) ${status} after ${seconds}s.${how}`;
  }

  /**
   * Ask this session's agent to approve something the running subagent wants to do (an MCP tool call, for
   * example). The question arrives as a message from the job; the agent answers with message_subagent.
   * No answer within the time limit counts as "deny".
   */
  askParent(job: Job, question: string, timeoutMs: number): Promise<{ allow: boolean; reason: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (job.pendingApproval !== settle) return;
        job.pendingApproval = null;
        resolve({ allow: false, reason: "no answer in time" });
      }, timeoutMs);
      timer.unref?.();
      const settle = (answer: string) => {
        clearTimeout(timer);
        resolve({ allow: /^\s*(allow|yes|y|approve|approved|ok|okay|go ahead|accept)\b/i.test(answer), reason: answer.trim() });
      };
      job.pendingApproval = settle;
      this.log.info("subagent asks for approval", { job: job.name });
      this.post(
        job,
        `Subagent ${job.name} asks for approval: ${question}\n\n` +
          `Decide as its supervisor: answer with message_subagent(job="${job.name}", message="allow") or message="deny" (a reason may follow). ` +
          `It waits for your answer; no answer within ${Math.round(timeoutMs / 60_000)} minutes counts as deny.`,
      );
    });
  }

  /** A message the running subagent sent to this session (its answer to a live message, for example). */
  fromSubagent(job: Job, body: string, replyTo: string | null): void {
    this.log.info("message from subagent", { job: job.name });
    this.post(job, body, replyTo);
  }

  private post(job: Job, body: string, replyTo: string | null = null): void {
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
  }
}

/** Failed runs often still have a session (timeouts, aborts, errors after progress): keep it for recovery. */
function sessionOfError(err: unknown): string | null {
  return err instanceof DelegateError ? (err.sessionId ?? null) : null;
}

type StoredJob = Pick<Job, "id" | "name" | "agent" | "model" | "prompt" | "startedAt" | "status" | "sessionId" | "workdir" | "worktree" | "args" | "owner" | "finishedAt">;

function toStored(j: Job): StoredJob {
  return {
    id: j.id,
    name: j.name,
    agent: j.agent,
    model: j.model,
    prompt: j.prompt.slice(0, STORED_PROMPT_CHARS),
    startedAt: j.startedAt,
    status: j.status,
    sessionId: j.sessionId,
    workdir: j.workdir,
    worktree: j.worktree,
    args: j.args,
    owner: j.owner,
    finishedAt: j.finishedAt,
  };
}

function readStore(path: string): StoredJob[] {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(data) ? (data as StoredJob[]).filter((j) => j && typeof j.id === "string" && typeof j.name === "string") : [];
  } catch {
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
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return () => {};
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { force: true });
      } catch {
        // gone meanwhile
      }
      if (Date.now() > deadline) return () => {};
      Atomics.wait(pause, 0, 0, LOCK_RETRY_MS);
    }
  }
}