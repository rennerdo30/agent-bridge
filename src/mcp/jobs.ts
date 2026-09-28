import { randomUUID } from "node:crypto";
import { MAX_RUNNING_JOBS } from "../core/constants.js";
import type { DelegateResult } from "../core/delegate.js";
import type { Logger } from "../core/logger.js";
import type { BridgeNode } from "../core/node.js";
import type { AgentKind, BridgeMessage } from "../core/protocol.js";

const JOB_ID_LENGTH = 8;
const PROMPT_PREVIEW_CHARS = 120;

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
}

/**
 * Background subagents: the other CLI running headlessly while this agent keeps working. When a job
 * finishes, its answer lands in this session's inbox as a message from the job's pseudo peer.
 */
export class JobManager {
  private readonly running = new Map<string, Job>();
  private readonly foreground = new Map<string, Job>();

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

  /**
   * Register a blocking ask_* run for visibility in peers. Returns a progress sink and a function to
   * call when the run ends. Foreground runs do not count against the job limit or delay the Stop hook.
   */
  track(agent: AgentKind, model: string | null, prompt: string): { job: Job; onProgress: (message: string) => void; end: () => void } {
    const id = randomUUID().replace(/-/g, "").slice(0, JOB_ID_LENGTH);
    const job: Job = { id, name: `${agent}-ask-${id}`, agent, model, prompt, startedAt: Date.now(), controller: new AbortController(), progress: null, foreground: true };
    this.foreground.set(id, job);
    return {
      job,
      onProgress: (message) => {
        job.progress = message;
      },
      end: () => {
        this.foreground.delete(id);
      },
    };
  }

  canStart(): boolean {
    return this.running.size < MAX_RUNNING_JOBS;
  }

  start(
    agent: AgentKind,
    model: string | null,
    prompt: string,
    run: (signal: AbortSignal, onProgress: (message: string) => void) => Promise<DelegateResult>,
  ): Job {
    const id = randomUUID().replace(/-/g, "").slice(0, JOB_ID_LENGTH);
    const job: Job = { id, name: `${agent}-job-${id}`, agent, model, prompt, startedAt: Date.now(), controller: new AbortController(), progress: null };
    this.running.set(id, job);
    this.log.info("subagent started", { job: job.name, model, prompt: prompt.slice(0, PROMPT_PREVIEW_CHARS) });

    const onProgress = (message: string) => {
      job.progress = message;
      this.log.debug("subagent progress", { job: job.name, message });
    };
    run(job.controller.signal, onProgress).then(
      (res) => this.finish(job, res.isError ? "failed" : "done", res.text || "(no answer text returned)", res.sessionId),
      (err) => this.finish(job, "failed", String((err as Error)?.message ?? err), null),
    );
    return job;
  }

  cancel(id: string): boolean {
    const job = this.running.get(id) ?? [...this.running.values()].find((j) => j.name === id);
    if (!job) return false;
    job.controller.abort();
    return true;
  }

  cancelAll(): void {
    for (const j of this.running.values()) j.controller.abort();
  }

  private finish(job: Job, status: "done" | "failed", text: string, sessionId: string | null): void {
    this.running.delete(job.id);
    const seconds = Math.round((Date.now() - job.startedAt) / 1000);
    this.log.info("subagent finished", { job: job.name, status, seconds, sessionId });
    const header =
      `Subagent ${job.name} (${job.agent}${job.model ? `, model ${job.model}` : ""}) ${status} after ${seconds}s.` +
      (sessionId ? ` session_id=${sessionId} (pass it to ask_${job.agent} or spawn_${job.agent} to continue).` : "");
    const m: BridgeMessage = {
      id: randomUUID(),
      from: { id: `job:${job.id}`, name: job.name, agent: job.agent },
      to: this.node.name,
      recipient: this.node.name,
      conversationId: `job-${job.id}`,
      replyTo: null,
      hop: 0,
      body: `${header}\n\n${text}`,
      createdAt: Date.now(),
      readAt: null,
    };
    this.node.deliverLocal(m);
  }
}
