import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  atomicPluginWrite
} from "./chunk-CJPLA2VJ.mjs";

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
import { existsSync as existsSync2, readdirSync as readdirSync2, readFileSync as readFileSync2, statSync } from "node:fs";
import { join as join2 } from "node:path";

// src/core/process-identity.ts
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
var exec = promisify(execFile);
var parentIdentity;
function parentProcessIdentity() {
  return parentIdentity ??= readProcessIdentity(process.ppid);
}
async function readProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return start ? `${boot.trim()}:${start}` : null;
    }
    const { stdout } = process.platform === "win32" ? await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: 5e3 }) : await exec("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5e3, env: { ...process.env, LC_ALL: "C" } });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
async function readProcessIdentities(pids) {
  const valid = [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  const result = /* @__PURE__ */ new Map();
  if (!valid.length) return result;
  if (process.platform === "win32") {
    try {
      const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id @(${valid.join(",")}) -ErrorAction SilentlyContinue | ForEach-Object { try { [string]$_.Id + '|' + [string]$_.StartTime.ToUniversalTime().Ticks } catch {} }; exit 0`], { windowsHide: true, timeout: 5e3 });
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^(\d+)\|(\d+)$/.exec(line.trim());
        if (match && valid.includes(Number(match[1]))) result.set(Number(match[1]), match[2]);
      }
    } catch {
    }
  } else {
    await Promise.all(valid.map(async (pid) => {
      const identity = await readProcessIdentity(pid);
      if (identity) result.set(pid, identity);
    }));
  }
  return result;
}
var ownIdentity;
function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return void 0;
  if (pid === process.pid && ownIdentity) return ownIdentity;
  try {
    let identity;
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      if (start) identity = `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
    } else {
      identity = (process.platform === "win32" ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: 5e3, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) : execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5e3, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } })).trim() || void 0;
    }
    if (pid === process.pid) ownIdentity = identity;
    return identity;
  } catch {
    return void 0;
  }
}
function isProcessIdentityAlive(pid, identity) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !identity) return void 0;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "ESRCH" ? false : void 0;
  }
  const current = processIdentity(pid);
  return current === void 0 ? void 0 : current === identity;
}

// src/core/store-compatibility.ts
var identities = /* @__PURE__ */ new Map();
var refreshes = /* @__PURE__ */ new Map();
var IDENTITY_REFRESH_MS = 1e4;
function presenceSignature(path) {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return void 0;
  }
}
function refreshStorePeerIdentities(home, signal) {
  signal?.throwIfAborted();
  const ready = refreshIdentityCache(home);
  if (!signal) return ready;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    ready.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}
