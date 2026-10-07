import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_HOME, ENV } from "../core/constants.js";
import { recordRuntimeSession, selectedWorker, type PluginClient } from "../core/plugin-runtime.js";

const clientArg = process.argv.find((arg) => arg.startsWith("--agent="))?.slice(8) ?? process.env[ENV.agent] ?? "codex";
const client: PluginClient = ["claude", "codex", "opencode", "antigravity"].includes(clientArg) ? clientArg as PluginClient : "codex";
const home = process.env[ENV.home]?.trim() || DEFAULT_HOME;
const runtimeHome = process.env.AGENT_BRIDGE_PLUGIN_RUNTIME_HOME?.trim() || home;
const selected = selectedWorker(runtimeHome, client, join(dirname(fileURLToPath(import.meta.url)), "worker.mjs"));
// CWD discovery must still recognize the host's original plugin root after selecting another snapshot.
process.env.AGENT_BRIDGE_LAUNCH_PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
try { recordRuntimeSession(home, { pid: process.pid, client, version: selected.version, worker: selected.worker, startedAt: new Date().toISOString() }); }
catch (error) { process.stderr.write(`agent-bridge: session version reporting unavailable: ${String(error)}\n`); }
// Import once. Keep the same stdio transport, identity, coordinator and broker for the whole session.
await import(pathToFileURL(selected.worker).href);
