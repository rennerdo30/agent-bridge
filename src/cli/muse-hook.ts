import { MUSE_ACCESS_ENV, museHookFile, museHostPid, readMusePrivateJson, restoreMuseContext } from "../core/muse-context.js";
import { processIdentity } from "../core/process-identity.js";
import { object, TRANSCRIPT_ID } from "../core/transcripts/common.js";
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
 * After the per-run host handoff is authenticated, restrictive decisions can be
 * made locally before the late SDK session identity exists: read denies writes,
 * ask requires native approval, and children cannot use root Bridge tools.
 * A missing handoff never reaches this gate; it denies in runMuseHook instead.
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
    // Only permission decisions need the adapter's environment contract. Mail
    // callbacks authenticate the current hook registration below instead; doing
    // both repeats DPAPI, host identity and ancestry probes in every fresh CLI.
    const restored = event === "PreToolUse" ? await restoreMuseContext() : false;
    let raw = "";
    for await (const part of process.stdin) { raw += part; if (raw.length > 256 * 1024) throw new Error("hook input too large"); }
    const input = object(JSON.parse(raw || "{}"));
    const session = process.env.MUSE_SESSION_ID, thread = process.env.MUSE_THREAD_ID;
    childBridgeCall = event === "PreToolUse" && !!thread && thread !== session && museBridgeTool(input);
    if (event === "PreToolUse") {
      if (!restored && process.env.AGENT_BRIDGE_INTERNAL === "1") throw new Error("Unauthenticated Muse host context");
      const gate = musePreToolUseGate(input, process.env[MUSE_ACCESS_ENV], childBridgeCall);
      if (gate) { process.stdout.write(JSON.stringify(gate)); return 0; }
    }
    if (!session || !TRANSCRIPT_ID.test(session)) throw new Error("Muse session identity unavailable");
    if (event !== "PreToolUse" && ((thread && thread !== session) || (typeof input.session_id === "string" && input.session_id !== session))) { process.stdout.write("{}"); return 0; }
    const host = await museHostPid();
    if (!host) throw new Error("Muse host unavailable");
    let reg: Record<string, any>;
    try { reg = readMusePrivateJson(museHookFile(host, session)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; reg = readMusePrivateJson(museHookFile(host, "bootstrap")); }
    if ((reg.session !== null && reg.session !== session) || reg.hostIdentity !== processIdentity(host) || reg.identity !== processIdentity(reg.pid) || !Number.isInteger(reg.port) || reg.port < 1 || reg.port > 65535 || typeof reg.secret !== "string" || !reg.secret) throw new Error("Invalid Muse hook binding");
    const response = await fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}`, "content-type": "application/json" }, body: JSON.stringify({ event, input, session, thread }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error("Muse hook unavailable");
    process.stdout.write(JSON.stringify(await response.json()));
  } catch {
    process.stdout.write(JSON.stringify(event === "PreToolUse" ? { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: "agent-bridge permission gate unavailable" } } : {}));
  }
  return 0;
}
