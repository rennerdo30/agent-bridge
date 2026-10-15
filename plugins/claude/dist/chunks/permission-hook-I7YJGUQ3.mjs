import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RELAY_URL_ENV,
  askRelay,
  boundedDetail
} from "./chunk-M5XY6MWN.mjs";
import {
  readBodyText
} from "./chunk-6KTEQAZ2.mjs";
import "./chunk-F2J2GD3I.mjs";
import "./chunk-AVFP4VLR.mjs";
import "./chunk-ORHVXX2T.mjs";
import "./chunk-DNAUDSOJ.mjs";
import "./chunk-D5ZW6VFT.mjs";
import "./chunk-XIY6YUWX.mjs";
import "./chunk-56244RMS.mjs";
import "./chunk-LOV5TPO7.mjs";
import "./chunk-7AVL5VO2.mjs";
import "./chunk-PQTSSDXI.mjs";
import "./chunk-UTSHXRSC.mjs";
import "./chunk-IYJ5P7ML.mjs";
import "./chunk-7ILYHEEI.mjs";
import "./chunk-OX5J3NNH.mjs";
import "./chunk-HYOPFLLN.mjs";
import "./chunk-K2KQEUNB.mjs";
import "./chunk-BVMWTWQA.mjs";
import "./chunk-O26G5HFG.mjs";
import "./chunk-ARGAVNKJ.mjs";
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
