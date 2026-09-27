import { HOOK_MAX_MESSAGES, STOP_WAIT_CAP_MS } from "../core/constants.js";
import type { BridgeMessage } from "../core/protocol.js";
import { formatMessages, formatPeer } from "./format.js";
import type { ServerContext } from "./server.js";

/** Hook events agent-bridge subscribes to in both Claude Code and Codex. */
export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop";

export interface HookInput {
  event: HookEvent;
  sessionId: string | null;
  stopHookActive: boolean;
  /** Session working directory from the hook input, when the host provides it. */
  cwd?: string | null;
  /** Aborted when the host cancels the hook call (e.g. the user interrupts). */
  signal?: AbortSignal;
}

/** Same JSON shape as command-hook stdout; both hosts parse MCP-tool hook text identically. */
export type HookOutput =
  | Record<string, never>
  | { hookSpecificOutput: { hookEventName: HookEvent; additionalContext: string } }
  | { decision: "block"; reason: string };

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

export async function buildHookResponse(ctx: ServerContext, input: HookInput): Promise<HookOutput> {
  const node = ctx.node;
  if (!node) return {};
  ctx.log.debug("hook event", { event: input.event, sessionId: input.sessionId, stopHookActive: input.stopHookActive });
  if (input.sessionId) await node.setSessionId(input.sessionId).catch(() => {});
  // The MCP server may have been started outside the project (e.g. in the plugin folder).
  if (input.cwd) await ctx.learnCwd?.(input.cwd);
  // Joining may have been deferred until the project dir was known.
  await node.ensureConnected().catch((err) => ctx.log.warn("bridge not reachable from hook", { err: (err as Error).message }));
  // With a live channel, Claude Code receives messages by push; hooks would only duplicate them.
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
      if (msgs.length === 0 && inConversation) {
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
