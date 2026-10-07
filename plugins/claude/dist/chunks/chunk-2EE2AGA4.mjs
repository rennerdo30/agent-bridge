import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  ENV
} from "./chunk-X27LYYGH.mjs";

// src/core/session-visibility.ts
import { posix } from "node:path";
function isPluginCacheCwd(cwd) {
  const path = posix.normalize(cwd.replace(/\\/g, "/")).toLowerCase().replace(/\/+$/, "");
  return /(?:^|\/)\.(?:codex|claude)\/plugins\/cache(?:\/|$)/.test(path) || /(?:^|\/)(?:\.config\/opencode|\.opencode|opencode)\/plugins?(?:\/|$)/.test(path) || /(?:^|\/)(?:\.gemini\/(?:config|antigravity-cli)|\.agents)\/plugins(?:\/|$)/.test(path);
}
function isInternalBridgeProcess(env = process.env) {
  return env[ENV.internal] === "1";
}

export {
  isPluginCacheCwd,
  isInternalBridgeProcess
};
