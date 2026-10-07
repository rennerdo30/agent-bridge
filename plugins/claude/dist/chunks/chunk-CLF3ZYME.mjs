import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  atomicPluginWrite
} from "./chunk-HPETZCQA.mjs";

// src/core/json-store.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { closeSync as closeSync2, copyFileSync, existsSync as existsSync3, fsyncSync, mkdirSync as mkdirSync2, openSync as openSync2, readFileSync as readFileSync2, readdirSync as readdirSync3, renameSync, rmSync as rmSync2, writeFileSync } from "node:fs";
import { basename, dirname as dirname2, join as join3 } from "node:path";

// src/core/storage-lock.ts
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
var LOCK_FILE = ".maintenance-lock";
var USERS_DIR = ".storage-users";
var SCOPED_STORE_DIRS = /* @__PURE__ */ new Set(["runs", "jobs", "job-outcomes", "worktree-state", "permission-repairs"]);
var NESTED_STORE_DIRS = /* @__PURE__ */ new Set(["local-result-receipts"]);
function storageLease(home) {
  const lock = join(home, LOCK_FILE);
  if (existsSync(lock)) throw new Error("storage maintenance is in progress");
  const dir = join(home, USERS_DIR);
  mkdirSync(dir, { recursive: true, mode: 448 });
  const path = join(dir, `${process.pid}-${randomUUID()}`);
  closeSync(openSync(path, "wx", 384));
  if (existsSync(lock)) {
    rmSync(path);
    throw new Error("storage maintenance is in progress");
  }
  return () => rmSync(path, { force: true });
}
function storeHome(path) {
  const dir = dirname(path);
  if (NESTED_STORE_DIRS.has(dirname(dir).split(/[\\/]/).at(-1) ?? "")) return dirname(dirname(dir));
  return SCOPED_STORE_DIRS.has(dir.split(/[\\/]/).at(-1) ?? "") ? dirname(dir) : dir;
}
function maintenanceLock(home) {
  mkdirSync(home, { recursive: true, mode: 448 });
  const path = join(home, LOCK_FILE);
  closeSync(openSync(path, "wx", 384));
  try {
    const dir = join(home, USERS_DIR);
    for (const file of existsSync(dir) ? readdirSync(dir) : []) {
      const pid = Number(file.split("-")[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("unknown storage lease; stop all bridge processes first");
      try {
        process.kill(pid, 0);
      } catch (err) {
        if (err.code !== "ESRCH") throw err;
        rmSync(join(dir, file));
        continue;
      }
      throw new Error("storage is in use; stop all bridge processes before restore or repair");
    }
    return () => rmSync(path, { force: true });
  } catch (err) {
    rmSync(path, { force: true });
    throw err;
  }
}

// src/core/store-compatibility.ts
import { existsSync as existsSync2, readdirSync as readdirSync2, readFileSync } from "node:fs";
import { join as join2 } from "node:path";
function releasedStoreCapabilities(version) {
  const match = /^0\.29\.(\d+)$/.exec(version ?? "");
  if (!match) return { json: 0, sqlite: 0 };
  const patch = Number(match[1]);
  if (patch >= 13 && patch <= 15) return { json: 4, sqlite: 7 };
  if (patch === 16) return { json: 4, sqlite: 8 };
  if (patch === 12) return { json: 3, sqlite: 7 };
  if (patch <= 11) return { json: 2, sqlite: 4 };
  return { json: 0, sqlite: 0 };
}
function validStoreCapabilities(value) {
  const v = value;
  return Boolean(v && Number.isSafeInteger(v.json) && v.json >= 0 && Number.isSafeInteger(v.sqlite) && v.sqlite >= 0);
}
function recordStorePeer(home, peer) {
  if (peer.host || !Number.isSafeInteger(peer.pid) || peer.pid <= 0) return;
  const explicit = validStoreCapabilities(peer.storeCapabilities);
  const path = join2(home, "storage-capabilities", `${peer.pid}.json`);
  if (!explicit && existsSync2(path)) {
    try {
      if (JSON.parse(readFileSync(path, "utf8")).explicit) return;
    } catch {
    }
  }
  const caps = explicit ? peer.storeCapabilities : releasedStoreCapabilities(peer.version);
  atomicPluginWrite(path, JSON.stringify({ schemaVersion: 1, ...caps, pid: peer.pid, name: peer.name, version: peer.version ?? "unknown", explicit }) + "\n");
}
function liveStorePeers(home) {
  const dir = join2(home, "storage-capabilities");
  if (!existsSync2(dir)) return [];
  return readdirSync2(dir).filter((file) => /^\d+\.json$/.test(file)).flatMap((file) => {
    const pid = Number(file.slice(0, -5));
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return [];
    }
    try {
      const record = JSON.parse(readFileSync(join2(dir, file), "utf8"));
      if (record.schemaVersion === 1 && record.pid === pid && validStoreCapabilities(record)) return [record];
    } catch {
    }
    return [{ pid, name: `pid ${pid}`, version: "unknown", json: 0, sqlite: 0, explicit: false }];
  });
}
function assertStoreUpgrade(home, format, current, target) {
  if (target <= current) return;
  const blockers = liveStorePeers(home).filter((peer) => peer[format] < target);
  if (!blockers.length) return;
  throw Object.assign(new Error(`Waiting to upgrade ${format} store ${current}\u2192${target}: ${blockers.map((p) => `${p.name} (v${p.version}, pid ${p.pid}, reads ${p[format]})`).join(", ")}. Existing sessions keep their code and data; retry when these readers finish naturally.`), { code: "STORE_UPGRADE_DEFERRED" });
}

// src/core/json-store.ts
var JSON_STORE_VERSION = 4;
var KEEP_STORE_BACKUPS = 3;
var RENAME_ATTEMPTS = 50;
var RENAME_RETRY_MS = 20;
function warn(log, message, data) {
  if (log) log.warn(message, data);
  else process.stderr.write(`${message}: ${JSON.stringify(data)}
`);
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function archiveFile(path) {
  if (!existsSync3(path)) return null;
  const dir = join3(dirname2(path), "archive");
  mkdirSync2(dir, { recursive: true, mode: 448 });
  const target = join3(dir, `${basename(path)}-${Date.now()}-${randomUUID2()}`);
  renameSync(path, target);
  return target;
}
function backupPath(path) {
  return `${path}.backup-${Date.now()}-${randomUUID2()}`;
}
function retainBackups(path) {
  const prefix = `${basename(path)}.backup-`;
  const files = readdirSync3(dirname2(path)).filter((f) => f.startsWith(prefix)).sort().reverse();
  for (const file of files.slice(KEEP_STORE_BACKUPS)) {
    try {
      archiveFile(join3(dirname2(path), file));
    } catch (error) {
      const code = error.code;
      if (["EBUSY", "EPERM", "EACCES", "ENOENT"].includes(code ?? "")) continue;
      throw error;
    }
  }
}
function readJsonStore(path, log, valid = isRecord) {
  let raw;
  try {
    raw = readFileSync2(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  try {
    const value = JSON.parse(raw);
    if (isRecord(value) && typeof value.version === "number" && value.version > JSON_STORE_VERSION) return value;
    if (!valid(value)) throw new Error("invalid store structure");
    return value;
  } catch (err) {
    const preserved = `${path}.corrupt-${Date.now()}-${randomUUID2()}`;
    const release = storageLease(storeHome(path));
    try {
      renameSync(path, preserved);
    } finally {
      release();
    }
    warn(log, "preserved corrupt JSON store", { path, preserved, err: err.message });
    return null;
  }
}
function assertWritableStore(value) {
  if (!isRecord(value) || value.version === void 0) return;
  if (!Number.isInteger(value.version) || value.version < 0 || value.version > JSON_STORE_VERSION) {
    throw new Error(`unsupported JSON store version: ${String(value.version)}`);
  }
}
function mergeStoreFields(previous, next) {
  const merged = { ...previous, ...next };
  for (const [key, value] of Object.entries(next)) {
    if (isRecord(previous[key]) && isRecord(value)) merged[key] = mergeStoreFields(previous[key], value);
  }
  return merged;
}
function writeJsonStore(path, value, previous) {
  const release = storageLease(storeHome(path));
  try {
    writeJsonStoreUnlocked(path, value, previous);
  } finally {
    release();
  }
}
function writeJsonStoreUnlocked(path, value, previous) {
  assertWritableStore(previous);
  assertStoreUpgrade(storeHome(path), "json", isRecord(previous) && typeof previous.version === "number" ? previous.version : 0, JSON_STORE_VERSION);
  mkdirSync2(dirname2(path), { recursive: true, mode: 448 });
  if (previous !== null && (!isRecord(previous) || previous.version !== JSON_STORE_VERSION) && existsSync3(path)) {
    copyFileSync(path, backupPath(path));
    retainBackups(path);
  }
  const tmp = `${path}.${process.pid}.${randomUUID2()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...value, version: JSON_STORE_VERSION }, null, 2)}
`, { mode: 384 });
  const fd = openSync2(tmp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync2(fd);
  }
  const pause = new Int32Array(new SharedArrayBuffer(4));
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(tmp, path);
        return;
      } catch (err) {
        const code = err.code;
        if (!["EPERM", "EBUSY", "EACCES"].includes(code ?? "") || attempt >= RENAME_ATTEMPTS) throw err;
        Atomics.wait(pause, 0, 0, RENAME_RETRY_MS);
      }
    }
  } finally {
    rmSync2(tmp, { force: true });
  }
}
function retentionLimit(key, fallback) {
  const raw = process.env[key];
  if (raw === void 0 || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}

export {
  storageLease,
  maintenanceLock,
  validStoreCapabilities,
  recordStorePeer,
  assertStoreUpgrade,
  JSON_STORE_VERSION,
  isRecord,
  archiveFile,
  backupPath,
  retainBackups,
  readJsonStore,
  assertWritableStore,
  mergeStoreFields,
  writeJsonStore,
  retentionLimit
};
