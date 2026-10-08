import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/backup-worker.ts
import { parentPort, workerData } from "node:worker_threads";

// src/core/backups.ts
import { createHash as createHash3, randomUUID as randomUUID6 } from "node:crypto";
import { closeSync as closeSync5, copyFileSync as copyFileSync4, existsSync as existsSync7, fsyncSync as fsyncSync3, lstatSync as lstatSync2, mkdirSync as mkdirSync6, openSync as openSync5, readFileSync as readFileSync6, readSync, readdirSync as readdirSync5, renameSync as renameSync4, statSync as statSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname6, join as join9, relative, resolve as resolve2, sep } from "node:path";

// src/core/constants.ts
import { homedir } from "node:os";
import { join } from "node:path";
var APP_NAME = "agent-bridge";
var DEFAULT_HOME = join(homedir(), `.${APP_NAME}`);
var DB_FILE_NAME = "bridge.db";
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

// src/core/sqlite-maintenance.ts
var ARCHIVE_DB_NAME = "archive.db";

// src/core/backups.ts
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
function syncFile(path) {
  const fd = openSync5(path, "r+");
  try {
    fsyncSync3(fd);
  } finally {
    closeSync5(fd);
  }
}
function jsonStoreFiles(home) {
  if (!existsSync7(home)) return [];
  const files = [];
  const visit = (dir, recurse) => {
    if (!existsSync7(dir)) return;
    const root = lstatSync2(dir);
    if (root.isSymbolicLink() || !root.isDirectory()) return;
    for (const name of readdirSync5(dir).sort()) {
      const path = join9(dir, name);
      const st = lstatSync2(path);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory() && recurse) visit(path, true);
      else if (st.isFile() && name !== "dashboard.json" && /\.jsonl?(?:-\d+-[\w-]+)?$/.test(name)) files.push(path);
    }
  };
  visit(home, false);
  for (const dir of ["jobs", "runs", "archive", "read-state", "job-outcomes", "local-result-receipts"]) visit(join9(home, dir), true);
  return files;
}
function listBackups(home) {
  const dir = join9(home, BACKUPS_DIR_NAME);
  if (!existsSync7(dir)) return [];
  return readdirSync5(dir).filter((f) => f.startsWith(BACKUP_PREFIX)).flatMap((f) => {
    const path = join9(dir, f);
    try {
      const manifest = JSON.parse(readFileSync6(join9(path, MANIFEST_NAME), "utf8"));
      return [{ path, createdAt: manifest.createdAt }];
    } catch {
      return [];
    }
  }).sort((a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path));
}
async function backupIfDueBackground(home, control, now = Date.now()) {
  const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
  if (!interval || now - (listBackups(home)[0]?.createdAt ?? 0) < interval) return null;
  control.checkpoint();
  if (typeof sqlite.backup !== "function") throw new Error("Automatic backup deferred: incremental SQLite backup requires a newer Node runtime; existing data is untouched");
  const release = storageLease(home);
  const root = join9(home, BACKUPS_DIR_NAME);
  const name = `${BACKUP_PREFIX}${String(now).padStart(13, "0")}-${randomUUID6()}`;
  const staging = join9(root, `.pending-${name}`);
  const manifest = { version: BACKUP_MANIFEST_VERSION, createdAt: now, files: [] };
  try {
    mkdirSync6(staging, { recursive: true, mode: 448 });
    const checksum = async (file) => {
      const handle = await open(file, "r");
      const hash = createHash3("sha256");
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let bytes = 0;
      try {
        for (; ; ) {
          control.checkpoint();
          const read = await handle.read(buffer, 0, buffer.length, bytes);
          if (!read.bytesRead) break;
          hash.update(buffer.subarray(0, read.bytesRead));
          bytes += read.bytesRead;
        }
      } finally {
        await handle.close();
      }
      return { bytes, sha256: hash.digest("hex") };
    };
    const capture = async (source, database) => {
      control.checkpoint();
      const path = relative(home, source).split(sep).join("/");
      const target = join9(staging, path);
      mkdirSync6(dirname6(target), { recursive: true, mode: 448 });
      if (database) {
        const db = new sqlite.DatabaseSync(source, { readOnly: true, timeout: 100 });
        try {
          db.exec("BEGIN");
          db.prepare("PRAGMA schema_version").get();
          const version = db.prepare("PRAGMA user_version").get().user_version;
          await sqlite.backup(db, target, { rate: 32, progress: () => control.checkpoint() });
          db.exec("ROLLBACK");
          const copied = new sqlite.DatabaseSync(target, { readOnly: true, timeout: 100 });
          try {
            if (copied.prepare("PRAGMA user_version").get().user_version !== version) throw new Error(`Backup version verification failed: ${path}`);
            copied.prepare("SELECT count(*) FROM sqlite_master").get();
          } finally {
            copied.close();
          }
        } finally {
          db.close();
        }
      } else {
        const sourceHandle = await open(source, "r");
        let targetHandle;
        try {
          targetHandle = await open(target, "wx", 384);
          const length = (await sourceHandle.stat()).size;
          const buffer = Buffer.allocUnsafe(256 * 1024);
          for (let at = 0; at < length; ) {
            control.checkpoint();
            const chunk = await sourceHandle.read(buffer, 0, Math.min(buffer.length, length - at), at);
            if (!chunk.bytesRead) throw new Error(`Backup source shortened during capture: ${path}`);
            for (let written = 0; written < chunk.bytesRead; ) {
              const result = await targetHandle.write(buffer, written, chunk.bytesRead - written, at + written);
              if (!result.bytesWritten) throw new Error(`Backup write made no progress: ${path}`);
              written += result.bytesWritten;
            }
            at += chunk.bytesRead;
          }
          await targetHandle.sync();
        } finally {
          await sourceHandle.close();
          await targetHandle?.close();
        }
      }
      control.checkpoint();
      syncFile(target);
      const first = await checksum(target);
      const verified = await checksum(target);
      if (first.bytes !== verified.bytes || first.sha256 !== verified.sha256) throw new Error(`Backup checksum verification failed: ${path}`);
      manifest.files.push({ path, ...verified });
    };
    for (const name2 of USER_DATABASES) if (existsSync7(join9(home, name2))) await capture(join9(home, name2), true);
    for (const file of jsonStoreFiles(home)) await capture(file, false);
    control.checkpoint();
    writeFileSync5(join9(staging, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 384 });
    syncFile(join9(staging, MANIFEST_NAME));
    const published = join9(root, name);
    renameSync4(staging, published);
    const retention = retentionLimit(BACKUP_RETENTION_ENV, DEFAULT_BACKUP_RETENTION);
    if (retention) for (const previous of listBackups(home).slice(retention)) {
      control.checkpoint();
      const cold = join9(root, "archive");
      mkdirSync6(cold, { recursive: true, mode: 448 });
      renameSync4(previous.path, join9(cold, previous.path.split(/[\\/]/).at(-1)));
    }
    return published;
  } catch (error) {
    if (existsSync7(staging)) writeFileSync5(join9(staging, "failure.json"), JSON.stringify({ version: 1, at: Date.now(), error: String(error) }) + "\n", { flag: "wx", mode: 384 });
    throw error;
  } finally {
    release();
  }
}

// src/core/backup-worker.ts
var state = new Int32Array(workerData.pressure, 0, 2);
var pauseUntil = new BigInt64Array(workerData.pressure, 8, 1);
var pressureSince = 0;
var checkpoint = () => {
  for (; ; ) {
    if (Atomics.load(state, 1)) throw new Error("Automatic backup stopped; incomplete snapshot preserved");
    const paused = !!Atomics.load(state, 0) || Date.now() < Number(Atomics.load(pauseUntil, 0));
    if (!paused) {
      pressureSince = 0;
      break;
    }
    pressureSince ||= Date.now();
    if (Date.now() - pressureSince >= 5e3) throw new Error("Automatic backup paused for sustained broker pressure; incomplete snapshot preserved");
    Atomics.wait(state, 0, Atomics.load(state, 0), 100);
  }
  Atomics.wait(state, 1, 0, 5);
};
try {
  const path = await backupIfDueBackground(workerData.home, { checkpoint });
  parentPort?.postMessage({ path });
} catch (error) {
  parentPort?.postMessage({ error: String(error) });
} finally {
  parentPort?.close();
}
