import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/codex-trust.ts
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var PERMISSION_HOOK_STATE_KEY = 'hooks.state."agent-bridge@agent-bridge:plugin.json#hooks[0]:permission_request:0:0"';
var OBSERVATIONS_FILE = "codex-hook.json";
function codexHome(env = process.env) {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}
function codexPermissionHookHash(home = codexHome(), read = (p) => readFileSync(p, "utf8")) {
  let text;
  try {
    text = read(join(home, "config.toml"));
  } catch {
    return null;
  }
  const at = text.indexOf(`[${PERMISSION_HOOK_STATE_KEY}]`);
  if (at < 0) return null;
  for (const line of text.slice(at).split(/\r?\n/).slice(1)) {
    if (line.trim().startsWith("[")) break;
    const m = /^\s*trusted_hash\s*=\s*"(sha256:[0-9a-f]+)"/.exec(line);
    if (m) return m[1];
  }
  return null;
}
function readObservations(bridgeHome) {
  try {
    return JSON.parse(readFileSync(join(bridgeHome, OBSERVATIONS_FILE), "utf8"));
  } catch {
    return {};
  }
}
function recordCodexHookObservation(bridgeHome, hash, observation) {
  const all = readObservations(bridgeHome);
  if (all[hash] === "failed") return;
  all[hash] = observation;
  try {
    writeFileSync(join(bridgeHome, OBSERVATIONS_FILE), JSON.stringify(all, null, 2), { mode: 384 });
  } catch {
  }
}
function codexPermissionHookTrusted(bridgeHome, home = codexHome(), read = (p) => readFileSync(p, "utf8")) {
  const hash = codexPermissionHookHash(home, read);
  return hash !== null && readObservations(bridgeHome)[hash] !== "failed";
}

export {
  codexHome,
  codexPermissionHookHash,
  recordCodexHookObservation,
  codexPermissionHookTrusted
};
