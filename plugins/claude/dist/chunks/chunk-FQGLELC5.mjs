import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  configureSqlite,
  isSqliteBusy,
  liveStorePeers,
  migrationLock,
  refreshStorePeerIdentities
} from "./chunk-ATZFJWXN.mjs";

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

// src/core/conversation-text.ts
var CONVERSATION_BYTES = 64 * 1024;
function indexedConversationText(raw) {
  const text = raw.toString("utf8");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const lines = text.trim().split("\n");
    if (lines.length > 1 && lines.every((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    })) return lines.map((line) => indexedConversationText(Buffer.from(line))).join("\n");
    return text;
  }
  const found = [];
  const visit = (item, depth = 0) => {
    if (depth > 8 || found.join("\n").length >= CONVERSATION_BYTES) return;
    if (Array.isArray(item)) {
      for (const v of item.slice(0, 100)) visit(v, depth + 1);
    } else if (item && typeof item === "object") for (const [key, v] of Object.entries(item)) {
      if (["text", "body", "content", "summary", "prompt", "title", "topic", "description", "note", "reason", "detail", "question", "answer"].includes(key) && typeof v === "string") found.push(v);
      else if (["message", "payload", "content", "parts", "output", "data"].includes(key)) visit(v, depth + 1);
    }
  };
  visit(value);
  return found.join("\n").slice(0, CONVERSATION_BYTES);
}
function conversationBodyText(body, raw) {
  if (body === null || body === void 0) return raw.toString("utf8");
  return String(body) || indexedConversationText(raw);
}

// src/core/history-codec.ts
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import * as zlib from "node:zlib";
var CODEC_PLAIN = 0;
var CODEC_ZSTD = 1;
var CODEC_BROTLI = 2;
var MIN_COMPRESS_BYTES = 256;
var zstd = typeof zlib.zstdCompressSync === "function" ? zlib : null;
function compress(bytes) {
  if (bytes.length < MIN_COMPRESS_BYTES) return { value: bytes, codec: CODEC_PLAIN };
  const value = zstd ? zstd.zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: 6 } }) : brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } });
  return value.length < bytes.length ? { value, codec: zstd ? CODEC_ZSTD : CODEC_BROTLI } : { value: bytes, codec: CODEC_PLAIN };
}
function decompress(bytes, codec) {
  if (codec === CODEC_ZSTD) {
    if (!zstd) throw new Error("History value uses zstd, which this Node runtime cannot decode; data is retained");
    return zstd.zstdDecompressSync(bytes);
  }
  if (codec === CODEC_BROTLI) return brotliDecompressSync(bytes);
  throw new Error(`Unknown history codec ${codec}; data is retained`);
}
var asBuffer = (value) => value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(String(value ?? ""), "utf8");
var codecOf = (codec) => codec === void 0 || codec === null ? CODEC_PLAIN : Number(codec);
function encodeBytes(bytes) {
  return compress(bytes);
}
function decodeBytes(value, codec) {
  const c = codecOf(codec);
  return c === CODEC_PLAIN ? asBuffer(value) : decompress(asBuffer(value), c);
}
function encodeText(text) {
  const encoded = compress(Buffer.from(text, "utf8"));
  return encoded.codec === CODEC_PLAIN ? { value: text, codec: CODEC_PLAIN } : encoded;
}
function decodeText(value, codec) {
  const c = codecOf(codec);
  if (c === CODEC_PLAIN) return typeof value === "string" ? value : asBuffer(value).toString("utf8");
  return decompress(asBuffer(value), c).toString("utf8");
}
function registerHistoryFunctions(db) {
  db.function("ab_text", { deterministic: true }, (value, codec) => value === null ? null : decodeText(value, codec));
  db.function("ab_raw", { deterministic: true }, (value, codec) => value === null ? null : decodeBytes(value, codec));
  db.function("ab_json", { deterministic: true }, (value, codec) => value === null ? null : decodeText(value, codec));
  db.function("ab_body", { deterministic: true }, (body, raw, codec) => raw === null ? body : conversationBodyText(body, decodeBytes(raw, codec)));
}

// src/core/history-migration.ts
import { createHash, randomUUID } from "node:crypto";
import { existsSync as existsSync3, mkdirSync, renameSync, statSync, statfsSync } from "node:fs";
import { dirname as dirname3, join as join2 } from "node:path";
import { DatabaseSync as DatabaseSync4 } from "node:sqlite";
import { setTimeout as delay2 } from "node:timers/promises";

// src/core/history-schema-v2.ts
var CONVERSATION_RECORDS_VIEW = `CREATE VIEW v_conversation_records AS SELECT id, source, generation, offset, conversation, at, part,
 ab_text(raw, raw_codec) AS raw_text, ab_body(body, raw, raw_codec) AS body_text, length(raw) AS stored_bytes, raw_codec FROM conversation_records;`;
