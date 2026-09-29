import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Codex runs plugin hooks only after the user trusted them in /hooks; the trust is stored in
 * config.toml under [hooks.state."<plugin>:plugin.json#hooks[0]:<event>:<group>:<handler>"].
 *
 * Forwarding permissions from a Codex subagent relies on the agent-bridge PermissionRequest hook. If it
 * does not run, Codex's automatic reviewer decides alone. A trust entry alone is not proof (a changed hook
 * keeps a stale entry), so agent-bridge also records what it observed per trusted hash:
 *  - verified: the hook answered a real request through the relay
 *  - failed:   a Codex "ask" run changed files without the hook asking (the reviewer approved)
 * A failed hash is never used again; the user has to re-trust the hook in /hooks (which changes the hash).
 */
const PERMISSION_HOOK_STATE_KEY = 'hooks.state."agent-bridge@agent-bridge:plugin.json#hooks[0]:permission_request:0:0"';
const OBSERVATIONS_FILE = "codex-hook.json";

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/** The trusted hash Codex stored for the agent-bridge PermissionRequest hook, if any. */
export function codexPermissionHookHash(home: string = codexHome(), read: (p: string) => string = (p) => readFileSync(p, "utf8")): string | null {
  let text: string;
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
    if (m) return m[1]!;
  }
  return null;
}

type Observation = "verified" | "failed";

function readObservations(bridgeHome: string): Record<string, Observation> {
  try {
    return JSON.parse(readFileSync(join(bridgeHome, OBSERVATIONS_FILE), "utf8")) as Record<string, Observation>;
  } catch {
    return {};
  }
}

export function recordCodexHookObservation(bridgeHome: string, hash: string, observation: Observation): void {
  const all = readObservations(bridgeHome);
  if (all[hash] === "failed") return; // never upgrade a hash that let the reviewer decide
  all[hash] = observation;
  try {
    writeFileSync(join(bridgeHome, OBSERVATIONS_FILE), JSON.stringify(all, null, 2), { mode: 0o600 });
  } catch {
    // best effort; the in-run warning still reaches the user
  }
}

/** Trusted in Codex and not caught letting the reviewer approve. */
export function codexPermissionHookTrusted(
  bridgeHome: string,
  home: string = codexHome(),
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
): boolean {
  const hash = codexPermissionHookHash(home, read);
  return hash !== null && readObservations(bridgeHome)[hash] !== "failed";
}
