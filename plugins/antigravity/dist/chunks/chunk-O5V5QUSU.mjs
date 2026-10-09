import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  defaultEffort
} from "./chunk-KNKN5CEU.mjs";
import {
  codexPermissionHookHash,
  codexPermissionHookTrusted,
  recordCodexHookObservation
} from "./chunk-IOGZQ3DT.mjs";
import {
  prepareWorktreeContinuation,
  recordWorktreeOrigin
} from "./chunk-YS5QBWXI.mjs";
import {
  invalidateWorktreePathProof,
  worktreeLease
} from "./chunk-YWCSJN6E.mjs";
import {
  assertPhysicalPath
} from "./chunk-VBI722PL.mjs";
import {
  t
} from "./chunk-BG6KJS4H.mjs";
import {
  BridgeNode,
  REMOTE_JOB_POLL_MS,
  remoteSpawnArgsSchema
} from "./chunk-ONIAYRKT.mjs";
import {
  formatSiblingMessages,
  formatUsage
} from "./chunk-3EY3DDNH.mjs";
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
  worktreeLinkWarning,
  worktreeReport,
  worktreeRoots
} from "./chunk-AUHFUJG3.mjs";
import {
  DESK_READ_PATTERNS,
  approvalHint,
  isAutoApproved,
  isHandoffToolCall,
  isOwnServerCall
} from "./chunk-HFRXC4WN.mjs";
import {
  DELEGATION_TARGETS,
  DelegateError,
  JOB_SETTING_KEYS,
  PARENT_JOB_ENV,
  ParentLink,
  PermissionRelay,
  ROOT_NAME_ENV,
  ROOT_SESSION_ENV,
  RootConcurrency,
  appendContextEvent,
  bundledCli,
  checkDepth,
  codexDriveMappings,
  codexPathReport,
  denyPendingApprovals,
  jobEnvironment,
  killPid,
  pidAlive,
  retryTransient,
  supportsAsk,
  unreviewable,
  waitForApproval
} from "./chunk-77OLZCJD.mjs";
import {
  ResourceSlots,
  SLOT_OWNER_ENV,
  SLOT_PID_ENV,
  SLOT_RENEW_MS,
  resourceSlotHint
} from "./chunk-GWOVJPPW.mjs";
import {
  resolveDbPath,
  resolvePipePath
} from "./chunk-GVOVE4SF.mjs";
import {
  isJobSendTarget,
  siblingMaxHops
} from "./chunk-M26SH6VN.mjs";
import {
  loadOrCreateToken
} from "./chunk-V4WDBMEN.mjs";
import {
  SIBLING_CONVERSATION_PREFIX
} from "./chunk-4QXHCXBU.mjs";
import {
  legacyRunnerPeers,
  publishRunnerSpec,
  readRunnerStateRecord,
  runnerFilesImported,
  runnerSpecPath,
  runnerStatePath,
  writeRunnerStateRecord
} from "./chunk-LYYIJWEF.mjs";
import {
  startRunFeedReady
} from "./chunk-2Q5HH3UW.mjs";
import {
  JSON_STORE_VERSION,
  archiveFile,
  assertStoreUpgrade,
  assertWritableStore,
  existingMetadataDb,
  readJsonStore,
  refreshStorePeerIdentities,
  retentionLimit,
  writeJsonStore
} from "./chunk-ATZFJWXN.mjs";
import {
  identityStartedAfter,
  processIdentity
} from "./chunk-4EDVJNL7.mjs";
import {
  APP_VERSION,
  DEFAULT_DELEGATE_TIMEOUT_SEC,
  DELEGATION_METADATA_VERSION,
  ENV,
  MAX_JOB_TIMEOUT_SEC
} from "./chunk-7EOIPV3B.mjs";

// src/core/startup-admission.ts
import { randomUUID } from "node:crypto";
var STARTUP_CAPACITY = 2;
var STARTUP_RESOURCE = "delegate-startup";
async function acquireStartup(home, signal) {
  const slots = new ResourceSlots(home);
  const owner = { id: `startup-${randomUUID()}`, pid: process.pid };
  try {
    await slots.acquire(STARTUP_RESOURCE, STARTUP_CAPACITY, owner, signal);
  } catch (err) {
    slots.close();
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      slots.release(owner, STARTUP_RESOURCE);
    } finally {
      slots.close();
    }
  };
}

