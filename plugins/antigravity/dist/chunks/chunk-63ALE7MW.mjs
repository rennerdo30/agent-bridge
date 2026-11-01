import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  external_exports
} from "./chunk-7TGCOQY2.mjs";

// src/core/bundle-directory.ts
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
function bundleDirectory(url) {
  const dir = dirname(fileURLToPath(url));
  return basename(dir) === "chunks" ? dirname(dir) : dir;
}

// src/core/t3-identity.ts
var t3BindingSchema = external_exports.object({
  kind: external_exports.literal("t3"),
  scope: external_exports.string().regex(/^[a-f0-9]{64}$/),
  threadId: external_exports.string().min(1).max(512),
  providerInstanceId: external_exports.string().min(1).max(256)
});
function nativeT3FromEnv(env) {
  const selector = env.AGENT_BRIDGE_HOST;
  if (selector !== void 0 && selector !== "auto") return false;
  return Boolean(env.T3CODE_CLI_PATH?.trim());
}
function mcpProfileFromEnv(env, frontend, nativeT3 = false) {
  const selected = env.AGENT_BRIDGE_MCP_PROFILE ?? "auto";
  if (!["auto", "full", "reduced"].includes(selected)) throw new Error("Invalid AGENT_BRIDGE_MCP_PROFILE; expected auto, reduced or full.");
  if (selected === "reduced" && !frontend && !nativeT3) throw new Error("Reduced MCP profile requires a validated T3 host or a T3 Code chat.");
  if (frontend) t3BindingSchema.parse(frontend);
  return selected === "full" || !frontend && !nativeT3 ? "full" : "reduced";
}
var REDUCED_HIDDEN = /* @__PURE__ */ new Set([
  "t3_capabilities",
  "t3_delegate",
  "t3_task_status",
  "t3_task_cancel",
  "t3_send",
  "list_models",
  "usage_limits"
]);
function profileAllowsTool(profile, name) {
  return profile !== "reduced" || !REDUCED_HIDDEN.has(name);
}
function sameFrontend(a, b) {
  if (!a.frontend && !b.frontend) return true;
  return Boolean(a.frontend && b.frontend && a.frontend.scope === b.frontend.scope && a.frontend.threadId === b.frontend.threadId && a.frontend.providerInstanceId === b.frontend.providerInstanceId);
}

export {
  bundleDirectory,
  t3BindingSchema,
  nativeT3FromEnv,
  mcpProfileFromEnv,
  profileAllowsTool,
  sameFrontend
};
