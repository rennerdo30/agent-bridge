import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { DEFAULT_DELEGATE_TIMEOUT_SEC } from "../core/constants.js";
import type { BridgeNode } from "../core/node.js";
import type { CodingAgent } from "../core/protocol.js";
import { REMOTE_JOB_POLL_MS, remoteSpawnArgsSchema } from "../network/remote-job-protocol.js";
import type { DelegateArgs } from "./delegate-run.js";
import type { Job, RunResult } from "./jobs.js";

/** Blocking remote asks still use the remote detached runner and publish approvals to the supervisor. */
export async function runRemoteAsk(node: BridgeNode, target: CodingAgent, args: DelegateArgs, job: Job, signal: AbortSignal, onProgress: (message: string) => void): Promise<RunResult> {
  const host = args.host!;
  const raw = { ...args, timeout_sec: args.timeout_sec ?? DEFAULT_DELEGATE_TIMEOUT_SEC };
  delete raw.host;
  delete raw.send_to;
  job.remote = { host, name: `${target}-job-${job.id}` };
  const cancel = () => { void node.remoteJob(host, { op: "control", job: job.id, control: { type: "cancel" } }).catch(() => {}); };
  const combined = AbortSignal.any([signal, job.controller.signal]);
  combined.addEventListener("abort", cancel, { once: true });
  try {
    let snapshot = await node.remoteJob(host, { op: "spawn", job: job.id, target, args: remoteSpawnArgsSchema.parse(raw) });
    if (combined.aborted) { cancel(); combined.throwIfAborted(); }
    job.remoteControl = (control) => { void node.remoteJob(host, { op: "control", job: job.id, control }).catch(() => {}); };
    job.live = { post: (body) => { void node.remoteJob(host, { op: "control", job: job.id, control: { type: "message", body, cid: randomUUID() } }).catch(() => {}); } };
    for (;;) {
      combined.throwIfAborted();
      const state = snapshot.state;
      if (state?.progress) onProgress(state.progress);
      if (state) { job.sessionId = state.sessionId ?? job.sessionId; job.workdir = state.workdir ?? job.workdir; job.worktree = state.worktree ?? job.worktree; }
      if (state && state.status !== "running" && !snapshot.alive) return { text: state.report ?? "Remote job ended without a report.", sessionId: state.sessionId ?? null, isError: state.status !== "done", status: state.status, details: {}, workdir: state.workdir ?? undefined, worktree: state.worktree ?? undefined };
      if (!snapshot.alive) throw new Error("Remote job runner ended without a result.");
      await delay(REMOTE_JOB_POLL_MS, undefined, { signal: combined });
      snapshot = await node.remoteJob(host, { op: "state", job: job.id });
    }
  } finally { combined.removeEventListener("abort", cancel); job.live = null; job.remoteControl = undefined; }
}
