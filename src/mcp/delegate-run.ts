import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BridgeConfig } from "../core/config.js";
import { DEFAULT_DELEGATE_TIMEOUT_SEC, MAX_JOB_TIMEOUT_SEC } from "../core/constants.js";
import { DelegateError, retryTransient, type DelegateResult } from "../core/delegate.js";
import { defaultEffort } from "../core/effort.js";
import { t } from "../core/i18n.js";
import type { Logger } from "../core/logger.js";
import { ParentLink } from "../core/parent-link.js";
import type { AgentKind, CodingAgent } from "../core/protocol.js";
import { PermissionRelay, type PermissionDecision, type PermissionRequest } from "../core/relay.js";
import { codexPermissionHookHash, codexPermissionHookTrusted, recordCodexHookObservation } from "../core/codex-trust.js";
import { startRunFeed } from "../core/runfeed.js";
import { isAutoApproved, isHandoffToolCall, isOwnServerCall, mcpToolOf, shortServer } from "../core/tool-allow.js";
import { changedFiles, createWorktree, finishWorktree, gitChangeSnapshot, gitDirsOutside, handoffWarning, subagentCommitMessage, worktreeReport, type Worktree } from "../core/worktree.js";
import { formatUsage } from "./format.js";
import type { Job, RunResult } from "./jobs.js";
import { DELEGATION_TARGETS, supportsAsk, type Access, type RelayWiring, type TargetArgs } from "./targets.js";

/** Added to a subagent's task when it can report progress. */
const PROGRESS_HINT =
  "(agent-bridge: while you work, call the report_progress tool of the agent-bridge MCP server with the percent of the whole task done and a few words on the current step: when you start, after each milestone, and at least every few minutes.)";
/** Added to a new subagent's task: the session that started it owns the project handoff. */
export const DELEGATED_JOB_NOTE =
  "(agent-bridge: you are a delegated job. Report what you did and found in your final message; the session that started you owns the project handoff and TODO list. Do not write or commit handoff or TODO files (such as HANDOFF.md or TODO.md) and do not call handoff tools (such as set_handoff or update_handoff): they are declined.)";
/** Why a subagent's handoff tool call was declined; shown to the subagent where its CLI passes it on. */
const HANDOFF_DECLINED =
  "Declined by agent-bridge: delegated jobs do not write the project handoff. Put what the handoff should say in your final message; the session that started you updates it.";
/** How long a background subagent waits for its parent agent to approve something before it counts as "deny". */
export const PARENT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** _worktree: internal, a follow-up continuing in an existing worktree. _job: the job's name. */
export type DelegateArgs = { prompt: string; model?: string; effort?: string; session_id?: string; cwd?: string; timeout_sec?: number; worktree?: boolean; allow_tools?: string[]; title: string; _worktree?: Worktree; _job?: string } & TargetArgs;

/** Where a background job's approval questions, answers and facts go: this session's JobManager, or a job runner's link to it. */
export interface JobSink {
  askParent(job: Job, question: string, timeoutMs: number): Promise<{ allow: boolean; reason: string }>;
  /** isAnswer: its answer to a live message (wakes the session); else a note unless it replies to something. */
  fromSubagent(job: Job, body: string, replyTo: string | null, isAnswer?: boolean): void;
  note(job: Job, facts: { sessionId?: string | null; workdir?: string | null; worktree?: Worktree | null }): void;
}

/** What a delegated run needs from the process that runs it (the session's MCP server or a job runner). */
export interface RunContext {
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
}

