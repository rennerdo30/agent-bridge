import { HOOK_MAX_MESSAGES, HOOK_BUDGET_MS } from "../core/constants.js";
import { siblingMaxHops } from "../core/job-messaging.js";
import { AGENT_KINDS, BROADCAST, isQuietMessage, type BridgeMessage } from "../core/protocol.js";
import { formatMessages, formatParentMessages, formatPeer } from "./format.js";
import { MessageWaitStore, resumeWaitHint } from "./message-wait.js";
import { shouldWakeClaudeMessage, WAKE_HEADER } from "./rewake.js";
import type { ServerContext } from "./server.js";
import { formatDecisionSummary } from "../core/decisions.js";
import { finishHookTurn, reserveHook } from "./hook-ownership.js";

/** Hook events agent-bridge subscribes to in both Claude Code and Codex. */
export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop" | "StopFailure" | "SubagentStart" | "SubagentStop" | "SessionEnd";

export interface HookInput {
  event: HookEvent;
  sessionId: string | null;
  stopHookActive: boolean;
  /** UserPromptSubmit: the prompt text (to recognize agent-bridge's own wake-up turns). */
  prompt?: string | null;
  /** Host token for rejecting hooks from a completed or superseded prompt. */
  promptId?: string | null;
  /** The hook fired inside a native subagent (Claude Code's agent_id), not for the main agent. */
  subagent?: boolean;
  agentId?: string | null;
  /** Session working directory from the hook input, when the host provides it. */
  cwd?: string | null;
  /** Aborted when the host cancels the hook call (e.g. the user interrupts). */
  signal?: AbortSignal;
  /** Metadata work shares the hook deadline. */
  prepare?: (current: () => boolean) => Promise<void>;
}

/** Same JSON shape as command-hook stdout; both hosts parse MCP-tool hook text identically. */
export type HookOutput =
  | Record<string, never>
  | { hookSpecificOutput: { hookEventName: HookEvent; additionalContext: string } }
  | { decision: "block"; reason: string; hookSpecificOutput?: { hookEventName: HookEvent; additionalContext: string } };

const STOP_REASON_FOOTER =
  "Handle these peer messages now: do what is reasonable, answer with the agent-bridge \"send\" tool (reply_to=<id>), then end your turn.";

function context(event: HookEvent, additionalContext: string): HookOutput {
  return { hookSpecificOutput: { hookEventName: event, additionalContext } };
}

export function discardFinishedNotes(ctx: ServerContext): void {
  const node = ctx.node;
  if (!node) return;
  // A completed job's old status chatter is history, never a new instruction.
  const notes = node.unread().filter((m) => !isQuietMessage(m) && ctx.jobs?.isNote(m));
  if (!notes.length) return;
  const jobs = new Map(ctx.jobs?.hookJobs().map((job) => [job.name, job]));
  const obsolete = notes.filter((m) => {
    if (isQuietMessage(m)) return false;
    if (!ctx.jobs?.isNote(m)) return false;
    const job = jobs.get(m.from.name);
    return job !== undefined && !job.projectRoot && !job.deliveryHistory?.length && !job.ownershipHistory?.length && job.status !== "running";
  });
  node.markRead(obsolete.map((m) => m.id));
}

const antigravityStopPending = new WeakMap<ServerContext, Set<string>>();

function holdOrMarkRead(ctx: ServerContext, ids: string[], hold: boolean): void {
  if (!ids.length) return;
  if (hold) {
    let pending = antigravityStopPending.get(ctx);
    if (!pending) { pending = new Set(); antigravityStopPending.set(ctx, pending); }
    for (const id of ids) pending.add(id);
    return;
  }
  ctx.node?.markRead(ids);
}

/** Confirm that an Antigravity Stop continuation started a model step or tool call. */
export function confirmAntigravityStopDelivery(ctx: ServerContext): void {
  const pending = antigravityStopPending.get(ctx);
  if (!pending?.size) return;
  antigravityStopPending.delete(ctx);
  ctx.node?.markRead([...pending]);
}

