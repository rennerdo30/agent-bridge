import { BridgeClient } from "../core/client.js";
import { isPluginCacheCwd } from "../core/session-visibility.js";
import { defaultPeerName, loadConfig } from "../core/config.js";
import { PROTOCOL_VERSION } from "../core/constants.js";
import type { Logger } from "../core/logger.js";
import { resolveDbPath, resolveHome, resolvePipePath } from "../core/paths.js";
import type { PeerInfo } from "../core/protocol.js";
import { loadOrCreateToken } from "../core/token.js";
import { formatPeer } from "../mcp/format.js";
import { formatDecisionSummary, readDecisions, type OwnerDecision } from "../core/decisions.js";

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

async function startupState(home: string, cwd: string, name: string, log: Logger): Promise<{ peers: PeerInfo[]; decisions: OwnerDecision[] }> {
  let client: BridgeClient | null = null;
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("broker timeout")), BROKER_TIMEOUT_MS).unref());
  // Lost the race: never an unhandled rejection.
  timeout.catch(() => {});
  try {
    return await Promise.race([
      (async () => {
        client = await BridgeClient.connect(resolvePipePath(home), log);
        await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
        const peers = await client.request("peers", {});
        // An older broker may not support decisions yet; the presence note still works.
        const decisions = await client.request("decisions", { scope: { project: cwd }, session: name }).catch(() => []);
        return { peers, decisions };
      })(),
      timeout,
    ]);
  } finally {
    (client as BridgeClient | null)?.close();
  }
}

/** The startup note for the session: its bridge name and who else is online. */
export function sessionStartContext(name: string, peers: PeerInfo[] | null, decisions: OwnerDecision[] = []): string {
  const others = (peers ?? []).filter((p) => p.name !== name && !isPluginCacheCwd(p.cwd));
  return [
    `[agent-bridge] You are connected to agent-bridge as "${name}".`,
    others.length ? `Peers online:\n${others.map((p) => formatPeer(p)).join("\n")}` : "No other agents are online right now.",
    formatDecisionSummary(decisions),
  ].filter(Boolean).join("\n");
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
  const state = await startupState(home, cwd, name, log).catch((err) => {
    log.debug("session start: broker not reachable", { err: (err as Error).message });
    try { return { peers: [], decisions: readDecisions(resolveDbPath(home), { scope: { project: cwd }, session: name }) }; }
    catch { return null; }
  });
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: sessionStartContext(name, state?.peers ?? null, state?.decisions) } }));
  return 0;
}
