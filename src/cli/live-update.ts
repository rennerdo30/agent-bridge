import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_VERSION, PROTOCOL_VERSION } from "../core/constants.js";
import { BridgeClient } from "../core/client.js";
import { resolvePipePath } from "../core/paths.js";
import { nullLogger } from "../core/logger.js";
import { loadOrCreateToken } from "../core/token.js";
import { assertUnlinked, atomicPluginWrite, liveRuntimeSessions, publishPlugin, selectRuntime, type PluginClient } from "../core/plugin-runtime.js";

export function compareReleases(a: string, b: string): number {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const difference = left[i]! - right[i]!; if (difference) return difference; }
  return 0;
}

/** Install directly into Codex's documented cache, avoiding its destructive reinstall/pruning commands. */
export function updateCodex(source: string, home = process.env.CODEX_HOME || join(homedir(), ".codex"), version = APP_VERSION): string {
  const base = join(home, "plugins", "cache", "agent-bridge", "agent-bridge");
  assertUnlinked(base);
  for (const entry of existsSync(base) ? readdirSync(base, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "local" || !/^\d+\.\d+\.\d+$/.test(entry.name)) throw new Error(`Codex cache uses an unsupported version selector (${entry.name}); preserved unchanged.`);
    if (compareReleases(entry.name, version) > 0) throw new Error(`Codex already has a newer version (${entry.name}); preserved unchanged.`);
  }
  const configPath = join(home, "config.toml"); assertUnlinked(configPath);
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const marketplace = join(home, "agent-bridge-marketplace");
  const nextConfig = codexLiveConfig(config, marketplace);
  const root = publishPlugin(source, base, version);
  // Pin the configured marketplace to the same immutable release. Native refresh then sees
  // the already active version instead of reinstalling a stale Git marketplace snapshot.
  publishPlugin(source, join(marketplace, "plugins"), version);
  atomicPluginWrite(join(marketplace, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "agent-bridge", plugins: [{ name: "agent-bridge", source: { source: "local", path: `./plugins/${version}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }],
  }, null, 2) + "\n");
  atomicPluginWrite(configPath, nextConfig);
  return root;
}

/** Narrow TOML edits; keep all unrelated tables, comments, credentials and plugin preferences. */
export function codexLiveConfig(config: string, marketplace: string): string {
  const header = /^\s*\[marketplaces\.(?:agent-bridge|"agent-bridge"|'agent-bridge')\]\s*(?:#.*)?$/gm;
  const matches = [...config.matchAll(header)];
  if (matches.length > 1) throw new Error("Duplicate agent-bridge marketplace tables; preserved unchanged");
  const fields = `source_type = "local"\nsource = ${JSON.stringify(marketplace.replaceAll("\\", "/"))}\n`;
  if (matches.length) {
    const match = matches[0]!, start = match.index! + match[0].length;
    const tail = config.slice(start), end = /^\s*\[/m.exec(tail)?.index ?? tail.length;
    const body = tail.slice(0, end).replace(/^\s*(?:source_type|source)\s*=.*(?:\r?\n|$)/gm, "");
    config = config.slice(0, start) + "\n" + fields + body + tail.slice(end);
  } else config += `\n[marketplaces.agent-bridge]\n${fields}`;
  if (!/^\s*\[plugins\.(?:"agent-bridge@agent-bridge"|'agent-bridge@agent-bridge')\]/m.test(config)) config += '\n[plugins."agent-bridge@agent-bridge"]\nenabled = true\n';
  return config;
}

/** Native v2 metadata is kept intact, with every scope and unrelated plugin preserved. */
export function updateClaude(source: string, home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), version = APP_VERSION): string {
  const metadata = join(home, "plugins", "installed_plugins.json");
  assertUnlinked(metadata);
  const installed = JSON.parse(readFileSync(metadata, "utf8"));
  const entries = installed?.plugins?.["agent-bridge@agent-bridge"];
  if (installed.version !== 2 || !Array.isArray(entries) || entries.length === 0 || entries.some((e: any) => !e || typeof e.installPath !== "string" || typeof e.scope !== "string")) throw new Error("Unsupported or missing installed plugin metadata; preserved unchanged. Install the plugin first.");
  if (entries.some((entry: any) => typeof entry.version === "string" && /^\d+\.\d+\.\d+$/.test(entry.version) && compareReleases(entry.version, version) > 0)) throw new Error("Claude already has a newer version; preserved unchanged");
  const root = publishPlugin(source, join(home, "plugins", "cache", "agent-bridge", "agent-bridge"), version);
  installed.plugins["agent-bridge@agent-bridge"] = entries.map((entry: any) => {
    const next = { ...entry, installPath: root, version, lastUpdated: new Date().toISOString() };
    // The previous revision is in the backup; do not claim its Git hash describes this package.
    delete next.gitCommitSha;
    return next;
  });
  atomicPluginWrite(metadata, JSON.stringify(installed, null, 2) + "\n");
  return root;
}

export function activatePluginRuntime(source: string, client: PluginClient, bridgeHome: string, version = APP_VERSION): string {
  return selectRuntime(bridgeHome, client, source, version);
}

export function reportPluginSessions(home: string, client: PluginClient, version: string, out: (s: string) => void): void {
  const sessions = liveRuntimeSessions(home, client);
  out(`  New MCP server starts select v${version}; existing sessions keep working. No sessions were stopped or switched mid-session.`);
  for (const s of sessions) out(`    pid ${s.pid}: v${s.version}${s.version === version ? " (current)" : " (retained old code)"}, started ${s.startedAt}`);
  out(`  ${sessions.filter((s) => s.version === version).length} recorded live launch(es) on the selected version; ${sessions.filter((s) => s.version !== version).length} on retained versions. Legacy launches are not recorded.`);
}

/** Read the existing broker only: never elect, disconnect peers, restart jobs or change identities. */
export async function reportConnectedVersions(home: string, clients: readonly string[], version: string, out: (s: string) => void): Promise<void> {
  let client: BridgeClient | null = null;
  try {
    client = await BridgeClient.connect(resolvePipePath(home, process.env), nullLogger);
    await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(home) });
    const peers = (await client.request("peers", {})).filter((peer) => clients.includes(peer.agent));
    for (const peer of peers) out(`  ${peer.name}: v${peer.version ?? "unknown"}${peer.version === version ? " (current)" : " (retained old code)"}`);
    out(`  Connected sessions: ${peers.filter((peer) => peer.version === version).length} current, ${peers.filter((peer) => peer.version !== version).length} older or unknown. Switched mid-session: 0.`);
  } catch {
    out("  Connected-session version report unavailable; no sessions were restarted. Use agent-bridge status later.");
  } finally { client?.close(); }
}
