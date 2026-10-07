import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  SQLITE_BUSY_TIMEOUT_MS,
  configureSqlite
} from "./chunk-AGX4O262.mjs";
import {
  nullLogger
} from "./chunk-FVHLG3WF.mjs";
import {
  assertStoreUpgrade,
  backupPath,
  retainBackups
} from "./chunk-TPCM6ZR4.mjs";

// src/core/sqlite-migrations.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { copyFileSync, mkdirSync } from "node:fs";
import { basename, dirname as dirname2, join as join2 } from "node:path";

// src/core/sqlite-maintenance.ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  const existed = existsSync(path);
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
  return file === ":memory:" ? ":memory:" : join(dirname(file), ARCHIVE_DB_NAME);
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
import { randomUUID } from "node:crypto";
import { closeSync, existsSync as existsSync2, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      if (existsSync2(path)) try {
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
        if (existsSync2(path)) {
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
  if (basename(file) === "bridge.db") assertStoreUpgrade(dirname2(file), "sqlite", version, target);
  let backup = null;
  for (let attempt = 0; ; attempt++) {
    if (attempt >= MAX_SNAPSHOT_ATTEMPTS) throw Object.assign(new Error("database kept changing before migration; waiting to retry while sessions continue"), { code: "EBUSY" });
    const before = db.prepare("PRAGMA data_version").get().data_version;
    if (existed) {
      const protectedDir = join2(dirname2(file), ".migration-snapshots");
      mkdirSync(protectedDir, { recursive: true, mode: 448 });
      const legacyBackup = backupPath(file);
      backup = join2(protectedDir, `${basename(legacyBackup)}-v${version}-to-v${target}`);
      db.prepare("VACUUM INTO ?").run(backup);
      const snapshot = new DatabaseSync2(backup, { readOnly: true });
      try {
        if (snapshot.prepare("PRAGMA integrity_check").all().some((row) => row.integrity_check !== "ok")) throw new Error(`invalid pre-migration snapshot: ${backup}`);
      } finally {
        snapshot.close();
      }
      copyFileSync(backup, legacyBackup);
      retainBackups(file);
      log.info("backed up store before migration", { file, backup, version });
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

export {
  migrateSqlite,
  ARCHIVE_DB_NAME,
  ARCHIVE_STORE_VERSION,
  checkDatabase,
  snapshotDatabase,
  openArchive,
  archiveDbPath,
  archiveMessages
};
