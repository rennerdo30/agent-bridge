import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Logger } from "../core/logger.js";
import type { PermissionDecision, PermissionRequest } from "../core/relay.js";

/** Allow/Deny choice rendered by the host as a native dialog (MCP elicitation, form mode). */
const DECISION_SCHEMA = {
  type: "object" as const,
  properties: {
    decision: {
      type: "string" as const,
      title: "Decision",
      enum: ["allow", "deny"],
      enumNames: ["Allow", "Deny"],
    },
    reason: { type: "string" as const, title: "Reason (optional)" },
  },
  required: ["decision"],
};
/** How long the user has to answer before the request counts as denied. */
const ANSWER_TIMEOUT_MS = 10 * 60 * 1000;
export function describeRequest(req: PermissionRequest): string {
  // The whole text the owner approves: over-long requests are refused before they get here (AB-241).
  const detail = req.detail;
  return `A ${req.agent} subagent started by agent-bridge asks for permission to use ${req.tool}${req.cwd ? ` in ${req.cwd}` : ""}:\n\n${detail}`;
}

/**
 * Ask the user in the parent session. Hosts that cannot show elicitation dialogs, a dismissed dialog,
 * a timeout or any error all mean "deny": a subagent never gets more than the user explicitly allowed.
 */
export async function askUserViaElicitation(server: Server, req: PermissionRequest, log: Logger): Promise<PermissionDecision> {
  const caps = server.getClientCapabilities();
  if (!caps?.elicitation) {
    return { allow: false, message: "Denied: the parent session cannot show permission dialogs (its client does not support MCP elicitation)." };
  }
  try {
    const res = await server.elicitInput(
      { mode: "form", message: describeRequest(req), requestedSchema: DECISION_SCHEMA } as Parameters<Server["elicitInput"]>[0],
      { timeout: ANSWER_TIMEOUT_MS },
    );
    const allowed = res.action === "accept" && (res.content as { decision?: string } | undefined)?.decision === "allow";
    log.info("user answered subagent permission request", { tool: req.tool, action: res.action, allowed });
    const reason = typeof res.content?.reason === "string" ? res.content.reason.trim() : "";
    return allowed ? { allow: true } : { allow: false, message: `Denied by the user in the parent session${reason ? `: ${reason}` : "."}` };
  } catch (err) {
    log.warn("permission dialog failed; denying", { err: (err as Error).message });
    return { allow: false, message: "Denied: the permission dialog could not be shown or was not answered in time." };
  }
}
