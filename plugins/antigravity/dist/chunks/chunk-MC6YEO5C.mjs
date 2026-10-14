import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  APP_NAME,
  DB_FILE_NAME,
  DEFAULT_HOME,
  ENV,
  PROTOCOL_VERSION,
  SOCKET_FILE_NAME,
  WINDOWS_PIPE_PREFIX
} from "./chunk-G5PLFO4A.mjs";
import {
  readMusePrivateJsonAsync
} from "./chunk-LU5OH4AB.mjs";
import {
  readProcessIdentity
} from "./chunk-4O6KB7UQ.mjs";

// src/core/paths.ts
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";
var PIPE_HASH_LENGTH = 12;
var SHORT_SOCKET_HASH_LENGTH = 16;
var SHORT_SOCKET_ROOT = "/tmp";
function maxSocketPathBytes(platform = process.platform) {
  return platform === "linux" || platform === "android" ? 107 : 103;
}
function shortSocketDirectory(uid = process.getuid?.()) {
  return posix.join(SHORT_SOCKET_ROOT, `${APP_NAME}-${uid ?? "user"}`);
}
function resolveHome(env = process.env) {
  return resolve(env[ENV.home]?.trim() || DEFAULT_HOME);
}
function resolvePipePath(home, env = process.env, platform = process.platform, uid = process.getuid?.()) {
  const override = env[ENV.pipe]?.trim();
  if (override) return override;
  if (platform === "win32") {
    const hash2 = createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, PIPE_HASH_LENGTH);
    return `${WINDOWS_PIPE_PREFIX}${APP_NAME}-${hash2}-p${PROTOCOL_VERSION}`;
  }
  const socketName = SOCKET_FILE_NAME.replace(/\.sock$/, `-p${PROTOCOL_VERSION}.sock`);
  const inHome = posix.join(home, socketName);
  if (Buffer.byteLength(inHome) <= maxSocketPathBytes(platform)) return inHome;
  const hash = createHash("sha256").update(home).digest("hex").slice(0, SHORT_SOCKET_HASH_LENGTH);
  return posix.join(shortSocketDirectory(uid), `${hash}-${socketName}`);
}
function ensurePrivateSocketDirectory(pipePath, platform = process.platform) {
  if (platform === "win32" || typeof pipePath !== "string") return;
  const uid = process.getuid?.();
  const dir = shortSocketDirectory(uid);
  if (posix.dirname(pipePath) !== dir) return;
  try {
    mkdirSync(dir, { mode: 448 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || uid !== void 0 && stat.uid !== uid) {
    throw Object.assign(new Error(`refusing the agent-bridge socket directory ${dir}: it is not a directory owned by this user. Remove it or set ${ENV.pipe}.`), { code: "EUNSAFESOCKETDIR" });
  }
  if ((stat.mode & 63) !== 0) chmodSync(dir, 448);
}
var BROKER_TCP_FILE = "broker-tcp.json";
function isEphemeralBrokerTcpRecord(value) {
  return Object.keys(value).sort().join(",") === "identity,nonce,pid,pipePath,port,protocol" && typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535;
}
async function brokerTcpPortAsync(home, pipePath, signal) {
  try {
    const value = await readMusePrivateJsonAsync(join(home, BROKER_TCP_FILE), signal);
    if (!isEphemeralBrokerTcpRecord(value) || value.pipePath !== pipePath || value.protocol !== PROTOCOL_VERSION || !Number.isSafeInteger(value.pid) || typeof value.identity !== "string" || typeof value.nonce !== "string" || !value.nonce || signal.aborted) return null;
    const identity = await readProcessIdentity(value.pid, signal);
    return !signal.aborted && value.identity === identity ? value.port : null;
  } catch {
    return null;
  }
}
function resolveDbPath(home) {
  return join(home, DB_FILE_NAME);
}

export {
  resolveHome,
  resolvePipePath,
  ensurePrivateSocketDirectory,
  BROKER_TCP_FILE,
  isEphemeralBrokerTcpRecord,
  brokerTcpPortAsync,
  resolveDbPath
};