function historyStoreV2Schema(fts = supportsHistoryFts()) {
  return `
CREATE TABLE history_documents (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, agent TEXT NOT NULL, at INTEGER NOT NULL,
  body NOT NULL, body_codec INTEGER NOT NULL DEFAULT 0, folded TEXT, link TEXT NOT NULL,
  message TEXT, job TEXT, run TEXT, session TEXT, cursor TEXT
);
CREATE INDEX idx_history_time ON history_documents(at);
CREATE INDEX idx_history_session ON history_documents(session);
CREATE INDEX idx_history_job ON history_documents(job);
CREATE VIEW history_documents_text AS SELECT rowid AS doc_rowid, ab_text(body, body_codec) AS body FROM history_documents;
CREATE TABLE history_cursors (source TEXT PRIMARY KEY, cursor TEXT NOT NULL);
CREATE TABLE history_files (path TEXT PRIMARY KEY, kind TEXT NOT NULL, agent TEXT NOT NULL, session TEXT, cwd TEXT NOT NULL, child TEXT, checked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE history_tags (id TEXT NOT NULL, type TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,type,value));
CREATE INDEX idx_history_tags ON history_tags(type,value,id);
CREATE TABLE history_sessions (alias TEXT PRIMARY KEY, session TEXT NOT NULL, job TEXT);
CREATE INDEX idx_history_sessions ON history_sessions(session,job);
CREATE TABLE history_pending (id TEXT NOT NULL, body TEXT NOT NULL, from_agent TEXT NOT NULL, from_name TEXT NOT NULL, from_id TEXT NOT NULL, recipient TEXT NOT NULL, to_target TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(id,recipient));
${fts ? `CREATE VIRTUAL TABLE history_fts USING fts5(body, content='history_documents_text', content_rowid='doc_rowid', tokenize='unicode61');
CREATE TRIGGER history_insert AFTER INSERT ON history_documents BEGIN
  INSERT INTO history_fts(rowid, body) VALUES (new.rowid, ab_text(new.body, new.body_codec));
END;
CREATE TRIGGER history_delete AFTER DELETE ON history_documents BEGIN
  INSERT INTO history_fts(history_fts, rowid, body) VALUES ('delete', old.rowid, ab_text(old.body, old.body_codec));
END;
CREATE TRIGGER history_update AFTER UPDATE ON history_documents BEGIN
  INSERT INTO history_fts(history_fts, rowid, body) VALUES ('delete', old.rowid, ab_text(old.body, old.body_codec));
  INSERT INTO history_fts(rowid, body) VALUES (new.rowid, ab_text(new.body, new.body_codec));
END;` : ""}
CREATE TABLE conversations (
 id TEXT PRIMARY KEY, agent TEXT NOT NULL, session TEXT NOT NULL, parent TEXT,
 project TEXT NOT NULL DEFAULT '', job TEXT, kind TEXT NOT NULL DEFAULT 'transcript'
);
CREATE INDEX idx_conversations_project ON conversations(project);
CREATE INDEX idx_conversations_parent ON conversations(parent);
CREATE TABLE conversation_sources (
 id TEXT PRIMARY KEY, path TEXT NOT NULL, conversation TEXT NOT NULL, format TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 0, offset INTEGER NOT NULL DEFAULT 0,
 identity TEXT NOT NULL DEFAULT '', anchor TEXT NOT NULL DEFAULT '', checked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE conversation_records (
 id INTEGER PRIMARY KEY, source TEXT NOT NULL, generation INTEGER NOT NULL,
 offset INTEGER NOT NULL, conversation TEXT NOT NULL, at INTEGER NOT NULL,
 raw BLOB NOT NULL, raw_codec INTEGER NOT NULL DEFAULT 0, body TEXT, part TEXT,
 UNIQUE(source,generation,offset)
);
CREATE INDEX idx_conversation_records ON conversation_records(conversation,id);
CREATE INDEX idx_conversation_parts ON conversation_records(part);
CREATE TRIGGER conversation_records_no_delete BEFORE DELETE ON conversation_records BEGIN
 SELECT RAISE(ABORT,'conversation records are append-only'); END;
CREATE TRIGGER conversation_records_no_update BEFORE UPDATE ON conversation_records BEGIN
 SELECT RAISE(ABORT,'conversation records are append-only'); END;
CREATE TABLE conversation_parts (
 source TEXT NOT NULL, part TEXT NOT NULL, revision TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(source,part)
);
CREATE TABLE conversation_projects (project TEXT PRIMARY KEY, checked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE conversation_memberships (project TEXT NOT NULL, conversation TEXT NOT NULL, PRIMARY KEY(project,conversation));
CREATE TABLE conversation_bindings (
 session TEXT NOT NULL, agent TEXT NOT NULL, cwd TEXT NOT NULL, job TEXT,
 pending INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(session,agent)
);
CREATE TABLE conversation_envelopes (id INTEGER PRIMARY KEY, message TEXT NOT NULL, recipient TEXT NOT NULL, UNIQUE(message,recipient));
${CONVERSATION_RECORDS_VIEW}
CREATE VIEW v_history_documents AS SELECT id, kind, agent, at, ab_text(body, body_codec) AS body_text, link, message, job, run, session, length(body) AS stored_bytes, body_codec FROM history_documents;
CREATE TABLE history_migration(version INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, status TEXT NOT NULL, manifest TEXT, source TEXT);
CREATE TABLE history_copy_state(table_name TEXT PRIMARY KEY, source_rows INTEGER NOT NULL, after_rowid INTEGER, copied_rows INTEGER NOT NULL DEFAULT 0,
 copy_sha256 TEXT NOT NULL DEFAULT '', verify_after INTEGER, verified_rows INTEGER NOT NULL DEFAULT 0, verify_sha256 TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0);
CREATE TABLE history_legacy_tail(source_id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL);
`;
}
var HISTORY_V2_COPY_TABLES = ["conversations", "conversation_sources", "conversation_parts", "conversation_projects", "conversation_memberships", "conversation_bindings", "conversation_envelopes", "history_cursors", "history_files", "history_tags", "history_sessions", "history_pending", "conversation_records", "history_documents"];

