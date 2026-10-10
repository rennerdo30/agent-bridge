import { worktreeRoots } from "../core/worktree.js";
import { randomUUID } from "node:crypto";
import { appendContextEvent } from "../core/context-journal.js";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BridgeConfig } from "../core/config.js";
import { APP_VERSION, DEFAULT_DELEGATE_TIMEOUT_SEC, DELEGATION_METADATA_VERSION, ENV, MAX_JOB_TIMEOUT_SEC } from "../core/constants.js";
import { bundledCli, checkDepth, DelegateError, PARENT_JOB_ENV, ROOT_NAME_ENV, ROOT_SESSION_ENV, retryTransient, type DelegateResult } from "../core/delegate.js";
import { RootConcurrency } from "../core/root-concurrency.js";
import { acquireStartup } from "../core/startup-admission.js";
import { defaultEffort } from "../core/effort.js";
import { t } from "../core/i18n.js";
import type { Logger } from "../core/logger.js";
import { ParentLink, type ParentRoute } from "../core/parent-link.js";
import { BridgeNode } from "../core/node.js";
import { resolveDbPath, resolvePipePath } from "../core/paths.js";
import { loadOrCreateToken } from "../core/token.js";
import type { AgentKind, CodingAgent } from "../core/protocol.js";
import { PermissionRelay, unreviewable, type PermissionDecision, type PermissionRequest } from "../core/relay.js";
import { codexPermissionHookHash, codexPermissionHookTrusted, recordCodexHookObservation } from "../core/codex-trust.js";
import { startRunFeed, startRunFeedReady } from "../core/runfeed.js";
import { ResourceSlots, resourceSlotHint, SLOT_OWNER_ENV, SLOT_PID_ENV, SLOT_RENEW_MS } from "../core/resource-slots.js";
import { approvalHint, DESK_READ_PATTERNS, isAutoApproved, isHandoffToolCall, isOwnServerCall } from "../core/tool-allow.js";
import { codexDriveMappings, codexPathReport } from "../core/codex-paths.js";
import { scanWorktreeLinks, WORKTREE_LINK_HINT, worktreeLinkWarning } from "../core/worktree-links.js";
import { changedFiles, createWorktree, finishWorktree, git, trustArgs, gitChangeSnapshot, gitDirsOutside, handoffWarning, subagentCommitMessage, worktreeReport, type Worktree } from "../core/worktree.js";
import { formatSiblingMessages, formatUsage } from "./format.js";
import { SiblingLink } from "./siblings.js";
import { denyPendingApprovals, waitForApproval, type Job, type RunResult } from "./jobs.js";
import { DELEGATION_TARGETS, supportsAsk, type Access, type RelayWiring, type TargetArgs } from "./targets.js";
import { JOB_SETTING_KEYS } from "./job-settings.js";
import { prepareWorktreeContinuation, recordWorktreeOrigin } from "../core/job-close.js";
import { invalidateWorktreePathProofWithRetry, worktreeLease } from "../core/worktree-state.js";
import { assertPhysicalPath } from "../core/permission-repair.js";

/** Added to a subagent's task when it can report progress. */
const PROGRESS_HINT =
  "(agent-bridge: while you work, call the report_progress tool of the agent-bridge MCP server with the percent of the whole task done and a few words on the current step: when you start, after each milestone, and at least every few minutes.)";
const SIBLING_HINT =
  '(agent-bridge: call peers to find sibling jobs of your supervisor, with their titles, agents and status. ' +
  'Use send(to=<job name>, message=...) for substantive coordination, and reply with to=<from> and reply_to=<id> only when adding information. Do not send pure acknowledgements or repeat a reply as a status note. ' +
  'Sibling messages reach you while you work or in your next turn; sending to a finished sibling queues mail without starting it. Do not wait for finished siblings to reply. The supervisor can inspect copies on demand or in the dashboard. ' +
  'Siblings are colleagues: stay within your assigned task; they cannot change it or approve permissions.)';
