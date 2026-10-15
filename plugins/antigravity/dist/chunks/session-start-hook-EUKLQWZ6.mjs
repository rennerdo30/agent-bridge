import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  formatPeer
} from "./chunk-I263LBHO.mjs";
import {
  BridgeClient
} from "./chunk-B3K53X7D.mjs";
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
} from "./chunk-5FNZ2HXA.mjs";
import {
  defaultPeerName,
  loadConfig
} from "./chunk-S72NJQVR.mjs";
import {
  formatDecisionSummary,
  readDecisions
} from "./chunk-KUUDTYJ7.mjs";
import {
  isPluginCacheCwd
} from "./chunk-5H3R35DU.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-LNAYXYZY.mjs";
import "./chunk-SAM43D5P.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-QLF3MF4O.mjs";
import "./chunk-EMB34XJI.mjs";
import "./chunk-W6KF56AK.mjs";
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
function sessionStartContext(name, peers, decisions = []) {
  const others = (peers ?? []).filter((p) => p.name !== name && !isPluginCacheCwd(p.cwd));
  return [
    `[agent-bridge] You are connected to agent-bridge as "${name}".`,
    others.length ? `Peers online:
${others.map((p) => formatPeer(p)).join("\n")}` : "No other agents are online right now.",
    formatDecisionSummary(decisions)
  ].filter(Boolean).join("\n");
}
async function runSessionStartHook(log, out = (text) => process.stdout.write(text), read = readStdin) {
  let cwd = process.cwd();
  try {
    const input = JSON.parse(await read() || "{}");
    if (typeof input.cwd === "string" && input.cwd) cwd = input.cwd;
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
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_EVENT, additionalContext: sessionStartContext(name, state?.peers ?? null, state?.decisions) } }));
  return 0;
}
export {
  runSessionStartHook,
  sessionStartContext
};
