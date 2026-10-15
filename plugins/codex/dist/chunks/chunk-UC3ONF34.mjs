import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  isHandoffToolCall
} from "./chunk-HFRXC4WN.mjs";
import {
  ANTIGRAVITY_ACCESS_ENV,
  ANTIGRAVITY_EDIT_RELAY_ENV,
  RELAY_TOKEN_ENV,
  RELAY_URL_ENV,
  askRelay,
  boundedDetail
} from "./chunk-ZXQMF3A5.mjs";
import {
  resolveHome
} from "./chunk-ZT3W4XMU.mjs";
import {
  createLogger
} from "./chunk-JJ6UMMYX.mjs";
import {
  antigravityAncestor
} from "./chunk-VNQ4UNAO.mjs";
import {
  object
} from "./chunk-NVDPULGI.mjs";

// src/cli/antigravity-hook.ts
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
var OWN_SERVERS = ["agent-bridge", "agent-bridge_agent-bridge"];
var WRITE_TOOLS = ["write_to_file", "replace_file_content", "multi_replace_file_content", "notebook_edit"];
var READ_ONLY_TOOLS = /* @__PURE__ */ new Set(["view_file", "grep_search", "find_by_name", "list_dir", "read_url_content", "search_web", "command_status", "list_resources", "read_resource", "finish", "wait", "wait_5_seconds"]);
function allowed(input, decision = "allow") {
  const call = object(input.toolCall), args = object(call.args), resources = [];
  const server = args.ServerName ?? args.server_name ?? args.serverName;
  const tool = args.ToolName ?? args.tool_name ?? args.toolName;
  if (call.name === "call_mcp_tool" && typeof server === "string" && typeof tool === "string") resources.push(`mcp(${server}/${tool})`);
  if (call.name === "run_command" && typeof args.CommandLine === "string") resources.push(`command(${args.CommandLine})`);
  const path = args.TargetFile ?? args.AbsolutePath ?? args.FilePath;
  if (typeof path === "string") {
    const writes = WRITE_TOOLS.includes(call.name);
    resources.push(`${writes ? "write_file" : "read_file"}(${path})`);
  }
  if (call.name === "read_url_content" && typeof args.Url === "string") {
    try {
      resources.push(`read_url(${new URL(args.Url).hostname})`);
    } catch {
    }
  }
  return { decision, ...resources.length ? { permissionOverrides: resources } : {} };
}
function hasGitSegment(path) {
  return path.split(/[\\/]+/).some((part) => part.toLowerCase() === ".git");
}
function canonicalTargetPath(targetPath) {
  const lexical = resolve(targetPath);
  if (hasGitSegment(lexical)) return null;
  let cur = lexical;
  const tail = [];
  while (true) {
    try {
      lstatSync(cur);
    } catch (err) {
      if (err?.code !== "ENOENT") return null;
      const parent = dirname(cur);
      if (parent === cur) return null;
      tail.unshift(basename(cur));
      cur = parent;
      continue;
    }
    try {
      const realCur = realpathSync.native(cur);
      const canonical = tail.length ? join(realCur, ...tail) : realCur;
      return hasGitSegment(canonical) ? null : canonical;
    } catch {
      return null;
    }
  }
}
function insideWorkspace(targetPath, workspacePaths) {
  if (typeof targetPath !== "string" || !isAbsolute(targetPath) || !Array.isArray(workspacePaths)) return false;
  const canonicalTarget = canonicalTargetPath(targetPath);
  if (!canonicalTarget) return false;
  return workspacePaths.some((root) => {
    if (typeof root !== "string" || !isAbsolute(root)) return false;
    try {
      const canonicalRoot = realpathSync.native(root);
      const rel = relative(canonicalRoot, canonicalTarget);
      return Boolean(!rel || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    } catch {
      return false;
    }
  });
}
function hasAntigravityEditRelay(env = process.env) {
  return env[ANTIGRAVITY_EDIT_RELAY_ENV] === "1" && Boolean(env[RELAY_URL_ENV]?.trim()) && Boolean(env[RELAY_TOKEN_ENV]?.trim());
}
function antigravityReadingTool(input) {
  const call = object(input.toolCall), args = object(call.args);
  if (READ_ONLY_TOOLS.has(call.name)) return true;
  if (call.name !== "call_mcp_tool") return false;
  const server = args.ServerName ?? args.server_name ?? args.serverName;
  const tool = args.ToolName ?? args.tool_name ?? args.toolName;
  return OWN_SERVERS.includes(server) && typeof tool === "string" && tool.length > 0;
}
async function antigravityPermission(input, access = process.env[ANTIGRAVITY_ACCESS_ENV], relay = hasAntigravityEditRelay()) {
  const call = object(input.toolCall), args = object(call.args);
  const server = args.ServerName ?? args.server_name ?? args.serverName;
  const tool = args.ToolName ?? args.tool_name ?? args.toolName;
  const request = { agent: "antigravity", tool: call.name === "call_mcp_tool" ? `mcp:${server ?? "unknown"}` : String(call.name ?? "unknown"), ...boundedDetail((call.name === "call_mcp_tool" ? `${tool ?? "unknown"}: ` : "") + JSON.stringify(args)), cwd: Array.isArray(input.workspacePaths) ? input.workspacePaths[0] : void 0 };
  if (access && isHandoffToolCall(request)) return { decision: "deny", reason: "Delegated jobs report to their supervisor; handoff writes are declined" };
  if ((!access || access === "edit") && call.name === "call_mcp_tool" && OWN_SERVERS.includes(server)) return allowed(input);
  if (!access) return { decision: "allow" };
  if (access === "edit") {
    if (!relay) return { decision: "allow" };
    if (READ_ONLY_TOOLS.has(call.name)) return { decision: "allow" };
    const path = args.TargetFile ?? args.AbsolutePath ?? args.FilePath ?? args.DirectoryPath ?? args.SearchDirectory ?? args.SearchPath;
    if (WRITE_TOOLS.includes(call.name) && insideWorkspace(path, input.workspacePaths)) return { decision: "allow" };
    const decision2 = await askRelay(request);
    return decision2.allow ? allowed(input, "auto_approve") : { decision: "deny", reason: decision2.message };
  }
  if (antigravityReadingTool(input)) return allowed(input);
  if (access !== "ask") return { decision: "deny", reason: "agent-bridge read access forbids this tool" };
  const decision = await askRelay(request);
  return decision.allow ? allowed(input) : { decision: "deny", reason: decision.message };
}
function antigravityHookOutput(event, text) {
  if (!text) return {};
  return event === "Stop" ? { decision: "continue", reason: text } : { injectSteps: [{ ephemeralMessage: text }] };
}
async function postAntigravityHook(event, input, timeoutMs = 2e4, home = resolveHome()) {
  const signal = AbortSignal.timeout(timeoutMs);
  const pid = await antigravityAncestor(process.ppid, signal);
  if (!pid || signal.aborted) return {};
  const reg = JSON.parse(readFileSync(join(home, "antigravity-hooks", `${pid}.json`), "utf8"));
  if (!Number.isInteger(reg.port) || typeof reg.secret !== "string") throw new Error("invalid hook registration");
  const res = await fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}`, "content-type": "application/json" }, body: JSON.stringify({ event, input }), signal });
  if (!res.ok) throw new Error("hook endpoint unavailable");
  return object(await res.json());
}
async function runAntigravityHook(event) {
  try {
    let raw = "";
    for await (const part of process.stdin) {
      raw += part;
      if (raw.length > 256 * 1024) throw new Error("hook input too large");
    }
    const input = object(JSON.parse(raw || "{}"));
    if (event === "PreToolUse") {
      const decision = await antigravityPermission(input), call = object(input.toolCall), args = object(call.args);
      if (!process.env[ANTIGRAVITY_ACCESS_ENV] && (typeof input.conversationId === "string" || Array.isArray(input.workspacePaths))) {
        await postAntigravityHook("PreToolUse", input, 1500).catch(() => {
        });
      }
      try {
        createLogger({ home: resolveHome(), component: "antigravity-hook", consoleLevel: "silent" }).debug("native tool gate", { tool: call.name, server: args.ServerName, mcpTool: args.ToolName, inputKeys: Object.keys(input), access: process.env[ANTIGRAVITY_ACCESS_ENV], decision: decision.decision, overrides: decision.permissionOverrides });
      } catch {
      }
      process.stdout.write(JSON.stringify(decision));
      return 0;
    }
    process.stdout.write(JSON.stringify(await postAntigravityHook(event, input)));
  } catch {
    process.stdout.write(JSON.stringify(event === "PreToolUse" ? process.env[ANTIGRAVITY_ACCESS_ENV] ? { decision: "deny", reason: "agent-bridge permission hook unavailable" } : { decision: "allow" } : {}));
  }
  return 0;
}

export {
  hasAntigravityEditRelay,
  antigravityReadingTool,
  antigravityPermission,
  antigravityHookOutput,
  postAntigravityHook,
  runAntigravityHook
};
