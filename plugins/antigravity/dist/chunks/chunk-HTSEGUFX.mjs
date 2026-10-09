import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  SQLITE_STORE_VERSION
} from "./chunk-RQUYBZWF.mjs";
import {
  HistoryIndex,
  cleanupSavepoint
} from "./chunk-OLKI265K.mjs";
import {
  CONVERSATION_MIGRATION
} from "./chunk-YDEC4ZHB.mjs";
import {
  historyDbPath,
  historySchema,
  openHistoryStore
} from "./chunk-CHBSI67H.mjs";
import {
  AUTO_BACKUP_ENV,
  BACKUP_INTERVAL_ENV,
  DEFAULT_BACKUP_INTERVAL_MS
} from "./chunk-QDCRXLPB.mjs";
import {
  bundleDirectory
} from "./chunk-D5ZW6VFT.mjs";
import {
  SIBLING_CONVERSATION_PREFIX,
  isQuietMessage
} from "./chunk-4QXHCXBU.mjs";
import {
  DECISIONS_SCHEMA,
  DecisionStore
} from "./chunk-MQP6K4NJ.mjs";
import {
  isPluginCacheCwd
} from "./chunk-QI5MA53T.mjs";
import {
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_REQUEST_BUSY_MS,
  archiveDbPath,
  archiveMessages,
  configureSqlite,
  isSqliteBusy,
  migrateSqlite,
  openArchive,
  retentionLimit,
  retrySqlite,
  storageLease
} from "./chunk-OMBGRGBY.mjs";

// src/core/store.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, realpathSync } from "node:fs";
import { dirname as dirname3, resolve } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

// src/core/backup-background.ts
import { fork } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var BackupBackground = class {
  constructor(home, log) {
    this.home = home;
    this.log = log;
    if (this.enabled) this.schedule(3e4);
  }
  home;
  log;
  worker = null;
  timer = null;
  pending = false;
  pauseUntil = 0;
  stopped = false;
  failed = false;
  enabled = process.env[AUTO_BACKUP_ENV] === "1" && retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS) > 0;
  lastVerifiedAt = null;
  lastError = null;
  pressure(pending, lockError = false) {
    const changed = this.pending !== pending || lockError;
    this.pending = pending;
    if (lockError) this.pauseUntil = Date.now() + 5e3;
    if (changed && this.worker?.connected) this.worker.send({ type: "pressure", pending, pauseUntil: this.pauseUntil }, () => {
    });
  }
  status() {
    const paused = this.pending || Date.now() < this.pauseUntil;
    return {
      phase: !this.enabled ? "disabled" : this.stopped ? "stopped" : this.failed ? "failed" : paused ? "paused" : this.worker ? "running" : this.lastVerifiedAt ? "verified" : "scheduled",
      lastVerifiedAt: this.lastVerifiedAt,
      lastError: this.lastError
    };
  }
  schedule(delay2) {
    if (!this.enabled || this.stopped || this.failed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, delay2);
    this.timer.unref();
  }
  start() {
    if (!this.enabled || this.stopped || this.worker || this.failed) return;
    if (this.pending || Date.now() < this.pauseUntil) {
      this.schedule(3e4);
      return;
    }
    let entry = pathToFileURL(join(bundleDirectory(import.meta.url), "backup-worker.mjs"));
    if (import.meta.url.endsWith(".ts")) {
      const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
      const path = join(process.env.AGENT_BRIDGE_TEST_ROOT ?? join(root, ".agent-bridge-test"), "backup-worker.mjs");
      const inputs = ["backup-worker.ts", "message-backups.ts", "backups.ts", "storage-lock.ts", "json-store.ts"];
      if (!existsSync(path) || inputs.some((name) => statSync(join(root, "src/core", name)).mtimeMs > statSync(path).mtimeMs)) {
        mkdirSync(dirname(path), { recursive: true });
        createRequire(import.meta.url)("esbuild").buildSync({ entryPoints: [join(root, "src/core/backup-worker.ts")], outfile: path, bundle: true, platform: "node", format: "esm", target: "node22", external: ["node:*"], logLevel: "silent" });
      }
      entry = pathToFileURL(path);
    }
    const worker = this.worker = fork(fileURLToPath(entry), [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], windowsHide: true });
    worker.on("message", (message) => {
      if (message.error) {
        this.lastError = String(message.error).includes("sustained broker pressure") ? "broker_pressure" : "backup_failed";
        const pressureOnly = this.lastError === "broker_pressure";
        this.failed = !pressureOnly;
        if (!this.stopped) this.log.warn("automatic backup deferred; original and partial snapshots preserved", { err: message.error });
      } else if (message.path) {
        this.lastVerifiedAt = Date.now();
        this.lastError = null;
        this.log.info("automatic backup verified", { backup: message.path });
      }
    });
    worker.on("error", (error) => {
      this.failed = true;
      this.lastError = "worker_failed";
      this.log.warn("automatic backup process failed", { err: String(error) });
    });
    worker.on("exit", (code, signal) => {
      if (!this.stopped && (code !== 0 || signal)) {
        this.failed = true;
        this.lastError = "worker_failed";
      }
      if (this.worker === worker) this.worker = null;
      const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
      if (interval) this.schedule(Math.min(interval, 60 * 60 * 1e3));
    });
    worker.send({ type: "pressure", pending: this.pending, pauseUntil: this.pauseUntil }, () => {
    });
    worker.send({ type: "start", home: this.home }, () => {
    });
    worker.unref();
  }
  async close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const worker = this.worker;
    if (worker?.connected) worker.send({ type: "stop" }, () => {
    });
    if (worker) await new Promise((resolve2) => worker.once("exit", () => resolve2()));
  }
};

