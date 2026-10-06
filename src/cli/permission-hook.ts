import { askRelay, RELAY_URL_ENV, type PermissionRequest } from "../core/relay.js";

/**
 * `PermissionRequest` hook (command type) for Codex and Claude Code subagents. Reads the hook input from stdin.
 *
 * Only acts inside a subagent that agent-bridge started with a permission relay (the relay URL is in
 * the environment). Everywhere else it prints nothing, so the host falls back to its normal approval flow.
 * Inside a subagent it always prints a decision (deny on any error), so Codex's automatic reviewer is
 * never left to decide on its own.
 *
 * Codex loads it from its plugin manifest; Claude subagents get it through `--settings` (see delegate.ts),
 * with "claude" as argument.
 */
const MAX_DETAIL_CHARS = 4_000;
/** Codex and Claude Code name MCP tools mcp__<server>__<tool>. */
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;

function describe(toolInput: unknown): string {
  if (toolInput && typeof toolInput === "object") {
    const o = toolInput as Record<string, unknown>;
    if (typeof o.command === "string") return o.command;
    if (typeof o.file_path === "string") return o.file_path;
  }
  return JSON.stringify(toolInput ?? {}).slice(0, MAX_DETAIL_CHARS);
}

/** The relay request for one hook input. MCP tools become "mcp:<server>" (one allow covers the server). */
export function hookRequest(agent: string, input: Record<string, unknown>): PermissionRequest {
  const tool = String(input.tool_name ?? "unknown");
  const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
  const detail = describe(input.tool_input);
  const mcp = MCP_TOOL.exec(tool);
  if (mcp) return { agent, tool: `mcp:${mcp[1]}`, detail: `${mcp[2]}: ${detail}`.slice(0, MAX_DETAIL_CHARS), cwd };
  return { agent, tool, detail: detail.slice(0, MAX_DETAIL_CHARS), cwd };
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

export async function runPermissionHook(agent = "codex"): Promise<number> {
  if (!process.env[RELAY_URL_ENV]) return 0;
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    // Unparseable input: still answer, with a deny.
  }
  const decision = await askRelay(hookRequest(agent === "claude" ? "claude" : "codex", input));
  const out = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: decision.allow ? { behavior: "allow" } : { behavior: "deny", message: decision.message },
    },
  };
  process.stdout.write(JSON.stringify(out));
  return 0;
}
