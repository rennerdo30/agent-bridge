import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  formatMachineSkew,
  formatPeer
} from "./chunk-OJPUGEST.mjs";
import {
  BridgeClient
} from "./chunk-EWFBGKQO.mjs";
import {
  readBodyText
} from "./chunk-6KTEQAZ2.mjs";
import "./chunk-ORHVXX2T.mjs";
import {
  loadOrCreateToken
} from "./chunk-DNAUDSOJ.mjs";
import {
  resolveDbPath,
  resolveHome,
  resolvePipePath
} from "./chunk-YGG2GNCU.mjs";
import "./chunk-Y3R7DNYE.mjs";
import {
  defaultPeerName,
  loadConfig
} from "./chunk-VAAHNP24.mjs";
import {
  formatDecisionSummary,
  readDecisions
} from "./chunk-JR5WUYK2.mjs";
import "./chunk-ASTYETXU.mjs";
import {
  isPluginCacheCwd
} from "./chunk-XOWKRTDA.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-MPE4JJY6.mjs";
import "./chunk-7NCHHXYD.mjs";
import "./chunk-4RLE2X5P.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-S4LREWMY.mjs";
import "./chunk-AAH2UEC3.mjs";
import "./chunk-6RNADTH4.mjs";

// src/cli/session-start-hook.ts
var BROKER_TIMEOUT_MS = 3e3;
var HOOK_EVENT = "SessionStart";
async function readStdin() {
  return readBodyText(process.stdin);
}
async function startupState(home, cwd, name, log) {
  let client = null;
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("broker timeout")), BROKER_TIMEOUT_MS).unref());
  timeout.catch(() => {
  });
  try {
    return await Promise.race([
      (async () => {
        client = await BridgeClient.connect(resolvePipePath(home), log);
        await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
        const peers = await client.request("peers", {});
        const decisions = await client.request("decisions", { scope: { project: cwd }, session: name }).catch(() => []);
        return { peers, decisions };
      })(),
      timeout
    ]);
  } finally {
    client?.close();
  }
}
function sessionStartContext(name, peers, decisions = [], sessionId) {
  const live = peers ?? [];
  const self = sessionId ? live.find((p) => p.agent === "claude" && p.sessionId === sessionId) : void 0;
  const holder = self ? void 0 : live.find((p) => p.name === name);
  const taken = Boolean(sessionId && holder?.sessionId && holder.sessionId !== sessionId);
  const own = self?.name ?? (taken ? void 0 : name);
  const others = live.filter((p) => p !== self && p.name !== own && !isPluginCacheCwd(p.cwd));
  return [
    own ? `[agent-bridge] You are connected to agent-bridge as "${own}".` : `[agent-bridge] Another live session already uses "${name}", so this session gets a suffixed agent-bridge name (for example "${name}-2"). Check your own name with the agent-bridge peers tool before using it (project_main, replies).`,
    others.length ? `Peers online:
${others.map((p) => formatPeer(p)).join("\n")}` : "No other agents are online right now.",
    ...formatMachineSkew(others),
    formatDecisionSummary(decisions)
  ].filter(Boolean).join("\n");
}
async function runSessionStartHook(log, out = (text) => process.stdout.write(text), read = readStdin) {
  let cwd = process.cwd(), sessionId;
  try {
    const input = JSON.parse(await read() || "{}");
    if (typeof input.cwd === "string" && input.cwd) cwd = input.cwd;
    if (typeof input.session_id === "string" && input.session_id) sessionId = input.session_id;
  } catch {
  }
  const home = resolveHome();
  const name = loadConfig(home, "claude", log).name ?? defaultPeerName("claude", cwd);
  const state = await startupState(home, cwd, name, log).catch((err) => {
    log.debug("session start: broker not reachable", { err: err.message });
    try {
      return { peers: [], decisions: readDecisions(resolveDbPath(home), { scope: { project: cwd }, session: name }) };
    } catch {
      return null;
    }
  });
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: sessionStartContext(name, state?.peers ?? null, state?.decisions, sessionId) } }));
  return 0;
}
export {
  runSessionStartHook,
  sessionStartContext
};
