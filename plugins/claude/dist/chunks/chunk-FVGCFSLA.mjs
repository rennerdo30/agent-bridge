import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  external_exports
} from "./chunk-FDMEMG4Z.mjs";
import {
  migrateSqlite
} from "./chunk-NYEIO7DU.mjs";
import {
  MAX_BODY_CHARS
} from "./chunk-7EOIPV3B.mjs";

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

// src/core/owner-questions.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { existsSync as existsSync2, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
var QUESTIONS_FILE = "owner-questions.db";
var MAX_OPEN_QUESTIONS = 5;
var short = external_exports.string().trim().min(1).max(500);
var askOwnerSchema = external_exports.object({
  project: external_exports.string().min(1).max(4096).optional().describe("Own project directory; defaults to the asking session's canonical project"),
  deskProject: external_exports.string().trim().min(1).max(100).optional().describe("Pair Desk project slug for linked issue navigation; otherwise read from .pair-desk.json"),
  title: short.refine((s) => !/[\r\n]/.test(s), "Use a one-line title"),
  context: external_exports.string().max(4e3).refine((s) => s.split(/\r?\n/).length <= 10),
  topic: external_exports.string().trim().min(1).max(160),
  options: external_exports.array(external_exports.object({
    id: external_exports.string().regex(/^[\w-]{1,40}$/),
    label: short,
    consequence: short,
    recommended: external_exports.boolean()
  }).strict()).min(2).max(4),
  links: external_exports.array(external_exports.object({ kind: external_exports.enum(["issue", "file", "commit", "artifact", "diff"]), value: external_exports.string().min(1).max(4096) }).strict()).max(10).default([]),
  affectedProjects: external_exports.array(external_exports.string().min(1).max(4096)).max(20).default([]),
  job: external_exports.string().min(1).max(100).optional(),
  blocking: external_exports.boolean(),
  blocks: external_exports.string().max(1e3),
  meanwhile: short,
  destructive: external_exports.boolean().default(false),
  authorization: external_exports.boolean().default(false),
  urgency: external_exports.enum(["normal", "urgent"]).default("normal"),
  default: external_exports.object({ option: external_exports.string().max(40), deadline: external_exports.number().int().positive() }).strict().optional()
}).strict().superRefine((a, ctx) => {
  if (a.options.filter((o) => o.recommended).length !== 1 || new Set(a.options.map((o) => o.id)).size !== a.options.length)
    ctx.addIssue({ code: "custom", message: "Use distinct options with exactly one recommendation" });
  if (a.default && !a.options.some((o) => o.id === a.default.option)) ctx.addIssue({ code: "custom", message: "Default must reference an option" });
  if (a.default && (a.authorization || a.blocking && a.destructive)) ctx.addIssue({ code: "custom", message: "Authorization and blocking destructive questions cannot use a default" });
  if (a.authorization && !a.links.some((l) => ["artifact", "diff", "commit"].includes(l.kind))) ctx.addIssue({ code: "custom", message: "Include the concrete artifact or diff" });
  if (a.blocking && !a.blocks.trim()) ctx.addIssue({ code: "custom", message: "State the action that is blocked" });
});
var questionAnswerSchema = external_exports.object({
  option: external_exports.string().max(40).optional(),
  text: external_exports.string().min(1).max(8e3).optional(),
  pin: external_exports.object({ scope: decisionScopeSchema, topic: external_exports.string().trim().min(1).max(160) }).strict().optional()
}).strict().refine((a) => Boolean(a.option) !== Boolean(a.text), "Choose an option or write an answer");
var migrations = [{ version: 1, sql: `
CREATE TABLE questions (id TEXT PRIMARY KEY, project TEXT NOT NULL, dedupe_key TEXT NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL);
CREATE UNIQUE INDEX question_open_key ON questions(dedupe_key) WHERE status='open';
CREATE TABLE question_events (revision INTEGER PRIMARY KEY AUTOINCREMENT, question_id TEXT NOT NULL, record TEXT NOT NULL);
CREATE TABLE question_alerts (question_id TEXT PRIMARY KEY, notified_at INTEGER NOT NULL, channel TEXT NOT NULL);
PRAGMA user_version=1;` }];
var OwnerQuestionStore = class {
  db;
  constructor(home, log) {
    mkdirSync(home, { recursive: true, mode: 448 });
    const file = join(home, QUESTIONS_FILE), existed = existsSync2(file);
    this.db = new DatabaseSync2(file);
    try {
      migrateSqlite(this.db, file, existed, 1, migrations, log);
      this.db.exec("PRAGMA busy_timeout=1000");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  list() {
    return this.db.prepare("SELECT record FROM questions ORDER BY rowid DESC").all().map((r) => JSON.parse(String(r.record)));
  }
  work() {
    return this.db.prepare(`SELECT record FROM questions WHERE status='open' OR
    (status='answered' AND (coalesce(json_extract(record,'$.deliveryComplete'),0)=0 OR
      json_extract(record,'$.mirror.state') IN ('pending','failed'))) ORDER BY rowid`).all().map((r) => JSON.parse(String(r.record)));
  }
  get(id) {
    const row = this.db.prepare("SELECT record FROM questions WHERE id=?").get(id);
    return row ? JSON.parse(String(row.record)) : void 0;
  }
  save(q) {
    this.db.prepare(`INSERT INTO questions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,record=excluded.record`).run(q.id, q.project, q.dedupeKey, q.status, JSON.stringify(q));
    this.db.prepare("INSERT INTO question_events(question_id,record) VALUES(?,?)").run(q.id, JSON.stringify(q));
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
  ask(input, project, asker, at = Date.now(), deskProject) {
    const args = askOwnerSchema.parse(input);
    if (args.default && args.default.deadline <= at) throw new Error("Default deadline must be in the future");
    return this.transaction(() => {
      const open = this.list().filter((q2) => q2.status === "open");
      const sameAsker = (a) => a.sessionId && asker.sessionId ? a.agent === asker.agent && a.sessionId === asker.sessionId : a.peerId && asker.peerId ? a.peerId === asker.peerId : a.session === asker.session;
      const issue = args.links.filter((l) => l.kind === "issue").map((l) => l.value.toUpperCase()).sort().join(",");
      const key = JSON.stringify([project, issue, args.topic.toLowerCase()]);
      const same = open.find((q2) => q2.dedupeKey === key);
      if (!same?.askers.some(sameAsker) && open.filter((q2) => q2.askers.some(sameAsker)).length >= MAX_OPEN_QUESTIONS) throw new Error(`At most ${MAX_OPEN_QUESTIONS} open questions per session; consolidate or cancel existing ones`);
      if (same) {
        if (JSON.stringify([same.options, same.default, same.authorization, same.destructive, same.blocking]) !== JSON.stringify([args.options, args.default, args.authorization, args.destructive, args.blocking])) throw new Error(`Question ${same.id} already covers this topic with different terms; cancel or supersede it explicitly`);
        const priorAsker = same.askers.findIndex((a) => sameAsker(a) && a.job === asker.job);
        if (priorAsker < 0) same.askers.push(asker);
        else same.askers[priorAsker] = { ...same.askers[priorAsker], ...asker };
        same.affectedProjects = [.../* @__PURE__ */ new Set([...same.affectedProjects, ...args.affectedProjects, project])];
        same.links = [...new Map([...same.links, ...args.links].map((l) => [JSON.stringify(l), l])).values()];
        this.save(same);
        return { question: same, merged: true, similar: [] };
      }
      const q = {
        ...args,
        id: randomUUID2(),
        kind: "question",
        project,
        dedupeKey: key,
        status: "open",
        askedAt: at,
        askers: [asker],
        deliveries: [],
        ...deskProject ? { deskProject } : {},
        affectedProjects: [.../* @__PURE__ */ new Set([project, ...args.affectedProjects])]
      };
      this.save(q);
      return { question: q, merged: false, similar: open.filter((o) => o.project === project && o.topic.toLowerCase() === args.topic.toLowerCase()).map((o) => o.id) };
    });
  }
  answer(id, input, author, at = Date.now(), source = "owner") {
    const args = questionAnswerSchema.parse(input);
    return this.transaction(() => {
      const q = this.get(id);
      if (!q || q.status !== "open") throw new Error("Question is no longer open");
      const option = args.option ? q.options.find((o) => o.id === args.option) : void 0;
      if (args.option && !option) throw new Error("Unknown option");
      if (source === "declared-default" && (!q.default || q.default.deadline > at || q.default.option !== args.option || q.authorization || q.blocking && q.destructive || args.pin)) throw new Error("Default cannot apply");
      q.status = "answered";
      q.answer = { text: args.text ?? option.label, ...option ? { option: option.id } : {}, author, at, source, ...args.pin ? { pin: args.pin } : {} };
      q.mirror = q.links.some((l) => l.kind === "issue") ? { state: "pending" } : void 0;
      this.save(q);
      return q;
    });
  }
  dismiss(id, status, reason, supersededBy) {
    return this.transaction(() => {
      const q = this.get(id);
      if (!q || q.status !== "open") throw new Error("Question is no longer open");
      if (!reason.trim()) throw new Error("Give a dismissal reason");
      if (status === "superseded" && (!supersededBy || supersededBy === id || !this.get(supersededBy))) throw new Error("Choose a replacement question");
      q.status = status;
      q.dismissal = { reason, at: Date.now(), ...supersededBy ? { supersededBy } : {} };
      this.save(q);
      return q;
    });
  }
  claimAlert(id, channel, at, reminderMs) {
    return Boolean(this.db.prepare(`INSERT INTO question_alerts VALUES(?,?,?) ON CONFLICT(question_id) DO UPDATE SET notified_at=excluded.notified_at,channel=excluded.channel
      WHERE ? > 0 AND excluded.notified_at-question_alerts.notified_at >= ?`).run(id, at, channel, reminderMs, reminderMs).changes);
  }
};
function readOwnerQuestions(home) {
  const file = join(home, QUESTIONS_FILE);
  if (!existsSync2(file)) return [];
  const db = new DatabaseSync2(file, { readOnly: true, timeout: 100 });
  try {
    return db.prepare("SELECT record FROM questions ORDER BY rowid DESC").all().map((r) => JSON.parse(String(r.record)));
  } finally {
    db.close();
  }
}
var questionAlertSettingsSchema = external_exports.object({ sound: external_exports.boolean(), toast: external_exports.boolean(), reminderMinutes: external_exports.number().int().min(0).max(1440) }).strict();
var DEFAULT_QUESTION_ALERTS = { sound: true, toast: true, reminderMinutes: 15 };
function questionAlertChannel(tabs, at) {
  const live = tabs.filter((t) => at - t.at <= 1e4).sort((a, b) => Number(b.visible) - Number(a.visible) || b.at - a.at);
  return live.length ? { channel: "browser", tab: live[0].tab } : { channel: "desktop" };
}

export {
  MAX_DECISION_TOPIC_CHARS,
  MAX_DECISION_TEXT_CHARS,
  DECISION_MESSAGE_HOP,
  decisionScopeSchema,
  DECISIONS_SCHEMA,
  normalizeProject,
  decisionApplies,
  DecisionStore,
  formatDecisionSummary,
  readDecisions,
  QUESTIONS_FILE,
  askOwnerSchema,
  questionAnswerSchema,
  OwnerQuestionStore,
  readOwnerQuestions,
  questionAlertSettingsSchema,
  DEFAULT_QUESTION_ALERTS,
  questionAlertChannel
};
