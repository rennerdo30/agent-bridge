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
  const names = short ? [server, short] : [server];
  if (names.includes("pair_desk")) names.push("pair-desk");
  return names;
}

/** A server's name as allow patterns use it ("plugin_x_pair-desk" -> "pair-desk"). */
export function shortServer(server: string): string {
  return serverNames(server).at(-1)!;
}

/** The MCP server and tool of a permission request, when it is an MCP tool call. */
export function mcpToolOf(r: { tool: string; detail: string }): { server: string; tool: string | null } | null {
  const raw = /^(?:[\w]+\.)?mcp__(.+?)__(.+)$/.exec(r.tool);
  if (raw) return { server: raw[1]!, tool: raw[2]! };
  if (!r.tool.startsWith("mcp:")) return null;
  const server = r.tool.slice("mcp:".length);
  const quoted = /\btool\s+["'`]([\w.-]+)["'`]/i.exec(r.detail)?.[1];
  let tool = quoted ?? /^\s*([\w.-]+)(?:\s*:|\s*$)/.exec(r.detail)?.[1] ?? null;
  // opencode prefixes the tool with its server: "pair-desk_list_projects".
  const prefixes = serverNames(server).flatMap((name) => [name, name.replace(/[^a-zA-Z0-9_-]/g, "_")]).sort((a, b) => b.length - a.length);
  for (const name of prefixes) if (tool?.startsWith(`${name}_`)) { tool = tool.slice(name.length + 1); break; }
  return { server, tool };
}

const DESK_WORKER_PRESET = "pair-desk:worker";
export const DESK_READ_PATTERNS = ["pair-desk.get_*", "pair-desk.list_*"];
const DESK_WORKER_PATTERNS = ["pair-desk.get_*", "pair-desk.list_*", "pair-desk.comment", "pair-desk.progress", "pair-desk.set_plan", "pair-desk.update_step", "pair-desk.create_issue", "pair-desk.update_issue", "pair-desk.set_location"];

/** Suggest explicit worker access without implying that read patterns cover desk writes. */
export function approvalHint(r: { tool: string; detail: string }): string {
  const call = mcpToolOf(r);
  if (!call?.tool) return "";
  const server = shortServer(call.server);
  const preset = isAutoApproved(r, [DESK_WORKER_PRESET]) ? ` or "${DESK_WORKER_PRESET}" (desk reads, comments, plans, issue edits and review locations; excludes status, builds and handoff writes)` : "";
  return ` (not covered by this job's allow_tools; add "${server}.${call.tool}"${preset} to allow it without asking; get_* and list_* only cover reads)`;
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
  return patterns.flatMap((p) => p.trim() === DESK_WORKER_PRESET ? DESK_WORKER_PATTERNS : [p]).some((p) => {
    const re = glob(p.trim());
    return names.some((n) => re.test(n));
  });
}

/** Handoff tools (names ending in set_handoff or update_handoff, e.g. pair-desk's): the session that started a subagent owns the handoff. */
const HANDOFF_TOOL = /(set|update)_handoff$/i;

/** Whether a subagent's request is a call to a handoff-writing MCP tool; such calls are declined without asking. */
export function isHandoffToolCall(r: { tool: string; detail: string }): boolean {
  const tool = mcpToolOf(r)?.tool;
  return Boolean(tool && HANDOFF_TOOL.test(tool));
}
