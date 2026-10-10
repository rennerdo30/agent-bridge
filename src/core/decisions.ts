import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { MAX_BODY_CHARS } from "./constants.js";
import type { BridgeMessage, MessageAddress, PeerInfo } from "./protocol.js";

export const MAX_DECISION_TOPIC_CHARS = 160;
export const MAX_DECISION_TEXT_CHARS = MAX_BODY_CHARS - 1_024;
const MAX_SCOPE_SESSIONS = 100;
const MAX_SCOPE_PATH_CHARS = 4_096;
/** At the configured maximum hop limit: notifications never start a wake-up conversation. */
export const DECISION_MESSAGE_HOP = 100;
const SUMMARY_LIMIT = 5;
const SUMMARY_TEXT_CHARS = 160;

export const decisionScopeSchema = z.union([
  z.literal("all"),
  z.object({ project: z.string().trim().min(1).max(MAX_SCOPE_PATH_CHARS) }).strict(),
  z.object({ sessions: z.array(z.string().trim().min(1).max(MAX_SCOPE_PATH_CHARS)).min(1).max(MAX_SCOPE_SESSIONS) }).strict(),
]);
export type DecisionScope = z.infer<typeof decisionScopeSchema>;

export interface OwnerDecision {
  id: string;
  topic: string;
  text: string;
  scope: DecisionScope;
  author: MessageAddress;
  createdAt: number;
  sourceMessageId: string | null;
  supersedes: string | null;
  current: boolean;
}

export interface DecideArgs {
  topic: string;
  text: string;
  scope?: DecisionScope;
  sourceMessageId?: string;
}

export interface DecisionsArgs {
  query?: string;
  scope?: DecisionScope;
  history?: boolean;
  /** Exact topic for history endpoints (query is otherwise a substring search). */
  topic?: string;
  /** Include decisions addressed to this session along with its project's decisions. */
  session?: string;
}

export const DECISIONS_SCHEMA = `
CREATE TABLE decisions (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  body TEXT NOT NULL,
  scope TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_agent TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  source_message_id TEXT,
  supersedes TEXT
);
CREATE INDEX idx_decisions_topic ON decisions (topic, revision);
CREATE INDEX idx_decisions_supersedes ON decisions (supersedes);
CREATE TABLE decision_deliveries (
  decision_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (decision_id, session_key)
);
`;

interface DecisionRow {
  id: string;
  topic: string;
  body: string;
  scope: string;
  author_id: string;
  author_name: string;
  author_agent: MessageAddress["agent"];
  created_at: number;
  source_message_id: string | null;
  supersedes: string | null;
  current: number;
}

