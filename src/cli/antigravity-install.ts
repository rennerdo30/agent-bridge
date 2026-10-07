import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";
import { archiveFile } from "../core/json-store.js";
import { pluginSourceDir, type InstallResult } from "./opencode-install.js";
import { antigravityHookCommand, antigravityPluginDir } from "../core/antigravity-plugin.js";
import { homedir } from "node:os";
export { antigravityPluginDir } from "../core/antigravity-plugin.js";

const MARKER = ".agent-bridge-owned";
function unlinked(path: string): void {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Plugin links are not supported: ${current}`);
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
}
export const antigravitySourceDir = (from?: string) => pluginSourceDir("antigravity", "plugin.json", from);

/** Add only this plugin's MCP grant in the CLI's existing native settings format. */
export function grantAntigravityBridgeMcp(settings = join(homedir(), ".gemini", "antigravity-cli", "settings.json")): void {
  unlinked(settings); unlinked(join(dirname(settings), "archive"));
  const config = existsSync(settings) ? JSON.parse(readFileSync(settings, "utf8")) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid native Antigravity settings; preserved unchanged");
  const permissions = config.permissions ?? {};
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions) || (permissions.allow !== undefined && !Array.isArray(permissions.allow))) throw new Error("Invalid native Antigravity permissions; preserved unchanged");
  const rule = "mcp(agent-bridge_agent-bridge/*)";
  if (permissions.allow?.includes(rule)) return;
  config.permissions = { ...permissions, allow: [...(permissions.allow ?? []), rule] };
  mkdirSync(dirname(settings), { recursive: true });
  if (existsSync(settings)) archiveFile(settings);
  writeFileSync(settings, JSON.stringify(config, null, 2) + "\n");
}

/** Manual global plugin installation is an official agy interface. Never replace foreign files. */
export function installAntigravity(source: string, target = antigravityPluginDir()): InstallResult {
  source = resolve(source); target = resolve(target);
  unlinked(source); unlinked(target);
  unlinked(join(target, MARKER));
  if (existsSync(target) && (!existsSync(join(target, MARKER)) || readFileSync(join(target, MARKER), "utf8").trim() !== "agent-bridge")) throw new Error(`Refusing to replace an unowned Antigravity plugin: ${target}`);
  if (JSON.parse(readFileSync(join(source, "plugin.json"), "utf8")).name !== "agent-bridge") throw new Error("Invalid Antigravity plugin source");
  const result: InstallResult = { configDir: target, files: [], skipped: [] };
  const files: Array<[string, string]> = [];
  const copy = (from: string, to: string) => {
    unlinked(to);
    if (lstatSync(from).isSymbolicLink()) throw new Error(`Plugin source links are not supported: ${from}`);
    mkdirSync(dirname(to), { recursive: true });
    if (existsSync(to)) archiveFile(to);
    copyFileSync(from, to); result.files.push(to);
  };
  const walk = (dir: string, relative = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Plugin source links are not supported");
      const rel = join(relative, entry.name);
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile()) files.push([join(dir, entry.name), join(target, rel)]);
    }
  };
  walk(source);
  // Validate every destination before the first write, including backup folders and the ownership marker.
  for (const [, to] of files) { unlinked(to); unlinked(join(dirname(to), "archive")); }
  for (const name of ["mcp_config.json", "hooks.json", "archive"]) unlinked(join(target, name));
  for (const [from, to] of files) copy(from, to);
  writeFileSync(join(target, MARKER), "agent-bridge\n");
  const config = { mcpServers: { "agent-bridge": { command: process.execPath, args: [join(target, "dist", "server.mjs"), "--agent=antigravity"] } } };
  for (const name of ["mcp_config.json", "hooks.json"]) { unlinked(join(target, name)); if (existsSync(join(target, name))) archiveFile(join(target, name)); }
  writeFileSync(join(target, "mcp_config.json"), JSON.stringify(config, null, 2) + "\n");
  const command = (event: string) => antigravityHookCommand(join(target, "dist", "cli.mjs"), event);
  writeFileSync(join(target, "hooks.json"), JSON.stringify({ "agent-bridge": {
    PreInvocation: [{ type: "command", command: command("PreInvocation"), timeout: 30 }],
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: command("PreToolUse"), timeout: 600 }] }],
    Stop: [{ type: "command", command: command("Stop"), timeout: 30 }],
  } }, null, 2) + "\n");
  if (target === antigravityPluginDir()) grantAntigravityBridgeMcp();
  return result;
}

/** Uninstall archives the entire owned plugin, including any user additions. */
export function uninstallAntigravity(target = antigravityPluginDir()): InstallResult {
  unlinked(target);
  unlinked(join(target, MARKER)); unlinked(join(dirname(target), "archive"));
  const result: InstallResult = { configDir: target, files: [], skipped: [] };
  if (!existsSync(target)) return result;
  if (lstatSync(target).isSymbolicLink() || !existsSync(join(target, MARKER)) || readFileSync(join(target, MARKER), "utf8").trim() !== "agent-bridge") result.skipped.push(target);
  else { archiveFile(target); result.files.push(target); }
  return result;
}