// src/mcp/delegate-run.ts
import { randomUUID as randomUUID2 } from "node:crypto";
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
  const owner = { id: `${job.name}-${randomUUID2()}`, pid: process.pid };
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
  const wt = a._worktree ?? (a.worktree ? await createWorktree({ cwd: a.cwd || rc.cwd(), home: rc.home, worktreeRoot: rc.cfg.worktreeRoot, jobId: randomUUID2().slice(0, 8), log: rc.log }) : null);
  const root = wt?.path ?? bridgeWorktreeRoot(a.cwd || rc.cwd(), rc.home);
  if (!root) return runDelegateInner(rc, target, a, signal, onProgress, background, job);
  const release = worktreeLease(rc.home, { path: root }, job?.id);
  try {
    if (wt) {
      if (!a._worktree) await recordWorktreeOrigin(rc.home, wt, rc.log);
      else await prepareWorktreeContinuation(rc.home, wt, rc.log);
    } else {
      assertPhysicalPath(root);
      invalidateWorktreePathProof(rc.home, root);
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
  const wt = a._worktree ?? (a.worktree ? await createWorktree({ cwd, home: rc.home, worktreeRoot: cfg.worktreeRoot, jobId: randomUUID2().slice(0, 8), log: dlog }) : null);
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
    const id = randomUUID2();
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
  const autoApprove = [...cfg.autoApproveTools, ...access === "read" ? DESK_READ_PATTERNS : [], ...a.allow_tools ?? []];
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
      name: `${target}-${randomUUID2().slice(0, 8)}`,
      header: `${target}${a.model ? ` (${a.model}${a.effort ? `, effort ${a.effort}` : ""})` : a.effort ? ` (effort ${a.effort})` : ""} in ${workdir}, access ${access ?? "default"}, by ${me}${a.session_id ? `, continues ${a.session_id}` : ""}
${a.prompt}
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
        post: (m, sibling) => {
          const from = sibling?.from.name ?? me;
          const message = sibling ? formatSiblingMessages([sibling], siblingLink?.maxHops) : m;
          feed.report(`message from ${from}: ${m.split("\n")[0].slice(0, MESSAGE_PREVIEW_CHARS)}`, `message from ${from}: ${m}`);
          if (!steering) return void l.post(message, sibling);
          const s = steering;
          const delivery = s.send(message, Boolean(sibling)).then(
            (ok) => {
              if (!ok) l.post(message, sibling);
              else if (sibling) siblingLink?.consumed([sibling.id]);
            },
            () => {
              l.post(message, sibling);
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
  const slotOwner = { id: `${a._job ?? target}-${randomUUID2()}`, pid: process.pid };
  let slots = null;
  let slotTimer;
  let res;
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
        const release = await acquireStartup(rc.home, signal);
        try {
          signal.throwIfAborted();
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
    feed.meta({ session: res.sessionId });
    feed.end(signal.aborted ? "cancelled" : res.isError ? "failed" : "done", res.text);
    if (!res.isError && res.text.trim()) link?.reportCompleted();
  } catch (err) {
    if (err instanceof DelegateError && err.sessionId) feed.meta({ session: err.sessionId });
    if (wt) {
      const branch = await git([...trustArgs(wt.path), "branch", "--show-current"], wt.path, dlog).catch(() => wt.branch);
      const branchHead = await git([...trustArgs(wt.path), "rev-parse", "HEAD"], wt.path, dlog).catch(() => void 0);
      feed.meta({ branch: branch || wt.branch, branchHead });
    }
    feed.end(signal.aborted ? "cancelled" : `failed: ${err?.message ?? err}`);
    if (wt && err instanceof Error) err.message += `

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
    throw err;
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
      job.queue.unshift(...await link.close());
    }
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
      const message = subagentCommitMessage({ answer: res.text, task: a.prompt, job: a._job, agent: target, model: a.model ?? defaultModel });
      const outcome = await finishWorktree(wt, message, dlog);
      wt.branch = outcome.branch;
      wt.branchHead = await git([...trustArgs(wt.repoRoot, wt.path), "rev-parse", "HEAD"], wt.path, dlog);
      feed.meta({ branch: wt.branch, branchHead: wt.branchHead });
      notes.push(worktreeReport(wt, outcome));
    } catch (err) {
      notes.push(`Could not commit the changes in worktree ${wt.path} (branch ${wt.branch}): ${err.message}`);
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
  return { ...res, workdir, worktree: wt ?? void 0, text: notes.length ? `${res.text}

---
${notes.join("\n\n")}` : res.text };
}

