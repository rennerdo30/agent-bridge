import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/job-archive-worker.ts
import { parentPort, workerData } from "node:worker_threads";

// src/core/job-archive-migration.ts
import { existsSync as existsSync9, lstatSync as lstatSync4, mkdirSync as mkdirSync8, readFileSync as readFileSync8, readdirSync as readdirSync6 } from "node:fs";
import { basename as basename4, dirname as dirname8, join as join11 } from "node:path";

// src/core/archive-bundle.ts
import { createHash as createHash4, randomUUID as randomUUID6 } from "node:crypto";
import { closeSync as closeSync5, existsSync as existsSync8, fsyncSync as fsyncSync3, linkSync, lstatSync as lstatSync3, mkdirSync as mkdirSync7, openSync as openSync5, readFileSync as readFileSync7, readdirSync as readdirSync5, renameSync as renameSync4, writeFileSync as writeFileSync5 } from "node:fs";
import { basename as basename3, dirname as dirname7, join as join10 } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";

// src/core/json-store.ts
import { randomUUID as randomUUID5 } from "node:crypto";
import { closeSync as closeSync4, copyFileSync as copyFileSync3, existsSync as existsSync7, fsyncSync as fsyncSync2, mkdirSync as mkdirSync6, openSync as openSync4, readFileSync as readFileSync6, readdirSync as readdirSync4, renameSync as renameSync3, rmSync as rmSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { basename as basename2, dirname as dirname6, join as join9 } from "node:path";

// src/core/storage-lock.ts
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

// src/core/store-compatibility.ts
import { existsSync as existsSync3, readdirSync as readdirSync3, readFileSync as readFileSync3, statSync } from "node:fs";
import { join as join4 } from "node:path";

// src/core/plugin-runtime.ts
import { randomUUID as randomUUID2, createHash } from "node:crypto";
import { copyFileSync, existsSync as existsSync2, lstatSync, mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname as dirname2, join as join3, resolve } from "node:path";

// src/core/constants.ts
import { homedir } from "node:os";
import { join as join2 } from "node:path";
var APP_NAME = "agent-bridge";
var DEFAULT_HOME = join2(homedir(), `.${APP_NAME}`);
var LOG_FILE_NAME = `${APP_NAME}.log`;
var MAX_FRAME_BYTES = 4 * 1024 * 1024;
var MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var PURGE_INTERVAL_MS = 60 * 60 * 1e3;
var QUEUED_MAIL_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var MAX_JOB_TIMEOUT_SEC = 24 * 60 * 60;

// src/core/process-identity.ts
import { execFile, execFileSync } from "node:child_process";
import { readFileSync as readFileSync2 } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
var exec = promisify(execFile);
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
      const stat = readFileSync2(`/proc/${pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      if (start) identity = `${readFileSync2("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${start}`;
    } else {
      identity = (process.platform === "win32" ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: 5e3, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) : execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { timeout: 5e3, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } })).trim() || void 0;
    }
    if (pid === process.pid) ownIdentity = identity;
    return identity;
  } catch {
    return void 0;
  }
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
  return new Promise((resolve2, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    ready.then(() => {
      signal.removeEventListener("abort", abort);
      resolve2();
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
    const dir = join4(home, "storage-capabilities");
    const records2 = existsSync3(dir) ? readdirSync3(dir).filter((file) => /^\d+\.json$/.test(file)).flatMap((file) => {
      const path = join4(dir, file), signature = presenceSignature(path), cached = identities.get(path);
      return signature && (!cached || cached.signature !== signature || Date.now() - cached.at >= IDENTITY_REFRESH_MS) ? [{ pid: Number(file.slice(0, -5)), path, signature }] : [];
    }) : [];
    if (!records2.length) return;
    const refresh = (async () => {
      const current = await readProcessIdentities(records2.filter((record2) => record2.pid !== process.pid).map((record2) => record2.pid));
      for (const { pid, path, signature } of records2) identities.set(path, { identity: pid === process.pid ? processIdentity(pid) ?? null : current.get(pid) ?? null, at: Date.now(), signature });
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
  const path = join4(home, "storage-capabilities", `${pid}.json`), cached = identities.get(path);
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
function validStoreCapabilities(value) {
  const v = value;
  return Boolean(v && Number.isSafeInteger(v.json) && v.json >= 0 && Number.isSafeInteger(v.sqlite) && v.sqlite >= 0 && (v.jobArchive === void 0 || Number.isSafeInteger(v.jobArchive) && v.jobArchive >= 0));
}
function liveStorePeers(home) {
  const dir = join4(home, "storage-capabilities");
  if (!existsSync3(dir)) return [];
  void refreshStorePeerIdentities(home).catch(() => {
  });
  return readdirSync3(dir).filter((file) => /^\d+\.json$/.test(file)).flatMap((file) => {
    const pid = Number(file.slice(0, -5));
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return [];
    }
    try {
      const path = join4(dir, file), signature = presenceSignature(path);
      const record2 = JSON.parse(readFileSync3(path, "utf8"));
      if (signature !== presenceSignature(path)) throw new Error("Store reader presence changed during observation");
      const identity = cachedIdentity(home, pid);
      if (identity && typeof record2.processIdentity === "string" && record2.processIdentity !== identity) return [];
      if (identity && !record2.processIdentity && legacyPidReused(identity, statSync(join4(dir, file)).mtimeMs)) return [];
      if (identity && record2.schemaVersion === 1 && record2.pid === pid && validStoreCapabilities(record2)) return [record2];
    } catch {
    }
    return [{ pid, name: `pid ${pid}`, version: "unknown", json: 0, sqlite: 0, explicit: false }];
  });
}
function assertStoreUpgrade(home, format, current, target) {
  if (target <= current) return;
  const blockers = liveStorePeers(home).filter((peer) => (peer[format] ?? 0) < target);
  if (!blockers.length) return;
  throw Object.assign(new Error(`Waiting to upgrade ${format} store ${current}\u2192${target}: ${blockers.map((p) => `${p.name} (v${p.version}, pid ${p.pid}, reads ${p[format]})`).join(", ")}. Existing sessions keep their code and data; retry when these readers finish naturally.`), { code: "STORE_UPGRADE_DEFERRED" });
}

// src/core/job-archive-index.ts
import { createHash as createHash3 } from "node:crypto";
import { existsSync as existsSync6, lstatSync as lstatSync2, mkdirSync as mkdirSync5, realpathSync, statSync as statSync4 } from "node:fs";
import { dirname as dirname5, join as join8 } from "node:path";
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";

// src/core/file-cache.ts
import { readFileSync as readFileSync4, statSync as statSync2 } from "node:fs";
var MAX_BYTES = 16 * 1024 * 1024;
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
function fileSignature(st) {
  return `${st.dev}:${st.ino}:${st.birthtimeMs}:${st.ctimeMs}:${st.mtimeMs}:${st.size}`;
}

// src/core/sqlite-migrations.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { createHash as createHash2, randomUUID as randomUUID4 } from "node:crypto";
import { closeSync as closeSync3, copyFileSync as copyFileSync2, fsyncSync, mkdirSync as mkdirSync4, openSync as openSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { basename, dirname as dirname4, join as join7 } from "node:path";

// src/core/sqlite-maintenance.ts
import { existsSync as existsSync4 } from "node:fs";
import { dirname as dirname3, join as join6 } from "node:path";
import { DatabaseSync } from "node:sqlite";

// src/core/logger.ts
import { appendFileSync, mkdirSync as mkdirSync3, renameSync as renameSync2, statSync as statSync3 } from "node:fs";
import { join as join5 } from "node:path";
var MAX_LOG_BYTES = 5 * 1024 * 1024;

// src/core/sqlite-policy.ts
import { setTimeout as delay } from "node:timers/promises";
var SQLITE_BUSY_TIMEOUT_MS = 3e3;

// src/core/migration-lock.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { closeSync as closeSync2, existsSync as existsSync5, openSync as openSync2, readFileSync as readFileSync5, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
function migrationLock(file) {
  if (file === ":memory:") return () => {
  };
  const path = `${file}.migration-lock`, recovery = `${path}.recovery`;
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID3() });
  const until = Date.now() + 5e3;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (; ; ) {
    try {
      const fd = openSync2(path, "wx", 384);
      try {
        writeFileSync2(fd, owner);
      } catch (error) {
        closeSync2(fd);
        rmSync2(path);
        throw error;
      }
      closeSync2(fd);
      return () => {
        if (readFileSync5(path, "utf8") === owner) rmSync2(path);
      };
    } catch (error) {
      if (!["EEXIST", "EPERM", "EBUSY", "EACCES"].includes(error.code ?? "")) throw error;
    }
    let recoveryFd;
    try {
      let dead = false;
      if (existsSync5(path)) try {
        const pid = JSON.parse(readFileSync5(path, "utf8")).pid;
        if (Number.isSafeInteger(pid) && pid > 0) try {
          process.kill(pid, 0);
        } catch (error) {
          dead = error.code === "ESRCH";
        }
      } catch {
      }
      if (dead) {
        recoveryFd = openSync2(recovery, "wx", 384);
        if (existsSync5(path)) {
          const pid = JSON.parse(readFileSync5(path, "utf8")).pid;
          if (Number.isSafeInteger(pid) && pid > 0) try {
            process.kill(pid, 0);
          } catch (error) {
            if (error.code === "ESRCH") rmSync2(path);
          }
        }
      }
    } catch (error) {
      if (!["EEXIST", "ENOENT", "EPERM", "EBUSY", "EACCES"].includes(error.code ?? "")) throw error;
    } finally {
      if (recoveryFd !== void 0) {
        closeSync2(recoveryFd);
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
  const quote = (name) => `"${name.replaceAll('"', '""')}"`;
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
      const source = db.prepare(`SELECT rowid AS __migration_rowid__, * FROM ${quote(table)} ORDER BY rowid`);
      source.setReadBigInts(true);
      const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((row) => String(row.name));
      const insert = snapshot.prepare(`INSERT INTO ${quote(table)} (rowid,${columns.map(quote).join(",")}) VALUES (${["rowid", ...columns].map(() => "?").join(",")})`);
      const expected = createHash2("sha256");
      let rows = 0;
      for (const row of source.iterate()) {
        insert.run(row.__migration_rowid__, ...columns.map((name) => row[name]));
        expected.update(digest(row));
        rows++;
      }
      const actual = createHash2("sha256");
      const verify = snapshot.prepare(`SELECT rowid AS __migration_rowid__, * FROM ${quote(table)} ORDER BY rowid`);
      verify.setReadBigInts(true);
      let verified = 0;
      for (const row of verify.iterate()) {
        actual.update(digest(row));
        verified++;
      }
      const sha2562 = expected.digest("hex");
      if (rows !== verified || actual.digest("hex") !== sha2562) throw new Error(`Migration metadata snapshot verification failed: ${table}`);
      manifest.tables.push({ name: table, rows, sha256: sha2562 });
    }
    snapshot.exec(`PRAGMA user_version=${version}; COMMIT`);
    if (snapshot.prepare("PRAGMA integrity_check").all().some((row) => row.integrity_check !== "ok")) throw new Error(`Invalid metadata migration snapshot: ${path}`);
    writeFileSync3(`${path}.manifest.json`, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 384 });
    const manifestFile = openSync3(`${path}.manifest.json`, "r+");
    try {
      fsyncSync(manifestFile);
    } finally {
      closeSync3(manifestFile);
    }
  } finally {
    snapshot.close();
  }
}
function migrateSqlite(db, file, existed, target, migrations, log2) {
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
      const protectedDir = join7(dirname4(file), ".migration-snapshots");
      mkdirSync4(protectedDir, { recursive: true, mode: 448 });
      const legacyBackup = backupPath(file);
      const pending = migrations.filter((migration) => migration.version > version);
      const scoped = pending.length > 0 && pending.every((migration) => migration.backupTables !== void 0);
      if (scoped) {
        backup = join7(protectedDir, `${basename(file)}.metadata-v${version}-to-v${target}-${randomUUID4()}.db`);
        metadataSnapshot(db, backup, [...new Set(pending.flatMap((migration) => [...migration.backupTables]))], version, target);
      } else {
        backup = join7(protectedDir, `${basename(legacyBackup)}-v${version}-to-v${target}`);
        db.prepare("VACUUM INTO ?").run(backup);
        const snapshot = new DatabaseSync2(backup, { readOnly: true });
        try {
          if (snapshot.prepare("PRAGMA integrity_check").all().some((row) => row.integrity_check !== "ok")) throw new Error(`invalid pre-migration snapshot: ${backup}`);
        } finally {
          snapshot.close();
        }
      }
      if (!scoped) {
        copyFileSync2(backup, legacyBackup);
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
        for (const row of tables) {
          const name = String(row.name);
          const quote = (s) => `"${s.replaceAll('"', '""')}"`;
          const quoted = quote(name);
          const columns = original.prepare(`PRAGMA table_xinfo(${quoted})`).all().filter((r) => r.hidden === 0).map((r) => String(r.name));
          let rowidAlias = "__bridge_backup_rowid";
          while (columns.includes(rowidAlias)) rowidAlias += "_";
          const rowid = ["rowid", "_rowid_", "oid"].find((s) => !columns.includes(s));
          const hasRowid = row.wr === 0 && rowid !== void 0;
          const select = original.prepare(`SELECT ${hasRowid ? `${quote(rowid)} AS ${quote(rowidAlias)}, ` : ""}${columns.map(quote).join(", ")} FROM ${quoted}`);
          select.setReadBigInts(true);
          const rows = select.all();
          db.exec(`DELETE FROM ${quoted}`);
          for (const data of rows) {
            const insertColumns = hasRowid ? [rowid, ...columns] : columns;
            const values = hasRowid ? [data[rowidAlias], ...columns.map((s) => data[s])] : columns.map((s) => data[s]);
            db.prepare(`INSERT INTO ${quoted} (${insertColumns.map(quote).join(", ")}) VALUES (${values.map(() => "?").join(", ")})`).run(...values);
          }
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
var jobDigest = (bytes) => createHash3("sha256").update(bytes).digest("hex");
var jobArchivePath = (jobsPath) => join8(dirname5(jobsPath), JOB_ARCHIVE_FILE);
function archiveWriteError(error) {
  const e = error;
  return e?.errcode === 5 || e?.errcode === 6 || e?.code === "EBUSY" ? Object.assign(new Error("Job archive is busy; retry later. Saved records remain retained.", { cause: error }), { code: "EJOBLOCKED" }) : error;
}
function physicalArchivePath(path) {
  for (const at of [path, dirname5(path)]) {
    if (existsSync6(at)) {
      const st = lstatSync2(at);
      if (st.isSymbolicLink()) throw new Error("job archive path must be physical; data kept unchanged");
    }
  }
  if (existsSync6(path)) realpathSync.native(path);
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
  physicalArchivePath(join8(dirname5(path), "archive"));
  if (!writable && !existsSync6(file)) return void 0;
  if (writable) mkdirSync5(dirname5(file), { recursive: true, mode: 448 });
  const db = new DatabaseSync3(file, { readOnly: !writable, timeout: 100 });
  try {
    db.exec("PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON");
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
var CACHE_BUDGET = 8 * 1024 * 1024;
function markJobProjection(path, jobs, expectedSignature) {
  physicalArchivePath(path);
  const signature = fileSignature(statSync4(path)), db = openJobArchive(path, true);
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

// src/core/json-store.ts
var JSON_STORE_VERSION = 4;
var KEEP_STORE_BACKUPS = 3;
function archiveFile(path) {
  if (!existsSync7(path)) return null;
  const dir = join9(dirname6(path), "archive");
  mkdirSync6(dir, { recursive: true, mode: 448 });
  const target = join9(dir, `${basename2(path)}-${Date.now()}-${randomUUID5()}`);
  renameSync3(path, target);
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
      archiveFile(join9(dirname6(path), file));
    } catch (error) {
      const code = error.code;
      if (["EBUSY", "EPERM", "EACCES", "ENOENT"].includes(code ?? "")) continue;
      throw error;
    }
  }
}

// src/core/archive-bundle.ts
var BUNDLE_MANIFEST_VERSION = 1;
var sha256 = (data) => createHash4("sha256").update(data).digest("hex");
function publish(path, data) {
  const temp = `${path}.${randomUUID6()}.tmp`;
  const fd = openSync5(temp, "wx", 384);
  try {
    writeFileSync5(fd, data);
    fsyncSync3(fd);
  } finally {
    closeSync5(fd);
  }
  linkSync(temp, path);
  archiveFile(temp);
}
function bundleFiles(dir, names, outDir, now = Date.now()) {
  mkdirSync7(outDir, { recursive: true, mode: 448 });
  const entries = [];
  const blobs = [];
  const chunks = [];
  const known = /* @__PURE__ */ new Set();
  let offset = 0;
  for (const name of names) {
    if (basename3(name) !== name) throw new Error(`bundle names must be plain file names: ${name}`);
    const path = join10(dir, name);
    const before = lstatSync3(path);
    if (!before.isFile()) throw new Error(`not a regular file: ${name}`);
    const data = readFileSync7(path);
    const after = lstatSync3(path);
    if (after.mtimeMs !== before.mtimeMs || after.size !== data.length) throw new Error(`file changed while bundling: ${name}`);
    const hash = sha256(data);
    entries.push({ name, bytes: data.length, sha256: hash, mtimeMs: before.mtimeMs });
    if (known.has(hash)) continue;
    known.add(hash);
    blobs.push({ sha256: hash, offset, bytes: data.length });
    chunks.push(data);
    offset += data.length;
  }
  const packed = brotliCompressSync(Buffer.concat(chunks), { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: offset } });
  const id = `bundle-${String(now).padStart(13, "0")}-${randomUUID6()}`;
  const bundle = `${id}.br`;
  publish(join10(outDir, bundle), packed);
  const manifest = { version: BUNDLE_MANIFEST_VERSION, createdAt: now, bundle, bundleSha256: sha256(packed), entries, blobs };
  const manifestPath = join10(outDir, `${id}.manifest.json`);
  publish(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  verifyBundle(manifestPath);
  return manifestPath;
}
function readBundleManifest(manifestPath) {
  const value = JSON.parse(readFileSync7(manifestPath, "utf8"));
  if (value.version !== BUNDLE_MANIFEST_VERSION || !Array.isArray(value.entries) || !Array.isArray(value.blobs) || basename3(value.bundle) !== value.bundle) {
    throw new Error(`unsupported bundle manifest: ${manifestPath}`);
  }
  return value;
}
function extractBundle(manifestPath) {
  const manifest = readBundleManifest(manifestPath);
  const packed = readFileSync7(join10(dirname7(manifestPath), manifest.bundle));
  if (sha256(packed) !== manifest.bundleSha256) throw new Error(`bundle checksum mismatch: ${manifest.bundle}`);
  const raw = brotliDecompressSync(packed);
  const blobs = /* @__PURE__ */ new Map();
  for (const blob of manifest.blobs) {
    const data = raw.subarray(blob.offset, blob.offset + blob.bytes);
    if (data.length !== blob.bytes || sha256(data) !== blob.sha256) throw new Error(`bundle blob mismatch: ${blob.sha256}`);
    blobs.set(blob.sha256, data);
  }
  const out = /* @__PURE__ */ new Map();
  for (const entry of manifest.entries) {
    const data = blobs.get(entry.sha256);
    if (!data || data.length !== entry.bytes) throw new Error(`bundle entry missing: ${entry.name}`);
    out.set(entry.name, data);
  }
  return out;
}
function verifyBundle(manifestPath) {
  extractBundle(manifestPath);
}
function retireBundled(dir, manifestPath, coldDir) {
  const contents = extractBundle(manifestPath);
  mkdirSync7(coldDir, { recursive: true, mode: 448 });
  const moved = [], kept = [];
  for (const [name, bytes] of contents) {
    const source = join10(dir, name), target = join10(coldDir, name);
    if (!existsSync8(source) || existsSync8(target) || !readFileSync7(source).equals(bytes)) {
      kept.push(name);
      continue;
    }
    renameSync4(source, target);
    moved.push(name);
  }
  return { moved, kept };
}

// src/core/job-archive-migration.ts
import { setTimeout as yieldWriter } from "node:timers/promises";
var isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
var acceptArchive = (name) => /^jobs-.*\.json$/.test(name) || /^jobs\.json(?:-|\.(?:overflow\.json|backup)-)/.test(name);
function records(raw, file) {
  const value = JSON.parse(raw.toString("utf8"));
  if (isRecord(value) && value.version !== void 0 && (!Number.isInteger(value.version) || Number(value.version) < 0 || Number(value.version) > JSON_STORE_VERSION))
    throw new Error(`unsupported job archive: ${basename4(file)}; originals retained`);
  const jobs = Array.isArray(value) ? value : isRecord(value) ? value.jobs : void 0;
  if (!Array.isArray(jobs)) throw new Error(`invalid job archive: ${basename4(file)}; originals retained`);
  return jobs;
}
async function migrateJobArchives(path) {
  mkdirSync8(dirname8(path), { recursive: true, mode: 448 });
  physicalArchivePath(path);
  const release = migrationLock(`${jobArchivePath(path)}.legacy`);
  let close = () => {
  };
  const result = { imported: 0, moved: 0, kept: 0, deferred: false, manifests: [] };
  try {
    const db = openJobArchive(path, true);
    close = () => db.close();
    const state = db.prepare("SELECT state FROM archive_migrations WHERE version=1").get();
    if (state?.state === "complete") return result;
    const groups = [];
    for (const dir of [join11(dirname8(path), "archive"), dirname8(path)]) {
      if (!existsSync9(dir)) continue;
      physicalArchivePath(dir);
      const names = readdirSync6(dir).filter((name) => dir === dirname8(path) ? /^jobs\.json\.backup-/.test(name) || name === "jobs.json.overflow.json" : acceptArchive(name));
      names.sort((a, b) => {
        const time = (n) => Number(/(?:^jobs-|jobs\.json-|\.backup-|\.overflow\.json-)(\d+)/.exec(n)?.[1] ?? lstatSync4(join11(dir, n)).mtimeMs);
        return time(a) - time(b) || a.localeCompare(b);
      });
      groups.push({ dir, names });
    }
    const imported = /* @__PURE__ */ new Map();
    const verified = /* @__PURE__ */ new Set();
    let parsedBytes = 0;
    const importSource = (file, raw) => {
      const digest = jobDigest(raw);
      if (db.prepare("SELECT 1 FROM archive_sources WHERE path=? AND sha256=?").get(file, digest)) return;
      let jobs = imported.get(digest);
      if (!jobs) {
        jobs = records(raw, file);
        const cost = estimatedJsonBytes(jobs, 16 * 1024 * 1024);
        if (cost + parsedBytes <= 16 * 1024 * 1024) {
          imported.set(digest, jobs);
          parsedBytes += cost;
        }
      }
      const ownTransaction = !db.isTransaction;
      if (ownTransaction) db.exec("BEGIN IMMEDIATE");
      try {
        {
          const stamp = /(?:^jobs-|jobs\.json-|\.backup-|\.overflow\.json-)(\d+)/.exec(basename4(file))?.[1];
          putJobRecords(db, jobs, stamp ? Number(stamp) : lstatSync4(file).mtimeMs, false, true);
          const query = db.prepare("SELECT payload FROM job_versions WHERE id=? AND sha256=?");
          for (const job of verified.has(digest) ? [] : jobs) if (isRecord(job) && archivedRecordId(job) !== void 0) {
            const json = JSON.stringify(job), row = query.get(archivedRecordId(job), jobDigest(json));
            if (!row || row.payload !== json) throw new Error("job archive import verification failed; originals retained");
          }
          verified.add(digest);
        }
        db.prepare("INSERT INTO archive_sources(path,sha256,imported_at) VALUES(?,?,?)").run(file, digest, Date.now());
        if (ownTransaction) db.exec("COMMIT");
        result.imported++;
      } catch (error) {
        if (ownTransaction && db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    };
    for (const group of groups) for (let offset = 0; offset < group.names.length; offset += 32) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const name of group.names.slice(offset, offset + 32)) {
          const file = join11(group.dir, name);
          physicalArchivePath(file);
          const st = lstatSync4(file);
          if (!st.isFile()) throw new Error("job archive entry must be a physical file");
          importSource(file, readFileSync8(file));
        }
        db.exec("COMMIT");
        await yieldWriter(5);
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    }
    if (existsSync9(path)) {
      physicalArchivePath(path);
      const before = lstatSync4(path), jobs = records(readFileSync8(path), path);
      if (fileSignature(lstatSync4(path)) !== fileSignature(before)) throw new Error("active jobs changed during archive import; retry later");
      db.exec("BEGIN IMMEDIATE");
      try {
        putJobRecords(db, jobs, before.mtimeMs);
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
      markJobProjection(path, jobs, fileSignature(before));
    }
    db.prepare("INSERT INTO archive_migrations(version,state) VALUES(1,'imported') ON CONFLICT(version) DO UPDATE SET state='imported'").run();
    await refreshStorePeerIdentities(dirname8(path));
    try {
      assertStoreUpgrade(dirname8(path), "jobArchive", 0, 1);
    } catch (error) {
      if (error.code !== "STORE_UPGRADE_DEFERRED") throw error;
      result.deferred = true;
      return result;
    }
    const cold = join11(dirname8(path), "cold-storage", "jobs-v1");
    physicalArchivePath(cold);
    mkdirSync8(cold, { recursive: true, mode: 448 });
    physicalArchivePath(join11(cold, "archive"));
    for (const group of groups) {
      if (!group.names.length) continue;
      const manifest = bundleFiles(group.dir, group.names, cold);
      result.manifests.push(manifest);
      for (const [name, raw] of extractBundle(manifest)) importSource(join11(group.dir, name), raw);
      const originals = join11(cold, group.dir === dirname8(path) ? "root-originals" : "archive-originals");
      physicalArchivePath(originals);
      const moved = retireBundled(group.dir, manifest, originals);
      result.moved += moved.moved.length;
      result.kept += moved.kept.length;
    }
    if (!result.kept) db.prepare("UPDATE archive_migrations SET state='complete' WHERE version=1").run();
    return result;
  } finally {
    try {
      close();
    } finally {
      release();
    }
  }
}

// src/core/job-archive-worker.ts
try {
  parentPort?.postMessage({ result: await migrateJobArchives(workerData.path) });
} catch (error) {
  parentPort?.postMessage({ error: String(error) });
} finally {
  parentPort?.close();
}
