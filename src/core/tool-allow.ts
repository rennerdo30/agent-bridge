/**
 * Which MCP tool calls of subagents are approved without asking the parent, by name patterns such as
 * "pair-desk.get_*", "pair-desk.list_*" or "pair-desk" (the whole server). Patterns come from the config
 * (autoApproveTools) and from ask_* / spawn_* (allow_tools).
 *
 * Each CLI describes an MCP permission differently; all arrive as tool "mcp:<server>" plus a detail:
 *  - Codex:    detail 'Allow the pair-desk MCP server to run tool "list_projects"?'
 *  - Claude:   server "plugin_<plugin>_<server>", detail "list_projects: {...}"
 *  - opencode: detail "pair-desk_list_projects: ..."
 */

/** "plugin_agent-pair-programming_pair-desk" -> "pair-desk" (Claude names plugin servers this way). */
function serverNames(server: string): string[] {
  const short = /^plugin_[^_]+_(.+)$/.exec(server)?.[1];
  return short ? [server, short] : [server];
}

/** The MCP server and tool of a permission request, when it is an MCP tool call. */
export function mcpToolOf(r: { tool: string; detail: string }): { server: string; tool: string | null } | null {
  if (!r.tool.startsWith("mcp:")) return null;
  const server = r.tool.slice("mcp:".length);
  const quoted = /tool "([^"]+)"/.exec(r.detail)?.[1];
  let tool = quoted ?? /^\s*([\w.-]+)/.exec(r.detail)?.[1] ?? null;
  // opencode prefixes the tool with its server: "pair-desk_list_projects".
  for (const name of serverNames(server)) if (tool?.startsWith(`${name}_`)) tool = tool.slice(name.length + 1);
  return { server, tool };
}

function glob(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
}

/**
 * The subagent's own agent-bridge server (send to its parent, report_progress, peers): always allowed, it only
 * talks to the session that runs the subagent. Its name per CLI: Codex "agent-bridge", Claude
 * "plugin_agent-bridge_bridge", opencode "bridge".
 */
const OWN_SERVERS = new Set(["agent-bridge", "plugin_agent-bridge_bridge", "bridge"]);

export function isOwnServerCall(r: { tool: string; detail: string }): boolean {
  const call = mcpToolOf(r);
  return Boolean(call && OWN_SERVERS.has(call.server));
}

/** Whether a pattern list allows this request (always false for non-MCP requests: commands, edits). */
export function isAutoApproved(r: { tool: string; detail: string }, patterns: readonly string[]): boolean {
  const call = mcpToolOf(r);
  if (!call || patterns.length === 0) return false;
  const names = serverNames(call.server).flatMap((s) => [s, call.tool ? `${s}.${call.tool}` : null]).filter((n): n is string => Boolean(n));
  return patterns.some((p) => {
    const re = glob(p.trim());
    return names.some((n) => re.test(n));
  });
}