// src/mcp/job-host.ts
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join as join3 } from "node:path";

// src/mcp/remote-job-host.ts
import { join as join2 } from "node:path";
var REMOTE_STATE_GRACE_MS = 9e4;
var RemoteJobHost = class {
  constructor(node, home, log) {
    this.node = node;
    this.home = home;
    this.log = log;
  }
  node;
  home;
  log;
  busy = /* @__PURE__ */ new Set();
  cache = /* @__PURE__ */ new Map();
  path(job) {
    return join2(this.home, "remote-job-states", `${job.id}.json`);
  }
  read(job) {
    return this.cache.get(job.id) ?? readJsonStore(this.path(job));
  }
  save(job, snapshot) {
    const data = { fetchedAt: Date.now(), snapshot };
    this.cache.set(job.id, data);
    writeJsonStore(this.path(job), data, readJsonStore(this.path(job)));
  }
  start(job, host, target, args) {
    job.remote = { host, name: `${target}-job-${job.id}` };
    this.cache.delete(job.id);
    this.save(job, { state: null, alive: true, approvals: [] });
    const raw = { ...args, cwd: args.cwd ?? job.workdir };
    for (const key of ["host", "_job", "_worktree", "send_to"]) delete raw[key];
    const request = { op: "spawn", job: job.id, target, args: remoteSpawnArgsSchema.parse(raw) };
    this.busy.add(job.id);
    void this.node.remoteJob(host, request).then((snapshot) => {
      this.save(job, snapshot);
      if (job.controller.signal.aborted) this.send(job, { type: "cancel" });
    }, (err) => {
      this.save(job, { state: { pid: 0, peer: `${host}/${job.name}`, status: "failed", updatedAt: Date.now(), report: `Remote job failed: ${err.message}`, delivered: false }, alive: false, approvals: [] });
    }).finally(() => this.busy.delete(job.id));
    return { pid: null, peer: `${host}/${job.name}`, startedAt: Date.now() };
  }
  state(job) {
    const cached = this.read(job);
    if (!this.busy.has(job.id) && (!cached || Date.now() - cached.fetchedAt >= REMOTE_JOB_POLL_MS)) this.sendRequest(job, { op: "state", job: job.id });
    return cached?.snapshot.state ?? null;
  }
  alive(job) {
    const cached = this.read(job);
    return cached ? cached.snapshot.alive && Date.now() - cached.fetchedAt < REMOTE_STATE_GRACE_MS : Date.now() - (job.host?.startedAt ?? 0) < REMOTE_STATE_GRACE_MS;
  }
  send(job, control) {
    this.sendRequest(job, { op: "control", job: job.id, control });
  }
  sendRequest(job, request) {
    if (!job.remote) return;
    if (request.op === "state") this.busy.add(job.id);
    void this.node.remoteJob(job.remote.host, request).then((snapshot) => this.save(job, snapshot), (err) => {
      this.log.warn("remote job request failed", { job: job.name, host: job.remote?.host, operation: request.op, err: err.message });
    }).finally(() => {
      if (request.op === "state") this.busy.delete(job.id);
    });
  }
};

