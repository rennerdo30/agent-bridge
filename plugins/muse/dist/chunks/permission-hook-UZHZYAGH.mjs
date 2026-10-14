import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RELAY_URL_ENV,
  askRelay,
  boundedDetail
} from "./chunk-RQVG3DTE.mjs";
import "./chunk-YXP3D4N7.mjs";
import {
  readBodyText
} from "./chunk-6KTEQAZ2.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-CHGUU5ZH.mjs";
import "./chunk-QE5Y5JCD.mjs";
import "./chunk-2UCPNPKV.mjs";
import "./chunk-BEZD7FHM.mjs";
import "./chunk-JF4RUO76.mjs";
import "./chunk-GT6BLZHK.mjs";
import "./chunk-IMOU3QNL.mjs";
import "./chunk-VXKZ7TFV.mjs";
import "./chunk-4S5VWBNU.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-SCPRRSA3.mjs";
import "./chunk-GGCBZOQR.mjs";
import "./chunk-G5PLFO4A.mjs";
import "./chunk-VWILPC5Y.mjs";
import "./chunk-NVDPULGI.mjs";
import "./chunk-FG32ZSGV.mjs";
import "./chunk-6RNADTH4.mjs";

// src/cli/permission-hook.ts
var MCP_TOOL = /^mcp__(.+?)__(.+)$/;
function describe(toolInput) {
  if (toolInput && typeof toolInput === "object") {
    const o = toolInput;
    if (typeof o.command === "string") return o.command;
    if (typeof o.file_path === "string") return o.file_path;
  }
  return JSON.stringify(toolInput ?? {});
}
function hookRequest(agent, input) {
  const tool = String(input.tool_name ?? "unknown");
  const cwd = typeof input.cwd === "string" ? input.cwd : void 0;
  const detail = describe(input.tool_input);
  const mcp = MCP_TOOL.exec(tool);
  if (mcp) return { agent, tool: `mcp:${mcp[1]}`, ...boundedDetail(`${mcp[2]}: ${detail}`), cwd };
  return { agent, tool, ...boundedDetail(detail), cwd };
}
async function readStdin() {
  return readBodyText(process.stdin);
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
