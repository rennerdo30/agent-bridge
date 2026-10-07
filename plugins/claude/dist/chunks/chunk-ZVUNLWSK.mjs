import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  external_exports
} from "./chunk-JYWG6ADH.mjs";
import {
  MAX_BODY_CHARS
} from "./chunk-DQEWVRBU.mjs";

// src/core/decisions.ts
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
var MAX_DECISION_TOPIC_CHARS = 160;
var MAX_DECISION_TEXT_CHARS = MAX_BODY_CHARS - 1024;
var MAX_SCOPE_SESSIONS = 100;
var MAX_SCOPE_PATH_CHARS = 4096;
var DECISION_MESSAGE_HOP = 100;
var SUMMARY_LIMIT = 5;
var SUMMARY_TEXT_CHARS = 160;
var decisionScopeSchema = external_exports.union([
  external_exports.literal("all"),
  external_exports.object({ project: external_exports.string().trim().min(1).max(MAX_SCOPE_PATH_CHARS) }).strict(),
  external_exports.object({ sessions: external_exports.array(external_exports.string().trim().min(1).max(MAX_SCOPE_PATH_CHARS)).min(1).max(MAX_SCOPE_SESSIONS) }).strict()
]);
var DECISIONS_SCHEMA = `
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
function normalizeProject(folder) {
  const path = resolve(folder).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? path.toLowerCase() : path;
}
function normalizeScope(scope) {
  if (scope === "all") return scope;
  if ("project" in scope) return { project: normalizeProject(scope.project) };
  return { sessions: [...new Set(scope.sessions)].sort() };
}
function decisionApplies(decision, peer) {
  if (decision.scope === "all") return true;
  if ("project" in decision.scope) return decision.scope.project === normalizeProject(peer.cwd);
  return decision.scope.sessions.some((s) => s === peer.name || s === peer.id || s === peer.sessionId);
}
function scopeMatches(decision, filter, sessions = []) {
  const stored = decision.scope;
  if (!filter || stored === "all") return true;
  if (filter === "all") return false;
  if ("project" in filter) {
    return "project" in stored ? stored.project === filter.project : sessions.some((s) => stored.sessions.includes(s));
  }
  return "sessions" in stored && filter.sessions.some((s) => stored.sessions.includes(s));
}
var DecisionStore = class {
  constructor(db) {
    this.db = db;
  }
  db;
  record(args, author, at) {
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
    return this.list({ topic, history: true }).find((d) => d.id === id);
  }
  list(args = {}, peer) {
    const rows = this.db.prepare(`SELECT d.*, NOT EXISTS (SELECT 1 FROM decisions newer WHERE newer.supersedes = d.id) AS current
      FROM decisions d ORDER BY revision DESC`).all();
    const query = args.query?.trim().toLowerCase();
    const scope = args.scope ? normalizeScope(args.scope) : void 0;
    const sessions = [...args.session ? [args.session] : [], ...peer ? [peer.name, peer.id, ...peer.sessionId ? [peer.sessionId] : []] : []];
    return rows.map((r) => ({
      id: r.id,
      topic: r.topic,
      text: r.body,
      scope: JSON.parse(r.scope),
      author: { id: r.author_id, name: r.author_name, agent: r.author_agent },
      createdAt: r.created_at,
      sourceMessageId: r.source_message_id,
      supersedes: r.supersedes,
      current: Boolean(r.current)
    })).filter((d) => (args.history || d.current) && (!args.topic || d.topic === args.topic.trim().toLowerCase()) && (!query || `${d.topic}
${d.text}`.toLowerCase().includes(query)) && scopeMatches(d, scope, sessions));
  }
  /** The receipt and durable message commit together, before emitting any event. */
  enqueue(decision, sessionKey, message, insert) {
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
  linkSession(from, to) {
    this.db.prepare(`INSERT OR IGNORE INTO decision_deliveries
      SELECT decision_id, ?, message_id, created_at FROM decision_deliveries WHERE session_key = ?`).run(to, from);
  }
};
function formatDecisionSummary(decisions) {
  if (!decisions.length) return "";
  const lines = decisions.slice(0, SUMMARY_LIMIT).map((d) => `- ${d.topic}: ${d.text.replace(/\s+/g, " ").slice(0, SUMMARY_TEXT_CHARS)}${d.text.length > SUMMARY_TEXT_CHARS ? "\u2026" : ""}`);
  return [`Current owner decisions (${decisions.length}; call decisions for full text):`, ...lines].join("\n");
}
function readDecisions(dbPath, args = {}) {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 50 });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decisions'").get()) return [];
    return new DecisionStore(db).list(args);
  } finally {
    db.close();
  }
}

export {
  MAX_DECISION_TOPIC_CHARS,
  MAX_DECISION_TEXT_CHARS,
  DECISION_MESSAGE_HOP,
  decisionScopeSchema,
  DECISIONS_SCHEMA,
  decisionApplies,
  DecisionStore,
  formatDecisionSummary,
  readDecisions
};
