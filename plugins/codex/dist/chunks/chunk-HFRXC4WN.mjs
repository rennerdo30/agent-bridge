import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/tool-allow.ts
function serverNames(server) {
  const short = /^plugin_[^_]+_(.+)$/.exec(server)?.[1] ?? /^([^_]+)_\1$/.exec(server)?.[1];
  const names = short ? [server, short] : [server];
  if (names.includes("pair_desk")) names.push("pair-desk");
  return names;
}
function shortServer(server) {
  return serverNames(server).at(-1);
}
function mcpToolOf(r) {
  const raw = /^(?:[\w]+\.)?mcp__(.+?)__(.+)$/.exec(r.tool);
  if (raw) return { server: raw[1], tool: raw[2] };
  if (!r.tool.startsWith("mcp:")) return null;
  const server = r.tool.slice("mcp:".length);
  const quoted = /\btool\s+["'`]([\w.-]+)["'`]/i.exec(r.detail)?.[1];
  let tool = quoted ?? /^\s*([\w.-]+)(?:\s*:|\s*$)/.exec(r.detail)?.[1] ?? null;
  const prefixes = serverNames(server).flatMap((name) => [name, name.replace(/[^a-zA-Z0-9_-]/g, "_")]).sort((a, b) => b.length - a.length);
  for (const name of prefixes) if (tool?.startsWith(`${name}_`)) {
    tool = tool.slice(name.length + 1);
    break;
  }
  return { server, tool };
}
var DESK_WORKER_PRESET = "pair-desk:worker";
var DESK_READ_PATTERNS = ["pair-desk.get_*", "pair-desk.list_*"];
var DESK_WORKER_PATTERNS = ["pair-desk.get_*", "pair-desk.list_*", "pair-desk.comment", "pair-desk.progress", "pair-desk.set_plan", "pair-desk.update_step", "pair-desk.create_issue", "pair-desk.update_issue", "pair-desk.set_location"];
function approvalHint(r) {
  const call = mcpToolOf(r);
  if (!call?.tool) return "";
  const server = shortServer(call.server);
  const preset = isAutoApproved(r, [DESK_WORKER_PRESET]) ? ` or "${DESK_WORKER_PRESET}" (desk reads, comments, plans, issue edits and review locations; excludes status, builds and handoff writes)` : "";
  return ` (not covered by this job's allow_tools; add "${server}.${call.tool}"${preset} to allow it without asking; get_* and list_* only cover reads)`;
}
function glob(pattern) {
  return new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
}
var OWN_SERVERS = /* @__PURE__ */ new Set(["agent-bridge", "agent-bridge_agent-bridge", "plugin_agent-bridge_bridge", "bridge"]);
function isOwnServerCall(r) {
  const call = mcpToolOf(r);
  return Boolean(call && OWN_SERVERS.has(call.server));
}
function isAutoApproved(r, patterns) {
  const call = mcpToolOf(r);
  if (!call || patterns.length === 0) return false;
  const names = serverNames(call.server).flatMap((s) => [s, call.tool ? `${s}.${call.tool}` : null]).filter((n) => Boolean(n));
  return patterns.flatMap((p) => p.trim() === DESK_WORKER_PRESET ? DESK_WORKER_PATTERNS : [p]).some((p) => {
    const re = glob(p.trim());
    return names.some((n) => re.test(n));
  });
}
var HANDOFF_TOOL = /(set|update)_handoff$/i;
function isHandoffToolCall(r) {
  const tool = mcpToolOf(r)?.tool;
  return Boolean(tool && HANDOFF_TOOL.test(tool));
}

export {
  DESK_READ_PATTERNS,
  approvalHint,
  isOwnServerCall,
  isAutoApproved,
  isHandoffToolCall
};
