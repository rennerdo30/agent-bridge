import { assertRunnerArchiveAdmission, readRunnerStateRecord, runnerLedgerNamespace } from "../core/runner-store.js";
import { ProjectGroups } from "../core/project-groups.js";
import { worktreeProcesses, worktreeProcessReport } from "../core/worktree-processes.js";
import { canControlJob } from "../core/job-ownership.js";
import { join } from "node:path";
import { JOBS_FILE } from "../core/constants.js";
import { readStore } from "./jobs.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { settleUsageAttempt, usageRefused, usageSubmissionReceipt } from "../core/usage.js";
import { completionMessageId, COMPLETION_DEDUPE_PREFIX } from "../core/completion.js";
import { takeRunnerSpec } from "../core/runner-store.js";
import { failureCause } from "../core/delegate.js";
import { createLogger } from "../core/logger.js";
import { BridgeNode } from "../core/node.js";
import { resolveDbPath, resolvePipePath } from "../core/paths.js";
import { quarantineMessage, quarantineTextAsync } from "../core/oversize.js";
import { loadOrCreateToken } from "../core/token.js";
import { ACK_CONVERSATION_SUFFIX, QUESTION_CONVERSATION_SUFFIX, SIBLING_CONVERSATION_PREFIX, type BridgeMessage, type SendResult } from "../core/protocol.js";
import type { ParentRoute } from "../core/parent-link.js";
import { isPureAcknowledgement } from "../core/job-messaging.js";
import { resumeArgs, runDelegate, type JobSink, type RunContext } from "./delegate-run.js";
import { CONTROL_CONVERSATION_PREFIX, JOB_PEER_PREFIX, RUNNER_HEARTBEAT_MS, readRunnerState, writeRunnerState, type RunnerSpec } from "./job-host.js";
import { jobReport, NOTE_CONVERSATION_SUFFIX, PAUSE_HELD_NOTE, PAUSE_RACE_NOTE, pauseReasonText, QUEUED_FOLLOW_UP_NOTE, sessionOfError, waitForApproval, type Job, type RunnerControl, type RunnerState } from "./jobs.js";
import { changedJobArgs } from "./job-settings.js";
import { processCleanupReport, establishWindowsJobScope, type WindowsJobScope } from "../core/windows-job-scope.js";
import type { Logger } from "../core/logger.js";
import { closeJobWorktree } from "../core/job-close.js";
import { recordWorktreeProcessProofWithRetry } from "../core/worktree-state.js";
import { acquireStartup } from "../core/startup-admission.js";
import { refreshStorePeerIdentities } from "../core/store-compatibility.js";
import { guardRunnerErrors } from "./job-runner-errors.js";
import { configurePathDisplay } from "../core/display-paths.js";
import { compatibleDeliveryHandover, deliverFinalResult, permanentDeliveryRefusal, PERMANENT_DELIVERY_CODES } from "./final-result.js";
import { deliveryFailure, type DeliveryEvidence } from "./delivery-evidence.js";
import { hasUnsettledRunnerRetention, retainRunnerDelivery, runnerLedgerPrincipal, RunnerRetentionUnsettled, RUNNER_LEDGER_MAX_BYTES, RUNNER_LEDGER_MAX_ITEMS, type PendingRunnerRetention, type RunnerDeliveryLedger } from "./runner-delivery-retention.js";

/** Delivering a message to the session: tries for several minutes (the bridge may be changing hands, or no session hosts it). */
const SEND_ATTEMPTS = 30;
/** deliverFinalResult retries a final result itself, with backoff, and then leaves it to the session fallback. */
const FINAL_SEND_ATTEMPTS = 1;
/** Node latches these compatibility refusals; retries cannot heal that connection. */
const NOTE_TERMINAL_CODES: ReadonlySet<string> = new Set(["protocol_mismatch"]);
const SEND_RETRY_MAX_MS = 10_000;
/** Progress lines come fast: the state file is written at most this often for them. */
const PROGRESS_SAVE_MS = 1_000;
/** Forwarded message ids remembered in the state file. */
const SEEN_LIMIT = 100;
/** After SIGTERM, a runner that has not wound down by then exits anyway. */
const STOP_DEADLINE_MS = 15_000;
/**
 * Initial storage admission is bounded before any native turn starts. The host keeps a runner whose PID is
 * known and alive, so a slow admission waits instead of failing the turn (AB-278).
 */
export const INITIAL_STATE_DEADLINE_MS = 5 * 60_000;
const INITIAL_STATE_RETRY_MAX_MS = 2_000;

