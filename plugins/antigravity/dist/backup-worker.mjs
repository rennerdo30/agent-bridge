import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/backup-worker.ts
import { constants, getPriority, setPriority } from "node:os";
import { setTimeout as pause } from "node:timers/promises";

// src/core/message-backups.ts
import { createHash as createHash4, randomUUID as randomUUID7 } from "node:crypto";
import { closeSync as closeSync6, existsSync as existsSync8, fsyncSync as fsyncSync4, lstatSync as lstatSync3, mkdirSync as mkdirSync7, openSync as openSync6, readFileSync as readFileSync7, readdirSync as readdirSync6, renameSync as renameSync5, writeFileSync as writeFileSync6 } from "node:fs";
import { open as open2 } from "node:fs/promises";
import { dirname as dirname7, join as join10, resolve as resolve3 } from "node:path";
import { DatabaseSync as DatabaseSync4 } from "node:sqlite";

// src/core/backups.ts
import { createHash as createHash3, randomUUID as randomUUID6 } from "node:crypto";
import { closeSync as closeSync5, copyFileSync as copyFileSync4, existsSync as existsSync7, fsyncSync as fsyncSync3, lstatSync as lstatSync2, mkdirSync as mkdirSync6, openSync as openSync5, readFileSync as readFileSync6, readSync, readdirSync as readdirSync5, renameSync as renameSync4, statSync as statSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname6, join as join9, relative, resolve as resolve2, sep } from "node:path";

// src/core/constants.ts
import { homedir } from "node:os";
import { join } from "node:path";
var APP_NAME = "agent-bridge";
var DEFAULT_HOME = join(homedir(), `.${APP_NAME}`);
var LOG_FILE_NAME = `${APP_NAME}.log`;
var MAX_FRAME_BYTES = 4 * 1024 * 1024;
var MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var PURGE_INTERVAL_MS = 60 * 60 * 1e3;
var QUEUED_MAIL_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var MAX_JOB_TIMEOUT_SEC = 24 * 60 * 60;

// src/core/json-store.ts
import { randomUUID as randomUUID3 } from "node:crypto";
import { closeSync as closeSync2, copyFileSync as copyFileSync2, existsSync as existsSync4, fsyncSync, mkdirSync as mkdirSync3, openSync as openSync2, readFileSync as readFileSync4, readdirSync as readdirSync4, renameSync as renameSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, dirname as dirname3, join as join5 } from "node:path";

// src/core/storage-lock.ts
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { dirname, join as join2 } from "node:path";
var LOCK_FILE = ".maintenance-lock";
var USERS_DIR = ".storage-users";
function storageLease(home) {
  const lock = join2(home, LOCK_FILE);
  if (existsSync(lock)) throw new Error("storage maintenance is in progress");
  const dir = join2(home, USERS_DIR);
  mkdirSync(dir, { recursive: true, mode: 448 });
  const path = join2(dir, `${process.pid}-${randomUUID()}`);
  closeSync(openSync(path, "wx", 384));
  if (existsSync(lock)) {
    rmSync(path);
    throw new Error("storage maintenance is in progress");
  }
  return () => rmSync(path, { force: true });
}

// src/core/store-compatibility.ts
import { existsSync as existsSync3, readdirSync as readdirSync3, readFileSync as readFileSync3, statSync } from "node:fs";
import { join as join4 } from "node:path";

// src/core/plugin-runtime.ts
import { randomUUID as randomUUID2, createHash } from "node:crypto";
import { copyFileSync, existsSync as existsSync2, lstatSync, mkdirSync as mkdirSync2, readdirSync as readdirSync2, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname as dirname2, join as join3, resolve } from "node:path";

// src/core/process-identity.ts
import { execFile, execFileSync } from "node:child_process";
import { readFileSync as readFileSync2 } from "node:fs";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
var exec = promisify(execFile);

