import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveHome } from "../core/paths.js";
import { object } from "../core/transcripts/common.js";
import type { HookOutput } from "../mcp/hooks.js";

/** The registration file a muse-hosted MCP server publishes for its session's hooks. */
export function museHookRegistration(home: string, sessionId: string): string {
  return join(home, "muse-hooks", `${sessionId.replace(/[^\w-]/g, "_")}.json`);
}

/** Map the bridge's Claude-shaped hook output onto Muse's hook output for one event. */
export function museHookOutput(event: string, output: HookOutput): Record<string, unknown> {
  const text = "reason" in output ? String(output.reason) : "hookSpecificOutput" in output ? output.hookSpecificOutput.additionalContext : "";
  if (!text) return {};
  if (event === "Stop") return { decision: "block", reason: text };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

/**
 * Command hook declared by the Muse plugin: forwards one lifecycle event to the
 * bridge MCP server of this session (which registered its endpoint by session id)
 * and prints its JSON answer. Any failure stays silent: a hook must never break a turn.
 */
export async function runMuseHook(eventArg?: string): Promise<number> {
  try {
    let raw = "";
    for await (const part of process.stdin) { raw += part; if (raw.length > 256 * 1024) throw new Error("hook input too large"); }
    const input = object(JSON.parse(raw || "{}"));
    const event = typeof input.hook_event_name === "string" ? input.hook_event_name : eventArg ?? "";
    const sessionId = typeof input.session_id === "string" ? input.session_id : process.env.MUSE_SESSION_ID ?? "";
    if (!event || !sessionId) { process.stdout.write("{}"); return 0; }
    const reg = JSON.parse(readFileSync(museHookRegistration(resolveHome(), sessionId), "utf8"));
    if (!Number.isInteger(reg.port) || typeof reg.secret !== "string") throw new Error("invalid hook registration");
    const res = await fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}`, "content-type": "application/json" }, body: JSON.stringify({ event, input }), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error("hook endpoint unavailable");
    process.stdout.write(JSON.stringify(await res.json()));
  } catch {
    process.stdout.write("{}");
  }
  return 0;
}
