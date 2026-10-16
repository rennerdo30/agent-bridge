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
  const short = /^plugin_[^_]+_(.+)$/.exec(server)?.[1] ?? /^([^_]+)_\1$/.exec(server)?.[1];
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
  // The "<tool>: <args>" prefix (Claude, opencode, Antigravity) wins: the arguments after it are the job's own
  // text and may quote another tool's name (AB-423). Only a detail without that prefix (Codex's one-line
  // elicitation sentence, 'Allow the … server to run tool "x"?') may name the tool in quotes, exactly once.
  const prefixed = /^\s*([\w.-]+)(?:\s*:|\s*$)/.exec(r.detail)?.[1];
  const quotedAll = prefixed || /[\r\n]/.test(r.detail.trim()) ? [] : [...r.detail.matchAll(/\btool\s+["'`]([\w.-]+)["'`]/gi)];
  let tool = prefixed ?? (quotedAll.length === 1 ? quotedAll[0]![1]! : null);
  // opencode prefixes the tool with its server: "pair-desk_list_projects".
  const prefixes = serverNames(server).flatMap((name) => [name, name.replace(/[^a-zA-Z0-9_-]/g, "_")]).sort((a, b) => b.length - a.length);
  for (const name of prefixes) if (tool?.startsWith(`${name}_`)) { tool = tool.slice(name.length + 1); break; }
  return { server, tool };
}

const DESK_WORKER_PRESET = "pair-desk:worker";
export const DESK_READ_PATTERNS = ["pair-desk.get_*", "pair-desk.list_*"];
/**
 * "pair-desk:worker": reads, comments, progress, plans, steps, issue edits and review locations. Creating issues
 * is not part of it (owner decision 2026-10-16, AB-403): grant "pair-desk.create_issue" explicitly.
 */
const DESK_WORKER_PATTERNS = ["pair-desk.get_*", "pair-desk.list_*", "pair-desk.comment", "pair-desk.progress", "pair-desk.set_plan", "pair-desk.update_step", "pair-desk.update_issue", "pair-desk.set_location"];

/**
 * A job's allow_tools (AB-403): an explicit list from spawn_* / ask_* replaces the configured default
 * (jobs.defaultAllowTools, "pair-desk:worker" unless changed); an explicit [] turns it off for that job.
 * Only bridge jobs use this; native children and the session itself never see the default.
 */
export function effectiveAllowTools(explicit: readonly string[] | undefined, defaults: readonly string[]): string[] {
  return [...(explicit ?? defaults)];
}

/** Suggest explicit worker access without implying that read patterns cover desk writes. */
export function approvalHint(r: { tool: string; detail: string }): string {
  const call = mcpToolOf(r);
  if (!call?.tool) return "";
  const server = shortServer(call.server);
  const preset = isAutoApproved(r, [DESK_WORKER_PRESET]) ? ` or "${DESK_WORKER_PRESET}" (desk reads, comments, plans, issue edits and review locations; excludes status, builds and handoff writes)` : "";
  return ` (not covered by this job's allow_tools; add "${server}.${call.tool}"${preset} to allow it without asking; get_* and list_* only cover reads)`;
}

function glob(pattern: string, flags = "i"): RegExp {
  return new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, flags);
}

/** Structured inventory never goes through CLI description or opencode prefix normalization. */
export function isInventoryToolGranted(server: string, tool: string, patterns: readonly string[]): boolean {
  const names = serverNames(server).flatMap((name) => [name, `${name}.${tool}`]);
  return patterns.flatMap((p) => p.trim() === DESK_WORKER_PRESET ? DESK_WORKER_PATTERNS : [p.trim()])
    .some((pattern) => names.some((name) => glob(pattern, "").test(name)));
}

/** Whether any grant selects a server, including a tool-specific grant or worker preset. */
export function hasServerGrant(server: string, patterns: readonly string[]): boolean {
  return patterns.flatMap((p) => p.trim() === DESK_WORKER_PRESET ? DESK_WORKER_PATTERNS : [p.trim()])
    .some((p) => serverNames(server).some((name) => glob(p.split(".")[0]!).test(name)));
}

/**
 * The subagent's own agent-bridge server (send to its parent, report_progress, peers): always allowed, it only
 * talks to the session that runs the subagent. Its name per CLI: Codex "agent-bridge", Claude
 * "plugin_agent-bridge_bridge", opencode "bridge".
 */
const OWN_SERVERS = new Set(["agent-bridge", "agent-bridge_agent-bridge", "plugin_agent-bridge_bridge", "bridge"]);

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
