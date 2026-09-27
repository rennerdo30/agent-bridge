import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Codex runs plugin hooks only after the user trusted them in /hooks; the trust is stored in
 * config.toml under [hooks.state."<plugin>:plugin.json#hooks[0]:<event>:<group>:<handler>"].
 *
 * Forwarding permissions from a Codex subagent relies on the agent-bridge PermissionRequest hook. If it
 * does not run, Codex's automatic reviewer would decide alone, so forwarding is only used when this
 * trust entry exists. Keep the hook definition in plugin.json unchanged: editing it invalidates the trust.
 */
const PERMISSION_HOOK_STATE_KEY = 'hooks.state."agent-bridge@agent-bridge:plugin.json#hooks[0]:permission_request:0:0"';

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

export function codexPermissionHookTrusted(home: string = codexHome(), read: (p: string) => string = (p) => readFileSync(p, "utf8")): boolean {
  let text: string;
  try {
    text = read(join(home, "config.toml"));
  } catch {
    return false;
  }
  const at = text.indexOf(`[${PERMISSION_HOOK_STATE_KEY}]`);
  if (at < 0) return false;
  // The table body runs until the next table header.
  const rest = text.slice(at).split(/\r?\n/).slice(1);
  for (const line of rest) {
    if (line.trim().startsWith("[")) break;
    if (/^\s*trusted_hash\s*=\s*"sha256:[0-9a-f]+"/.test(line)) return true;
  }
  return false;
}
