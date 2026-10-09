import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  isHandoffToolCall
} from "./chunk-HFRXC4WN.mjs";
import {
  ANTIGRAVITY_ACCESS_ENV,
  askRelay,
  boundedDetail
} from "./chunk-7KRAJNI6.mjs";
import {
  resolveHome
} from "./chunk-35H7HOLN.mjs";
import {
  object
} from "./chunk-TFQZM67X.mjs";
import {
  createLogger
} from "./chunk-OHCADHNH.mjs";

// src/cli/antigravity-hook.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

// src/core/procinfo.ts
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
var LOOKUP_TIMEOUT_MS = 5e3;
var MAX_ANCESTORS = 4;
function exec(file, args) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: LOOKUP_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => err ? reject(err) : resolve(stdout)
    );
  });
}
async function lookup(pid) {
  try {
    if (process.platform === "linux") {
      const [cmd, stat] = await Promise.all([readFile(`/proc/${pid}/cmdline`, "utf8"), readFile(`/proc/${pid}/stat`, "utf8")]);
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      return { pid, ppid, cmdline: cmd.split("\0").join(" ") };
    }
    if (process.platform === "win32") {
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "$($p.ParentProcessId)"; $p.CommandLine }`;
      const out2 = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
      const [ppidLine, ...rest] = out2.split(/\r?\n/);
      if (!ppidLine?.trim()) return null;
      return { pid, ppid: Number(ppidLine.trim()), cmdline: rest.join(" ").trim() };
    }
    const out = await exec("ps", ["-o", "ppid=,args=", "-p", String(pid)]);
    const m = /^\s*(\d+)\s+(.*)$/s.exec(out.trim());
    return m ? { pid, ppid: Number(m[1]), cmdline: m[2].trim() } : null;
  } catch {
    return null;
  }
}
var CHANNEL_FLAGS = ["--channels", "--dangerously-load-development-channels"];
async function antigravityAncestor(start = process.ppid) {
  let pid = start;
  for (let i = 0; i < 6 && pid > 1; i++) {
    const info = await lookup(pid);
    if (!info) return null;
    if (/^(?:"[^"\r\n]*[\\/]|[^\s"\r\n]*[\\/])?agy(?:\.exe)?(?:"|\s|$)/i.test(info.cmdline)) return pid;
    pid = info.ppid;
  }
  return null;
}
function cmdlineEnablesChannel(cmdline, pluginName) {
  const tokens = cmdline.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
  const values = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const eq = CHANNEL_FLAGS.find((f) => tok.startsWith(`${f}=`));
    if (eq) {
      values.push(tok.slice(eq.length + 1));
    } else if (CHANNEL_FLAGS.includes(tok)) {
      for (let j = i + 1; j < tokens.length && !tokens[j].startsWith("-"); j++) values.push(tokens[j]);
    }
  }
  return values.some((v) => v.split(",").some((entry) => entry.includes(pluginName)));
}
function cmdlineIsPrintMode(cmdline) {
  return cmdline.split(/\s+/).some((t) => /^["']?(-p|--print)(=.*)?["']?$/.test(t));
}
function cmdlineIsClaude(cmdline) {
  const tokens = cmdline.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^["']|["']$/g, "")) ?? [];
  const executable = tokens[0]?.replace(/\\/g, "/").split("/").at(-1) ?? "";
  if (/^claude(?:\.exe|\.cmd)?$/i.test(executable)) return true;
  if (!/^node(?:\.exe)?$/i.test(executable)) return false;
  return /(?:^|\/)node_modules\/@anthropic-ai\/claude-code\/cli\.js$/i.test((tokens[1] ?? "").replace(/\\/g, "/"));
}
async function inspectClaudeLaunch(pluginName, log) {
  let pid = process.ppid;
  let channel = false;
  for (let i = 0; i < MAX_ANCESTORS && pid > 1; i++) {
    const info = await lookup(pid);
    if (!info) break;
    log.debug("inspected ancestor process", { pid, cmdline: info.cmdline.slice(0, 300) });
    if (cmdlineEnablesChannel(info.cmdline, pluginName)) channel = true;
    if (cmdlineIsClaude(info.cmdline)) {
      const print = cmdlineIsPrintMode(info.cmdline);
      return { channel, print, interactive: !print };
    }
    pid = info.ppid;
  }
  return { channel, print: false, interactive: false };
}

// src/cli/antigravity-hook.ts
var OWN_SERVERS = ["agent-bridge", "agent-bridge_agent-bridge"];
function allowed(input) {
  const call = object(input.toolCall), args = object(call.args), resources = [];
  const server = args.ServerName ?? args.server_name ?? args.serverName;
  const tool = args.ToolName ?? args.tool_name ?? args.toolName;
  if (call.name === "call_mcp_tool" && typeof server === "string" && typeof tool === "string") resources.push(`mcp(${server}/${tool})`);
  if (call.name === "run_command" && typeof args.CommandLine === "string") resources.push(`command(${args.CommandLine})`);
  const path = args.TargetFile ?? args.AbsolutePath ?? args.FilePath;
  if (typeof path === "string") {
    const writes = ["write_to_file", "replace_file_content", "multi_replace_file_content", "notebook_edit"].includes(call.name);
    resources.push(`${writes ? "write_file" : "read_file"}(${path})`);
  }
  if (call.name === "read_url_content" && typeof args.Url === "string") {
    try {
      resources.push(`read_url(${new URL(args.Url).hostname})`);
    } catch {
    }
  }
  return { decision: "allow", ...resources.length ? { permissionOverrides: resources } : {} };
}
function antigravityReadingTool(input) {
  const call = object(input.toolCall), args = object(call.args);
  if (["view_file", "grep_search", "find_by_name", "list_dir", "read_url_content", "search_web", "command_status", "list_resources", "read_resource", "finish", "wait", "wait_5_seconds"].includes(call.name)) return true;
  if (call.name !== "call_mcp_tool") return false;
  const server = args.ServerName ?? args.server_name ?? args.serverName;
  const tool = args.ToolName ?? args.tool_name ?? args.toolName;
  return OWN_SERVERS.includes(server) && typeof tool === "string" && tool.length > 0;
}
async function antigravityPermission(input, access = process.env[ANTIGRAVITY_ACCESS_ENV]) {
  const call = object(input.toolCall), args = object(call.args);
  const server = args.ServerName ?? args.server_name ?? args.serverName;
  const tool = args.ToolName ?? args.tool_name ?? args.toolName;
  const request = { agent: "antigravity", tool: call.name === "call_mcp_tool" ? `mcp:${server ?? "unknown"}` : String(call.name ?? "unknown"), ...boundedDetail((call.name === "call_mcp_tool" ? `${tool ?? "unknown"}: ` : "") + JSON.stringify(args)), cwd: Array.isArray(input.workspacePaths) ? input.workspacePaths[0] : void 0 };
  if (access && isHandoffToolCall(request)) return { decision: "deny", reason: "Delegated jobs report to their supervisor; handoff writes are declined" };
  if ((!access || access === "edit") && call.name === "call_mcp_tool" && OWN_SERVERS.includes(server)) return allowed(input);
  if (!access || access === "edit") return {};
  if (antigravityReadingTool(input)) return allowed(input);
  if (access !== "ask") return { decision: "deny", reason: "agent-bridge read access forbids this tool" };
  const decision = await askRelay(request);
  return decision.allow ? allowed(input) : { decision: "deny", reason: decision.message };
}
function antigravityHookOutput(event, text) {
  if (!text) return {};
  return event === "Stop" ? { decision: "continue", reason: text } : { injectSteps: [{ ephemeralMessage: text }] };
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
      try {
        createLogger({ home: resolveHome(), component: "antigravity-hook", consoleLevel: "silent" }).debug("native tool gate", { tool: call.name, server: args.ServerName, mcpTool: args.ToolName, inputKeys: Object.keys(input), access: process.env[ANTIGRAVITY_ACCESS_ENV], decision: decision.decision, overrides: decision.permissionOverrides });
      } catch {
      }
      process.stdout.write(JSON.stringify(decision));
      return 0;
    }
    const pid = await antigravityAncestor();
    if (!pid) {
      process.stdout.write("{}");
      return 0;
    }
    const reg = JSON.parse(readFileSync(join(resolveHome(), "antigravity-hooks", `${pid}.json`), "utf8"));
    if (!Number.isInteger(reg.port) || typeof reg.secret !== "string") throw new Error("invalid hook registration");
    const res = await fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}`, "content-type": "application/json" }, body: JSON.stringify({ event, input }), signal: AbortSignal.timeout(2e4) });
    if (!res.ok) throw new Error("hook endpoint unavailable");
    process.stdout.write(JSON.stringify(await res.json()));
  } catch {
    process.stdout.write(JSON.stringify(event === "PreToolUse" && process.env[ANTIGRAVITY_ACCESS_ENV] ? { decision: "deny", reason: "agent-bridge permission hook unavailable" } : {}));
  }
  return 0;
}

export {
  antigravityAncestor,
  inspectClaudeLaunch,
  antigravityReadingTool,
  antigravityPermission,
  antigravityHookOutput,
  runAntigravityHook
};
