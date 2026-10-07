import { existsSync, readFileSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, parse, sep } from "node:path";
import { archiveFile } from "../core/json-store.js";
import { pluginSourceDir, type InstallResult } from "./opencode-install.js";
import { antigravityHookCommand, antigravityPluginDir, antigravityRuntimeHome } from "../core/antigravity-plugin.js";
import { atomicPluginWrite, pluginFiles, releaseVersion, selectRuntime } from "../core/plugin-runtime.js";
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

function metadata(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid native metadata; preserved unchanged: ${path}`);
  return value;
}
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));

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
  atomicPluginWrite(settings, JSON.stringify(config, null, 2) + "\n");
}

/** Manual global plugin installation is an official agy interface. Never replace foreign files. */
export function installAntigravity(source: string, target = antigravityPluginDir()): InstallResult {
  source = resolve(source); target = resolve(target);
  unlinked(source); unlinked(target);
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return !path || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
  };
  if (contains(source, target) || contains(target, source)) throw new Error("Plugin source and installation must be separate directories");
  const runtimeHome = antigravityRuntimeHome(target);
  if (contains(source, runtimeHome) || contains(runtimeHome, source)) throw new Error("Plugin source and runtime must be separate directories");
  unlinked(runtimeHome);
  unlinked(join(target, MARKER));
  if (existsSync(target) && (!existsSync(join(target, MARKER)) || readFileSync(join(target, MARKER), "utf8").trim() !== "agent-bridge")) throw new Error(`Refusing to replace an unowned Antigravity plugin: ${target}`);
  if (JSON.parse(readFileSync(join(source, "plugin.json"), "utf8")).name !== "agent-bridge") throw new Error("Invalid Antigravity plugin source");
  const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
  releaseVersion(version);
  for (const file of ["server.mjs", "worker.mjs", "cli.mjs", "history-worker.mjs"]) {
    if (!existsSync(join(source, "dist", file))) throw new Error(`Missing Antigravity runtime: ${file}`);
  }
  const result: InstallResult = { configDir: target, files: [], skipped: [] };
  const files = pluginFiles(source).filter((file) => !file.replaceAll("\\", "/").startsWith("dist/") && !["hooks.json", "mcp_config.json"].includes(file));
  // Validate every destination before the first write, including backup folders and the ownership marker.
  for (const file of files) unlinked(join(target, file));
  for (const name of ["mcp_config.json", "hooks.json", "archive"]) unlinked(join(target, name));
  const previousConfig = metadata(join(target, "mcp_config.json")), previousHooks = metadata(join(target, "hooks.json"));
  if ((previousConfig.mcpServers !== undefined && !record(previousConfig.mcpServers)) || (previousHooks["agent-bridge"] !== undefined && !record(previousHooks["agent-bridge"]))) throw new Error("Invalid native plugin settings; preserved unchanged");
  const previousServer = previousConfig.mcpServers?.["agent-bridge"] ?? {};
  if (!record(previousServer) || (previousServer.env !== undefined && !record(previousServer.env))) throw new Error("Invalid native MCP settings; preserved unchanged");
  const runtime = selectRuntime(runtimeHome, "antigravity", source, version);
  result.files.push(runtime);
  const write = (file: string, text: string | Uint8Array) => { const path = join(target, file); atomicPluginWrite(path, text); result.files.push(path); };
  for (const file of files) write(file, readFileSync(join(source, file)));
  write(MARKER, "agent-bridge\n");
  const config = { ...previousConfig, mcpServers: { ...previousConfig.mcpServers, "agent-bridge": { ...previousServer, command: process.execPath, args: [join(runtime, "dist", "server.mjs"), "--agent=antigravity"], env: { ...previousServer.env, AGENT_BRIDGE_PLUGIN_RUNTIME_HOME: runtimeHome } } } };
  const command = (event: string) => antigravityHookCommand(join(runtime, "dist", "cli.mjs"), event);
  write("hooks.json", JSON.stringify({ ...previousHooks, "agent-bridge": {
    ...previousHooks["agent-bridge"],
    PreInvocation: [{ type: "command", command: command("PreInvocation"), timeout: 30 }],
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: command("PreToolUse"), timeout: 600 }] }],
    Stop: [{ type: "command", command: command("Stop"), timeout: 30 }],
  } }, null, 2) + "\n");
  write("mcp_config.json", JSON.stringify(config, null, 2) + "\n");
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
