import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  MAX_NATIVE_SUBAGENTS,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  TRANSCRIPT_ID,
  canonicalProjectRoot,
  fileStat,
  object,
  preview,
  projectKey,
  readJsonl,
  safeFile,
  scanJsonl,
  time
} from "./chunk-OVBYB4CB.mjs";
import {
  isPluginCacheCwd
} from "./chunk-I7XFUMWM.mjs";
import {
  configureSqlite,
  isSqliteBusy,
  migrateSqlite,
  migrationLock,
  nullLogger
} from "./chunk-UT6DV2NX.mjs";
import {
  assertUnlinked
} from "./chunk-CJPLA2VJ.mjs";
import {
  DEFAULT_HOME
} from "./chunk-PEBTAWO6.mjs";

// src/core/history-schema.ts
import { DatabaseSync } from "node:sqlite";
function supportsHistoryFts() {
  const probe = new DatabaseSync(":memory:");
  try {
    probe.exec("CREATE VIRTUAL TABLE probe USING fts5(body)");
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}
function historySchema(fts = supportsHistoryFts()) {
  return `
CREATE TABLE history_documents (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, agent TEXT NOT NULL, at INTEGER NOT NULL,
  body TEXT NOT NULL, folded TEXT NOT NULL, link TEXT NOT NULL,
  message TEXT, job TEXT, run TEXT, session TEXT, cursor TEXT
);
CREATE INDEX idx_history_time ON history_documents(at);
CREATE INDEX idx_history_session ON history_documents(session);
CREATE INDEX idx_history_job ON history_documents(job);
CREATE TABLE history_cursors (source TEXT PRIMARY KEY, cursor TEXT NOT NULL);
CREATE TABLE history_files (path TEXT PRIMARY KEY, kind TEXT NOT NULL, agent TEXT NOT NULL, session TEXT, cwd TEXT NOT NULL, child TEXT, checked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE history_tags (id TEXT NOT NULL, type TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,type,value));
CREATE INDEX idx_history_tags ON history_tags(type,value,id);
CREATE TABLE history_sessions (alias TEXT PRIMARY KEY, session TEXT NOT NULL, job TEXT);
CREATE INDEX idx_history_sessions ON history_sessions(session,job);
CREATE TABLE history_pending (id TEXT NOT NULL, body TEXT NOT NULL, from_agent TEXT NOT NULL, from_name TEXT NOT NULL, from_id TEXT NOT NULL, recipient TEXT NOT NULL, to_target TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(id,recipient));
CREATE TRIGGER history_message_insert AFTER INSERT ON messages BEGIN
  INSERT OR REPLACE INTO history_pending VALUES (new.id, new.body, new.from_agent, new.from_name, new.from_id, new.recipient, new.to_target, new.created_at);
END;
CREATE TRIGGER history_message_claim AFTER UPDATE OF recipient ON messages BEGIN
  INSERT OR REPLACE INTO history_pending VALUES (new.id, new.body, new.from_agent, new.from_name, new.from_id, new.recipient, new.to_target, new.created_at);
END;
${fts ? `CREATE VIRTUAL TABLE history_fts USING fts5(body, content='history_documents', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER history_insert AFTER INSERT ON history_documents BEGIN
  INSERT INTO history_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER history_delete AFTER DELETE ON history_documents BEGIN
  INSERT INTO history_fts(history_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER history_update AFTER UPDATE ON history_documents BEGIN
  INSERT INTO history_fts(history_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO history_fts(rowid, body) VALUES (new.rowid, new.body);
END;` : ""}
PRAGMA user_version = 4;
`;
}

// src/core/conversation-schema.ts
var CONVERSATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY, agent TEXT NOT NULL, session TEXT NOT NULL, parent TEXT,
 project TEXT NOT NULL DEFAULT '', job TEXT, kind TEXT NOT NULL DEFAULT 'transcript'
);
CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations(project);
CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent);
CREATE TABLE IF NOT EXISTS conversation_sources (
 id TEXT PRIMARY KEY, path TEXT NOT NULL, conversation TEXT NOT NULL, format TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 0, offset INTEGER NOT NULL DEFAULT 0,
 identity TEXT NOT NULL DEFAULT '', anchor TEXT NOT NULL DEFAULT '', checked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS conversation_records (
 id INTEGER PRIMARY KEY, source TEXT NOT NULL, generation INTEGER NOT NULL,
 offset INTEGER NOT NULL, conversation TEXT NOT NULL, at INTEGER NOT NULL,
 raw BLOB NOT NULL, body TEXT NOT NULL, part TEXT,
 UNIQUE(source,generation,offset)
);
CREATE INDEX IF NOT EXISTS idx_conversation_records ON conversation_records(conversation,id);
CREATE INDEX IF NOT EXISTS idx_conversation_parts ON conversation_records(part);
CREATE TRIGGER IF NOT EXISTS conversation_records_no_delete BEFORE DELETE ON conversation_records BEGIN
 SELECT RAISE(ABORT,'conversation records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS conversation_records_no_update BEFORE UPDATE ON conversation_records BEGIN
 SELECT RAISE(ABORT,'conversation records are append-only'); END;
CREATE TABLE IF NOT EXISTS conversation_parts (
 source TEXT NOT NULL, part TEXT NOT NULL, revision TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(source,part)
);
CREATE TABLE IF NOT EXISTS conversation_projects (project TEXT PRIMARY KEY, checked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS conversation_memberships (
 project TEXT NOT NULL, conversation TEXT NOT NULL, PRIMARY KEY(project,conversation)
);
CREATE TABLE IF NOT EXISTS conversation_bindings (
 session TEXT NOT NULL, agent TEXT NOT NULL, cwd TEXT NOT NULL, job TEXT,
 pending INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(session,agent)
);
CREATE TABLE IF NOT EXISTS conversation_envelopes (
 id INTEGER PRIMARY KEY, message TEXT NOT NULL, recipient TEXT NOT NULL,
 UNIQUE(message,recipient)
);
INSERT OR IGNORE INTO conversation_envelopes(message,recipient) SELECT id,recipient FROM messages;
CREATE TRIGGER IF NOT EXISTS conversation_envelope_insert AFTER INSERT ON messages BEGIN
 INSERT OR IGNORE INTO conversation_envelopes(message,recipient) VALUES(new.id,new.recipient); END;
CREATE TRIGGER IF NOT EXISTS conversation_envelope_claim AFTER UPDATE OF recipient ON messages BEGIN
 INSERT OR IGNORE INTO conversation_envelopes(message,recipient) VALUES(new.id,new.recipient); END;
`;
var CONVERSATION_MIGRATION = `${CONVERSATION_SCHEMA}
INSERT OR IGNORE INTO conversation_bindings(session,agent,cwd)
 SELECT session_id,json_extract(identity,'$[0]'),json_extract(identity,'$[3]')
 FROM session_bindings WHERE json_valid(identity) AND json_type(identity,'$[0]')='text'
 AND json_type(identity,'$[3]')='text';
PRAGMA user_version=8;`;

// src/core/history-migration.ts
import { createHash, randomUUID } from "node:crypto";
import { existsSync as existsSync2, mkdirSync } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

// src/core/history-store.ts
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
var HISTORY_DB_NAME = "history.db";
var HISTORY_STORE_VERSION = 1;
var HISTORY_COPY_ROWS = 32;
var HISTORY_BATCH_MS = 50;
var HISTORY_COPY_BYTES = 512 * 1024;
var HISTORY_IO_BYTES_PER_SECOND = 8 * 1024 * 1024;
var HISTORY_TABLES = ["history_documents", "history_cursors", "history_files", "history_tags", "history_sessions", "history_pending", "conversations", "conversation_sources", "conversation_records", "conversation_parts", "conversation_projects", "conversation_memberships", "conversation_bindings", "conversation_envelopes"];
var quote = (s) => `"${s.replaceAll('"', '""')}"`;
function historyDbPath(bridge) {
  return bridge === ":memory:" ? bridge : join(dirname(bridge), HISTORY_DB_NAME);
}
function historyReady(db) {
  if (Number(db.prepare("PRAGMA user_version").get().user_version) !== HISTORY_STORE_VERSION) return false;
  return !!db.prepare("SELECT name FROM sqlite_master WHERE name='history_migration'").get() && db.prepare("SELECT status FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION)?.status === "verified";
}
function historyReadPath(file) {
  if (basename(file) !== "bridge.db") return file;
  const path = historyDbPath(file);
  if (!existsSync(path)) return file;
  const db = new DatabaseSync2(path, { readOnly: true, timeout: 100 });
  try {
    return historyReady(db) ? path : file;
  } finally {
    db.close();
  }
}
function openHistoryStore(file) {
  const db = new DatabaseSync2(file, { timeout: 3e3 });
  try {
    db.exec("PRAGMA busy_timeout=3000");
    const version = Number(db.prepare("PRAGMA user_version").get().user_version);
    if (version > HISTORY_STORE_VERSION) throw new Error(`unsupported history store version: ${version}`);
    configureSqlite(db);
    if (version === HISTORY_STORE_VERSION) return db;
    const release = migrationLock(file);
    try {
      if (Number(db.prepare("PRAGMA user_version").get().user_version) === HISTORY_STORE_VERSION) return db;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(historySchema().replace(/CREATE TRIGGER history_message_(?:insert|claim)[\s\S]*?END;/g, "").replace(/PRAGMA user_version = 4;/, ""));
        db.exec(CONVERSATION_SCHEMA.slice(0, CONVERSATION_SCHEMA.indexOf("INSERT OR IGNORE INTO conversation_envelopes")));
        db.exec(`CREATE TABLE history_migration(version INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, status TEXT NOT NULL, manifest TEXT);
          CREATE TABLE history_legacy_tail(source_id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL);
          PRAGMA user_version=${HISTORY_STORE_VERSION}; COMMIT`);
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    } finally {
      release();
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
async function migrateHistoryStore(bridge, target, shouldPause = () => false, stopped = () => false, onLease, retryFailed = false, options = {}) {
  if (historyReady(target)) {
    options.onProgress?.({ phase: "verified", percent: 100, etaSeconds: 0, paused: false, completedRows: 0, totalRows: 0, snapshot: null, ioBytesPerSecond: options.ioBytesPerSecond ?? HISTORY_IO_BYTES_PER_SECOND, error: null });
    return;
  }
  const release = migrationLock(historyDbPath(bridge));
  try {
    onLease?.(readFileSync(`${historyDbPath(bridge)}.migration-lock`, "utf8"));
    if (historyReady(target)) return;
    const state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
    if (state?.status === "failed") {
      if (!retryFailed) throw Object.assign(new Error("History migration verification failed previously; all originals and snapshots preserved; use agent-bridge reindex for an explicit retry"), { code: "HISTORY_VERIFICATION_FAILED" });
      const failure2 = JSON.parse(String(state.manifest));
      target.prepare("UPDATE history_migration SET status=?,manifest=? WHERE version=?").run(failure2.resumeStatus, failure2.snapshotManifest, HISTORY_STORE_VERSION);
    }
    await resumableHistoryMigration(bridge, target, shouldPause, stopped, options);
  } catch (err) {
    const state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
    const code = err.code;
    if (state && state.status !== "failed" && !isSqliteBusy(err) && code !== "HISTORY_MIGRATION_STOPPED" && code !== "HISTORY_SNAPSHOT_PAUSED") {
      target.prepare("UPDATE history_migration SET status='failed',manifest=? WHERE version=?").run(JSON.stringify({ error: String(err), resumeStatus: state.status, snapshotManifest: state.manifest }), HISTORY_STORE_VERSION);
    }
    throw err;
  } finally {
    release();
    onLease?.(null);
  }
}
function historyMigrationFailure(db) {
  const state = db.prepare("SELECT status,manifest FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
  if (state?.status !== "failed") return null;
  try {
    return String(JSON.parse(String(state.manifest)).error);
  } catch {
    return "History migration failed; protected backup preserved; explicit retry required";
  }
}
function releaseExitedHistoryLease(bridge, owner) {
  const path = `${historyDbPath(bridge)}.migration-lock`;
  if (JSON.parse(owner).pid !== process.pid) return;
  if (existsSync(path) && readFileSync(path, "utf8") === owner) rmSync(path);
}
function copyLegacyConversationTail(source, target) {
  if (!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_records'").get()) return 0;
  const after = Number(target.prepare("SELECT cursor FROM history_cursors WHERE source='legacy-record-tail'").get()?.cursor ?? 0);
  const deadline = Date.now() + HISTORY_BATCH_MS;
  let work = 0;
  for (const row of source.prepare("SELECT * FROM conversation_records WHERE id>? ORDER BY id LIMIT ?").iterate(after, HISTORY_COPY_ROWS)) {
    const conversation = source.prepare("SELECT * FROM conversations WHERE id=?").get(row.conversation);
    if (!conversation) throw new Error("Legacy record has no conversation; original retained");
    target.exec("BEGIN IMMEDIATE");
    try {
      const columns2 = Object.keys(conversation);
      target.prepare(`INSERT OR IGNORE INTO conversations(${columns2.map(quote).join(",")}) VALUES(${columns2.map(() => "?").join(",")})`).run(...Object.values(conversation));
      let copied = target.prepare("SELECT * FROM conversation_records WHERE source=? AND generation=? AND offset=?").get(row.source, row.generation, row.offset);
      if (!copied) {
        target.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body,part) VALUES(?,?,?,?,?,?,?,?)").run(row.source, row.generation, row.offset, row.conversation, row.at, row.raw, row.body, row.part);
        copied = target.prepare("SELECT * FROM conversation_records WHERE source=? AND generation=? AND offset=?").get(row.source, row.generation, row.offset);
      }
      if (copied.conversation !== row.conversation || !Buffer.from(copied.raw).equals(Buffer.from(row.raw))) throw new Error("Legacy transcript conflict; both originals retained, tail deferred");
      target.prepare("INSERT OR IGNORE INTO history_legacy_tail VALUES(?,?)").run(row.id, copied.id);
      target.prepare("INSERT INTO history_cursors VALUES('legacy-record-tail',?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(String(row.id));
      target.exec("COMMIT");
    } catch (err) {
      target.exec("ROLLBACK");
      throw err;
    }
    work++;
    if (Date.now() >= deadline) break;
  }
  return work;
}

// src/core/history-migration.ts
var q = (s) => `"${s.replaceAll('"', '""')}"`;
var failure = (table) => Object.assign(new Error(`History migration verification failed: ${table}; all originals and snapshots preserved; explicit retry required`), { code: "HISTORY_VERIFICATION_FAILED" });
function digest(rows) {
  const hash = createHash("sha256");
  for (const row of rows) for (const [key, value] of Object.entries(row)) {
    const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
    hash.update(`${key.length}:${key}:${value === null ? "null" : value instanceof Uint8Array ? "blob" : typeof value}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}
function reader(file) {
  const db = new DatabaseSync3(file, { readOnly: true, timeout: 100 });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100; PRAGMA cache_size=-2048; PRAGMA mmap_size=0");
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${q(table)})`).all().map((r) => String(r.name));
}
function inputChunk(db, table, after, upper) {
  if (upper === null) return [];
  const query = db.prepare(`SELECT rowid AS __copy_rowid,* FROM ${q(table)} WHERE ${after === null ? "" : "rowid>? AND "}rowid<=? ORDER BY rowid LIMIT ?`);
  const args = after === null ? [upper, HISTORY_COPY_ROWS] : [after, upper, HISTORY_COPY_ROWS];
  const rows = [];
  let bytes = 0;
  const start = Date.now();
  for (const value of query.iterate(...args)) {
    const row = value;
    rows.push(row);
    bytes += rowBytes(row);
    if (bytes >= HISTORY_COPY_BYTES || Date.now() - start >= HISTORY_BATCH_MS) break;
  }
  return rows;
}
function rowBytes(row) {
  return Object.values(row).reduce((n, v) => n + (v instanceof Uint8Array ? v.byteLength : typeof v === "string" ? Buffer.byteLength(v) : 8), 0);
}
function rangeRows(db, table, chunk) {
  const query = db.prepare(`SELECT rowid AS __copy_rowid,* FROM ${q(table)} WHERE ${chunk.first_after === null ? "" : "rowid>? AND "}rowid<=? ORDER BY rowid LIMIT ?`);
  return query.all(...chunk.first_after === null ? [chunk.after_rowid, chunk.row_count + 1] : [chunk.first_after, chunk.after_rowid, chunk.row_count + 1]);
}
function checkChunk(db, table, chunk) {
  const rows = rangeRows(db, table, chunk);
  if (rows.length !== chunk.row_count || digest(rows) !== chunk.sha256) throw failure(table);
}
function insertRows(db, table, rows, names) {
  const insert = db.prepare(`INSERT OR IGNORE INTO ${q(table)}(${["rowid", ...names].map(q).join(",")}) VALUES(${["rowid", ...names].map(() => "?").join(",")})`);
  for (const row of rows) insert.run(row.__copy_rowid, ...names.map((name) => row[name]));
}
var SCHEMA = `CREATE TABLE table_state (
 table_name TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,upper_rowid INTEGER,source_sql TEXT NOT NULL,estimate INTEGER NOT NULL,
 snapshot_after INTEGER,snapshot_done INTEGER NOT NULL DEFAULT 0,snapshot_rows INTEGER NOT NULL DEFAULT 0,snapshot_bytes INTEGER NOT NULL DEFAULT 0,
 snapshot_verify_after INTEGER,snapshot_verify_done INTEGER NOT NULL DEFAULT 0,snapshot_verify_rows INTEGER NOT NULL DEFAULT 0,
 copy_after INTEGER,copy_done INTEGER NOT NULL DEFAULT 0,copy_rows INTEGER NOT NULL DEFAULT 0,
 verify_after INTEGER,verify_done INTEGER NOT NULL DEFAULT 0,verify_rows INTEGER NOT NULL DEFAULT 0);
CREATE TABLE chunks(table_name TEXT NOT NULL,generation INTEGER NOT NULL,first_after INTEGER,after_rowid INTEGER NOT NULL,row_count INTEGER NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(table_name,generation,after_rowid));
CREATE TABLE artifacts(table_name TEXT NOT NULL,generation INTEGER NOT NULL,archived_table TEXT NOT NULL,PRIMARY KEY(table_name,generation));
PRAGMA user_version=1;`;
function readHistoryMigrationProgress(target, ioBytesPerSecond = HISTORY_IO_BYTES_PER_SECOND) {
  const state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
  const result = { phase: "starting", percent: 0, etaSeconds: null, paused: false, completedRows: 0, totalRows: 0, snapshot: state?.snapshot ?? null, ioBytesPerSecond, error: null };
  if (!state) return result;
  if (state.status === "verified") return { ...result, phase: "verified", percent: 100, etaSeconds: 0 };
  if (state.status === "failed") {
    let error = "History migration failed; explicit retry required";
    try {
      error = String(JSON.parse(state.manifest).error);
    } catch {
    }
    return { ...result, phase: "failed", error };
  }
  result.phase = state.status === "snapshotting" ? "snapshot" : "copy";
  const file = `${state.snapshot}.progress.db`;
  if (!existsSync2(file)) return result;
  const meta = reader(file);
  try {
    if (Number(meta.prepare("PRAGMA user_version").get().user_version) !== 1) return result;
    const totals = meta.prepare("SELECT coalesce(sum(snapshot_rows+snapshot_verify_rows+copy_rows+verify_rows),0) done,coalesce(sum(estimate),0)*4 total,coalesce(sum(snapshot_done=0 OR snapshot_verify_done=0),0) snapshot,coalesce(sum(copy_done=0),0) copy FROM table_state").get();
    result.completedRows = Number(totals.done);
    result.totalRows = Math.max(result.completedRows, Number(totals.total));
    result.percent = result.totalRows ? Math.min(99.99, 100 * result.completedRows / result.totalRows) : 0;
    result.phase = Number(totals.snapshot) ? "snapshot" : Number(totals.copy) ? "copy" : "verify";
    return result;
  } finally {
    meta.close();
  }
}
async function resumableHistoryMigration(bridge, target, paused, stopped, options = {}) {
  const limit = options.ioBytesPerSecond ?? HISTORY_IO_BYTES_PER_SECOND;
  if (!Number.isFinite(limit) || limit < 64 * 1024 || limit > 256 * 1024 * 1024) throw new Error("History migration I/O limit must be between 64 KiB/s and 256 MiB/s");
  let state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
  let phase = state?.status === "copying" ? "copy" : "snapshot";
  let pinned = false, nextAt = 0, pressureSince = 0;
  let meta, source, backup;
  let progress = { phase, percent: 0, etaSeconds: null, paused: false, completedRows: 0, totalRows: 0, snapshot: state?.snapshot ?? null, ioBytesPerSecond: limit, error: null };
  const start = Date.now();
  let startRows = 0;
  const emit = (changes = {}) => {
    if (meta) {
      const totals = meta.prepare("SELECT coalesce(sum(snapshot_rows+snapshot_verify_rows+copy_rows+verify_rows),0) done,coalesce(sum(estimate),0)*4 total FROM table_state").get();
      progress.completedRows = Number(totals.done);
      progress.totalRows = Math.max(progress.completedRows, Number(totals.total));
      progress.percent = progress.totalRows ? Math.min(99.99, 100 * progress.completedRows / progress.totalRows) : 0;
      const work = progress.completedRows - startRows;
      progress.etaSeconds = work > 0 ? Math.ceil((Date.now() - start) / 1e3 / work * (progress.totalRows - progress.completedRows)) : null;
    }
    progress = { ...progress, phase, ...changes };
    options.onProgress?.({ ...progress });
  };
  const gap = async () => {
    await delay(10);
    for (; ; ) {
      if (stopped()) throw Object.assign(new Error("History migration stopped; snapshot and durable chunk cursors preserved"), { code: "HISTORY_MIGRATION_STOPPED" });
      if (paused()) {
        if (!pressureSince) {
          pressureSince = Date.now();
          emit({ paused: true });
        }
        if (pinned && Date.now() - pressureSince >= 2e3) throw Object.assign(new Error("History snapshot paused; durable chunks preserved"), { code: "HISTORY_SNAPSHOT_PAUSED" });
        await delay(100);
        continue;
      }
      if (pressureSince) {
        pressureSince = 0;
        emit({ paused: false });
      }
      const remaining = nextAt - Date.now();
      if (remaining <= 0) return;
      await delay(Math.min(100, remaining));
    }
  };
  const pace = (bytes, since) => {
    nextAt = since + Math.ceil(bytes * 1e3 / limit);
  };
  const tables = () => meta.prepare("SELECT * FROM table_state ORDER BY rowid").all();
  const current = (name) => meta.prepare("SELECT * FROM table_state WHERE table_name=?").get(name);
  const nextChunk = (table, after) => meta.prepare(`SELECT * FROM chunks WHERE table_name=? AND generation=? ${after === null ? "" : "AND after_rowid>?"} ORDER BY after_rowid LIMIT 1`).get(...after === null ? [table.table_name, table.generation] : [table.table_name, table.generation, after]);
  try {
    await gap();
    if (!state) {
      const folder = join2(dirname2(bridge), ".migration-snapshots");
      mkdirSync(folder, { recursive: true, mode: 448 });
      const snapshot = join2(folder, `bridge-history-v1-${randomUUID()}.db`);
      state = { snapshot, status: "snapshotting", manifest: null };
      target.prepare("INSERT INTO history_migration VALUES(?,?,'snapshotting',NULL)").run(HISTORY_STORE_VERSION, snapshot);
    }
    progress.snapshot = state.snapshot;
    const progressFile = `${state.snapshot}.progress.db`;
    meta = new DatabaseSync3(progressFile, { timeout: 100 });
    meta.exec("PRAGMA busy_timeout=100; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048");
    const version = Number(meta.prepare("PRAGMA user_version").get().user_version);
    if (version > 1) throw new Error(`unsupported history migration checkpoint version: ${version}`);
    if (!version) {
      meta.exec("BEGIN IMMEDIATE");
      try {
        meta.exec(SCHEMA);
        meta.exec("COMMIT");
      } catch (err) {
        meta.exec("ROLLBACK");
        throw err;
      }
    }
    const legacySnapshot = state.status === "copying" && (!meta.prepare("SELECT 1 FROM table_state LIMIT 1").get() || !!meta.prepare("SELECT 1 FROM table_state WHERE snapshot_done=0 OR snapshot_verify_done=0 LIMIT 1").get());
    if (state.status === "snapshotting" || legacySnapshot) {
      phase = "snapshot";
      emit();
      await gap();
      source = reader(legacySnapshot ? state.snapshot : bridge);
      source.exec("BEGIN");
      pinned = !legacySnapshot;
      const schemas = source.prepare("SELECT name,sql FROM sqlite_master WHERE type='table'").all();
      for (const name of HISTORY_TABLES) {
        const schema = schemas.find((row) => row.name === name);
        if (!schema) continue;
        const max = source.prepare(`SELECT max(rowid) n FROM ${q(name)}`).get().n;
        meta.prepare("INSERT OR IGNORE INTO table_state(table_name,upper_rowid,source_sql,estimate) VALUES(?,?,?,?)").run(name, max, schema.sql, Math.max(0, max ?? 0));
      }
      backup = legacySnapshot ? void 0 : new DatabaseSync3(state.snapshot, { timeout: 100 });
      if (backup) {
        backup.exec("PRAGMA busy_timeout=100; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA mmap_size=0");
        backup.prepare("ATTACH DATABASE ? AS progress").run(progressFile);
      }
      startRows = tables().reduce((n, table) => n + table.snapshot_rows + table.snapshot_verify_rows + table.copy_rows + table.verify_rows, 0);
      for (let table of tables()) {
        await gap();
        const guards = table.table_name === "conversation_records" && source.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name IN ('conversation_records_no_delete','conversation_records_no_update')").get().n === 2;
        let changed = false;
        if (!legacySnapshot && table.snapshot_after !== null && !guards) {
          let after = null;
          for (; ; ) {
            const chunk = nextChunk(table, after);
            if (!chunk) break;
            await gap();
            const since = Date.now();
            try {
              checkChunk(source, table.table_name, chunk);
            } catch (err) {
              if (err.code !== "HISTORY_VERIFICATION_FAILED") throw err;
              changed = true;
              break;
            }
            pace(chunk.bytes, since);
            after = chunk.after_rowid;
          }
        }
        const max = source.prepare(`SELECT max(rowid) n FROM ${q(table.table_name)}`).get().n;
        if (!legacySnapshot && !guards && ((table.upper_rowid ?? 0) > (max ?? 0) || table.source_sql !== String(schemas.find((row) => row.name === table.table_name)?.sql))) changed = true;
        if (changed) {
          const archived = `retained_${table.table_name}_${randomUUID().replaceAll("-", "")}`;
          backup.exec("BEGIN IMMEDIATE");
          try {
            backup.exec(`ALTER TABLE ${q(table.table_name)} RENAME TO ${q(archived)}`);
            const sql = String(schemas.find((row) => row.name === table.table_name).sql);
            backup.exec(sql);
            backup.prepare("INSERT INTO progress.artifacts VALUES(?,?,?)").run(table.table_name, table.generation, archived);
            backup.prepare("UPDATE progress.table_state SET generation=generation+1,upper_rowid=?,source_sql=?,estimate=?,snapshot_after=NULL,snapshot_done=0,snapshot_rows=0,snapshot_bytes=0,snapshot_verify_after=NULL,snapshot_verify_done=0,snapshot_verify_rows=0,copy_after=NULL,copy_done=0,copy_rows=0,verify_after=NULL,verify_done=0,verify_rows=0 WHERE table_name=?").run(max, sql, Math.max(0, max ?? 0), table.table_name);
            backup.exec("COMMIT");
          } catch (err) {
            backup.exec("ROLLBACK");
            throw err;
          }
          table = current(table.table_name);
        } else if (!legacySnapshot && !guards && table.upper_rowid !== max) {
          meta.prepare("UPDATE table_state SET upper_rowid=?,estimate=?,snapshot_done=0,snapshot_verify_done=0 WHERE table_name=?").run(max, Math.max(table.snapshot_rows, max ?? 0), table.table_name);
          table = current(table.table_name);
        }
        if (backup && !backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table.table_name)) backup.exec(table.source_sql);
        const names = columns(source, table.table_name);
        while (!table.snapshot_done) {
          await gap();
          const since = Date.now(), rows = inputChunk(source, table.table_name, table.snapshot_after, table.upper_rowid);
          if (!rows.length) {
            meta.prepare("UPDATE table_state SET snapshot_done=1,estimate=snapshot_rows WHERE table_name=?").run(table.table_name);
            break;
          }
          const chunk = { first_after: table.snapshot_after, after_rowid: Number(rows.at(-1).__copy_rowid), row_count: rows.length, sha256: digest(rows), bytes: rows.reduce((n, row) => n + rowBytes(row), 0) };
          const writer = backup ?? meta, prefix = backup ? "progress." : "";
          writer.exec("BEGIN IMMEDIATE");
          try {
            if (backup) {
              insertRows(backup, table.table_name, rows, names);
              checkChunk(backup, table.table_name, chunk);
            }
            writer.prepare(`INSERT OR IGNORE INTO ${prefix}chunks VALUES(?,?,?,?,?,?,?)`).run(table.table_name, table.generation, chunk.first_after, chunk.after_rowid, chunk.row_count, chunk.sha256, chunk.bytes);
            writer.prepare(`UPDATE ${prefix}table_state SET snapshot_after=?,snapshot_rows=snapshot_rows+?,snapshot_bytes=snapshot_bytes+? WHERE table_name=?`).run(chunk.after_rowid, chunk.row_count, chunk.bytes, table.table_name);
            writer.exec("COMMIT");
          } catch (err) {
            writer.exec("ROLLBACK");
            throw err;
          }
          pace(chunk.bytes * 3, since);
          table = current(table.table_name);
          emit();
        }
      }
      source.exec("ROLLBACK");
      source.close();
      source = void 0;
      pinned = false;
      backup?.close();
      backup = void 0;
      source = reader(state.snapshot);
      for (let table of tables()) while (!table.snapshot_verify_done) {
        await gap();
        const chunk = nextChunk(table, table.snapshot_verify_after);
        if (!chunk) {
          meta.prepare("UPDATE table_state SET snapshot_verify_done=1 WHERE table_name=?").run(table.table_name);
          break;
        }
        const since = Date.now();
        checkChunk(source, table.table_name, chunk);
        pace(chunk.bytes, since);
        meta.prepare("UPDATE table_state SET snapshot_verify_after=?,snapshot_verify_rows=snapshot_verify_rows+? WHERE table_name=?").run(chunk.after_rowid, chunk.row_count, table.table_name);
        table = current(table.table_name);
        emit();
      }
      source.close();
      source = void 0;
      target.prepare("UPDATE history_migration SET status='copying' WHERE version=?").run(HISTORY_STORE_VERSION);
      state.status = "copying";
    }
    source = reader(state.snapshot);
    const manifest = {};
    phase = "copy";
    emit();
    for (let table of tables()) {
      const names = columns(source, table.table_name);
      while (!table.copy_done) {
        await gap();
        const chunk = nextChunk(table, table.copy_after);
        if (!chunk) {
          meta.prepare("UPDATE table_state SET copy_done=1 WHERE table_name=?").run(table.table_name);
          break;
        }
        const since = Date.now(), rows = rangeRows(source, table.table_name, chunk);
        if (rows.length !== chunk.row_count || digest(rows) !== chunk.sha256) throw failure(`snapshot ${table.table_name}`);
        target.exec("BEGIN IMMEDIATE");
        try {
          insertRows(target, table.table_name, rows, names);
          checkChunk(target, table.table_name, chunk);
          target.exec("COMMIT");
        } catch (err) {
          target.exec("ROLLBACK");
          throw err;
        }
        meta.prepare("UPDATE table_state SET copy_after=?,copy_rows=copy_rows+? WHERE table_name=?").run(chunk.after_rowid, chunk.row_count, table.table_name);
        pace(chunk.bytes * 3, since);
        table = current(table.table_name);
        emit();
      }
    }
    phase = "verify";
    emit();
    for (let table of tables()) {
      while (!table.verify_done) {
        await gap();
        const chunk = nextChunk(table, table.verify_after);
        if (!chunk) {
          const extra = table.snapshot_after === null ? target.prepare(`SELECT rowid FROM ${q(table.table_name)} LIMIT 1`).get() : target.prepare(`SELECT rowid FROM ${q(table.table_name)} WHERE rowid>? LIMIT 1`).get(table.snapshot_after);
          if (extra) throw failure(`extra rows in ${table.table_name}`);
          meta.prepare("UPDATE table_state SET verify_done=1 WHERE table_name=?").run(table.table_name);
          break;
        }
        const since = Date.now();
        checkChunk(target, table.table_name, chunk);
        pace(chunk.bytes, since);
        meta.prepare("UPDATE table_state SET verify_after=?,verify_rows=verify_rows+? WHERE table_name=?").run(chunk.after_rowid, chunk.row_count, table.table_name);
        table = current(table.table_name);
        emit();
      }
      const hash = createHash("sha256");
      let manifestRows = 0;
      for (const chunk of meta.prepare("SELECT * FROM chunks WHERE table_name=? AND generation=? ORDER BY after_rowid").iterate(table.table_name, table.generation)) {
        hash.update(`${chunk.after_rowid}:${chunk.row_count}:${chunk.sha256};`);
        if (++manifestRows % 128 === 0) await gap();
      }
      manifest[table.table_name] = { rows: table.snapshot_rows, sha256: hash.digest("hex") };
    }
    await gap();
    target.exec("BEGIN IMMEDIATE");
    try {
      const hasRecords = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_records'").get();
      const max = hasRecords ? Number(source.prepare("SELECT coalesce(max(id),0) n FROM conversation_records").get().n) : 0;
      target.prepare("INSERT INTO history_cursors VALUES('legacy-record-tail',?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(String(max));
      target.prepare("UPDATE history_migration SET status='verified',manifest=? WHERE version=?").run(JSON.stringify(manifest), HISTORY_STORE_VERSION);
      target.exec("COMMIT");
    } catch (err) {
      target.exec("ROLLBACK");
      throw err;
    }
    emit({ phase: "verified", percent: 100, etaSeconds: 0, paused: false });
  } catch (err) {
    const code = err.code;
    emit(code === "HISTORY_MIGRATION_STOPPED" || code === "HISTORY_SNAPSHOT_PAUSED" ? { paused: true } : { phase: "failed", error: String(err), etaSeconds: null });
    throw err;
  } finally {
    source?.close();
    backup?.close();
    meta?.close();
  }
}

// src/core/project-store.ts
import { createHash as createHash2 } from "node:crypto";
import {
  appendFileSync,
  existsSync as existsSync3,
  lstatSync,
  mkdirSync as mkdirSync2,
  readFileSync as readFileSync2,
  realpathSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname as dirname3, join as join3, resolve } from "node:path";
import { DatabaseSync as DatabaseSync4 } from "node:sqlite";
var roots = /* @__PURE__ */ new Map();
var excluded = /* @__PURE__ */ new Map();
function linkedParent(file) {
  try {
    assertUnlinked(dirname3(resolve(file)));
    return false;
  } catch {
    return true;
  }
}
function conversationProject(cwd) {
  if (!cwd || isPluginCacheCwd(cwd)) return "";
  try {
    if (isPluginCacheCwd(realpathSync.native(cwd))) return "";
  } catch {
  }
  const known = roots.get(cwd);
  if (known !== void 0) return known;
  const canonical = canonicalProjectRoot(cwd);
  const root = canonical ? projectKey(canonical) : existsSync3(cwd) ? "" : projectKey(resolve(cwd));
  if (roots.size >= 256) roots.delete(roots.keys().next().value);
  roots.set(cwd, root);
  return root;
}
function ensureProjectFolder(project) {
  if (!project || !existsSync3(project)) return null;
  const folder = join3(project, ".agent-bridge");
  if (existsSync3(folder) && (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()))
    return null;
  const fresh = !existsSync3(folder);
  mkdirSync2(folder, { recursive: true, mode: 448 });
  const gitMarker = existsSync3(join3(project, ".git"));
  if (!fresh && excluded.get(project) === gitMarker) return folder;
  try {
    const exclude = execFileSync(
      "git",
      [
        "-C",
        project,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "info/exclude"
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2e3
      }
    ).trim();
    if (linkedParent(exclude) || existsSync3(exclude) && lstatSync(exclude).isSymbolicLink())
      return null;
    const text = existsSync3(exclude) ? readFileSync2(exclude, "utf8") : "";
    if (!text.split(/\r?\n/).includes("/.agent-bridge/")) {
      mkdirSync2(dirname3(exclude), { recursive: true });
      appendFileSync(
        exclude,
        `${text && !text.endsWith("\n") ? "\n" : ""}/.agent-bridge/
`
      );
    }
  } catch {
    if (existsSync3(join3(project, ".git"))) return null;
  }
  excluded.set(project, gitMarker);
  return folder;
}
function projectDatabasePath(project, home) {
  const id = createHash2("sha256").update(project).digest("hex").slice(0, 16);
  return join3(home && !ownsProjectMirrors(home) ? join3(home, "project-mirrors") : join3(project, ".agent-bridge"), `conversations-${id}.db`);
}
function ownsProjectMirrors(home) {
  const physical = (path) => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  return projectKey(physical(home)) === projectKey(physical(DEFAULT_HOME));
}
function syncProjectMirror(main, project, home) {
  const path = projectDatabasePath(project, home);
  let folder;
  if (ownsProjectMirrors(home)) folder = ensureProjectFolder(project);
  else {
    assertUnlinked(home);
    assertUnlinked(dirname3(path));
    mkdirSync2(dirname3(path), { recursive: true, mode: 448 });
    folder = dirname3(path);
  }
  if (!folder) return 0;
  const archive = join3(folder, "archive");
  if (linkedParent(path) || existsSync3(archive) && lstatSync(archive).isSymbolicLink() || linkedParent(join3(archive, "backup")))
    return 0;
  for (const file of [path, `${path}-wal`, `${path}-shm`])
    if (existsSync3(file) && lstatSync(file).isSymbolicLink()) return 0;
  const existed = existsSync3(path), mirror = new DatabaseSync4(path, { timeout: 50 });
  try {
    migrateSqlite(
      mirror,
      path,
      existed,
      1,
      [
        {
          version: 1,
          sql: `CREATE TABLE messages (id TEXT, body TEXT, from_agent TEXT, from_name TEXT, from_id TEXT, recipient TEXT, to_target TEXT, created_at INTEGER); ${historySchema()} ${CONVERSATION_SCHEMA} CREATE TABLE mirror_cursor (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL); INSERT INTO mirror_cursor VALUES(1,0); PRAGMA user_version=1;`
        }
      ],
      nullLogger
    );
    mirror.exec("PRAGMA journal_mode=WAL;");
    const after = Number(
      mirror.prepare("SELECT value FROM mirror_cursor WHERE id=1").get().value
    );
    const primary = main.prepare(
      `SELECT r.id,r.conversation FROM conversation_records r JOIN conversations c ON c.id=r.conversation WHERE c.project=? AND r.id>? ORDER BY r.id LIMIT 32`
    ).all(project, after);
    const associated = main.prepare(
      "SELECT r.id,r.conversation FROM conversation_memberships m JOIN conversation_records r ON r.conversation=m.conversation WHERE m.project=? AND r.id>? ORDER BY r.id LIMIT 32"
    ).all(project, after);
    const candidates = [
      ...new Map(
        [...primary, ...associated].map((row) => [Number(row.id), row])
      ).values()
    ].sort((a, b) => Number(a.id) - Number(b.id)).slice(0, 32);
    let copied = 0, last = after;
    mirror.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of candidates) {
        const conversation = main.prepare("SELECT * FROM conversations WHERE id=?").get(candidate.conversation);
        const previous = mirror.prepare("SELECT * FROM conversations WHERE id=?").get(candidate.conversation);
        if (!previous || previous.parent !== conversation.parent || previous.session !== conversation.session || previous.agent !== conversation.agent || previous.kind !== conversation.kind || previous.project !== conversation.project || previous.job !== conversation.job) {
          mirror.prepare(
            `INSERT INTO conversations VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent=excluded.parent,project=excluded.project,job=excluded.job,session=excluded.session,agent=excluded.agent,kind=excluded.kind`
          ).run(
            conversation.id,
            conversation.agent,
            conversation.session,
            conversation.parent,
            conversation.project,
            conversation.job,
            conversation.kind
          );
        }
        const documentId = `durable:${candidate.id}`;
        mirror.prepare("INSERT OR IGNORE INTO history_tags VALUES(?,?,?)").run(documentId, "project", project);
        for (const tag of main.prepare(
          "SELECT type,value FROM history_tags WHERE id=? AND type IN ('session','job')"
        ).all(documentId))
          mirror.prepare("INSERT OR IGNORE INTO history_tags VALUES(?,?,?)").run(documentId, tag.type, tag.value);
        const docMeta = main.prepare("SELECT session FROM history_documents WHERE id=?").get(documentId);
        const alias = docMeta?.session ? main.prepare("SELECT * FROM history_sessions WHERE alias=?").get(docMeta.session) : null;
        if (alias)
          mirror.prepare(
            "INSERT INTO history_sessions VALUES(?,?,?) ON CONFLICT(alias) DO UPDATE SET session=excluded.session,job=excluded.job WHERE history_sessions.session IS NOT excluded.session OR history_sessions.job IS NOT excluded.job"
          ).run(alias.alias, alias.session, alias.job);
        if (mirror.prepare("SELECT id FROM conversation_records WHERE id=?").get(candidate.id)) {
          last = Number(candidate.id);
          continue;
        }
        if (copied >= 8) break;
        const row = main.prepare("SELECT * FROM conversation_records WHERE id=?").get(candidate.id);
        mirror.prepare(
          "INSERT OR IGNORE INTO conversation_records VALUES(?,?,?,?,?,?,?,?,?)"
        ).run(
          row.id,
          row.source,
          row.generation,
          row.offset,
          row.conversation,
          row.at,
          row.raw,
          row.body,
          row.part
        );
        const doc = main.prepare("SELECT * FROM history_documents WHERE id=?").get(`durable:${row.id}`);
        if (doc) {
          mirror.prepare(
            "INSERT OR IGNORE INTO history_documents(id,kind,agent,at,body,folded,link,message,job,run,session,cursor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)"
          ).run(
            doc.id,
            doc.kind,
            doc.agent,
            doc.at,
            doc.body,
            doc.folded,
            doc.link,
            doc.message,
            doc.job,
            doc.run,
            doc.session,
            doc.cursor
          );
        }
        copied++;
        last = Number(row.id);
      }
      mirror.prepare("UPDATE mirror_cursor SET value=? WHERE id=1").run(candidates.length ? last : 0);
      mirror.exec("COMMIT");
    } catch (err) {
      mirror.exec("ROLLBACK");
      throw err;
    }
    return copied;
  } finally {
    mirror.close();
  }
}

// src/core/transcripts/antigravity.ts
import { join as join4 } from "node:path";
function antigravitySessionFile(session, paths) {
  return paths.antigravity && session.sessionId && TRANSCRIPT_ID.test(session.sessionId) ? safeFile(paths.antigravity, join4(paths.antigravity, "brain", session.sessionId, ".system_generated", "logs", "transcript.jsonl")) : null;
}
function antigravityItems(row) {
  const at = time(row.created_at), items = [];
  const id = Number.isSafeInteger(row.step_index) ? String(row.step_index) : void 0;
  const toolResult = row.type === "GENERIC" && typeof row.content === "string" && /^Created At: [^\n]*\nCompleted At: /.test(row.content);
  if (toolResult) items.push({ kind: "tool", at, tool: "result", summary: preview(row.content), id });
  else if (typeof row.content === "string" && row.content && (["USER_INPUT", "PLANNER_RESPONSE", "AGENT_RESPONSE"].includes(row.type) || row.type === "GENERIC" && row.source === "MODEL")) items.push({ kind: row.type === "USER_INPUT" ? "user" : "assistant", at, text: preview(row.content, MAX_TEXT_CHARS), id });
  for (const call of (Array.isArray(row.tool_calls) ? row.tool_calls : []).map(object)) {
    items.push({ kind: "tool", at, tool: String(call.name ?? call.tool_name ?? "tool"), summary: preview(call.arguments ?? call.args ?? call.parameters), id: `${id ?? ""}:${items.length}` });
  }
  const subagents = object(row.subagent_info).subagents ?? row.subagents;
  for (const child of (Array.isArray(subagents) ? subagents : []).map(object)) {
    if (typeof child.conversation_id !== "string" || !TRANSCRIPT_ID.test(child.conversation_id)) continue;
    items.push({ kind: "subagent", at, subagent: { id: child.conversation_id, title: preview(child.role ?? child.type_name ?? "Native subagent", MAX_TITLE_CHARS), agent: "antigravity" } });
  }
  return items;
}
function listAntigravitySubagents(session, paths) {
  const file = antigravitySessionFile(session, paths);
  if (!file) return [];
  const children = /* @__PURE__ */ new Map();
  for (const { value } of scanJsonl(file)) for (const item of antigravityItems(value)) {
    const child = item.subagent;
    if (!child || children.size >= MAX_NATIVE_SUBAGENTS) continue;
    const nested = antigravitySessionFile({ ...session, sessionId: child.id }, paths), stat = nested ? fileStat(nested) : null;
    children.set(child.id, { id: child.id, title: child.title, status: "unknown", startedAt: item.at, updatedAt: stat?.mtimeMs ?? item.at });
  }
  return [...children.values()];
}
function readAntigravityChat(session, paths, from = "0", child) {
  if (child && (!TRANSCRIPT_ID.test(child) || !listAntigravitySubagents(session, paths).some((entry) => entry.id === child))) return null;
  const file = antigravitySessionFile(child ? { ...session, sessionId: child } : session, paths);
  if (!file) return null;
  const page = readJsonl(file, from);
  return { items: page.entries.flatMap(({ value }) => antigravityItems(value)), next: page.next };
}

export {
  historySchema,
  CONVERSATION_MIGRATION,
  readHistoryMigrationProgress,
  HISTORY_BATCH_MS,
  HISTORY_IO_BYTES_PER_SECOND,
  historyDbPath,
  historyReady,
  historyReadPath,
  openHistoryStore,
  migrateHistoryStore,
  historyMigrationFailure,
  releaseExitedHistoryLease,
  copyLegacyConversationTail,
  conversationProject,
  projectDatabasePath,
  ownsProjectMirrors,
  syncProjectMirror,
  antigravityItems,
  listAntigravitySubagents,
  readAntigravityChat
};
