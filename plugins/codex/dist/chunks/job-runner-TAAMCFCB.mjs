import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  ProjectGroups
} from "./chunk-AQ6ZAVOC.mjs";
import {
  PERMANENT_DELIVERY_CODES,
  deliverFinalResult,
  guardRunnerErrors
} from "./chunk-H5S6KB2I.mjs";
import {
  resumeArgs,
  runDelegate
} from "./chunk-ESET66VL.mjs";
import {
  closeJobWorktree
} from "./chunk-YNQZK5XH.mjs";
import {
  recordWorktreeProcessProofWithRetry
} from "./chunk-G5F4XBXR.mjs";
import "./chunk-ZI7QR6JF.mjs";
import {
  acquireStartup
} from "./chunk-N7ONZJES.mjs";
import "./chunk-KNKN5CEU.mjs";
import "./chunk-IOGZQ3DT.mjs";
import "./chunk-VLV6NLZ5.mjs";
import {
  BridgeNode
} from "./chunk-EOED74NJ.mjs";
import "./chunk-XXZDRDC2.mjs";
import "./chunk-DNFDFVNI.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-U7JW4WPD.mjs";
import "./chunk-PLZI7WMX.mjs";
import {
  CONTROL_CONVERSATION_PREFIX,
  JOB_PEER_PREFIX,
  NOTE_CONVERSATION_SUFFIX,
  PAUSE_HELD_NOTE,
  PAUSE_RACE_NOTE,
  QUEUED_FOLLOW_UP_NOTE,
  RUNNER_HEARTBEAT_MS,
  canControlJob,
  changedJobArgs,
  establishWindowsJobScope,
  failureCause,
  jobReport,
  pauseReasonText,
  processCleanupReport,
  quarantineMessage,
  readStore,
  sessionOfError,
  settleUsageAttempt,
  usageRefused,
  usageSubmissionReceipt,
  waitForApproval,
  worktreeProcessReport,
  worktreeProcesses,
  writeRunnerState
} from "./chunk-ILN2V2BA.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-DXEWIZM4.mjs";
import {
  COMPLETION_DEDUPE_PREFIX,
  completionMessageId
} from "./chunk-T3Y747W7.mjs";
import {
  isPureAcknowledgement
} from "./chunk-ORHVXX2T.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import {
  resolveDbPath,
  resolvePipePath
} from "./chunk-3L5NAV5P.mjs";
import "./chunk-6B2AZPTL.mjs";
import "./chunk-KT6UGBZN.mjs";
import "./chunk-HSYLC53O.mjs";
import "./chunk-3ONQFYIQ.mjs";
import "./chunk-JKWPEEII.mjs";
import "./chunk-VUZ3I7UH.mjs";
import {
  takeRunnerSpec
} from "./chunk-5NPKKVPB.mjs";
import "./chunk-UEE6Z4PJ.mjs";
import {
  configurePathDisplay
} from "./chunk-HYOPFLLN.mjs";
import {
  ACK_CONVERSATION_SUFFIX,
  QUESTION_CONVERSATION_SUFFIX,
  SIBLING_CONVERSATION_PREFIX
} from "./chunk-IYJ5P7ML.mjs";
import {
  createLogger,
  refreshStorePeerIdentities
} from "./chunk-6QSR4FTZ.mjs";
import "./chunk-YEN6TM2D.mjs";
import {
  JOBS_FILE
} from "./chunk-FJ2TGOLZ.mjs";
import "./chunk-EMDJN7RB.mjs";
import "./chunk-6RNADTH4.mjs";

