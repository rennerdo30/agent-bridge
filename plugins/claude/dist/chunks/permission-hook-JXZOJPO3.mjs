import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RELAY_URL_ENV,
  askRelay,
  boundedDetail,
  describeToolInput,
  markerSafe,
  requestIdentity
} from "./chunk-ILN2V2BA.mjs";
import {
  readBodyText
} from "./chunk-6KTEQAZ2.mjs";
import "./chunk-DXEWIZM4.mjs";
import "./chunk-T3Y747W7.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-DNAUDSOJ.mjs";
import "./chunk-3L5NAV5P.mjs";
import "./chunk-6B2AZPTL.mjs";
import "./chunk-KT6UGBZN.mjs";
import "./chunk-HSYLC53O.mjs";
import "./chunk-3ONQFYIQ.mjs";
import "./chunk-JKWPEEII.mjs";
import "./chunk-VUZ3I7UH.mjs";
import "./chunk-5NPKKVPB.mjs";
import "./chunk-UEE6Z4PJ.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-6QSR4FTZ.mjs";
import "./chunk-YEN6TM2D.mjs";
import "./chunk-FJ2TGOLZ.mjs";
import "./chunk-EMDJN7RB.mjs";
import "./chunk-6RNADTH4.mjs";

// src/cli/permission-hook.ts
var MCP_TOOL = /^mcp__(.+?)__(.+)$/;
var FILE_CHANGE_TOOLS = /* @__PURE__ */ new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "apply_patch"]);
function describe(toolInput, mcp) {
  return describeToolInput(toolInput, { mcp });
}
function hookRequest(agent, input) {
  const tool = String(input.tool_name ?? "unknown");
  const cwd = typeof input.cwd === "string" ? input.cwd : void 0;
  const mcp = MCP_TOOL.exec(tool);
  const detail = describe(input.tool_input, Boolean(mcp));
  const exact = FILE_CHANGE_TOOLS.has(tool) ? { inexact: true } : { identity: requestIdentity({ tool_name: tool, tool_input: input.tool_input ?? null }) };
  if (mcp) return { agent, tool: `mcp:${mcp[1]}`, ...boundedDetail(markerSafe(`${mcp[2]}: ${detail}`)), cwd, ...exact };
  return { agent, tool, ...boundedDetail(detail), cwd, ...exact };
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
  FILE_CHANGE_TOOLS,
  hookRequest,
  runPermissionHook
};
