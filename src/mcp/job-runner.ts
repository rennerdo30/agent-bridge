import { randomUUID } from "node:crypto";
import { archiveFile, assertWritableStore, readJsonStore } from "../core/json-store.js";
import { failureCause } from "../core/delegate.js";
import { createLogger } from "../core/logger.js";
import { BridgeNode } from "../core/node.js";
import { resolveDbPath, resolvePipePath } from "../core/paths.js";
import { loadOrCreateToken } from "../core/token.js";
import { SIBLING_CONVERSATION_PREFIX } from "../core/protocol.js";
import { resumeArgs, runDelegate, type JobSink, type RunContext } from "./delegate-run.js";
import { CONTROL_CONVERSATION_PREFIX, JOB_PEER_PREFIX, RUNNER_HEARTBEAT_MS, writeRunnerState, type RunnerSpec } from "./job-host.js";
import { jobReport, NOTE_CONVERSATION_SUFFIX, QUEUED_FOLLOW_UP_NOTE, sessionOfError, waitForApproval, type Job, type RunnerControl, type RunnerState } from "./jobs.js";
import { changedJobArgs } from "./job-settings.js";
import { notifyJobEvent } from "../core/notifications.js";

/** Delivering a message to the session: tries for several minutes (the bridge may be changing hands, or no session hosts it). */
const SEND_ATTEMPTS = 30;
const SEND_RETRY_MAX_MS = 10_000;
/** Progress lines come fast: the state file is written at most this often for them. */
const PROGRESS_SAVE_MS = 1_000;
/** Forwarded message ids remembered in the state file. */
const SEEN_LIMIT = 100;
/** After SIGTERM, a runner that has not wound down by then exits anyway. */
const STOP_DEADLINE_MS = 15_000;

/**
 * `agent-bridge job-runner <spec>`: runs one background job, detached from the session's MCP server (see
 * job-host.ts). It runs the turn the server asked for, then the follow-ups that arrive while it runs, and
 * reports each turn to the session as a message from the job. It exits when the job has nothing left to do.
 */