export function normalizeProject(folder: string): string {
  const path = resolve(folder).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function normalizeScope(scope: DecisionScope): DecisionScope {
  if (scope === "all") return scope;
  if ("project" in scope) return { project: normalizeProject(scope.project) };
  return { sessions: [...new Set(scope.sessions)].sort() };
}

export function decisionApplies(decision: Pick<OwnerDecision, "scope">, peer: Pick<PeerInfo, "name" | "id" | "sessionId" | "cwd">): boolean {
  if (decision.scope === "all") return true;
  if ("project" in decision.scope) return decision.scope.project === normalizeProject(peer.cwd);
  return decision.scope.sessions.some((s) => s === peer.name || s === peer.id || s === peer.sessionId);
}

function scopeMatches(decision: OwnerDecision, filter?: DecisionScope, sessions: string[] = []): boolean {
  const stored = decision.scope;
  if (!filter || stored === "all") return true;
  if (filter === "all") return false;
  if ("project" in filter) {
    return "project" in stored ? stored.project === filter.project : sessions.some((s) => stored.sessions.includes(s));
  }
  return "sessions" in stored && filter.sessions.some((s) => stored.sessions.includes(s));
}

/** Uses the broker's existing database connection; revisions and delivery receipts are append-only. */
export class DecisionStore {
  constructor(private readonly db: DatabaseSync) {}

  record(args: DecideArgs & { scope: DecisionScope }, author: MessageAddress, at: number): OwnerDecision {
    const topic = args.topic.trim().toLowerCase();
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT id FROM decisions WHERE topic = ? ORDER BY revision DESC LIMIT 1").get(topic);
      this.db.prepare(`INSERT INTO decisions (id, topic, body, scope, author_id, author_name, author_agent, created_at, source_message_id, supersedes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, topic, args.text.trim(), JSON.stringify(normalizeScope(args.scope)), author.id, author.name, author.agent, at, args.sourceMessageId ?? null, previous?.id ?? null);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.list({ topic, history: true }).find((d) => d.id === id)!;
  }

  /**
   * Insert a decision synced from a paired broker, keeping its id, topic, createdAt, author,
   * supersedes and history intact (a decision is identified by its id; an existing id is kept
   * as-is and never duplicated). Only scope "all" is synced: project and session paths differ
   * per PC, so narrower scopes are refused here. Returns true when the row is new.
   *
   * When both PCs recorded the same topic while disconnected there are two chain tips; the
   * newer revision (createdAt, id as tiebreak) becomes current by chaining the tips, so the
   * older revision stays in history. Nothing is deleted: history is append-only.
   *
   * `current` is derived locally from the supersedes chain, so it is not an input here.
   */
  importSync(decision: Omit<OwnerDecision, "current">): boolean {
    if (decision.scope !== "all") return false;
    const topic = decision.topic.trim().toLowerCase();
    if (!topic || !decision.text.trim()) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db.prepare("INSERT OR IGNORE INTO decisions (id, topic, body, scope, author_id, author_name, author_agent, created_at, source_message_id, supersedes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(decision.id, topic, decision.text.trim(), JSON.stringify("all" as const),
          decision.author.id, decision.author.name, decision.author.agent,
          decision.createdAt, decision.sourceMessageId, decision.supersedes).changes === 1;
      const tips = (this.db.prepare(`SELECT id, created_at FROM decisions WHERE topic = ?
        AND id NOT IN (SELECT supersedes FROM decisions WHERE topic = ? AND supersedes IS NOT NULL)
        ORDER BY created_at ASC, id ASC`).all(topic, topic) as { id: string; created_at: number }[]);
      for (let i = 1; i < tips.length; i++) {
        this.db.prepare("UPDATE decisions SET supersedes = ? WHERE id = ? AND (supersedes IS NULL OR supersedes != ?)")
          .run(tips[i - 1]!.id, tips[i]!.id, tips[i - 1]!.id);
      }
      this.db.exec("COMMIT");
      return inserted;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  list(args: DecisionsArgs = {}, peer?: PeerInfo): OwnerDecision[] {
    const rows = this.db.prepare(`SELECT d.*, NOT EXISTS (SELECT 1 FROM decisions newer WHERE newer.supersedes = d.id) AS current
      FROM decisions d ORDER BY revision DESC`).all() as unknown as DecisionRow[];
    const query = args.query?.trim().toLowerCase();
    const scope = args.scope ? normalizeScope(args.scope) : undefined;
    const sessions = [...(args.session ? [args.session] : []), ...(peer ? [peer.name, peer.id, ...(peer.sessionId ? [peer.sessionId] : [])] : [])];
    return rows.map((r): OwnerDecision => ({
      id: r.id, topic: r.topic, text: r.body, scope: JSON.parse(r.scope),
      author: { id: r.author_id, name: r.author_name, agent: r.author_agent },
      createdAt: r.created_at, sourceMessageId: r.source_message_id, supersedes: r.supersedes, current: Boolean(r.current),
    })).filter((d) => (args.history || d.current) && (!args.topic || d.topic === args.topic.trim().toLowerCase()) &&
      (!query || `${d.topic}\n${d.text}`.toLowerCase().includes(query)) && scopeMatches(d, scope, sessions));
  }

  /** The receipt and durable message commit together, before emitting any event. */
  enqueue(decision: Pick<OwnerDecision, "id">, sessionKey: string, message: BridgeMessage, insert: () => void): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare("INSERT OR IGNORE INTO decision_deliveries VALUES (?, ?, ?, ?)").run(decision.id, sessionKey, message.id, message.createdAt).changes;
      if (changed) insert();
      this.db.exec("COMMIT");
      return Boolean(changed);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** A hook learns the host session id after hello; retain the provisional receipt as well. */
  linkSession(from: string, to: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO decision_deliveries
      SELECT decision_id, ?, message_id, created_at FROM decision_deliveries WHERE session_key = ?`).run(to, from);
  }
}

export function formatDecisionSummary(decisions: OwnerDecision[]): string {
  if (!decisions.length) return "";
  const lines = decisions.slice(0, SUMMARY_LIMIT).map((d) => `- ${d.topic}: ${d.text.replace(/\s+/g, " ").slice(0, SUMMARY_TEXT_CHARS)}${d.text.length > SUMMARY_TEXT_CHARS ? "…" : ""}`);
  return [`Current owner decisions (${decisions.length}; call decisions for full text):`, ...lines].join("\n");
}

/** Startup and dashboard snapshots never migrate or write the broker's database. */
export function readDecisions(dbPath: string, args: DecisionsArgs = {}): OwnerDecision[] {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 50 });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decisions'").get()) return [];
    return new DecisionStore(db).list(args);
  } finally { db.close(); }
}
