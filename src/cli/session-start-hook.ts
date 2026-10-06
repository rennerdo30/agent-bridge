import { BridgeClient } from "../core/client.js";
import { defaultPeerName, loadConfig } from "../core/config.js";
import { PROTOCOL_VERSION } from "../core/constants.js";
import type { Logger } from "../core/logger.js";
import { resolveHome, resolvePipePath } from "../core/paths.js";
import type { PeerInfo } from "../core/protocol.js";
import { loadOrCreateToken } from "../core/token.js";
import { formatPeer } from "../mcp/format.js";

/**
 * Claude Code `SessionStart` command hook. At launch and on --continue/--resume, SessionStart fires before the
 * session's MCP servers are available, so an `mcp_tool` hook cannot run there: this asks the broker directly
 * who is online. The session's own server records its session id and folder with the next hook (the prompt).
 */
const BROKER_TIMEOUT_MS = 3_000;
const HOOK_EVENT = "SessionStart";

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function onlinePeers(home: string, log: Logger): Promise<PeerInfo[]> {
  let client: BridgeClient | null = null;
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("broker timeout")), BROKER_TIMEOUT_MS).unref());
  // Lost the race: never an unhandled rejection.
  timeout.catch(() => {});
  try {
    return await Promise.race([
      (async () => {
        client = await BridgeClient.connect(resolvePipePath(home), log);
        await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
        return client.request("peers", {});
      })(),
      timeout,
    ]);
  } finally {
    (client as BridgeClient | null)?.close();
  }
}

/** The startup note for the session: its bridge name and who else is online. */
export function sessionStartContext(name: string, peers: PeerInfo[] | null): string {
  const others = (peers ?? []).filter((p) => p.name !== name);
  return [
    `[agent-bridge] You are connected to agent-bridge as "${name}".`,
    others.length ? `Peers online:\n${others.map((p) => formatPeer(p)).join("\n")}` : "No other agents are online right now.",
  ].join("\n");
}

export async function runSessionStartHook(log: Logger, out: (text: string) => void = (text) => process.stdout.write(text), read: () => Promise<string> = readStdin): Promise<number> {
  let cwd = process.cwd();
  try {
    const input = JSON.parse((await read()) || "{}");
    if (typeof input.cwd === "string" && input.cwd) cwd = input.cwd;
  } catch {
    // No hook input: the process folder is the session's.
  }
  const home = resolveHome();
  const name = loadConfig(home, "claude", log).name ?? defaultPeerName("claude", cwd);
  const peers = await onlinePeers(home, log).catch((err) => {
    log.debug("session start: broker not reachable", { err: (err as Error).message });
    return null;
  });
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: sessionStartContext(name, peers) } }));
  return 0;
}
