import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  atomicPluginWrite
} from "./chunk-SFW3GO73.mjs";

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
import { existsSync as existsSync5, readdirSync as readdirSync5, readFileSync as readFileSync5, statSync } from "node:fs";
import { join as join6 } from "node:path";

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

// src/core/metadata-db.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { existsSync as existsSync3, lstatSync as lstatSync2, mkdirSync as mkdirSync4 } from "node:fs";
import { dirname as dirname4, join as join4, resolve as resolve2 } from "node:path";
import { DatabaseSync } from "node:sqlite";

// src/core/metadata-file-lease.ts
import { createHash, randomUUID as randomUUID3 } from "node:crypto";
import { closeSync as closeSync3, fsyncSync as fsyncSync2, linkSync, lstatSync, mkdirSync as mkdirSync3, openSync as openSync3, readFileSync as readFileSync3, readdirSync as readdirSync3, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { basename as basename2, dirname as dirname3, join as join3, resolve } from "node:path";

// src/core/json-store.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { closeSync as closeSync2, copyFileSync, existsSync as existsSync2, fsyncSync, mkdirSync as mkdirSync2, openSync as openSync2, readFileSync as readFileSync2, readdirSync as readdirSync2, renameSync, rmSync as rmSync2, writeFileSync } from "node:fs";
import { basename, dirname as dirname2, join as join2 } from "node:path";
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
  if (!existsSync2(path)) return null;
  const dir = join2(dirname2(path), "archive");
  mkdirSync2(dir, { recursive: true, mode: 448 });
  const target = join2(dir, `${basename(path)}-${Date.now()}-${randomUUID2()}`);
  renameSync(path, target);
  return target;
}
function backupPath(path) {
  return `${path}.backup-${Date.now()}-${randomUUID2()}`;
}
function retainBackups(path) {
  const prefix = `${basename(path)}.backup-`;
  const files = readdirSync2(dirname2(path)).filter((f) => f.startsWith(prefix)).sort().reverse();
  for (const file of files.slice(KEEP_STORE_BACKUPS)) {
    try {
      archiveFile(join2(dirname2(path), file));
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
  if (previous !== null && (!isRecord(previous) || previous.version !== JSON_STORE_VERSION) && existsSync2(path)) {
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

// src/core/metadata-file-lease.ts
var VERSION = 2;
var RETRY_MS = 20;
var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
var MARKER = /^(?:owner|claim)-v1\.(\d+)\.([A-Za-z0-9_-]+)\.([a-f0-9-]{36})\.json$/;
var busy = () => Object.assign(new Error("metadata lease has a live or unknown owner"), { code: "ELEASEBUSY" });
var exitedIdentities = /* @__PURE__ */ new Set();
var identityProbes = /* @__PURE__ */ new Set();
function nonBlockingAlive(owner) {
  if (owner.pid === process.pid) return isProcessIdentityAlive(owner.pid, owner.identity);
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return error.code === "ESRCH" ? false : void 0;
  }
  const key = `${owner.pid}:${owner.identity}`;
  if (exitedIdentities.has(key)) return false;
  if (!identityProbes.has(key)) {
    identityProbes.add(key);
    void readProcessIdentity(owner.pid).then((current) => {
      if (current !== null && current !== owner.identity) {
        if (exitedIdentities.size >= 512) exitedIdentities.delete(exitedIdentities.values().next().value);
        exitedIdentities.add(key);
      }
    }).catch(() => {
    }).finally(() => identityProbes.delete(key));
  }
  return void 0;
}
function physicalDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw busy();
}
function physicalAncestors(path) {
  let current = resolve(path);
  for (; ; ) {
    try {
      physicalDirectory(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname3(current);
    if (parent === current) return;
    current = parent;
  }
}
function markerName(identity, claim = false) {
  return `${claim ? "claim" : "owner"}-v1.${process.pid}.${Buffer.from(identity).toString("base64url")}.${randomUUID3()}.json`;
}
function fileIdentity(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw busy();
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}
function readOwner(path, registry) {
  try {
    const file = fileIdentity(path);
    const value = JSON.parse(readFileSync3(path, "utf8"));
    if (!isRecord(value) || value.version !== VERSION || typeof value.ownerDirectory !== "string" || !UUID.test(value.ownerDirectory)) return null;
    physicalDirectory(registry);
    const dir = join3(registry, value.ownerDirectory);
    physicalDirectory(dir);
    const files = readdirSync3(dir);
    if (files.length !== 1) return null;
    const marker = files[0];
    const match = MARKER.exec(marker);
    const pid = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(pid) || pid <= 0 || !UUID.test(match[3])) return null;
    const identity = Buffer.from(match[2], "base64url").toString("utf8");
    if (!identity || Buffer.from(identity).toString("base64url") !== match[2]) return null;
    if (fileIdentity(join3(dir, marker)) !== file || fileIdentity(path) !== file) return null;
    return { dir, marker, pid, identity, file };
  } catch {
    return null;
  }
}
function readMetadataLeaseOwner(path) {
  const registry = join3(dirname3(path), ".metadata-leases", createHash("sha256").update(basename2(path)).digest("hex"));
  const owner = readOwner(path, registry);
  return owner ? { pid: owner.pid, identity: owner.identity } : null;
}
function archiveOwned(path, registry, owner, identity) {
  const current = readOwner(path, registry);
  if (!current || current.file !== owner.file || current.marker !== owner.marker || current.dir !== owner.dir) throw busy();
  const claim = markerName(identity, true);
  renameSync2(join3(owner.dir, owner.marker), join3(owner.dir, claim));
  if (fileIdentity(path) !== owner.file) throw busy();
  renameSync2(path, join3(owner.dir, `released-v2.${randomUUID3()}.json`));
  archiveFile(owner.dir);
}
function metadataFileLease(path, waitMs = 0, nonBlockingRecovery = false) {
  const identity = processIdentity(process.pid);
  if (!identity) throw busy();
  const parent = dirname3(path);
  physicalAncestors(parent);
  mkdirSync3(parent, { recursive: true, mode: 448 });
  physicalDirectory(parent);
  const namespace = join3(parent, ".metadata-leases");
  mkdirSync3(namespace, { recursive: true, mode: 448 });
  physicalDirectory(namespace);
  const registry = join3(namespace, createHash("sha256").update(basename2(path)).digest("hex"));
  mkdirSync3(registry, { recursive: true, mode: 448 });
  physicalDirectory(registry);
  const archive = join3(registry, "archive");
  mkdirSync3(archive, { recursive: true, mode: 448 });
  physicalDirectory(archive);
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let staged;
  try {
    for (; ; ) {
      let absent = false;
      try {
        lstatSync(path);
      } catch (error) {
        if (error.code === "ENOENT") absent = true;
        else throw error;
      }
      if (absent) {
        if (!staged) {
          const ownerDirectory = randomUUID3();
          const dir = join3(registry, ownerDirectory);
          mkdirSync3(dir, { mode: 448 });
          const marker = markerName(identity);
          const source = join3(dir, marker);
          try {
            const fd = openSync3(source, "wx", 384);
            try {
              writeFileSync2(fd, `${JSON.stringify({ version: VERSION, pid: process.pid, identity, nonce: marker, ownerDirectory, createdAt: Date.now() })}
`);
              fsyncSync2(fd);
            } finally {
              closeSync3(fd);
            }
            staged = { dir, marker, pid: process.pid, identity, file: fileIdentity(source) };
          } catch (error) {
            archiveFile(dir);
            throw error;
          }
        }
        try {
          linkSync(join3(staged.dir, staged.marker), path);
          const acquired = staged;
          staged = void 0;
          let released = false;
          return () => {
            if (released) return;
            const owner2 = readOwner(path, registry);
            if (!owner2 || owner2.file !== acquired.file || owner2.dir !== acquired.dir || owner2.marker !== acquired.marker) return;
            archiveOwned(path, registry, owner2, identity);
            released = true;
          };
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      const owner = readOwner(path, registry);
      if (owner && (nonBlockingRecovery ? nonBlockingAlive(owner) : isProcessIdentityAlive(owner.pid, owner.identity)) === false) {
        try {
          archiveOwned(path, registry, owner, identity);
          continue;
        } catch {
        }
      }
      if (Date.now() >= deadline) throw busy();
      Atomics.wait(pause, 0, 0, RETRY_MS);
    }
  } finally {
    if (staged) archiveFile(staged.dir);
  }
}

// src/core/metadata-db.ts
var VERSION2 = 1;
var connections = /* @__PURE__ */ new Map();
var readers = /* @__PURE__ */ new Map();
var SCHEMA = `
CREATE TABLE IF NOT EXISTS bridge_components (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS worktree_leases (
 key TEXT PRIMARY KEY, path TEXT, pid INTEGER, identity TEXT, job_id TEXT,
 nonce TEXT NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL,
 archived_at INTEGER, archive_reason TEXT, legacy_path TEXT
);
CREATE TABLE IF NOT EXISTS worktree_lease_archive (
 nonce TEXT PRIMARY KEY, key TEXT NOT NULL, path TEXT, pid INTEGER, identity TEXT, job_id TEXT,
 acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL,
 archived_at INTEGER NOT NULL, archive_reason TEXT NOT NULL, legacy_path TEXT
);
CREATE TABLE IF NOT EXISTS bridge_metadata (
 domain TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(domain,key)
);
CREATE TABLE IF NOT EXISTS bridge_read_receipts (
 identity TEXT NOT NULL, message_id TEXT NOT NULL, read_at INTEGER,
 PRIMARY KEY(identity,message_id)
);
CREATE TABLE IF NOT EXISTS bridge_imports (
 path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
 bundle TEXT NOT NULL, cold_path TEXT NOT NULL, imported_at INTEGER NOT NULL
);
INSERT INTO bridge_components(name,version) VALUES ('metadata',1)
 ON CONFLICT(name) DO UPDATE SET version=excluded.version;
`;
function physicalMetadataPath(path) {
  let current = resolve2(path);
  for (; ; ) {
    try {
      if (lstatSync2(current).isSymbolicLink()) throw new Error(`Linked storage path retained: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname4(current);
    if (parent === current) return;
    current = parent;
  }
}
function existingMetadataDb(home) {
  const file = join4(resolve2(home), "bridge.db"), cached = connections.get(file);
  if (cached) return cached;
  if (!existsSync3(file)) return void 0;
  physicalMetadataPath(file);
  const db = new DatabaseSync(file, { timeout: 5e3 });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get() || Number(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) !== VERSION2) {
      db.close();
      return void 0;
    }
    db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    connections.set(file, db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function assertMetadataAdmission(home) {
  const blockers = liveStorePeers(home).filter((peer) => !/^0\.30\.(?:[4-9]|[1-9]\d+)$/.test(peer.version));
  if (blockers.length) throw Object.assign(new Error(`Waiting for metadata upgrade: ${blockers.map((p) => `${p.name} (v${p.version}, pid ${p.pid})`).join(", ")}. Existing readers keep their files.`), { code: "STORE_UPGRADE_DEFERRED" });
}
function metadataDb(home) {
  const file = join4(resolve2(home), "bridge.db");
  const cached = connections.get(file);
  if (cached) return cached;
  physicalMetadataPath(file);
  mkdirSync4(dirname4(file), { recursive: true, mode: 448 });
  const existed = existsSync3(file);
  const db = new DatabaseSync(file, { timeout: 5e3 });
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    const version = () => db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get() ? Number(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) : 0;
    if (version() > VERSION2) throw new Error("Metadata store is newer than this reader; retained unchanged.");
    if (version() < VERSION2) {
      assertMetadataAdmission(home);
      const release = metadataFileLease(`${file}.metadata-migration`, 5e3);
      try {
        if (version() < VERSION2) {
          if (existed) {
            const dir = join4(home, ".migration-snapshots");
            physicalMetadataPath(dir);
            mkdirSync4(dir, { recursive: true, mode: 448 });
            const backup = join4(dir, `metadata-v${VERSION2}-${randomUUID4()}.db`);
            db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
            const check = new DatabaseSync(backup, { readOnly: true });
            try {
              if (check.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok") throw new Error("Metadata backup verification failed; originals retained.");
            } finally {
              check.close();
            }
          }
          db.exec("BEGIN IMMEDIATE");
          try {
            db.exec(SCHEMA);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }
      } finally {
        release();
      }
    }
    connections.set(file, db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function closeMetadataDb(home) {
  const file = join4(resolve2(home), "bridge.db"), db = connections.get(file);
  if (db) {
    db.close();
    connections.delete(file);
  }
}
function retainMetadataReader(home) {
  const key = resolve2(home);
  readers.set(key, (readers.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (readers.get(key) ?? 1) - 1;
    if (count > 0) readers.set(key, count);
    else {
      readers.delete(key);
      closeMetadataDb(home);
    }
  };
}
function metadataValue(home, domain, key) {
  const row = metadataDb(home).prepare("SELECT value FROM bridge_metadata WHERE domain=? AND key=?").get(domain, key);
  return row ? JSON.parse(String(row.value)) : null;
}
function saveMetadataValue(home, domain, key, value) {
  const release = storageLease(home);
  try {
    metadataDb(home).prepare(`INSERT INTO bridge_metadata VALUES (?,?,?,?)
   ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(domain, key, JSON.stringify(value), Date.now());
  } finally {
    release();
  }
}

// src/core/metadata-import.ts
import { createHash as createHash2, randomUUID as randomUUID5 } from "node:crypto";
import { appendFileSync, closeSync as closeSync4, existsSync as existsSync4, lstatSync as lstatSync3, mkdirSync as mkdirSync5, openSync as openSync4, readFileSync as readFileSync4, readSync, readdirSync as readdirSync4, renameSync as renameSync3 } from "node:fs";
import { dirname as dirname5, join as join5, relative } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
var LIMIT = 64 * 1024 * 1024;
var hash = (bytes) => createHash2("sha256").update(bytes).digest("hex");
function retainMetadataFiles(home, files, project) {
  const release = storageLease(home);
  try {
    return retainFiles(home, files, project);
  } finally {
    release();
  }
}
function retainFiles(home, files, project) {
  assertMetadataAdmission(home);
  const db = metadataDb(home), bundles = [];
  const pending = [];
  const flush = () => {
    if (!pending.length) return;
    const id = randomUUID5(), bundleDir = join5(home, "cold", "bundles"), originals = join5(home, "cold", "originals", id);
    physicalMetadataPath(bundleDir);
    physicalMetadataPath(originals);
    mkdirSync5(bundleDir, { recursive: true, mode: 448 });
    const packed = { version: 1, entries: pending.map((p) => p.entry) };
    const compressed = gzipSync(Buffer.from(JSON.stringify(packed)));
    db.exec("BEGIN IMMEDIATE");
    let bundle;
    let offset;
    try {
      const current = db.prepare("SELECT value FROM bridge_metadata WHERE domain='bundle-current' AND key='metadata'").get();
      const saved = current ? JSON.parse(String(current.value)) : null;
      bundle = saved?.path ?? join5(bundleDir, `metadata-v1-${id}.frames.gz`);
      physicalMetadataPath(bundle);
      offset = existsSync4(bundle) ? lstatSync3(bundle).size : 0;
      if (offset + compressed.length > LIMIT) {
        bundle = join5(bundleDir, `metadata-v1-${id}.frames.gz`);
        offset = 0;
      }
      appendFileSync(bundle, compressed, { mode: 384, flush: true });
      const restored = readBundleFrame(bundle, offset, compressed.length);
      if (restored.version !== 1 || restored.entries.length !== pending.length) throw new Error("Bundle round trip failed; originals retained.");
      restored.entries.forEach((entry, i) => {
        const raw = Buffer.from(entry.data, "base64"), source = pending[i];
        if (entry.path !== source.entry.path || raw.length !== entry.bytes || hash(raw) !== entry.sha256 || !raw.equals(source.raw)) throw new Error("Bundle byte verification failed; originals retained.");
      });
      for (const source of pending) {
        project(db, source.entry.path, source.raw);
        db.prepare(`INSERT INTO bridge_imports VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO NOTHING`).run(source.entry.path, source.entry.sha256, source.raw.length, bundle, join5(originals, source.entry.path), Date.now());
        db.prepare("INSERT INTO bridge_metadata VALUES ('bundle-entry',?,?,?) ON CONFLICT(domain,key) DO NOTHING").run(source.entry.path, JSON.stringify({ bundle, offset, length: compressed.length }), Date.now());
      }
      db.prepare("INSERT INTO bridge_metadata VALUES ('bundle-current','metadata',?,?) ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(JSON.stringify({ path: bundle }), Date.now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    for (const source of pending) {
      physicalMetadataPath(source.file);
      const stat = lstatSync3(source.file);
      if (`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` !== source.signature || !readFileSync4(source.file).equals(source.raw)) throw new Error(`Import source changed; retained at ${source.file}`);
      const cold = String(db.prepare("SELECT cold_path FROM bridge_imports WHERE path=?").get(source.entry.path).cold_path);
      physicalMetadataPath(cold);
      mkdirSync5(dirname5(cold), { recursive: true, mode: 448 });
      renameSync3(source.file, cold);
    }
    bundles.push(bundle);
    pending.length = 0;
  };
  let size = 0;
  for (const file of files) {
    physicalMetadataPath(file);
    const path = relative(home, file).replace(/\\/g, "/");
    if (path.startsWith("../") || path === "..") throw new Error("Import path escapes bridge home.");
    const stat = lstatSync3(file);
    if (!stat.isFile() || stat.size > LIMIT) throw new Error(`Import source exceeds bounded bundle size; retained: ${file}`);
    const raw = readFileSync4(file), sha256 = hash(raw);
    const prior = db.prepare("SELECT sha256,cold_path FROM bridge_imports WHERE path=?").get(path);
    if (prior) {
      if (prior.sha256 !== sha256) throw new Error(`Imported source changed; retained: ${file}`);
      const cold = String(prior.cold_path);
      physicalMetadataPath(cold);
      if (existsSync4(cold)) throw new Error(`Both original and cold source exist; retained: ${file}`);
      mkdirSync5(dirname5(cold), { recursive: true, mode: 448 });
      renameSync3(file, cold);
      continue;
    }
    if (size + raw.length > LIMIT) {
      flush();
      size = 0;
    }
    pending.push({ file, raw, entry: { path, bytes: raw.length, sha256, data: raw.toString("base64") }, signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` });
    size += raw.length;
  }
  flush();
  return bundles;
}
function readBundleFrame(file, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || length > LIMIT * 2) throw new Error("Invalid bundle frame bounds");
  physicalMetadataPath(file);
  const fd = openSync4(file, "r"), compressed = Buffer.alloc(length);
  try {
    let at = 0;
    while (at < length) {
      const n = readSync(fd, compressed, at, length - at, offset + at);
      if (!n) throw new Error("Incomplete retained bundle frame");
      at += n;
    }
  } finally {
    closeSync4(fd);
  }
  return JSON.parse(gunzipSync(compressed, { maxOutputLength: LIMIT * 2 }).toString("utf8"));
}
function importMetadataDomain(home, domain, extension = ".json", nested = false) {
  const db = metadataDb(home), component = `import:${domain}`;
  if (db.prepare("SELECT 1 FROM bridge_components WHERE name=?").get(component)) return;
  const root = join5(home, domain), files = [];
  physicalMetadataPath(root);
  if (existsSync4(root)) for (const name of readdirSync4(root)) {
    const path = join5(root, name);
    physicalMetadataPath(path);
    if (lstatSync3(path).isFile() && name.endsWith(extension)) files.push(path);
    else if (nested && /^[a-f0-9]{64}$/.test(name) && lstatSync3(path).isDirectory()) {
      for (const file of readdirSync4(path)) if (file.endsWith(extension)) files.push(join5(path, file));
    }
  }
  retainMetadataFiles(home, files, (store, path, raw) => {
    const key = path.slice(domain.length + 1).slice(0, -extension.length);
    let value;
    try {
      value = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    store.prepare("INSERT INTO bridge_metadata VALUES (?,?,?,?) ON CONFLICT(domain,key) DO NOTHING").run(domain, key, JSON.stringify(value), Date.now());
  });
  db.prepare("INSERT INTO bridge_components VALUES (?,1) ON CONFLICT(name) DO NOTHING").run(component);
}

// src/core/store-compatibility.ts
var identities = /* @__PURE__ */ new Map();
var refreshes = /* @__PURE__ */ new Map();
var IDENTITY_REFRESH_MS = 1e4;
function databasePresence(home) {
  const db = existingMetadataDb(home);
  if (!db?.prepare("SELECT 1 FROM bridge_components WHERE name='import:storage-capabilities'").get()) return void 0;
  return db.prepare("SELECT key,value FROM bridge_metadata WHERE domain='storage-capabilities'").all().filter((row) => /^\d+$/.test(String(row.key))).map((row) => ({ record: JSON.parse(String(row.value)), signature: String(row.value) }));
}
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
  return new Promise((resolve3, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    ready.then(() => {
      signal.removeEventListener("abort", abort);
      resolve3();
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
    const dir = join6(home, "storage-capabilities");
    const stored = databasePresence(home);
    const records = stored ? stored.flatMap(({ record, signature }) => {
      const path = join6(dir, `${record.pid}.json`), cached = identities.get(path);
      return !cached || cached.signature !== signature || Date.now() - cached.at >= IDENTITY_REFRESH_MS ? [{ pid: record.pid, path, signature }] : [];
    }) : existsSync5(dir) ? readdirSync5(dir).filter((file) => /^\d+\.json$/.test(file)).flatMap((file) => {
      const path = join6(dir, file), signature = presenceSignature(path), cached = identities.get(path);
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
function cachedIdentity(home, pid, observedSignature) {
  if (pid === process.pid) return processIdentity(pid);
  const path = join6(home, "storage-capabilities", `${pid}.json`), cached = identities.get(path);
  const stored = observedSignature === void 0 ? databasePresence(home) : void 0;
  const signature = observedSignature ?? (stored ? stored.find((entry) => entry.record.pid === pid)?.signature : presenceSignature(path));
  return cached && cached.signature === signature && Date.now() - cached.at < IDENTITY_REFRESH_MS ? cached.identity ?? void 0 : void 0;
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
  const ready = databasePresence(home);
  if (ready || /^0\.30\.(?:[4-9]|[1-9]\d+)$/.test(peer.version ?? "")) {
    try {
      metadataDb(home);
      importMetadataDomain(home, "storage-capabilities");
      const explicit2 = validStoreCapabilities(peer.storeCapabilities), caps2 = explicit2 ? peer.storeCapabilities : releasedStoreCapabilities(peer.version);
      const prior = databasePresence(home)?.find((entry) => entry.record.pid === peer.pid)?.record;
      let identity2 = cachedIdentity(home, peer.pid);
      if (prior?.explicit && (!identity2 || prior.processIdentity === identity2)) {
        if (!explicit2) return;
        if (!options.authoritative && prior.version === (peer.version ?? "unknown") && prior.json === caps2.json && prior.sqlite === caps2.sqlite) return;
        identity2 ??= prior.processIdentity;
      }
      saveMetadataValue(home, "storage-capabilities", String(peer.pid), { schemaVersion: 1, ...caps2, pid: peer.pid, name: peer.name, version: peer.version ?? "unknown", explicit: explicit2, observedAt: Date.now(), ...identity2 ? { processIdentity: identity2 } : {} });
      if (!identity2) void refreshStorePeerIdentities(home).catch(() => {
      });
      return;
    } catch (error) {
      if (ready || error.code !== "STORE_UPGRADE_DEFERRED") throw error;
    }
  }
  const explicit = validStoreCapabilities(peer.storeCapabilities);
  const path = join6(home, "storage-capabilities", `${peer.pid}.json`);
  let identity = cachedIdentity(home, peer.pid);
  if (!identity) void refreshStorePeerIdentities(home).catch(() => {
  });
  if (explicit && existsSync5(path)) {
    try {
      const previous = JSON.parse(readFileSync5(path, "utf8"));
      if (previous.explicit && validStoreCapabilities(previous) && previous.pid === peer.pid && previous.version === (peer.version ?? "unknown") && previous.json === peer.storeCapabilities.json && previous.sqlite === peer.storeCapabilities.sqlite && (!identity || previous.processIdentity === identity)) {
        if (!options.authoritative || previous.name === peer.name) return;
        identity ??= previous.processIdentity;
      }
    } catch {
    }
  }
  if (!explicit && existsSync5(path)) {
    try {
      const previous = JSON.parse(readFileSync5(path, "utf8"));
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
  const stored = databasePresence(home);
  if (stored) {
    void refreshStorePeerIdentities(home).catch(() => {
    });
    return stored.flatMap(({ record, signature }) => {
      try {
        process.kill(record.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") return [];
      }
      const identity = cachedIdentity(home, record.pid, signature);
      if (identity && record.processIdentity && record.processIdentity !== identity) return [];
      if (identity && record.processIdentity === identity && validStoreCapabilities(record)) return [record];
      return [{ pid: record.pid, name: record.name ?? `pid ${record.pid}`, version: "unknown", json: 0, sqlite: 0, explicit: false }];
    });
  }
  const dir = join6(home, "storage-capabilities");
  if (!existsSync5(dir)) return [];
  void refreshStorePeerIdentities(home).catch(() => {
  });
  return readdirSync5(dir).filter((file) => /^\d+\.json$/.test(file)).flatMap((file) => {
    const pid = Number(file.slice(0, -5));
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return [];
    }
    try {
      const path = join6(dir, file), signature = presenceSignature(path);
      const record = JSON.parse(readFileSync5(path, "utf8"));
      if (signature !== presenceSignature(path)) throw new Error("Store reader presence changed during observation");
      const identity = cachedIdentity(home, pid);
      if (identity && typeof record.processIdentity === "string" && record.processIdentity !== identity) return [];
      if (identity && !record.processIdentity && legacyPidReused(identity, statSync(join6(dir, file)).mtimeMs)) return [];
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

export {
  storageLease,
  maintenanceLock,
  parentProcessIdentity,
  readProcessIdentity,
  processIdentity,
  isProcessIdentityAlive,
  readMetadataLeaseOwner,
  metadataFileLease,
  physicalMetadataPath,
  metadataDb,
  closeMetadataDb,
  retainMetadataReader,
  metadataValue,
  saveMetadataValue,
  retainMetadataFiles,
  importMetadataDomain,
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
