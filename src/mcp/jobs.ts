import { randomUUID } from "node:crypto";
import { MAX_RUNNING_JOBS } from "../core/constants.js";
import { DelegateError, type DelegateResult } from "../core/delegate.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import type { AgentKind, BridgeMessage } from "../core/protocol.js";

const JOB_ID_LENGTH = 8;
const PROMPT_PREVIEW_CHARS = 120;
/** Finished subagents stay addressable (message_subagent) for this many jobs. */
const HISTORY_LIMIT = 50;
/** Follow-up sent when a subagent is resumed without a message (e.g. after a failure). */
export const DEFAULT_FOLLOW_UP = "Continue where you stopped and finish the task. Then give your final answer.";

/** A delegated run's result, plus the folder it worked in (a worktree, for example). */
export type RunResult = DelegateResult & { workdir?: string };
export type Run = (signal: AbortSignal, onProgress: (message: string, full?: string) => void) => Promise<RunResult>;
/** Continue a subagent's own session with a new message (same agent, model, access and folder). */
export type Resume = (message: string, sessionId: string, workdir: string | null) => Run;

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
  status: "running" | "done" | "failed";
  /** The subagent's own session (Codex thread, Claude session, opencode session) once known. */
  sessionId: string | null;
  workdir: string | null;
  resume?: Resume;
  /** Follow-ups that arrived while the job was running; sent as soon as it finishes. */
  queue: string[];
  finishedAt?: number;
}

export type FollowUpOutcome = "started" | "queued" | "unknown" | "no-session" | "busy";

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
  ) {}

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
      .filter((j) => j.status !== "running")
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
  }

  private newJob(agent: AgentKind, model: string | null, prompt: string, kind: "job" | "ask", resume?: Resume): Job {
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
      resume,
      queue: [],
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
  ): { job: Job; onProgress: (message: string) => void; end: (outcome?: { result?: RunResult; error?: unknown }) => void } {
    const job = { ...this.newJob(agent, model, prompt, "ask", resume), foreground: true };
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
      },
    };
  }

  canStart(): boolean {
    return this.running.size < MAX_RUNNING_JOBS;
  }

  start(agent: AgentKind, model: string | null, prompt: string, run: Run, resume?: Resume): Job {
    const job = this.newJob(agent, model, prompt, "job", resume);
    this.remember(job);
    this.log.info("subagent started", { job: job.name, model, prompt: prompt.slice(0, PROMPT_PREVIEW_CHARS) });
    this.launch(job, run);
    return job;
  }

  /** Send a follow-up to a subagent: queued while it runs, otherwise its session is resumed in the background. */
  followUp(ref: string, message: string): { outcome: FollowUpOutcome; job?: Job } {
    const job = this.find(ref);
    if (!job) return { outcome: "unknown" };
    if (job.status === "running") {
      job.queue.push(message);
      return { outcome: "queued", job };
    }
    if (!job.resume || !job.sessionId) return { outcome: "no-session", job };
    if (!this.canStart()) return { outcome: "busy", job };
    this.log.info("subagent resumed", { job: job.name, sessionId: job.sessionId });
    this.launch(job, job.resume(message, job.sessionId, job.workdir));
    return { outcome: "started", job };
  }

  private launch(job: Job, run: Run): void {
    job.status = "running";
    job.startedAt = Date.now();
    job.controller = new AbortController();
    job.progress = null;
    job.foreground = false;
    this.running.set(job.id, job);
    const onProgress = (message: string) => {
      job.progress = message;
      this.log.debug("subagent progress", { job: job.name, message });
    };
    run(job.controller.signal, onProgress).then(
      (res) => {
        job.workdir = res.workdir ?? job.workdir;
        this.finish(job, res.isError ? "failed" : "done", res.text || "(no answer text returned)", res.sessionId);
      },
      (err) => this.finish(job, "failed", String((err as Error)?.message ?? err), sessionOfError(err)),
    );
  }

  cancel(id: string): boolean {
    const job = this.running.get(id) ?? [...this.running.values()].find((j) => j.name === id);
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
    const seconds = Math.round((Date.now() - job.startedAt) / 1000);
    this.log.info("subagent finished", { job: job.name, status, seconds, sessionId: job.sessionId });

    // Follow-ups that arrived meanwhile go out right away, into the same session.
    if (job.queue.length && job.resume && job.sessionId && !job.controller.signal.aborted) {
      const queued = job.queue.splice(0).join("\n\n");
      this.post(job, `${this.header(job, status, seconds)}\n\n${text}\n\n(Your queued follow-up was sent to it; its answer will arrive as another message.)`);
      this.launch(job, job.resume(queued, job.sessionId, job.workdir));
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

  private post(job: Job, body: string): void {
    const m: BridgeMessage = {
      id: randomUUID(),
      from: { id: `job:${job.id}`, name: job.name, agent: job.agent },
      to: this.node.name,
      recipient: this.node.name,
      conversationId: `job-${job.id}`,
      replyTo: null,
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
