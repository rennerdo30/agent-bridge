import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Logger } from "./logger.js";
import type { AgentKind, BridgeMessage } from "./protocol.js";

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
  private readonly stmt: {
    insert: StatementSync;
    unread: StatementSync;
    markRead: StatementSync;
    claim: StatementSync;
    byId: StatementSync;
    purge: StatementSync;
  };

  constructor(
    file: string,
    private readonly log: Logger,
  ) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    this.db.exec(SCHEMA);
    this.stmt = {
      insert: this.db.prepare(
        `INSERT INTO messages (id, recipient, from_id, from_name, from_agent, to_target, conversation_id, reply_to, hop, body, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ),
      unread: this.db.prepare(
        `SELECT * FROM messages WHERE recipient = ? AND read_at IS NULL ORDER BY created_at ASC, id ASC LIMIT ?`,
      ),
      markRead: this.db.prepare(`UPDATE messages SET read_at = ? WHERE id = ? AND recipient = ? AND read_at IS NULL`),
      claim: this.db.prepare(`UPDATE messages SET recipient = ? WHERE recipient = ? AND read_at IS NULL`),
      byId: this.db.prepare(`SELECT * FROM messages WHERE id = ? ORDER BY created_at ASC LIMIT 1`),
      purge: this.db.prepare(`DELETE FROM messages WHERE created_at < ?`),
    };
    log.debug("message store opened", { file });
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
    return Number(this.stmt.claim.run(toName, fromKey).changes);
  }

  byId(id: string): BridgeMessage | null {
    const row = this.stmt.byId.get(id) as unknown as Row | undefined;
    return row ? toMessage(row) : null;
  }

  purgeOlderThan(cutoff: number): number {
    const n = Number(this.stmt.purge.run(cutoff).changes);
    if (n > 0) this.log.info("purged expired messages", { count: n });
    return n;
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      this.log.warn("error closing message store", { err });
    }
  }
}