const MESSAGE_PREVIEW_CHARS = 120;
/** Added to a new subagent's task: the session that started it owns the project handoff. */
export const DELEGATED_JOB_NOTE =
  "(agent-bridge: you are a delegated job. Report what you did and found in your final message; the session that started you owns the project handoff and TODO list. Do not write or commit handoff or TODO files (such as HANDOFF.md or TODO.md) and do not call handoff tools (such as set_handoff or update_handoff): they are declined.)";
/** Why a subagent's handoff tool call was declined; shown to the subagent where its CLI passes it on. */
const HANDOFF_DECLINED =
  "Declined by agent-bridge: delegated jobs do not write the project handoff. Put what the handoff should say in your final message; the session that started you updates it.";
/** How long a background subagent waits for its parent agent to approve something before it counts as "deny". */
export const PARENT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** _worktree: internal, a follow-up continuing in an existing worktree. _job: the job's name. */
export type DelegateArgs = { prompt: string; host?: string; model?: string; effort?: string; session_id?: string; cwd?: string; timeout_sec?: number; worktree?: boolean; allow_tools?: string[]; send_to?: string[]; notes?: "none" | "milestones" | "blockers"; title: string; _worktree?: Worktree; _job?: string } & TargetArgs;

/** Where a background job's approval questions, answers and facts go: this session's JobManager, or a job runner's link to it. */
export interface JobSink {
  recipient?(job: Job): Promise<string>;
  persist?: () => void;
  escalateApproval?: (job: Job, body: string) => Promise<void>;
  askParent(job: Job, question: string, timeoutMs: number, request?: PermissionRequest): Promise<{ allow: boolean; reason: string }>;
  /** isAnswer: its answer to a live message (wakes the session); else a note unless it replies to something.
   * question: send with message_kind="question"; a sink may report where it was routed (AB-249). */
  fromSubagent(job: Job, body: string, replyTo: string | null, isAnswer?: boolean, forceNote?: boolean, question?: boolean): void | Promise<ParentRoute | undefined>;
  note(job: Job, facts: { sessionId?: string | null; workdir?: string | null; worktree?: Worktree | null }): void;
}

/** What a delegated run needs from the process that runs it (the session's MCP server or a job runner). */
export interface RunContext {
  /** Release machine startup admission once the native CLI reports its session. */
  startupReady?: () => void;
  /** Agent kind of the session that started the run. */
  agent: AgentKind;
  cfg: BridgeConfig;
  home: string;
  log: Logger;
  /** Peer name of that session (the subagent's parent). */
  me: () => string;
  /** Its project directory: the default working directory. */
  cwd: () => string;
  /** Ask the user in the session (MCP elicitation); only the MCP server has it. */
  askUser?: (req: PermissionRequest) => Promise<PermissionDecision>;
  userCanAnswer?: () => boolean;
  jobs?: JobSink;
  /** Detached runners already have a hidden job peer; in-process runs create their own. */
  jobNode?: BridgeNode;
}

/** A folder inside ~/.agent-bridge/worktrees (a subagent worktree, possibly from an earlier job). */
export function isBridgeWorktree(dir: string, home: string): boolean {
  return bridgeWorktreeRoot(dir, home) !== null;
}

