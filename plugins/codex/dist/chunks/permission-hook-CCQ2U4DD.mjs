import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RELAY_URL_ENV,
  askRelay,
  boundedDetail
} from "./chunk-NGVYFQBO.mjs";
import "./chunk-BJ5JARC7.mjs";
import {
  readBodyText
} from "./chunk-6KTEQAZ2.mjs";
import "./chunk-JTZGNEMM.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-5FNZ2HXA.mjs";
import "./chunk-CAIIZP3X.mjs";
import "./chunk-S72NJQVR.mjs";
import "./chunk-KUUDTYJ7.mjs";
import "./chunk-5H3R35DU.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-54NYPMRK.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-LNAYXYZY.mjs";
import "./chunk-SAM43D5P.mjs";
import "./chunk-QLF3MF4O.mjs";
import "./chunk-EMB34XJI.mjs";
import "./chunk-OX5J3NNH.mjs";
import "./chunk-W6KF56AK.mjs";
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
