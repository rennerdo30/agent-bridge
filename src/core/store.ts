import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Logger } from "./logger.js";
import { isQuietMessage, SIBLING_CONVERSATION_PREFIX, type AgentKind, type BridgeMessage, type PeerInfo } from "./protocol.js";
import { migrateSqlite } from "./sqlite-migrations.js";
import { archiveDbPath, archiveMessages, openArchive } from "./sqlite-maintenance.js";
import { storageLease } from "./storage-lock.js";
import { backupIfDue, BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS } from "./backups.js";
import { retentionLimit } from "./json-store.js";
import { historySchema } from "./history-schema.js";
import { CONVERSATION_MIGRATION } from "./conversation-schema.js";
import { HistoryIndex } from "./history.js";
import { isPluginCacheCwd } from "./session-visibility.js";
import { DECISIONS_SCHEMA, DecisionStore } from "./decisions.js";
import { configureSqlite, retrySqlite, SQLITE_BUSY_TIMEOUT_MS, SQLITE_REQUEST_BUSY_MS } from "./sqlite-policy.js";

const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

export const SQLITE_STORE_VERSION = 9;

/** Offline broadcasts retain recently observed sessions for one day. */
export const BROADCAST_RECENT_MS = 24 * 60 * 60 * 1_000;

/** Recipient key used while a message waits for "any peer of this agent kind". */
export function agentQueueKey(agent: AgentKind): string {
  return `agent:${agent}`;
}

const SCHEMA = `
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

const MIGRATIONS = [
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
  ` },
] as const;

/** Upgrade only the schema, without broker startup, archive movement or retention. */
export function migrateMessageSchema(db: DatabaseSync, file: string, existed: boolean, log: Logger): void {
  migrateSqlite(db, file, existed, SQLITE_STORE_VERSION, MIGRATIONS, log);
}

export function registrationIdentity(peer: PeerInfo): string | null {
  if (peer.jobAgent || !Number.isSafeInteger(peer.agentPid) || !peer.agentPid || peer.agentPid <= 0 || !peer.agentStartedAt) return null;
  let cwd = resolve(peer.cwd);
  try { cwd = realpathSync.native(cwd); } catch { /* A removed working folder still has a stable absolute spelling. */ }
  if (process.platform === "win32") cwd = cwd.toLowerCase();
  return JSON.stringify([peer.agent, peer.agentPid, peer.agentStartedAt, cwd, peer.name.replace(/-\d+$/, "")]);
}

interface Row {
  id: string;
  recipient: string;
  from_id: string;
  from_name: string;
  from_agent: string;
  to_target: string;
  conversation_id: string;
  reply_to: string | null;
  hop: number;
  body: string;
  created_at: number;
  read_at: number | null;
}