/** Release unconfirmed Antigravity Stop mail so the next turn or inbox call still sees it unread. */
export function releaseAntigravityStopDelivery(ctx: ServerContext): void {
  antigravityStopPending.delete(ctx);
}

/** Messages eligible to be injected now. `wakeOnly` limits to those allowed to trigger work (below the hop limit). */
function take(ctx: ServerContext, wakeOnly: boolean, notesOnly = false, hold = false): BridgeMessage[] {
  const node = ctx.node!;
  discardFinishedNotes(ctx);
  const msgs = node
    .unread()
    // Observer copies and acknowledgements remain available in inbox/history on demand.
    // Filter before the batch limit so old chatter cannot delay current results or blockers.
    .filter((m) => !isQuietMessage(m))
    .filter((m) => !notesOnly || ctx.jobs?.isNote(m) || !shouldWakeClaudeMessage(node, ctx.cfg, m))
    // Ending a turn: a running subagent's status note does not keep it going; it comes with the next prompt.
    .filter((m) => !wakeOnly || (m.hop < ctx.cfg.maxHops && !ctx.jobs?.isNote(m)))
    .slice(0, HOOK_MAX_MESSAGES);
  holdOrMarkRead(ctx, msgs.map((m) => m.id), hold);
  return msgs;
}

/** A delegated subagent: its parent's messages arrive over the parent link, not the bridge. */
const parentReads = new WeakMap<ServerContext, Promise<Awaited<ReturnType<NonNullable<ServerContext["parent"]>["inbox"]>>>>();
const nativeDeliveries = new WeakMap<ServerContext, Map<string, string[]>>();

/** A later child boundary confirms the preceding hook context survived cancellation. */
export async function confirmNativeChildDelivery(ctx: ServerContext, agentId: string): Promise<void> {
  const deliveries = nativeDeliveries.get(ctx), ids = deliveries?.get(agentId);
  if (!ids?.length || !ctx.node) return;
  await ctx.node.nativeChildAck(agentId, ids);
  if (deliveries?.get(agentId) === ids) deliveries.delete(agentId);
}