/** A caller may resume from a nested project directory; inspect the whole managed worktree. */
function bridgeWorktreeRoot(dir: string, home: string): string | null {
  for (const [index, root] of worktreeRoots(home).entries()) {
    if (!isInside(dir, root) || resolve(dir) === resolve(root)) continue;
    const name = relative(root, resolve(dir)).split(/[\\/]/)[0]!;
    // A configured worktreeRoot may hold other folders; only job-named trees (<repo>-<job id>) count there.
    if (index > 0 && !/-[0-9a-f]{8}$/.test(name)) continue;
    return join(root, name);
  }
  return null;
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Follow-up arguments: saved settings in the session and folder (or worktree) the job used. */
export function resumeArgs(a: DelegateArgs, job: string, message: string, sessionId: string, workdir: string | null, worktree: Worktree | null, saved?: Record<string, unknown>): DelegateArgs {
  if (saved) {
    a = { ...a };
    for (const key of JOB_SETTING_KEYS) delete a[key];
    a = { ...a, ...Object.fromEntries(JOB_SETTING_KEYS.filter((key) => saved[key] !== undefined).map((key) => [key, saved[key]])) };
  }
  return { ...a, _job: job, prompt: message, session_id: sessionId, cwd: workdir ?? a.cwd, worktree: false, _worktree: worktree ?? undefined, access: a.worktree ? (a.access ?? "edit") : a.access };
}

/** Plain jobs stay read-only; worktree edit jobs honor their separate default and exact overrides. */
export function worktreeArgs(target: CodingAgent, a: DelegateArgs, cfg: BridgeConfig, cwd: string, home: string, platform = process.platform): DelegateArgs {
  const worktree = Boolean(a.worktree || a._worktree || isBridgeWorktree(cwd, home));
  const access = worktree ? (a.access ?? "edit") : a.access;
  const sandbox = target === "codex" && worktree && access === "edit" && a.sandbox === undefined
    ? cfg.codexWorktreeSandbox ?? (cfg.codexSandbox === "read-only" ? platform === "win32" ? "danger-full-access" : "workspace-write" : cfg.codexSandbox)
    : a.sandbox;
  return { ...a, access, ...(sandbox !== undefined ? { sandbox } : {}) };
}

/** Run the delegate; returns its result plus a report of what it changed. */
export async function runDelegate(
  rc: RunContext, target: CodingAgent, a: DelegateArgs, signal: AbortSignal,
  onProgress: ((message: string) => void) | undefined, background: boolean, job?: Job,
): Promise<RunResult> {
  checkDepth(rc.cfg.maxDelegateDepth);
  if (!job?.rootSession) return runWithWorktreeLease(rc, target, a, signal, onProgress, background, job);
  const budget = new RootConcurrency(rc.home, job.rootSession);
  const owner = { id: `${job.name}-${randomUUID()}`, pid: process.pid };
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!job.parentJob) budget.ensureLimit(rc.cfg.maxJobs);
    onProgress?.("queued: waiting for root admission");
    await budget.acquireWhenAvailable(owner, signal);
    timer = setInterval(() => { try { budget.renew(owner); } catch (err) { rc.log.warn("could not renew root concurrency lease", { err: String(err) }); } }, SLOT_RENEW_MS);
    timer.unref();
    return await runWithWorktreeLease(rc, target, a, signal, onProgress, background, job);
  } finally { clearInterval(timer); try { budget.release(owner); } finally { budget.close(); } }
}

async function runWithWorktreeLease(rc: RunContext, target: CodingAgent, a: DelegateArgs, signal: AbortSignal, onProgress: ((message: string) => void) | undefined, background: boolean, job?: Job): Promise<RunResult> {
  signal.throwIfAborted();
  onProgress?.("preparing run context");
  const wt = a._worktree ?? (a.worktree ? await createWorktree({ cwd: a.cwd || rc.cwd(), home: rc.home, worktreeRoot: rc.cfg.worktreeRoot, jobId: randomUUID().slice(0, 8), log: rc.log }) : null);
  const root = wt?.path ?? bridgeWorktreeRoot(a.cwd || rc.cwd(), rc.home);
  if (!root) return runDelegateInner(rc, target, a, signal, onProgress, background, job);
  const release = worktreeLease(rc.home, { path: root }, job?.id);
  try {
    // A reader that is just exiting must not fail the turn at once (AB-260): these state writes wait
    // for a fresh identity scan with backoff, then fail with the same blocker message as before.
    const retry = { signal, log: rc.log, onWait: (message: string) => onProgress?.(`queued: ${message}`) };
    if (wt) {
      if (!a._worktree) await recordWorktreeOrigin(rc.home, wt, rc.log, retry);
      else await prepareWorktreeContinuation(rc.home, wt, rc.log, retry);
    } else {
      assertPhysicalPath(root);
      await invalidateWorktreePathProofWithRetry(rc.home, root, retry);
    }
    return await runDelegateInner(rc, target, wt ? { ...a, _worktree: wt } : a, signal, onProgress, background, job);
  } finally { release(); }
}

