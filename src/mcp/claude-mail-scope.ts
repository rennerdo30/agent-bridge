import { randomBytes } from "node:crypto";
import { NATIVE_AGENT_ID } from "../core/native-children.js";
import { BridgeError } from "../core/protocol.js";

export const CLAUDE_MAIL_TOOLS = ["inbox", "wait_for_message", "get_conversation", "search_history"] as const;
export const isClaudeMailTool = (name: string): boolean => (CLAUDE_MAIL_TOOLS as readonly string[]).includes(name);
const GRANT_MS = 10_000;
const MAX_GRANTS = 128;
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
    if (!isClaudeMailTool(tool) || !sessionId || agentId !== undefined && !NATIVE_AGENT_ID.test(agentId)) {
      throw new BridgeError("unauthorized", "Invalid Claude mail scope.");
    }
    const now = this.now();
    for (const [token, grant] of this.grants) if (grant.expires <= now) this.grants.delete(token);
    if (this.grants.size >= MAX_GRANTS) throw new BridgeError("unauthorized", "Claude mail scope capacity reached; mail remains queued.");
    const token = randomBytes(24).toString("hex");
    this.grants.set(token, { tool, sessionId, agentId, expires: now + GRANT_MS });
    return token;
  }

  take(token: unknown, tool: string, sessionId: string | null): Grant {
    const grant = typeof token === "string" ? this.grants.get(token) : undefined;
    if (typeof token === "string") this.grants.delete(token); // one attempt, even for a mismatched call
    if (!grant || grant.expires <= this.now() || grant.tool !== tool || grant.sessionId !== sessionId) {
      throw new BridgeError("unauthorized", "Missing, expired or ambiguous Claude mail scope; no mail accessed. Use the current host mod or receive mail through hooks.");
    }
    return grant;
  }
}
