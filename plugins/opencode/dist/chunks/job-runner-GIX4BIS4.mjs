import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  ProjectGroups
} from "./chunk-EK3MVAU4.mjs";
import {
  guardRunnerErrors
} from "./chunk-Q4TGWKCP.mjs";
import {
  acquireStartup,
  resumeArgs,
  runDelegate
} from "./chunk-ZYYKBS73.mjs";
import {
  closeJobWorktree
} from "./chunk-YGKOYMWI.mjs";
import {
  recordWorktreeProcessProofWithRetry
} from "./chunk-5T4RJ7IQ.mjs";
import "./chunk-72TFE3RP.mjs";
import "./chunk-KNKN5CEU.mjs";
import "./chunk-IOGZQ3DT.mjs";
import "./chunk-CE5EGKJK.mjs";
import {
  BridgeNode
} from "./chunk-FE5BZOBY.mjs";
import "./chunk-OVC2JA2V.mjs";
import "./chunk-K2APWES6.mjs";
import "./chunk-RQUYBZWF.mjs";
import "./chunk-SPGRZ3MU.mjs";
import "./chunk-NR4D7G7R.mjs";
import {
  CONTROL_CONVERSATION_PREFIX,
  JOB_PEER_PREFIX,
  NOTE_CONVERSATION_SUFFIX,
  QUEUED_FOLLOW_UP_NOTE,
  RUNNER_HEARTBEAT_MS,
  canControlJob,
  changedJobArgs,
  establishWindowsJobScope,
  failureCause,
  jobReport,
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
} from "./chunk-L7NKUEJL.mjs";
import "./chunk-6KTEQAZ2.mjs";
import "./chunk-ZH2USODZ.mjs";
import {
  COMPLETION_DEDUPE_PREFIX
} from "./chunk-E5ZSIZVD.mjs";
import {
  isPureAcknowledgement
} from "./chunk-ORHVXX2T.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import {
  resolveDbPath,
  resolvePipePath
} from "./chunk-HJGP2JM4.mjs";
import "./chunk-Q5IQLWCD.mjs";
import "./chunk-QZCBQNZ3.mjs";
import "./chunk-IJB7OPWL.mjs";
import "./chunk-6XRCYILV.mjs";
import "./chunk-AHTV3VZF.mjs";
import {
  ACK_CONVERSATION_SUFFIX,
  QUESTION_CONVERSATION_SUFFIX,
  SIBLING_CONVERSATION_PREFIX
} from "./chunk-IYJ5P7ML.mjs";
import {
  takeRunnerSpec
} from "./chunk-VLWA2RF6.mjs";
import "./chunk-OX5J3NNH.mjs";
import {
  configurePathDisplay
} from "./chunk-HYOPFLLN.mjs";
import {
  createLogger,
  refreshStorePeerIdentities
} from "./chunk-K2GEQFVF.mjs";
import "./chunk-2SAFLVLW.mjs";
import {
  JOBS_FILE
} from "./chunk-HIVVJXLN.mjs";
import "./chunk-HYVC3VSW.mjs";
import "./chunk-6RNADTH4.mjs";

// src/mcp/job-runner.ts
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
var SEND_ATTEMPTS = 30;
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
        const release = await acquireStartup(home, controller.signal);
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
  const save = (patch = {}) => {
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
  let chain = Promise.resolve();
  const deliver = async (body, replyTo, note = false, key, question = false) => {
    const dedupeKey = key ?? randomUUID();
    body = quarantineMessage(home, { id: dedupeKey, body }).body;
    return deliverWithRetry(() => {
      refreshOwner();
      const suffix = isPureAcknowledgement(body) ? ACK_CONVERSATION_SUFFIX : question ? QUESTION_CONVERSATION_SUFFIX : note ? NOTE_CONVERSATION_SUFFIX : "";
      return node.send({ to: owner, body, conversationId: `job-${job.id}${suffix}`, ...replyTo ? { replyTo } : {}, dedupeKey }, { quiet: true });
    }, log, owner);
  };
  const inOrder = (body, replyTo, note, key, question = false) => {
    const sent = chain.then(() => deliver(body, replyTo, note, key, question));
    chain = sent;
    return sent;
  };
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
    if (c.type === "cancel" && !isCurrentRunnerCancel(m.createdAt, job.startedAt)) {
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
  const stop = () => {
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
  let args = spec.args;
  for (; ; ) {
    let status = "failed";
    let text = "";
    let cause = null;
    let processesStopped = false;
    try {
      const res = await runDelegate(rc, target, args, job.controller.signal, onProgress, true, job);
      job.workdir = res.workdir ?? job.workdir;
      job.worktree = res.worktree ?? job.worktree;
      job.sessionId = res.sessionId ?? job.sessionId;
      status = res.status ?? (res.isError ? "failed" : "done");
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
    if (job.controller.signal.aborted && processesStopped) {
      const cleanup = await closeJobWorktree({ home, job: { ...job, status }, enabled: spec.cfg.jobCloseCleanup, log });
      text += `

Worktree close: ${cleanup.action}: ${cleanup.reason}`;
    }
    job.etaReportedAt = void 0;
    if (job.controller.signal.aborted) status = "cancelled";
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
      save();
      continue;
    }
    closing = true;
    if (saveTimer) clearTimeout(saveTimer);
    const reportId = randomUUID();
    save({ status, report, reportId, delivered: false, finishedAt: Date.now() });
    const delivered = await post(report, null, false, `${COMPLETION_DEDUPE_PREFIX}${reportId}`);
    save({ delivered });
    log.info("job runner done", { status, delivered });
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
async function deliverWithRetry(send, log, owner, attempts = SEND_ATTEMPTS) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await send();
    } catch (err) {
      if (err?.code === "too_large") {
        log.error("message too large to deliver; not retried", { owner, err: err.message });
        return null;
      }
      log.warn("could not deliver to the session; retrying", { owner, attempt, err: err.message });
      await new Promise((r) => setTimeout(r, Math.min(attempt * 1e3, SEND_RETRY_MAX_MS)));
    }
  }
  return null;
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
  isCurrentRunnerCancel,
  publishInitialRunnerState,
  questionRoute,
  runJobRunner,
  runOwnedJobRunner
};
