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
  readMusePrivateJson
} from "./chunk-7CFZWA3V.mjs";
import {
  processIdentity
} from "./chunk-6KVDLO53.mjs";

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
function brokerTcpPort(home, pipePath = resolvePipePath(home)) {
  try {
    const value = readMusePrivateJson(join(home, BROKER_TCP_FILE));
    if (!isEphemeralBrokerTcpRecord(value) || value.pipePath !== pipePath || value.protocol !== PROTOCOL_VERSION || !Number.isSafeInteger(value.pid) || typeof value.identity !== "string" || value.identity !== processIdentity(value.pid) || typeof value.nonce !== "string" || !value.nonce) return null;
    return typeof value.port === "number" && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 ? value.port : null;
  } catch {
    return null;
  }
}
function resolveDbPath(home) {
  return join(home, DB_FILE_NAME);
}

// src/core/token.ts
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync as chmodSync2, closeSync, existsSync, linkSync, mkdirSync as mkdirSync2, openSync, readFileSync as readFileSync2, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join as join2 } from "node:path";
var TOKEN_FILE_NAME = "token";
var TOKEN_BYTES = 32;
var OWNER_ONLY = 384;
var EMPTY_TOKEN_WAIT_MS = 2e3;
function tokenPath(home) {
  return join2(home, TOKEN_FILE_NAME);
}
function loadOrCreateToken(home) {
  const file = tokenPath(home);
  mkdirSync2(dirname(file), { recursive: true, mode: 448 });
  if (!existsSync(file)) {
    const temp = join2(dirname(file), `.token-${randomUUID()}`);
    let created = false;
    try {
      const token = randomBytes(TOKEN_BYTES).toString("hex");
      const fd = openSync(temp, "wx", OWNER_ONLY);
      created = true;
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      try {
        chmodSync2(temp, OWNER_ONLY);
      } catch {
      }
      try {
        linkSync(temp, file);
      } catch (err) {
        if (err.code !== "EEXIST") {
          try {
            writeFileSync(file, token, { flag: "wx", mode: OWNER_ONLY });
          } catch (inner) {
            if (inner.code !== "EEXIST") throw inner;
          }
        }
      }
    } finally {
      if (created) try {
        unlinkSync(temp);
      } catch {
      }
    }
  }
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (const deadline = Date.now() + EMPTY_TOKEN_WAIT_MS; ; ) {
    const token = readFileSync2(file, "utf8").trim();
    if (token) return token;
    if (Date.now() >= deadline) throw new Error(`agent-bridge token file is empty: ${file}`);
    Atomics.wait(pause, 0, 0, 25);
  }
}
function tokensEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export {
  resolveHome,
  resolvePipePath,
  ensurePrivateSocketDirectory,
  BROKER_TCP_FILE,
  isEphemeralBrokerTcpRecord,
  brokerTcpPort,
  resolveDbPath,
  loadOrCreateToken,
  tokensEqual
};