export async function publishInitialRunnerState(spec: Pick<RunnerSpec, "home" | "job">, log: Logger, deadlineMs = INITIAL_STATE_DEADLINE_MS): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Job runner stopped before initial state publication"));
  const deadline = setTimeout(() => controller.abort(new Error("Job runner initial state publication timed out after waiting for store admission")), deadlineMs);
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  try {
    for (let attempt = 0; ; attempt++) {
      // Cold identity readiness stays a precondition of the first write. A slow or failed identity query (a
      // PowerShell batch on Windows under load) is retried within the deadline instead of failing the turn (AB-278).
      try { await refreshStorePeerIdentities(spec.home, controller.signal); }
      catch (error) {
        controller.signal.throwIfAborted();
        if (attempt === 0 || attempt % 30 === 0) log.info("initial runner state waits for reader identities", { job: spec.job.name, attempt, reason: String(error) });
        await delay(Math.min(INITIAL_STATE_RETRY_MAX_MS, (attempt + 1) * 100), undefined, { signal: controller.signal });
        continue;
      }
      controller.signal.throwIfAborted();
      try {
        // Another runner can publish presence after the asynchronous scan. Keep
        // the compatibility guard authoritative and reverify rather than exit.
        // The actual writer checks existing pending state under its storage
        // boundary. An early convenience read can create metadata/cache absence
        // before a newly published reader reaches that first guarded write.
        writeRunnerState(spec.home, spec.job.id, { pid: process.pid, peer: spec.job.name,
          status: "running", updatedAt: Date.now(), progress: "queued: runner startup admission" }, true);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "STORE_UPGRADE_DEFERRED") throw error;
        if (attempt === 0 || attempt % 30 === 0) log.info("initial runner state waits for retained store readers", { job: spec.job.name, attempt, reason: String(error) });
        await delay(Math.min(INITIAL_STATE_RETRY_MAX_MS, (attempt + 1) * 100), undefined, { signal: controller.signal });
      }
    }
  } finally {
    clearTimeout(deadline);
    process.off("SIGTERM", stop); process.off("SIGINT", stop);
  }
}

/**
 * `agent-bridge job-runner <spec>`: runs one background job, detached from the session's MCP server (see
 * job-host.ts). It runs the turn the server asked for, then the follow-ups that arrive while it runs, and
 * reports each turn to the session as a message from the job. It exits when the job has nothing left to do.
 */
export async function runJobRunner(specFile: string | undefined): Promise<number> {
  if (!specFile) return 2;
  // The spec row (AB-208), or a spec file written by an older server or a fixture. Taken once.
  const data = takeRunnerSpec(specFile);
  if (!data) return 2;
  const spec = data as unknown as RunnerSpec;
  const { home } = spec;
  const log = createLogger({ home, component: "job-runner" }).child(spec.job.name);
  // This is a dedicated runner, never the shared broker/MCP server. Establish ownership
  // before any delegate can create tools, including tools whose intermediate parents exit.
  let scope: WindowsJobScope | null = null;
  const releaseErrorGuards = guardRunnerErrors(log);
  try {
    // This detached runner has a cold process cache. Resolve retained reader generations
    // before its first versioned state write; the broker/election hot paths never await this.
    // Publish the real runner PID before Windows ownership or machine admission can wait.
    await publishInitialRunnerState(spec, log);
    if (process.platform === "win32") {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on("SIGTERM", stop); process.on("SIGINT", stop);
      try {
        const release = await acquireStartup(home, controller.signal, spec.job.name);
        try { controller.signal.throwIfAborted(); scope = await establishWindowsJobScope(log); }
        finally { release(); }
      } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
    }
    return await runOwnedJobRunner(spec, log, scope);
  } catch (error) {
    // The detached runner's stderr is not retained: record why it ends without a report.
    log.error("job runner failed", { err: String((error as Error)?.stack ?? error) });
    throw error;
  } finally {
    try { scope?.detach(); }
    finally { releaseErrorGuards(); }
  }
}