// src/core/store-compatibility-overlay.ts
import { existsSync as existsSync2 } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
import { DatabaseSync } from "node:sqlite";
var TABLES = ["session_bindings", "peer_names", "peer_name_owners", "job_delivery_routes", "peer_last_seen"];
var SCHEMA = `
CREATE TABLE session_bindings(identity TEXT NOT NULL, session_id TEXT NOT NULL, learned_at INTEGER NOT NULL, PRIMARY KEY(identity,session_id));
CREATE TABLE peer_names(identity TEXT NOT NULL, name TEXT NOT NULL, session_id TEXT, agent TEXT NOT NULL, learned_at INTEGER NOT NULL, PRIMARY KEY(identity,name));
CREATE TABLE peer_name_owners(name TEXT PRIMARY KEY, identity TEXT NOT NULL);
CREATE TABLE job_delivery_routes(id TEXT PRIMARY KEY, recipient TEXT NOT NULL, consumed_at INTEGER);
CREATE TABLE peer_last_seen(name TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
PRAGMA user_version=1;`;
function attachStoreCompatibility(db, file, log, create) {
  const path = join2(dirname2(file), "store-compatibility.db");
  const existed = existsSync2(path);
  if (!create && !existed) return;
  const overlay = new DatabaseSync(path);
  try {
    migrateSqlite(overlay, path, existed, 1, [{ version: 1, sql: SCHEMA }], log);
  } finally {
    overlay.close();
  }
  db.prepare("ATTACH DATABASE ? AS store_compatibility").run(path);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of TABLES) {
      if (!db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const merge = table === "peer_last_seen" ? "ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)" : table === "session_bindings" ? "ON CONFLICT(identity,session_id) DO UPDATE SET learned_at=MAX(session_bindings.learned_at,excluded.learned_at)" : "ON CONFLICT DO NOTHING";
      db.exec(`INSERT INTO main.${table} SELECT * FROM store_compatibility.${table} WHERE 1 ${merge}`);
    }
    if (!db.prepare("SELECT name FROM main.sqlite_master WHERE name='peer_last_seen'").get()) {
      db.exec(`INSERT INTO store_compatibility.peer_last_seen SELECT name, MAX(learned_at) FROM peer_names GROUP BY name
        ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// src/core/store.ts
var BROADCAST_RECENT_MS = 24 * 60 * 60 * 1e3;
function agentQueueKey(agent) {
  return `agent:${agent}`;
}
var SCHEMA2 = `
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT    NOT NULL,
  recipient       TEXT    NOT NULL,
  from_id         TEXT    NOT NULL,
  from_name       TEXT    NOT NULL,
  from_agent      TEXT    NOT NULL,
  to_target       TEXT    NOT NULL,
  conversation_id TEXT    NOT NULL,
  reply_to        TEXT,
  hop             INTEGER NOT NULL,
  body            TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  read_at         INTEGER,
  PRIMARY KEY (id, recipient)
);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages (recipient, read_at, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_id ON messages (id);
`;
var MIGRATIONS = [
  { version: 1, sql: `${SCHEMA2} PRAGMA user_version = 1;` },
  { version: 2, sql: `
    CREATE TABLE IF NOT EXISTS archived_messages AS
      SELECT *, '' AS archive_reason, 0 AS archived_at FROM messages WHERE 0;
    PRAGMA user_version = 2;
  ` },
  { version: 3, sql: `${DECISIONS_SCHEMA} PRAGMA user_version = 3;` },
  { version: 4, sql: historySchema() },
  { version: 5, sql: `
    CREATE TABLE IF NOT EXISTS session_bindings (
      identity TEXT NOT NULL,
      session_id TEXT NOT NULL,
      learned_at INTEGER NOT NULL,
      PRIMARY KEY (identity, session_id)
    );
    PRAGMA user_version = 5;
  ` },
  { version: 6, sql: `
    CREATE TABLE IF NOT EXISTS peer_names (
      identity TEXT NOT NULL, name TEXT NOT NULL, session_id TEXT, agent TEXT NOT NULL,
      learned_at INTEGER NOT NULL, PRIMARY KEY (identity, name)
    );
    CREATE TABLE IF NOT EXISTS peer_name_owners (
      name TEXT PRIMARY KEY, identity TEXT NOT NULL
    );
    INSERT INTO peer_names
      SELECT binding.identity, json_extract(binding.identity, '$[4]'), binding.session_id, json_extract(binding.identity, '$[0]'), binding.learned_at
      FROM session_bindings binding WHERE json_valid(binding.identity)
        AND json_type(binding.identity, '$[4]')='text' AND json_type(binding.identity, '$[0]')='text'
        AND NOT EXISTS (
          SELECT 1 FROM session_bindings other WHERE json_valid(other.identity)
            AND other.identity<>binding.identity
            AND json_extract(other.identity, '$[4]')=json_extract(binding.identity, '$[4]')
        )
      ORDER BY binding.learned_at ASC
      ON CONFLICT(identity, name) DO UPDATE SET session_id=excluded.session_id, learned_at=excluded.learned_at;
    INSERT INTO peer_name_owners SELECT name, identity FROM peer_names WHERE 1 ORDER BY learned_at ASC
      ON CONFLICT(name) DO UPDATE SET identity=excluded.identity;
    PRAGMA user_version = 6;
  ` },
  { version: 7, sql: `
    CREATE TABLE IF NOT EXISTS job_delivery_routes (
      id TEXT PRIMARY KEY, recipient TEXT NOT NULL, consumed_at INTEGER
    );
    PRAGMA user_version = 7;
  ` },
  { version: 8, sql: CONVERSATION_MIGRATION },
  { version: 9, backupTables: ["peer_names"], sql: `
    CREATE TABLE IF NOT EXISTS peer_last_seen (
      name TEXT PRIMARY KEY, seen_at INTEGER NOT NULL
    );
    INSERT INTO peer_last_seen SELECT name, MAX(learned_at) FROM peer_names GROUP BY name;
    PRAGMA user_version = 9;
  ` }
];
function migrateMessageSchema(db, file, existed, log) {
  migrateSqlite(db, file, existed, SQLITE_STORE_VERSION, MIGRATIONS, log);
}
function registrationIdentity(peer) {
  if (peer.jobAgent || !Number.isSafeInteger(peer.agentPid) || !peer.agentPid || peer.agentPid <= 0 || !peer.agentStartedAt) return null;
  let cwd = resolve(peer.cwd);
  try {
    cwd = realpathSync.native(cwd);
  } catch {
  }
  if (process.platform === "win32") cwd = cwd.toLowerCase();
  return JSON.stringify([peer.agent, peer.agentPid, peer.agentStartedAt, cwd, peer.name.replace(/-\d+$/, "")]);
}
function toMessage(r) {
  return {
    id: r.id,
    recipient: r.recipient,
    from: { id: r.from_id, name: r.from_name, agent: r.from_agent },
    to: r.to_target,
    conversationId: r.conversation_id,
    replyTo: r.reply_to,
    hop: r.hop,
    body: r.body,
    createdAt: r.created_at,
    readAt: r.read_at
  };
}
var MessageStore = class {
  constructor(file, log) {
    this.log = log;
    this.file = file;
    const existed = file !== ":memory:" && existsSync3(file);
    this.home = file === ":memory:" ? null : dirname3(file);
    if (file !== ":memory:") mkdirSync2(dirname3(file), { recursive: true, mode: 448 });
    this.release = file === ":memory:" ? () => {
    } : storageLease(dirname3(file));
    try {
      this.db = new DatabaseSync2(file);
    } catch (err) {
      this.release();
      throw err;
    }
    try {
      let deferred = false;
      try {
        migrateMessageSchema(this.db, file, existed, log);
      } catch (error) {
        const version = Number(this.db.prepare("PRAGMA user_version").get().user_version);
        if (error.code !== "STORE_UPGRADE_DEFERRED" || version < 4) throw error;
        deferred = true;
        log.info("hosting broker on compatible existing schema while upgrade waits for retained readers", { file, version, target: SQLITE_STORE_VERSION });
      }
      if (file !== ":memory:") attachStoreCompatibility(this.db, file, log, deferred);
      configureSqlite(this.db);
    } catch (err) {
      this.db.close();
      this.release();
      throw err;
    }
    try {
      this.archiveDb = openArchive(archiveDbPath(file));
    } catch (err) {
      this.db.close();
      this.release();
      throw err;
    }
    this.decisions = new DecisionStore(this.db);
    this.historyFile = historyDbPath(file);
    let historyDb;
    try {
      this.historyDb = historyDb = file === ":memory:" ? this.db : openHistoryStore(this.historyFile);
      this.history = new HistoryIndex(
        this.historyDb,
        this.home,
        void 0,
        this.db,
        file === ":memory:" ? void 0 : (peer) => this.historyPeerSink?.(peer)
      );
    } catch (err) {
      if (historyDb && historyDb !== this.db) historyDb.close();
      this.archiveDb.close();
      this.db.close();
      this.release();
      throw err;
    }
    this.stmt = {
      insert: this.db.prepare(
        `INSERT INTO messages (id, recipient, from_id, from_name, from_agent, to_target, conversation_id, reply_to, hop, body, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      ),
      unread: this.db.prepare(
        `SELECT * FROM messages WHERE recipient = ? AND read_at IS NULL
         ORDER BY CASE WHEN (conversation_id LIKE '%:note' OR conversation_id LIKE '%:ack' OR conversation_id LIKE 'files-progress-%') THEN 1 ELSE 0 END,
                  created_at ASC, id ASC LIMIT ?`
      ),
      markRead: this.db.prepare(`UPDATE messages SET read_at = ? WHERE id = ? AND recipient = ? AND read_at IS NULL`),
      claim: this.db.prepare(`UPDATE OR IGNORE messages SET recipient = ? WHERE recipient = ? AND read_at IS NULL`),
      byId: this.db.prepare(`SELECT * FROM messages WHERE id = ? ORDER BY created_at ASC LIMIT 1`),
      replyConflicts: this.db.prepare(`SELECT id, from_name, conversation_id FROM messages WHERE recipient = ? AND read_at IS NULL
        AND (conversation_id = ? OR from_name IN (SELECT value FROM json_each(?)))
        AND (? IS NULL OR created_at >= ?) AND id != ?
        AND conversation_id NOT LIKE '%:note' AND conversation_id NOT LIKE '%:ack'
        AND conversation_id NOT LIKE 'files-progress-%' ORDER BY created_at, id LIMIT 50`)
    };
    log.debug("message store opened", { file });
  }
  log;
  db;
  archiveDb;
  historyDb;
  release;
  home;
  writeAbort = new AbortController();
  backups = null;
  archiveTimer = null;
  legacyArchivePending = true;
  purgeCutoff = null;
  purgeCursor = null;
  purgeHighWater = null;
  nextPurgeCutoff = null;
  archiveMaintenanceFailed = false;
  closed = false;
  decisions;
  history;
  historyFile;
  historyPeerSink;
  /** Told about every stored or claimed message, so a backed-off history worker indexes it promptly. */
  historyMessageSink;
  file;
  stmt;
  startBackups() {
    this.scheduleArchiveMaintenance();
    if (process.env.AGENT_BRIDGE_AUTO_BACKUP === "1" && this.home && !this.backups) this.backups = new BackupBackground(this.home, this.log);
  }
  backupPressure(pending, lockError = false) {
    this.backups?.pressure(pending, lockError);
  }
  backupStatus() {
    return this.backups?.status() ?? null;
  }
  async closeBackups() {
    await this.backups?.close();
    this.backups = null;
  }
  /** Append identities learned from hooks; previous session bindings remain retained. */
  rememberSession(peer, at) {
    const identity = registrationIdentity(peer);
    if (!identity || !peer.sessionId) return;
    this.db.prepare(`INSERT INTO session_bindings VALUES (?,?,?) ON CONFLICT(identity,session_id)
      DO UPDATE SET learned_at=excluded.learned_at`).run(identity, peer.sessionId, at);
  }
  recoverSession(peer) {
    const identity = registrationIdentity(peer);
    if (!identity) return null;
    const row = this.db.prepare("SELECT session_id FROM session_bindings WHERE identity=? ORDER BY learned_at DESC, rowid DESC LIMIT 1").get(identity);
    return row ? String(row.session_id) : null;
  }
  /** Retain names only with CLI or hook identity; a similar spelling is never an alias. */
  rememberName(peer, at) {
    const identity = registrationIdentity(peer) ?? (!peer.jobAgent && peer.sessionId ? JSON.stringify(["session", peer.agent, peer.sessionId]) : null);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (identity) this.db.prepare(`INSERT INTO peer_names VALUES (?,?,?,?,?) ON CONFLICT(identity,name)
        DO UPDATE SET session_id=COALESCE(excluded.session_id,peer_names.session_id), learned_at=MIN(peer_names.learned_at,excluded.learned_at)`).run(identity, peer.name, peer.sessionId, peer.agent, at);
      this.db.prepare(`INSERT INTO peer_name_owners VALUES (?,?) ON CONFLICT(name)
        DO UPDATE SET identity=excluded.identity`).run(peer.name, identity ?? `unidentified:${peer.id}`);
      if (!peer.jobAgent && !peer.subagent) this.markPeerSeen(peer.name, at);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  /** Presence updates never change the identity that currently owns a name. */
  markPeerSeen(name, at) {
    this.db.prepare(`INSERT INTO peer_last_seen VALUES (?,?)
      ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)`).run(name, at);
  }
  namesFor(peer) {
    const identity = registrationIdentity(peer);
    if (peer.jobAgent || !identity && !peer.sessionId) return [];
    return this.db.prepare(`SELECT name FROM peer_names JOIN peer_name_owners USING(name,identity)
      WHERE identity=? OR (session_id=? AND agent=?) GROUP BY name ORDER BY MIN(learned_at) ASC, MIN(peer_names.rowid) ASC`).all(identity, peer.sessionId, peer.agent).map((r) => String(r.name));
  }
  /** Retained registrations include offline sessions, but never worker runners or agent queue keys. */
  broadcastNames() {
    const sessions = this.history.database.prepare("SELECT session FROM history_sessions WHERE alias=?");
    const files = this.history.database.prepare("SELECT DISTINCT cwd FROM history_files WHERE session=? AND cwd<>''");
    return this.db.prepare(`SELECT name,identity FROM peer_name_owners
      WHERE identity NOT LIKE 'unidentified:job:%' ORDER BY name`).all().filter((row) => {
      const identity = String(row.identity);
      let session;
      try {
        const parts = JSON.parse(identity);
        if (Array.isArray(parts)) {
          if (parts[0] === "session" && typeof parts[2] === "string") session = parts[2];
          else if (typeof parts[1] === "number" && typeof parts[3] === "string") return !isPluginCacheCwd(parts[3]);
        }
      } catch {
      }
      session ??= String(sessions.get(identity.startsWith("unidentified:") ? identity.slice(13) : String(row.name))?.session ?? "") || void 0;
      const cwds = session ? files.all(session).map((file) => String(file.cwd)) : [];
      return !cwds.length || cwds.some((cwd) => !isPluginCacheCwd(cwd));
    }).map((row) => String(row.name));
  }
  /** Eligibility never removes history or old queued messages. Unknown old names are skipped. */
  recentProjectSenders(address, previous, since) {
    return this.db.prepare(`SELECT from_name FROM messages WHERE to_target=? AND recipient=? AND created_at>=?
      AND from_id NOT LIKE 'job:%' GROUP BY from_name ORDER BY MAX(created_at) DESC LIMIT 64`).all(address, previous, since).map((row) => String(row.from_name));
  }
  broadcastRecipients(now, masters) {
    const seen = this.db.prepare("SELECT seen_at FROM peer_last_seen WHERE name=?");
    const queued = [], skipped = [];
    for (const name of this.broadcastNames()) {
      const at = Number(seen.get(name)?.seen_at ?? 0);
      (masters.has(name) || at > 0 && at >= now - BROADCAST_RECENT_MS ? queued : skipped).push(name);
    }
    for (const name of masters) if (!queued.includes(name) && !skipped.includes(name)) queued.push(name);
    return { queued, skipped };
  }
  /** Keep lock waits out of the broker event loop. Callbacks must be synchronous atomic steps. */
  retryWrite(operation) {
    return retrySqlite(() => {
      this.db.exec(`PRAGMA busy_timeout = ${SQLITE_REQUEST_BUSY_MS}`);
      try {
        return operation();
      } finally {
        this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      }
    }, Infinity, this.writeAbort.signal);
  }
  insert(m) {
    this.stmt.insert.run(
      m.id,
      m.recipient,
      m.from.id,
      m.from.name,
      m.from.agent,
      m.to,
      m.conversationId,
      m.replyTo,
      m.hop,
      m.body,
      m.createdAt
    );
    this.historyMessageSink?.();
  }
  unread(recipient, limit) {
    return this.stmt.unread.all(recipient, limit).map(toMessage);
  }
  /** A guarded fan-out is one transaction; lock retries cannot leave half a send persisted. */
  insertBatch(messages, before = () => {
  }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      before();
      for (const message of messages) this.insert(message);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  /** Query the whole inbox before a reply, independent of the hook batch limit. */
  replyConflicts(recipient, from, conversationId, anchor) {
    const rows = this.stmt.replyConflicts.all(recipient, conversationId, JSON.stringify(from), anchor?.id ?? null, anchor?.createdAt ?? 0, anchor?.id ?? "");
    return rows.map((row) => ({ id: String(row.id), from: { name: String(row.from_name) }, conversationId: String(row.conversation_id) }));
  }
  /** Copy pending job mail to its new supervisor, retaining the old row as history. Replay is idempotent. */
  handoffMail(from, to, job, at, fallback = false) {
    if (from === to) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare("SELECT * FROM messages WHERE recipient=? AND from_id=? AND read_at IS NULL AND conversation_id NOT LIKE ?").all(from, `job:${job}`, `${SIBLING_CONVERSATION_PREFIX}%`);
      const copied = [];
      for (const row of rows) {
        const route = this.db.prepare("SELECT recipient, consumed_at FROM job_delivery_routes WHERE id=?").get(row.id);
        if (route && (route.consumed_at !== null || route.recipient !== from)) continue;
        const m = { ...toMessage(row), recipient: to, to, readAt: null };
        if (fallback && !isQuietMessage(m)) m.conversationId = m.conversationId.replace(/:note$/, "") + (m.conversationId.endsWith(":fallback") ? "" : ":fallback");
        const existing = this.db.prepare("SELECT read_at FROM messages WHERE id=? AND recipient=?").get(m.id, to);
        if (!existing) this.insert(m);
        else this.db.prepare("UPDATE messages SET read_at=NULL, to_target=?, conversation_id=? WHERE id=? AND recipient=?").run(to, m.conversationId, m.id, to);
        copied.push(m);
        this.db.prepare("INSERT INTO job_delivery_routes(id,recipient,consumed_at) VALUES (?,?,NULL) ON CONFLICT(id) DO UPDATE SET recipient=excluded.recipient").run(m.id, to);
        this.stmt.markRead.run(at, m.id, from);
      }
      this.db.exec("COMMIT");
      return copied;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  pendingJobRecipients(job) {
    return this.db.prepare("SELECT DISTINCT recipient FROM messages WHERE from_id=? AND read_at IS NULL AND conversation_id NOT LIKE ?").all(`job:${job}`, `${SIBLING_CONVERSATION_PREFIX}%`).map((row) => String(row.recipient));
  }
  pendingJobSenders() {
    return new Set(this.db.prepare("SELECT DISTINCT from_id FROM messages WHERE read_at IS NULL AND from_id LIKE 'job:%' AND conversation_id NOT LIKE ?").all(`${SIBLING_CONVERSATION_PREFIX}%`).map((row) => String(row.from_id)));
  }
  insertOnce(m) {
    if (this.db.prepare("SELECT 1 FROM messages WHERE id=? AND recipient=?").get(m.id, m.recipient)) return false;
    this.insert(m);
    return true;
  }
  /** A recovered inline envelope must never replay after a recipient consumed it or it was forwarded. */
  insertJobDelivery(m) {
    if (this.db.prepare("SELECT 1 FROM job_delivery_routes WHERE id=?").get(m.id)) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.insertOnce(m);
      const row = this.db.prepare("SELECT read_at FROM messages WHERE id=? AND recipient=?").get(m.id, m.recipient);
      this.db.prepare("INSERT INTO job_delivery_routes(id,recipient,consumed_at) VALUES (?,?,?)").run(m.id, m.recipient, row?.read_at ?? null);
      this.db.exec("COMMIT");
      return inserted;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  markRead(recipient, ids, at = Date.now()) {
    let changed = 0;
    const route = this.db.prepare("UPDATE job_delivery_routes SET consumed_at=? WHERE id=? AND recipient=? AND consumed_at IS NULL");
    for (let offset = 0; offset < ids.length; offset += 100) {
      this.db.exec("SAVEPOINT message_ack");
      try {
        for (const id of ids.slice(offset, offset + 100)) {
          changed += Number(this.stmt.markRead.run(at, id, recipient).changes);
          route.run(at, id, recipient);
        }
        this.db.exec("RELEASE message_ack");
      } catch (err) {
        cleanupSavepoint(this.db, "message_ack", true, err);
      }
    }
    return changed;
  }
  /** Move messages waiting for "any <agent>" to a concrete peer name. */
  claim(fromKey, toName) {
    if (fromKey === toName) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const moved = Number(this.stmt.claim.run(toName, fromKey).changes);
      const duplicates = Number(this.db.prepare(`UPDATE messages SET read_at = ?
        WHERE recipient = ? AND read_at IS NULL AND id IN (SELECT id FROM messages WHERE recipient = ?)`).run(Date.now(), fromKey, toName).changes);
      this.db.exec("COMMIT");
      if (moved) this.historyMessageSink?.();
      return moved + duplicates;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  /** Archive unread mail waiting for a queue key or name that is older than the cutoff. */
  expireQueued(recipient, cutoff) {
    if (!this.db.prepare("SELECT 1 FROM messages WHERE recipient = ? AND read_at IS NULL AND created_at < ? LIMIT 1").get(recipient, cutoff)) return 0;
    const n = archiveMessages(this.db, this.archiveDb, "recipient = ? AND read_at IS NULL AND created_at < ?", [recipient, cutoff], "stale queue");
    if (n > 0) this.log.info("archived stale queued messages", { recipient, count: n });
    return n;
  }
  /** Finish TTL archival before a broker claims/replays a reused queue name. */
  async expireQueuedAsync(recipient, cutoff) {
    let count = 0;
    for (; ; ) {
      const result = await this.retryWrite(() => {
        this.archiveDb.exec(`PRAGMA busy_timeout = ${SQLITE_REQUEST_BUSY_MS}`);
        try {
          const moved = this.archiveChunk("messages", "recipient = ? AND read_at IS NULL AND created_at < ?", [recipient, cutoff], "stale queue");
          const remaining = Boolean(this.db.prepare("SELECT 1 FROM messages WHERE recipient = ? AND read_at IS NULL AND created_at < ? LIMIT 1").get(recipient, cutoff));
          return { moved, remaining };
        } finally {
          this.archiveDb.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
        }
      });
      count += result.moved;
      if (!result.remaining) break;
      await delay(50, void 0, { signal: this.writeAbort.signal });
    }
    if (count) this.log.info("archived stale queued messages", { recipient, count });
    return count;
  }
  receipts(id) {
    const merged = /* @__PURE__ */ new Map();
    for (const [db, table] of [[this.archiveDb, "messages"], [this.db, "archived_messages"], [this.db, "messages"]]) {
      const rows = db.prepare(`SELECT recipient, read_at AS readAt FROM ${table} WHERE id = ?`).all(id);
      for (const row of rows) merged.set(row.recipient, row);
    }
    return [...merged.values()];
  }
  byId(id) {
    const row = this.stmt.byId.get(id) ?? this.archiveDb.prepare("SELECT * FROM messages WHERE id = ? LIMIT 1").get(id) ?? this.db.prepare("SELECT * FROM archived_messages WHERE id = ? LIMIT 1").get(id);
    return row ? toMessage(row) : null;
  }
  /** Retained recipient copies for a durable retry; active rows take precedence. */
  messagesById(id) {
    const merged = /* @__PURE__ */ new Map();
    for (const [db, table] of [[this.archiveDb, "messages"], [this.db, "archived_messages"], [this.db, "messages"]]) {
      for (const row of db.prepare(`SELECT * FROM ${table} WHERE id = ? ORDER BY rowid`).all(id)) {
        const message = toMessage(row);
        merged.set(message.recipient, message);
      }
    }
    return [...merged.values()];
  }
  purgeOlderThan(cutoff) {
    if (!this.db.prepare("SELECT 1 FROM messages WHERE created_at < ? LIMIT 1").get(cutoff)) return 0;
    const n = archiveMessages(this.db, this.archiveDb, "created_at < ?", [cutoff], "expired");
    if (n > 0) this.log.info("archived expired messages", { count: n });
    return n;
  }
  /** Broker retention queues bounded work; direct/offline purge remains synchronous. */
  schedulePurgeOlderThan(cutoff) {
    if (this.purgeCutoff === null) this.purgeCutoff = cutoff;
    else if (cutoff > this.purgeCutoff) this.nextPurgeCutoff = Math.max(this.nextPurgeCutoff ?? cutoff, cutoff);
    this.scheduleArchiveMaintenance();
  }
  scheduleArchiveMaintenance(delayMs = 50) {
    if (this.closed || this.archiveMaintenanceFailed || this.archiveTimer) return;
    this.archiveTimer = setTimeout(() => {
      this.archiveTimer = null;
      if (this.closed) return;
      let more = false;
      let retryDelay = 50;
      try {
        this.db.exec(`PRAGMA busy_timeout = ${SQLITE_REQUEST_BUSY_MS}`);
        this.archiveDb.exec(`PRAGMA busy_timeout = ${SQLITE_REQUEST_BUSY_MS}`);
        if (this.legacyArchivePending) {
          this.legacyArchivePending = this.archiveChunk("archived_messages", "1", [], "legacy") > 0;
          more = this.legacyArchivePending;
        } else if (this.purgeCutoff !== null) {
          more = this.archivePurgeChunk(this.purgeCutoff);
          if (!more) {
            this.purgeCutoff = this.nextPurgeCutoff;
            this.nextPurgeCutoff = null;
            this.purgeCursor = this.purgeHighWater = null;
          }
        }
        more ||= this.purgeCutoff !== null;
      } catch (error) {
        if (isSqliteBusy(error)) {
          more = true;
          retryDelay = 250;
        } else {
          this.archiveMaintenanceFailed = true;
          this.log.warn("message archive maintenance stopped; original rows preserved", { err: String(error) });
        }
      } finally {
        this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
        this.archiveDb.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      }
      if (more) this.scheduleArchiveMaintenance(retryDelay);
    }, delayMs);
    this.archiveTimer.unref();
  }
  archiveChunk(table, where, args, reason) {
    const rows = this.db.prepare(`SELECT rowid AS id, octet_length(body) AS bytes FROM ${table} WHERE ${where} ORDER BY ${table === "messages" ? "created_at" : "rowid"} LIMIT 16`).all(...args);
    const ids = [];
    let bytes = 0;
    for (const row of rows) {
      if (ids.length && bytes + Number(row.bytes) > 256 * 1024) break;
      ids.push(String(row.id));
      bytes += Number(row.bytes);
    }
    if (!ids.length) return 0;
    return archiveMessages(this.db, this.archiveDb, `rowid IN (${ids.map(() => "?").join(",")}) AND (${where})`, [...ids, ...args], reason, table);
  }
  archivePurgeChunk(cutoff) {
    if (this.purgeHighWater === null) {
      const high = this.db.prepare("SELECT MAX(rowid) AS id FROM messages");
      high.setReadBigInts(true);
      const id = high.get().id;
      if (id === null) return false;
      this.purgeHighWater = String(id);
    }
    const select = this.db.prepare(`SELECT rowid AS id, created_at AS at, octet_length(body) AS bytes FROM messages WHERE ${this.purgeCursor === null ? "" : "rowid > ? AND "}rowid <= ? ORDER BY rowid LIMIT 16`);
    select.setReadBigInts(true);
    const rows = select.all(...this.purgeCursor === null ? [this.purgeHighWater] : [this.purgeCursor, this.purgeHighWater]);
    const ids = [];
    let bytes = 0;
    let next = this.purgeCursor;
    for (const row of rows) {
      if (Number(row.at) < cutoff) {
        if (ids.length && bytes + Number(row.bytes) > 256 * 1024) break;
        ids.push(String(row.id));
        bytes += Number(row.bytes);
      }
      next = String(row.id);
    }
    if (ids.length) archiveMessages(this.db, this.archiveDb, `rowid IN (${ids.map(() => "?").join(",")}) AND created_at < ?`, [...ids, cutoff], "expired");
    this.purgeCursor = next;
    return rows.length > 0;
  }
  stopWrites() {
    this.writeAbort.abort();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.archiveTimer) clearTimeout(this.archiveTimer);
    this.archiveTimer = null;
    this.stopWrites();
    this.history.close();
    if (this.historyDb !== this.db) this.historyDb.close();
    void this.closeBackups();
    try {
      this.db.close();
      this.archiveDb.close();
    } catch (err) {
      this.log.warn("error closing message store", { err });
    } finally {
      this.release();
    }
  }
};

export {
  BROADCAST_RECENT_MS,
  agentQueueKey,
  migrateMessageSchema,
  registrationIdentity,
  MessageStore
};
