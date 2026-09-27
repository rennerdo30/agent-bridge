import { createHash } from "node:crypto";
import { join, posix, resolve } from "node:path";
import { DB_FILE_NAME, DEFAULT_HOME, ENV, SOCKET_FILE_NAME, WINDOWS_PIPE_PREFIX, APP_NAME } from "./constants.js";

const PIPE_HASH_LENGTH = 12;

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env[ENV.home]?.trim() || DEFAULT_HOME);
}

/**
 * The broker endpoint. Every distinct home directory gets its own endpoint, so tests and
 * separate users never collide. Windows uses a named pipe; everything else a Unix socket.
 */
export function resolvePipePath(home: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env[ENV.pipe]?.trim();
  if (override) return override;
  if (platform === "win32") {
    const hash = createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, PIPE_HASH_LENGTH);
    return `${WINDOWS_PIPE_PREFIX}${APP_NAME}-${hash}`;
  }
  return posix.join(home, SOCKET_FILE_NAME);
}

export function resolveDbPath(home: string): string {
  return join(home, DB_FILE_NAME);
}
