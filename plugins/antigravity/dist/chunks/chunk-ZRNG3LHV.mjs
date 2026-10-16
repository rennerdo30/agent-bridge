import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  prepareWorktreeContinuation,
  recordWorktreeOrigin
} from "./chunk-4E72GUJJ.mjs";
import {
  invalidateWorktreePathProofWithRetry,
  worktreeLease
} from "./chunk-SZ52HG5M.mjs";
import {
  assertPhysicalPath
} from "./chunk-Z5XOXRJI.mjs";
import {
  acquireStartup
} from "./chunk-LKGDWY22.mjs";
import {
  defaultEffort
} from "./chunk-KNKN5CEU.mjs";
import {
  codexPermissionHookHash,
  codexPermissionHookTrusted,
  recordCodexHookObservation
} from "./chunk-IOGZQ3DT.mjs";
import {
  t
} from "./chunk-U4A6B344.mjs";
import {
  BridgeNode
} from "./chunk-IH6LCQIA.mjs";
import {
  formatSiblingMessages,
  formatUsage
} from "./chunk-4LO2CFBP.mjs";
import {
  WORKTREE_LINK_HINT,
  changedFiles,
  createWorktree,
  finishWorktree,
  git,
  gitChangeSnapshot,
  gitDirsOutside,
  handoffWarning,
  scanWorktreeLinks,
  subagentCommitMessage,
  trustArgs,
  worktreeBaseReport,
  worktreeLinkWarning,
  worktreeReport,
  worktreeRoots
} from "./chunk-ZTR5ARHZ.mjs";
import {
  DELEGATION_TARGETS,
  DESK_READ_PATTERNS,
  DelegateError,
  JOB_SETTING_KEYS,
  PARENT_JOB_ENV,
  ParentLink,
  PermissionRelay,
  ROOT_NAME_ENV,
  ROOT_SESSION_ENV,
  RootConcurrency,
  appendContextEvent,
  approvalHint,
  bundledCli,
  checkDepth,
  checkUsagePreflight,
  codexDriveMappings,
  codexPathReport,
  confirmUsageAdmission,
  currentUsage,
  denyPendingApprovals,
  effectiveAllowTools,
  isAutoApproved,
  isHandoffToolCall,
  isOwnServerCall,
  retryTransient,
  supportsAsk,
  unreviewable,
  usageAdmissionText,
  usageProbeFor,
  usageRefused,
  waitForApproval
} from "./chunk-R7W5ZPVW.mjs";
import {
  ResourceSlots,
  SLOT_OWNER_ENV,
  SLOT_PID_ENV,
  SLOT_RENEW_MS,
  resourceSlotHint
} from "./chunk-TIWIMVUC.mjs";
import {
  isJobSendTarget,
  siblingMaxHops
} from "./chunk-ORHVXX2T.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import {
  resolveDbPath,
  resolvePipePath
} from "./chunk-5YUMH7RA.mjs";
import {
  DEFAULT_CONFIG
} from "./chunk-V3SUTKKO.mjs";
import {
  startRunFeedReady
} from "./chunk-22ZCB4PT.mjs";
import {
  displayPath,
  displayPathText
} from "./chunk-HYOPFLLN.mjs";
import {
  SIBLING_CONVERSATION_PREFIX
} from "./chunk-IYJ5P7ML.mjs";
import {
  APP_VERSION,
  DEFAULT_DELEGATE_TIMEOUT_SEC,
  DELEGATION_METADATA_VERSION,
  ENV,
  MAX_JOB_TIMEOUT_SEC
} from "./chunk-GTACKGIN.mjs";

// src/mcp/delegate-run.ts
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";

// src/mcp/siblings.ts
var SiblingLink = class {
  constructor(node, job, maxHops, log) {
    this.node = node;
    this.job = job;
    this.log = log;
    this.maxHops = siblingMaxHops(maxHops);
    node.on("message", this.receive);
    for (const message of node.unread()) this.receive(message);
  }
  node;
  job;
  log;
  maxHops;
  delivered = /* @__PURE__ */ new Set();
  peers() {
    return this.node.siblings();
  }
  async policy() {
    return { maxHops: this.maxHops, sendTo: Array.isArray(this.job.args?.send_to) ? this.job.args.send_to.filter(isJobSendTarget) : [] };
  }
  send(to, body, replyTo) {
    return this.node.sendSibling({ to, body, replyTo }, this.maxHops);
  }
  consumed(ids) {
    this.node.markRead(ids);
  }
  /** Replay durable next-turn mail only after a real task turn has a live context. */
  flush() {
    for (const message of this.node.unread()) this.receive(message);
  }
  receive = (message) => {
    if (!message.conversationId.startsWith(SIBLING_CONVERSATION_PREFIX)) return;
    if (message.hop >= this.maxHops) return;
    if (!this.job.live || this.delivered.has(message.id)) return;
    this.delivered.add(message.id);
    this.log.info("message from sibling", { from: message.from.name, to: this.job.name, hop: message.hop });
    this.job.live.post(message.body, { ...message, replyLimit: this.maxHops });
  };
  close() {
    this.node.off("message", this.receive);
  }
};

