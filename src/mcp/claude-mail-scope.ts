import { randomBytes } from "node:crypto";
import { NATIVE_AGENT_ID } from "../core/native-children.js";
import { BridgeError } from "../core/protocol.js";

export const CLAUDE_MAIL_TOOLS = ["inbox", "wait_for_message", "get_conversation", "search_history"] as const;
export const isClaudeMailTool = (name: string): boolean => (CLAUDE_MAIL_TOOLS as readonly string[]).includes(name);
/** Every model-facing tool on a shared Claude connection. Lifecycle hook_event is
 * internal: the host mod refuses model tool.call events for it, leaving native hooks intact. */
export const CLAUDE_SCOPED_TOOLS = [
  ...CLAUDE_MAIL_TOOLS, "health", "ask_owner", "withdraw_owner_question", "decide", "decisions",
  "project_main", "coordinator_availability", "peers", "send", "send_status", "native_child_grant",
  "network_status", "resource_slots", "send_files", "fetch_files", "cancel_transfer",
  "max_subagents", "auto_wake", "usage_limits", "list_models", "dashboard", "set_job_outcome",
  "handoff_subagents", "message_subagent", "cancel_subagent", "pause_subagent", "resume_subagent", "report_progress",
  "checklist", "job_checklist", "project_checklist",
  ...["claude", "codex", "opencode", "antigravity", "muse"].flatMap(agent => [`ask_${agent}`, `spawn_${agent}`]),
] as const;
export const isClaudeScopedTool = (name: string): boolean => (CLAUDE_SCOPED_TOOLS as readonly string[]).includes(name);
export const CLAUDE_CHILD_STATUS_TOOLS = ["health", "decisions", "network_status", "resource_slots", "usage_limits", "list_models"] as const;
const GRANT_MS = 10_000;
const MAX_GRANTS = 128;
// Children cannot exhaust the shared map: the parent always keeps this headroom.
const PARENT_RESERVED_GRANTS = 16;
interface Grant { tool: string; sessionId: string; agentId?: string; expires: number }

/** Ephemeral capabilities issued only through the authenticated host-mod endpoint.
 * The mod supplies the engine's pinned agentId, never the model's native_child argument.
 * No token or grant is logged, persisted, or returned in a tool result. The server
 * requires one only while a native child route is live (see CLAUDE-MAIL-SCOPES.md).
 */
export class ClaudeMailScopes {
  private readonly grants = new Map<string, Grant>();
  constructor(private readonly now = () => performance.now()) {}

  issue(tool: string, sessionId: string, agentId?: string): string {
    if (!isClaudeScopedTool(tool) || !sessionId || agentId !== undefined && !NATIVE_AGENT_ID.test(agentId)) {
      throw new BridgeError("unauthorized", "Invalid Claude tool scope.");
    }
    const now = this.now();
    for (const [token, grant] of this.grants) if (grant.expires <= now) this.grants.delete(token);
    if (this.grants.size >= (agentId === undefined ? MAX_GRANTS : MAX_GRANTS - PARENT_RESERVED_GRANTS)) throw new BridgeError("unauthorized", "Claude tool scope capacity reached; retry later.");
    const token = randomBytes(24).toString("hex");
    this.grants.set(token, { tool, sessionId, agentId, expires: now + GRANT_MS });
    return token;
  }

  take(token: unknown, tool: string, sessionId: string | null): Grant {
    const grant = typeof token === "string" ? this.grants.get(token) : undefined;
    if (typeof token === "string") this.grants.delete(token); // one attempt, even for a mismatched call
    if (!grant || grant.expires <= this.now() || grant.tool !== tool || grant.sessionId !== sessionId) {
      // A genuine parent grant that only outlived its window (e.g. a slow permission prompt)
      // is marked so the caller may treat it as unscoped; that is safe only with no live child.
      const expiredParent = !!grant && grant.agentId === undefined && grant.tool === tool && grant.sessionId === sessionId;
      throw new BridgeError("unauthorized", "Missing, expired or ambiguous Claude tool scope; no tool action taken. Use the current host mod.",
        expiredParent ? { expiredParent: true } : undefined);
    }
    return grant;
  }
}