export async function runOwnedJobRunner(spec: RunnerSpec, log: Logger, scope: WindowsJobScope | null): Promise<number> {
  const { home, target } = spec;
  const job: Job = {
    ...spec.job,
    controller: new AbortController(),
    progress: null,
    status: "running",
    queue: [],
    usageQueuedControls: [],
    allowedServers: new Set(spec.job.allowedServers),
  };
  /** The first turn of this runner: pause mail from before it belongs to an earlier runner. */
  const runnerStartedAt = job.startedAt;
  let owner = spec.owner;
  const refreshOwner = () => {
    const saved = readStore(join(home, JOBS_FILE)).find((j) => j.id === job.id);
    if (!saved) return;
    owner = saved.owner ?? owner;
    Object.assign(job, { owner, supervisor: saved.supervisor, parentJob: saved.parentJob, rootSession: saved.rootSession, rootName: saved.rootName,
      ownershipHistory: saved.ownershipHistory, masters: saved.masters, args: { ...job.args, send_to: saved.args?.send_to } });
  };
  const seen: string[] = [];
  /** The final report is decided: messages arriving now are left to the session (it continues the job). */
  let closing = false;

  const previous = readRunnerStateRecord(home, job.id) as unknown as RunnerState | null;
  // Only recover evidence. A restart must not regenerate a note/final UUID or
  // execute a new provider turn while an original accepted item is unsettled.
  const recoveringRetention = hasUnsettledRunnerRetention(previous);
  if (recoveringRetention) {
    log.error("Original runner generation requires owned evidence recovery before admission");
    return 1;
  }
  assertRunnerArchiveAdmission(home, job.id);
  let extra: Partial<RunnerState> = { status: "running" };
  const pendingRetention = new Map<string, PendingRunnerRetention>();
  const shutdown = new AbortController();
  let ledger: RunnerDeliveryLedger = { version: 1, namespace: runnerLedgerNamespace(home, true), generation: randomUUID(), job: job.id, principal: runnerLedgerPrincipal(spec), entries: [] };
  extra.deliveryLedger = ledger;
  let finalQueued = false;
  const deliveryEvidence = (kind: DeliveryEvidence["kind"], stage: DeliveryEvidence["stage"], messageId: string, attempt = 1, error?: unknown) => {
    extra.deliveryEvidence = { kind, stage, messageId, at: Date.now(), attempt, finalQueued, ...(error ? deliveryFailure(error) : {}) };
    // The ordinary heartbeat retains this even if a later busy log tail rolls
    // away. No extra writer/lease on a delivery hot path and no payload/proof.
    try { log.debug("job delivery evidence", extra.deliveryEvidence); } catch { /* Evidence never changes delivery. */ }
  };
  const save = (patch: Partial<RunnerState> = {}, required = false) => {
    extra = { ...extra, ...patch };
    try {
      refreshOwner();
      writeRunnerState(home, job.id, {
        pid: process.pid,
        peer: node.name,
        status: "running",
        ...extra,
        updatedAt: Date.now(),
        model: job.model,
        sessionId: job.sessionId,
        providerUsage: job.providerUsage,
        usageSubmission: usageSubmissionReceipt(job),
        workdir: job.workdir,
        worktree: job.worktree,
        progress: job.progress,
        percent: job.percent,
        progressNote: job.progressNote,
        etaAt: job.etaAt,
        etaReportedAt: job.etaReportedAt,
        asking: Boolean(job.pendingApproval),
        live: Boolean(job.live),
        seen: seen.slice(-SEEN_LIMIT),
      });
    } catch (err) {
      log.warn("could not write the job runner state", { err: (err as Error).message });
      if (required) throw err;
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
    parentJob: job.parentJob,
    rootSession: job.rootSession,
    rootName: job.rootName,
    jobTitle: typeof job.args?.title === "string" ? job.args.title : spec.args.title,
    jobSendTo: spec.args.send_to,
    id: `${JOB_PEER_PREFIX}${job.id}`,
    name: job.name,
    cwd: spec.cwd,
    autoWake: false,
    // A session hosts the bridge; without one, messages wait here (and the report in the state file).
    canHostBroker: false,
    log,
  });
  // Recovery must never republish the old process's creation identity as ours.
  delete extra.identity; delete extra.pid; delete extra.peer; delete extra.updatedAt;
  save();
  const heartbeat = setInterval(() => save(), RUNNER_HEARTBEAT_MS);
  log.info("job runner started", { pid: process.pid, target, owner });

  const retain = async (item: PendingRunnerRetention) => {
    pendingRetention.set(item.messageId, item);
    const count = extra.retainedDeliveryCount ?? 0;
    await retainRunnerDelivery(async () => {
      // A separate durable pending copy protects a crash between fsync/rename
      // and confirmation. Original bytes/UUID/intent are never reconstructed.
      save({ pendingDeliveryRetention: [...pendingRetention.values()], deliveryRetentionFailure: undefined }, true);
      await quarantineTextAsync(home, item.messageId, item.record, () => {
      const beforeLedger = ledger;
      const nextLedger = { ...ledger, entries: ledger.entries.filter(entry => entry.messageId !== item.messageId) };
      try {
        save({ pendingDeliveryRetention: [...pendingRetention.values()].filter(other => other !== item),
          deliveryLedger: nextLedger,
          retainedDeliveryCount: Math.min(65_535, count + 1), deliveryRetentionFailure: undefined }, true);
      } catch (error) {
        extra.pendingDeliveryRetention = [...pendingRetention.values()]; extra.retainedDeliveryCount = count;
        extra.deliveryLedger = beforeLedger;
        throw error;
      }
      ledger = nextLedger;
      pendingRetention.delete(item.messageId);
      });
    }, shutdown.signal, ms => new Promise<void>((resolve, reject) => {
      if (shutdown.signal.aborted) { reject(new RunnerRetentionUnsettled("shutdown")); return; }
      const abort = () => { clearTimeout(timer); reject(new RunnerRetentionUnsettled("shutdown")); };
      const timer = setTimeout(() => { shutdown.signal.removeEventListener("abort", abort); resolve(); }, ms);
      shutdown.signal.addEventListener("abort", abort, { once: true });
    }));
  };

  // Messages to the session, in order. Each is tried until the bridge takes it (the session may be offline:
  // then it waits in the store for the session's next server).
  const prepare = (body: string, replyTo: string | null, note = false, key?: string, question = false, final = false) => {
    // One key for all attempts: a send that timed out here may still be queued at a slow broker.
    const dedupeKey = key ?? randomUUID();
    const intendedOwner = owner, originalBody = body;
    const kind: DeliveryEvidence["kind"] = final ? "final" : question ? "question" : note ? "note" : "message";
    const terminalCodes = final ? PERMANENT_DELIVERY_CODES : note && !question ? NOTE_TERMINAL_CODES : undefined;
    const messageId = final && dedupeKey.startsWith(COMPLETION_DEDUPE_PREFIX) ? completionMessageId(`job:${job.id}`, dedupeKey.slice(COMPLETION_DEDUPE_PREFIX.length)) : completionMessageId(`send:${node.name}`, dedupeKey);
    // AB-380: a body over the message limit can never be sent: once its full text is in a file, send a stub.
    body = quarantineMessage(home, { id: dedupeKey, body }).body;
    const suffix = isPureAcknowledgement(body) ? ACK_CONVERSATION_SUFFIX : question ? QUESTION_CONVERSATION_SUFFIX : note ? NOTE_CONVERSATION_SUFFIX : "";
    const conversationId = `job-${job.id}${suffix}`;
    const item = { messageId, record: JSON.stringify({ version: 1, kind: "accepted-runner-delivery", authority: "evidence-only-no-replay", generation: ledger.generation, namespace: ledger.namespace, senderName: node.name,
      job: job.id, intendedSender: { kind: "job", agent: job.agent, id: `job:${job.id}` }, to: intendedOwner, attemptedTo: intendedOwner,
      body: originalBody, wireBody: body, conversationId, replyTo, note, question, final, dedupeKey, messageId, supervisor: spec.job.supervisor ?? null,
      parentJob: spec.job.parentJob ?? null, rootSession: spec.job.rootSession ?? null }) };
    const existing = ledger.entries.find(entry => entry.messageId === messageId);
    if (existing && existing.record !== item.record) throw new RunnerRetentionUnsettled("invalid-evidence");
    // Admission is synchronous and durable before returning a queue promise.
    // Reserve room for the terminal result; rejected backpressure is not queued.
    if (!existing) {
      const bytes = ledger.entries.reduce((n, entry) => n + Buffer.byteLength(entry.record), 0) + Buffer.byteLength(item.record);
      if (ledger.entries.length >= RUNNER_LEDGER_MAX_ITEMS + (final ? 1 : 0) || bytes > RUNNER_LEDGER_MAX_BYTES - (final ? 0 : 2 * 1024 * 1024))
        throw Object.assign(new Error("Runner delivery admission backpressure; item was not accepted, caller retains its bytes"), { code: "RUNNER_DELIVERY_BACKPRESSURE" });
      ledger = { ...ledger, entries: [...ledger.entries, item] };
    }
    let admissionError: RunnerRetentionUnsettled | undefined;
    try { save({ deliveryLedger: ledger }, true); } catch { admissionError = new RunnerRetentionUnsettled("attempts-exhausted"); }
    return { body, replyTo, note, question, final, kind, messageId, dedupeKey, conversationId, intendedOwner, item, terminalCodes, admissionError };
  };
  const complete = (item: PendingRunnerRetention) => {
    const before = ledger;
    const next = { ...ledger, entries: ledger.entries.filter(entry => entry.messageId !== item.messageId) };
    try { save({ deliveryLedger: next }, true); ledger = next; }
    catch { extra.deliveryLedger = before; throw new RunnerRetentionUnsettled("attempts-exhausted"); }
  };
  const deliver = async (prepared: ReturnType<typeof prepare>): Promise<SendResult | null> => {
    const { body, replyTo, note, question, final, kind, messageId, dedupeKey, conversationId, intendedOwner, item, terminalCodes, admissionError } = prepared;
    if (admissionError) throw admissionError;
    deliveryEvidence(kind, "sending", messageId);
    // deliverFinalResult retries a final result with bounded attempts; a permanent refusal starts the session fallback at once.
    return deliverWithRetry(() => {
      // A retry may cross a handoff or reload. Routing changes never replace the active delegate.
      refreshOwner();
      // A question is marked so the broker can route it to the project main while the parent is offline (AB-249).
      return node.send({ to: intendedOwner, body, conversationId, ...(replyTo ? { replyTo } : {}), dedupeKey }, { quiet: true });
    }, log, owner, final ? FINAL_SEND_ATTEMPTS : SEND_ATTEMPTS, terminalCodes,
    (attempt, error) => deliveryEvidence(kind, (final ? permanentDeliveryRefusal(error) : note && !question && (error as { code?: string })?.code === "protocol_mismatch" && !compatibleDeliveryHandover(error)) ? "refused" : "retrying", messageId, attempt, error))
      .catch(async error => {
        if (error instanceof RunnerRetentionUnsettled) throw error;
        // An exact-version/attestation refusal cannot heal by retrying this
        // connection. Preserve accepted bytes and original intent before letting
        // the final settle. This record grants NO replay or new recipient rights.
        if (final) complete(item); else await retain(item);
        if (final || !note || question || (error as { code?: string })?.code !== "protocol_mismatch") throw error;
        return null;
      })
      .then(async result => {
        if (result?.messages.length) { complete(item); deliveryEvidence(kind, "stored", messageId); }
        else if (ledger.entries.some(entry => entry.messageId === messageId)) { if (final) complete(item); else await retain(item); }
        return result;
      });
  };
  const inOrder = inSendOrder(deliver, error => error instanceof RunnerRetentionUnsettled);
  const post = (body: string, replyTo: string | null = null, note = false, key?: string): Promise<undefined> =>
    inOrder.post(prepare(body, replyTo, note, key));
  /** Send a question and say where the broker put it: the parent, the project main, or a queue. */
  const ask = async (body: string, replyTo: string | null): Promise<ParentRoute> => {
    const result = await inOrder(prepare(body, replyTo, false, undefined, true));
    return questionRoute(result, owner, async (name) => (await node.peers()).some((p) => p.name === name && p.projectMain === true));
  };

  const sink: JobSink = {
    persist: () => save(),
    escalateApproval: async (_job, body) => { await post(body); },
    askParent: (j, question, timeoutMs, request) => {
      const answer = waitForApproval(j, question, timeoutMs, (body) => void post(body), log, home, request);
      save();
      return answer.finally(() => save());
    },
    // Its own status notes do not wake the session (see JobManager.fromSubagent); answers and replies do.
    fromSubagent: (j, body, replyTo, isAnswer, forceNote, question) => {
      const answer = !forceNote && (Boolean(isAnswer) || replyTo !== null || j.awaitingAnswer === true);
      if (!forceNote && !isPureAcknowledgement(body)) j.awaitingAnswer = false;
      if (question && !forceNote && !isPureAcknowledgement(body)) return ask(body, replyTo);
      return post(body, replyTo, !answer);
    },
    note: (j, facts) => {
      if (facts.sessionId) j.sessionId = facts.sessionId;
      if (facts.workdir) j.workdir = facts.workdir;
      if (facts.worktree) j.worktree = facts.worktree;
      save();
    },
  };

  const handleControl = async (m: BridgeMessage) => {
    // Direct sibling chat is handled by the current turn's SiblingLink, never as supervisor control.
    if (m.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX)) return;
    if (!m.conversationId.startsWith(CONTROL_CONVERSATION_PREFIX)) {
      log.warn("unsupported ordinary job mail retained unread", { from: m.from.name, id: m.id });
      return;
    }
    // A remote job's supervisor is fixed by the authenticated spawn, never by an incoming message.
    if (owner.includes("/") && m.from.name !== owner) {
      log.warn("ignoring remote job control from another supervisor", { from: m.from.name });
      return;
    }
    let c: RunnerControl;
    try {
      c = JSON.parse(m.body) as RunnerControl;
    } catch {
      return;
    }
    // A pause holds the job, not one turn: one sent while this runner switched to a queued continuation
    // still applies. Only control mail older than this runner (an earlier runner's turn) is ignored.
    if (c.type === "pause" && !isCurrentRunnerCancel(m.createdAt, runnerStartedAt) || c.type === "cancel" && !isCurrentRunnerCancel(m.createdAt, job.startedAt)) {
      log.info("ignoring cancellation from an earlier job turn", { createdAt: m.createdAt, startedAt: job.startedAt });
      return;
    }
    refreshOwner();
    if (!owner.includes("/") && !canControlJob(job as unknown as Record<string, unknown>, m.from.name)) {
      const peers = await node.peers();
      const master = peers.find((p) => p.name === m.from.name);
      if (!master || !new ProjectGroups(home).canControl(master, job as unknown as Record<string, unknown>, peers)) return;
    }
    // A project master can control the job without becoming its durable primary owner.
    if (m.from.name !== owner) log.info("job control received from another session", { name: m.from.name, owner });
    void node.updateJob({ jobParent: owner }).catch(() => {});
    if (c.type === "message") {
      if (closing) return;
      if (!seen.includes(c.cid)) {
        if (job.live) {
          await inOrder.drain();
          if (closing || job.controller.signal.aborted || shutdown.signal.aborted) throw new RunnerRetentionUnsettled("shutdown");
          job.awaitingAnswer = true;
          job.live.post(c.body, undefined, c.cid);
        }
        else {
          if (job.queue.length >= 128 || Buffer.byteLength(JSON.stringify([[...job.queue, c.body], [...job.usageQueuedControls!, { cid: c.cid, body: c.body }]])) > RUNNER_LEDGER_MAX_BYTES)
            throw new Error("Runner input backpressure; original control remains unread in its owned mailbox");
          job.queue.push(c.body); job.usageQueuedControls!.push({ cid: c.cid, body: c.body });
        }
        seen.push(c.cid);
      }
      // Queued input is accepted only after its exact CID/body is owned in the
      // current generation. A retry of this control reuses the seen CID and
      // repeats confirmation, never appends/executes a second provider turn.
      save(job.queue.length ? { retainedRunnerInputs: { generation: ledger.generation, phase: "pending", bodies: [...job.queue], controls: [...job.usageQueuedControls ?? []] } } : {}, true);
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
      job.pausePending = false;
      job.controller.abort();
      save({ stopping: true });
    } else if (c.type === "pause") {
      // A repeated pause for the same turn changes nothing.
      if (job.pausePending || closing) { node.markRead([m.id]); return; }
      job.pauseReason = pauseReasonText(c.reason);
      job.pausedAt = Date.now();
      job.pausePending = true;
      job.controller.abort();
      save({ stopping: true });
    }
    node.markRead([m.id]);
  };
  let controls: Promise<void> = Promise.resolve();
  const controlRetries = new Map<string, NodeJS.Timeout>();
  const onControl = (m: BridgeMessage) => {
    controls = controls.then(() => handleControl(m)).catch((err) => {
      // EventEmitter does not observe async listener rejections. A broker timeout must never
      // become an unhandled rejection that terminates this runner and its active CLI turn.
      log.warn("job control deferred; active turn kept running", { id: m.id, err: String(err) });
      if (!closing && !controlRetries.has(m.id)) {
        const timer = setTimeout(() => { controlRetries.delete(m.id); onControl(m); }, 1_000);
        timer.unref();
        controlRetries.set(m.id, timer);
      }
    });
  };
  node.on("message", onControl);
  // Runner shutdown (SIGTERM/SIGINT) ends final-result retries; a turn cancel never does.
  let stopTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    shutdown.abort();
    job.queue = [];
    job.controller.abort();
    stopTimer ??= setTimeout(() => {
      if (pendingRetention.size || ledger.entries.length || hasUnsettledRunnerRetention(extra)) {
        save({ pendingDeliveryRetention: [...pendingRetention.values()], deliveryRetentionFailure: "shutdown" });
        log.error("job runner delivery unsettled", { reason: "shutdown", pending: pendingRetention.size });
      }
      process.exit(1);
    }, STOP_DEADLINE_MS);
    stopTimer.unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  if (!recoveringRetention) void node.start().catch((err) => log.warn("could not join the bridge yet; retrying in the background", { err: (err as Error).message }));

  let saveTimer: NodeJS.Timeout | null = null;
  const onProgress = (message: string) => {
    job.progress = message;
    saveTimer ??= setTimeout(() => {
      saveTimer = null;
      save();
    }, PROGRESS_SAVE_MS);
  };
  configurePathDisplay(spec.cfg.pathDisplay ?? { preferAlias: true });
  const rc: RunContext = { agent: spec.byAgent, cfg: spec.cfg, home, log, me: () => owner, cwd: () => spec.cwd, jobs: sink, jobNode: node };

  /**
   * A turn's final report: persisted in the runner state before the first send, then delivered once under a stable
   * completion ID (AB-400). Used by every terminal path, including a pause that holds queued follow-ups (AB-398).
   */
  let turnReportId: string | undefined;
  const deliverFinal = async (report: string, status: "done" | "failed" | "cancelled" | "paused"): Promise<void> => {
    const final = { report, reportId: turnReportId ??= randomUUID(), delivered: false };
    finalQueued = true;
    const messageId = completionMessageId(`job:${job.id}`, final.reportId);
    deliveryEvidence("final", "queued", messageId);
    const finishedAt = Date.now();
    // Keep the existing bounded persistence retries below if this first write
    // cannot acquire storage. The in-memory final also retains its original ID.
    save({ status, ...final, finishedAt, ...(extra.retainedRunnerInputs?.phase === "provider-admitted"
      ? { retainedRunnerInputs: { ...extra.retainedRunnerInputs, phase: "consumed" } } : {}) }, true);
    // Receipt probes and session fallback must not overtake an accepted note.
    // Unlike ordinary send errors, a failed retention remains a queue barrier.
    const prepared = prepare(report, null, false, `${COMPLETION_DEDUPE_PREFIX}${final.reportId}`, false, true);
    await inOrder.drain();
    const settlement = await deliverFinalResult(final,
      (stored) => save({ status, ...stored, finishedAt }, true),
      async (body, id) => {
        // Retrying this result reuses its original immutable captured item.
        if (!ledger.entries.some(entry => entry.messageId === prepared.messageId)) { ledger = { ...ledger, entries: [...ledger.entries, prepared.item] }; save({ deliveryLedger: ledger }, true); }
        const result = await inOrder(prepared);
        return result && { stored: result.messages.length > 0 };
      },
      async (ms) => { await delay(ms); },
      shutdown.signal,
      async (id) => {
        deliveryEvidence("final", "receipt-probe", messageId);
        try {
          const stored = (await node.sendState(completionMessageId(`job:${job.id}`, id))).state === "stored";
          deliveryEvidence("final", stored ? "stored" : "queued", messageId); return stored;
        } catch (error) { deliveryEvidence("final", "receipt-failed", messageId, 1, error); throw error; }
      });
    extra.finalDelivery = { ...settlement, messageId, at: Date.now() };
    if (ledger.entries.some(entry => entry.messageId === prepared.messageId)) complete(prepared.item);
    try { log.info("job final delivery settled", extra.finalDelivery); } catch { /* Evidence never changes delivery. */ }
    save(); // Retain the precise exit outcome, including refusal, before this runner exits.
  };

  try {
    try { save({ deliveryLedger: ledger }, true); } catch { throw new RunnerRetentionUnsettled("attempts-exhausted"); }
    let args = spec.args;
    for (;;) {
      turnReportId = undefined;
      await inOrder.drain();
      if (extra.retainedRunnerInputs?.phase === "admitted") {
        if (shutdown.signal.aborted || job.controller.signal.aborted) throw new RunnerRetentionUnsettled("shutdown");
        // Admission is not proof of provider completion. A crash at/after this
        // boundary retains the original input as unconfirmed, never replays it.
        save({ retainedRunnerInputs: { ...extra.retainedRunnerInputs, phase: "provider-admitted" } }, true);
      }
      let status: "done" | "failed" | "cancelled" | "paused" = "failed";
      let text = "";
      let cause: string | null = null;
      let processesStopped = false;
      let completed = false;
      try {
        const res = await runDelegate(rc, target, args, job.controller.signal, onProgress, true, job);
        job.workdir = res.workdir ?? job.workdir;
        job.worktree = res.worktree ?? job.worktree;
        job.sessionId = res.sessionId ?? job.sessionId;
        status = res.status ?? (res.isError ? "failed" : "done");
        completed = status === "done";
        text = res.text || "(no answer text returned)";
        cause = res.isError ? failureCause({ result: res }) : null;
      } catch (err) {
        job.sessionId = sessionOfError(err) ?? job.sessionId;
        status = "failed";
        cause = failureCause({ error: err });
      } finally {
        settleUsageAttempt(job, status === "done");
        save();
      }
      // Ordering (AB-398): runDelegate above already made the job's commit or WIP checkpoint, so this cleanup runs
      // after it. Files that still-running job processes write between that commit and their stop are never
      // committed; the session only lists them as dirty files when it settles the turn. A paused job keeps its
      // worktree (closeJobWorktree below is skipped while a pause is pending).
      if (scope) {
        try {
          const cleanup = await scope.cleanup();
          processesStopped = cleanup.remaining.length === 0;
          text += "\n\n" + processCleanupReport(cleanup);
          if (cleanup.remaining.length) {
            status = "failed";
            cause = "job-owned background processes did not stop: " + cleanup.remaining.join(", ");
          }
        } catch (err) {
          status = "failed";
          cause = "job process cleanup failed: " + (err as Error).message;
          log.error("job process cleanup failed", { cause });
          text += "\n\n" + cause + ". Ownership containment remains active until the runner exits.";
        }
      }
      if (!scope && job.worktree?.path) {
        text += "\n\n" + worktreeProcessReport(await worktreeProcesses(job.worktree.path));
      }
      job.etaAt = undefined;
      if (job.worktree) {
        try {
          await recordWorktreeProcessProofWithRetry(home, job.worktree, processesStopped, { log });
        } catch (err) {
          log.warn("could not write the worktree process proof; worktree retained", { err: (err as Error).message });
        }
      }
      if (job.controller.signal.aborted && processesStopped && !job.pausePending) {
        const cleanup = await closeJobWorktree({ home, job: { ...job, status }, enabled: spec.cfg.jobCloseCleanup, log });
        text += `\n\nWorktree close: ${cleanup.action}: ${cleanup.reason}`;
      }
      job.etaReportedAt = undefined;
      // Decided after the last await, so a pause arriving meanwhile is seen. A pause that raced a completed turn
      // never swallows its report; a pause stays a pause even when job-owned processes would not stop (AB-398).
      const outcome = runnerTurnOutcome({ status, completed, pausePending: job.pausePending === true, scoped: Boolean(scope), processesStopped });
      if (holdsQueuedFollowUps({ pauseRaced: outcome.pauseRaced, queued: job.queue.length, sessionId: job.sessionId })) {
        // The turn finished, but follow-ups wait: deliver its report, then hold them. The job is paused with its
        // queue kept (the session recovers it from usageQueuedControls); no continuation starts here (AB-398).
        log.info("pause arrived as the turn finished; holding its queued follow-ups", { sessionId: job.sessionId, queued: job.queue.length });
        job.pausePending = false;
        closing = true;
        if (saveTimer) clearTimeout(saveTimer);
        const report = jobReport(job, status, Math.round((Date.now() - job.startedAt) / 1000), `${text}\n\n${PAUSE_HELD_NOTE}`, cause, home);
        // The report is persisted first and delivered once under its completion ID (AB-400): if the bridge does not
        // take it, the session posts the stored report when it settles the pause.
        await deliverFinal(report, "paused");
        log.info("job runner paused with held follow-ups", { delivered: extra.delivered === true });
        break;
      }
      if (outcome.pauseRaced) {
        log.info("pause arrived after the turn had finished; delivering its report", { sessionId: job.sessionId });
        job.pausePending = false;
        job.pauseReason = undefined;
        job.pausedAt = undefined;
        text += `\n\n${PAUSE_RACE_NOTE}`;
        // The pause aborted only a finished turn: later follow-ups of this runner need a live controller.
        job.controller = new AbortController();
      }
      if (outcome.status === "paused") status = "paused";
      else if (job.controller.signal.aborted) status = "cancelled";
      if (status === "paused") {
        closing = true;
        if (saveTimer) clearTimeout(saveTimer);
        save({ status: "paused", finishedAt: Date.now() });
        log.info("job runner paused", { sessionId: job.sessionId, processesStopped: processesStopped || !scope });
        if (outcome.pausedWithLeftovers) {
          await post(`Subagent ${job.name} is paused, but its job-owned processes did not all stop; they may still be using the machine. ` +
            `${cause ?? "Process cleanup did not finish."}\n\n${text.trim()}`);
        }
        break;
      }
      const report = jobReport(job, status, Math.round((Date.now() - job.startedAt) / 1000), text, cause, home);
      if (extra.retainedRunnerInputs?.phase === "provider-admitted") save({ status, report, reportId: turnReportId ??= randomUUID(), delivered: false,
        retainedRunnerInputs: { ...extra.retainedRunnerInputs, phase: "consumed" } }, true);
      log.info("job turn finished", { status, sessionId: job.sessionId, cause });
      // The supervisor's JobManager emits the finish/fail notification when it settles this
      // result. A detached notifier here would remain inside this runner's owned job scope.
      // Follow-ups that arrived meanwhile go out right away, into the same session, from this runner.
      if (job.queue.length && job.sessionId && !job.controller.signal.aborted && !usageRefused(job) && !job.usagePendingControls?.length) {
        // Persist the still-unconsumed input and result before waiting. Neither
        // a suspended predecessor nor cancellation may consume this turn intent.
        save({ retainedRunnerInputs: { generation: ledger.generation, phase: "pending", bodies: [...job.queue], controls: [...job.usageQueuedControls ?? []] },
          status, report, reportId: turnReportId ??= randomUUID(), delivered: false, finishedAt: Date.now() }, true);
        await inOrder.drain();
        if (job.controller.signal.aborted || shutdown.signal.aborted || job.pausePending) throw new RunnerRetentionUnsettled("shutdown");
        save({ retainedRunnerInputs: { ...extra.retainedRunnerInputs!, phase: "admitted" } }, true);
        await post(`${report}\n\n${QUEUED_FOLLOW_UP_NOTE}`);
        await inOrder.drain();
        if (job.controller.signal.aborted || shutdown.signal.aborted || job.pausePending) throw new RunnerRetentionUnsettled("shutdown");
        const queued = job.queue.splice(0).join("\n\n");
        job.usagePendingControls = job.usageQueuedControls;
        job.usageQueuedControls = [];
        args = resumeArgs(spec.base, job.name, queued, job.sessionId, job.workdir, job.worktree, job.args);
        if (args.model !== undefined) job.model = args.model;
        job.startedAt = Date.now();
        job.progress = null;
        extra = { status: "running", retainedRunnerInputs: extra.retainedRunnerInputs, deliveryLedger: ledger, pendingDeliveryRetention: [...pendingRetention.values()], retainedDeliveryCount: extra.retainedDeliveryCount };
        save({}, true);
        continue;
      }
      closing = true;
      if (saveTimer) clearTimeout(saveTimer);
      // The state first: once the report arrives, the session must find the job finished.
      await deliverFinal(report, status);
      log.info("job runner done", { status, delivered: extra.delivered === true });
      break;
    }
    // A pause/continuation path must observe the same owned queue as a final.
    await inOrder.drain();
    return 0;
  } catch (error) {
    if (!(error instanceof RunnerRetentionUnsettled)) throw error;
    extra.pendingDeliveryRetention = [...pendingRetention.values()];
    extra.deliveryRetentionFailure = error.reason;
    // If every storage path fails, explicitly fail the runner; never claim a
    // drained queue or successful final settlement. No arbitrary error/payload.
    save();
    log.error("job runner delivery unsettled", { reason: error.reason, pending: pendingRetention.size });
    return 1;
  } finally {
    clearInterval(heartbeat);
    if (saveTimer) clearTimeout(saveTimer);
    if (stopTimer) clearTimeout(stopTimer);
    for (const timer of controlRetries.values()) clearTimeout(timer);
    node.off("message", onControl);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await node.stop();
  }
}

