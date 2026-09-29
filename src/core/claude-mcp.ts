import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The MCP servers a Claude Code subagent would load, as permission rule names (mcp__<server>), so a
 * read-only subagent can be denied all of them except agent-bridge's own (it answers its parent with send).
 * A blanket "mcp__*" deny would also block that: deny rules beat allow rules.
 *
 * Sources: plugin servers (mcp__plugin_<plugin>_<server>), user and per-project servers in ~/.claude.json,
 * the project's .mcp.json, and the claude.ai account connectors (by prefix).
 */
export const OWN_SERVER_RULE = "mcp__plugin_agent-bridge_bridge";
/** Connectors from the claude.ai account cannot be listed locally; their tools share this prefix. */
const ACCOUNT_CONNECTORS_RULE = "mcp__claude_ai_*";
/** Built into Claude Code rather than configured (the browser extension). */
const BUILT_IN_RULES = ["mcp__claude-in-chrome"];

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function serverNames(mcp: unknown): string[] {
  return mcp && typeof mcp === "object" ? Object.keys(mcp as object) : [];
}

/** MCP servers of the installed Claude Code plugins. */
function pluginServers(home: string): string[] {
  const installed = readJson(join(home, ".claude", "plugins", "installed_plugins.json"));
  const out: string[] = [];
  for (const [key, entries] of Object.entries<any>(installed?.plugins ?? {})) {
    const plugin = key.split("@")[0]!;
    for (const e of Array.isArray(entries) ? entries : [entries]) {
      const root = e?.installPath;
      if (typeof root !== "string") continue;
      const manifest = readJson(join(root, ".claude-plugin", "plugin.json"));
      const declared = manifest?.mcpServers;
      const servers = typeof declared === "string" ? readJson(resolve(root, declared))?.mcpServers ?? readJson(resolve(root, declared)) : declared;
      const names = new Set([...serverNames(servers), ...serverNames(readJson(join(root, ".mcp.json"))?.mcpServers)]);
      for (const s of names) out.push(`mcp__plugin_${plugin}_${s}`);
    }
  }
  return out;
}

export function claudeMcpDenyRules(cwd: string, home = homedir()): string[] {
  const config = readJson(join(home, ".claude.json"));
  const norm = (p: string) => resolve(p).replace(/\\/g, "/").toLowerCase();
  const project = Object.entries<any>(config?.projects ?? {}).find(([p]) => norm(p) === norm(cwd))?.[1];
  const names = [
    ...pluginServers(home),
    ...serverNames(config?.mcpServers).map((s) => `mcp__${s}`),
    ...serverNames(project?.mcpServers).map((s) => `mcp__${s}`),
    ...serverNames(readJson(join(cwd, ".mcp.json"))?.mcpServers).map((s) => `mcp__${s}`),
    ACCOUNT_CONNECTORS_RULE,
    ...BUILT_IN_RULES,
  ];
  return [...new Set(names)].filter((n) => n !== OWN_SERVER_RULE);
}