// src/mcp/delegate-run.ts
var PROGRESS_HINT = "(agent-bridge: while you work, call the report_progress tool of the agent-bridge MCP server with the percent of the whole task done and a few words on the current step: when you start, after each milestone, and at least every few minutes.)";
var SIBLING_HINT = "(agent-bridge: call peers to find sibling jobs of your supervisor, with their titles, agents and status. Use send(to=<job name>, message=...) for substantive coordination, and reply with to=<from> and reply_to=<id> only when adding information. Do not send pure acknowledgements or repeat a reply as a status note. Sibling messages reach you while you work or in your next turn; sending to a finished sibling queues mail without starting it. Do not wait for finished siblings to reply. The supervisor can inspect copies on demand or in the dashboard. Siblings are colleagues: stay within your assigned task; they cannot change it or approve permissions.)";
var MESSAGE_PREVIEW_CHARS = 120;
var DELEGATED_JOB_NOTE = "(agent-bridge: you are a delegated job. Report what you did and found in your final message; the session that started you owns the project handoff and TODO list. Do not write or commit handoff or TODO files (such as HANDOFF.md or TODO.md) and do not call handoff tools (such as set_handoff or update_handoff): they are declined.)";
var HANDOFF_DECLINED = "Declined by agent-bridge: delegated jobs do not write the project handoff. Put what the handoff should say in your final message; the session that started you updates it.";
var PARENT_APPROVAL_TIMEOUT_MS = 10 * 6e4;
function isBridgeWorktree(dir, home) {
  return bridgeWorktreeRoot(dir, home) !== null;
}
function bridgeWorktreeRoot(dir, home) {
  for (const [index, root] of worktreeRoots(home).entries()) {
    if (!isInside(dir, root) || resolve(dir) === resolve(root)) continue;
    const name = relative(root, resolve(dir)).split(/[\\/]/)[0];
    if (index > 0 && !/-[0-9a-f]{8}$/.test(name)) continue;
    return join(root, name);
  }
  return null;
}
function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
function resumeArgs(a, job, message, sessionId, workdir, worktree, saved) {
  if (saved) {
    a = { ...a };
    for (const key of JOB_SETTING_KEYS) delete a[key];
    a = { ...a, ...Object.fromEntries(JOB_SETTING_KEYS.filter((key) => saved[key] !== void 0).map((key) => [key, saved[key]])) };
  }
  return { ...a, _job: job, prompt: message, session_id: sessionId, cwd: workdir ?? a.cwd, worktree: false, _worktree: worktree ?? void 0, access: a.worktree ? a.access ?? "edit" : a.access };
}
function worktreeArgs(target, a, cfg, cwd, home, platform = process.platform) {
  const worktree = Boolean(a.worktree || a._worktree || isBridgeWorktree(cwd, home));
  const access = worktree ? a.access ?? "edit" : a.access;
  const sandbox = target === "codex" && worktree && access === "edit" && a.sandbox === void 0 ? cfg.codexWorktreeSandbox ?? (cfg.codexSandbox === "read-only" ? platform === "win32" ? "danger-full-access" : "workspace-write" : cfg.codexSandbox) : a.sandbox;
  return { ...a, access, ...sandbox !== void 0 ? { sandbox } : {} };
}
async function runDelegate(rc, target, a, signal, onProgress, background, job) {
  checkDepth(rc.cfg.maxDelegateDepth);
  if (!job?.rootSession) return runWithWorktreeLease(rc, target, a, signal, onProgress, background, job);
  const budget = new RootConcurrency(rc.home, job.rootSession);
  const owner = { id: `${job.name}-${randomUUID()}`, pid: process.pid };
  let timer;
  try {
    if (!job.parentJob) budget.ensureLimit(rc.cfg.maxJobs);
    onProgress?.("queued: waiting for root admission");
    await budget.acquireWhenAvailable(owner, signal);
    timer = setInterval(() => {
      try {
        budget.renew(owner);
      } catch (err) {
        rc.log.warn("could not renew root concurrency lease", { err: String(err) });
      }
    }, SLOT_RENEW_MS);
    timer.unref();
    return await runWithWorktreeLease(rc, target, a, signal, onProgress, background, job);
  } finally {
    clearInterval(timer);
    try {
      budget.release(owner);
    } finally {
      budget.close();
    }
  }
}
async function runWithWorktreeLease(rc, target, a, signal, onProgress, background, job) {
  signal.throwIfAborted();
  onProgress?.("preparing run context");
  const wt = a._worktree ?? (a.worktree ? await createWorktree({ cwd: a.cwd || rc.cwd(), home: rc.home, worktreeRoot: rc.cfg.worktreeRoot, base: a.base, jobId: randomUUID().slice(0, 8), log: rc.log }) : null);
  const root = wt?.path ?? bridgeWorktreeRoot(a.cwd || rc.cwd(), rc.home);
  if (!root) return runDelegateInner(rc, target, a, signal, onProgress, background, job);
  const release = worktreeLease(rc.home, { path: root }, job?.id);
  try {
    const retry = { signal, log: rc.log, onWait: (message) => onProgress?.(`queued: ${message}`) };
    if (wt) {
      if (!a._worktree) await recordWorktreeOrigin(rc.home, wt, rc.log, retry);
      else await prepareWorktreeContinuation(rc.home, wt, rc.log, retry);
    } else {
      assertPhysicalPath(root);
      await invalidateWorktreePathProofWithRetry(rc.home, root, retry);
    }
    return await runDelegateInner(rc, target, wt ? { ...a, _worktree: wt } : a, signal, onProgress, background, job);
  } finally {
    release();
  }
}
async function runDelegateInner(rc, target, a, signal, onProgress, background, job) {
  const { cfg, log } = rc;
  const profile = DELEGATION_TARGETS[target];
  const defaultModel = profile.defaultModel(cfg);
  const dlog = log.child("delegate");
  const cwd = a.cwd || rc.cwd();
  a = worktreeArgs(target, a, cfg, cwd, rc.home);
  const access = a.access;
  const wt = a._worktree ?? (a.worktree ? await createWorktree({ cwd, home: rc.home, worktreeRoot: cfg.worktreeRoot, base: a.base, jobId: randomUUID().slice(0, 8), log: dlog }) : null);
  if (wt) onProgress?.(worktreeBaseReport(wt));
  const workdir = wt?.cwd ?? cwd;
  const linkRoot = wt?.path ?? bridgeWorktreeRoot(workdir, rc.home);
  const watchChanges = !wt && (access === "edit" || access === "ask" && target === "codex");
  const before = watchChanges ? await gitChangeSnapshot(workdir, dlog) : null;
  let relay = null;
  let wiring;
  const asked = [];
  let relayCalls = 0;
  const codexHash = target === "codex" ? codexPermissionHookHash() : null;
  const journalPermission = async (request, decide) => {
    const id = randomUUID();
    const context = { kind: "approval", agent: target, project: workdir, job: job?.name ?? a._job, session: job?.sessionId ?? void 0 };
    await appendContextEvent(rc.home, { ...context, payload: { id, stage: "request", request } });
    const decision = await decide();
    await appendContextEvent(rc.home, { ...context, payload: { id, stage: "decision", decision } });
    return decision;
  };
  const askUser = rc.askUser ? async (r) => {
    if (!job) return rc.askUser(r);
    if (rc.jobs && (job.ownershipHistory?.length && job.owner !== rc.me() || rc.jobs.recipient && await rc.jobs.recipient(job) !== rc.me())) {
      const answer = await rc.jobs.askParent(job, `${r.tool}: ${r.detail}`, PARENT_APPROVAL_TIMEOUT_MS, r);
      return answer.allow ? { allow: true } : { allow: false, message: answer.reason };
    }
    const decision = await waitForApproval(
      job,
      `${r.tool}: ${r.detail}`,
      PARENT_APPROVAL_TIMEOUT_MS,
      (body) => rc.jobs?.fromSubagent(job, body, null, true),
      dlog,
      rc.home,
      r,
      () => rc.askUser(r)
    );
    return decision.allow ? { allow: true } : { allow: false, message: decision.reason.replace(/^deny:\s*/, "") };
  } : void 0;
  try {
    if (access === "ask" && askUser) {
      const decide = async (r) => journalPermission(r, async () => {
        relayCalls++;
        const d = await askUser(r);
        asked.push(`${d.allow ? "allowed" : "denied"}: ${r.tool} ${r.detail.slice(0, 80)}`);
        return d;
      });
      relay = new PermissionRelay(decide, dlog);
      await relay.start();
      wiring = { onPermission: decide, env: relay.childEnv(), codexHookTrusted: codexPermissionHookTrusted(rc.home) };
    }
  } catch (err) {
    await relay?.stop();
    throw err;
  }
  const forwarding = access === "ask" && supportsAsk(target, wiring);
  const me = rc.me();
  const allowedServers = job ? job.allowedServers ??= /* @__PURE__ */ new Set() : /* @__PURE__ */ new Set();
  const defaultAllowTools = cfg.jobs?.defaultAllowTools ?? DEFAULT_CONFIG.jobs.defaultAllowTools;
  const baseAllow = [...cfg.autoApproveTools, ...access === "read" ? DESK_READ_PATTERNS : []];
  const requiredAllow = [...baseAllow, ...a.allow_tools ?? []];
  const autoApprove = [...baseAllow, ...effectiveAllowTools(a.allow_tools, defaultAllowTools)];
  const approve = async (r) => journalPermission(r, async () => {
    if (isHandoffToolCall(r)) {
      asked.push(`declined (handoff tool): ${r.tool} ${r.detail.slice(0, 80)}`);
      return { allow: false, message: HANDOFF_DECLINED };
    }
    if (!r.automaticReview && r.tool.startsWith("mcp:") && allowedServers.has(r.tool)) return { allow: true };
    const refused = isOwnServerCall(r) ? null : unreviewable(r);
    if (refused) {
      asked.push(`denied (too long to review): ${r.tool} ${r.detail.slice(0, 80)}`);
      return refused;
    }
    if (!r.automaticReview && (isOwnServerCall(r) || isAutoApproved(r, autoApprove))) return { allow: true };
    let d;
    if (wiring) d = await wiring.onPermission(r);
    else if (job && (!job.foreground || job.parentJob || job.ownershipHistory?.length) && rc.jobs) {
      const hint = approvalHint(r);
      const a2 = await rc.jobs.askParent(job, `${r.tool.replace(/^mcp:/, "MCP server ")}: ${r.detail}${hint}`, PARENT_APPROVAL_TIMEOUT_MS, r);
      d = a2.allow ? { allow: true } : { allow: false, message: `Denied by supervisor ${me}: ${a2.reason || "no reason supplied"}` };
      asked.push(`${d.allow ? "allowed" : "denied"} by ${me}: ${r.tool} ${r.detail.slice(0, 80)}`);
    } else if (askUser) {
      relayCalls++;
      d = await askUser(r);
      asked.push(`${d.allow ? "allowed" : "denied"}: ${r.tool} ${r.detail.slice(0, 80)}`);
    } else d = r.tool.startsWith("mcp:") && access === "edit" ? { allow: true } : { allow: false, message: "No one to ask in this session." };
    if (d.allow && !r.automaticReview && r.tool.startsWith("mcp:")) allowedServers.add(r.tool);
    return d;
  });
  let feed;
  try {
    feed = await startRunFeedReady({
      home: rc.home,
      name: `${target}-${randomUUID().slice(0, 8)}`,
      header: `${target}${a.model ? ` (${a.model}${a.effort ? `, effort ${a.effort}` : ""})` : a.effort ? ` (effort ${a.effort})` : ""} in ${displayPath(workdir)}, access ${access ?? "default"}, by ${me}${a.session_id ? `, continues ${a.session_id}` : ""}
${displayPathText(a.prompt)}
---`,
      forward: onProgress,
      meta: {
        metadataVersion: DELEGATION_METADATA_VERSION,
        bridgeVersion: APP_VERSION,
        parentJob: job?.parentJob,
        rootSession: job?.rootSession,
        by: me,
        byAgent: rc.agent,
        byCwd: rc.cwd(),
        job: a._job,
        // The job's current title (message_subagent can name or rename a job after it started).
        title: typeof job?.args?.title === "string" && job.args.title || a.title?.trim() || void 0,
        model: a.model ?? defaultModel ?? null,
        effort: a.effort ?? cfg.effort[target] ?? defaultEffort(target, a.model ?? defaultModel ?? null),
        access: access ?? "default",
        permission: profile.permission(cfg, { ...a, access }),
        workdir,
        ...wt ? { branch: wt.branch, baseBranch: wt.baseBranch, repoRoot: wt.repoRoot } : {},
        jobStartedAt: job?.startedAt,
        continues: a.session_id ?? null
      }
    }, signal);
  } catch (err) {
    await relay?.stop();
    throw err;
  }
  let link = null;
  let siblingLink = null;
  let jobNode = null;
  const liveDeliveries = /* @__PURE__ */ new Set();
  let steering = null;
  if (job && rc.jobs) {
    const jobs = rc.jobs;
    jobNode = rc.jobNode ?? new BridgeNode({
      pipePath: resolvePipePath(rc.home),
      token: loadOrCreateToken(rc.home),
      dbPath: resolveDbPath(rc.home),
      agent: "other",
      jobAgent: job.agent,
      id: `job:${job.id}`,
      name: job.name,
      cwd: workdir,
      jobOwner: job.supervisor ?? job.owner ?? me,
      jobParent: me,
      jobTitle: a.title,
      jobSendTo: a.send_to,
      autoWake: false,
      canHostBroker: false,
      log: dlog
    });
    siblingLink = new SiblingLink(jobNode, job, cfg.maxHops, dlog);
    void jobNode.start().catch((err) => dlog.warn("sibling bridge unavailable; retrying", { err: err.message }));
    const l = new ParentLink(
      me,
      (body, replyTo, kind) => {
        feed.report(`answer to ${me}: ${body.split("\n")[0].slice(0, 120)}`, `answer to ${me}: ${body}`);
        return jobs.fromSubagent(job, body, replyTo, kind === "question", kind === "note", kind === "question");
      },
      dlog,
      (percent, note, eta) => {
        job.percent = percent;
        job.progressNote = note;
        if (eta) Object.assign(job, eta);
        jobs.persist?.();
        feed.meta({ percent, progressNote: note, progressAt: Date.now(), ...eta ?? {} });
        feed.report(`progress ${percent}%${note ? `: ${note}` : ""}`);
      },
      siblingLink,
      (body) => jobs.escalateApproval ? jobs.escalateApproval(job, body) : Promise.reject(new Error("approval escalation unavailable"))
    );
    try {
      await l.start();
      link = l;
      job.live = {
        post: (m, sibling, controlId) => {
          const from = sibling?.from.name ?? me;
          const message = sibling ? formatSiblingMessages([sibling], siblingLink?.maxHops) : m;
          feed.report(`message from ${from}: ${m.split("\n")[0].slice(0, MESSAGE_PREVIEW_CHARS)}`, `message from ${from}: ${m}`);
          if (!steering) return void l.post(message, sibling, controlId);
          const s = steering;
          const delivery = s.send(message, Boolean(sibling)).then(
            (ok) => {
              if (!ok) l.post(message, sibling, controlId);
              else if (sibling) siblingLink?.consumed([sibling.id]);
            },
            () => {
              l.post(message, sibling, controlId);
            }
          );
          liveDeliveries.add(delivery);
          void delivery.finally(() => liveDeliveries.delete(delivery));
        }
      };
      siblingLink.flush();
    } catch (err) {
      dlog.warn("live link unavailable; messages to this subagent wait until it finishes", { err: err.message });
    }
  }
  const writableRoots = access === "edit" || a.sandbox === "workspace-write" ? await gitDirsOutside(workdir, dlog) : void 0;
  if (writableRoots?.length) dlog.info("extra writable folders for the subagent", { workdir, writableRoots });
  if (job) job.retitle = (title) => {
    feed.meta({ title });
    void jobNode?.updateJob({ jobTitle: title }).catch(() => {
    });
    void steering?.rename?.(title).catch((err) => dlog.warn("could not rename the Codex thread", { err: err.message }));
  };
  const slotOwner = { id: `${a._job ?? target}-${randomUUID()}`, pid: process.pid };
  let slots = null;
  let slotTimer;
  let res;
  let usageWarning = "";
  let failure;
  try {
    if (Object.keys(cfg.resourceSlots).length) {
      slots = new ResourceSlots(rc.home);
      slotTimer = setInterval(() => {
        try {
          slots?.renew(slotOwner);
        } catch (err) {
          dlog.warn("could not renew resource slots", { err: err.message });
        }
      }, SLOT_RENEW_MS);
      slotTimer.unref();
    }
    res = await retryTransient(
      {
        // With a live link the subagent can report how far it is (report_progress; shown in the dashboard).
        // A new session learns once that it reports back and leaves the handoff alone.
        prompt: [
          a.prompt,
          wt ? worktreeBaseReport(wt) : null,
          a.session_id ? null : DELEGATED_JOB_NOTE,
          `(agent-bridge reporting: ${a.notes === "milestones" ? 'Send only milestone notes, using send(message_kind="note").' : a.notes === "blockers" ? 'Send only blockers requiring attention, using send(message_kind="question").' : "No unsolicited progress notes. Final report only."} Use report_progress for dashboard progress. Questions requiring a supervisor decision use send(message_kind="question"); replies to a live request and final reports still reach the supervisor.)`,
          linkRoot ? WORKTREE_LINK_HINT : null,
          link ? PROGRESS_HINT : null,
          link ? SIBLING_HINT : null,
          resourceSlotHint(cfg.resourceSlots, bundledCli())
        ].filter(Boolean).join("\n\n"),
        title: typeof job?.args?.title === "string" && job.args.title || a.title,
        cwd: workdir,
        sessionId: a.session_id ?? null,
        timeoutSec: a.timeout_sec ?? (background ? MAX_JOB_TIMEOUT_SEC : DEFAULT_DELEGATE_TIMEOUT_SEC),
        maxDelegateDepth: cfg.maxDelegateDepth,
        model: a.model ?? defaultModel,
        effort: a.effort ?? cfg.effort[target] ?? null,
        // What it really runs (a CLI default or an alias resolved), for the dashboard.
        onInfo: (info) => feed.meta({ ...info.model ? { model: info.model } : {}, ...info.permission ? { permission: info.permission } : {}, effort: info.effort ?? a.effort ?? cfg.effort[target] ?? defaultEffort(target, info.model ?? null) }),
        log: dlog,
        signal,
        onProgress: feed.report,
        extraEnv: {
          ...link?.childEnv(),
          [ENV.home]: rc.home,
          [ENV.maxDelegateDepth]: String(cfg.maxDelegateDepth),
          // AGENT_BRIDGE_JOB_ID: the stable job name for tools in the job's processes that prove "same job" ownership.
          ...job ? { [PARENT_JOB_ENV]: job.name, AGENT_BRIDGE_JOB_ID: job.name, [ROOT_SESSION_ENV]: job.rootSession ?? job.supervisor ?? me, [ROOT_NAME_ENV]: job.rootName ?? me } : {},
          ...slots ? { [SLOT_OWNER_ENV]: slotOwner.id, [SLOT_PID_ENV]: String(slotOwner.pid) } : {}
        },
        writableRoots,
        onSession: (id) => {
          rc.startupReady?.();
          feed.meta({ session: id });
          if (job) rc.jobs?.note(job, { sessionId: id, workdir, worktree: wt });
        },
        approve,
        ...target === "claude" ? { claudeAllowTools: autoApprove, claudeRequiredAllowTools: requiredAllow } : {},
        onDenied: (message) => {
          link?.post(message);
        },
        // Someone answers approve's questions: the user ("ask" relay or a dialog) or, for a background
        // subagent, the parent agent. Else targets keep their own behavior (Claude and opencode).
        canApprove: Boolean(wiring) || Boolean(job && (!job.foreground || job.parentJob) && rc.jobs) || Boolean(rc.askUser && rc.userCanAnswer?.()),
        live: job ? {
          from: me,
          onSteering: (s) => {
            steering = s;
            const title = job.args?.title;
            if (s && typeof title === "string" && title !== a.title) job.retitle?.(title);
          },
          onAnswer: (answer) => {
            feed.report(`answer to ${me}: ${answer.split("\n")[0].slice(0, 120)}`, `answer to ${me}: ${answer}`);
            rc.jobs?.fromSubagent(job, answer, null, true);
          }
        } : void 0
      },
      async (req) => {
        onProgress?.("queued: waiting for machine startup admission");
        const release = await acquireStartup(rc.home, signal, job?.name ?? a._job);
        try {
          signal.throwIfAborted();
          const previous = job?.providerUsage?.turnStartedAt === job?.startedAt ? job?.providerUsage : void 0;
          if (previous?.decision.type === "warn" && !previous.warningReported) usageWarning = usageAdmissionText(previous.decision);
          const usage2 = await checkUsagePreflight(usageProbeFor(target, cfg, { home: rc.home, cwd: workdir, log: dlog }, req.model ?? void 0), previous?.warningReported || a._usageWarningReported || Boolean(usageWarning));
          signal.throwIfAborted();
          if (job) {
            const admittedControls = currentUsage(job, job.providerUsage) ? job.providerUsage?.admittedControls : void 0;
            job.providerUsage = { runId: job.usageRunId, turnStartedAt: job.startedAt, decision: usage2, admittedControls, warningReported: previous?.warningReported === true || usage2.type === "warn" || Boolean(usageWarning) };
            rc.jobs?.persist?.();
          }
          if (usage2.type === "block") {
            usageWarning = "";
            throw new Error(usageAdmissionText(usage2));
          }
          if (usage2.type === "warn") usageWarning = usageAdmissionText(usage2);
          if (job) {
            confirmUsageAdmission(job, (job.usagePendingControls ?? []).map((control) => control.cid));
            rc.jobs?.persist?.();
          }
          onProgress?.("starting native CLI");
          return await profile.run(cfg, { ...req, onSession: (id) => {
            release();
            req.onSession?.(id);
          } }, { ...a, access, relay: wiring });
        } finally {
          release();
        }
      }
    );
    if (usageWarning) res = { ...res, text: `${usageWarning}

${res.text}` };
    feed.meta({ session: res.sessionId });
    feed.end(signal.aborted ? "cancelled" : res.isError ? "failed" : "done", displayPathText(res.text));
    if (!res.isError && res.text.trim()) link?.reportCompleted();
  } catch (err) {
    failure = { err };
  } finally {
    if (job) denyPendingApprovals(job);
    clearInterval(slotTimer);
    if (slots) {
      try {
        slots.release(slotOwner);
      } catch (err) {
        dlog.warn("could not release resource slots; leases will expire", { err: err.message });
      } finally {
        slots.close();
      }
    }
    siblingLink?.close();
    if (jobNode && !rc.jobNode) await jobNode.stop();
    await Promise.allSettled(liveDeliveries);
    await relay?.stop();
    if (job) job.retitle = null;
    if (job && link) {
      job.live = null;
      const pending = await link.closeMessages();
      job.queue.unshift(...pending.map((message) => message.body));
      if (job.usageQueuedControls) job.usageQueuedControls.unshift(...pending.map((message) => ({ cid: message.controlId ?? randomUUID(), body: message.body })));
      if (usageRefused(job)) job.providerUsage.retainedControls = pending.flatMap((message) => message.controlId ? [{ cid: message.controlId, body: message.body }] : []);
    }
  }
  if (failure) {
    const { err } = failure;
    if (usageWarning && err instanceof Error) err.message = `${usageWarning}

${err.message}`;
    if (err instanceof DelegateError && err.sessionId) feed.meta({ session: err.sessionId });
    if (wt) {
      const branch = await git([...trustArgs(wt.path), "branch", "--show-current"], wt.path, dlog).catch(() => wt.branch);
      const branchHead = await git([...trustArgs(wt.path), "rev-parse", "HEAD"], wt.path, dlog).catch(() => void 0);
      feed.meta({ branch: branch || wt.branch, branchHead });
      try {
        if (linkRoot && scanWorktreeLinks(linkRoot).externalLinks.some((link2) => link2.path === resolve(linkRoot)))
          throw new Error("the worktree root is an external link");
        const subject = `WIP: ${subagentCommitMessage({ answer: "", task: a.prompt, job: a._job, agent: target, model: a.model ?? defaultModel })}`;
        const outcome = await finishWorktree(wt, subject, dlog, true);
        wt.branch = outcome.branch;
        wt.branchHead = await git([...trustArgs(wt.repoRoot, wt.path), "rev-parse", "HEAD"], wt.path, dlog);
        feed.meta({ branch: wt.branch, branchHead: wt.branchHead });
        if (err instanceof Error) err.message += `

${worktreeReport(wt, outcome)}`;
      } catch (commitError) {
        if (err instanceof Error) err.message += `

Could not make a WIP commit: ${commitError.message}${await dirtyFilesNote(wt, dlog)}`;
      }
    }
    feed.end(signal.aborted ? "cancelled" : displayPathText(`failed: ${err?.message ?? err}`));
    if (wt && err instanceof Error) err.message += `

${worktreeBaseReport(wt)}
Its worktree (with any partial work) is ${wt.path} on branch ${wt.branch}.`;
    if (linkRoot && err instanceof Error) {
      try {
        const warning = worktreeLinkWarning(scanWorktreeLinks(linkRoot));
        if (warning) err.message += `

${warning}`;
      } catch (scanError) {
        err.message += `
WARNING: worktree link inspection failed: ${scanError.message}`;
      }
    }
    if (err instanceof Error) err.message = displayPathText(err.message);
    throw err;
  }
  const notes = [`Step-by-step log: ${feed.logPath}`];
  if (target === "codex") {
    const mappingNote = codexPathReport(codexDriveMappings(`${cwd}
${a.prompt}`));
    if (mappingNote) notes.push(mappingNote);
  }
  let linkedWorktreeRoot = false;
  if (linkRoot) {
    try {
      const scan = scanWorktreeLinks(linkRoot);
      linkedWorktreeRoot = scan.externalLinks.some((link2) => link2.path === resolve(linkRoot));
      const warning = worktreeLinkWarning(scan);
      if (warning) notes.push(warning);
    } catch (err) {
      notes.push(`WARNING: worktree link inspection failed: ${err.message}`);
    }
  }
  if (access !== "ask" && asked.length) notes.push(`Approval requests forwarded:
${asked.join("\n")}`);
  if (access === "ask") {
    notes.push(
      forwarding ? asked.length ? `Permission requests forwarded to the user:
${asked.join("\n")}` : "No permission requests were needed." : t("ask.unsupported", { agent: target })
    );
  }
  const usage = formatUsage(res.details);
  if (usage) notes.push(usage);
  if (wt && linkedWorktreeRoot) {
    notes.push("Auto-commit skipped: the worktree root is an external link. Restore worktree isolation before running git or cleanup through it.");
  } else if (wt) {
    try {
      const subject = subagentCommitMessage({ answer: res.text, task: a.prompt, job: a._job, agent: target, model: a.model ?? defaultModel });
      const unfinished = res.isError || signal.aborted;
      const outcome = await finishWorktree(wt, unfinished ? `WIP: ${subject}` : subject, dlog, true);
      wt.branch = outcome.branch;
      wt.branchHead = await git([...trustArgs(wt.repoRoot, wt.path), "rev-parse", "HEAD"], wt.path, dlog);
      feed.meta({ branch: wt.branch, branchHead: wt.branchHead });
      notes.push(worktreeReport(wt, outcome));
    } catch (err) {
      notes.push(`Could not commit the changes in worktree ${wt.path} (branch ${wt.branch}): ${err.message}${await dirtyFilesNote(wt, dlog)}`);
    }
  } else if (before) {
    const after = await gitChangeSnapshot(workdir, dlog);
    const changed = after ? changedFiles(before, after) : [];
    if (access === "ask" && target === "codex" && forwarding && codexHash) {
      if (relayCalls > 0) recordCodexHookObservation(rc.home, codexHash, "verified");
      else if (changed.length) {
        recordCodexHookObservation(rc.home, codexHash, "failed");
        log.warn("codex changed files without the permission hook asking; forwarding disabled for this hook version", { changed });
        notes.push(t("ask.hookBypassed", { files: changed.join(", ") }));
      }
    }
    if (access === "edit" || changed.length) notes.push(changed.length ? `Files changed in your working copy:
${changed.join("\n")}` : "No files changed.");
    const warning = handoffWarning(changed);
    if (warning) notes.push(warning);
  }
  if (wt) notes.unshift(worktreeBaseReport(wt));
  return { ...res, workdir, worktree: wt ?? void 0, text: displayPathText(notes.length ? `${res.text}

---
${notes.join("\n\n")}` : res.text) };
}
async function dirtyFilesNote(wt, log) {
  try {
    const dirty = (await git([...trustArgs(wt.repoRoot, wt.path), "status", "--porcelain=v1", "-z", "--untracked-files=all"], wt.path, log)).split("\0").filter(Boolean).map((entry) => entry.slice(3));
    return dirty.length ? `
Dirty files left on the job worktree:
${dirty.join("\n")}` : "";
  } catch (statusError) {
    return `
Could not list dirty files in the job worktree: ${statusError.message}`;
  }
}

export {
  isBridgeWorktree,
  isInside,
  resumeArgs,
  runDelegate
};
