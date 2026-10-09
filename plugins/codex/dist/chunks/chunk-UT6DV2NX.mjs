import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  assertStoreUpgrade,
  backupPath,
  retainBackups
} from "./chunk-GN275QYC.mjs";
import {
  ENV,
  LOG_DIR_NAME,
  LOG_FILE_NAME
} from "./chunk-PEBTAWO6.mjs";

// src/core/logger.ts
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
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
    if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
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
    const dir = join(opts.home, LOG_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    sink.file = join(dir, LOG_FILE_NAME);
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
        appendFileSync(sink.file, line);
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
import { existsSync as existsSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// src/core/sqlite-migrations.ts
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID as randomUUID2 } from "node:crypto";
import { closeSync as closeSync2, copyFileSync, fsyncSync, mkdirSync as mkdirSync2, openSync as openSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, dirname, join as join2 } from "node:path";

// src/core/migration-lock.ts
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
function migrationLock(file) {
  if (file === ":memory:") return () => {
  };
  const path = `${file}.migration-lock`, recovery = `${path}.recovery`;
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const until = Date.now() + 5e3;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (; ; ) {
    try {
      const fd = openSync(path, "wx", 384);
      try {
        writeFileSync(fd, owner);
      } catch (error) {
        closeSync(fd);
        rmSync(path);
        throw error;
      }
      closeSync(fd);
      return () => {
        if (readFileSync(path, "utf8") === owner) rmSync(path);
      };
    } catch (error) {
      if (!["EEXIST", "EPERM", "EBUSY", "EACCES"].includes(error.code ?? "")) throw error;
    }
    let recoveryFd;
    try {
      let dead = false;
      if (existsSync(path)) try {
        const pid = JSON.parse(readFileSync(path, "utf8")).pid;
        if (Number.isSafeInteger(pid) && pid > 0) try {
          process.kill(pid, 0);
        } catch (error) {
          dead = error.code === "ESRCH";
        }
      } catch {
      }
      if (dead) {
        recoveryFd = openSync(recovery, "wx", 384);
        if (existsSync(path)) {
          const pid = JSON.parse(readFileSync(path, "utf8")).pid;
          if (Number.isSafeInteger(pid) && pid > 0) try {
            process.kill(pid, 0);
          } catch (error) {
            if (error.code === "ESRCH") rmSync(path);
          }
        }
      }
    } catch (error) {
      if (!["EEXIST", "ENOENT", "EPERM", "EBUSY", "EACCES"].includes(error.code ?? "")) throw error;
    } finally {
      if (recoveryFd !== void 0) {
        closeSync(recoveryFd);
        rmSync(recovery);
      }
    }
    if (Date.now() >= until) throw Object.assign(new Error("another session is migrating this store; waiting for its protected snapshot and commit"), { code: "EBUSY" });
    Atomics.wait(pause, 0, 0, 20);
  }
}

// src/core/sqlite-migrations.ts
var MAX_SNAPSHOT_ATTEMPTS = 10;
function metadataSnapshot(db, path, tables, version, target) {
  const snapshot = new DatabaseSync(path);
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
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if (!schema || typeof schema.sql !== "string") throw new Error(`Missing migration snapshot table: ${table}`);
      snapshot.exec(schema.sql);
      const source = db.prepare(`SELECT rowid AS __migration_rowid__, * FROM ${quote(table)} ORDER BY rowid`);
      source.setReadBigInts(true);
      const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((row) => String(row.name));
      const insert = snapshot.prepare(`INSERT INTO ${quote(table)} (rowid,${columns.map(quote).join(",")}) VALUES (${["rowid", ...columns].map(() => "?").join(",")})`);
      const expected = createHash("sha256");
      let rows = 0;
      for (const row of source.iterate()) {
        insert.run(row.__migration_rowid__, ...columns.map((name) => row[name]));
        expected.update(digest(row));
        rows++;
      }
      const actual = createHash("sha256");
      const verify = snapshot.prepare(`SELECT rowid AS __migration_rowid__, * FROM ${quote(table)} ORDER BY rowid`);
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
    const manifestFile = openSync2(`${path}.manifest.json`, "r+");
    try {
      fsyncSync(manifestFile);
    } finally {
      closeSync2(manifestFile);
    }
  } finally {
    snapshot.close();
  }
}
function migrateSqlite(db, file, existed, target, migrations, log) {
  const release = migrationLock(file);
  try {
    migrateLocked(db, file, existed, target, migrations, log);
  } finally {
    release();
  }
}
function migrateLocked(db, file, existed, target, migrations, log) {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  const version = Number(db.prepare("PRAGMA user_version").get().user_version);
  if (version > target) throw new Error(`unsupported SQLite store version: ${version}`);
  if (version === target) return;
  if (basename(file) === "bridge.db") assertStoreUpgrade(dirname(file), "sqlite", version, target);
  let backup = null;
  for (let attempt = 0; ; attempt++) {
    if (attempt >= MAX_SNAPSHOT_ATTEMPTS) throw Object.assign(new Error("database kept changing before migration; waiting to retry while sessions continue"), { code: "EBUSY" });
    const before = db.prepare("PRAGMA data_version").get().data_version;
    if (existed) {
      const protectedDir = join2(dirname(file), ".migration-snapshots");
      mkdirSync2(protectedDir, { recursive: true, mode: 448 });
      const legacyBackup = backupPath(file);
      const pending = migrations.filter((migration) => migration.version > version);
      const scoped = pending.length > 0 && pending.every((migration) => migration.backupTables !== void 0);
      if (scoped) {
        backup = join2(protectedDir, `${basename(file)}.metadata-v${version}-to-v${target}-${randomUUID2()}.db`);
        metadataSnapshot(db, backup, [...new Set(pending.flatMap((migration) => [...migration.backupTables]))], version, target);
      } else {
        backup = join2(protectedDir, `${basename(legacyBackup)}-v${version}-to-v${target}`);
        db.prepare("VACUUM INTO ?").run(backup);
        const snapshot = new DatabaseSync(backup, { readOnly: true });
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
      log.info("backed up store before migration", { file, backup, version, scope: scoped ? "metadata and schema only" : "whole database" });
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
      const original = new DatabaseSync(backup, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
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
        log.warn("failed migration restored its backup", { file, backup });
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

// src/core/sqlite-maintenance.ts
var ARCHIVE_DB_NAME = "archive.db";
var ARCHIVE_STORE_VERSION = 1;
function checkDatabase(db) {
  const integrity = db.prepare("PRAGMA integrity_check").all().map((r) => String(r.integrity_check));
  const foreign = db.prepare("PRAGMA foreign_key_check").all();
  return [...integrity.filter((s) => s !== "ok"), ...foreign.map((r) => `foreign key: ${JSON.stringify(r)}`)];
}
function snapshotDatabase(source, target) {
  const db = new DatabaseSync2(source, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
  const copy = new DatabaseSync2(target, { readOnly: true, timeout: SQLITE_BUSY_TIMEOUT_MS });
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
  const existed = existsSync2(path);
  const db = new DatabaseSync2(path);
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
  return file === ":memory:" ? ":memory:" : join3(dirname2(file), ARCHIVE_DB_NAME);
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

export {
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
  migrateSqlite
};
