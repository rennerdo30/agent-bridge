import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  APP_NAME,
  DB_FILE_NAME,
  DEFAULT_HOME,
  ENV,
  PROTOCOL_VERSION,
  SOCKET_FILE_NAME,
  WINDOWS_PIPE_PREFIX
} from "./chunk-PEBTAWO6.mjs";

// src/core/paths.ts
import { createHash } from "node:crypto";
import { join, posix, resolve } from "node:path";
var PIPE_HASH_LENGTH = 12;
function resolveHome(env = process.env) {
  return resolve(env[ENV.home]?.trim() || DEFAULT_HOME);
}
function resolvePipePath(home, env = process.env, platform = process.platform) {
  const override = env[ENV.pipe]?.trim();
  if (override) return override;
  if (platform === "win32") {
    const hash = createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, PIPE_HASH_LENGTH);
    return `${WINDOWS_PIPE_PREFIX}${APP_NAME}-${hash}-p${PROTOCOL_VERSION}`;
  }
  return posix.join(home, SOCKET_FILE_NAME.replace(/\.sock$/, `-p${PROTOCOL_VERSION}.sock`));
}
function resolveDbPath(home) {
  return join(home, DB_FILE_NAME);
}

export {
  resolveHome,
  resolvePipePath,
  resolveDbPath
};
