import { readFileSync } from "node:fs";
import { resolveHome } from "../core/paths.js";
import { sessionFile, type RewakeRegistration } from "../mcp/rewake.js";

/**
 * Claude Code `Stop` hook with `async` + `asyncRewake`: runs in the background after a turn ends and waits
 * (via the session's agent-bridge server) for a subagent result or an awaited reply. When one arrives it
 * prints the messages to stderr and exits 2, which wakes the session. Exit 0 = nothing to do.
 */
const EXIT_WAKE = 2;
/** Stop polling a bit before the hook's configured timeout (7200s in hooks.json). */
const MAX_WAIT_MS = 7_000 * 1000;

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

export async function runRewakeHook(): Promise<number> {
  let sessionId = "";
  try {
    sessionId = String(JSON.parse((await readStdin()) || "{}").session_id ?? "");
  } catch {
    return 0;
  }
  if (!sessionId) return 0;
  let reg: RewakeRegistration;
  try {
    reg = JSON.parse(readFileSync(sessionFile(resolveHome(), sessionId), "utf8"));
  } catch {
    return 0; // no agent-bridge server for this session
  }
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${reg.port}/wait`, { headers: { authorization: `Bearer ${reg.secret}` } });
    } catch {
      return 0; // the session's server is gone
    }
    if (!res.ok) return 0;
    const { text, superseded } = (await res.json()) as { text?: string; superseded?: boolean };
    if (text) {
      process.stderr.write(text);
      return EXIT_WAKE;
    }
    if (superseded) return 0; // a newer turn's hook is waiting now
  }
  return 0;
}