/**
 * Tries a send until the bridge takes it. A too_large refusal is final (AB-380): retrying cannot make it fit, and the
 * caller keeps what it sent (a finished report stays in the runner state for the session to collect).
 */
export async function deliverWithRetry<T>(send: () => Promise<T>, log: Logger, owner: string, attempts = SEND_ATTEMPTS,
  rethrow?: ReadonlySet<string>, failed?: (attempt: number, error: unknown) => void): Promise<T | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await send();
    } catch (err) {
      try { failed?.(attempt, err); } catch { /* Diagnostics never alter delivery or failure policy. */ }
      // The caller handles these refusals itself (a final result hands over to the session fallback).
      if (rethrow?.has((err as { code?: string } | null)?.code ?? "") && !compatibleDeliveryHandover(err)) throw err;
      if ((err as { code?: string } | null)?.code === "too_large") {
        log.error("message too large to deliver; not retried", { owner, err: (err as Error).message });
        return null;
      }
      log.warn("could not deliver to the session; retrying", { owner, attempt, err: (err as Error).message });
      if (attempt === attempts) break;
      await new Promise((r) => setTimeout(r, Math.min(attempt * 1_000, SEND_RETRY_MAX_MS)));
    }
  }
  return null;
}

/**
 * A pause that raced a finished turn while follow-ups were queued holds them: the report is delivered and the job
 * is paused with its queue kept, instead of starting the continuation and calling the job finished (AB-398 N1).
 */