async function subagentHook(ctx: ServerContext, input: HookInput): Promise<HookOutput> {
  if (input.subagent && ctx.agent === "claude" && ctx.node && input.agentId) {
    const node = ctx.node;
    // Native children never prepare/observe metadata or acquire main hook ownership.
    if (node.wasReplaced || !input.sessionId || input.sessionId !== node.currentSessionId || input.event === "StopFailure") return {};
    if (input.event === "SubagentStop") {
      await withinHook(node.nativeChild({ agentId: input.agentId, action: "end" }), input.signal!);
      nativeDeliveries.get(ctx)?.delete(input.agentId);
      return {};
    }
    const child = await withinHook(node.nativeChild({ agentId: input.agentId, action: "start", maxHops: Math.min(32, siblingMaxHops(ctx.cfg.maxHops)) }), input.signal!);
    if (!child || input.signal?.aborted) return {};
    await withinHook(confirmNativeChildDelivery(ctx, input.agentId), input.signal!);
    const identity = `[agent-bridge] Your scoped native child address is "${child.address}". Use native_child="${child.agentId}" on peers, inbox and send. Your parent is ${child.parent}; bridge jobs owned by it and exact send_to grants may reach you. Never act as the parent session.`;
    const messages = (await withinHook(node.nativeChildPending(input.agentId), input.signal!)).filter(m => !isQuietMessage(m) && (input.event !== "Stop" || m.hop < child.maxHops));
    // Hand-out is not a receipt. A cancelled/deadline hook must leave mail returnable
    // at SubagentStop or parent end; the next child hook/tool confirms this hand-out.
    if (messages.length) {
      let deliveries = nativeDeliveries.get(ctx);
      if (!deliveries) { deliveries = new Map(); nativeDeliveries.set(ctx, deliveries); }
      deliveries.set(input.agentId, messages.map(m => m.id));
    }
    const delivery = [identity, messages.length ? formatMessages(messages) : ""].filter(Boolean).join("\n\n");
    if (input.event === "Stop") return messages.length ? { decision: "block", reason: delivery } : {};
    if (input.event === "PostToolUse" && messages.length) return { decision: "block", reason: delivery, hookSpecificOutput: { hookEventName: input.event, additionalContext: delivery } };
    return context(input.event, delivery);
  }
  const parent = ctx.parent;
  if (!parent || input.event === "SessionStart" || input.event === "StopFailure") return {};
  let pending = parentReads.get(ctx);
  if (!pending) { pending = parent.inbox().catch((err) => {
    ctx.log.debug("parent inbox unavailable", { err: (err as Error).message });
    return [];
  }); parentReads.set(ctx, pending); }
  const hasChildren = Boolean(ctx.childInbox?.unread().length);
  const msgs = hasChildren ? [] : await withinHook(pending, input.signal!);
  if (!hasChildren) parentReads.delete(ctx);
  const children = ctx.childInbox?.take() ?? [];
  if (msgs.length === 0 && children.length === 0) {
    return {};
  }
  ctx.log.info("delivering parent messages to the subagent", { count: msgs.length, event: input.event });
  const text = [msgs.length ? formatParentMessages(parent.name, msgs) : "", children.length ? formatMessages(children) : ""].filter(Boolean).join("\n\n");
  // Before it ends its turn: keep it going so it answers (and adjusts) instead of finishing without seeing them.
  if (input.event === "Stop") return { decision: "block", reason: text };
  // After a tool call, "block" feeds the reason back to the model as feedback on that call (the call itself
  // already ran), which the hosts surface far more reliably than additional context alone.
  if (input.event === "PostToolUse") return { decision: "block", reason: text, hookSpecificOutput: { hookEventName: input.event, additionalContext: text } };
  return context(input.event, text);
}

