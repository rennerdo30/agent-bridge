import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  recordRuntimeSession,
  selectedWorker
} from "./chunks/chunk-ENZISWMO.mjs";
import {
  DEFAULT_HOME,
  ENV
} from "./chunks/chunk-Q372BWBW.mjs";
import "./chunks/chunk-HHAVWD7J.mjs";

// src/mcp/launcher.ts
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var clientArg = process.argv.find((arg) => arg.startsWith("--agent="))?.slice(8) ?? process.env[ENV.agent] ?? "codex";
var client = ["claude", "codex", "opencode", "antigravity"].includes(clientArg) ? clientArg : "codex";
var home = process.env[ENV.home]?.trim() || DEFAULT_HOME;
var runtimeHome = process.env.AGENT_BRIDGE_PLUGIN_RUNTIME_HOME?.trim() || home;
var selected = selectedWorker(runtimeHome, client, join(dirname(fileURLToPath(import.meta.url)), "worker.mjs"));
process.env.AGENT_BRIDGE_LAUNCH_PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  recordRuntimeSession(home, { pid: process.pid, client, version: selected.version, worker: selected.worker, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
} catch (error) {
  process.stderr.write(`agent-bridge: session version reporting unavailable: ${String(error)}
`);
}
await import(pathToFileURL(selected.worker).href);