export function holdsQueuedFollowUps(o: { pauseRaced: boolean; queued: number; sessionId: string | null | undefined }): boolean {
  return o.pauseRaced && o.queued > 0 && Boolean(o.sessionId);
}

/**
 * How a runner turn ends when a pause may be pending (AB-398). A pause that arrived after the turn completed
 * never swallows its report; a pause whose job-owned processes would not stop stays a pause (never a silent
 * cancellation) and the supervisor is told about the leftovers.
 */
export function runnerTurnOutcome(o: { status: "done" | "failed" | "cancelled" | "paused"; completed: boolean; pausePending: boolean; scoped: boolean; processesStopped: boolean }):
  { status: "done" | "failed" | "cancelled" | "paused"; pauseRaced: boolean; pausedWithLeftovers: boolean } {
  if (!o.pausePending) return { status: o.status, pauseRaced: false, pausedWithLeftovers: false };
  if (o.completed) return { status: o.status, pauseRaced: true, pausedWithLeftovers: false };
  return { status: "paused", pauseRaced: false, pausedWithLeftovers: o.scoped && !o.processesStopped };
}

/** Ordinary failures recover; an accepted unretained item is latched until the owner observes drain. */
export function inSendOrder<A extends unknown[], T>(send: (...args: A) => Promise<T>, blocks?: (error: unknown) => boolean):
  ((...args: A) => Promise<T>) & { post(...args: A): Promise<undefined>; drain(): Promise<void> } {
  let chain: Promise<unknown> = Promise.resolve();
  let blocked: { error: unknown } | undefined;
  const schedule = <R>(operation: () => Promise<R>): Promise<R> => {
    const sent = chain.then(() => { if (blocked) throw blocked.error; return operation(); });
    // This observer owns ignored callback promises as well as awaited ones.
    // A blocking failure remains in queue state and rejects every later effect
    // and drain; observing a rejection is never confirmation of retention.
    chain = sent.catch(error => { if (blocks?.(error)) blocked ??= { error }; });
    return sent;
  };
  const enqueue = (...args: A) => schedule(() => send(...args));
  return Object.assign(enqueue, {
    post: (...args: A) => schedule(async () => { await send(...args); return undefined; }),
    drain: async () => {
      let observed;
      do { observed = chain; await observed; } while (observed !== chain);
      if (blocked) throw blocked.error;
    },
  });
}

/** Legacy 0.29.10 control mail also carries its original broker timestamp. */
export function isCurrentRunnerCancel(createdAt: number, startedAt: number): boolean {
  return createdAt >= startedAt;
}

/** Where the broker put a job's question (AB-249), from its send result. */
export async function questionRoute(result: SendResult | null, parent: string, isMain: (name: string) => Promise<boolean>): Promise<ParentRoute> {
  if (!result) return { state: "unconfirmed", parent };
  const delivered = result.deliveredTo[0];
  if (delivered === parent) return { state: "delivered", parent };
  if (delivered) return { state: "rerouted", parent, recipient: delivered, main: await isMain(delivered).catch(() => false) };
  return { state: "queued", parent, recipient: result.queuedFor[0] ?? parent };
}
