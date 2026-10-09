import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ANTIGRAVITY_ACCESS_ENV } from "../core/antigravity.js";
import { antigravityAncestor } from "../core/procinfo.js";
import { resolveHome } from "../core/paths.js";
import { askRelay, boundedDetail } from "../core/relay.js";
import { object } from "../core/transcripts/common.js";
import { isHandoffToolCall } from "../core/tool-allow.js";
import { createLogger } from "../core/logger.js";

const OWN_SERVERS = ["agent-bridge", "agent-bridge_agent-bridge"];
function allowed(input: Record<string, any>): Record<string, unknown> {
  const call = object(input.toolCall), args = object(call.args), resources: string[] = [];
  const server = args.ServerName ?? args.server_name ?? args.serverName;
  const tool = args.ToolName ?? args.tool_name ?? args.toolName;
  if (call.name === "call_mcp_tool" && typeof server === "string" && typeof tool === "string") resources.push(`mcp(${server}/${tool})`);
  if (call.name === "run_command" && typeof args.CommandLine === "string") resources.push(`command(${args.CommandLine})`);
  const path = args.TargetFile ?? args.AbsolutePath ?? args.FilePath;
  if (typeof path === "string") {
    const writes = ["write_to_file", "replace_file_content", "multi_replace_file_content", "notebook_edit"].includes(call.name);
    resources.push(`${writes ? "write_file" : "read_file"}(${path})`);
  }
  if (call.name === "read_url_content" && typeof args.Url === "string") {
    try { resources.push(`read_url(${new URL(args.Url).hostname})`); } catch { /* Native policy handles malformed URLs. */ }
  }
  return { decision: "allow", ...(resources.length ? { permissionOverrides: resources } : {}) };
}

/** Unknown tools fail closed for restricted delegation. Bridge coordination remains usable. */
export function antigravityReadingTool(input: Record<string, any>): boolean {
  const call = object(input.toolCall), args = object(call.args);
  if (["view_file", "grep_search", "find_by_name", "list_dir", "read_url_content", "search_web", "command_status", "list_resources", "read_resource", "finish", "wait", "wait_5_seconds"].includes(call.name)) return true;
  if (call.name !== "call_mcp_tool") return false;
  const server = args.ServerName ?? args.server_name ?? args.serverName;
  const tool = args.ToolName ?? args.tool_name ?? args.toolName;
  // The bridge enforces job ownership and delegated-tool restrictions itself.
  return OWN_SERVERS.includes(server) && typeof tool === "string" && tool.length > 0;
}

export async function antigravityPermission(input: Record<string, any>, access = process.env[ANTIGRAVITY_ACCESS_ENV]): Promise<Record<string, unknown>> {
  const call = object(input.toolCall), args = object(call.args);
  const server = args.ServerName ?? args.server_name ?? args.serverName;
  const tool = args.ToolName ?? args.tool_name ?? args.toolName;
  const request = { agent: "antigravity", tool: call.name === "call_mcp_tool" ? `mcp:${server ?? "unknown"}` : String(call.name ?? "unknown"), ...boundedDetail((call.name === "call_mcp_tool" ? `${tool ?? "unknown"}: ` : "") + JSON.stringify(args)), cwd: Array.isArray(input.workspacePaths) ? input.workspacePaths[0] : undefined };
  if (access && isHandoffToolCall(request)) return { decision: "deny", reason: "Delegated jobs report to their supervisor; handoff writes are declined" };
  if ((!access || access === "edit") && call.name === "call_mcp_tool" && OWN_SERVERS.includes(server)) return allowed(input);
  if (!access || access === "edit") return {};
  if (antigravityReadingTool(input)) return allowed(input);
  if (access !== "ask") return { decision: "deny", reason: "agent-bridge read access forbids this tool" };
  const decision = await askRelay(request);
  return decision.allow ? allowed(input) : { decision: "deny", reason: decision.message };
}

export function antigravityHookOutput(event: string, text: string): Record<string, unknown> {
  if (!text) return {};
  return event === "Stop" ? { decision: "continue", reason: text } : { injectSteps: [{ ephemeralMessage: text }] };
}

export async function runAntigravityHook(event: string): Promise<number> {
  try {
    let raw = "";
    for await (const part of process.stdin) { raw += part; if (raw.length > 256 * 1024) throw new Error("hook input too large"); }
    const input = object(JSON.parse(raw || "{}"));
    if (event === "PreToolUse") {
      const decision = await antigravityPermission(input), call = object(input.toolCall), args = object(call.args);
      try {
        createLogger({ home: resolveHome(), component: "antigravity-hook", consoleLevel: "silent" }).debug("native tool gate", { tool: call.name, server: args.ServerName, mcpTool: args.ToolName, inputKeys: Object.keys(input), access: process.env[ANTIGRAVITY_ACCESS_ENV], decision: decision.decision, overrides: decision.permissionOverrides });
      } catch { /* Diagnostic logging must never replace an explicit tool decision. */ }
      process.stdout.write(JSON.stringify(decision)); return 0;
    }
    const pid = await antigravityAncestor();
    if (!pid) { process.stdout.write("{}"); return 0; }
    const reg = JSON.parse(readFileSync(join(resolveHome(), "antigravity-hooks", `${pid}.json`), "utf8"));
    if (!Number.isInteger(reg.port) || typeof reg.secret !== "string") throw new Error("invalid hook registration");
    const res = await fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}`, "content-type": "application/json" }, body: JSON.stringify({ event, input }), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error("hook endpoint unavailable");
    process.stdout.write(JSON.stringify(await res.json()));
  } catch {
    // Even edit runs retain delegated handoff restrictions; an unreadable gate cannot waive them.
    process.stdout.write(JSON.stringify(event === "PreToolUse" && process.env[ANTIGRAVITY_ACCESS_ENV] ? { decision: "deny", reason: "agent-bridge permission hook unavailable" } : {}));
  }
  return 0;
}