// src/mcp/job-runner.ts
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
var SEND_ATTEMPTS = 30;
var FINAL_SEND_ATTEMPTS = 1;
var SEND_RETRY_MAX_MS = 1e4;
var PROGRESS_SAVE_MS = 1e3;
var SEEN_LIMIT = 100;
var STOP_DEADLINE_MS = 15e3;
var INITIAL_STATE_DEADLINE_MS = 5 * 6e4;
var INITIAL_STATE_RETRY_MAX_MS = 2e3;
async function publishInitialRunnerState(spec, log, deadlineMs = INITIAL_STATE_DEADLINE_MS) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Job runner stopped before initial state publication"));
  const deadline = setTimeout(() => controller.abort(new Error("Job runner initial state publication timed out after waiting for store admission")), deadlineMs);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await refreshStorePeerIdentities(spec.home, controller.signal);
      } catch (error) {
        controller.signal.throwIfAborted();
        if (attempt === 0 || attempt % 30 === 0) log.info("initial runner state waits for reader identities", { job: spec.job.name, attempt, reason: String(error) });
        await delay(Math.min(INITIAL_STATE_RETRY_MAX_MS, (attempt + 1) * 100), void 0, { signal: controller.signal });
        continue;
      }
      controller.signal.throwIfAborted();
      try {
        writeRunnerState(spec.home, spec.job.id, { pid: process.pid, peer: spec.job.name, status: "running", updatedAt: Date.now(), progress: "queued: runner startup admission" });
        return;
      } catch (error) {
        if (error.code !== "STORE_UPGRADE_DEFERRED") throw error;
        if (attempt === 0 || attempt % 30 === 0) log.info("initial runner state waits for retained store readers", { job: spec.job.name, attempt, reason: String(error) });
        await delay(Math.min(INITIAL_STATE_RETRY_MAX_MS, (attempt + 1) * 100), void 0, { signal: controller.signal });
      }
    }
  } finally {
    clearTimeout(deadline);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
async function runJobRunner(specFile) {
  if (!specFile) return 2;
  const data = takeRunnerSpec(specFile);
  if (!data) return 2;
  const spec = data;
  const { home } = spec;
  const log = createLogger({ home, component: "job-runner" }).child(spec.job.name);
  let scope = null;
  const releaseErrorGuards = guardRunnerErrors(log);
  try {
    await publishInitialRunnerState(spec, log);
    if (process.platform === "win32") {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);
      try {
        const release = await acquireStartup(home, controller.signal, spec.job.name);
        try {
          controller.signal.throwIfAborted();
          scope = await establishWindowsJobScope(log);
        } finally {
          release();
        }
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
    }
    return await runOwnedJobRunner(spec, log, scope);
  } catch (error) {
    log.error("job runner failed", { err: String(error?.stack ?? error) });
    throw error;
  } finally {
    try {
      scope?.detach();
    } finally {
      releaseErrorGuards();
    }
  }
}
async function runOwnedJobRunner(spec, log, scope) {
  const { home, target } = spec;
  const job = {
    ...spec.job,
    controller: new AbortController(),
    progress: null,
    status: "running",
    queue: [],
    usageQueuedControls: [],
    allowedServers: new Set(spec.job.allowedServers)
  };
  const runnerStartedAt = job.startedAt;
  let owner = spec.owner;
  const refreshOwner = () => {
    const saved = readStore(join(home, JOBS_FILE)).find((j) => j.id === job.id);
    if (!saved) return;
    owner = saved.owner ?? owner;
    Object.assign(job, {
      owner,
      supervisor: saved.supervisor,
      parentJob: saved.parentJob,
      rootSession: saved.rootSession,
      rootName: saved.rootName,
      ownershipHistory: saved.ownershipHistory,
      masters: saved.masters,
      args: { ...job.args, send_to: saved.args?.send_to }
    });
  };
  const seen = [];
  let closing = false;
  let extra = { status: "running" };
  const save = (patch = {}, required = false) => {
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
        seen: seen.slice(-SEEN_LIMIT)
      });
    } catch (err) {
      log.warn("could not write the job runner state", { err: err.message });
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
    log
  });
  save();
  const heartbeat = setInterval(() => save(), RUNNER_HEARTBEAT_MS);
  log.info("job runner started", { pid: process.pid, target, owner });
  const deliver = async (body, replyTo, note = false, key, question = false, final = false) => {
    const dedupeKey = key ?? randomUUID();
    body = quarantineMessage(home, { id: dedupeKey, body }).body;
    return deliverWithRetry(() => {
      refreshOwner();
      const suffix = isPureAcknowledgement(body) ? ACK_CONVERSATION_SUFFIX : question ? QUESTION_CONVERSATION_SUFFIX : note ? NOTE_CONVERSATION_SUFFIX : "";
      return node.send({ to: owner, body, conversationId: `job-${job.id}${suffix}`, ...replyTo ? { replyTo } : {}, dedupeKey }, { quiet: true });
    }, log, owner, final ? FINAL_SEND_ATTEMPTS : SEND_ATTEMPTS, final ? PERMANENT_DELIVERY_CODES : void 0);
  };
  const inOrder = inSendOrder(deliver);
  const post = (body, replyTo = null, note = false, key) => inOrder(body, replyTo, note, key).then((result) => result !== null);
  const ask = async (body, replyTo) => {
    const result = await inOrder(body, replyTo, false, void 0, true);
    return questionRoute(result, owner, async (name) => (await node.peers()).some((p) => p.name === name && p.projectMain === true));
  };
  const sink = {
    persist: () => save(),
    escalateApproval: async (_job, body) => {
      await post(body);
    },
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
      void post(body, replyTo, !answer);
    },
    note: (j, facts) => {
      if (facts.sessionId) j.sessionId = facts.sessionId;
      if (facts.workdir) j.workdir = facts.workdir;
      if (facts.worktree) j.worktree = facts.worktree;
      save();
    }
  };
  const handleControl = async (m) => {
    if (m.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX)) return;
    if (!m.conversationId.startsWith(CONTROL_CONVERSATION_PREFIX)) {
      log.warn("unsupported ordinary job mail retained unread", { from: m.from.name, id: m.id });
      return;
    }
    if (owner.includes("/") && m.from.name !== owner) {
      log.warn("ignoring remote job control from another supervisor", { from: m.from.name });
      return;
    }
    let c;
    try {
      c = JSON.parse(m.body);
    } catch {
      return;
    }
    if (c.type === "pause" && !isCurrentRunnerCancel(m.createdAt, runnerStartedAt) || c.type === "cancel" && !isCurrentRunnerCancel(m.createdAt, job.startedAt)) {
      log.info("ignoring cancellation from an earlier job turn", { createdAt: m.createdAt, startedAt: job.startedAt });
      return;
    }
    refreshOwner();
    if (!owner.includes("/") && !canControlJob(job, m.from.name)) {
      const peers = await node.peers();
      const master = peers.find((p) => p.name === m.from.name);
      if (!master || !new ProjectGroups(home).canControl(master, job, peers)) return;
    }
    if (m.from.name !== owner) log.info("job control received from another session", { name: m.from.name, owner });
    void node.updateJob({ jobParent: owner }).catch(() => {
    });
    if (c.type === "message") {
      if (closing) return;
      if (!seen.includes(c.cid)) {
        if (job.live) {
          job.awaitingAnswer = true;
          job.live.post(c.body, void 0, c.cid);
        } else {
          job.queue.push(c.body);
          job.usageQueuedControls.push({ cid: c.cid, body: c.body });
        }
        seen.push(c.cid);
      }
      save();
    } else if (c.type === "title") {
      job.args = { ...job.args, title: c.title };
      job.retitle?.(c.title);
    } else if (c.type === "effort") {
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
      if (job.pausePending || closing) {
        node.markRead([m.id]);
        return;
      }
      job.pauseReason = pauseReasonText(c.reason);
      job.pausedAt = Date.now();
      job.pausePending = true;
      job.controller.abort();
      save({ stopping: true });
    }
    node.markRead([m.id]);
  };
  let controls = Promise.resolve();
  const controlRetries = /* @__PURE__ */ new Map();
  const onControl = (m) => {
    controls = controls.then(() => handleControl(m)).catch((err) => {
      log.warn("job control deferred; active turn kept running", { id: m.id, err: String(err) });
      if (!closing && !controlRetries.has(m.id)) {
        const timer = setTimeout(() => {
          controlRetries.delete(m.id);
          onControl(m);
        }, 1e3);
        timer.unref();
        controlRetries.set(m.id, timer);
      }
    });
  };
  node.on("message", onControl);
  const shutdown = new AbortController();
  const stop = () => {
    shutdown.abort();
    job.queue = [];
    job.controller.abort();
    setTimeout(() => process.exit(1), STOP_DEADLINE_MS).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  void node.start().catch((err) => log.warn("could not join the bridge yet; retrying in the background", { err: err.message }));
  let saveTimer = null;
  const onProgress = (message) => {
    job.progress = message;
    saveTimer ??= setTimeout(() => {
      saveTimer = null;
      save();
    }, PROGRESS_SAVE_MS);
  };
  configurePathDisplay(spec.cfg.pathDisplay ?? { preferAlias: true });
  const rc = { agent: spec.byAgent, cfg: spec.cfg, home, log, me: () => owner, cwd: () => spec.cwd, jobs: sink, jobNode: node };
  const deliverFinal = async (report, status) => {
    const final = { report, reportId: randomUUID(), delivered: false };
    const finishedAt = Date.now();
    await deliverFinalResult(
      final,
      (stored) => save({ status, ...stored, finishedAt }, true),
      async (body, id) => {
        const result = await inOrder(body, null, false, `${COMPLETION_DEDUPE_PREFIX}${id}`, false, true);
        return result && { stored: result.messages.length > 0 };
      },
      async (ms) => {
        await delay(ms);
      },
      shutdown.signal,
      async (id) => (await node.sendState(completionMessageId(`job:${job.id}`, id))).state === "stored"
    );
  };
  let args = spec.args;
  for (; ; ) {
    let status = "failed";
    let text = "";
    let cause = null;
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
        cause = "job process cleanup failed: " + err.message;
        log.error("job process cleanup failed", { cause });
        text += "\n\n" + cause + ". Ownership containment remains active until the runner exits.";
      }
    }
    if (!scope && job.worktree?.path) {
      text += "\n\n" + worktreeProcessReport(await worktreeProcesses(job.worktree.path));
    }
    job.etaAt = void 0;
    if (job.worktree) {
      try {
        await recordWorktreeProcessProofWithRetry(home, job.worktree, processesStopped, { log });
      } catch (err) {
        log.warn("could not write the worktree process proof; worktree retained", { err: err.message });
      }
    }
    if (job.controller.signal.aborted && processesStopped && !job.pausePending) {
      const cleanup = await closeJobWorktree({ home, job: { ...job, status }, enabled: spec.cfg.jobCloseCleanup, log });
      text += `

Worktree close: ${cleanup.action}: ${cleanup.reason}`;
    }
    job.etaReportedAt = void 0;
    const outcome = runnerTurnOutcome({ status, completed, pausePending: job.pausePending === true, scoped: Boolean(scope), processesStopped });
    if (holdsQueuedFollowUps({ pauseRaced: outcome.pauseRaced, queued: job.queue.length, sessionId: job.sessionId })) {
      log.info("pause arrived as the turn finished; holding its queued follow-ups", { sessionId: job.sessionId, queued: job.queue.length });
      job.pausePending = false;
      closing = true;
      if (saveTimer) clearTimeout(saveTimer);
      const report2 = jobReport(job, status, Math.round((Date.now() - job.startedAt) / 1e3), `${text}

${PAUSE_HELD_NOTE}`, cause, home);
      await deliverFinal(report2, "paused");
      log.info("job runner paused with held follow-ups", { delivered: extra.delivered === true });
      break;
    }
    if (outcome.pauseRaced) {
      log.info("pause arrived after the turn had finished; delivering its report", { sessionId: job.sessionId });
      job.pausePending = false;
      job.pauseReason = void 0;
      job.pausedAt = void 0;
      text += `

${PAUSE_RACE_NOTE}`;
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
        await post(`Subagent ${job.name} is paused, but its job-owned processes did not all stop; they may still be using the machine. ${cause ?? "Process cleanup did not finish."}

${text.trim()}`);
      }
      break;
    }
    const report = jobReport(job, status, Math.round((Date.now() - job.startedAt) / 1e3), text, cause, home);
    log.info("job turn finished", { status, sessionId: job.sessionId, cause });
    if (job.queue.length && job.sessionId && !job.controller.signal.aborted && !usageRefused(job) && !job.usagePendingControls?.length) {
      const queued = job.queue.splice(0).join("\n\n");
      job.usagePendingControls = job.usageQueuedControls;
      job.usageQueuedControls = [];
      void post(`${report}

${QUEUED_FOLLOW_UP_NOTE}`);
      args = resumeArgs(spec.base, job.name, queued, job.sessionId, job.workdir, job.worktree, job.args);
      if (args.model !== void 0) job.model = args.model;
      job.startedAt = Date.now();
      job.progress = null;
      extra = { status: "running" };
      save();
      continue;
    }
    closing = true;
    if (saveTimer) clearTimeout(saveTimer);
    await deliverFinal(report, status);
    log.info("job runner done", { status, delivered: extra.delivered === true });
    break;
  }
  clearInterval(heartbeat);
  for (const timer of controlRetries.values()) clearTimeout(timer);
  node.off("message", onControl);
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  await node.stop();
  return 0;
}
async function deliverWithRetry(send, log, owner, attempts = SEND_ATTEMPTS, rethrow) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await send();
    } catch (err) {
      if (rethrow?.has(err?.code ?? "")) throw err;
      if (err?.code === "too_large") {
        log.error("message too large to deliver; not retried", { owner, err: err.message });
        return null;
      }
      log.warn("could not deliver to the session; retrying", { owner, attempt, err: err.message });
      if (attempt === attempts) break;
      await new Promise((r) => setTimeout(r, Math.min(attempt * 1e3, SEND_RETRY_MAX_MS)));
    }
  }
  return null;
}
function holdsQueuedFollowUps(o) {
  return o.pauseRaced && o.queued > 0 && Boolean(o.sessionId);
}
function runnerTurnOutcome(o) {
  if (!o.pausePending) return { status: o.status, pauseRaced: false, pausedWithLeftovers: false };
  if (o.completed) return { status: o.status, pauseRaced: true, pausedWithLeftovers: false };
  return { status: "paused", pauseRaced: false, pausedWithLeftovers: o.scoped && !o.processesStopped };
}
function inSendOrder(send) {
  let chain = Promise.resolve();
  return (...args) => {
    const sent = chain.then(() => send(...args));
    chain = sent.catch(() => void 0);
    return sent;
  };
}
function isCurrentRunnerCancel(createdAt, startedAt) {
  return createdAt >= startedAt;
}
async function questionRoute(result, parent, isMain) {
  if (!result) return { state: "unconfirmed", parent };
  const delivered = result.deliveredTo[0];
  if (delivered === parent) return { state: "delivered", parent };
  if (delivered) return { state: "rerouted", parent, recipient: delivered, main: await isMain(delivered).catch(() => false) };
  return { state: "queued", parent, recipient: result.queuedFor[0] ?? parent };
}
export {
  INITIAL_STATE_DEADLINE_MS,
  deliverWithRetry,
  holdsQueuedFollowUps,
  inSendOrder,
  isCurrentRunnerCancel,
  publishInitialRunnerState,
  questionRoute,
  runJobRunner,
  runOwnedJobRunner,
  runnerTurnOutcome
};