async function refreshIdentityCache(home) {
  for (; ; ) {
    const pending = refreshes.get(home);
    if (pending) {
      await pending;
      continue;
    }
    const dir = join2(home, "storage-capabilities");
    const records = existsSync2(dir) ? readdirSync2(dir).filter((file) => /^\d+\.json$/.test(file)).flatMap((file) => {
      const path = join2(dir, file), signature = presenceSignature(path), cached = identities.get(path);
      return signature && (!cached || cached.signature !== signature || Date.now() - cached.at >= IDENTITY_REFRESH_MS) ? [{ pid: Number(file.slice(0, -5)), path, signature }] : [];
    }) : [];
    if (!records.length) return;
    const refresh = (async () => {
      const current = await readProcessIdentities(records.filter((record) => record.pid !== process.pid).map((record) => record.pid));
      for (const { pid, path, signature } of records) identities.set(path, { identity: pid === process.pid ? processIdentity(pid) ?? null : current.get(pid) ?? null, at: Date.now(), signature });
    })();
    refreshes.set(home, refresh);
    try {
      await refresh;
    } finally {
      refreshes.delete(home);
    }
  }
}
function cachedIdentity(home, pid) {
  if (pid === process.pid) return processIdentity(pid);
  const path = join2(home, "storage-capabilities", `${pid}.json`), cached = identities.get(path);
  return cached && cached.signature === presenceSignature(path) && Date.now() - cached.at < IDENTITY_REFRESH_MS ? cached.identity ?? void 0 : void 0;
}
function legacyPidReused(identity, recordedAt) {
  if (process.platform === "win32" && /^\d+$/.test(identity)) {
    const startedAt = Number((BigInt(identity) - 621355968000000000n) / 10000n);
    return startedAt > recordedAt;
  }
  if (process.platform !== "linux") {
    const startedAt = Date.parse(identity + " UTC");
    return Number.isFinite(startedAt) && startedAt > recordedAt;
  }
  return false;
}
function releasedStoreCapabilities(version) {
  const match = /^0\.29\.(\d+)$/.exec(version ?? "");
  if (!match) return { json: 0, sqlite: 0 };
  const patch = Number(match[1]);
  if (patch >= 13 && patch <= 15) return { json: 4, sqlite: 7 };
  if (patch === 16 || patch === 17) return { json: 4, sqlite: 8 };
  if (patch === 12) return { json: 3, sqlite: 7 };
  if (patch <= 11) return { json: 2, sqlite: 4 };
  return { json: 0, sqlite: 0 };
}
function validStoreCapabilities(value) {
  const v = value;
  return Boolean(v && Number.isSafeInteger(v.json) && v.json >= 0 && Number.isSafeInteger(v.sqlite) && v.sqlite >= 0);
}
function recordStorePeer(home, peer, options = {}) {
  if (peer.host || !Number.isSafeInteger(peer.pid) || peer.pid <= 0) return;
  const explicit = validStoreCapabilities(peer.storeCapabilities);
  const path = join2(home, "storage-capabilities", `${peer.pid}.json`);
  let identity = cachedIdentity(home, peer.pid);
  if (!identity) void refreshStorePeerIdentities(home).catch(() => {
  });
  if (explicit && existsSync2(path)) {
    try {
      const previous = JSON.parse(readFileSync2(path, "utf8"));
      if (previous.explicit && validStoreCapabilities(previous) && previous.pid === peer.pid && previous.version === (peer.version ?? "unknown") && previous.json === peer.storeCapabilities.json && previous.sqlite === peer.storeCapabilities.sqlite && (!identity || previous.processIdentity === identity)) {
        if (!options.authoritative || previous.name === peer.name) return;
        identity ??= previous.processIdentity;
      }
    } catch {
    }
  }
  if (!explicit && existsSync2(path)) {
    try {
      const previous = JSON.parse(readFileSync2(path, "utf8"));
      if (previous.explicit && (!identity || previous.processIdentity === identity)) return;
    } catch {
    }
  }
  const caps = explicit ? peer.storeCapabilities : releasedStoreCapabilities(peer.version);
  atomicPluginWrite(path, JSON.stringify({ schemaVersion: 1, ...caps, pid: peer.pid, name: peer.name, version: peer.version ?? "unknown", explicit, ...identity ? { processIdentity: identity } : {} }) + "\n");
  if (!identity) void refreshStorePeerIdentities(home).catch(() => {
  });
}
function liveStorePeers(home) {
  const dir = join2(home, "storage-capabilities");
  if (!existsSync2(dir)) return [];
  void refreshStorePeerIdentities(home).catch(() => {
  });
  return readdirSync2(dir).filter((file) => /^\d+\.json$/.test(file)).flatMap((file) => {
    const pid = Number(file.slice(0, -5));
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return [];
    }
    try {
      const path = join2(dir, file), signature = presenceSignature(path);
      const record = JSON.parse(readFileSync2(path, "utf8"));
      if (signature !== presenceSignature(path)) throw new Error("Store reader presence changed during observation");
      const identity = cachedIdentity(home, pid);
      if (identity && typeof record.processIdentity === "string" && record.processIdentity !== identity) return [];
      if (identity && !record.processIdentity && legacyPidReused(identity, statSync(join2(dir, file)).mtimeMs)) return [];
      if (identity && record.schemaVersion === 1 && record.pid === pid && validStoreCapabilities(record)) return [record];
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
import { randomUUID as randomUUID2 } from "node:crypto";
import { closeSync as closeSync2, copyFileSync, existsSync as existsSync3, fsyncSync, mkdirSync as mkdirSync2, openSync as openSync2, readFileSync as readFileSync3, readdirSync as readdirSync3, renameSync, rmSync as rmSync2, writeFileSync } from "node:fs";
import { basename, dirname as dirname2, join as join3 } from "node:path";
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
    raw = readFileSync3(path, "utf8");
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
  parentProcessIdentity,
  readProcessIdentity,
  processIdentity,
  isProcessIdentityAlive,
  refreshStorePeerIdentities,
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
