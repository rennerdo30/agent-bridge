import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  DECISIONS_SCHEMA,
  DecisionStore
} from "./chunk-IVSM3443.mjs";
import {
  SQLITE_STORE_VERSION
} from "./chunk-RQUYBZWF.mjs";
import {
  SIBLING_CONVERSATION_PREFIX,
  isQuietMessage
} from "./chunk-SOPZATYP.mjs";
import {
  CONVERSATION_MIGRATION,
  historySchema
} from "./chunk-CV444Y3C.mjs";
import {
  HistoryIndex
} from "./chunk-BMYN33JS.mjs";
import {
  ARCHIVE_DB_NAME,
  archiveDbPath,
  archiveMessages,
  migrateSqlite,
  openArchive,
  snapshotDatabase
} from "./chunk-JSAVG5BJ.mjs";
import {
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_REQUEST_BUSY_MS,
  configureSqlite,
  retrySqlite
} from "./chunk-AGX4O262.mjs";
import {
  isPluginCacheCwd
} from "./chunk-VNX2WF5E.mjs";
import {
  isRecord,
  maintenanceLock,
  retentionLimit,
  storageLease
} from "./chunk-TPCM6ZR4.mjs";
import {
  DB_FILE_NAME
} from "./chunk-6PRX5EOQ.mjs";

// src/core/store.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, realpathSync } from "node:fs";
import { dirname as dirname2, resolve as resolve2 } from "node:path";
import { DatabaseSync } from "node:sqlite";