/** A folder inside ~/.agent-bridge/worktrees (a subagent worktree, possibly from an earlier job). */
export function isBridgeWorktree(dir: string, home: string): boolean {
  return isInside(dir, join(home, "worktrees")) && resolve(dir) !== resolve(join(home, "worktrees"));
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The arguments of a follow-up turn: same agent, model and access, in the folder (or worktree) the job used. */
export function resumeArgs(a: DelegateArgs, job: string, message: string, sessionId: string, workdir: string | null, worktree: Worktree | null): DelegateArgs {
  return { ...a, _job: job, prompt: message, session_id: sessionId, cwd: workdir ?? a.cwd, worktree: false, _worktree: worktree ?? undefined, access: a.worktree ? (a.access ?? "edit") : a.access };
}

/** Run the delegate; returns its result plus a report of what it changed. */
export async function runDelegate(
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
  const access: Access | undefined = a.worktree || a._worktree || isBridgeWorktree(cwd, rc.home) ? (a.access ?? "edit") : a.access;
  // A follow-up to a worktree job keeps working (and committing) in that worktree.
  const wt = a._worktree ?? (a.worktree ? await createWorktree({ cwd, home: rc.home, jobId: randomUUID().slice(0, 8), log: dlog }) : null);
  const workdir = wt?.cwd ?? cwd;
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
  try {
    if (access === "ask" && rc.askUser) {
      const askUser = rc.askUser;
      const decide = async (r: PermissionRequest) => {
        relayCalls++;
        const d = await askUser(r);
        asked.push(`${d.allow ? "allowed" : "denied"}: ${r.tool} ${r.detail.slice(0, 80)}`);
        return d;
      };
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
  const autoApprove = [...cfg.autoApproveTools, ...(a.allow_tools ?? [])];
  const approve = async (r: PermissionRequest): Promise<PermissionDecision> => {
    // Handoff tools first: no allow pattern or earlier "allow" for their server covers them.
    if (isHandoffToolCall(r)) {
      asked.push(`declined (handoff tool): ${r.tool} ${r.detail.slice(0, 80)}`);
      // Codex's decline carries no reason: tell the running subagent directly.
      if (target === "codex") job?.live?.post(HANDOFF_DECLINED);
      return { allow: false, message: HANDOFF_DECLINED };
    }
    if (r.tool.startsWith("mcp:") && allowedServers.has(r.tool)) return { allow: true };
    // Its own agent-bridge tools (answering the parent, report_progress) never need a question.
    if (isOwnServerCall(r) || isAutoApproved(r, autoApprove)) return { allow: true };
    let d: PermissionDecision;
    if (wiring) d = await wiring.onPermission(r);
    else if (job && !job.foreground && rc.jobs) {
      // A background subagent asks the agent that started it (it can decide, also in auto mode or with
      // the user away). A blocking ask_* caller cannot answer while it waits, so that one asks the user.
      // Name the allow_tools pattern that would cover this call, so the next spawn need not ask.
      const call = mcpToolOf(r);
      const hint = call?.tool ? ` (not covered by this job's allow_tools; "${shortServer(call.server)}.${call.tool}" or "${shortServer(call.server)}" would allow it without asking)` : "";
      const a = await rc.jobs.askParent(job, `${r.tool.replace(/^mcp:/, "MCP server ")}: ${r.detail}${hint}`, PARENT_APPROVAL_TIMEOUT_MS);
      d = a.allow ? { allow: true } : { allow: false, message: `Denied by ${me}: ${a.reason}` };
      asked.push(`${d.allow ? "allowed" : "denied"} by ${me}: ${r.tool} ${r.detail.slice(0, 80)}`);
    } else if (rc.askUser) {
      relayCalls++;
      d = await rc.askUser(r);
      asked.push(`${d.allow ? "allowed" : "denied"}: ${r.tool} ${r.detail.slice(0, 80)}`);
    } else d = r.tool.startsWith("mcp:") && access === "edit" ? { allow: true } : { allow: false, message: "No one to ask in this session." };
    if (d.allow && r.tool.startsWith("mcp:")) allowedServers.add(r.tool);
    return d;
  };
  let feed: ReturnType<typeof startRunFeed>;
  try {
    feed = startRunFeed({
      home: rc.home,
      name: `${target}-${randomUUID().slice(0, 8)}`,
      header: `${target}${a.model ? ` (${a.model}${a.effort ? `, effort ${a.effort}` : ""})` : a.effort ? ` (effort ${a.effort})` : ""} in ${workdir}, access ${access ?? "default"}, by ${me}${a.session_id ? `, continues ${a.session_id}` : ""}\n${a.prompt}\n---`,
      forward: onProgress,
      meta: {
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
        continues: a.session_id ?? null,
      },
    });
  } catch (err) {
    await relay?.stop();
    throw err;
  }
  // Live link: this session's messages reach the subagent while it works, and it can answer at once.
  let link: ParentLink | null = null;

  let steering: { send: (message: string) => Promise<boolean> } | null = null;
  if (job && rc.jobs) {
    const jobs = rc.jobs;
    const l = new ParentLink(
      me,
      (body, replyTo) => {
        feed.report(`answer to ${me}: ${body.split("\n")[0]!.slice(0, 120)}`, `answer to ${me}: ${body}`);
        jobs.fromSubagent(job, body, replyTo);
      },
      dlog,
      (percent, note) => {
        job.percent = percent;
        job.progressNote = note;
        feed.meta({ percent, progressNote: note, progressAt: Date.now() });
        feed.report(`progress ${percent}%${note ? `: ${note}` : ""}`);
      },
    );
    try {
      await l.start();
      link = l;
      job.live = {
        post: (m) => {
          feed.report(`message from ${me}: ${m.split("\n")[0]!.slice(0, 120)}`, `message from ${me}: ${m}`);
          // Natively where the target supports it (a real user message in the running turn), else at its next hook.
          if (!steering) return void l.post(m);
          const s = steering;
          void s.send(m).then((ok) => {
            if (!ok) l.post(m);
          });
        },
      };
    } catch (err) {
      dlog.warn("live link unavailable; messages to this subagent wait until it finishes", { err: (err as Error).message });
    }
  }
  // A linked worktree's git data lives in the main repository: writable, so the subagent can commit.
  const writableRoots = access === "edit" || (a as { sandbox?: string }).sandbox === "workspace-write" ? await gitDirsOutside(workdir, dlog) : undefined;
  if (writableRoots?.length) dlog.info("extra writable folders for the subagent", { workdir, writableRoots });
  if (job) job.retitle = (title) => feed.meta({ title });
  let res: DelegateResult;
  try {
    // A temporary provider error (an invalid upstream response, say) gets one automatic resume first.
    res = await retryTransient(
      {
        // With a live link the subagent can report how far it is (report_progress; shown in the dashboard).
        // A new session learns once that it reports back and leaves the handoff alone.
        prompt: [a.prompt, a.session_id ? null : DELEGATED_JOB_NOTE, link ? PROGRESS_HINT : null].filter(Boolean).join("\n\n"),
        cwd: workdir,
        sessionId: a.session_id ?? null,
        timeoutSec: a.timeout_sec ?? (background ? MAX_JOB_TIMEOUT_SEC : DEFAULT_DELEGATE_TIMEOUT_SEC),
        model: a.model ?? defaultModel,
        effort: a.effort ?? cfg.effort[target] ?? null,
        // What it really runs (a CLI default or an alias resolved), for the dashboard.
        onInfo: (info) => feed.meta({ ...(info.model ? { model: info.model } : {}), ...(info.permission ? { permission: info.permission } : {}), effort: info.effort ?? a.effort ?? cfg.effort[target] ?? defaultEffort(target, info.model ?? null) }),
        log: dlog,
        signal,
        onProgress: feed.report,
        extraEnv: link?.childEnv(),
        writableRoots,
        onSession: (id) => {
          feed.meta({ session: id });
          if (job) rc.jobs?.note(job, { sessionId: id, workdir, worktree: wt });
        },
        approve,
        // Someone answers approve's questions: the user ("ask" relay or a dialog) or, for a background
        // subagent, the parent agent. Else targets keep their own behavior (Claude and opencode).
        canApprove: Boolean(wiring) || Boolean(job && !job.foreground && rc.jobs) || Boolean(rc.askUser && rc.userCanAnswer?.()),
        live: job
          ? {
              from: me,
              onSteering: (s) => void (steering = s),
              onAnswer: (answer) => {
                feed.report(`answer to ${me}: ${answer.split("\n")[0]!.slice(0, 120)}`, `answer to ${me}: ${answer}`);
                rc.jobs?.fromSubagent(job, answer, null, true);
              },
            }
          : undefined,
      },
      (req) => profile.run(cfg, req, { ...a, access, relay: wiring }),
    );
    feed.meta({ session: res.sessionId });
    feed.end(res.isError ? "failed" : "done", res.text);
  } catch (err) {
    if (err instanceof DelegateError && err.sessionId) feed.meta({ session: err.sessionId });
    feed.end(`failed: ${(err as Error)?.message ?? err}`);
    // The worktree keeps whatever the subagent did before failing: say where it is.
    if (wt && err instanceof Error) err.message += `\n\nIts worktree (with any partial work) is ${wt.path} on branch ${wt.branch}.`;
    throw err;
  } finally {
    await relay?.stop();
    if (job) job.retitle = null;
    if (job && link) {
      job.live = null;
      // Messages it never got to see go out as a follow-up right after this turn.
      job.queue.unshift(...(await link.close()));
    }
  }

  const notes: string[] = [`Step-by-step log: ${feed.logPath}`];
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
  if (wt) {
    try {
      const message = subagentCommitMessage({ answer: res.text, task: a.prompt, job: a._job, agent: target, model: a.model ?? defaultModel });
      notes.push(worktreeReport(wt, await finishWorktree(wt, message, dlog)));
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
