import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  formatPeer
} from "./chunk-TJYHRUI4.mjs";
import {
  BridgeClient
} from "./chunk-VXNV2AYB.mjs";
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
} from "./chunk-46RB6AVL.mjs";
import "./chunk-Y3R7DNYE.mjs";
import {
  defaultPeerName,
  loadConfig
} from "./chunk-I2XRBOSH.mjs";
import {
  formatDecisionSummary,
  readDecisions
} from "./chunk-URHJJMOH.mjs";
import "./chunk-7SIT4IHS.mjs";
import {
  isPluginCacheCwd
} from "./chunk-NSCIYA7M.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-ABUT2FNZ.mjs";
import "./chunk-7NCHHXYD.mjs";
import "./chunk-XRHYDGVO.mjs";
import {
  PROTOCOL_VERSION
} from "./chunk-4DJV76SS.mjs";
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