function toMessage(r: Row): BridgeMessage {
  return {
    id: r.id,
    recipient: r.recipient,
    from: { id: r.from_id, name: r.from_name, agent: r.from_agent as AgentKind },
    to: r.to_target,
    conversationId: r.conversation_id,
    replyTo: r.reply_to,
    hop: r.hop,
    body: r.body,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

/**
 * Durable message store. Only the broker process opens it, so there is a single writer at a time.
 * All statements are prepared once and bound with parameters.
 */
export class MessageStore {
  private readonly db: DatabaseSync;
  private readonly archiveDb: DatabaseSync;
  private readonly release: () => void;
  private readonly home: string | null;
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  readonly decisions: DecisionStore;
  readonly history: HistoryIndex;
  readonly file: string;
  private readonly stmt: {
    insert: StatementSync;
    unread: StatementSync;
    markRead: StatementSync;
    claim: StatementSync;
    byId: StatementSync;
  };

  constructor(
    file: string,
    private readonly log: Logger,
  ) {
    this.file = file;
    const existed = file !== ":memory:" && existsSync(file);
    this.home = file === ":memory:" ? null : dirname(file);
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); // owner-only on Unix
    this.release = file === ":memory:" ? () => {} : storageLease(dirname(file));
    try { this.db = new DatabaseSync(file); }
    catch (err) { this.release(); throw err; }
    try {
      migrateMessageSchema(this.db, file, existed, log);
      configureSqlite(this.db);
    } catch (err) {
      this.db.close();
      this.release();
      throw err;
    }
    try { this.archiveDb = openArchive(archiveDbPath(file)); }
    catch (err) { this.db.close(); this.release(); throw err; }
    try { archiveMessages(this.db, this.archiveDb, "1", [], "legacy", "archived_messages"); }
    catch (err) { this.archiveDb.close(); this.db.close(); this.release(); throw err; }
    this.decisions = new DecisionStore(this.db);
    this.history = new HistoryIndex(this.db, this.home);
    this.stmt = {
      insert: this.db.prepare(
        `INSERT INTO messages (id, recipient, from_id, from_name, from_agent, to_target, conversation_id, reply_to, hop, body, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ),
      unread: this.db.prepare(
        `SELECT * FROM messages WHERE recipient = ? AND read_at IS NULL
         ORDER BY CASE WHEN (conversation_id LIKE '%:note' OR conversation_id LIKE '%:ack' OR conversation_id LIKE 'files-progress-%') THEN 1 ELSE 0 END,
                  created_at ASC, id ASC LIMIT ?`,
      ),
      markRead: this.db.prepare(`UPDATE messages SET read_at = ? WHERE id = ? AND recipient = ? AND read_at IS NULL`),
      claim: this.db.prepare(`UPDATE OR IGNORE messages SET recipient = ? WHERE recipient = ? AND read_at IS NULL`),
      byId: this.db.prepare(`SELECT * FROM messages WHERE id = ? ORDER BY created_at ASC LIMIT 1`),
    };
    log.debug("message store opened", { file });
    if (file !== ":memory:") {
      try { backupIfDue(dirname(file)); }
      catch (err) { log.warn("automatic backup failed", { err: String(err) }); }
      const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
      if (interval) {
        this.backupTimer = setInterval(() => {
          try { backupIfDue(dirname(file)); }
          catch (err) { log.warn("automatic backup failed", { err: String(err) }); }
        }, Math.min(interval, BACKUP_CHECK_INTERVAL_MS));
        this.backupTimer.unref();
      }
    }
  }

  /** Append identities learned from hooks; previous session bindings remain retained. */
  rememberSession(peer: PeerInfo, at: number): void {
    const identity = registrationIdentity(peer);
    if (!identity || !peer.sessionId) return;
    this.db.prepare(`INSERT INTO session_bindings VALUES (?,?,?) ON CONFLICT(identity,session_id)
      DO UPDATE SET learned_at=excluded.learned_at`).run(identity, peer.sessionId, at);
  }

  recoverSession(peer: PeerInfo): string | null {
    const identity = registrationIdentity(peer);
    if (!identity) return null;
    const row = this.db.prepare("SELECT session_id FROM session_bindings WHERE identity=? ORDER BY learned_at DESC, rowid DESC LIMIT 1").get(identity);
    return row ? String(row.session_id) : null;
  }

  /** Retain names only with CLI or hook identity; a similar spelling is never an alias. */
  rememberName(peer: PeerInfo, at: number): void {
    const identity = registrationIdentity(peer) ?? (!peer.jobAgent && peer.sessionId ? JSON.stringify(["session", peer.agent, peer.sessionId]) : null);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (identity) this.db.prepare(`INSERT INTO peer_names VALUES (?,?,?,?,?) ON CONFLICT(identity,name)
        DO UPDATE SET session_id=COALESCE(excluded.session_id,peer_names.session_id), learned_at=MIN(peer_names.learned_at,excluded.learned_at)`)
        .run(identity, peer.name, peer.sessionId, peer.agent, at);
      // Even an older or unidentified server supersedes historical ownership of its exact name.
      this.db.prepare(`INSERT INTO peer_name_owners VALUES (?,?) ON CONFLICT(name)
        DO UPDATE SET identity=excluded.identity`).run(peer.name, identity ?? `unidentified:${peer.id}`);
      if (!peer.jobAgent && !peer.subagent) this.db.prepare(`INSERT INTO peer_last_seen VALUES (?,?)
        ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)`).run(peer.name, at);
      this.db.exec("COMMIT");
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }

  namesFor(peer: PeerInfo): string[] {
    const identity = registrationIdentity(peer);
    if (peer.jobAgent || (!identity && !peer.sessionId)) return [];
    return this.db.prepare(`SELECT name FROM peer_names JOIN peer_name_owners USING(name,identity)
      WHERE identity=? OR (session_id=? AND agent=?) GROUP BY name ORDER BY MIN(learned_at) ASC, MIN(peer_names.rowid) ASC`)
      .all(identity, peer.sessionId, peer.agent).map((r) => String(r.name));
  }

  /** Retained registrations include offline sessions, but never worker runners or agent queue keys. */
  broadcastNames(): string[] {
    const sessions = this.db.prepare("SELECT session FROM history_sessions WHERE alias=?");
    const files = this.db.prepare("SELECT DISTINCT cwd FROM history_files WHERE session=? AND cwd<>''");
    return this.db.prepare(`SELECT name,identity FROM peer_name_owners
      WHERE identity NOT LIKE 'unidentified:job:%' ORDER BY name`).all().filter((row) => {
        const identity = String(row.identity);
        let session: string | undefined;
        try {
          const parts: unknown = JSON.parse(identity);
          if (Array.isArray(parts)) {
            if (parts[0] === "session" && typeof parts[2] === "string") session = parts[2];
            else if (typeof parts[1] === "number" && typeof parts[3] === "string") return !isPluginCacheCwd(parts[3]);
          }
        } catch { /* Older unidentified registrations may still have indexed session metadata. */ }
        session ??= String(sessions.get(identity.startsWith("unidentified:") ? identity.slice(13) : String(row.name))?.session ?? "") || undefined;
        const cwds = session ? files.all(session).map((file) => String(file.cwd)) : [];
        // Historical rows remain untouched. Unknown paths and any real project path stay eligible.
        return !cwds.length || cwds.some((cwd) => !isPluginCacheCwd(cwd));
      }).map((row) => String(row.name));
  }

  /** Eligibility never removes history or old queued messages. Unknown old names are skipped. */
  broadcastRecipients(now: number, masters: ReadonlySet<string>): { queued: string[]; skipped: string[] } {
    const seen = this.db.prepare("SELECT seen_at FROM peer_last_seen WHERE name=?");
    const queued: string[] = [], skipped: string[] = [];
    for (const name of this.broadcastNames()) {
      const at = Number(seen.get(name)?.seen_at ?? 0);
      (masters.has(name) || at > 0 && at >= now - BROADCAST_RECENT_MS ? queued : skipped).push(name);
    }
    for (const name of masters) if (!queued.includes(name) && !skipped.includes(name)) queued.push(name);
    return { queued, skipped };
  }

  /** Keep lock waits out of the broker event loop. Callbacks must be synchronous atomic steps. */
  retryWrite<T>(operation: () => T): Promise<T> {
    return retrySqlite(() => {
      this.db.exec(`PRAGMA busy_timeout = ${SQLITE_REQUEST_BUSY_MS}`);
      try { return operation(); }
      finally { this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`); }
    });
  }

  insert(m: BridgeMessage): void {
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
      m.createdAt,
    );
  }

  unread(recipient: string, limit: number): BridgeMessage[] {
    return (this.stmt.unread.all(recipient, limit) as unknown as Row[]).map(toMessage);
  }

  /** Copy pending job mail to its new supervisor, retaining the old row as history. Replay is idempotent. */
  handoffMail(from: string, to: string, job: string, at: number, fallback = false): BridgeMessage[] {
    if (from === to) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare("SELECT * FROM messages WHERE recipient=? AND from_id=? AND read_at IS NULL AND conversation_id NOT LIKE ?").all(from, `job:${job}`, `${SIBLING_CONVERSATION_PREFIX}%`) as unknown as Row[];
      const copied: BridgeMessage[] = [];
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
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }

  pendingJobRecipients(job: string): string[] {
    return this.db.prepare("SELECT DISTINCT recipient FROM messages WHERE from_id=? AND read_at IS NULL AND conversation_id NOT LIKE ?").all(`job:${job}`, `${SIBLING_CONVERSATION_PREFIX}%`).map((row) => String(row.recipient));
  }

  pendingJobSenders(): Set<string> {
    return new Set(this.db.prepare("SELECT DISTINCT from_id FROM messages WHERE read_at IS NULL AND from_id LIKE 'job:%' AND conversation_id NOT LIKE ?")
      .all(`${SIBLING_CONVERSATION_PREFIX}%`).map((row) => String(row.from_id)));
  }

  insertOnce(m: BridgeMessage): boolean {
    if (this.db.prepare("SELECT 1 FROM messages WHERE id=? AND recipient=?").get(m.id, m.recipient)) return false;
    this.insert(m);
    return true;
  }

  /** A recovered inline envelope must never replay after a recipient consumed it or it was forwarded. */
  insertJobDelivery(m: BridgeMessage): boolean {
    if (this.db.prepare("SELECT 1 FROM job_delivery_routes WHERE id=?").get(m.id)) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.insertOnce(m);
      const row = this.db.prepare("SELECT read_at FROM messages WHERE id=? AND recipient=?").get(m.id, m.recipient);
      this.db.prepare("INSERT INTO job_delivery_routes(id,recipient,consumed_at) VALUES (?,?,?)").run(m.id, m.recipient, row?.read_at ?? null);
      this.db.exec("COMMIT");
      return inserted;
    } catch (err) { this.db.exec("ROLLBACK"); throw err; }
  }

  markRead(recipient: string, ids: string[], at: number = Date.now()): number {
    let changed = 0;
    for (const id of ids) {
      changed += Number(this.stmt.markRead.run(at, id, recipient).changes);
      this.db.prepare("UPDATE job_delivery_routes SET consumed_at=? WHERE id=? AND recipient=? AND consumed_at IS NULL").run(at, id, recipient);
    }
    return changed;
  }

  /** Move messages waiting for "any <agent>" to a concrete peer name. */
  claim(fromKey: string, toName: string): number {
    if (fromKey === toName) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const moved = Number(this.stmt.claim.run(toName, fromKey).changes);
      // A broadcast can have reached both servers before their shared session id was learned.
      // Keep the destination copy and retire the duplicate alias without replaying it later.
      const duplicates = Number(this.db.prepare(`UPDATE messages SET read_at = ?
        WHERE recipient = ? AND read_at IS NULL AND id IN (SELECT id FROM messages WHERE recipient = ?)`)
        .run(Date.now(), fromKey, toName).changes);
      this.db.exec("COMMIT");
      return moved + duplicates;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Archive unread mail waiting for a queue key or name that is older than the cutoff. */
  expireQueued(recipient: string, cutoff: number): number {
    const n = archiveMessages(this.db, this.archiveDb, "recipient = ? AND read_at IS NULL AND created_at < ?", [recipient, cutoff], "stale queue");
    if (n > 0) this.log.info("archived stale queued messages", { recipient, count: n });
    return n;
  }

  receipts(id: string): { recipient: string; readAt: number | null }[] {
    const merged = new Map<string, { recipient: string; readAt: number | null }>();
    for (const [db, table] of [[this.archiveDb, "messages"], [this.db, "archived_messages"], [this.db, "messages"]] as const) {
      const rows = db.prepare(`SELECT recipient, read_at AS readAt FROM ${table} WHERE id = ?`).all(id) as unknown as { recipient: string; readAt: number | null }[];
      for (const row of rows) merged.set(row.recipient, row);
    }
    return [...merged.values()];
  }

  byId(id: string): BridgeMessage | null {
    const row = (this.stmt.byId.get(id) ?? this.archiveDb.prepare("SELECT * FROM messages WHERE id = ? LIMIT 1").get(id) ??
      this.db.prepare("SELECT * FROM archived_messages WHERE id = ? LIMIT 1").get(id)) as unknown as Row | undefined;
    return row ? toMessage(row) : null;
  }

  purgeOlderThan(cutoff: number): number {
    const n = archiveMessages(this.db, this.archiveDb, "created_at < ?", [cutoff], "expired");
    if (n > 0) this.log.info("archived expired messages", { count: n });
    if (this.home) {
      try { backupIfDue(this.home); }
      catch (err) { this.log.warn("automatic backup failed", { err: String(err) }); }
    }
    return n;
  }

  close(): void {
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
}