// src/mcp/job-host.ts
import { setTimeout as delay } from "node:timers/promises";
var RUNNERS_DIR_NAME = "jobs";
var JOB_PEER_PREFIX = "job:";
var CONTROL_CONVERSATION_PREFIX = "jobctl-";
var RUNNER_HEARTBEAT_MS = 15e3;
var START_GRACE_MS = 3e4;
var KEEP_FILES_MS = 7 * 24 * 60 * 60 * 1e3;
var DETACH_LAUNCHER = "const c=require('node:child_process').spawn(process.execPath,process.argv.slice(1),{detached:true,stdio:'ignore',windowsHide:true});c.on('error',()=>process.exit(1));if(c.pid)process.stdout.write(String(c.pid));c.unref()";
function runnerStatePath2(home, id) {
  return runnerStatePath(home, id);
}
function specPath(home, id) {
  return runnerSpecPath(home, id);
}
function readRunnerState(home, id) {
  const path = runnerStatePath2(home, id);
  try {
    const s = readRunnerStateRecord(home, id, { preserveCorrupt: true });
    return s && typeof s.pid === "number" && typeof s.status === "string" ? s : null;
  } catch {
    return null;
  }
}
function writeRunnerState(home, id, state) {
  const identity = state.identity ?? (state.pid === process.pid ? processIdentity(process.pid) : void 0);
  writeRunnerStateRecord(home, id, { ...state, ...identity ? { identity } : {} });
}
var IDENTITY_CACHE_MS = 3e4;
var probed = /* @__PURE__ */ new Map();
function runnerProcessAlive(state, fresh = false) {
  if (!pidAlive(state.pid)) return false;
  let entry = probed.get(state.pid);
  if (fresh || !entry || Date.now() - entry.at >= IDENTITY_CACHE_MS) probed.set(state.pid, entry = { identity: processIdentity(state.pid), at: Date.now() });
  if (entry.identity === void 0) return !fresh;
  if (state.identity) return entry.identity === state.identity;
  return !Number.isFinite(state.updatedAt) || !identityStartedAfter(entry.identity, state.updatedAt + 1e3);
}
var JobRunners = class {
  constructor(node, home, cli, log) {
    this.node = node;
    this.home = home;
    this.cli = cli;
    this.log = log;
    this.remote = new RemoteJobHost(node, home, log);
    try {
      const dir = join3(home, RUNNERS_DIR_NAME);
      const keepMs = retentionLimit("AGENT_BRIDGE_RUNNER_KEEP_MS", KEEP_FILES_MS);
      if (!keepMs) return;
      if (existingMetadataDb(home) && runnerFilesImported(home) && !legacyRunnerPeers(home)) return;
      for (const f of readdirSync(dir)) {
        const path = join3(dir, f);
        if (!f.endsWith(".json") || f.endsWith(".spec.json") || Date.now() - statSync(path).mtimeMs <= keepMs) continue;
        const id = f.replace(/\.json$/, "");
        const state = readRunnerState(home, id);
        if (state?.status === "done" || state?.status === "failed" || state?.status === "cancelled") {
          archiveFile(path);
          archiveFile(specPath(home, id));
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") this.log.warn("could not archive runner files", { err: String(err) });
    }
  }
  node;
  home;
  cli;
  log;
  remote;
  /** Start a turn of this job in a new runner; null when that is not possible (the turn then runs in the server). */
  async startAsync(job, spec, admission) {
    const signal = admission?.signal ?? job.controller.signal;
    let attempts = 0;
    for (; ; ) {
      signal.throwIfAborted();
      await refreshStorePeerIdentities(this.home, signal);
      signal.throwIfAborted();
      if (admission && !admission.isCurrent()) throw new Error("Detached job startup lost its supervisor authority before launch");
      try {
        return this.start(job, spec);
      } catch (error) {
        if (error.code !== "STORE_UPGRADE_DEFERRED") throw error;
        job.progress = `queued: ${error.message}`;
        if (attempts++ % 30 === 0) this.log.info("job runner start waits for retained store readers", { job: job.name, reason: String(error) });
        await delay(Math.min(1e3, attempts * 100), void 0, { signal });
      }
    }
  }
  start(job, spec) {
    if (spec.args.host) return this.remote.start(job, spec.args.host, spec.target, spec.args);
    try {
      mkdirSync(join3(this.home, RUNNERS_DIR_NAME), { recursive: true });
      const statePath = runnerStatePath2(this.home, job.id);
      const file = specPath(this.home, job.id);
      assertWritableStore(readJsonStore(statePath, this.log));
      assertWritableStore(readJsonStore(file, this.log));
      assertStoreUpgrade(this.home, "json", 0, JSON_STORE_VERSION);
      const full = {
        ...spec,
        home: this.home,
        job: {
          id: job.id,
          name: job.name,
          agent: job.agent,
          model: job.model,
          prompt: job.prompt,
          startedAt: job.startedAt,
          args: job.args,
          sessionId: job.sessionId,
          workdir: job.workdir,
          worktree: job.worktree,
          owner: job.owner,
          supervisor: job.supervisor,
          metadataVersion: job.metadataVersion,
          parentJob: job.parentJob,
          rootSession: job.rootSession,
          rootName: job.rootName,
          allowedServers: [...job.allowedServers ?? []]
        }
      };
      const args = [this.cli, "job-runner", publishRunnerSpec(this.home, job.id, { ...full })];
      const info = { pid: null, peer: job.name, startedAt: Date.now() };
      let pid = null;
      if (process.platform === "win32") {
        const launcher = spawn(process.execPath, ["-e", DETACH_LAUNCHER, ...args], { env: jobEnvironment(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        let output = "";
        launcher.stdout.on("data", (chunk) => {
          output += chunk;
        });
        launcher.on("close", () => {
          const reported = Number(output);
          if (Number.isSafeInteger(reported) && reported > 0) info.pid = reported;
        });
        launcher.on("error", (err) => this.log.warn("could not start a job runner", { job: job.name, err: err.message }));
      } else {
        const child = spawn(process.execPath, args, { env: jobEnvironment(), detached: true, stdio: "ignore" });
        child.on("error", (err) => this.log.warn("could not start a job runner", { job: job.name, err: err.message }));
        child.unref();
        pid = child.pid ?? null;
      }
      this.log.info("job runner started", { job: job.name, pid });
      info.pid = pid;
      return info;
    } catch (err) {
      if (err.code === "STORE_UPGRADE_DEFERRED") throw err;
      this.log.warn("job runner unavailable; the subagent runs inside this server", { job: job.name, err: err.message });
      return null;
    }
  }
  state(job) {
    if (job.remote) return this.remote.state(job);
    return readRunnerState(this.home, job.id);
  }
  alive(job, state) {
    if (job.remote) return this.remote.alive(job);
    if (!state) {
      const host = job.host;
      return Boolean(host) && (host.pid !== null ? pidAlive(host.pid) : Date.now() - host.startedAt < START_GRACE_MS);
    }
    return runnerProcessAlive(state);
  }
  send(job, control) {
    if (job.remote) return this.remote.send(job, control);
    const to = this.state(job)?.peer ?? job.host?.peer ?? job.name;
    this.node.send({ to, body: JSON.stringify(control), conversationId: `${CONTROL_CONVERSATION_PREFIX}${job.id}` }, { quiet: true }).catch((err) => this.log.warn("could not reach the job runner", { job: job.name, control: control.type, err: err.message }));
  }
  kill(job) {
    if (job.remote) return this.remote.send(job, { type: "cancel" });
    const state = this.state(job);
    if (state) {
      if (runnerProcessAlive(state, true)) killPid(state.pid, this.log);
      else this.log.warn("job runner PID no longer belongs to the runner; not killing it", { job: job.name, pid: state.pid });
      return;
    }
    if (job.host?.pid) killPid(job.host.pid, this.log);
  }
};

export {
  acquireStartup,
  isBridgeWorktree,
  isInside,
  resumeArgs,
  runDelegate,
  JOB_PEER_PREFIX,
  CONTROL_CONVERSATION_PREFIX,
  RUNNER_HEARTBEAT_MS,
  readRunnerState,
  writeRunnerState,
  JobRunners
};
