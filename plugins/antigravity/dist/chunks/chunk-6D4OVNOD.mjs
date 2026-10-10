import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  atomicPluginWrite,
  isProcessIdentityAlive,
  processIdentity,
  processStartMs,
  readProcessIdentities,
  readProcessIdentitiesSync,
  readProcessIdentity,
  recordedOwnerLiveness
} from "./chunk-VBHAVRFY.mjs";
import {
  ENV,
  LOG_DIR_NAME,
  LOG_FILE_NAME
} from "./chunk-DLCSA3SJ.mjs";

// src/core/storage-lock.ts
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

// src/core/boot-time.ts
import { uptime } from "node:os";
var BOOT_MARGIN_MS = 6e4;
function writtenBeforeBoot(at, now = Date.now(), upSeconds = uptime()) {
  return Number.isFinite(at) && at > 0 && at < now - upSeconds * 1e3 - BOOT_MARGIN_MS;
}
function ownerGone({ alive, recordedAt }) {
  if (alive !== void 0) return !alive;
  return recordedAt !== void 0 && writtenBeforeBoot(recordedAt);
}

// src/core/storage-lock.ts
var LOCK_FILE = ".maintenance-lock";
var USERS_DIR = ".storage-users";
var SCOPED_STORE_DIRS = /* @__PURE__ */ new Set(["runs", "jobs", "job-outcomes", "worktree-state", "permission-repairs"]);
var NESTED_STORE_DIRS = /* @__PURE__ */ new Set(["local-result-receipts"]);
var START_SLACK_MS = 2e3;
function writeOwner(path) {
  const owner = { pid: process.pid, nonce: randomUUID(), createdAt: Date.now() };
  const fd = openSync(path, "wx", 384);
  try {
    writeSync(fd, JSON.stringify(owner));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return owner;
}
function readOwner(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.nonce !== "string" || !Number.isFinite(value.createdAt)) return null;
    return value;
  } catch {
    return null;
  }
}
function ownerGone2(pid, createdAt) {
  if (pid === process.pid) return false;
  let alive;
  try {
    process.kill(pid, 0);
    const started = processStartMs(pid);
    alive = started === void 0 ? void 0 : started <= createdAt + START_SLACK_MS;
  } catch (err) {
    alive = err.code === "ESRCH" ? false : void 0;
  }
  return ownerGone({ alive, recordedAt: createdAt });
}
function recoverStaleLock(path) {
  const owner = readOwner(path);
  if (!owner || !ownerGone2(owner.pid, owner.createdAt)) return false;
  const moved = `${path}.stale-${randomUUID()}`;
  try {
    renameSync(path, moved);
  } catch (err) {
    return err.code === "ENOENT";
  }
  if (readOwner(moved)?.nonce !== owner.nonce) {
    try {
      linkSync(moved, path);
      rmSync(moved, { force: true });
    } catch {
    }
    return false;
  }
  rmSync(moved, { force: true });
  return true;
}
function maintenanceBusy(path) {
  const owner = readOwner(path);
  const who = owner ? `held by pid ${owner.pid} since ${new Date(owner.createdAt).toISOString()}` : "owner unknown (written by an older version)";
  return new Error(`storage maintenance is in progress (${who}); if no agent-bridge maintenance command is running, delete ${path}`);
}
function storageLease(home) {
  const lock = join(home, LOCK_FILE);
  if (existsSync(lock) && !recoverStaleLock(lock) && existsSync(lock)) throw maintenanceBusy(lock);
  const dir = join(home, USERS_DIR);
  mkdirSync(dir, { recursive: true, mode: 448 });
  const path = join(dir, `${process.pid}-${randomUUID()}`);
  writeOwner(path);
  if (existsSync(lock)) {
    rmSync(path);
    throw maintenanceBusy(lock);
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
  let owner;
  try {
    owner = writeOwner(path);
  } catch (err) {
    if (err.code !== "EEXIST" || !recoverStaleLock(path)) throw err.code === "EEXIST" ? maintenanceBusy(path) : err;
    owner = writeOwner(path);
  }
  const release = () => {
    if (readOwner(path)?.nonce === owner.nonce) rmSync(path, { force: true });
  };
  try {
    const dir = join(home, USERS_DIR);
    for (const file of existsSync(dir) ? readdirSync(dir) : []) {
      const lease = join(dir, file);
      const pid = Number(file.split("-")[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`unknown storage lease ${lease}; stop all bridge processes first`);
      let createdAt = readOwner(lease)?.createdAt;
      if (createdAt === void 0) {
        try {
          createdAt = statSync(lease).mtimeMs;
        } catch (err) {
          if (err.code === "ENOENT") continue;
          throw err;
        }
      }
      if (ownerGone2(pid, createdAt)) {
        rmSync(lease, { force: true });
        continue;
      }
      throw new Error(`storage is in use by pid ${pid} (lease ${lease}); stop all bridge processes before restore or repair`);
    }
    return release;
  } catch (err) {
    release();
    throw err;
  }
}

// src/core/metadata-db.ts
import { randomUUID as randomUUID7 } from "node:crypto";
import { existsSync as existsSync9, lstatSync as lstatSync4, mkdirSync as mkdirSync8 } from "node:fs";
import { dirname as dirname8, join as join10, resolve as resolve3 } from "node:path";
import { DatabaseSync as DatabaseSync5 } from "node:sqlite";

// src/core/metadata-file-lease.ts
import { createHash as createHash4, randomUUID as randomUUID6 } from "node:crypto";
import { closeSync as closeSync6, fsyncSync as fsyncSync4, linkSync as linkSync2, lstatSync as lstatSync3, mkdirSync as mkdirSync7, openSync as openSync6, readFileSync as readFileSync7, readdirSync as readdirSync5, renameSync as renameSync5, writeFileSync as writeFileSync4 } from "node:fs";
import { basename as basename3, dirname as dirname7, join as join9, resolve as resolve2 } from "node:path";

// src/core/json-store.ts
import { randomUUID as randomUUID5 } from "node:crypto";
import { closeSync as closeSync5, copyFileSync as copyFileSync2, existsSync as existsSync7, fsyncSync as fsyncSync3, mkdirSync as mkdirSync6, openSync as openSync5, readFileSync as readFileSync6, readdirSync as readdirSync4, renameSync as renameSync4, rmSync as rmSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { basename as basename2, dirname as dirname6, join as join8 } from "node:path";

// src/core/store-compatibility.ts
import { existsSync as existsSync3, readdirSync as readdirSync3, readFileSync as readFileSync3, statSync as statSync3 } from "node:fs";
import { join as join3 } from "node:path";

// src/core/metadata-import.ts
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import { appendFileSync, closeSync as closeSync2, existsSync as existsSync2, lstatSync, mkdirSync as mkdirSync2, openSync as openSync2, readFileSync as readFileSync2, readSync, readdirSync as readdirSync2, renameSync as renameSync2, statSync as statSync2 } from "node:fs";
import { dirname as dirname2, join as join2, relative, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
var LIMIT = 64 * 1024 * 1024;
var hash = (bytes2) => createHash("sha256").update(bytes2).digest("hex");
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
    const id = randomUUID2(), bundleDir = join2(home, "cold", "bundles"), originals = join2(home, "cold", "originals", id);
    physicalMetadataPath(bundleDir);
    physicalMetadataPath(originals);
    mkdirSync2(bundleDir, { recursive: true, mode: 448 });
    const packed = { version: 1, entries: pending.map((p) => p.entry) };
    const compressed = gzipSync(Buffer.from(JSON.stringify(packed)));
    db.exec("BEGIN IMMEDIATE");
    let bundle;
    let offset;
    try {
      const current = db.prepare("SELECT value FROM bridge_metadata WHERE domain='bundle-current' AND key='metadata'").get();
      const saved = current ? JSON.parse(String(current.value)) : null;
      bundle = saved?.path ?? join2(bundleDir, `metadata-v1-${id}.frames.gz`);
      physicalMetadataPath(bundle);
      offset = existsSync2(bundle) ? lstatSync(bundle).size : 0;
      if (offset + compressed.length > LIMIT) {
        bundle = join2(bundleDir, `metadata-v1-${id}.frames.gz`);
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
        project(db, source.entry.path, source.raw, join2(originals, source.entry.path));
        db.prepare(`INSERT INTO bridge_imports VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO NOTHING`).run(source.entry.path, source.entry.sha256, source.raw.length, bundle, join2(originals, source.entry.path), Date.now());
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
      const stat = lstatSync(source.file);
      if (`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` !== source.signature || !readFileSync2(source.file).equals(source.raw)) throw new Error(`Import source changed; retained at ${source.file}`);
      const cold = String(db.prepare("SELECT cold_path FROM bridge_imports WHERE path=?").get(source.entry.path).cold_path);
      physicalMetadataPath(cold);
      mkdirSync2(dirname2(cold), { recursive: true, mode: 448 });
      renameSync2(source.file, cold);
    }
    bundles.push(bundle);
    pending.length = 0;
  };
  let size = 0;
  for (const file of files) {
    physicalMetadataPath(file);
    const path = relative(home, file).replace(/\\/g, "/");
    if (path.startsWith("../") || path === "..") throw new Error("Import path escapes bridge home.");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > LIMIT) throw new Error(`Import source exceeds bounded bundle size; retained: ${file}`);
    const raw = readFileSync2(file), sha256 = hash(raw);
    const prior = db.prepare("SELECT sha256,cold_path FROM bridge_imports WHERE path=?").get(path);
    if (prior) {
      if (prior.sha256 !== sha256) throw new Error(`Imported source changed; retained: ${file}`);
      const cold = String(prior.cold_path);
      physicalMetadataPath(cold);
      if (existsSync2(cold)) throw new Error(`Both original and cold source exist; retained: ${file}`);
      mkdirSync2(dirname2(cold), { recursive: true, mode: 448 });
      renameSync2(file, cold);
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
  const fd = openSync2(file, "r"), compressed = Buffer.alloc(length);
  try {
    let at = 0;
    while (at < length) {
      const n = readSync(fd, compressed, at, length - at, offset + at);
      if (!n) throw new Error("Incomplete retained bundle frame");
      at += n;
    }
  } finally {
    closeSync2(fd);
  }
  return JSON.parse(gunzipSync(compressed, { maxOutputLength: LIMIT * 2 }).toString("utf8"));
}
function repairImportedTimes(db, domain) {
  const marker = `repair:import-times:${domain}`;
  if (db.prepare("SELECT 1 FROM bridge_components WHERE name=?").get(marker)) return;
  const rows = db.prepare("SELECT m.key AS key, m.updated_at AS updated, i.imported_at AS imported, i.cold_path AS cold FROM bridge_metadata m JOIN bridge_imports i ON i.path = ? || '/' || m.key || '.json' WHERE m.domain = ?").all(domain, domain);
  const update = db.prepare("UPDATE bridge_metadata SET updated_at=? WHERE domain=? AND key=? AND updated_at=?");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const updated = Number(row.updated), imported = Number(row.imported);
      if (!Number.isFinite(updated) || !Number.isFinite(imported) || Math.abs(updated - imported) > 6e4) continue;
      let at;
      try {
        at = statSync2(String(row.cold)).mtimeMs;
      } catch {
        continue;
      }
      if (at < updated) update.run(Math.round(at), domain, String(row.key), row.updated);
    }
    db.prepare("INSERT INTO bridge_components VALUES (?,1) ON CONFLICT(name) DO NOTHING").run(marker);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
function importMetadataDomain(home, domain, extension = ".json", nested = false) {
  const db = metadataDb(home), component = `import:${domain}`;
  if (db.prepare("SELECT 1 FROM bridge_components WHERE name=?").get(component)) {
    if (domain === "storage-capabilities") repairImportedTimes(db, domain);
    return;
  }
  const root = join2(home, domain), files = [];
  physicalMetadataPath(root);
  if (existsSync2(root)) for (const name of readdirSync2(root)) {
    const path = join2(root, name);
    physicalMetadataPath(path);
    if (lstatSync(path).isFile() && name.endsWith(extension)) files.push(path);
    else if (nested && /^[a-f0-9]{64}$/.test(name) && lstatSync(path).isDirectory()) {
      for (const file of readdirSync2(path)) if (file.endsWith(extension)) files.push(join2(path, file));
    }
  }
  const writtenAt = new Map(files.map((file) => [resolve(file).toLowerCase(), statSync2(file).mtimeMs]));
  retainMetadataFiles(home, files, (store, path, raw) => {
    const key = path.slice(domain.length + 1).slice(0, -extension.length);
    const at = Math.round(writtenAt.get(resolve(home, path).toLowerCase()) ?? Date.now());
    let value;
    try {
      value = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    store.prepare("INSERT INTO bridge_metadata VALUES (?,?,?,?) ON CONFLICT(domain,key) DO NOTHING").run(domain, key, JSON.stringify(value), at);
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
  return db.prepare("SELECT key,value,updated_at FROM bridge_metadata WHERE domain='storage-capabilities'").all().filter((row) => /^\d+$/.test(String(row.key))).map((row) => ({ record: JSON.parse(String(row.value)), signature: String(row.value), at: Number(row.updated_at) }));
}
function presenceSignature(path) {
  try {
    const stat = statSync3(path);
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return void 0;
  }
}
function refreshStorePeerIdentities(home, signal) {
  signal?.throwIfAborted();
  const ready = refreshIdentityCache(home);
  if (!signal) return ready;
  return new Promise((resolve4, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    ready.then(() => {
      signal.removeEventListener("abort", abort);
      resolve4();
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
    const dir = join3(home, "storage-capabilities");
    const stored = databasePresence(home);
    const records = stored ? stored.flatMap(({ record: record2, signature }) => {
      const path = join3(dir, `${record2.pid}.json`), cached = identities.get(path);
      return !cached || cached.signature !== signature || Date.now() - cached.at >= IDENTITY_REFRESH_MS ? [{ pid: record2.pid, path, signature }] : [];
    }) : existsSync3(dir) ? readdirSync3(dir).filter((file) => /^\d+\.json$/.test(file)).flatMap((file) => {
      const path = join3(dir, file), signature = presenceSignature(path), cached = identities.get(path);
      return signature && (!cached || cached.signature !== signature || Date.now() - cached.at >= IDENTITY_REFRESH_MS) ? [{ pid: Number(file.slice(0, -5)), path, signature }] : [];
    }) : [];
    if (!records.length) return;
    let failed = false;
    const refresh = (async () => {
      let current;
      try {
        current = await readProcessIdentities(records.filter((record2) => record2.pid !== process.pid).map((record2) => record2.pid));
      } catch {
        failed = true;
        for (const { path } of records) {
          const cached = identities.get(path);
          if (cached) identities.set(path, { ...cached, at: Date.now() });
        }
        return;
      }
      for (const { pid, path, signature } of records) identities.set(path, { identity: pid === process.pid ? processIdentity(pid) ?? null : current.get(pid) ?? null, at: Date.now(), signature });
    })();
    refreshes.set(home, refresh);
    try {
      await refresh;
    } finally {
      refreshes.delete(home);
    }
    if (failed) return;
  }
}
function cachedIdentity(home, pid, observedSignature) {
  if (pid === process.pid) return processIdentity(pid);
  const path = join3(home, "storage-capabilities", `${pid}.json`), cached = identities.get(path);
  const stored = observedSignature === void 0 ? databasePresence(home) : void 0;
  const signature = observedSignature ?? (stored ? stored.find((entry) => entry.record.pid === pid)?.signature : presenceSignature(path));
  return cached && cached.signature === signature ? cached.identity ?? void 0 : void 0;
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
  return Boolean(v && Number.isSafeInteger(v.json) && v.json >= 0 && Number.isSafeInteger(v.sqlite) && v.sqlite >= 0 && (v.jobArchive === void 0 || Number.isSafeInteger(v.jobArchive) && v.jobArchive >= 0));
}
function recordStorePeer(home, peer, options = {}) {
  if (peer.host || !Number.isSafeInteger(peer.pid) || peer.pid <= 0) return;
  const ready = databasePresence(home);
  if (ready || metadataRelease(peer.version)) {
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
      if (ready || !["STORE_UPGRADE_DEFERRED", "ELEASEBUSY"].includes(String(error.code))) throw error;
    }
  }
  const explicit = validStoreCapabilities(peer.storeCapabilities);
  const path = join3(home, "storage-capabilities", `${peer.pid}.json`);
  let identity = cachedIdentity(home, peer.pid);
  if (!identity) void refreshStorePeerIdentities(home).catch(() => {
  });
  if (explicit && existsSync3(path)) {
    try {
      const previous = JSON.parse(readFileSync3(path, "utf8"));
      if (previous.explicit && validStoreCapabilities(previous) && previous.pid === peer.pid && previous.version === (peer.version ?? "unknown") && previous.json === peer.storeCapabilities.json && previous.sqlite === peer.storeCapabilities.sqlite && previous.jobArchive === peer.storeCapabilities.jobArchive && (!identity || previous.processIdentity === identity)) {
        if (!options.authoritative || previous.name === peer.name) return;
        identity ??= previous.processIdentity;
      }
    } catch {
    }
  }
  if (!explicit && existsSync3(path)) {
    try {
      const previous = JSON.parse(readFileSync3(path, "utf8"));
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
    return stored.flatMap(({ record: record2, signature, at }) => {
      if (writtenBeforeBoot(at)) return [];
      try {
        process.kill(record2.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") return [];
      }
      const identity = cachedIdentity(home, record2.pid, signature);
      if (identity && record2.processIdentity && record2.processIdentity !== identity) return [];
      const observed = !record2.processIdentity && typeof record2.observedAt === "number";
      if (identity && !record2.processIdentity && legacyPidReused(identity, observed ? record2.observedAt : at)) return [];
      if (identity && (record2.processIdentity === identity || observed) && validStoreCapabilities(record2)) return [record2];
      return [{ pid: record2.pid, name: record2.name ?? `pid ${record2.pid}`, version: "unknown", json: 0, sqlite: 0, explicit: false }];
    });
  }
  const dir = join3(home, "storage-capabilities");
  if (!existsSync3(dir)) return [];
  void refreshStorePeerIdentities(home).catch(() => {
  });
  return readdirSync3(dir).filter((file) => /^\d+\.json$/.test(file)).flatMap((file) => {
    const pid = Number(file.slice(0, -5));
    try {
      if (writtenBeforeBoot(statSync3(join3(dir, file)).mtimeMs)) return [];
    } catch {
    }
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return [];
    }
    try {
      const path = join3(dir, file), signature = presenceSignature(path);
      const record2 = JSON.parse(readFileSync3(path, "utf8"));
      if (signature !== presenceSignature(path)) throw new Error("Store reader presence changed during observation");
      const identity = cachedIdentity(home, pid);
      if (identity && typeof record2.processIdentity === "string" && record2.processIdentity !== identity) return [];
      if (identity && !record2.processIdentity && legacyPidReused(identity, statSync3(join3(dir, file)).mtimeMs)) return [];
      if (identity && record2.schemaVersion === 1 && record2.pid === pid && validStoreCapabilities(record2)) return [record2];
    } catch {
    }
    return [{ pid, name: `pid ${pid}`, version: "unknown", json: 0, sqlite: 0, explicit: false }];
  });
}
function metadataRelease(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version ?? "");
  if (!m) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return major > 0 || minor > 30 || minor === 30 && patch >= 4;
}
function legacyStorePeers(home) {
  const stored = databasePresence(home);
  if (stored) void refreshStorePeerIdentities(home).catch(() => {
  });
  const records = stored ? stored.filter(({ record: record2, signature, at }) => {
    if (record2.pid === process.pid) return false;
    if (writtenBeforeBoot(at)) return false;
    try {
      process.kill(record2.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return false;
    }
    const identity = cachedIdentity(home, record2.pid, signature);
    if (identity && record2.processIdentity && record2.processIdentity !== identity) return false;
    if (identity && !record2.processIdentity && legacyPidReused(identity, typeof record2.observedAt === "number" ? record2.observedAt : at)) return false;
    return true;
  }).map((entry) => entry.record) : liveStorePeers(home).filter((peer) => peer.pid !== process.pid);
  return records.filter((peer) => !metadataRelease(peer.version)).map(({ pid, name, version }) => ({ pid, name: name ?? `pid ${pid}`, version: version ?? "unknown" }));
}
function exitedBehindHandle(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return ["EPERM", "ESRCH"].includes(String(error.code));
  }
}
function storedPresence(home, pid) {
  const stored = databasePresence(home);
  if (stored) return stored.find((entry) => entry.record.pid === pid)?.record;
  try {
    return JSON.parse(readFileSync3(join3(home, "storage-capabilities", `${pid}.json`), "utf8"));
  } catch {
    return void 0;
  }
}
function verifiedNow(home, peers, format, target) {
  const candidates = peers.flatMap((peer) => {
    const record2 = storedPresence(home, peer.pid);
    return record2?.processIdentity ? [{ pid: peer.pid, record: record2, identity: record2.processIdentity }] : [];
  });
  if (!candidates.length) return /* @__PURE__ */ new Set();
  const live = readProcessIdentitiesSync(candidates.map((candidate) => candidate.pid));
  if (!live) return /* @__PURE__ */ new Set();
  return new Set(candidates.filter(({ pid, record: record2, identity }) => {
    const now = live.get(pid);
    if (now === void 0) return exitedBehindHandle(pid);
    if (now === "") return false;
    return now !== identity || validStoreCapabilities(record2) && (record2[format] ?? 0) >= target;
  }).map((candidate) => candidate.pid));
}
function assertStoreUpgrade(home, format, current, target) {
  if (target <= current) return;
  let blockers = liveStorePeers(home).filter((peer) => (peer[format] ?? 0) < target);
  const unverified = blockers.filter((peer) => peer.version === "unknown");
  if (unverified.length && unverified.length <= 64) {
    const verified = verifiedNow(home, unverified, format, target);
    blockers = blockers.filter((peer) => !verified.has(peer.pid));
  }
  if (!blockers.length) return;
  throw Object.assign(new Error(`Waiting to upgrade ${format} store ${current}\u2192${target}: ${blockers.map((p) => `${p.name} (v${p.version}, pid ${p.pid}, reads ${p[format]})`).join(", ")}. Existing sessions keep their code and data; retry when these readers finish naturally.`), { code: "STORE_UPGRADE_DEFERRED" });
}

// src/core/job-archive-index.ts
import { createHash as createHash3 } from "node:crypto";
import { existsSync as existsSync6, lstatSync as lstatSync2, mkdirSync as mkdirSync5, realpathSync, statSync as statSync7 } from "node:fs";
import { dirname as dirname5, join as join7 } from "node:path";
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";

// src/core/file-cache.ts
import { readFileSync as readFileSync4, statSync as statSync4 } from "node:fs";
var MAX_BYTES = 16 * 1024 * 1024;
var MAX_ENTRIES = 2048;
var cache = /* @__PURE__ */ new Map();
var damaged = /* @__PURE__ */ new Map();
var bytes = 0;
function estimatedJsonBytes(value, limit = MAX_BYTES) {
  const pending = [value];
  let total = 0;
  while (pending.length && total <= limit) {
    const item = pending.pop();
    if (typeof item === "string") total += 32 + item.length * 2;
    else if (Array.isArray(item)) {
      total += 64 + item.length * 16;
      for (const child of item) pending.push(child);
    } else if (item !== null && typeof item === "object") {
      total += 64;
      for (const key of Object.keys(item)) {
        total += 64 + key.length * 2;
        pending.push(item[key]);
      }
    } else total += 16;
  }
  return total;
}
function cloneJson(value) {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item));
  if (value !== null && typeof value === "object") {
    const copied = {};
    for (const key of Object.keys(value)) {
      const item = cloneJson(value[key]);
      if (key === "__proto__") Object.defineProperty(copied, key, { value: item, writable: true, configurable: true, enumerable: true });
      else copied[key] = item;
    }
    return copied;
  }
  return value;
}
function fileSignature(st) {
  return `${st.dev}:${st.ino}:${st.birthtimeMs}:${st.ctimeMs}:${st.mtimeMs}:${st.size}`;
}
function readJsonSnapshot(file, scan) {
  if (scan && scan.file !== file) throw new Error("JSON snapshot scan belongs to another file");
  const st = scan?.stat ?? statSync4(file), signature = fileSignature(st);
  const failure = damaged.get(file);
  if (failure?.signature === signature) throw failure.error;
  damaged.delete(file);
  const saved = cache.get(file);
  if (saved?.signature === signature) {
    cache.delete(file);
    cache.set(file, saved);
    return saved;
  }
  if (saved) {
    cache.delete(file);
    bytes -= saved.bytes;
  }
  let value;
  try {
    if (!scan) value = JSON.parse(readFileSync4(file, "utf8"));
    else {
      const raw = readFileSync4(file, "utf8");
      const after = statSync4(file);
      if (!after.isFile() || fileSignature(after) !== signature)
        throw new Error("JSON snapshot identity changed during read");
      value = JSON.parse(raw);
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      damaged.set(file, { signature, error });
      if (damaged.size > 128) damaged.delete(damaged.keys().next().value);
    }
    throw error;
  }
  const next = { signature, value, bytes: estimatedJsonBytes(value) };
  if (next.bytes <= MAX_BYTES) {
    cache.set(file, next);
    bytes += next.bytes;
    while (bytes > MAX_BYTES || cache.size > MAX_ENTRIES) {
      const first = cache.keys().next().value;
      bytes -= cache.get(first).bytes;
      cache.delete(first);
    }
  }
  return next;
}

// src/core/sqlite-migrations.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { createHash as createHash2, randomUUID as randomUUID4 } from "node:crypto";
import { closeSync as closeSync4, copyFileSync, fsyncSync as fsyncSync2, mkdirSync as mkdirSync4, openSync as openSync4, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, dirname as dirname4, join as join6 } from "node:path";

// src/core/sqlite-maintenance.ts
import { existsSync as existsSync4 } from "node:fs";
import { dirname as dirname3, join as join5 } from "node:path";
import { DatabaseSync } from "node:sqlite";

// src/core/logger.ts
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync3, renameSync as renameSync3, statSync as statSync5 } from "node:fs";
import { join as join4 } from "node:path";
var LOG_LEVELS = ["debug", "info", "warn", "error", "silent"];
var LEVEL_RANK = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
var DEFAULT_FILE_LEVEL = "info";
var DEFAULT_CONSOLE_LEVEL = "warn";
var MAX_LOG_BYTES = 5 * 1024 * 1024;
var ROTATE_CHECK_EVERY = 500;
function parseLevel(value, fallback) {
  const v = value?.trim().toLowerCase();
  return LOG_LEVELS.includes(v ?? "") ? v : fallback;
}
function serialize(data) {
  if (!data) return "";
  try {
    return " " + JSON.stringify(data, (_k, v) => v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v);
  } catch {
    return " [unserializable data]";
  }
}
function rotateIfNeeded(file) {
  try {
    if (statSync5(file).size > MAX_LOG_BYTES) renameSync3(file, `${file}.1`);
  } catch {
  }
}
function createLogger(opts) {
  const envLevel = process.env[ENV.logLevel];
  const sink = {
    fileLevel: opts.fileLevel ?? parseLevel(envLevel, DEFAULT_FILE_LEVEL),
    consoleLevel: opts.consoleLevel ?? parseLevel(process.env[ENV.logConsole] ?? envLevel, DEFAULT_CONSOLE_LEVEL),
    file: null,
    writes: 0
  };
  try {
    const dir = join4(opts.home, LOG_DIR_NAME);
    mkdirSync3(dir, { recursive: true });
    sink.file = join4(dir, LOG_FILE_NAME);
    rotateIfNeeded(sink.file);
  } catch (err) {
    process.stderr.write(`[${opts.component}] cannot open log directory, logging to stderr only: ${String(err)}
`);
  }
  return makeLogger(sink, opts.component);
}
function makeLogger(sink, scope) {
  const write = (level, msg, data) => {
    const rank = LEVEL_RANK[level];
    const toFile = sink.file !== null && rank >= LEVEL_RANK[sink.fileLevel];
    const toConsole = rank >= LEVEL_RANK[sink.consoleLevel];
    if (!toFile && !toConsole) return;
    const line = `${(/* @__PURE__ */ new Date()).toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] pid=${process.pid} ${msg}${serialize(data)}
`;
    if (toFile) {
      try {
        if (++sink.writes % ROTATE_CHECK_EVERY === 0) rotateIfNeeded(sink.file);
        appendFileSync2(sink.file, line);
      } catch {
      }
    }
    if (toConsole) process.stderr.write(line);
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
    child: (s) => makeLogger(sink, `${scope}:${s}`)
  };
}
var nullLogger = {
  debug: () => {
  },
  info: () => {
  },
  warn: () => {
  },
  error: () => {
  },
  child: () => nullLogger
};

// src/core/sqlite-policy.ts
import { setTimeout as delay } from "node:timers/promises";
var SQLITE_BUSY_TIMEOUT_MS = 3e3;
var SQLITE_REQUEST_BUSY_MS = 10;
function configureSqlite(db, busyTimeoutMs = SQLITE_BUSY_TIMEOUT_MS) {
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA journal_mode = WAL;`);
}
function isSqliteBusy(err) {
  const value = err;
  return value?.errcode === 5 || value?.errcode === 6 || /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(String(value?.code)) || /\bdatabase (?:is |table is |schema is )?locked\b|\bSQLITE_BUSY\b|\bSQLITE_LOCKED\b/i.test(String(value?.message));
}
async function retrySqlite(operation, timeoutMs = 8e3, signal) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (; ; ) {
    signal?.throwIfAborted();
    try {
      return operation();
    } catch (err) {
      if (!isSqliteBusy(err) || Date.now() >= deadline) throw err;
      await delay(Math.min(25 * 2 ** Math.min(attempt++, 4), Math.max(1, deadline - Date.now())), void 0, { signal });
    }
  }
}

// src/core/sqlite-maintenance.ts
var ARCHIVE_DB_NAME = "archive.db";
var ARCHIVE_STORE_VERSION = 1;
function checkDatabase(db) {
  const integrity = db.prepare("PRAGMA integrity_check").all().map((r) => String(r.integrity_check));
  const foreign = db.prepare("PRAGMA foreign_key_check").all();
  return [...integrity.filter((s) => s !== "ok"), ...foreign.map((r) => `foreign key: ${JSON.stringify(r)}`)];
}
function snapshotDatabase(source, target) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
  const copy = new DatabaseSync(target, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    const findings = checkDatabase(copy);
    if (findings.length) throw new Error(`invalid database backup: ${findings.join(", ")}`);
  } finally {
    copy.close();
  }
}
var ARCHIVE_SCHEMA = `
CREATE TABLE messages (
  id TEXT NOT NULL, recipient TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL,
  from_agent TEXT NOT NULL, to_target TEXT NOT NULL, conversation_id TEXT NOT NULL, reply_to TEXT,
  hop INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
  archive_reason TEXT NOT NULL, archived_at INTEGER NOT NULL,
  PRIMARY KEY (id, recipient)
);
CREATE INDEX idx_archive_created ON messages(created_at);
PRAGMA user_version = 1;
`;
function openArchive(path) {
  const existed = existsSync4(path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    migrateSqlite(db, path, existed, ARCHIVE_STORE_VERSION, [{ version: 1, sql: ARCHIVE_SCHEMA }], nullLogger);
    configureSqlite(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
function archiveDbPath(file) {
  return file === ":memory:" ? ":memory:" : join5(dirname3(file), ARCHIVE_DB_NAME);
}
function archiveMessages(source, archive, where, args, reason, table = "messages") {
  source.exec("BEGIN IMMEDIATE");
  try {
    const rows = source.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...args);
    archive.exec("BEGIN IMMEDIATE");
    try {
      const insert = archive.prepare("INSERT OR IGNORE INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const r of rows) {
        const existing = archive.prepare("SELECT * FROM messages WHERE id = ? AND recipient = ?").get(r.id, r.recipient);
        if (existing && Object.entries(r).some(([key, value]) => !["read_at", "archive_reason", "archived_at"].includes(key) && existing[key] !== value)) throw new Error("archive identity conflict; original message preserved");
        insert.run(r.id, r.recipient, r.from_id, r.from_name, r.from_agent, r.to_target, r.conversation_id, r.reply_to, r.hop, r.body, r.created_at, r.read_at, r.archive_reason ?? reason, r.archived_at ?? Date.now());
        if (existing && r.read_at !== null) archive.prepare("UPDATE messages SET read_at = COALESCE(read_at, ?) WHERE id = ? AND recipient = ?").run(r.read_at, r.id, r.recipient);
      }
      archive.exec("COMMIT");
    } catch (err) {
      archive.exec("ROLLBACK");
      throw err;
    }
    const count = Number(source.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...args).changes);
    source.exec("COMMIT");
    return count;
  } catch (err) {
    source.exec("ROLLBACK");
    throw err;
  }
}

// src/core/migration-lock.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { closeSync as closeSync3, existsSync as existsSync5, openSync as openSync3, readFileSync as readFileSync5, rmSync as rmSync2, statSync as statSync6, writeFileSync } from "node:fs";
function lockOwnerGone(path, verdicts) {
  let text, writtenAt;
  try {
    text = readFileSync5(path, "utf8");
    writtenAt = statSync6(path).mtimeMs;
  } catch {
    return null;
  }
  let owner;
  try {
    owner = JSON.parse(text);
  } catch {
    return false;
  }
  const pid = Number(owner.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return ownerGone({ alive: error.code === "ESRCH" ? false : void 0, recordedAt: writtenAt });
  }
  let gone = verdicts.get(text);
  if (gone === void 0) verdicts.set(text, gone = ownerGone({ alive: recordedOwnerLiveness(pid, typeof owner.identity === "string" ? owner.identity : void 0, writtenAt), recordedAt: writtenAt }));
  return gone;
}
function migrationLock(file) {
  if (file === ":memory:") return () => {
  };
  const path = `${file}.migration-lock`, recovery = `${path}.recovery`;
  const identity = processIdentity(process.pid);
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID3(), ...identity ? { identity } : {} });
  const until = Date.now() + 5e3;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const verdicts = /* @__PURE__ */ new Map();
  for (; ; ) {
    try {
      const fd = openSync3(path, "wx", 384);
      try {
        writeFileSync(fd, owner);
      } catch (error) {
        closeSync3(fd);
        rmSync2(path);
        throw error;
      }
      closeSync3(fd);
      return () => {
        if (readFileSync5(path, "utf8") === owner) rmSync2(path);
      };
    } catch (error) {
      if (!["EEXIST", "EPERM", "EBUSY", "EACCES"].includes(error.code ?? "")) throw error;
    }
    let recoveryFd;
    try {
      if (existsSync5(path) && lockOwnerGone(path, verdicts)) {
        recoveryFd = openSync3(recovery, "wx", 384);
        if (existsSync5(path) && lockOwnerGone(path, verdicts)) rmSync2(path);
      }
    } catch (error) {
      if (!["EEXIST", "ENOENT", "EPERM", "EBUSY", "EACCES"].includes(error.code ?? "")) throw error;
    } finally {
      if (recoveryFd !== void 0) {
        closeSync3(recoveryFd);
        rmSync2(recovery);
      }
    }
    if (Date.now() >= until) throw Object.assign(new Error("another session is migrating this store; waiting for its protected snapshot and commit"), { code: "EBUSY" });
    Atomics.wait(pause, 0, 0, 20);
  }
}

// src/core/sqlite-migrations.ts
var MAX_SNAPSHOT_ATTEMPTS = 10;
function metadataSnapshot(db, path, tables, version, target) {
  const snapshot = new DatabaseSync2(path);
  const quote2 = (name) => `"${name.replaceAll('"', '""')}"`;
  const digest = (row) => JSON.stringify(row, (_, value) => typeof value === "bigint" ? { bigint: String(value) } : value);
  const manifest = {
    version: 1,
    kind: "sqlite-migration-metadata",
    sourceVersion: version,
    targetVersion: target,
    schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    tables: []
  };
  try {
    snapshot.exec("BEGIN");
    for (const table of tables) {
      const schema2 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!schema2 || typeof schema2.sql !== "string") throw new Error(`Missing migration snapshot table: ${table}`);
      snapshot.exec(schema2.sql);
      const source = db.prepare(`SELECT rowid AS __migration_rowid__, * FROM ${quote2(table)} ORDER BY rowid`);
      source.setReadBigInts(true);
      const columns = db.prepare(`PRAGMA table_info(${quote2(table)})`).all().map((row) => String(row.name));
      const insert = snapshot.prepare(`INSERT INTO ${quote2(table)} (rowid,${columns.map(quote2).join(",")}) VALUES (${["rowid", ...columns].map(() => "?").join(",")})`);
      const expected = createHash2("sha256");
      let rows = 0;
      for (const row of source.iterate()) {
        insert.run(row.__migration_rowid__, ...columns.map((name) => row[name]));
        expected.update(digest(row));
        rows++;
      }
      const actual = createHash2("sha256");
      const verify = snapshot.prepare(`SELECT rowid AS __migration_rowid__, * FROM ${quote2(table)} ORDER BY rowid`);
      verify.setReadBigInts(true);
      let verified = 0;
      for (const row of verify.iterate()) {
        actual.update(digest(row));
        verified++;
      }
      const sha256 = expected.digest("hex");
      if (rows !== verified || actual.digest("hex") !== sha256) throw new Error(`Migration metadata snapshot verification failed: ${table}`);
      manifest.tables.push({ name: table, rows, sha256 });
    }
    snapshot.exec(`PRAGMA user_version=${version}; COMMIT`);
    if (snapshot.prepare("PRAGMA integrity_check").all().some((row) => row.integrity_check !== "ok")) throw new Error(`Invalid metadata migration snapshot: ${path}`);
    writeFileSync2(`${path}.manifest.json`, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 384 });
    const manifestFile = openSync4(`${path}.manifest.json`, "r+");
    try {
      fsyncSync2(manifestFile);
    } finally {
      closeSync4(manifestFile);
    }
  } finally {
    snapshot.close();
  }
}
function migrateSqlite(db, file, existed, target, migrations, log2) {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  if (Number(db.prepare("PRAGMA user_version").get().user_version) === target) return;
  const release = migrationLock(file);
  try {
    migrateLocked(db, file, existed, target, migrations, log2);
  } finally {
    release();
  }
}
function migrateLocked(db, file, existed, target, migrations, log2) {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  const version = Number(db.prepare("PRAGMA user_version").get().user_version);
  if (version > target) throw new Error(`unsupported SQLite store version: ${version}`);
  if (version === target) return;
  if (basename(file) === "bridge.db") assertStoreUpgrade(dirname4(file), "sqlite", version, target);
  let backup = null;
  for (let attempt = 0; ; attempt++) {
    if (attempt >= MAX_SNAPSHOT_ATTEMPTS) throw Object.assign(new Error("database kept changing before migration; waiting to retry while sessions continue"), { code: "EBUSY" });
    const before = db.prepare("PRAGMA data_version").get().data_version;
    if (existed) {
      const protectedDir = join6(dirname4(file), ".migration-snapshots");
      mkdirSync4(protectedDir, { recursive: true, mode: 448 });
      const legacyBackup = backupPath(file);
      const pending = migrations.filter((migration) => migration.version > version);
      const scoped = pending.length > 0 && pending.every((migration) => migration.backupTables !== void 0);
      if (scoped) {
        backup = join6(protectedDir, `${basename(file)}.metadata-v${version}-to-v${target}-${randomUUID4()}.db`);
        metadataSnapshot(db, backup, [...new Set(pending.flatMap((migration) => [...migration.backupTables]))], version, target);
      } else {
        backup = join6(protectedDir, `${basename(legacyBackup)}-v${version}-to-v${target}`);
        db.prepare("VACUUM INTO ?").run(backup);
        const snapshot = new DatabaseSync2(backup, { readOnly: true });
        try {
          if (snapshot.prepare("PRAGMA integrity_check").all().some((row) => row.integrity_check !== "ok")) throw new Error(`invalid pre-migration snapshot: ${backup}`);
        } finally {
          snapshot.close();
        }
      }
      if (!scoped) {
        copyFileSync(backup, legacyBackup);
        retainBackups(file);
      }
      log2.info("backed up store before migration", { file, backup, version, scope: scoped ? "metadata and schema only" : "whole database" });
    }
    db.exec("BEGIN IMMEDIATE");
    if (before === db.prepare("PRAGMA data_version").get().data_version) break;
    db.exec("ROLLBACK");
  }
  db.exec("SAVEPOINT schema_migration");
  try {
    const current = Number(db.prepare("PRAGMA user_version").get().user_version);
    if (current > target) throw new Error(`unsupported SQLite store version: ${current}`);
    for (const migration of migrations) if (migration.version > current) db.exec(migration.sql);
    if (Number(db.prepare("PRAGMA user_version").get().user_version) !== target) throw new Error("migration did not reach expected schema version");
    db.exec("RELEASE schema_migration; COMMIT");
  } catch (err) {
    db.exec("ROLLBACK TO schema_migration");
    if (backup) {
      const original = new DatabaseSync2(backup, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
      try {
        const tables = original.prepare("PRAGMA table_list").all().filter((r) => r.schema === "main" && r.type === "table" && !String(r.name).startsWith("sqlite_"));
        const quote2 = (s) => `"${s.replaceAll('"', '""')}"`;
        for (const row of tables) {
          const name = String(row.name);
          const quoted = quote2(name);
          const columns = original.prepare(`PRAGMA table_xinfo(${quoted})`).all().filter((r) => r.hidden === 0).map((r) => String(r.name));
          let rowidAlias = "__bridge_backup_rowid";
          while (columns.includes(rowidAlias)) rowidAlias += "_";
          const rowid = ["rowid", "_rowid_", "oid"].find((s) => !columns.includes(s));
          const hasRowid = row.wr === 0 && rowid !== void 0;
          const select = original.prepare(`SELECT ${hasRowid ? `${quote2(rowid)} AS ${quote2(rowidAlias)}, ` : ""}${columns.map(quote2).join(", ")} FROM ${quoted}`);
          select.setReadBigInts(true);
          const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND sql IS NOT NULL").all(name);
          for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote2(String(trigger.name))}`);
          db.exec(`DELETE FROM ${quoted}`);
          const insertColumns = hasRowid ? [rowid, ...columns] : columns;
          const insert = db.prepare(`INSERT INTO ${quoted} (${insertColumns.map(quote2).join(", ")}) VALUES (${insertColumns.map(() => "?").join(", ")})`);
          for (const data of select.iterate()) insert.run(...hasRowid ? [data[rowidAlias], ...columns.map((s) => data[s])] : columns.map((s) => data[s]));
          for (const trigger of triggers) db.exec(String(trigger.sql));
        }
        db.exec(`PRAGMA user_version = ${Number(original.prepare("PRAGMA user_version").get().user_version)}`);
        db.exec("RELEASE schema_migration; COMMIT");
        log2.warn("failed migration restored its backup", { file, backup });
      } catch (recoveryError) {
        db.exec("ROLLBACK");
        throw new AggregateError([err, recoveryError], `migration failed; transaction rolled back and backup preserved at ${backup}`);
      } finally {
        original.close();
      }
    } else db.exec("ROLLBACK");
    throw err;
  }
}

// src/core/job-archive-index.ts
var JOB_ARCHIVE_VERSION = 1;
var JOB_ARCHIVE_FILE = "job-archive.db";
var log = { debug() {
}, info() {
}, warn() {
}, error() {
}, child() {
  return this;
} };
var record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var archivedRecordId = (job) => record(job) ? typeof job.id === "string" ? job.id : typeof job.name === "string" ? `legacy-name:${job.name}` : void 0 : void 0;
var jobDigest = (bytes2) => createHash3("sha256").update(bytes2).digest("hex");
var jobArchivePath = (jobsPath) => join7(dirname5(jobsPath), JOB_ARCHIVE_FILE);
function archiveWriteError(error) {
  const e = error;
  return e?.errcode === 5 || e?.errcode === 6 || e?.code === "EBUSY" ? Object.assign(new Error("Job archive is busy; retry later. Saved records remain retained.", { cause: error }), { code: "EJOBLOCKED" }) : error;
}
function physicalArchivePath(path) {
  for (const at of [path, dirname5(path)]) {
    if (existsSync6(at)) {
      let st;
      try {
        st = lstatSync2(at);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (st.isSymbolicLink()) throw new Error("job archive path must be physical; data kept unchanged");
    }
  }
  try {
    if (existsSync6(path)) realpathSync.native(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}
var schema = `
CREATE TABLE job_versions (
  id TEXT NOT NULL, sha256 TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
  observed_at INTEGER NOT NULL, PRIMARY KEY(id,sha256)
);
CREATE TABLE job_records (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT, status TEXT, started_at INTEGER, finished_at INTEGER, metadata TEXT NOT NULL, history_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL, live INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(id,sha256) REFERENCES job_versions(id,sha256)
);
CREATE INDEX job_records_name ON job_records(name);
CREATE TABLE archive_sources (path TEXT NOT NULL, sha256 TEXT NOT NULL, imported_at INTEGER NOT NULL,
  PRIMARY KEY(path,sha256));
CREATE TABLE archive_migrations (version INTEGER PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE archive_projection (version INTEGER PRIMARY KEY, signature TEXT NOT NULL);
CREATE VIEW v_jobs AS SELECT r.id,r.name,r.status,r.started_at,r.finished_at,r.archived,r.active,r.observed_at,r.sha256,v.payload AS job_json
  FROM job_records r JOIN job_versions v USING(id,sha256);
CREATE VIEW current_jobs AS SELECT * FROM v_jobs;
PRAGMA user_version=1;`;
function openJobArchive(path, writable = false) {
  const file = jobArchivePath(path);
  physicalArchivePath(file);
  physicalArchivePath(`${file}-wal`);
  physicalArchivePath(`${file}-shm`);
  physicalArchivePath(join7(dirname5(path), "archive"));
  if (!writable && !existsSync6(file)) return void 0;
  if (writable) mkdirSync5(dirname5(file), { recursive: true, mode: 448 });
  const db = new DatabaseSync3(file, { readOnly: !writable, timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    db.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}; PRAGMA foreign_keys=ON`);
    const version = Number(db.prepare("PRAGMA user_version").get().user_version);
    if (!writable && version === 0) {
      db.close();
      return void 0;
    }
    if (writable && version < JOB_ARCHIVE_VERSION) {
      migrateSqlite(db, file, true, JOB_ARCHIVE_VERSION, [{ version: 1, sql: schema }], log);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    } else if (version !== JOB_ARCHIVE_VERSION) throw new Error(`unsupported job archive version ${version}; retry later`);
    return db;
  } catch (error) {
    db.close();
    throw archiveWriteError(error);
  }
}
function metadata(job) {
  const out = { ...job };
  for (const key of ["prompt", "result", "queuedMessages"]) delete out[key];
  if (typeof job.prompt === "string") out.prompt = job.prompt.slice(0, 300);
  return JSON.stringify(out);
}
function putJobRecords(db, jobs, observedAt = Date.now(), live = true, archived = false) {
  const prior = db.prepare("SELECT id,sha256,archived,live,observed_at FROM job_records WHERE id=?");
  const retained = db.prepare("SELECT metadata,history_json FROM job_records WHERE id=?");
  const insert = db.prepare("INSERT OR IGNORE INTO job_versions(id,sha256,payload,observed_at) VALUES(?,?,?,?)");
  const update = db.prepare(`INSERT INTO job_records(id,sha256,name,status,started_at,finished_at,metadata,history_json,observed_at,live,archived) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET sha256=excluded.sha256,name=excluded.name,status=excluded.status,
      started_at=excluded.started_at,finished_at=excluded.finished_at,metadata=excluded.metadata,history_json=excluded.history_json,
      observed_at=excluded.observed_at,live=excluded.live,archived=MAX(job_records.archived,excluded.archived)`);
  for (const job of jobs) {
    const id = archivedRecordId(job);
    if (!record(job) || id === void 0) continue;
    const json = JSON.stringify(job), sha = jobDigest(json), old = prior.get(id);
    if (old?.sha256 === sha) {
      if (archived && !old.archived) db.prepare("UPDATE job_records SET archived=1 WHERE id=?").run(id);
      continue;
    }
    insert.run(id, sha, json, observedAt);
    const oldRecord = old ? retained.get(id) : void 0;
    if (old) {
      const oldJob = JSON.parse(String(oldRecord.metadata));
      if (job.status === "running" && oldJob.startedAt === job.startedAt && record(oldJob.completionReceipt) && oldJob.completionReceipt.version === 1 && ["done", "failed", "cancelled"].includes(oldJob.status)) continue;
      if (!live && (old.live === 1 || Number(old.observed_at) > observedAt)) continue;
      if (live && old.live === 1 && Number(old.observed_at) > observedAt) continue;
    }
    const merged = { ...oldRecord ? JSON.parse(String(oldRecord.history_json)) : {}, ...job };
    update.run(
      id,
      sha,
      typeof job.name === "string" ? job.name : null,
      typeof job.status === "string" ? job.status : null,
      typeof job.startedAt === "number" ? job.startedAt : null,
      typeof job.finishedAt === "number" ? job.finishedAt : null,
      metadata(merged),
      JSON.stringify(merged),
      observedAt,
      Number(live),
      Number(archived)
    );
  }
}
function storeJobRecords(path, jobs, archived = false, previous = []) {
  const db = openJobArchive(path, true);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      if (previous.length) {
        const published = existsSync6(path) && db.prepare("SELECT signature FROM archive_projection WHERE version=1").get()?.signature === fileSignature(statSync7(path));
        putJobRecords(db, previous, now, !published);
      }
      putJobRecords(db, jobs, now, true, archived);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw archiveWriteError(error);
    }
  } catch (error) {
    throw archiveWriteError(error);
  } finally {
    db.close();
  }
  return jobArchivePath(path);
}
var cache2 = /* @__PURE__ */ new Map();
var cacheBytes = 0;
var CACHE_BUDGET = 8 * 1024 * 1024;
var archiveIndexCounters = { reads: 0, decoded: 0 };
function readIndexedJobs(path, selection = {}) {
  const file = jobArchivePath(path);
  physicalArchivePath(file);
  physicalArchivePath(join7(dirname5(path), "archive"));
  const signature = [file, `${file}-wal`].map((p) => existsSync6(p) ? fileSignature(statSync7(p)) : "missing").join("|");
  const key = `${file}:${Number(Boolean(selection.metadata))}:${Number(Boolean(selection.active))}:${Number(Boolean(selection.history))}:${JSON.stringify([selection.ids ? [...selection.ids].sort() : null, selection.names ? [...selection.names].sort() : null])}`;
  const saved = cache2.get(key);
  if (saved?.signature === signature) {
    cache2.delete(key);
    cache2.set(key, saved);
    return saved;
  }
  if (saved) {
    cacheBytes -= saved.bytes;
    cache2.delete(key);
  }
  const db = openJobArchive(path);
  if (!db) return { signature, jobs: [] };
  const jobs = [];
  try {
    archiveIndexCounters.reads++;
    const columns = selection.metadata ? "r.metadata" : selection.history ? "r.history_json AS payload" : "v.payload";
    const from = selection.metadata || selection.history ? "job_records r" : "job_records r JOIN job_versions v USING(id,sha256)";
    const decode = (row) => {
      archiveIndexCounters.decoded++;
      jobs.push(JSON.parse(String(selection.metadata ? row.metadata : row.payload)));
    };
    if (selection.ids || selection.names) {
      const seen = /* @__PURE__ */ new Set();
      for (const [field, values] of [["id", selection.ids], ["name", selection.names]]) {
        if (!values) continue;
        const query = db.prepare(`SELECT r.id,${columns} FROM ${from} WHERE r.${field}=?${selection.active ? " AND r.active=1" : ""}`);
        for (const value of values) for (const row of query.all(value)) {
          if (!seen.has(String(row.id))) {
            seen.add(String(row.id));
            decode(row);
          }
        }
      }
    } else for (const row of db.prepare(`SELECT ${columns} FROM ${from}${selection.active ? " WHERE r.active=1" : ""} ORDER BY r.observed_at,r.id`).iterate()) decode(row);
  } catch (error) {
    throw archiveWriteError(error);
  } finally {
    db.close();
  }
  const next = { signature, jobs, bytes: estimatedJsonBytes(jobs, CACHE_BUDGET) };
  if (next.bytes <= CACHE_BUDGET) {
    cache2.set(key, next);
    cacheBytes += next.bytes;
    while (cacheBytes > CACHE_BUDGET || cache2.size > 256) {
      const first = cache2.keys().next().value;
      cacheBytes -= cache2.get(first).bytes;
      cache2.delete(first);
    }
  }
  return next;
}
function markJobProjection(path, jobs, expectedSignature) {
  physicalArchivePath(path);
  const signature = fileSignature(statSync7(path)), db = openJobArchive(path, true);
  try {
    if (expectedSignature && signature !== expectedSignature) throw new Error("active jobs changed during archive import; retry later");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("UPDATE job_records SET active=0 WHERE active=1");
      const set = db.prepare("UPDATE job_records SET active=1 WHERE id=?");
      for (const job of jobs) {
        const id = archivedRecordId(job);
        if (id !== void 0) set.run(id);
      }
      db.prepare("INSERT INTO archive_projection(version,signature) VALUES(1,?) ON CONFLICT(version) DO UPDATE SET signature=excluded.signature").run(signature);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw archiveWriteError(error);
    }
  } finally {
    db.close();
  }
}
var projectionChecks = /* @__PURE__ */ new Map();
function indexedJobProjectionCurrent(path) {
  if (!existsSync6(path)) return false;
  physicalArchivePath(path);
  const file = jobArchivePath(path);
  const stat = (p) => existsSync6(p) ? fileSignature(statSync7(p)) : "missing";
  const active = fileSignature(statSync7(path)), signature = [active, stat(file), stat(`${file}-wal`)].join("|");
  const saved = projectionChecks.get(path);
  if (saved?.signature === signature) return saved.current;
  const db = openJobArchive(path);
  if (!db) return false;
  let current;
  try {
    current = db.prepare("SELECT signature FROM archive_projection WHERE version=1").get()?.signature === active;
  } finally {
    db.close();
  }
  if (projectionChecks.size >= 64) projectionChecks.delete(projectionChecks.keys().next().value);
  projectionChecks.set(path, { signature, current });
  return current;
}

// src/core/json-store.ts
var JSON_STORE_VERSION = 4;
var KEEP_STORE_BACKUPS = 3;
var RENAME_ATTEMPTS = 50;
var RENAME_RETRY_MS = 20;
function warn(log2, message, data) {
  if (log2) log2.warn(message, data);
  else process.stderr.write(`${message}: ${JSON.stringify(data)}
`);
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function archiveFile(path) {
  if (!existsSync7(path)) return null;
  const dir = join8(dirname6(path), "archive");
  mkdirSync6(dir, { recursive: true, mode: 448 });
  const target = join8(dir, `${basename2(path)}-${Date.now()}-${randomUUID5()}`);
  renameSync4(path, target);
  return target;
}
function backupPath(path) {
  return `${path}.backup-${Date.now()}-${randomUUID5()}`;
}
function retainBackups(path) {
  const prefix = `${basename2(path)}.backup-`;
  const files = readdirSync4(dirname6(path)).filter((f) => f.startsWith(prefix)).sort().reverse();
  for (const file of files.slice(KEEP_STORE_BACKUPS)) {
    try {
      archiveFile(join8(dirname6(path), file));
    } catch (error) {
      const code = error.code;
      if (["EBUSY", "EPERM", "EACCES", "ENOENT"].includes(code ?? "")) continue;
      throw error;
    }
  }
}
var PARTIAL_WRITE_WAIT_MS = 100;
function parseJsonStore(raw, valid) {
  const value = JSON.parse(raw);
  if (isRecord(value) && typeof value.version === "number" && value.version > JSON_STORE_VERSION) return value;
  if (!valid(value)) throw new Error("invalid store structure");
  return value;
}
function readJsonStore(path, log2, valid = isRecord) {
  let raw;
  try {
    raw = readFileSync6(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  try {
    return parseJsonStore(raw, valid);
  } catch (err) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PARTIAL_WRITE_WAIT_MS);
    try {
      const again = readFileSync6(path, "utf8");
      if (again !== raw) return parseJsonStore(again, valid);
    } catch (retry) {
      if (retry.code === "ENOENT") return null;
    }
    const preserved = `${path}.corrupt-${Date.now()}-${randomUUID5()}`;
    const release = storageLease(storeHome(path));
    try {
      renameSync4(path, preserved);
    } finally {
      release();
    }
    warn(log2, "preserved corrupt JSON store", { path, preserved, err: err.message });
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
  mkdirSync6(dirname6(path), { recursive: true, mode: 448 });
  if (basename2(path) === "jobs.json" && Array.isArray(value.jobs)) {
    storeJobRecords(path, value.jobs, false, Array.isArray(previous) ? previous : isRecord(previous) && Array.isArray(previous.jobs) ? previous.jobs : []);
  }
  if (previous !== null && (!isRecord(previous) || previous.version !== JSON_STORE_VERSION) && existsSync7(path)) {
    copyFileSync2(path, backupPath(path));
    retainBackups(path);
  }
  const tmp = `${path}.${process.pid}.${randomUUID5()}.tmp`;
  writeFileSync3(tmp, `${JSON.stringify({ ...value, version: JSON_STORE_VERSION }, null, 2)}
`, { mode: 384 });
  const fd = openSync5(tmp, "r+");
  try {
    fsyncSync3(fd);
  } finally {
    closeSync5(fd);
  }
  const pause = new Int32Array(new SharedArrayBuffer(4));
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync4(tmp, path);
        if (basename2(path) === "jobs.json" && Array.isArray(value.jobs)) markJobProjection(path, value.jobs);
        return;
      } catch (err) {
        const code = err.code;
        if (!["EPERM", "EBUSY", "EACCES"].includes(code ?? "") || attempt >= RENAME_ATTEMPTS) throw err;
        Atomics.wait(pause, 0, 0, RENAME_RETRY_MS);
      }
    }
  } finally {
    rmSync3(tmp, { force: true });
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
  const stat = lstatSync3(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw busy();
}
function physicalAncestors(path) {
  let current = resolve2(path);
  for (; ; ) {
    try {
      physicalDirectory(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname7(current);
    if (parent === current) return;
    current = parent;
  }
}
function markerName(identity, claim = false) {
  return `${claim ? "claim" : "owner"}-v1.${process.pid}.${Buffer.from(identity).toString("base64url")}.${randomUUID6()}.json`;
}
function fileIdentity(path) {
  const stat = lstatSync3(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw busy();
  return `${stat.dev}:${stat.ino}`;
}
function readOwner2(path, registry) {
  try {
    const file = fileIdentity(path);
    const value = JSON.parse(readFileSync7(path, "utf8"));
    if (!isRecord(value) || value.version !== VERSION || typeof value.ownerDirectory !== "string" || !UUID.test(value.ownerDirectory)) return null;
    physicalDirectory(registry);
    const dir = join9(registry, value.ownerDirectory);
    physicalDirectory(dir);
    const files = readdirSync5(dir);
    if (files.length !== 1) return null;
    const marker = files[0];
    const match = MARKER.exec(marker);
    const pid = Number(match?.[1]);
    if (!match || !Number.isSafeInteger(pid) || pid <= 0 || !UUID.test(match[3])) return null;
    const identity = Buffer.from(match[2], "base64url").toString("utf8");
    if (!identity || Buffer.from(identity).toString("base64url") !== match[2]) return null;
    if (fileIdentity(join9(dir, marker)) !== file || fileIdentity(path) !== file) return null;
    return { dir, marker, pid, identity, file, ...typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? { createdAt: value.createdAt } : {} };
  } catch {
    return null;
  }
}
function readMetadataLeaseOwner(path) {
  const registry = join9(dirname7(path), ".metadata-leases", createHash4("sha256").update(basename3(path)).digest("hex"));
  const owner = readOwner2(path, registry);
  return owner ? { pid: owner.pid, identity: owner.identity } : null;
}
function archiveOwned(path, registry, owner, identity) {
  const current = readOwner2(path, registry);
  if (!current || current.file !== owner.file || current.marker !== owner.marker || current.dir !== owner.dir) throw busy();
  const claim = markerName(identity, true);
  renameSync5(join9(owner.dir, owner.marker), join9(owner.dir, claim));
  if (fileIdentity(path) !== owner.file) throw busy();
  renameSync5(path, join9(owner.dir, `released-v2.${randomUUID6()}.json`));
  archiveFile(owner.dir);
}
function metadataFileLease(path, waitMs = 0, nonBlockingRecovery = false) {
  const identity = processIdentity(process.pid);
  if (!identity) throw busy();
  const parent = dirname7(path);
  physicalAncestors(parent);
  mkdirSync7(parent, { recursive: true, mode: 448 });
  physicalDirectory(parent);
  const namespace = join9(parent, ".metadata-leases");
  mkdirSync7(namespace, { recursive: true, mode: 448 });
  physicalDirectory(namespace);
  const registry = join9(namespace, createHash4("sha256").update(basename3(path)).digest("hex"));
  mkdirSync7(registry, { recursive: true, mode: 448 });
  physicalDirectory(registry);
  const archive = join9(registry, "archive");
  mkdirSync7(archive, { recursive: true, mode: 448 });
  physicalDirectory(archive);
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let staged;
  const probed = /* @__PURE__ */ new Map();
  const blockingAlive = (owner) => {
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      return error.code === "ESRCH" ? false : void 0;
    }
    const key = `${owner.pid}:${owner.identity}:${owner.file}`;
    if (!probed.has(key)) probed.set(key, isProcessIdentityAlive(owner.pid, owner.identity));
    return probed.get(key);
  };
  try {
    for (; ; ) {
      let absent = false;
      try {
        lstatSync3(path);
      } catch (error) {
        if (error.code === "ENOENT") absent = true;
        else throw error;
      }
      if (absent) {
        if (!staged) {
          const ownerDirectory = randomUUID6();
          const dir = join9(registry, ownerDirectory);
          mkdirSync7(dir, { mode: 448 });
          const marker = markerName(identity);
          const source = join9(dir, marker);
          try {
            const fd = openSync6(source, "wx", 384);
            try {
              writeFileSync4(fd, `${JSON.stringify({ version: VERSION, pid: process.pid, identity, nonce: marker, ownerDirectory, createdAt: Date.now() })}
`);
              fsyncSync4(fd);
            } finally {
              closeSync6(fd);
            }
            staged = { dir, marker, pid: process.pid, identity, file: fileIdentity(source) };
          } catch (error) {
            archiveFile(dir);
            throw error;
          }
        }
        try {
          linkSync2(join9(staged.dir, staged.marker), path);
          const acquired = staged;
          staged = void 0;
          let released = false;
          return () => {
            if (released) return;
            const owner2 = readOwner2(path, registry);
            if (!owner2 || owner2.file !== acquired.file || owner2.dir !== acquired.dir || owner2.marker !== acquired.marker) return;
            archiveOwned(path, registry, owner2, identity);
            released = true;
          };
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      const owner = readOwner2(path, registry);
      if (owner && ownerGone({ alive: nonBlockingRecovery ? nonBlockingAlive(owner) : blockingAlive(owner), recordedAt: owner.createdAt })) {
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

// src/core/metadata-snapshot.ts
import { createHash as createHash5 } from "node:crypto";
import { closeSync as closeSync7, existsSync as existsSync8, fsyncSync as fsyncSync5, openSync as openSync7, writeFileSync as writeFileSync5 } from "node:fs";
import { DatabaseSync as DatabaseSync4 } from "node:sqlite";
var quote = (name) => `"${name.replaceAll('"', '""')}"`;
var encode = (row) => JSON.stringify(row, (_, value) => typeof value === "bigint" ? { bigint: String(value) } : value);
function snapshotMetadataTables(source, file, tables, component, targetVersion) {
  if (existsSync8(file) || existsSync8(`${file}.manifest.json`)) throw new Error("Metadata snapshot destination exists; retained.");
  const snapshot = new DatabaseSync4(file);
  const manifest = {
    version: 1,
    kind: "metadata-component-snapshot",
    component,
    targetVersion,
    sourceVersion: Number(source.prepare("PRAGMA user_version").get().user_version),
    schema: [],
    tables: []
  };
  source.exec("BEGIN");
  try {
    manifest.schema = source.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    snapshot.exec("BEGIN");
    for (const name of tables) {
      const schema2 = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
      if (!schema2) {
        manifest.tables.push({ name, rows: 0, sha256: createHash5("sha256").digest("hex"), existed: false });
        continue;
      }
      if (typeof schema2.sql !== "string") throw new Error(`Metadata table has no schema: ${name}`);
      snapshot.exec(schema2.sql);
      const columns = source.prepare(`PRAGMA table_info(${quote(name)})`).all().map((row) => String(row.name));
      const insert = snapshot.prepare(`INSERT INTO ${quote(name)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      const expected = createHash5("sha256"), actual = createHash5("sha256");
      let rows = 0, verified = 0;
      const query = `SELECT ${columns.map(quote).join(",")} FROM ${quote(name)} ORDER BY ${columns.map(quote).join(",")}`;
      const read = source.prepare(query);
      read.setReadBigInts(true);
      for (const row of read.iterate()) {
        insert.run(...columns.map((column) => row[column]));
        expected.update(encode(row));
        rows++;
      }
      const check = snapshot.prepare(query);
      check.setReadBigInts(true);
      for (const row of check.iterate()) {
        actual.update(encode(row));
        verified++;
      }
      const sha256 = expected.digest("hex");
      if (verified !== rows || actual.digest("hex") !== sha256) throw new Error(`Metadata snapshot round-trip mismatch: ${name}`);
      manifest.tables.push({ name, rows, sha256, existed: true });
    }
    snapshot.exec("COMMIT");
    if (snapshot.prepare("PRAGMA quick_check").all().some((row) => row.quick_check !== "ok")) throw new Error("Metadata snapshot quick_check failed; retained.");
    writeFileSync5(`${file}.manifest.json`, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 384 });
    const descriptor = openSync7(`${file}.manifest.json`, "r+");
    try {
      fsyncSync5(descriptor);
    } finally {
      closeSync7(descriptor);
    }
  } finally {
    source.exec("ROLLBACK");
    snapshot.close();
  }
}

// src/core/metadata-db.ts
var VERSION2 = 1;
var connections = /* @__PURE__ */ new Map();
var readers = /* @__PURE__ */ new Map();
var handleKey = (path) => process.platform === "win32" ? path.toLowerCase() : path;
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
  let current = resolve3(path);
  for (; ; ) {
    try {
      if (lstatSync4(current).isSymbolicLink()) throw new Error(`Linked storage path retained: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname8(current);
    if (parent === current) return;
    current = parent;
  }
}
function existingMetadataDb(home) {
  const file = join10(resolve3(home), "bridge.db"), cached = connections.get(handleKey(file));
  if (cached) return cached;
  if (!existsSync9(file)) return void 0;
  physicalMetadataPath(file);
  const db = new DatabaseSync5(file, { timeout: 5e3 });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get() || Number(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) !== VERSION2) {
      db.close();
      return void 0;
    }
    db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
    connections.set(handleKey(file), db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function assertMetadataAdmission(home) {
  const blockers = liveStorePeers(home).filter((peer) => !metadataRelease(peer.version));
  if (blockers.length) throw Object.assign(new Error(`Waiting for metadata upgrade: ${blockers.map((p) => `${p.name} (v${p.version}, pid ${p.pid})`).join(", ")}. Existing readers keep their files.`), { code: "STORE_UPGRADE_DEFERRED" });
}
function metadataDb(home) {
  const file = join10(resolve3(home), "bridge.db");
  const cached = connections.get(handleKey(file));
  if (cached) return cached;
  physicalMetadataPath(file);
  mkdirSync8(dirname8(file), { recursive: true, mode: 448 });
  const existed = existsSync9(file);
  const db = new DatabaseSync5(file, { timeout: 5e3 });
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
            const dir = join10(home, ".migration-snapshots");
            physicalMetadataPath(dir);
            mkdirSync8(dir, { recursive: true, mode: 448 });
            const backup = join10(dir, `metadata-v${VERSION2}-${randomUUID7()}.db`);
            snapshotMetadataTables(db, backup, ["bridge_components", "worktree_leases", "worktree_lease_archive", "bridge_metadata", "bridge_read_receipts", "bridge_imports"], "metadata", VERSION2);
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
    connections.set(handleKey(file), db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
function closeMetadataDb(home) {
  const file = join10(resolve3(home), "bridge.db"), db = connections.get(handleKey(file));
  if (db) {
    db.close();
    connections.delete(handleKey(file));
  }
}
function retainMetadataReader(home) {
  const key = handleKey(resolve3(home));
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
function metadataDbOpen(home) {
  return connections.has(handleKey(join10(resolve3(home), "bridge.db")));
}
function metadataReaderRetained(home) {
  return (readers.get(handleKey(resolve3(home))) ?? 0) > 0;
}
function metadataValue(home, domain, key) {
  const row = metadataDb(home).prepare("SELECT value FROM bridge_metadata WHERE domain=? AND key=?").get(domain, key);
  return row ? JSON.parse(String(row.value)) : null;
}
function closeMetadataDbs() {
  for (const db of connections.values()) db.close();
  connections.clear();
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

export {
  writtenBeforeBoot,
  ownerGone,
  storageLease,
  maintenanceLock,
  readMetadataLeaseOwner,
  metadataFileLease,
  physicalMetadataPath,
  existingMetadataDb,
  metadataDb,
  closeMetadataDb,
  retainMetadataReader,
  metadataDbOpen,
  metadataReaderRetained,
  metadataValue,
  closeMetadataDbs,
  saveMetadataValue,
  retainMetadataFiles,
  importMetadataDomain,
  refreshStorePeerIdentities,
  validStoreCapabilities,
  recordStorePeer,
  liveStorePeers,
  legacyStorePeers,
  assertStoreUpgrade,
  estimatedJsonBytes,
  cloneJson,
  fileSignature,
  readJsonSnapshot,
  createLogger,
  nullLogger,
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_REQUEST_BUSY_MS,
  configureSqlite,
  isSqliteBusy,
  retrySqlite,
  ARCHIVE_DB_NAME,
  ARCHIVE_STORE_VERSION,
  checkDatabase,
  snapshotDatabase,
  openArchive,
  archiveDbPath,
  archiveMessages,
  migrationLock,
  migrateSqlite,
  archivedRecordId,
  jobDigest,
  jobArchivePath,
  physicalArchivePath,
  openJobArchive,
  putJobRecords,
  storeJobRecords,
  readIndexedJobs,
  markJobProjection,
  indexedJobProjectionCurrent,
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
