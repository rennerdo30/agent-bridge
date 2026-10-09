import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RELAY_URL_ENV,
  askRelay
} from "./chunk-PFAESD67.mjs";
import "./chunk-NSOFXHCC.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-7OVAI3PR.mjs";
import "./chunk-PCXGTT2Z.mjs";
import "./chunk-S5K6II4C.mjs";
import "./chunk-L3WJOWYS.mjs";
import "./chunk-WFART47T.mjs";
import "./chunk-P3D6CPFS.mjs";
import "./chunk-TQCKZODX.mjs";
import "./chunk-OVBYB4CB.mjs";
import "./chunk-I7XFUMWM.mjs";
import "./chunk-RVGYULDQ.mjs";
import "./chunk-UT6DV2NX.mjs";
import "./chunk-GN275QYC.mjs";
import "./chunk-CJPLA2VJ.mjs";
import "./chunk-PEBTAWO6.mjs";

// src/cli/permission-hook.ts
var MAX_DETAIL_CHARS = 4e3;
var MCP_TOOL = /^mcp__(.+?)__(.+)$/;
function describe(toolInput) {
  if (toolInput && typeof toolInput === "object") {
    const o = toolInput;
    if (typeof o.command === "string") return o.command;
    if (typeof o.file_path === "string") return o.file_path;
  }
  return JSON.stringify(toolInput ?? {}).slice(0, MAX_DETAIL_CHARS);
}
function hookRequest(agent, input) {
  const tool = String(input.tool_name ?? "unknown");
  const cwd = typeof input.cwd === "string" ? input.cwd : void 0;
  const detail = describe(input.tool_input);
  const mcp = MCP_TOOL.exec(tool);
  if (mcp) return { agent, tool: `mcp:${mcp[1]}`, detail: `${mcp[2]}: ${detail}`.slice(0, MAX_DETAIL_CHARS), cwd };
  return { agent, tool, detail: detail.slice(0, MAX_DETAIL_CHARS), cwd };
}
async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}
async function runPermissionHook(agent = "codex") {
  if (!process.env[RELAY_URL_ENV]) return 0;
  let input = {};
  try {
    input = JSON.parse(await readStdin() || "{}");
  } catch {
  }
  const decision = await askRelay(hookRequest(agent === "claude" ? "claude" : "codex", input));
  const out = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: decision.allow ? { behavior: "allow" } : { behavior: "deny", message: decision.message }
    }
  };
  process.stdout.write(JSON.stringify(out));
  return 0;
}
export {
  hookRequest,
  runPermissionHook
};
