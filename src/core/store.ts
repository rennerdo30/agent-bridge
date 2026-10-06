import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Logger } from "./logger.js";
import type { AgentKind, BridgeMessage, PeerInfo } from "./protocol.js";
import { migrateSqlite } from "./sqlite-migrations.js";
import { archiveDbPath, archiveMessages, openArchive } from "./sqlite-maintenance.js";
import { storageLease } from "./storage-lock.js";
import { backupIfDue, BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS } from "./backups.js";
import { retentionLimit } from "./json-store.js";
import { historySchema } from "./history-schema.js";
import { HistoryIndex } from "./history.js";
import { DECISIONS_SCHEMA, DecisionStore } from "./decisions.js";

const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

export const SQLITE_STORE_VERSION = 5;

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
] as const;

function registrationIdentity(peer: PeerInfo): string | null {
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
    const existed = file !== ":memory:" && existsSync(file);
    this.home = file === ":memory:" ? null : dirname(file);
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); // owner-only on Unix
    this.release = file === ":memory:" ? () => {} : storageLease(dirname(file));
    try { this.db = new DatabaseSync(file); }
    catch (err) { this.release(); throw err; }
    try {
      migrateSqlite(this.db, file, existed, SQLITE_STORE_VERSION, MIGRATIONS, log);
      this.db.exec("PRAGMA journal_mode = WAL;");
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
         ORDER BY CASE WHEN (conversation_id LIKE 'siblings-%:note' OR conversation_id LIKE '%:ack') THEN 1 ELSE 0 END,
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

  markRead(recipient: string, ids: string[], at: number = Date.now()): number {
    let changed = 0;
    for (const id of ids) changed += Number(this.stmt.markRead.run(at, id, recipient).changes);
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