// src/core/history-store.ts
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
var HISTORY_DB_NAME = "history.db";
var HISTORY_STORE_VERSION = 2;
var HISTORY_COPY_ROWS = 64;
var HISTORY_BATCH_MS = 50;
var HISTORY_COPY_BYTES = 2 * 1024 * 1024;
var HISTORY_IO_BYTES_PER_SECOND = 64 * 1024 * 1024;
var quote = (s) => `"${s.replaceAll('"', '""')}"`;
function historyDbPath(bridge) {
  return bridge === ":memory:" ? bridge : join(dirname(bridge), HISTORY_DB_NAME);
}
function historyReady(db) {
  if (Number(db.prepare("PRAGMA user_version").get().user_version) !== HISTORY_STORE_VERSION) return false;
  return !!db.prepare("SELECT name FROM sqlite_master WHERE name='history_migration'").get() && db.prepare("SELECT status FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION)?.status === "verified";
}
function historyReadPath(file) {
  return historyReadStatus(file).path;
}
function historyReadStatus(file) {
  if (basename(file) !== "bridge.db") return { path: file };
  const path = historyDbPath(file);
  if (!existsSync(path)) return { path: file };
  const db = new DatabaseSync2(path, { readOnly: true, timeout: 100 });
  try {
    if (historyReady(db) || historyV1Readable(db)) return { path };
    const migration = legacyReadNotice(db);
    return migration ? { path: file, migration } : { path: file };
  } finally {
    db.close();
  }
}
function historyV1Readable(db) {
  return Number(db.prepare("PRAGMA user_version").get().user_version) === 1 && !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='history_migration'").get() && db.prepare("SELECT status FROM history_migration WHERE version=1").get()?.status === "verified";
}
function legacyReadNotice(db) {
  if (historyReady(db) || historyV1Readable(db)) return void 0;
  const version = Number(db.prepare("PRAGMA user_version").get().user_version);
  const has = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name);
  const v1 = version === 1 ? has("history_migration") && db.prepare("SELECT status FROM history_migration WHERE version=1").get()?.status === "verified" : has(`${HISTORY_V1_PREFIX}history_migration`) && db.prepare(`SELECT status FROM ${quote(`${HISTORY_V1_PREFIX}history_migration`)} WHERE version=1`).get()?.status === "verified";
  let phase = "starting", percent = 0, error = null;
  if (version === HISTORY_STORE_VERSION && has("history_migration")) {
    const state = db.prepare("SELECT status,manifest FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
    if (state) {
      phase = String(state.status);
      if (phase === "failed") {
        try {
          error = String(JSON.parse(String(state.manifest)).error);
        } catch {
          error = "History migration failed; explicit retry required";
        }
      }
      const totals = has("history_copy_state") ? db.prepare("SELECT coalesce(sum(copied_rows+verified_rows),0) done,coalesce(sum(source_rows),0)*2 total FROM history_copy_state").get() : { done: 0, total: 0 };
      percent = Number(totals.total) ? Math.min(99.99, Math.round(1e4 * Number(totals.done) / Number(totals.total)) / 100) : 0;
    }
  }
  const notice = phase === "failed" ? `History store migration failed (${error}); results come from the legacy store (bridge.db) and may miss recent history. Run agent-bridge reindex to retry; nothing was deleted.` : `History store migration in progress (${phase}, ${percent}%); results come from the legacy store (bridge.db)${v1 ? " and miss history captured by 0.30.0\u20130.30.3, which stays retained and becomes searchable when the migration finishes" : " and may miss the newest history until the migration finishes"}.`;
  return { ready: false, readsFrom: "legacy", phase, percent, error, notice };
}
function openHistoryReader(file, timeout = 100) {
  const db = new DatabaseSync2(file, { readOnly: true, timeout });
  try {
    registerHistoryFunctions(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
function liveHistoryV1Writers(home) {
  return liveStorePeers(home).filter((peer) => /^0\.30\.[0-3]$/.test(peer.version) || peer.version === "unknown").map((peer) => `${peer.name} (v${peer.version}, pid ${peer.pid})`);
}
function deferUpgrade(writers) {
  throw Object.assign(new Error(`Waiting to upgrade history store 1\u2192${HISTORY_STORE_VERSION}: ${writers.join(", ")} still write history v1. Reads stay on the legacy store; retry when they finish naturally.`), { code: "STORE_UPGRADE_DEFERRED" });
}
function openHistoryStore(file) {
  const db = new DatabaseSync2(file, { timeout: 3e3 });
  try {
    db.exec("PRAGMA busy_timeout=3000");
    registerHistoryFunctions(db);
    const version = Number(db.prepare("PRAGMA user_version").get().user_version);
    if (version > HISTORY_STORE_VERSION) throw new Error(`unsupported history store version: ${version}`);
    configureSqlite(db);
    if (version === HISTORY_STORE_VERSION) {
      refreshHistoryViews(db);
      return db;
    }
    if (version === 1 && file !== ":memory:" && liveHistoryV1Writers(dirname(file)).length) return db;
    upgradeHistoryStore(db, file);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
function refreshHistoryViews(db) {
  const current = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='v_conversation_records'").get();
  if (!current || String(current.sql).includes("ab_body(")) return;
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DROP VIEW IF EXISTS v_conversation_records");
      db.exec(CONVERSATION_RECORDS_VIEW);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    if (!isSqliteBusy(err)) throw err;
  }
}
function upgradeHistoryStore(db, file) {
  if (Number(db.prepare("PRAGMA user_version").get().user_version) === HISTORY_STORE_VERSION) return;
  const release = migrationLock(file);
  try {
    const current = Number(db.prepare("PRAGMA user_version").get().user_version);
    if (current === HISTORY_STORE_VERSION) return;
    if (current === 1 && file !== ":memory:") {
      const writers = liveHistoryV1Writers(dirname(file));
      if (writers.length) deferUpgrade(writers);
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      if (current === 1) {
        for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) db.exec(`DROP TRIGGER ${quote(String(row.name))}`);
        const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        const virtual = tables.filter((row) => /^CREATE VIRTUAL TABLE/i.test(String(row.sql))).map((row) => String(row.name));
        for (const row of tables) {
          const name = String(row.name);
          if (virtual.some((v) => name !== v && name.startsWith(`${v}_`))) continue;
          db.exec(`ALTER TABLE ${quote(name)} RENAME TO ${quote(HISTORY_V1_PREFIX + name)}`);
        }
        for (const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all()) {
          const name = String(row.name);
          if (name.startsWith(HISTORY_V1_PREFIX)) continue;
          db.exec(`DROP INDEX ${quote(name)}`);
          db.exec(String(row.sql).replace(/^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?"?([^"\s(]+)"?/i, (_m, unique = "", ifne = "") => `CREATE ${unique}INDEX ${ifne}${quote(HISTORY_V1_PREFIX + name)}`));
        }
      }
      db.exec(historyStoreV2Schema());
      db.exec(`PRAGMA user_version=${HISTORY_STORE_VERSION}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    release();
  }
}
async function migrateHistoryStore(bridge, target, shouldPause = () => false, stopped = () => false, onLease, retryFailed = false, options = {}) {
  if (Number(target.prepare("PRAGMA user_version").get().user_version) !== HISTORY_STORE_VERSION) {
    await refreshStorePeerIdentities(dirname(bridge)).catch(() => {
    });
    upgradeHistoryStore(target, historyDbPath(bridge));
  }
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
      retainFailedAttempt(target);
    }
    await resumableHistoryMigration(bridge, target, shouldPause, stopped, { transient: isTransientHistoryError, ...options });
  } catch (err) {
    const state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
    if (state && state.status !== "failed" && !isTransientHistoryError(err)) {
      target.prepare("UPDATE history_migration SET status='failed',manifest=? WHERE version=?").run(JSON.stringify({ error: String(err), resumeStatus: state.status }), HISTORY_STORE_VERSION);
    }
    throw err;
  } finally {
    release();
    onLease?.(null);
  }
}
var TRANSIENT_CODES = /* @__PURE__ */ new Set([
  "HISTORY_MIGRATION_STOPPED",
  "HISTORY_DISK_SPACE",
  "HISTORY_SNAPSHOT_PAUSED",
  "STORE_UPGRADE_DEFERRED",
  "EBUSY",
  "EPERM",
  "EACCES",
  "ENOSPC",
  "EMFILE",
  "ENFILE",
  "EAGAIN",
  "EIO",
  "ETIMEDOUT",
  "EDQUOT",
  "ENOLCK"
]);
function isTransientHistoryError(err) {
  if (isSqliteBusy(err)) return true;
  const value = err;
  if (TRANSIENT_CODES.has(String(value?.code))) return true;
  const primary = typeof value?.errcode === "number" ? value.errcode & 255 : void 0;
  return primary === 10 || primary === 13 || primary === 14;
}
function retainFailedAttempt(target) {
  const stamp = Date.now();
  target.exec("BEGIN IMMEDIATE");
  try {
    for (const name of HISTORY_V2_COPY_TABLES) {
      if (!Number(target.prepare(`SELECT count(*) n FROM ${quote(name)}`).get().n)) continue;
      target.exec(`CREATE TABLE ${quote(`retained_${stamp}_${name}`)} AS SELECT rowid AS retained_rowid,* FROM ${quote(name)}`);
      if (name === "conversation_records") target.exec("DROP TRIGGER IF EXISTS conversation_records_no_delete");
      if (name === "history_documents") clearHistoryDocuments(target);
      else target.exec(`DELETE FROM ${quote(name)}`);
    }
    target.exec(`CREATE TRIGGER IF NOT EXISTS conversation_records_no_delete BEFORE DELETE ON conversation_records BEGIN
 SELECT RAISE(ABORT,'conversation records are append-only'); END`);
    target.exec(`CREATE TABLE ${quote(`retained_${stamp}_history_migration`)} AS SELECT * FROM history_migration; DELETE FROM history_migration;`);
    target.exec(`CREATE TABLE ${quote(`retained_${stamp}_history_copy_state`)} AS SELECT * FROM history_copy_state; DELETE FROM history_copy_state;`);
    target.exec("COMMIT");
  } catch (err) {
    target.exec("ROLLBACK");
    throw err;
  }
}
function historyMigrationFailure(db) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='history_migration'").get()) return null;
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
var LEGACY_CONFLICTS = `CREATE TABLE IF NOT EXISTS history_legacy_conflicts(source_id INTEGER PRIMARY KEY, reason TEXT NOT NULL,
 source TEXT, generation INTEGER, offset INTEGER, conversation TEXT, at INTEGER, raw BLOB, body TEXT, part TEXT, recorded_at INTEGER NOT NULL)`;
function legacyTailConflicts(db) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='history_legacy_conflicts'").get() ? Number(db.prepare("SELECT count(*) n FROM history_legacy_conflicts").get().n) : 0;
}
function copyLegacyConversationTail(source, target) {
  if (!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_records'").get()) return 0;
  const fts = !!target.prepare("SELECT name FROM sqlite_master WHERE name='history_fts'").get();
  const v2 = !!target.prepare("SELECT 1 FROM pragma_table_info('conversation_records') WHERE name='raw_codec'").get();
  const after = Number(target.prepare("SELECT cursor FROM history_cursors WHERE source='legacy-record-tail'").get()?.cursor ?? 0);
  const deadline = Date.now() + HISTORY_BATCH_MS;
  let work = 0;
  for (const row of source.prepare("SELECT * FROM conversation_records WHERE id>? ORDER BY id LIMIT ?").iterate(after, HISTORY_COPY_ROWS)) {
    const conversation = source.prepare("SELECT * FROM conversations WHERE id=?").get(row.conversation);
    target.exec("BEGIN IMMEDIATE");
    try {
      const retain = (reason) => {
        target.exec(LEGACY_CONFLICTS);
        target.prepare("INSERT OR IGNORE INTO history_legacy_conflicts VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(row.id, reason, row.source ?? null, row.generation ?? null, row.offset ?? null, row.conversation ?? null, row.at ?? null, row.raw ?? null, row.body ?? null, row.part ?? null, Date.now());
      };
      if (!conversation) retain("orphan");
      else {
        const columns = Object.keys(conversation);
        target.prepare(`INSERT OR IGNORE INTO conversations(${columns.map(quote).join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...Object.values(conversation));
        let copied = target.prepare("SELECT * FROM conversation_records WHERE source=? AND generation=? AND offset=?").get(row.source, row.generation, row.offset);
        if (!copied) {
          const { id: _id, ...plain } = row;
          const encoded = v2 ? encodeHistoryRow("conversation_records", plain, fts) : plain;
          const names = ["source", "generation", "offset", "conversation", "at", "raw", ...v2 ? ["raw_codec"] : [], "body", "part"];
          target.prepare(`INSERT INTO conversation_records(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`).run(...names.map((name) => encoded[name] ?? null));
          copied = target.prepare("SELECT * FROM conversation_records WHERE source=? AND generation=? AND offset=?").get(row.source, row.generation, row.offset);
        }
        const decoded = v2 ? decodeHistoryRow("conversation_records", copied) : copied;
        if (decoded.conversation !== row.conversation || !Buffer.from(decoded.raw).equals(Buffer.from(row.raw))) retain("conflict");
        else target.prepare("INSERT OR IGNORE INTO history_legacy_tail VALUES(?,?)").run(row.id, copied.id);
      }
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
function clearHistoryDocuments(db) {
  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='history_delete'").get();
  if (!trigger) {
    db.exec("DELETE FROM history_documents");
    return;
  }
  db.exec("DROP TRIGGER history_delete");
  db.exec("DELETE FROM history_documents");
  db.exec("INSERT INTO history_fts(history_fts) VALUES('delete-all')");
  db.exec(String(trigger.sql));
}

// src/core/sqlite-fast-snapshot.ts
import { backup, DatabaseSync as DatabaseSync3 } from "node:sqlite";
import { closeSync, constants as constants2, existsSync as existsSync2, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { dirname as dirname2, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
function physical(path) {
  let current = resolve(path);
  for (; ; ) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Linked snapshot path retained: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname2(current);
    if (parent === current) return;
    current = parent;
  }
}
function snapshotHeader(file) {
  physical(file);
  const fd = openSync(file, "r");
  let bytes;
  try {
    const header = Buffer.alloc(100);
    bytes = fstatSync(fd).size;
    if (readSync(fd, header, 0, 100, 0) !== 100 || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0") throw new Error("Invalid snapshot header; retained for investigation.");
    const encoded = header.readUInt16BE(16), pageSize = encoded === 1 ? 65536 : encoded, pages = header.readUInt32BE(28);
    if (!pageSize || !pages || pages * pageSize !== bytes) throw new Error("Snapshot page count does not match its file size; retained.");
  } finally {
    closeSync(fd);
  }
  return bytes;
}
async function verifyInWorker(file) {
  const bytes = snapshotHeader(file);
  await new Promise((resolvePromise, reject) => {
    const worker = new Worker(`
   const { workerData, parentPort } = require('node:worker_threads');
   const { DatabaseSync } = require('node:sqlite');
   const db = new DatabaseSync(workerData,{readOnly:true});
   try {
    if (db.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok')) throw new Error('Snapshot quick_check failed; retained.');
    parentPort.postMessage('ok');
   } finally { db.close(); }
  `, { eval: true, workerData: file });
    worker.once("error", reject);
    worker.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`Snapshot verification worker exited ${code}; retained.`)));
  });
  return bytes;
}
async function fastSnapshot(source, destination, options = {}) {
  physical(source);
  physical(destination);
  if (resolve(source) === resolve(destination) || existsSync2(destination)) throw new Error("Snapshot destination must be new; existing data retained.");
  const method = options.method ?? "backup";
  if (method === "copy" && !options.allowCheckpoint) throw new Error("OS-copy snapshots require explicit checkpoint authorization.");
  const db = new DatabaseSync3(source, { readOnly: method === "backup", timeout: method === "copy" ? 2e3 : 0 });
  let pinned = false;
  let fallback = false, checkpointAttempts = 0;
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const start = performance.now();
  try {
    if (method === "copy") {
      const wal = db.prepare("PRAGMA journal_mode").get().journal_mode === "wal";
      let ready = false;
      for (let attempt = 0; wal && attempt < 3; attempt++) {
        checkpointAttempts++;
        const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        if (checkpoint.busy === 0 && checkpoint.log === 0 && checkpoint.checkpointed === 0) {
          db.exec("BEGIN");
          pinned = true;
          db.prepare("SELECT count(*) FROM sqlite_schema").get();
          if (!existsSync2(`${source}-wal`) || lstatSync(`${source}-wal`).size === 0) {
            ready = true;
            break;
          }
          db.exec("ROLLBACK");
          pinned = false;
        }
        if (attempt < 2) await delay(5e3);
      }
      if (!ready) fallback = true;
      else {
        await options.onPinned?.(db);
        await copyFile(source, destination, constants2.COPYFILE_EXCL);
      }
    } else {
      db.exec("BEGIN");
      pinned = true;
      db.prepare("SELECT count(*) FROM sqlite_schema").get();
      await options.onPinned?.(db);
      const fd = openSync(destination, "wx", 384);
      closeSync(fd);
      await backup(db, destination, { rate: options.rate ?? 16384, ...options.progress ? { progress: options.progress } : {} });
    }
  } finally {
    if (pinned) db.exec("ROLLBACK");
    db.close();
  }
  if (fallback) {
    const result = await fastSnapshot(source, destination, { ...options, method: "backup", allowCheckpoint: false });
    return { ...result, startedAt, checkpointAttempts };
  }
  const copiedAt = (/* @__PURE__ */ new Date()).toISOString(), copyMs = performance.now() - start, verifyStart = performance.now(), bytes = await verifyInWorker(destination), verifyMs = performance.now() - verifyStart;
  return { method, bytes, copyMs, verifyMs, mibPerSecond: bytes / 1024 / 1024 / (copyMs / 1e3), startedAt, copiedAt, verifiedAt: (/* @__PURE__ */ new Date()).toISOString(), checkpointAttempts };
}

// src/core/history-migration.ts
var HISTORY_V1_PREFIX = "v1_";
var q = (s) => `"${s.replaceAll('"', '""')}"`;
var failure = (detail) => Object.assign(new Error(`History migration verification failed: ${detail}; all originals and snapshots preserved; explicit retry required`), { code: "HISTORY_VERIFICATION_FAILED" });
function foldedText(text) {
  return text.normalize("NFKD").replace(new RegExp("\\p{M}", "gu"), "").toLowerCase();
}
function digestRows(rows, names) {
  const hash = createHash("sha256");
  for (const row of rows) for (const key of names) {
    const value = row[key] ?? null;
    const bytes = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value));
    hash.update(`${key.length}:${key}:${value === null ? "null" : value instanceof Uint8Array ? "blob" : typeof value}:${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}
function chainRows(previous, rows, names) {
  let hash = previous;
  for (const row of rows) hash = createHash("sha256").update(hash).update(digestRows([row], names)).digest("hex");
  return hash;
}
function rowBytes(row) {
  return Object.values(row).reduce((n, v) => n + (v instanceof Uint8Array ? v.byteLength : typeof v === "string" ? Buffer.byteLength(v) : 8), 0);
}
function encodeHistoryRow(table, row, fts) {
  if (table === "conversation_records") {
    const raw = row.raw instanceof Uint8Array ? Buffer.from(row.raw) : Buffer.from(String(row.raw ?? ""), "utf8");
    const encoded = encodeBytes(raw);
    const body = row.body === null || row.body === void 0 ? null : String(row.body);
    return { ...row, raw: encoded.value, raw_codec: encoded.codec, body: body !== null && body === raw.toString("utf8") ? null : body };
  }
  if (table === "history_documents") {
    const body = String(row.body ?? "");
    const encoded = encodeText(body);
    const folded = row.folded === null || row.folded === void 0 ? null : String(row.folded);
    return { ...row, body: encoded.value, body_codec: encoded.codec, folded: fts && folded !== null && folded === foldedText(body) ? null : folded };
  }
  return row;
}
function decodeHistoryRow(table, row) {
  if (table === "conversation_records") {
    const raw = decodeBytes(row.raw, row.raw_codec);
    const { raw_codec: _codec, ...rest } = row;
    return { ...rest, raw, body: row.body === null || row.body === void 0 ? raw.toString("utf8") : row.body };
  }
  if (table === "history_documents") {
    const body = decodeText(row.body, row.body_codec);
    const { body_codec: _codec, ...rest } = row;
    return { ...rest, body, folded: row.folded === null || row.folded === void 0 ? foldedText(body) : row.folded };
  }
  return row;
}
function sourceColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${q(table)})`).all().map((r) => String(r.name));
}
function readHistoryMigrationProgress(target, ioBytesPerSecond = HISTORY_IO_BYTES_PER_SECOND) {
  const result = { phase: "starting", percent: 0, etaSeconds: null, paused: false, completedRows: 0, totalRows: 0, snapshot: null, ioBytesPerSecond, error: null };
  if (!target.prepare("SELECT name FROM sqlite_master WHERE name='history_migration'").get()) return result;
  const state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
  if (!state) return result;
  result.snapshot = state.snapshot;
  if (state.status === "verified") return { ...result, phase: "verified", percent: 100, etaSeconds: 0 };
  if (state.status === "failed") {
    let error = "History migration failed; explicit retry required";
    try {
      error = String(JSON.parse(state.manifest).error);
    } catch {
    }
    return { ...result, phase: "failed", error };
  }
  if (state.status === "snapshotting") return { ...result, phase: "snapshot" };
  const totals = target.prepare("SELECT coalesce(sum(copied_rows+verified_rows),0) done,coalesce(sum(source_rows),0)*2 total,coalesce(sum(done=0),0) copying FROM history_copy_state").get();
  result.completedRows = Number(totals.done);
  result.totalRows = Math.max(result.completedRows, Number(totals.total));
  result.percent = result.totalRows ? Math.min(99.99, 100 * result.completedRows / result.totalRows) : 0;
  result.phase = Number(totals.copying) ? "copy" : "verify";
  return result;
}
function assertDiskSpace(source, folder) {
  const needed = statSync(source).size * 1.5 + 1024 ** 3;
  const fs = statfsSync(folder);
  const free = fs.bavail * fs.bsize;
  if (free < needed) throw Object.assign(new Error(`History migration needs about ${Math.ceil(needed / 1024 ** 3)} GiB free next to ${folder}; ${Math.floor(free / 1024 ** 3)} GiB available. Nothing changed; it resumes when space is available.`), { code: "HISTORY_DISK_SPACE" });
}
async function resumableHistoryMigration(bridge, target, paused, stopped, options = {}) {
  const limit = options.ioBytesPerSecond ?? HISTORY_IO_BYTES_PER_SECOND;
  const transient = options.transient ?? ((err) => err.code === "HISTORY_DISK_SPACE");
  if (!Number.isFinite(limit) || limit < 64 * 1024 || limit > 1024 * 1024 * 1024) throw new Error("History migration I/O limit must be between 64 KiB/s and 1 GiB/s");
  registerHistoryFunctions(target);
  const fts = !!target.prepare("SELECT name FROM sqlite_master WHERE name='history_fts'").get();
  let state = target.prepare("SELECT * FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
  let nextAt = 0, pressureSince = 0, source;
  let progress = { ...readHistoryMigrationProgress(target, limit), paused: false };
  let start = Date.now(), startRows = progress.completedRows;
  const emit = (changes = {}) => {
    const current = readHistoryMigrationProgress(target, limit);
    const work = current.completedRows - startRows;
    progress = { ...current, etaSeconds: work > 0 ? Math.ceil((Date.now() - start) / 1e3 / work * (current.totalRows - current.completedRows)) : null, ...changes };
    options.onProgress?.({ ...progress });
  };
  const gap = async () => {
    await delay2(5);
    for (; ; ) {
      if (stopped()) throw Object.assign(new Error("History migration stopped; snapshot and durable copy cursors preserved"), { code: "HISTORY_MIGRATION_STOPPED" });
      if (paused()) {
        if (!pressureSince) {
          pressureSince = Date.now();
          emit({ paused: true });
        }
        await delay2(100);
        continue;
      }
      if (pressureSince) {
        pressureSince = 0;
        emit({ paused: false });
      }
      const remaining = nextAt - Date.now();
      if (remaining <= 0) return;
      await delay2(Math.min(100, remaining));
    }
  };
  const pace = (bytes, since) => {
    nextAt = since + Math.ceil(bytes * 1e3 / limit);
  };
  const table = (name) => target.prepare("SELECT * FROM history_copy_state WHERE table_name=?").get(name);
  try {
    await gap();
    if (!state) {
      const v1 = target.prepare("SELECT name FROM sqlite_master WHERE name=?").get(`${HISTORY_V1_PREFIX}history_migration`) ? target.prepare(`SELECT status FROM ${q(`${HISTORY_V1_PREFIX}history_migration`)} WHERE version=1`).get() : void 0;
      const kind = v1?.status === "verified" ? "history-v1" : "bridge";
      const folder = join2(dirname3(bridge), ".migration-snapshots");
      mkdirSync(folder, { recursive: true, mode: 448 });
      state = { snapshot: join2(folder, `history-v2-source-${randomUUID()}.db`), status: "snapshotting", manifest: null, source: kind };
      target.prepare("INSERT INTO history_migration(version,snapshot,status,manifest,source) VALUES(?,?,'snapshotting',NULL,?)").run(HISTORY_STORE_VERSION, state.snapshot, kind);
    }
    const sourceFile = state.source === "history-v1" ? join2(dirname3(bridge), "history.db") : bridge;
    const prefix = state.source === "history-v1" ? HISTORY_V1_PREFIX : "";
    if (state.status === "snapshotting") {
      emit({ phase: "snapshot" });
      assertDiskSpace(sourceFile, dirname3(state.snapshot));
      if (existsSync3(state.snapshot)) renameSync(state.snapshot, `${state.snapshot}.interrupted-${Date.now()}`);
      await (options.snapshot ?? fastSnapshot)(sourceFile, state.snapshot, { method: "copy", allowCheckpoint: true });
      source = new DatabaseSync4(state.snapshot, { readOnly: true });
      target.exec("BEGIN IMMEDIATE");
      try {
        for (const name of HISTORY_V2_COPY_TABLES) {
          if (!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(prefix + name)) continue;
          const max = Number(source.prepare(`SELECT coalesce(max(rowid),0) n FROM ${q(prefix + name)}`).get().n);
          target.prepare("INSERT OR IGNORE INTO history_copy_state(table_name,source_rows) VALUES(?,?)").run(name, max);
        }
        target.prepare("UPDATE history_migration SET status='copying' WHERE version=?").run(HISTORY_STORE_VERSION);
        target.exec("COMMIT");
      } catch (err) {
        target.exec("ROLLBACK");
        throw err;
      }
      state.status = "copying";
    }
    source ??= new DatabaseSync4(state.snapshot, { readOnly: true });
    source.exec("PRAGMA query_only=ON; PRAGMA cache_size=-8192");
    start = Date.now();
    startRows = readHistoryMigrationProgress(target, limit).completedRows;
    emit({ phase: "copy" });
    const read = (name, after) => {
      const rows = [];
      let bytes = 0;
      const began = Date.now();
      for (const value of source.prepare(`SELECT rowid AS __rowid,* FROM ${q(prefix + name)} WHERE rowid>? ORDER BY rowid LIMIT ?`).iterate(after ?? -1, HISTORY_COPY_ROWS)) {
        rows.push(value);
        bytes += rowBytes(value);
        if (bytes >= HISTORY_COPY_BYTES || Date.now() - began >= HISTORY_BATCH_MS) break;
      }
      return { rows, bytes };
    };
    const targetRange = (name, first, last, count) => target.prepare(`SELECT rowid AS __rowid,* FROM ${q(name)} WHERE rowid>=? AND rowid<=? ORDER BY rowid LIMIT ?`).all(first, last, count + 1);
    for (const name of HISTORY_V2_COPY_TABLES) {
      let current = table(name);
      if (!current) continue;
      const names = sourceColumns(source, prefix + name), digestNames = ["__rowid", ...names];
      const columns = Object.keys(encodeHistoryRow(name, Object.fromEntries(names.map((n) => [n, null])), fts));
      const insert = target.prepare(`INSERT INTO ${q(name)}(rowid,${columns.map(q).join(",")}) VALUES(?,${columns.map(() => "?").join(",")})`);
      while (!current.done) {
        await gap();
        const since = Date.now(), { rows, bytes } = read(name, current.after_rowid);
        if (!rows.length) {
          target.prepare("UPDATE history_copy_state SET done=1 WHERE table_name=?").run(name);
          break;
        }
        const expected = digestRows(rows, digestNames);
        target.exec("BEGIN IMMEDIATE");
        try {
          for (const row of rows) {
            const { __rowid, ...plain } = row;
            const encoded = encodeHistoryRow(name, plain, fts);
            insert.run(__rowid, ...columns.map((column) => encoded[column] ?? null));
          }
          const copied = targetRange(name, Number(rows[0].__rowid), Number(rows.at(-1).__rowid), rows.length).map((row) => decodeHistoryRow(name, row));
          if (copied.length !== rows.length || digestRows(copied, digestNames) !== expected) throw failure(`${name} rows after ${current.after_rowid ?? 0}`);
          target.prepare("UPDATE history_copy_state SET after_rowid=?,copied_rows=copied_rows+?,copy_sha256=? WHERE table_name=?").run(Number(rows.at(-1).__rowid), rows.length, chainRows(current.copy_sha256, rows, digestNames), name);
          target.exec("COMMIT");
        } catch (err) {
          target.exec("ROLLBACK");
          throw err;
        }
        pace(bytes * 2, since);
        current = table(name);
        emit({ phase: "copy" });
      }
    }
    emit({ phase: "verify" });
    const manifest = {};
    for (const name of HISTORY_V2_COPY_TABLES) {
      let current = table(name);
      if (!current) continue;
      const names = sourceColumns(source, prefix + name), digestNames = ["__rowid", ...names];
      while (!current.verified) {
        await gap();
        const since = Date.now(), { rows, bytes } = read(name, current.verify_after);
        if (!rows.length) {
          const total = Number(target.prepare(`SELECT count(*) n FROM ${q(name)}`).get().n);
          if (total !== current.copied_rows || current.verified_rows !== current.copied_rows || current.verify_sha256 !== current.copy_sha256) throw failure(`${name} totals`);
          target.prepare("UPDATE history_copy_state SET verified=1 WHERE table_name=?").run(name);
          break;
        }
        const expected = digestRows(rows, digestNames);
        const copied = targetRange(name, Number(rows[0].__rowid), Number(rows.at(-1).__rowid), rows.length).map((row) => decodeHistoryRow(name, row));
        if (copied.length !== rows.length || digestRows(copied, digestNames) !== expected) throw failure(`${name} verification after ${current.verify_after ?? 0}`);
        target.prepare("UPDATE history_copy_state SET verify_after=?,verified_rows=verified_rows+?,verify_sha256=? WHERE table_name=?").run(Number(rows.at(-1).__rowid), rows.length, chainRows(current.verify_sha256, rows, digestNames), name);
        pace(bytes * 2, since);
        current = table(name);
        emit({ phase: "verify" });
      }
      manifest[name] = { rows: current.verified_rows, sha256: current.verify_sha256 || createHash("sha256").digest("hex") };
    }
    await gap();
    target.exec("BEGIN IMMEDIATE");
    try {
      if (state.source === "history-v1") {
        if (source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(`${prefix}history_legacy_tail`)) {
          const map = target.prepare("INSERT OR IGNORE INTO history_legacy_tail(source_id,target_id) VALUES(?,?)");
          for (const row of source.prepare(`SELECT source_id,target_id FROM ${q(`${prefix}history_legacy_tail`)}`).iterate()) map.run(row.source_id, row.target_id);
        }
      } else {
        const max = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(`${prefix}conversation_records`) ? Number(source.prepare(`SELECT coalesce(max(id),0) n FROM ${q(`${prefix}conversation_records`)}`).get().n) : 0;
        target.prepare("INSERT INTO history_cursors VALUES('legacy-record-tail',?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor").run(String(max));
      }
      target.prepare("UPDATE history_migration SET status='verified',manifest=? WHERE version=?").run(JSON.stringify(manifest), HISTORY_STORE_VERSION);
      target.exec("COMMIT");
    } catch (err) {
      target.exec("ROLLBACK");
      throw err;
    }
    emit({ phase: "verified", percent: 100, etaSeconds: 0, paused: false });
  } catch (err) {
    const code = err.code;
    emit(code === "HISTORY_MIGRATION_STOPPED" ? { paused: true, error: null } : transient(err) ? { paused: true, error: String(err.message ?? err) } : { phase: "failed", error: String(err), etaSeconds: null });
    throw err;
  } finally {
    source?.close();
  }
}

export {
  historySchema,
  HISTORY_V2_COPY_TABLES,
  CONVERSATION_BYTES,
  indexedConversationText,
  conversationBodyText,
  encodeBytes,
  decodeBytes,
  encodeText,
  decodeText,
  registerHistoryFunctions,
  HISTORY_V1_PREFIX,
  chainRows,
  decodeHistoryRow,
  readHistoryMigrationProgress,
  HISTORY_DB_NAME,
  HISTORY_STORE_VERSION,
  HISTORY_BATCH_MS,
  HISTORY_IO_BYTES_PER_SECOND,
  historyDbPath,
  historyReady,
  historyReadPath,
  historyReadStatus,
  historyV1Readable,
  legacyReadNotice,
  openHistoryReader,
  openHistoryStore,
  migrateHistoryStore,
  historyMigrationFailure,
  releaseExitedHistoryLease,
  legacyTailConflicts,
  copyLegacyConversationTail,
  clearHistoryDocuments
};
