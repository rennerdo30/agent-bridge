import { askRelay, RELAY_URL_ENV } from "../core/relay.js";

/**
 * Codex `PermissionRequest` hook (command type). Reads the hook input from stdin.
 *
 * Only acts inside a subagent that agent-bridge started with a permission relay (the relay URL is in
 * the environment). Everywhere else it prints nothing, so Codex falls back to its normal approval flow.
 * Inside a subagent it always prints a decision (deny on any error), so Codex's automatic reviewer is
 * never left to decide on its own.
 */
const MAX_DETAIL_CHARS = 4_000;

function describe(toolInput: unknown): string {
  if (toolInput && typeof toolInput === "object") {
    const o = toolInput as Record<string, unknown>;
    if (typeof o.command === "string") return o.command;
    if (typeof o.file_path === "string") return o.file_path;
  }
  return JSON.stringify(toolInput ?? {}).slice(0, MAX_DETAIL_CHARS);
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

export async function runPermissionHook(): Promise<number> {
  if (!process.env[RELAY_URL_ENV]) return 0;
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    // Unparseable input: still answer, with a deny.
  }
  const decision = await askRelay({
    agent: "codex",
    tool: String(input.tool_name ?? "unknown"),
    detail: describe(input.tool_input).slice(0, MAX_DETAIL_CHARS),
    cwd: typeof input.cwd === "string" ? input.cwd : undefined,
  });
  const out = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: decision.allow ? { behavior: "allow" } : { behavior: "deny", message: decision.message },
    },
  };
  process.stdout.write(JSON.stringify(out));
  return 0;
}
