import { HOOK_MAX_MESSAGES, STOP_WAIT_CAP_MS } from "../core/constants.js";
import type { BridgeMessage } from "../core/protocol.js";
import { formatMessages, formatParentMessages, formatPeer } from "./format.js";
import { WAKE_HEADER } from "./rewake.js";
import type { ServerContext } from "./server.js";

/** Hook events agent-bridge subscribes to in both Claude Code and Codex. */
export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop";

export interface HookInput {
  event: HookEvent;
  sessionId: string | null;
  stopHookActive: boolean;
  /** UserPromptSubmit: the prompt text (to recognize agent-bridge's own wake-up turns). */
  prompt?: string | null;
  /** The hook fired inside a native subagent (Claude Code's agent_id), not for the main agent. */
  subagent?: boolean;
  /** Session working directory from the hook input, when the host provides it. */
  cwd?: string | null;
  /** Aborted when the host cancels the hook call (e.g. the user interrupts). */
  signal?: AbortSignal;
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

/** Messages eligible to be injected now. `wakeOnly` limits to those allowed to trigger work (below the hop limit). */
function take(ctx: ServerContext, wakeOnly: boolean): BridgeMessage[] {
  const node = ctx.node!;
  const msgs = node
    .unread()
    .filter((m) => !wakeOnly || m.hop < ctx.cfg.maxHops)
    .slice(0, HOOK_MAX_MESSAGES);
  node.markRead(msgs.map((m) => m.id));
  return msgs;
}

/** A delegated subagent: its parent's messages arrive over the parent link, not the bridge. */
async function subagentHook(ctx: ServerContext, input: HookInput): Promise<HookOutput> {
  const parent = ctx.parent;
  if (!parent || input.event === "SessionStart") return {};
  const msgs = await parent.inbox().catch((err) => {
    ctx.log.debug("parent inbox unavailable", { err: (err as Error).message });
    return [];
  });
  if (msgs.length === 0) return {};
  ctx.log.info("delivering parent messages to the subagent", { count: msgs.length, event: input.event });
  const text = formatParentMessages(parent.name, msgs);
  // Before it ends its turn: keep it going so it answers (and adjusts) instead of finishing without seeing them.
  if (input.event === "Stop") return { decision: "block", reason: text };
  // After a tool call, "block" feeds the reason back to the model as feedback on that call (the call itself
  // already ran), which the hosts surface far more reliably than additional context alone.
  if (input.event === "PostToolUse") return { decision: "block", reason: text, hookSpecificOutput: { hookEventName: input.event, additionalContext: text } };
  return context(input.event, text);
}

export async function buildHookResponse(ctx: ServerContext, input: HookInput): Promise<HookOutput> {
  const node = ctx.node;
  if (!node) return subagentHook(ctx, input);
  // A headless `claude -p` run is not a session: its hooks must not join the bridge or take mail.
  await ctx.launchKnown;
  if (ctx.headless) return {};
  ctx.log.debug("hook event", { event: input.event, sessionId: input.sessionId, stopHookActive: input.stopHookActive });
  if (input.sessionId) {
    await node.setSessionId(input.sessionId).catch(() => {});
    ctx.onSessionId?.(input.sessionId);
  }
  // The MCP server may have been started outside the project (e.g. in the plugin folder).
  if (input.cwd) await ctx.learnCwd?.(input.cwd);
  // Joining may have been deferred until the project dir was known.
  await node.ensureConnected().catch((err) => ctx.log.warn("bridge not reachable from hook", { err: (err as Error).message }));
  // A native subagent's tool calls fire the same hooks: messages are for the main agent, so leave them.
  if (input.subagent) return {};
  // A wake-up's messages reached the session if a turn is running (tool calls, turn end); if a prompt or a new
  // session comes first, the wake-up was lost and they are shown again below.
  // The wake-up's own turn starts with a prompt carrying its text: that is delivery, not a new user prompt.
  const wakeTurn = input.event === "UserPromptSubmit" && Boolean(input.prompt?.includes(WAKE_HEADER));
  if (input.event === "PostToolUse" || input.event === "Stop" || wakeTurn) ctx.wakeDelivery?.confirm();
  else ctx.wakeDelivery?.release();
  if (input.event === "PostToolUse" || input.event === "UserPromptSubmit") ctx.wakeDelivery?.active();  // With a live channel, Claude Code receives messages by push; hooks would only duplicate them.
  const channel = ctx.channelActive();

  switch (input.event) {
    case "SessionStart": {
      ctx.activity?.("idle");
      const peers = node.isConnected ? (await node.peers().catch(() => [])).filter((p) => p.id !== node.id) : [];
      const lines = [
        `[agent-bridge] You are connected to agent-bridge as "${node.name}".`,
        peers.length ? `Peers online:\n${peers.map((p) => formatPeer(p)).join("\n")}` : "No other agents are online right now.",
      ];
      const unread = node.unread().length;
      if (unread > 0 && !channel) lines.push(`You have ${unread} unread peer message(s); call the "inbox" tool to read them.`);
      return context("SessionStart", lines.join("\n"));
    }
    case "UserPromptSubmit":
    case "PostToolUse": {
      ctx.activity?.("busy");
      if (channel) return {};
      const msgs = take(ctx, false);
      return msgs.length ? context(input.event, formatMessages(msgs)) : {};
    }
    case "Stop": {
      if (channel) {
        ctx.activity?.("idle");
        return {};
      }
      // Listen window: this session is in a conversation if it sent something recently or has subagents running.
      const now = Date.now();
      const lingerRemaining = node.lastSentAt > 0 ? node.lastSentAt + ctx.cfg.lingerSec * 1000 - now : 0;
      const jobsRunning = ctx.jobs?.runningCount() ?? 0;
      const inConversation = lingerRemaining > 0 || jobsRunning > 0;
      if (!node.autoWakeEnabled && !inConversation) {
        ctx.activity?.("idle");
        return {};
      }
      let msgs = take(ctx, true);
      // With background wake-ups (Claude Code's asyncRewake hook) the turn never waits: it ends now and
      // the session is woken when a result or reply arrives. Hosts without that keep the listen window.
      if (msgs.length === 0 && inConversation && !ctx.rewakeAvailable) {
        const waitMs = Math.min(STOP_WAIT_CAP_MS, jobsRunning > 0 ? STOP_WAIT_CAP_MS : lingerRemaining);
        ctx.log.info("listening for replies before ending the turn", { waitMs, jobsRunning });
        const arrived = await node.waitForMessage(waitMs, (m) => m.hop < ctx.cfg.maxHops, input.signal);
        if (arrived) msgs = take(ctx, true);
      }
      if (msgs.length === 0) {
        ctx.activity?.("idle");
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