async function runDelegateInner(
  rc: RunContext,
  target: CodingAgent,
  a: DelegateArgs,
  signal: AbortSignal,
  onProgress: ((message: string) => void) | undefined,
  background: boolean,
  job?: Job,
): Promise<RunResult> {
  const { cfg, log } = rc;
  const profile = DELEGATION_TARGETS[target];
  const defaultModel = profile.defaultModel(cfg);
  const dlog = log.child("delegate");
  const cwd = a.cwd || rc.cwd();
  // Worktrees (new, continued, or an agent-bridge worktree given as cwd) exist to be edited in: edit by default.
  a = worktreeArgs(target, a, cfg, cwd, rc.home);
  const access: Access | undefined = a.access;
  // A follow-up to a worktree job keeps working (and committing) in that worktree.
  const wt = a._worktree ?? (a.worktree ? await createWorktree({ cwd, home: rc.home, worktreeRoot: cfg.worktreeRoot, jobId: randomUUID().slice(0, 8), log: dlog }) : null);
  const workdir = wt?.cwd ?? cwd;
  const linkRoot = wt?.path ?? bridgeWorktreeRoot(workdir, rc.home);
  // Codex in "ask" mode can only change files through an approval: watching the folder tells us whether
  // its permission hook really asked (see codex-trust.ts).
  const watchChanges = !wt && (access === "edit" || (access === "ask" && target === "codex"));
  const before = watchChanges ? await gitChangeSnapshot(workdir, dlog) : null;
  // access "ask": forward the subagent's permission requests to the user in this session.
  let relay: PermissionRelay | null = null;
  let wiring: RelayWiring | undefined;
  const asked: string[] = [];
  let relayCalls = 0;
  const codexHash = target === "codex" ? codexPermissionHookHash() : null;
  const journalPermission = async (request: PermissionRequest, decide: () => Promise<PermissionDecision>) => {
    const id = randomUUID();
    const context = { kind: "approval" as const, agent: target, project: workdir, job: job?.name ?? a._job, session: job?.sessionId ?? undefined };
    await appendContextEvent(rc.home, { ...context, payload: { id, stage: "request", request } });
    const decision = await decide();
    await appendContextEvent(rc.home, { ...context, payload: { id, stage: "decision", decision } });
    return decision;
  };
  // Native permission dialogs keep their existing eligibility; the dashboard can answer the same wait.
  const askUser = rc.askUser ? async (r: PermissionRequest): Promise<PermissionDecision> => {
    if (!job) return rc.askUser!(r);
    if (rc.jobs && ((job.ownershipHistory?.length && job.owner !== rc.me()) || (rc.jobs.recipient && await rc.jobs.recipient(job) !== rc.me()))) {
      const answer = await rc.jobs.askParent(job, `${r.tool}: ${r.detail}`, PARENT_APPROVAL_TIMEOUT_MS, r);
      return answer.allow ? { allow: true } : { allow: false, message: answer.reason };
    }
    const decision = await waitForApproval(job, `${r.tool}: ${r.detail}`, PARENT_APPROVAL_TIMEOUT_MS,
      (body) => rc.jobs?.fromSubagent(job, body, null, true), dlog, rc.home, r, () => rc.askUser!(r));
    return decision.allow ? { allow: true } : { allow: false, message: decision.reason.replace(/^deny:\s*/, "") };
  } : undefined;
  try {
    if (access === "ask" && askUser) {
      const decide = async (r: PermissionRequest) => journalPermission(r, async () => {
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
  // Approval questions a subagent asks while it works (Codex app-server: MCP tool calls, and in "ask" mode
  // commands and edits; opencode "edit" runs: what its rules leave to "ask"; Claude "edit" runs: permission
  // prompts, through a PermissionRequest hook) go to the parent agent of a background subagent, else to this
  // session's user. One "allow" per MCP server covers the rest of the run.
  // Remembered per job, so follow-ups and recoveries don't ask again.
  const allowedServers = job ? (job.allowedServers ??= new Set<string>()) : new Set<string>();
  const autoApprove = [...cfg.autoApproveTools, ...(access === "read" ? DESK_READ_PATTERNS : []), ...(a.allow_tools ?? [])];
  const approve = async (r: PermissionRequest): Promise<PermissionDecision> => journalPermission(r, async () => {
    // Handoff tools first: no allow pattern or earlier "allow" for their server covers them.
    if (isHandoffToolCall(r)) {
      asked.push(`declined (handoff tool): ${r.tool} ${r.detail.slice(0, 80)}`);
      return { allow: false, message: HANDOFF_DECLINED };
    }
    if (!r.automaticReview && r.tool.startsWith("mcp:") && allowedServers.has(r.tool)) return { allow: true };
    // Never decide (or pattern-match) a cut text: the owner must see everything they allow (AB-241).
    const refused = isOwnServerCall(r) ? null : unreviewable(r);
    if (refused) {
      asked.push(`denied (too long to review): ${r.tool} ${r.detail.slice(0, 80)}`);
      return refused;
    }
    // Its own agent-bridge tools (answering the parent, report_progress) never need a question.
    if (!r.automaticReview && (isOwnServerCall(r) || isAutoApproved(r, autoApprove))) return { allow: true };
    let d: PermissionDecision;
    if (wiring) d = await wiring.onPermission(r);
    else if (job && (!job.foreground || job.parentJob || job.ownershipHistory?.length) && rc.jobs) {
      // A background subagent asks the agent that started it (it can decide, also in auto mode or with
      // the user away). A blocking ask_* caller cannot answer while it waits, so that one asks the user.
      // Name the allow_tools pattern that would cover this call, so the next spawn need not ask.
      const hint = approvalHint(r);
      const a = await rc.jobs.askParent(job, `${r.tool.replace(/^mcp:/, "MCP server ")}: ${r.detail}${hint}`, PARENT_APPROVAL_TIMEOUT_MS, r);
      d = a.allow ? { allow: true } : { allow: false, message: `Denied by supervisor ${me}: ${a.reason || "no reason supplied"}` };
      asked.push(`${d.allow ? "allowed" : "denied"} by ${me}: ${r.tool} ${r.detail.slice(0, 80)}`);
    } else if (askUser) {
      relayCalls++;
      d = await askUser(r);
      asked.push(`${d.allow ? "allowed" : "denied"}: ${r.tool} ${r.detail.slice(0, 80)}`);
    } else d = r.tool.startsWith("mcp:") && access === "edit" ? { allow: true } : { allow: false, message: "No one to ask in this session." };
    if (d.allow && !r.automaticReview && r.tool.startsWith("mcp:")) allowedServers.add(r.tool);
    return d;
  });
  let feed: ReturnType<typeof startRunFeed>;
  try {
    feed = await startRunFeedReady({
      home: rc.home,
      name: `${target}-${randomUUID().slice(0, 8)}`,
      header: `${target}${a.model ? ` (${a.model}${a.effort ? `, effort ${a.effort}` : ""})` : a.effort ? ` (effort ${a.effort})` : ""} in ${workdir}, access ${access ?? "default"}, by ${me}${a.session_id ? `, continues ${a.session_id}` : ""}\n${a.prompt}\n---`,
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
        title: (typeof job?.args?.title === "string" && job.args.title) || a.title?.trim() || undefined,
        model: a.model ?? defaultModel ?? null,
        effort: a.effort ?? cfg.effort[target] ?? defaultEffort(target, a.model ?? defaultModel ?? null),
        access: access ?? "default",
        permission: profile.permission(cfg, { ...a, access }),
        workdir,
        ...(wt ? { branch: wt.branch, baseBranch: wt.baseBranch, repoRoot: wt.repoRoot } : {}),
        jobStartedAt: job?.startedAt,
        continues: a.session_id ?? null,
      },
    }, signal);
  } catch (err) {
    await relay?.stop();
    throw err;
  }
  // Live link: this session's messages reach the subagent while it works, and it can answer at once.
  let link: ParentLink | null = null;
  let siblingLink: SiblingLink | null = null;
  let jobNode: BridgeNode | null = null;
  const liveDeliveries = new Set<Promise<void>>();

  let steering: { send: (message: string, sibling?: boolean) => Promise<boolean>; rename?: (title: string) => Promise<void> } | null = null;
  if (job && rc.jobs) {
    const jobs = rc.jobs;
    jobNode = rc.jobNode ?? new BridgeNode({
      pipePath: resolvePipePath(rc.home), token: loadOrCreateToken(rc.home), dbPath: resolveDbPath(rc.home),
      agent: "other", jobAgent: job.agent, id: `job:${job.id}`, name: job.name, cwd: workdir,
      jobOwner: job.supervisor ?? job.owner ?? me, jobParent: me, jobTitle: a.title,
      jobSendTo: a.send_to,
      autoWake: false, canHostBroker: false, log: dlog,
    });
    siblingLink = new SiblingLink(jobNode, job, cfg.maxHops, dlog);
    void jobNode.start().catch((err) => dlog.warn("sibling bridge unavailable; retrying", { err: (err as Error).message }));
    const l = new ParentLink(
      me,
      (body, replyTo, kind) => {
        feed.report(`answer to ${me}: ${body.split("\n")[0]!.slice(0, 120)}`, `answer to ${me}: ${body}`);
        return jobs.fromSubagent(job, body, replyTo, kind === "question", kind === "note", kind === "question");
      },
      dlog,
      (percent, note, eta) => {
        job.percent = percent;
        job.progressNote = note;
        if (eta) Object.assign(job, eta);
        jobs.persist?.();
        feed.meta({ percent, progressNote: note, progressAt: Date.now(), ...(eta ?? {}) });
        feed.report(`progress ${percent}%${note ? `: ${note}` : ""}`);
      },
      siblingLink,
      (body) => jobs.escalateApproval ? jobs.escalateApproval(job, body) : Promise.reject(new Error("approval escalation unavailable")),
    );
    try {
      await l.start();
      link = l;
      job.live = {
        post: (m, sibling) => {
          const from = sibling?.from.name ?? me;
          const message = sibling ? formatSiblingMessages([sibling], siblingLink?.maxHops) : m;
          feed.report(`message from ${from}: ${m.split("\n")[0]!.slice(0, MESSAGE_PREVIEW_CHARS)}`, `message from ${from}: ${m}`);
          // Natively where the target supports it (a real user message in the running turn), else at its next hook.
          if (!steering) return void l.post(message, sibling);
          const s = steering;
          const delivery = s.send(message, Boolean(sibling)).then(
            (ok) => { if (!ok) l.post(message, sibling); else if (sibling) siblingLink?.consumed([sibling.id]); },
            () => { l.post(message, sibling); },
          );
          liveDeliveries.add(delivery);
          void delivery.finally(() => liveDeliveries.delete(delivery));
        },
      };
      siblingLink.flush();
    } catch (err) {
      dlog.warn("live link unavailable; messages to this subagent wait until it finishes", { err: (err as Error).message });
    }
  }
  // A linked worktree's git data lives in the main repository: writable, so the subagent can commit.
  const writableRoots = access === "edit" || (a as { sandbox?: string }).sandbox === "workspace-write" ? await gitDirsOutside(workdir, dlog) : undefined;
  if (writableRoots?.length) dlog.info("extra writable folders for the subagent", { workdir, writableRoots });
  if (job) job.retitle = (title) => {
    feed.meta({ title });
    void jobNode?.updateJob({ jobTitle: title }).catch(() => {});
    void steering?.rename?.(title).catch((err) => dlog.warn("could not rename the Codex thread", { err: (err as Error).message }));
  };
  const slotOwner = { id: `${a._job ?? target}-${randomUUID()}`, pid: process.pid };
  let slots: ResourceSlots | null = null;
  let slotTimer: NodeJS.Timeout | undefined;
  let res: DelegateResult;
  try {
    if (Object.keys(cfg.resourceSlots).length) {
      slots = new ResourceSlots(rc.home);
      slotTimer = setInterval(() => {
        try { slots?.renew(slotOwner); }
        catch (err) { dlog.warn("could not renew resource slots", { err: (err as Error).message }); }
      }, SLOT_RENEW_MS);
      slotTimer.unref();
    }
    // Provider hiccups resume the same session; capacity retries back off on the selected model.
    res = await retryTransient(
      {
        // With a live link the subagent can report how far it is (report_progress; shown in the dashboard).
        // A new session learns once that it reports back and leaves the handoff alone.
        prompt: [a.prompt, a.session_id ? null : DELEGATED_JOB_NOTE,
          `(agent-bridge reporting: ${a.notes === "milestones" ? 'Send only milestone notes, using send(message_kind="note").' : a.notes === "blockers" ? 'Send only blockers requiring attention, using send(message_kind="question").' : 'No unsolicited progress notes. Final report only.'} Use report_progress for dashboard progress. Questions requiring a supervisor decision use send(message_kind="question"); replies to a live request and final reports still reach the supervisor.)`,
          linkRoot ? WORKTREE_LINK_HINT : null, link ? PROGRESS_HINT : null, link ? SIBLING_HINT : null, resourceSlotHint(cfg.resourceSlots, bundledCli())].filter(Boolean).join("\n\n"),
        title: (typeof job?.args?.title === "string" && job.args.title) || a.title,
        cwd: workdir,
        sessionId: a.session_id ?? null,
        timeoutSec: a.timeout_sec ?? (background ? MAX_JOB_TIMEOUT_SEC : DEFAULT_DELEGATE_TIMEOUT_SEC),
        maxDelegateDepth: cfg.maxDelegateDepth,
        model: a.model ?? defaultModel,
        effort: a.effort ?? cfg.effort[target] ?? null,
        // What it really runs (a CLI default or an alias resolved), for the dashboard.
        onInfo: (info) => feed.meta({ ...(info.model ? { model: info.model } : {}), ...(info.permission ? { permission: info.permission } : {}), effort: info.effort ?? a.effort ?? cfg.effort[target] ?? defaultEffort(target, info.model ?? null) }),
        log: dlog,
        signal,
        onProgress: feed.report,
        extraEnv: { ...link?.childEnv(), [ENV.home]: rc.home, [ENV.maxDelegateDepth]: String(cfg.maxDelegateDepth),
          // AGENT_BRIDGE_JOB_ID: the stable job name for tools in the job's processes that prove "same job" ownership.
          ...(job ? { [PARENT_JOB_ENV]: job.name, AGENT_BRIDGE_JOB_ID: job.name, [ROOT_SESSION_ENV]: job.rootSession ?? job.supervisor ?? me, [ROOT_NAME_ENV]: job.rootName ?? me } : {}),
          ...(slots ? { [SLOT_OWNER_ENV]: slotOwner.id, [SLOT_PID_ENV]: String(slotOwner.pid) } : {}) },
        writableRoots,
        onSession: (id) => {
          rc.startupReady?.();
          feed.meta({ session: id });
          if (job) rc.jobs?.note(job, { sessionId: id, workdir, worktree: wt });
        },
        approve,
        onDenied: (message) => { link?.post(message); },
        // Someone answers approve's questions: the user ("ask" relay or a dialog) or, for a background
        // subagent, the parent agent. Else targets keep their own behavior (Claude and opencode).
        canApprove: Boolean(wiring) || Boolean(job && (!job.foreground || job.parentJob) && rc.jobs) || Boolean(rc.askUser && rc.userCanAnswer?.()),
        live: job
          ? {
              from: me,
              onSteering: (s) => {
                steering = s;
                const title = job.args?.title;
                if (s && typeof title === "string" && title !== a.title) job.retitle?.(title);
              },
              onAnswer: (answer) => {
                feed.report(`answer to ${me}: ${answer.split("\n")[0]!.slice(0, 120)}`, `answer to ${me}: ${answer}`);
                rc.jobs?.fromSubagent(job, answer, null, true);
              },
            }
          : undefined,
      },
      async (req) => {
        // Context/reader checks precede native admission. Each retry owns its
        // own permit, including callbacks that arrive after an earlier attempt.
        onProgress?.("queued: waiting for machine startup admission");
        const release = await acquireStartup(rc.home, signal);
        try {
          signal.throwIfAborted();
          onProgress?.("starting native CLI");
          return await profile.run(cfg, { ...req, onSession: (id) => { release(); req.onSession?.(id); } }, { ...a, access, relay: wiring });
        } finally { release(); }
      },
    );
    feed.meta({ session: res.sessionId });
    feed.end(signal.aborted ? "cancelled" : res.isError ? "failed" : "done", res.text);
    if (!res.isError && res.text.trim()) link?.reportCompleted();
  } catch (err) {
    if (err instanceof DelegateError && err.sessionId) feed.meta({ session: err.sessionId });
    if (wt) {
      const branch = await git([...trustArgs(wt.path), "branch", "--show-current"], wt.path, dlog).catch(() => wt.branch);
      const branchHead = await git([...trustArgs(wt.path), "rev-parse", "HEAD"], wt.path, dlog).catch(() => undefined);
      feed.meta({ branch: branch || wt.branch, branchHead });
    }
    feed.end(signal.aborted ? "cancelled" : `failed: ${(err as Error)?.message ?? err}`);
    // The worktree keeps whatever the subagent did before failing: say where it is.
    if (wt && err instanceof Error) err.message += `\n\nIts worktree (with any partial work) is ${wt.path} on branch ${wt.branch}.`;
    if (linkRoot && err instanceof Error) {
      try { const warning = worktreeLinkWarning(scanWorktreeLinks(linkRoot)); if (warning) err.message += `\n\n${warning}`; }
      catch (scanError) { err.message += `\nWARNING: worktree link inspection failed: ${(scanError as Error).message}`; }
    }
    throw err;
  } finally {
    if (job) denyPendingApprovals(job);
    clearInterval(slotTimer);
    if (slots) {
      try { slots.release(slotOwner); }
      catch (err) { dlog.warn("could not release resource slots; leases will expire", { err: (err as Error).message }); }
      finally { slots.close(); }
    }
    siblingLink?.close();
    if (jobNode && !rc.jobNode) await jobNode.stop();
    await Promise.allSettled(liveDeliveries);
    await relay?.stop();
    if (job) job.retitle = null;
    if (job && link) {
      job.live = null;
      // Messages it never got to see go out as a follow-up right after this turn.
      job.queue.unshift(...(await link.close()));
    }
  }

  const notes: string[] = [`Step-by-step log: ${feed.logPath}`];
  if (target === "codex") {
    const mappingNote = codexPathReport(codexDriveMappings(`${cwd}\n${a.prompt}`));
    if (mappingNote) notes.push(mappingNote);
  }
  let linkedWorktreeRoot = false;
  if (linkRoot) {
    try {
      const scan = scanWorktreeLinks(linkRoot);
      linkedWorktreeRoot = scan.externalLinks.some((link) => link.path === resolve(linkRoot));
      const warning = worktreeLinkWarning(scan);
      if (warning) notes.push(warning);
    }
    catch (err) { notes.push(`WARNING: worktree link inspection failed: ${(err as Error).message}`); }
  }
  if (access !== "ask" && asked.length) notes.push(`Approval requests forwarded:\n${asked.join("\n")}`);
  if (access === "ask") {
    notes.push(
      forwarding
        ? asked.length
          ? `Permission requests forwarded to the user:\n${asked.join("\n")}`
          : "No permission requests were needed."
        : t("ask.unsupported", { agent: target }),
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
      // Never lose the answer over a git problem.
      notes.push(`Could not commit the changes in worktree ${wt.path} (branch ${wt.branch}): ${(err as Error).message}`);
    }
  } else if (before) {
    const after = await gitChangeSnapshot(workdir, dlog);
    const changed = after ? changedFiles(before, after) : [];
    if (access === "ask" && target === "codex" && forwarding && codexHash) {
      if (relayCalls > 0) recordCodexHookObservation(rc.home, codexHash, "verified");
      else if (changed.length) {
        // Files changed in a read-only sandbox without the hook asking: Codex's reviewer approved.
        recordCodexHookObservation(rc.home, codexHash, "failed");
        log.warn("codex changed files without the permission hook asking; forwarding disabled for this hook version", { changed });
        notes.push(t("ask.hookBypassed", { files: changed.join(", ") }));
      }
    }
    if (access === "edit" || changed.length) notes.push(changed.length ? `Files changed in your working copy:\n${changed.join("\n")}` : "No files changed.");
    const warning = handoffWarning(changed);
    if (warning) notes.push(warning);
  }
  return { ...res, workdir, worktree: wt ?? undefined, text: notes.length ? `${res.text}\n\n---\n${notes.join("\n\n")}` : res.text };
}
