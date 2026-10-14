import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  resolveHome
} from "./chunk-P2QFDD4K.mjs";
import {
  object
} from "./chunk-NVDPULGI.mjs";

// src/cli/muse-hook.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
function museHookRegistration(home, sessionId) {
  return join(home, "muse-hooks", `${sessionId.replace(/[^\w-]/g, "_")}.json`);
}
function museHookOutput(event, output) {
  const text = "reason" in output ? String(output.reason) : "hookSpecificOutput" in output ? output.hookSpecificOutput.additionalContext : "";
  if (!text) return {};
  if (event === "Stop") return { decision: "block", reason: text };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}
async function runMuseHook(eventArg) {
  try {
    let raw = "";
    for await (const part of process.stdin) {
      raw += part;
      if (raw.length > 256 * 1024) throw new Error("hook input too large");
    }
    const input = object(JSON.parse(raw || "{}"));
    const event = typeof input.hook_event_name === "string" ? input.hook_event_name : eventArg ?? "";
    const sessionId = typeof input.session_id === "string" ? input.session_id : process.env.MUSE_SESSION_ID ?? "";
    if (!event || !sessionId) {
      process.stdout.write("{}");
      return 0;
    }
    const reg = JSON.parse(readFileSync(museHookRegistration(resolveHome(), sessionId), "utf8"));
    if (!Number.isInteger(reg.port) || typeof reg.secret !== "string") throw new Error("invalid hook registration");
    const res = await fetch(`http://127.0.0.1:${reg.port}/hook`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}`, "content-type": "application/json" }, body: JSON.stringify({ event, input }), signal: AbortSignal.timeout(2e4) });
    if (!res.ok) throw new Error("hook endpoint unavailable");
    process.stdout.write(JSON.stringify(await res.json()));
  } catch {
    process.stdout.write("{}");
  }
  return 0;
}

export {
  museHookRegistration,
  museHookOutput,
  runMuseHook
};