// src/core/json-store.ts
function retentionLimit(key, fallback) {
  const raw = process.env[key];
  if (raw === void 0 || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}

// src/core/sqlite-maintenance.ts
import { existsSync as existsSync6 } from "node:fs";
import { dirname as dirname5, join as join8 } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// src/core/sqlite-migrations.ts
import { DatabaseSync } from "node:sqlite";
import { createHash as createHash2, randomUUID as randomUUID5 } from "node:crypto";
import { closeSync as closeSync4, copyFileSync as copyFileSync3, fsyncSync as fsyncSync2, mkdirSync as mkdirSync4, openSync as openSync4, writeFileSync as writeFileSync4 } from "node:fs";
import { basename as basename2, dirname as dirname4, join as join6 } from "node:path";

// src/core/migration-lock.ts
import { randomUUID as randomUUID4 } from "node:crypto";
import { closeSync as closeSync3, existsSync as existsSync5, openSync as openSync3, readFileSync as readFileSync5, rmSync as rmSync3, writeFileSync as writeFileSync3 } from "node:fs";

// src/core/logger.ts
import { appendFileSync, mkdirSync as mkdirSync5, renameSync as renameSync3, statSync as statSync2 } from "node:fs";
import { join as join7 } from "node:path";
var MAX_LOG_BYTES = 5 * 1024 * 1024;

// src/core/sqlite-policy.ts
import { setTimeout as delay } from "node:timers/promises";

// src/core/backups.ts
import * as sqlite from "node:sqlite";
import { open } from "node:fs/promises";
var DEFAULT_BACKUP_RETENTION = 7;
var DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1e3;
var BACKUP_RETENTION_ENV = "AGENT_BRIDGE_BACKUP_RETENTION";
var BACKUP_INTERVAL_ENV = "AGENT_BRIDGE_BACKUP_INTERVAL_MS";

// src/core/message-backups.ts
var MESSAGE_BACKUPS_DIR = "message-backups";
var TABLES = {
  "bridge.db": ["messages", "archived_messages", "job_delivery_routes"],
  "archive.db": ["messages"],
  "store-compatibility.db": ["job_delivery_routes"]
};
var MAX_ROWS_PER_WINDOW = 64;
var MAX_BYTES_PER_WINDOW = 256 * 1024;
var quote = (name) => `"${name.replaceAll('"', '""')}"`;
function syncFile(path) {
  const fd = openSync6(path, "r+");
  try {
    fsyncSync4(fd);
  } finally {
    closeSync6(fd);
  }
}
function assertPhysical(path) {
  for (let at = resolve3(path); ; at = dirname7(at)) {
    try {
      if (lstatSync3(at).isSymbolicLink()) throw new Error("Message backup refuses linked paths");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (dirname7(at) === at) break;
  }
}
function rowDigest(row) {
  return Buffer.from(JSON.stringify(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Uint8Array ? ["blob", Buffer.from(value).toString("base64")] : [typeof value, String(value)]
  ])) + "\n");
}
function listMessageBackups(home) {
  const root = join10(home, MESSAGE_BACKUPS_DIR);
  assertPhysical(root);
  if (!existsSync8(root)) return [];
  return readdirSync6(root).filter((name) => name.startsWith("messages-")).flatMap((name) => {
    const path = join10(root, name);
    try {
      if (lstatSync3(path).isSymbolicLink()) return [];
      const manifestPath = join10(path, "manifest.json");
      if (lstatSync3(manifestPath).isSymbolicLink()) return [];
      const manifest = JSON.parse(readFileSync7(manifestPath, "utf8"));
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
  for (const path of [home, join10(home, MESSAGE_BACKUPS_DIR), join10(home, ".storage-users"), join10(home, "message-backup-lock.db")]) assertPhysical(path);
  const release = storageLease(home);
  let lock;
  let staging;
  try {
    lock = new DatabaseSync4(join10(home, "message-backup-lock.db"), { timeout: 0 });
    if (Number(lock.prepare("PRAGMA user_version").get().user_version) > 1) throw new Error("Unsupported message backup coordination schema");
    try {
      lock.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS generation(id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, nonce TEXT NOT NULL, started_at INTEGER NOT NULL); PRAGMA user_version=1;");
      lock.prepare("INSERT INTO generation VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,nonce=excluded.nonce,started_at=excluded.started_at").run(process.pid, randomUUID7(), now);
    } catch (error) {
      if (/database is locked|database is busy/.test(String(error))) return { path: null, skipped: "already-running" };
      throw error;
    }
    if (now - (listMessageBackups(home)[0]?.createdAt ?? 0) < interval) return { path: null, skipped: "not-due" };
    const root = join10(home, MESSAGE_BACKUPS_DIR), name = `messages-${String(now).padStart(13, "0")}-${randomUUID7()}`;
    staging = join10(root, `.pending-${name}`);
    mkdirSync7(staging, { recursive: true, mode: 448 });
    const manifest = {
      version: 1,
      kind: "message-tables",
      createdAt: now,
      restore: "merge-selected-tables-only",
      excludes: ["conversation-history", "other-tables", "json-stores"],
      files: []
    };
    const checksum = async (path) => {
      const file = await open2(path, "r"), hash = createHash4("sha256"), buffer = Buffer.allocUnsafe(MAX_BYTES_PER_WINDOW);
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
      const sourcePath = join10(home, sourceName);
      if (!existsSync8(sourcePath)) continue;
      assertPhysical(sourcePath);
      await control.checkpoint();
      const source = new DatabaseSync4(sourcePath, { readOnly: true, timeout: 100 });
      const path = sourceName.replace(/\.db$/, ".messages.db"), targetPath = join10(staging, path);
      let target;
      try {
        source.exec("BEGIN");
        const sourceVersion = Number(source.prepare("PRAGMA user_version").get().user_version);
        const schemas = names.flatMap((name2) => {
          const row = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name2);
          return typeof row?.sql === "string" ? [{ name: name2, schema: row.sql }] : [];
        });
        if (!schemas.length) continue;
        target = new DatabaseSync4(targetPath, { timeout: 100 });
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
          const hash = createHash4("sha256");
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
          const expected = hash.digest("hex"), verification = createHash4("sha256");
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
        syncFile(targetPath);
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
    writeFileSync6(join10(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 384 });
    syncFile(join10(staging, "manifest.json"));
    const published = join10(root, name);
    renameSync5(staging, published);
    const retention = retentionLimit(BACKUP_RETENTION_ENV, DEFAULT_BACKUP_RETENTION);
    if (retention) for (const previous of listMessageBackups(home).slice(retention)) {
      await control.checkpoint();
      const archive = join10(root, "archive");
      assertPhysical(archive);
      mkdirSync7(archive, { recursive: true, mode: 448 });
      renameSync5(previous.path, join10(archive, previous.path.split(/[\\/]/).at(-1)));
    }
    lock.exec("COMMIT");
    return { path: published };
  } catch (error) {
    if (staging && existsSync8(staging)) writeFileSync6(join10(staging, "failure.json"), JSON.stringify({ version: 1, at: Date.now(), error: String(error) }) + "\n", { flag: "wx", mode: 384 });
    throw error;
  } finally {
    try {
      lock?.close();
    } finally {
      release();
    }
  }
}

// src/core/backup-worker.ts
var pending = false;
var stop = false;
var pauseUntil = 0;
var pressureSince = 0;
var started = false;
process.on("message", (message) => {
  if (message.type === "pressure") {
    pending = !!message.pending;
    pauseUntil = message.pauseUntil ?? 0;
  }
  if (message.type === "stop") stop = true;
  if (message.type === "start" && typeof message.home === "string" && !started) {
    started = true;
    void run(message.home);
  }
});
process.once("disconnect", () => {
  stop = true;
});
async function checkpoint() {
  for (; ; ) {
    if (stop) throw new Error("Automatic message backup stopped; incomplete snapshot preserved");
    if (!pending && Date.now() >= pauseUntil) {
      pressureSince = 0;
      break;
    }
    pressureSince ||= Date.now();
    if (Date.now() - pressureSince >= 5e3) throw new Error("Automatic message backup paused for sustained broker pressure; incomplete snapshot preserved");
    await pause(100);
  }
  await pause(5);
  if (stop) throw new Error("Automatic message backup stopped; incomplete snapshot preserved");
}
async function run(home) {
  try {
    setPriority(process.pid, constants.priority.PRIORITY_LOW);
    const priority = getPriority(process.pid);
    if (priority < constants.priority.PRIORITY_BELOW_NORMAL) throw new Error("Automatic message backup could not lower its process priority");
    const result = await messageBackupIfDue(home, { checkpoint });
    process.send?.({ ...result, priority }, () => process.disconnect?.());
  } catch (error) {
    process.send?.({ error: String(error) }, () => process.disconnect?.());
  }
}