/** Deadline rejection stops the continuation before consuming any mail. */
function withinHook<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("hook deadline")); };
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { signal.removeEventListener("abort", abort); if (signal.aborted) abort(); else resolve(value); }, err => { signal.removeEventListener("abort", abort); reject(err); });
    if (signal.aborted) abort();
  });
}
export async function buildHookResponse(ctx: ServerContext, input: HookInput): Promise<HookOutput> {
  // An authoritative native-child flag must be checked before prepare can observe its metadata.
  // Hosts without that flag still need a separate lineage solution; thread ids alone are not proof.
  if (input.signal?.aborted || input.subagent && (ctx.agent !== "claude" || !ctx.node || !input.agentId)) return {};
  const node = ctx.node;
  const main = !input.subagent && input.event !== "SessionEnd" && (ctx.agent === "codex" || ctx.agent === "claude") && node !== null && !ctx.headless;
  const current = main ? reserveHook(ctx, input) : () => true;
  if (!current) return {};
  const owningSession = input.sessionId ?? node?.currentSessionId;
  // A running main turn must block wake admission even if its metadata never completes.
  const busyAtIngress = main && !input.signal?.aborted && (input.event === "UserPromptSubmit" || input.event === "PostToolUse");
  if (busyAtIngress) ctx.activity?.("busy");
  const controller = new AbortController();
  let deadlineExpired = false;
  const timer = setTimeout(() => { deadlineExpired = true; controller.abort(); }, HOOK_BUDGET_MS);
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) abort();
  try {
    if (input.subagent) return await subagentHook(ctx, { ...input, signal: controller.signal });
    if (input.event === "SessionEnd") {
      if (ctx.agent === "claude" && node && !node.wasReplaced && node.currentSessionId === input.sessionId) await withinHook(node.nativeChildrenEnd(), controller.signal);
      return {};
    }
    return await runHook(ctx, { ...input, signal: controller.signal }, current, busyAtIngress);
  }
  catch (err) {
    if (!controller.signal.aborted) throw err;
    // The host accepts {} as turn end. Only the owning main Stop's own deadline can
    // recover idle; cancellation, a newer hook, or a replaced session must retain activity.
    if (deadlineExpired && main && (input.event === "Stop" || input.event === "StopFailure") && current() && node?.currentSessionId === owningSession) finishHookTurn(ctx, input);
    ctx.log.debug("hook deferred slow work", { event: input.event });
    return {};
  }
  finally { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); }
}
async function runHook(ctx: ServerContext, input: HookInput, current: () => boolean, busyAtIngress: boolean): Promise<HookOutput> {
  if (input.prepare) await withinHook(input.prepare(() => current() && !input.signal?.aborted), input.signal!);
  if (!current()) return {};
  const node = ctx.node;
  if (!node) return subagentHook(ctx, input);
  // A headless `claude -p` run is not a session: its hooks must not join the bridge or take mail.
  await withinHook(ctx.launchKnown ?? Promise.resolve(), input.signal!);
  if (ctx.headless || !current()) return {};
  ctx.log.debug("hook event", { event: input.event, sessionId: input.sessionId, stopHookActive: input.stopHookActive });
  if (input.sessionId) {
    await withinHook(node.setSessionId(input.sessionId).catch(() => {}), input.signal!);
    if (!current()) return {};
    ctx.onSessionId?.(input.sessionId);
  }
  // The MCP server may have been started outside the project (e.g. in the plugin folder).
  if (input.cwd && ctx.learnCwd) await withinHook(ctx.learnCwd(input.cwd), input.signal!);
  if (!current()) return {};
  // Joining may have been deferred until the project dir was known.
  await withinHook(node.ensureConnected().catch((err) => ctx.log.warn("bridge not reachable from hook", { err: (err as Error).message })), input.signal!);
  if (!current()) return {};
  // The host discards StopFailure output. Never read/confirm mail that it cannot deliver.
  if (input.event === "StopFailure") { releaseAntigravityStopDelivery(ctx); finishHookTurn(ctx, input); return {}; }
  if (ctx.agent === "antigravity") {
    if (input.event === "PostToolUse" || (input.event === "UserPromptSubmit" && input.stopHookActive) || (input.event === "Stop" && input.stopHookActive)) confirmAntigravityStopDelivery(ctx);
    else releaseAntigravityStopDelivery(ctx);
  }
  const stopJobsRunning = input.event === "Stop" ? ctx.jobs?.runningCount() ?? 0 : 0;
  const replay = node.refreshPending().catch((err) => ctx.log.warn("pending mail refresh failed; retained for retry", { err: String(err) }));
  // Stop can deliver buffered mail or arm a child-result notification immediately. A slow
  // broker replay must not hide that mail behind the hook deadline; later arrivals still
  // use the existing delivery path, and ordinary hooks continue to await their refill.
  const stopReady = input.event === "Stop" && (stopJobsRunning > 0 || node.unread().some((m) => !isQuietMessage(m)));
  if (!stopReady) await withinHook(replay, input.signal!);
  // No stale main hook may confirm wake delivery, consume newer-turn mail or report activity.
  if (!current()) return {};
  // A wake-up's messages reached the session if a turn is running (tool calls, turn end); if a prompt or a new
  // session comes first, the wake-up was lost and they are shown again below.
  // The wake-up's own turn starts with a prompt carrying its text: that is delivery, not a new user prompt.
  const wakeTurn = input.event === "UserPromptSubmit" && Boolean(input.prompt?.includes(WAKE_HEADER));
  if (input.event === "PostToolUse" || input.event === "Stop" || wakeTurn) ctx.wakeDelivery?.confirm();
  else ctx.wakeDelivery?.release();
  if (input.event === "PostToolUse" || input.event === "UserPromptSubmit") ctx.wakeDelivery?.active();
  // With a live channel, Claude Code receives messages by push; hooks would only duplicate them.
  const channel = ctx.channelActive();
  const holdStop = ctx.agent === "antigravity";

  switch (input.event) {
    case "SessionStart": {
      ctx.activity?.("idle");
      const peers = node.isConnected ? (await withinHook(node.peers().catch(() => []), input.signal!)).filter((p) => p.id !== node.id) : [];
      if (!current()) return {};
      const lines = [
        `[agent-bridge] You are connected to agent-bridge as "${node.name}".`,
        peers.length ? `Peers online:\n${peers.map((p) => formatPeer(p)).join("\n")}` : "No other agents are online right now.",
      ];
      lines.push(...new MessageWaitStore(ctx.home).pending(node).map(resumeWaitHint));
      const unread = node.unread().filter((m) => !isQuietMessage(m)).length;
      const decisions = await withinHook(node.decisions({ scope: { project: ctx.cwd() } }).catch(() => []), input.signal!);
      if (!current()) return {};
      const summary = formatDecisionSummary(decisions);
      if (summary) lines.push(summary);
      if (unread > 0 && !channel) lines.push(`You have ${unread} unread peer message(s); call the "inbox" tool to read them.`);
      return context("SessionStart", lines.join("\n"));
    }
    case "UserPromptSubmit":
    case "PostToolUse": {
      if (!busyAtIngress) ctx.activity?.("busy");
      // Muted session messages use active hooks; observer copies stay on demand.
      const msgs = take(ctx, false, channel);
      return msgs.length ? context(input.event, formatMessages(msgs)) : {};
    }
    case "Stop": {
      if (channel) {
        finishHookTurn(ctx, input);
        return {};
      }
      ctx.wakeDelivery?.idle?.();
      // The agent-bridge mod wakes the session with a real turn: the turn ends, waiting messages go to the mod.
      if (ctx.wakeDelivery?.modActive?.()) {
        finishHookTurn(ctx, input);
        return {};
      }
      // Listen window: this session is in a conversation if it sent something recently or has subagents running.
      const now = Date.now();
      const lingerRemaining = node.lastSentAt > 0 ? node.lastSentAt + ctx.cfg.lingerSec * 1000 - now : 0;
      const jobsRunning = stopJobsRunning;
      const inConversation = lingerRemaining > 0 || jobsRunning > 0;
      if (!node.autoWakeEnabled && !inConversation) {
        // A notify wait is explicit permission to deliver its match, even after the listen window ends.
        // Finishing the last job ends runningCount before Stop. Its result still owns delivery.
        const awaited = node.unread().filter((m) => (node.isNotificationAwaited(m) ||
          (m.from.id.startsWith("job:") && shouldWakeClaudeMessage(node, ctx.cfg, m)) ||
          ((ctx.agent === "opencode" || ctx.agent === "antigravity") && m.to !== BROADCAST && !(AGENT_KINDS as readonly string[]).includes(m.to) &&
            shouldWakeClaudeMessage(node, ctx.cfg, m))) && m.hop < ctx.cfg.maxHops &&
          !isQuietMessage(m) && !m.conversationId.endsWith(":note")).slice(0, HOOK_MAX_MESSAGES);
        if (awaited.length) {
          holdOrMarkRead(ctx, awaited.map((m) => m.id), holdStop);
          ctx.activity?.("busy");
          return { decision: "block", reason: formatMessages(awaited, { replyHint: false }) };
        }
        finishHookTurn(ctx, input);
        return {};
      }
      const msgs = take(ctx, true, false, holdStop);
      // Stop never long-polls. Notify-mode subscriptions and the existing wake path deliver later.
      if (!msgs.length && jobsRunning > 0) {
        const waits = new MessageWaitStore(ctx.home);
        waits.save(node, {}, "notify");
        waits.attach(node);
      }
      if (msgs.length === 0) {
        finishHookTurn(ctx, input);
        return {};
      }
      ctx.activity?.("busy");
      ctx.log.info("continuing turn for peer messages", { count: msgs.length, autoWake: node.autoWakeEnabled });
      return { decision: "block", reason: `${formatMessages(msgs, { replyHint: false })}\n\n${STOP_REASON_FOOTER}` };
    }
    default:
      return {};
  }
}
