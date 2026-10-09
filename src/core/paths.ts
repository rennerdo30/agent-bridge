import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { DB_FILE_NAME, DEFAULT_HOME, ENV, SOCKET_FILE_NAME, WINDOWS_PIPE_PREFIX, APP_NAME, PROTOCOL_VERSION } from "./constants.js";

const PIPE_HASH_LENGTH = 12;
const SHORT_SOCKET_HASH_LENGTH = 16;
/** Fixed root (never $TMPDIR, which differs between processes) for sockets whose home path is too long. */
const SHORT_SOCKET_ROOT = "/tmp";

/**
 * Longest Unix socket path the kernel accepts: sun_path holds 108 bytes on Linux and 104 on macOS and the
 * BSDs, including the terminating NUL. Node 24 rejects longer paths with EINVAL; older runtimes truncated
 * them silently, which could make two homes share one endpoint.
 */
export function maxSocketPathBytes(platform: NodeJS.Platform = process.platform): number {
  return platform === "linux" || platform === "android" ? 107 : 103;
}

/** Per-user directory holding the endpoints of homes whose own socket path would be too long. */
export function shortSocketDirectory(uid: number | undefined = process.getuid?.()): string {
  return posix.join(SHORT_SOCKET_ROOT, `${APP_NAME}-${uid ?? "user"}`);
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env[ENV.home]?.trim() || DEFAULT_HOME);
}

/**
 * The broker endpoint. Every distinct home directory gets its own endpoint, so tests and
 * separate users never collide. Windows uses a named pipe; everything else a Unix socket.
 */
export function resolvePipePath(home: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, uid: number | undefined = process.getuid?.()): string {
  const override = env[ENV.pipe]?.trim();
  if (override) return override;
  if (platform === "win32") {
    const hash = createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, PIPE_HASH_LENGTH);
    // The protocol is part of the name: sessions of incompatible versions run separate bridges instead of
    // the first one locking every other version out.
    return `${WINDOWS_PIPE_PREFIX}${APP_NAME}-${hash}-p${PROTOCOL_VERSION}`;
  }
  const socketName = SOCKET_FILE_NAME.replace(/\.sock$/, `-p${PROTOCOL_VERSION}.sock`);
  const inHome = posix.join(home, socketName);
  // A home whose socket fits keeps it (every existing install). A deeper home gets a hashed, per-user short
  // path instead of an endpoint that can never be bound, the way tmux and ssh connection sharing do.
  if (Buffer.byteLength(inHome) <= maxSocketPathBytes(platform)) return inHome;
  const hash = createHash("sha256").update(home).digest("hex").slice(0, SHORT_SOCKET_HASH_LENGTH);
  return posix.join(shortSocketDirectory(uid), `${hash}-${socketName}`);
}

/**
 * Before binding or connecting to a socket in the shared short-socket root, make sure its directory is this
 * user's private directory: in a world-writable /tmp another user could otherwise pre-create it and receive
 * the session token on connect or replace the endpoint. Endpoints anywhere else are left untouched.
 */
export function ensurePrivateSocketDirectory(pipePath: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  const uid = process.getuid?.();
  const dir = shortSocketDirectory(uid);
  if (posix.dirname(pipePath) !== dir) return;
  try { mkdirSync(dir, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) {
    throw Object.assign(new Error(`refusing the agent-bridge socket directory ${dir}: it is not a directory owned by this user. Remove it or set ${ENV.pipe}.`), { code: "EUNSAFESOCKETDIR" });
  }
  // Our own directory with a loose mode (an old umask, a manual mkdir): tighten it rather than refuse.
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

export function resolveDbPath(home: string): string {
  return join(home, DB_FILE_NAME);
}