// src/core/backups.ts
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
var BACKUPS_DIR_NAME = "backups";
var BACKUP_MANIFEST_VERSION = 1;
var DEFAULT_BACKUP_RETENTION = 7;
var DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1e3;
var BACKUP_RETENTION_ENV = "AGENT_BRIDGE_BACKUP_RETENTION";
var BACKUP_INTERVAL_ENV = "AGENT_BRIDGE_BACKUP_INTERVAL_MS";
var MANIFEST_NAME = "manifest.json";
var BACKUP_PREFIX = "snapshot-";
function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
  const capture = (source, sqlite) => {
    const path = relative(home, source).split(sep).join("/");
    const target = join(staging, path);
    mkdirSync(dirname(target), { recursive: true, mode: 448 });
    if (sqlite) snapshotDatabase(source, target);
    else copyFileSync(source, target);
    syncFile(target);
    const raw = readFileSync(target);
    manifest.files.push({ path, sha256: createHash("sha256").update(raw).digest("hex"), bytes: raw.length });
  };
  for (const name2 of [DB_FILE_NAME, ARCHIVE_DB_NAME]) if (existsSync(join(home, name2))) capture(join(home, name2), true);
  for (const file of jsonStoreFiles(home)) capture(file, false);
  writeFileSync(join(staging, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", { mode: 384 });
  syncFile(join(staging, MANIFEST_NAME));
  const published = join(root, name);
  renameSync(staging, published);
  if (rotate) {
    const retention = retentionLimit(BACKUP_RETENTION_ENV, DEFAULT_BACKUP_RETENTION);
    if (retention) for (const backup of listBackups(home).slice(retention)) {
      const cold = join(root, "archive");
      mkdirSync(cold, { recursive: true, mode: 448 });
      renameSync(backup.path, join(cold, backup.path.split(/[\\/]/).at(-1)));
    }
  }
  return published;
}
function backupIfDue(home, now = Date.now()) {
  const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
  if (!interval || now - (listBackups(home)[0]?.createdAt ?? 0) < interval) return null;
  return createBackup(home, now);
}
function allowedPath(path) {
  return path === DB_FILE_NAME || path === ARCHIVE_DB_NAME || /^[\w.-]+\.json$/.test(path) && !["dashboard.json"].includes(path) || /^(jobs|runs|archive|read-state|job-outcomes|local-result-receipts)\/[\w./-]+$/.test(path) && !path.split("/").some((s) => s === ".." || s === ".") && /\.jsonl?(?:-\d+-[\w-]+)?$/.test(path);
}
function createRecovery(home) {
  const root = join(home, BACKUPS_DIR_NAME, `recovery-${Date.now()}-${randomUUID()}`);
  mkdirSync(root, { recursive: true, mode: 448 });
  const files = jsonStoreFiles(home);
  for (const name of [DB_FILE_NAME, ARCHIVE_DB_NAME]) for (const suffix of ["", "-wal", "-shm", "-journal"]) {
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
  if (!isRecord(value) || value.version !== BACKUP_MANIFEST_VERSION || !Number.isFinite(value.createdAt) || !Array.isArray(value.files)) throw new Error("unsupported backup manifest");
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
function restoreBackup(home, backup, confirmed) {
  if (!confirmed) throw new Error("restore requires confirmation");
  const manifest = readBackup(backup);
  const unlock = maintenanceLock(home);
  try {
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
        copyFileSync(join(backup, file.path), tmp);
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

// src/core/store.ts
var BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1e3;
var BROADCAST_RECENT_MS = 24 * 60 * 60 * 1e3;
function agentQueueKey(agent) {
  return `agent:${agent}`;
}
var SCHEMA = `
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
  { version: 1, sql: `${SCHEMA} PRAGMA user_version = 1;` },
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
  { version: 9, sql: `
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
  let cwd = resolve2(peer.cwd);
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
    const existed = file !== ":memory:" && existsSync2(file);
    this.home = file === ":memory:" ? null : dirname2(file);
    if (file !== ":memory:") mkdirSync2(dirname2(file), { recursive: true, mode: 448 });
    this.release = file === ":memory:" ? () => {
    } : storageLease(dirname2(file));
    try {
      this.db = new DatabaseSync(file);
    } catch (err) {
      this.release();
      throw err;
    }
    try {
      migrateMessageSchema(this.db, file, existed, log);
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
    try {
      archiveMessages(this.db, this.archiveDb, "1", [], "legacy", "archived_messages");
    } catch (err) {
      this.archiveDb.close();
      this.db.close();
      this.release();
      throw err;
    }
    this.decisions = new DecisionStore(this.db);
    this.history = new HistoryIndex(this.db, this.home);
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
      byId: this.db.prepare(`SELECT * FROM messages WHERE id = ? ORDER BY created_at ASC LIMIT 1`)
    };
    log.debug("message store opened", { file });
    if (file !== ":memory:") {
      try {
        backupIfDue(dirname2(file));
      } catch (err) {
        log.warn("automatic backup failed", { err: String(err) });
      }
      const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
      if (interval) {
        this.backupTimer = setInterval(() => {
          try {
            backupIfDue(dirname2(file));
          } catch (err) {
            log.warn("automatic backup failed", { err: String(err) });
          }
        }, Math.min(interval, BACKUP_CHECK_INTERVAL_MS));
        this.backupTimer.unref();
      }
    }
  }
  log;
  db;
  archiveDb;
  release;
  home;
  backupTimer = null;
  decisions;
  history;
  file;
  stmt;
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
      if (!peer.jobAgent && !peer.subagent) this.db.prepare(`INSERT INTO peer_last_seen VALUES (?,?)
        ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)`).run(peer.name, at);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  namesFor(peer) {
    const identity = registrationIdentity(peer);
    if (peer.jobAgent || !identity && !peer.sessionId) return [];
    return this.db.prepare(`SELECT name FROM peer_names JOIN peer_name_owners USING(name,identity)
      WHERE identity=? OR (session_id=? AND agent=?) GROUP BY name ORDER BY MIN(learned_at) ASC, MIN(peer_names.rowid) ASC`).all(identity, peer.sessionId, peer.agent).map((r) => String(r.name));
  }
  /** Retained registrations include offline sessions, but never worker runners or agent queue keys. */
  broadcastNames() {
    const sessions = this.db.prepare("SELECT session FROM history_sessions WHERE alias=?");
    const files = this.db.prepare("SELECT DISTINCT cwd FROM history_files WHERE session=? AND cwd<>''");
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
    });
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
  }
  unread(recipient, limit) {
    return this.stmt.unread.all(recipient, limit).map(toMessage);
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
    for (const id of ids) {
      changed += Number(this.stmt.markRead.run(at, id, recipient).changes);
      this.db.prepare("UPDATE job_delivery_routes SET consumed_at=? WHERE id=? AND recipient=? AND consumed_at IS NULL").run(at, id, recipient);
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
      return moved + duplicates;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  /** Archive unread mail waiting for a queue key or name that is older than the cutoff. */
  expireQueued(recipient, cutoff) {
    const n = archiveMessages(this.db, this.archiveDb, "recipient = ? AND read_at IS NULL AND created_at < ?", [recipient, cutoff], "stale queue");
    if (n > 0) this.log.info("archived stale queued messages", { recipient, count: n });
    return n;
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
  purgeOlderThan(cutoff) {
    const n = archiveMessages(this.db, this.archiveDb, "created_at < ?", [cutoff], "expired");
    if (n > 0) this.log.info("archived expired messages", { count: n });
    if (this.home) {
      try {
        backupIfDue(this.home);
      } catch (err) {
        this.log.warn("automatic backup failed", { err: String(err) });
      }
    }
    return n;
  }
  close() {
    this.history.close();
    if (this.backupTimer) clearInterval(this.backupTimer);
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
  jsonStoreFiles,
  listBackups,
  createBackup,
  readBackup,
  restoreBackup,
  BROADCAST_RECENT_MS,
  agentQueueKey,
  migrateMessageSchema,
  registrationIdentity,
  MessageStore
};
