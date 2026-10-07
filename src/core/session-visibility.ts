import { posix } from "node:path";
import { ENV } from "./constants.js";

/** Host plugin installation folders are background infrastructure, never projects. */
export function isPluginCacheCwd(cwd: string): boolean {
  const path = posix.normalize(cwd.replace(/\\/g, "/")).toLowerCase().replace(/\/+$/, "");
  return /(?:^|\/)\.(?:codex|claude)\/plugins\/cache(?:\/|$)/.test(path) ||
    /(?:^|\/)(?:\.config\/opencode|\.opencode|opencode)\/plugins?(?:\/|$)/.test(path) ||
    /(?:^|\/)(?:\.gemini\/(?:config|antigravity-cli)|\.agents)\/plugins(?:\/|$)/.test(path);
}

/** Explicit marking survives child processes that do not retain delegation depth. */
export function isInternalBridgeProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV.internal] === "1";
}
