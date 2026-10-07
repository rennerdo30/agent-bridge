import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  RELAY_URL_ENV,
  askRelay
} from "./chunk-HWDBJOHT.mjs";
import "./chunk-YZL7MD22.mjs";
import "./chunk-Y2DALO3R.mjs";
import "./chunk-GZUPJ35X.mjs";
import "./chunk-PCXGTT2Z.mjs";
import "./chunk-MZMJORKC.mjs";
import "./chunk-G6MLDC24.mjs";
import "./chunk-SOPZATYP.mjs";
import "./chunk-AT5K4DQH.mjs";
import "./chunk-AGX4O262.mjs";
import "./chunk-2EE2AGA4.mjs";
import "./chunk-FDMEMG4Z.mjs";
import "./chunk-4BCYRJ3A.mjs";
import "./chunk-BOOG2SC5.mjs";
import "./chunk-X27LYYGH.mjs";
import "./chunk-HHAVWD7J.mjs";

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
