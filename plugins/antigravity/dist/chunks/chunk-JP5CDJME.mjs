import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  ARCHIVE_DB_NAME,
  closeMetadataDb,
  isRecord,
  maintenanceLock,
  retentionLimit,
  snapshotDatabase,
  storageLease
} from "./chunk-ZI3EJK3N.mjs";
import {
  DB_FILE_NAME
} from "./chunk-GWP4RZPO.mjs";

// src/core/backups.ts
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as sqlite from "node:sqlite";
import { open } from "node:fs/promises";
var BACKUPS_DIR_NAME = "backups";
var BACKUP_MANIFEST_VERSION = 1;
var DEFAULT_BACKUP_RETENTION = 7;
var DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1e3;
var BACKUP_RETENTION_ENV = "AGENT_BRIDGE_BACKUP_RETENTION";
var BACKUP_INTERVAL_ENV = "AGENT_BRIDGE_BACKUP_INTERVAL_MS";
var MANIFEST_NAME = "manifest.json";
var BACKUP_PREFIX = "snapshot-";
var USER_DATABASES = [DB_FILE_NAME, ARCHIVE_DB_NAME, "history.db", "store-compatibility.db", "owner-questions.db"];
function digest(path) {
  const hash = createHash("sha256"), fd = openSync(path, "r"), buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    for (let bytes; (bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0; ) hash.update(buffer.subarray(0, bytes));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}
function syncFile(path) {
  const fd = openSync(path, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function jsonStoreFiles(home) {
  if (!existsSync(home)) return [];
  const files = [];
  const visit = (dir, recurse) => {
    if (!existsSync(dir)) return;
    const root = lstatSync(dir);
    if (root.isSymbolicLink() || !root.isDirectory()) return;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory() && recurse) visit(path, true);
      else if (st.isFile() && name !== "dashboard.json" && /\.jsonl?(?:-\d+-[\w-]+)?$/.test(name)) files.push(path);
    }
  };
  visit(home, false);
  for (const dir of ["jobs", "runs", "archive", "read-state", "job-outcomes", "local-result-receipts"]) visit(join(home, dir), true);
  return files;
}
function listBackups(home) {
  const dir = join(home, BACKUPS_DIR_NAME);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(BACKUP_PREFIX)).flatMap((f) => {
    const path = join(dir, f);
    try {
      const manifest = JSON.parse(readFileSync(join(path, MANIFEST_NAME), "utf8"));
      return [{ path, createdAt: manifest.createdAt }];
    } catch {
      return [];
    }
  }).sort((a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path));
}
function createBackup(home, now = Date.now(), rotate = true) {
  const release = storageLease(home);
  try {
    return createBackupUnlocked(home, now, rotate);
  } finally {
    release();
  }
}
function createBackupUnlocked(home, now, rotate) {
  const root = join(home, BACKUPS_DIR_NAME);
  mkdirSync(root, { recursive: true, mode: 448 });
  const name = `${BACKUP_PREFIX}${String(now).padStart(13, "0")}-${randomUUID()}`;
  const staging = join(root, `.pending-${name}`);
  mkdirSync(staging, { mode: 448 });
  const manifest = { version: BACKUP_MANIFEST_VERSION, createdAt: now, files: [] };
  const capture = (source, sqlite2) => {
    const path = relative(home, source).split(sep).join("/");
    const target = join(staging, path);
    mkdirSync(dirname(target), { recursive: true, mode: 448 });
    if (sqlite2) snapshotDatabase(source, target);
    else copyFileSync(source, target);
    syncFile(target);
    manifest.files.push({ path, sha256: digest(target), bytes: statSync(target).size });
  };
  for (const name2 of USER_DATABASES) if (existsSync(join(home, name2))) capture(join(home, name2), true);
  for (const file of jsonStoreFiles(home)) capture(file, false);
  writeFileSync(join(staging, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", { mode: 384 });
  syncFile(join(staging, MANIFEST_NAME));
  const published = join(root, name);
  renameSync(staging, published);
  if (rotate) {
    const retention = retentionLimit(BACKUP_RETENTION_ENV, DEFAULT_BACKUP_RETENTION);
    if (retention) for (const backup2 of listBackups(home).slice(retention)) {
      const cold = join(root, "archive");
      mkdirSync(cold, { recursive: true, mode: 448 });
      renameSync(backup2.path, join(cold, backup2.path.split(/[\\/]/).at(-1)));
    }
  }
  return published;
}
function allowedPath(path) {
  return USER_DATABASES.some((name) => path === name) || /^[\w.-]+\.json$/.test(path) && !["dashboard.json"].includes(path) || /^(jobs|runs|archive|read-state|job-outcomes|local-result-receipts)\/[\w./-]+$/.test(path) && !path.split("/").some((s) => s === ".." || s === ".") && /\.jsonl?(?:-\d+-[\w-]+)?$/.test(path);
}
function createRecovery(home) {
  const root = join(home, BACKUPS_DIR_NAME, `recovery-${Date.now()}-${randomUUID()}`);
  mkdirSync(root, { recursive: true, mode: 448 });
  const files = jsonStoreFiles(home);
  for (const name of USER_DATABASES) for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = join(home, name + suffix);
    if (existsSync(file)) files.push(file);
  }
  for (const source of files) {
    const target = join(root, relative(home, source));
    mkdirSync(dirname(target), { recursive: true, mode: 448 });
    copyFileSync(source, target);
    syncFile(target);
  }
  return root;
}
function readBackup(path) {
  const value = JSON.parse(readFileSync(join(path, MANIFEST_NAME), "utf8"));
  if (!isRecord(value) || value.kind !== void 0 && value.kind !== "full" || value.version !== BACKUP_MANIFEST_VERSION || !Number.isFinite(value.createdAt) || !Array.isArray(value.files)) throw new Error("unsupported full backup manifest; scoped message snapshots require a table merge");
  const seen = /* @__PURE__ */ new Set();
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== "string" || !allowedPath(file.path) || seen.has(file.path)) throw new Error("unsafe or duplicate backup path");
    seen.add(file.path);
    const source = resolve(path, file.path);
    if (!source.startsWith(resolve(path) + sep) || lstatSync(source).isSymbolicLink() || digest(source) !== file.sha256) throw new Error(`backup checksum mismatch: ${file.path}`);
    for (let dir = dirname(source); dir !== resolve(path); dir = dirname(dir)) {
      if (lstatSync(dir).isSymbolicLink()) throw new Error("unsafe backup directory");
    }
  }
  return value;
}
function restoreBackup(home, backup2, confirmed) {
  if (!confirmed) throw new Error("restore requires confirmation");
  const manifest = readBackup(backup2);
  const unlock = maintenanceLock(home);
  try {
    closeMetadataDb(home);
    const recovery = createRecovery(home);
    const displaced = join(recovery, "displaced");
    mkdirSync(displaced, { mode: 448 });
    const restored = [];
    const moved = [];
    try {
      for (const file of manifest.files) {
        const target = resolve(home, file.path);
        for (let dir = dirname(target); dir !== resolve(home); dir = dirname(dir)) {
          if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error("unsafe restore directory");
        }
        mkdirSync(dirname(target), { recursive: true, mode: 448 });
        const paths = target.endsWith(".db") ? [target, `${target}-wal`, `${target}-shm`, `${target}-journal`] : [target];
        for (const source of paths) if (existsSync(source)) {
          const preserved = join(displaced, relative(home, source));
          mkdirSync(dirname(preserved), { recursive: true, mode: 448 });
          renameSync(source, preserved);
          moved.push({ source, target: preserved });
        }
        const tmp = `${target}.${randomUUID()}.restore`;
        copyFileSync(join(backup2, file.path), tmp);
        syncFile(tmp);
        if (digest(tmp) !== file.sha256) throw new Error("backup changed during restore");
        renameSync(tmp, target);
        restored.push(target);
      }
    } catch (err) {
      for (const target of restored) renameSync(target, `${target}.failed-restore-${randomUUID()}`);
      for (const entry of moved.reverse()) renameSync(entry.target, entry.source);
      throw err;
    }
    return recovery;
  } finally {
    unlock();
  }
}

