import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RELAY_URL_ENV,
  askRelay,
  boundedDetail
} from "./chunk-J3ZAERJT.mjs";
import {
  readBodyText
} from "./chunk-6KTEQAZ2.mjs";
import "./chunk-ZW2SNKIR.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-M26SH6VN.mjs";
import "./chunk-V4WDBMEN.mjs";
import "./chunk-Z6MK4XYJ.mjs";
import "./chunk-CBYPCUI4.mjs";
import "./chunk-4QXHCXBU.mjs";
import "./chunk-U2CLVBS6.mjs";
import "./chunk-EA6YAI7Y.mjs";
import "./chunk-GWIXAP3X.mjs";
import "./chunk-DAFFZ3XB.mjs";
import "./chunk-WM3QOXKL.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-NPANAOIQ.mjs";
import "./chunk-2JCQIMR7.mjs";
import "./chunk-EZXQJRQM.mjs";
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
