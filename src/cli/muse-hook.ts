import { MUSE_ACCESS_ENV, museHookFile, museHostPid, readMusePrivateJson, restoreMuseContext } from "../core/muse-context.js";
import { processIdentity } from "../core/process-identity.js";
import { object } from "../core/transcripts/common.js";
import type { HookOutput } from "../mcp/hooks.js";

const READ_TOOLS = new Set(["read", "read_file", "view_file", "glob", "grep", "grep_search", "find_by_name", "list_dir", "ls", "web_search", "websearch", "web_fetch", "webfetch", "fetch", "search", "list_resources", "read_resource"]);
export function museBridgeTool(input: Record<string, any>): boolean {
  return /^mcp__(?:plugin_agent_bridge_bridge|agent_bridge)__[a-zA-Z0-9_]+$/.test(String(input.tool_name ?? ""));
}
export function museReadingTool(input: Record<string, any>): boolean {
  const tool = String(input.tool_name ?? "");
  return READ_TOOLS.has(tool.toLowerCase()) || museBridgeTool(input);
}
export function museHookOutput(event: string, output: HookOutput): Record<string, unknown> {
  if ("decision" in output && output.decision === "block") return { decision: "block", reason: output.reason };
  if ("hookSpecificOutput" in output && output.hookSpecificOutput) return { hookSpecificOutput: { hookEventName: event, additionalContext: output.hookSpecificOutput.additionalContext } };
  return {};
}
/**
 * The PreToolUse gate is a local decision: it needs no bridge endpoint. Inside a
 * `muse serve` host the MCP child's hook endpoint may never register (the child
 * can start before its session id exists), so deciding here keeps ask-mode jobs
 * fail-safe instead of failing closed: read still denies mutations, ask still
 * prompts natively (the MSP approval then reaches the supervisor), and native
 * children still cannot consume the root's bridge tools.
 */
export function musePreToolUseGate(input: Record<string, any>, access: string | undefined, childBridgeCall: boolean): Record<string, unknown> | null {
  if (childBridgeCall) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Muse native children share the root MCP connection; ask the parent to use Bridge tools." } };
  if (access === "read" && !museReadingTool(input)) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "agent-bridge read access forbids this tool" } };
  if (access === "ask" && !museReadingTool(input)) return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } };
  return null;
}

export async function runMuseHook(event: string): Promise<number> {
  let childBridgeCall = false;
  try {
    await restoreMuseContext();
    let raw = "";
    for await (const part of process.stdin) { raw += part; if (raw.length > 256 * 1024) throw new Error("hook input too large"); }
    const input = object(JSON.parse(raw || "{}"));
    const session = process.env.MUSE_SESSION_ID, thread = process.env.MUSE_THREAD_ID;
    childBridgeCall = event === "PreToolUse" && !!thread && thread !== session && museBridgeTool(input);
    if (event === "PreToolUse") {
      const gate = musePreToolUseGate(input, process.env[MUSE_ACCESS_ENV], childBridgeCall);
      if (gate) { process.stdout.write(JSON.stringify(gate)); return 0; }
    }
    if (!session) throw new Error("Muse session identity unavailable");
    if (event !== "PreToolUse" && ((thread && thread !== session) || (typeof input.session_id === "string" && input.session_id !== session))) { process.stdout.write("{}"); return 0; }
    const host = await museHostPid();
    if (!host) throw new Error("Muse host unavailable");
    const reg = readMusePrivateJson(museHookFile(host, session));
    if (reg.session !== session || reg.hostIdentity !== processIdentity(host) || reg.identity !== processIdentity(reg.pid) || !Number.isInteger(reg.port) || reg.port < 1 || reg.port > 65535 || typeof reg.secret !== "string") throw new Error("Invalid Muse hook binding");
    const response = await fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}`, "content-type": "application/json" }, body: JSON.stringify({ event, input, session, thread }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error("Muse hook unavailable");
    process.stdout.write(JSON.stringify(await response.json()));
  } catch {
    const access = process.env[MUSE_ACCESS_ENV];
    process.stdout.write(JSON.stringify(event === "PreToolUse" && (childBridgeCall || access === "read" || access === "ask" || process.env.AGENT_BRIDGE_INTERNAL === "1") ? { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: "agent-bridge permission gate unavailable" } } : {}));
  }
  return 0;
}