// src/core/message-backups.ts
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import { closeSync as closeSync2, existsSync as existsSync2, fsyncSync as fsyncSync2, lstatSync as lstatSync2, mkdirSync as mkdirSync2, openSync as openSync2, readFileSync as readFileSync2, readdirSync as readdirSync2, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { open as open2 } from "node:fs/promises";
import { dirname as dirname2, join as join2, resolve as resolve2 } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
var MESSAGE_BACKUPS_DIR = "message-backups";
var AUTO_BACKUP_ENV = "AGENT_BRIDGE_AUTO_BACKUP";
var TABLES = {
  "bridge.db": ["messages", "archived_messages", "job_delivery_routes"],
  "archive.db": ["messages"],
  "store-compatibility.db": ["job_delivery_routes"]
};
var MAX_ROWS_PER_WINDOW = 64;
var MAX_BYTES_PER_WINDOW = 256 * 1024;
var quote = (name) => `"${name.replaceAll('"', '""')}"`;
function syncFile2(path) {
  const fd = openSync2(path, "r+");
  try {
    fsyncSync2(fd);
  } finally {
    closeSync2(fd);
  }
}
function assertPhysical(path) {
  for (let at = resolve2(path); ; at = dirname2(at)) {
    try {
      if (lstatSync2(at).isSymbolicLink()) throw new Error("Message backup refuses linked paths");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (dirname2(at) === at) break;
  }
}
function rowDigest(row) {
  return Buffer.from(JSON.stringify(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Uint8Array ? ["blob", Buffer.from(value).toString("base64")] : [typeof value, String(value)]
  ])) + "\n");
}
function listMessageBackups(home) {
  const root = join2(home, MESSAGE_BACKUPS_DIR);
  assertPhysical(root);
  if (!existsSync2(root)) return [];
  return readdirSync2(root).filter((name) => name.startsWith("messages-")).flatMap((name) => {
    const path = join2(root, name);
    try {
      if (lstatSync2(path).isSymbolicLink()) return [];
      const manifestPath = join2(path, "manifest.json");
      if (lstatSync2(manifestPath).isSymbolicLink()) return [];
      const manifest = JSON.parse(readFileSync2(manifestPath, "utf8"));
      return manifest.version === 1 && manifest.kind === "message-tables" && Number.isFinite(manifest.createdAt) ? [{ path, createdAt: manifest.createdAt }] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path));
}
async function messageBackupIfDue(home, control, now = Date.now()) {
  const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
  if (!interval) return { path: null, skipped: "not-due" };
  await control.checkpoint();
  for (const path of [home, join2(home, MESSAGE_BACKUPS_DIR), join2(home, ".storage-users"), join2(home, "message-backup-lock.db")]) assertPhysical(path);
  const release = storageLease(home);
  let lock;
  let staging;
  try {
    lock = new DatabaseSync2(join2(home, "message-backup-lock.db"), { timeout: 0 });
    if (Number(lock.prepare("PRAGMA user_version").get().user_version) > 1) throw new Error("Unsupported message backup coordination schema");
    try {
      lock.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS generation(id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL, started_at INTEGER NOT NULL); PRAGMA user_version=1;");
      lock.prepare("INSERT INTO generation VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,nonce=excluded.nonce,started_at=excluded.started_at").run(process.pid, randomUUID2(), now);
    } catch (error) {
      if (/database is locked|database is busy/.test(String(error))) return { path: null, skipped: "already-running" };
      throw error;
    }
    if (now - (listMessageBackups(home)[0]?.createdAt ?? 0) < interval) return { path: null, skipped: "not-due" };
    const root = join2(home, MESSAGE_BACKUPS_DIR), name = `messages-${String(now).padStart(13, "0")}-${randomUUID2()}`;
    staging = join2(root, `.pending-${name}`);
    mkdirSync2(staging, { recursive: true, mode: 448 });
    const manifest = {
      version: 1,
      kind: "message-tables",
      createdAt: now,
      restore: "merge-selected-tables-only",
      excludes: ["conversation-history", "other-tables", "json-stores"],
      files: []
    };
    const checksum = async (path) => {
      const file = await open2(path, "r"), hash = createHash2("sha256"), buffer = Buffer.allocUnsafe(MAX_BYTES_PER_WINDOW);
      let bytes = 0;
      try {
        for (; ; ) {
          await control.checkpoint();
          const chunk = await file.read(buffer, 0, buffer.length, bytes);
          if (!chunk.bytesRead) break;
          hash.update(buffer.subarray(0, chunk.bytesRead));
          bytes += chunk.bytesRead;
        }
      } finally {
        await file.close();
      }
      return { bytes, sha256: hash.digest("hex") };
    };
    for (const [sourceName, names] of Object.entries(TABLES)) {
      const sourcePath = join2(home, sourceName);
      if (!existsSync2(sourcePath)) continue;
      assertPhysical(sourcePath);
      await control.checkpoint();
      const source = new DatabaseSync2(sourcePath, { readOnly: true, timeout: 100 });
      const path = sourceName.replace(/\.db$/, ".messages.db"), targetPath = join2(staging, path);
      let target;
      try {
        source.exec("BEGIN");
        const sourceVersion = Number(source.prepare("PRAGMA user_version").get().user_version);
        const schemas = names.flatMap((name2) => {
          const row = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name2);
          return typeof row?.sql === "string" ? [{ name: name2, schema: row.sql }] : [];
        });
        if (!schemas.length) continue;
        target = new DatabaseSync2(targetPath, { timeout: 100 });
        target.exec("PRAGMA synchronous=FULL;");
        const tables = [];
        for (const { name: name2, schema } of schemas) {
          await control.checkpoint();
          target.exec(schema);
          const columns = source.prepare(`PRAGMA table_xinfo(${quote(name2)})`).all().filter((column) => column.hidden === 0).map((column) => String(column.name));
          const selection = `SELECT rowid AS _ab_backup_rowid,${columns.map(quote).join(",")} FROM ${quote(name2)} ORDER BY rowid`;
          const read = source.prepare(selection);
          read.setReadBigInts(true);
          const insert = target.prepare(`INSERT INTO ${quote(name2)}(rowid,${columns.map(quote).join(",")}) VALUES(${columns.map(() => "?").concat("?").join(",")})`);
          const hash = createHash2("sha256");
          let rows = 0, windowRows = 0, windowBytes = 0;
          target.exec("BEGIN");
          for (const raw of read.iterate()) {
            const row = raw, bytes = rowDigest(row);
            insert.run(row._ab_backup_rowid, ...columns.map((column) => row[column]));
            hash.update(bytes);
            rows++;
            windowRows++;
            windowBytes += bytes.length;
            if (windowRows >= MAX_ROWS_PER_WINDOW || windowBytes >= MAX_BYTES_PER_WINDOW) {
              target.exec("COMMIT");
              await control.checkpoint();
              target.exec("BEGIN");
              windowRows = 0;
              windowBytes = 0;
            }
          }
          target.exec("COMMIT");
          const expected = hash.digest("hex"), verification = createHash2("sha256");
          let verifiedRows = 0;
          const reread = target.prepare(selection);
          reread.setReadBigInts(true);
          windowRows = 0;
          windowBytes = 0;
          for (const raw of reread.iterate()) {
            const bytes = rowDigest(raw);
            verification.update(bytes);
            verifiedRows++;
            windowRows++;
            windowBytes += bytes.length;
            if (windowRows >= MAX_ROWS_PER_WINDOW || windowBytes >= MAX_BYTES_PER_WINDOW) {
              await control.checkpoint();
              windowRows = 0;
              windowBytes = 0;
            }
          }
          await control.checkpoint();
          if (rows !== verifiedRows || expected !== verification.digest("hex") || target.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name2).sql !== schema) throw new Error(`Message backup table verification failed: ${sourceName}/${name2}`);
          tables.push({ name: name2, schema, rows, sha256: expected });
        }
        source.exec("ROLLBACK");
        target.close();
        target = void 0;
        await control.checkpoint();
        syncFile2(targetPath);
        const copied = await checksum(targetPath), verified = await checksum(targetPath);
        if (copied.bytes !== verified.bytes || copied.sha256 !== verified.sha256) throw new Error(`Message backup checksum verification failed: ${sourceName}`);
        manifest.files.push({ path, source: sourceName, sourceVersion, ...verified, tables });
      } finally {
        try {
          target?.close();
        } finally {
          source.close();
        }
      }
    }
    await control.checkpoint();
    writeFileSync2(join2(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 384 });
    syncFile2(join2(staging, "manifest.json"));
    const published = join2(root, name);
    renameSync2(staging, published);
    const retention = retentionLimit(BACKUP_RETENTION_ENV, DEFAULT_BACKUP_RETENTION);
    if (retention) for (const previous of listMessageBackups(home).slice(retention)) {
      await control.checkpoint();
      const archive = join2(root, "archive");
      assertPhysical(archive);
      mkdirSync2(archive, { recursive: true, mode: 448 });
      renameSync2(previous.path, join2(archive, previous.path.split(/[\\/]/).at(-1)));
    }
    lock.exec("COMMIT");
    return { path: published };
  } catch (error) {
    if (staging && existsSync2(staging)) writeFileSync2(join2(staging, "failure.json"), JSON.stringify({ version: 1, at: Date.now(), error: String(error) }) + "\n", { flag: "wx", mode: 384 });
    throw error;
  } finally {
    try {
      lock?.close();
    } finally {
      release();
    }
  }
}

export {
  DEFAULT_BACKUP_INTERVAL_MS,
  BACKUP_INTERVAL_ENV,
  jsonStoreFiles,
  listBackups,
  createBackup,
  readBackup,
  restoreBackup,
  AUTO_BACKUP_ENV,
  messageBackupIfDue
};
