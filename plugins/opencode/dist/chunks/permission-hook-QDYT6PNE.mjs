import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RELAY_URL_ENV,
  askRelay,
  boundedDetail,
  describeToolInput,
  markerSafe
} from "./chunk-R7W5ZPVW.mjs";
import {
  readBodyText
} from "./chunk-6KTEQAZ2.mjs";
import "./chunk-TIWIMVUC.mjs";
import "./chunk-RMFHER2N.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-DNAUDSOJ.mjs";
import "./chunk-5YUMH7RA.mjs";
import "./chunk-56244RMS.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-KBNZV2V7.mjs";
import "./chunk-V3SUTKKO.mjs";
import "./chunk-PJLFHRLV.mjs";
import "./chunk-IKJMNO54.mjs";
import "./chunk-22ZCB4PT.mjs";
import "./chunk-I32N5HZ3.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-LGFTSWER.mjs";
import "./chunk-WV46DNR7.mjs";
import "./chunk-GTACKGIN.mjs";
import "./chunk-ARGAVNKJ.mjs";
import "./chunk-6RNADTH4.mjs";

// src/cli/permission-hook.ts
var MCP_TOOL = /^mcp__(.+?)__(.+)$/;
function describe(toolInput, mcp) {
  return describeToolInput(toolInput, { mcp });
}
function hookRequest(agent, input) {
  const tool = String(input.tool_name ?? "unknown");
  const cwd = typeof input.cwd === "string" ? input.cwd : void 0;
  const mcp = MCP_TOOL.exec(tool);
  const detail = describe(input.tool_input, Boolean(mcp));
  if (mcp) return { agent, tool: `mcp:${mcp[1]}`, ...boundedDetail(markerSafe(`${mcp[2]}: ${detail}`)), cwd };
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
