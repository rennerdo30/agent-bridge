import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/mcp/launcher.ts
import { dirname as dirname2, join as join3 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// src/core/constants.ts
import { homedir } from "node:os";
import { join } from "node:path";
var APP_NAME = "agent-bridge";
var APP_VERSION = "0.30.2";
var PROTOCOL_VERSION = 2;
var ENV = {
  internal: "AGENT_BRIDGE_INTERNAL",
  home: "AGENT_BRIDGE_HOME",
  pipe: "AGENT_BRIDGE_PIPE",
  name: "AGENT_BRIDGE_NAME",
  agent: "AGENT_BRIDGE_AGENT",
  logLevel: "AGENT_BRIDGE_LOG_LEVEL",
  logConsole: "AGENT_BRIDGE_LOG_CONSOLE",
  autoWake: "AGENT_BRIDGE_AUTO_WAKE",
  wakeOnDirect: "AGENT_BRIDGE_WAKE_ON_DIRECT",
  maxHops: "AGENT_BRIDGE_MAX_HOPS",
  maxJobs: "AGENT_BRIDGE_MAX_JOBS",
  maxDelegateDepth: "AGENT_BRIDGE_MAX_DELEGATE_DEPTH",
  autoApproveTools: "AGENT_BRIDGE_AUTO_APPROVE_TOOLS",
  lingerSec: "AGENT_BRIDGE_LINGER_SEC",
  delivery: "AGENT_BRIDGE_DELIVERY",
  claudeBin: "AGENT_BRIDGE_CLAUDE_BIN",
  codexBin: "AGENT_BRIDGE_CODEX_BIN",
  opencodeBin: "AGENT_BRIDGE_OPENCODE_BIN",
  dashboard: "AGENT_BRIDGE_DASHBOARD",
  /** "0": background subagents run inside the session's MCP server instead of detached job runners (they then end with it). */
  jobRunner: "AGENT_BRIDGE_JOB_RUNNER"
};
var DEFAULT_HOME = join(homedir(), `.${APP_NAME}`);
var LOG_FILE_NAME = `${APP_NAME}.log`;
var MAX_FRAME_BYTES = 4 * 1024 * 1024;
var MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var PURGE_INTERVAL_MS = 60 * 60 * 1e3;
var QUEUED_MAIL_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var MAX_JOB_TIMEOUT_SEC = 24 * 60 * 60;

// src/core/plugin-runtime.ts
import { randomUUID, createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join as join2, resolve } from "node:path";
var RUNTIME_SCHEMA = 1;
var runtimeRoot = (home2, client2) => join2(home2, "plugin-versions", client2);
function assertUnlinked(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Plugin links are not supported: ${current}`);
    if (dirname(current) === current) break;
  }
}
function releaseVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Expected a patch release version, got ${version}`);
}
function atomicPluginWrite(path, text) {
  assertUnlinked(path);
  mkdirSync(dirname(path), { recursive: true });
  const previous = existsSync(path) ? readFileSync(path) : null;
  const content = Buffer.from(text);
  if (previous?.equals(content)) return;
  const tmp = `${path}.${randomUUID()}.tmp`, backup = `${path}.backup-${Date.now()}-${randomUUID()}`;
  assertUnlinked(tmp);
  assertUnlinked(backup);
  if (previous) copyFileSync(path, backup);
  writeFileSync(tmp, content, { flag: "wx", mode: 384 });
  const current = existsSync(path) ? readFileSync(path) : null;
  if (previous === null !== (current === null) || previous && !previous.equals(current)) throw new Error(`Plugin metadata changed concurrently; preserved both copies: ${path}`);
  renameSync(tmp, path);
}
function selectedWorker(home2, client2, fallback) {
  const base = runtimeRoot(home2, client2), path = join2(base, "active.json");
  try {
    assertUnlinked(path);
    const active = JSON.parse(readFileSync(path, "utf8"));
    releaseVersion(active.version);
    if (active.schemaVersion !== RUNTIME_SCHEMA || active.protocol !== PROTOCOL_VERSION) throw new Error("Incompatible runtime selector");
    const worker = join2(base, active.version, "dist", "worker.mjs");
    assertUnlinked(worker);
    if (!existsSync(worker)) throw new Error("Missing selected worker");
    return { worker, version: active.version };
  } catch {
    return { worker: fallback, version: APP_VERSION };
  }
}
function recordRuntimeSession(home2, session) {
  atomicPluginWrite(join2(home2, "plugin-sessions", `${session.pid}.json`), JSON.stringify({ schemaVersion: RUNTIME_SCHEMA, ...session }) + "\n");
}

// src/mcp/launcher.ts
var clientArg = process.argv.find((arg) => arg.startsWith("--agent="))?.slice(8) ?? process.env[ENV.agent] ?? "codex";
var client = ["claude", "codex", "opencode", "antigravity"].includes(clientArg) ? clientArg : "codex";
var home = process.env[ENV.home]?.trim() || DEFAULT_HOME;
var runtimeHome = process.env.AGENT_BRIDGE_PLUGIN_RUNTIME_HOME?.trim() || home;
var selected = selectedWorker(runtimeHome, client, join3(dirname2(fileURLToPath(import.meta.url)), "worker.mjs"));
process.env.AGENT_BRIDGE_LAUNCH_PLUGIN_ROOT = join3(dirname2(fileURLToPath(import.meta.url)), "..");
try {
  recordRuntimeSession(home, { pid: process.pid, client, version: selected.version, worker: selected.worker, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
} catch (error) {
  process.stderr.write(`agent-bridge: session version reporting unavailable: ${String(error)}
`);
}
await import(pathToFileURL(selected.worker).href);