export async function runJobRunner(specFile: string | undefined): Promise<number> {
  if (!specFile) return 2;
  const data = readJsonStore(specFile);
  assertWritableStore(data);
  if (!data) return 2;
  const spec = data as unknown as RunnerSpec;
  archiveFile(specFile);
  const { home, target } = spec;
  const log = createLogger({ home, component: "job-runner" }).child(spec.job.name);
  const job: Job = {
    ...spec.job,
    controller: new AbortController(),
    progress: null,
    status: "running",
    queue: [],
    allowedServers: new Set(spec.job.allowedServers),
  };
  let owner = spec.owner;
  const seen: string[] = [];
  /** The final report is decided: messages arriving now are left to the session (it continues the job). */
  let closing = false;

  let extra: Partial<RunnerState> = { status: "running" };
  const save = (patch: Partial<RunnerState> = {}) => {
    extra = { ...extra, ...patch };
    try {
      writeRunnerState(home, job.id, {
        pid: process.pid,
        peer: node.name,
        status: "running",
        ...extra,
        updatedAt: Date.now(),
        model: job.model,
        sessionId: job.sessionId,
        workdir: job.workdir,
        worktree: job.worktree,
        progress: job.progress,
        percent: job.percent,
        progressNote: job.progressNote,
        asking: Boolean(job.pendingApproval),
        live: Boolean(job.live),
        seen: seen.slice(-SEEN_LIMIT),
      });
    } catch (err) {
      log.warn("could not write the job runner state", { err: (err as Error).message });
    }
  };

  const node = new BridgeNode({
    pipePath: resolvePipePath(home),
    token: loadOrCreateToken(home),
    dbPath: resolveDbPath(home),
    // "other" keeps an older broker from routing "any codex" mail here; a current one hides the runner anyway.
    agent: "other",
    jobAgent: job.agent,
    jobOwner: job.supervisor ?? job.owner ?? owner,
    jobParent: owner,
    jobTitle: typeof job.args?.title === "string" ? job.args.title : spec.args.title,
    id: `${JOB_PEER_PREFIX}${job.id}`,
    name: job.name,
    cwd: spec.cwd,
    autoWake: false,
    // A session hosts the bridge; without one, messages wait here (and the report in the state file).
    canHostBroker: false,
    log,
  });
  save();
  const heartbeat = setInterval(() => save(), RUNNER_HEARTBEAT_MS);
  log.info("job runner started", { pid: process.pid, target, owner });

  // Messages to the session, in order. Each is tried until the bridge takes it (the session may be offline:
  // then it waits in the store for the session's next server).
  let chain: Promise<boolean> = Promise.resolve(true);
  const deliver = async (body: string, replyTo: string | null, note = false): Promise<boolean> => {
    // One key for all attempts: a send that timed out here may still be queued at a slow broker.
    const dedupeKey = randomUUID();
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
      try {
        await node.send({ to: owner, body, conversationId: `job-${job.id}${note ? NOTE_CONVERSATION_SUFFIX : ""}`, ...(replyTo ? { replyTo } : {}), dedupeKey }, { quiet: true });
        return true;
      } catch (err) {
        log.warn("could not deliver to the session; retrying", { owner, attempt, err: (err as Error).message });
        await new Promise((r) => setTimeout(r, Math.min(attempt * 1_000, SEND_RETRY_MAX_MS)));
      }
    }
    return false;
  };
  const post = (body: string, replyTo: string | null = null, note = false): Promise<boolean> => (chain = chain.then(() => deliver(body, replyTo, note)));

  const sink: JobSink = {
    askParent: (j, question, timeoutMs, request) => {
      const answer = waitForApproval(j, question, timeoutMs, (body) => void post(body), log, home, request);
      save();
      return answer.finally(() => save());
    },
    // Its own status notes do not wake the session (see JobManager.fromSubagent); answers and replies do.
    fromSubagent: (j, body, replyTo, isAnswer) => {
      const answer = Boolean(isAnswer) || replyTo !== null || j.awaitingAnswer === true;
      j.awaitingAnswer = false;
      void post(body, replyTo, !answer);
    },
    note: (j, facts) => {
      if (facts.sessionId) j.sessionId = facts.sessionId;
      if (facts.workdir) j.workdir = facts.workdir;
      if (facts.worktree) j.worktree = facts.worktree;
      save();
    },
  };

  node.on("message", (m) => {
    // Direct sibling chat is handled by the current turn's SiblingLink, never as supervisor control.
    if (m.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX)) return;
    node.markRead([m.id]);
    if (!m.conversationId.startsWith(CONTROL_CONVERSATION_PREFIX)) {
      log.info("ignoring a message that is not from the job's session", { from: m.from.name });
      return;
    }
    let c: RunnerControl;
    try {
      c = JSON.parse(m.body) as RunnerControl;
    } catch {
      return;
    }
    // The session may be a new server now, maybe under another name: answer where it is.
    if (m.from.name !== owner) log.info("the job's session is now", { name: m.from.name, was: owner });
    owner = m.from.name;
    void node.updateJob({ jobParent: owner }).catch(() => {});
    if (c.type === "message") {
      if (closing) return;
      seen.push(c.cid);
      if (job.pendingApproval) {
        const answer = job.pendingApproval;
        job.pendingApproval = null;
        answer(c.body, `session ${owner}`);
      } else if (job.live) {
        job.awaitingAnswer = true;
        job.live.post(c.body);
      }
      else job.queue.push(c.body);
      save();
    } else if (c.type === "title") {
      job.args = { ...job.args, title: c.title };
      job.retitle?.(c.title);
    } else if (c.type === "effort") {
      // From the next turn on (a running turn keeps its level).
      job.args = { ...job.args, effort: c.effort };
      save();
    } else if (c.type === "settings") {
      job.args = changedJobArgs(job.args, c.settings);
      save();
    } else if (c.type === "cancel") {
      log.info("cancelled by the session");
      job.queue = [];
      job.controller.abort();
    }
  });
  const stop = () => {
    job.queue = [];
    job.controller.abort();
    setTimeout(() => process.exit(1), STOP_DEADLINE_MS).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  void node.start().catch((err) => log.warn("could not join the bridge yet; retrying in the background", { err: (err as Error).message }));

  let saveTimer: NodeJS.Timeout | null = null;
  const onProgress = (message: string) => {
    job.progress = message;
    saveTimer ??= setTimeout(() => {
      saveTimer = null;
      save();
    }, PROGRESS_SAVE_MS);
  };
  const rc: RunContext = { agent: spec.byAgent, cfg: spec.cfg, home, log, me: () => owner, cwd: () => spec.cwd, jobs: sink, jobNode: node };

  let args = spec.args;
  for (;;) {
    let status: "done" | "failed";
    let text = "";
    let cause: string | null = null;
    try {
      const res = await runDelegate(rc, target, args, job.controller.signal, onProgress, true, job);
      job.workdir = res.workdir ?? job.workdir;
      job.worktree = res.worktree ?? job.worktree;
      job.sessionId = res.sessionId ?? job.sessionId;
      status = res.isError ? "failed" : "done";
      text = res.text || "(no answer text returned)";
      cause = res.isError ? failureCause({ result: res }) : null;
    } catch (err) {
      job.sessionId = sessionOfError(err) ?? job.sessionId;
      status = "failed";
      cause = failureCause({ error: err });
    }
    const report = jobReport(job, status, Math.round((Date.now() - job.startedAt) / 1000), text, cause);
    log.info("job turn finished", { status, sessionId: job.sessionId, cause });
    notifyJobEvent(home, status === "done" ? "finish" : "fail", log);
    // Follow-ups that arrived meanwhile go out right away, into the same session, from this runner.
    if (job.queue.length && job.sessionId && !job.controller.signal.aborted) {
      const queued = job.queue.splice(0).join("\n\n");
      void post(`${report}\n\n${QUEUED_FOLLOW_UP_NOTE}`);
      args = resumeArgs(spec.base, job.name, queued, job.sessionId, job.workdir, job.worktree, job.args);
      if (args.model !== undefined) job.model = args.model;
      job.startedAt = Date.now();
      job.progress = null;
      save();
      continue;
    }
    closing = true;
    if (saveTimer) clearTimeout(saveTimer);
    // The state first: once the report arrives, the session must find the job finished.
    save({ status, report, delivered: false, finishedAt: Date.now() });
    const delivered = await post(report);
    save({ delivered });
    log.info("job runner done", { status, delivered });
    break;
  }
  clearInterval(heartbeat);
  await node.stop();
  return 0;
}
