import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { decisionScopeSchema, type DecisionScope } from "./decisions.js";
import type { Logger } from "./logger.js";
import type { MessageAddress } from "./protocol.js";
import { migrateSqlite } from "./sqlite-migrations.js";

export const QUESTIONS_FILE = "owner-questions.db";
export const MAX_OPEN_QUESTIONS = 5;
const short = z.string().trim().min(1).max(500);
export const askOwnerSchema = z.object({
  project: z.string().min(1).max(4096).optional().describe("Own project directory; defaults to the asking session's canonical project"),
  deskProject: z.string().trim().min(1).max(100).optional().describe("Pair Desk project slug for linked issue navigation; otherwise read from .pair-desk.json"),
  title: short.refine(s => !/[\r\n]/.test(s), "Use a one-line title"),
  context: z.string().max(4000).refine(s => s.split(/\r?\n/).length <= 10),
  topic: z.string().trim().min(1).max(160),
  options: z.array(z.object({ id: z.string().regex(/^[\w-]{1,40}$/), label: short,
    consequence: short, recommended: z.boolean() }).strict()).min(2).max(4),
  links: z.array(z.object({ kind: z.enum(["issue", "file", "commit", "artifact", "diff"]), value: z.string().min(1).max(4096) }).strict()).max(10).default([]),
  affectedProjects: z.array(z.string().min(1).max(4096)).max(20).default([]),
  job: z.string().min(1).max(100).optional(),
  blocking: z.boolean(), blocks: z.string().max(1000), meanwhile: short,
  destructive: z.boolean().default(false), authorization: z.boolean().default(false),
  urgency: z.enum(["normal", "urgent"]).default("normal"),
  default: z.object({ option: z.string().max(40), deadline: z.number().int().positive() }).strict().optional(),
}).strict().superRefine((a, ctx) => {
  if (a.options.filter(o => o.recommended).length !== 1 || new Set(a.options.map(o => o.id)).size !== a.options.length)
    ctx.addIssue({ code: "custom", message: "Use distinct options with exactly one recommendation" });
  if (a.default && !a.options.some(o => o.id === a.default!.option)) ctx.addIssue({ code: "custom", message: "Default must reference an option" });
  if (a.default && (a.authorization || a.blocking && a.destructive)) ctx.addIssue({ code: "custom", message: "Authorization and blocking destructive questions cannot use a default" });
  if (a.authorization && !a.links.some(l => ["artifact", "diff", "commit"].includes(l.kind))) ctx.addIssue({ code: "custom", message: "Include the concrete artifact or diff" });
  if (a.blocking && !a.blocks.trim()) ctx.addIssue({ code: "custom", message: "State the action that is blocked" });
});
export type AskOwnerArgs = z.input<typeof askOwnerSchema>;
export const questionAnswerSchema = z.object({
  option: z.string().max(40).optional(), text: z.string().min(1).max(8000).optional(),
  pin: z.object({ scope: decisionScopeSchema, topic: z.string().trim().min(1).max(160) }).strict().optional(),
}).strict().refine(a => Boolean(a.option) !== Boolean(a.text), "Choose an option or write an answer");
export type QuestionAnswerArgs = z.infer<typeof questionAnswerSchema>;
export interface QuestionAsker { session: string; sessionId: string | null; agent: MessageAddress["agent"]; main: string; job?: string; }
export interface QuestionDelivery { recipient: string; messageId?: string; state: "pending" | "wake-requested" | "busy" | "wake-unavailable" | "offline" | "failed"; detail: string; readAt: number | null; }
export interface OwnerQuestion extends z.output<typeof askOwnerSchema> {
  id: string; kind: "question"; project: string; dedupeKey: string;
  status: "open" | "answered" | "cancelled" | "superseded"; askedAt: number;
  askers: QuestionAsker[]; answer?: { text: string; option?: string; author: MessageAddress; at: number; source: "owner" | "declared-default"; pin?: { scope: DecisionScope; topic: string }; decisionId?: string };
  deliveries: QuestionDelivery[]; dismissal?: { reason: string; at: number; supersededBy?: string };
  mirror?: { state: "pending" | "saved" | "failed"; detail?: string; nextAttempt?: number; issues?: string[] };
  deliveryComplete?: boolean;
}
const migrations = [{ version: 1, sql: `
CREATE TABLE questions (id TEXT PRIMARY KEY, project TEXT NOT NULL, dedupe_key TEXT NOT NULL, status TEXT NOT NULL, record TEXT NOT NULL);
CREATE UNIQUE INDEX question_open_key ON questions(dedupe_key) WHERE status='open';
CREATE TABLE question_events (revision INTEGER PRIMARY KEY AUTOINCREMENT, question_id TEXT NOT NULL, record TEXT NOT NULL);
CREATE TABLE question_alerts (question_id TEXT PRIMARY KEY, notified_at INTEGER NOT NULL, channel TEXT NOT NULL);
PRAGMA user_version=1;` }];

/** An additive extension of the approval registry. Legacy approval processes never open this database.
 * Their bridge.db and permission JSON formats stay unchanged. Future changes back up before migration. */
export class OwnerQuestionStore {
  private readonly db: DatabaseSync;
  constructor(home: string, log: Logger) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = join(home, QUESTIONS_FILE), existed = existsSync(file);
    this.db = new DatabaseSync(file);
    try { migrateSqlite(this.db, file, existed, 1, migrations, log); this.db.exec("PRAGMA busy_timeout=1000"); }
    catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  list(): OwnerQuestion[] { return this.db.prepare("SELECT record FROM questions ORDER BY rowid DESC").all().map(r => JSON.parse(String(r.record))); }
  work(): OwnerQuestion[] { return this.db.prepare(`SELECT record FROM questions WHERE status='open' OR
    (status='answered' AND (coalesce(json_extract(record,'$.deliveryComplete'),0)=0 OR
      json_extract(record,'$.mirror.state') IN ('pending','failed'))) ORDER BY rowid`).all().map(r => JSON.parse(String(r.record))); }
  get(id: string): OwnerQuestion | undefined { const row = this.db.prepare("SELECT record FROM questions WHERE id=?").get(id); return row ? JSON.parse(String(row.record)) : undefined; }
  save(q: OwnerQuestion): void {
    this.db.prepare(`INSERT INTO questions VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,record=excluded.record`).run(q.id, q.project, q.dedupeKey, q.status, JSON.stringify(q));
    this.db.prepare("INSERT INTO question_events(question_id,record) VALUES(?,?)").run(q.id, JSON.stringify(q));
  }
  private transaction<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const out = fn(); this.db.exec("COMMIT"); return out; } catch (err) { this.db.exec("ROLLBACK"); throw err; } }
  ask(input: AskOwnerArgs, project: string, asker: QuestionAsker, at = Date.now(), deskProject?: string): { question: OwnerQuestion; merged: boolean; similar: string[] } {
    const args = askOwnerSchema.parse(input);
    if (args.default && args.default.deadline <= at) throw new Error("Default deadline must be in the future");
    return this.transaction(() => {
      const open = this.list().filter(q => q.status === "open");
      const issue = args.links.filter(l => l.kind === "issue").map(l => l.value.toUpperCase()).sort().join(",");
      const key = JSON.stringify([project, issue, args.topic.toLowerCase()]);
      const same = open.find(q => q.dedupeKey === key);
      if (!same?.askers.some(a => a.session === asker.session) && open.filter(q => q.askers.some(a => a.session === asker.session)).length >= MAX_OPEN_QUESTIONS) throw new Error(`At most ${MAX_OPEN_QUESTIONS} open questions per session; consolidate or cancel existing ones`);
      if (same) {
        // Never merge different options/defaults into a question whose answer would mean different things.
        if (JSON.stringify([same.options,same.default,same.authorization,same.destructive,same.blocking]) !== JSON.stringify([args.options,args.default,args.authorization,args.destructive,args.blocking])) throw new Error(`Question ${same.id} already covers this topic with different terms; cancel or supersede it explicitly`);
        if (!same.askers.some(a => a.session === asker.session)) same.askers.push(asker);
        same.affectedProjects = [...new Set([...same.affectedProjects, ...args.affectedProjects, project])];
        same.links = [...new Map([...same.links, ...args.links].map(l => [JSON.stringify(l), l])).values()];
        this.save(same); return { question: same, merged: true, similar: [] };
      }
      const q: OwnerQuestion = { ...args, id: randomUUID(), kind: "question", project, dedupeKey: key,
        status: "open", askedAt: at, askers: [asker], deliveries: [], ...(deskProject ? {deskProject} : {}), affectedProjects: [...new Set([project, ...args.affectedProjects])] };
      this.save(q);
      return { question: q, merged: false, similar: open.filter(o => o.project === project && o.topic.toLowerCase() === args.topic.toLowerCase()).map(o => o.id) };
    });
  }
  answer(id: string, input: QuestionAnswerArgs, author: MessageAddress, at = Date.now(), source: "owner" | "declared-default" = "owner"): OwnerQuestion {
    const args = questionAnswerSchema.parse(input);
    return this.transaction(() => {
      const q = this.get(id); if (!q || q.status !== "open") throw new Error("Question is no longer open");
      const option = args.option ? q.options.find(o => o.id === args.option) : undefined;
      if (args.option && !option) throw new Error("Unknown option");
      if (source === "declared-default" && (!q.default || q.default.deadline > at || q.default.option !== args.option || q.authorization || q.blocking && q.destructive || args.pin)) throw new Error("Default cannot apply");
      q.status = "answered"; q.answer = { text: args.text ?? option!.label, ...(option ? { option: option.id } : {}), author, at, source, ...(args.pin ? { pin: args.pin } : {}) };
      q.mirror = q.links.some(l => l.kind === "issue") ? { state: "pending" } : undefined;
      this.save(q); return q;
    });
  }
  dismiss(id: string, status: "cancelled" | "superseded", reason: string, supersededBy?: string): OwnerQuestion {
    return this.transaction(() => {
      const q = this.get(id); if (!q || q.status !== "open") throw new Error("Question is no longer open");
      if (!reason.trim()) throw new Error("Give a dismissal reason");
      if (status === "superseded" && (!supersededBy || supersededBy === id || !this.get(supersededBy))) throw new Error("Choose a replacement question");
      q.status = status; q.dismissal = { reason, at: Date.now(), ...(supersededBy ? { supersededBy } : {}) }; this.save(q); return q;
    });
  }
  claimAlert(id: string, channel: string, at: number, reminderMs: number): boolean {
    return Boolean(this.db.prepare(`INSERT INTO question_alerts VALUES(?,?,?) ON CONFLICT(question_id) DO UPDATE SET notified_at=excluded.notified_at,channel=excluded.channel
      WHERE ? > 0 AND excluded.notified_at-question_alerts.notified_at >= ?`).run(id, at, channel, reminderMs, reminderMs).changes);
  }
}
export function readOwnerQuestions(home: string): OwnerQuestion[] {
  const file = join(home, QUESTIONS_FILE); if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true, timeout: 100 });
  try { return db.prepare("SELECT record FROM questions ORDER BY rowid DESC").all().map(r => JSON.parse(String(r.record))); } finally { db.close(); }
}

export interface QuestionAlertSettings { sound: boolean; toast: boolean; reminderMinutes: number }
export const questionAlertSettingsSchema = z.object({ sound: z.boolean(), toast: z.boolean(), reminderMinutes: z.number().int().min(0).max(1440) }).strict();
export const DEFAULT_QUESTION_ALERTS: QuestionAlertSettings = { sound: true, toast: true, reminderMinutes: 15 };
export interface DashboardPresence { tab: string; visible: boolean; at: number }
/** Select one browser tab, preferring a visible one. Hidden-but-open remains different from closed. */
export function questionAlertChannel(tabs: DashboardPresence[], at: number): { channel: "browser" | "desktop"; tab?: string } {
  const live = tabs.filter(t => at - t.at <= 10_000).sort((a,b) => Number(b.visible)-Number(a.visible) || b.at-a.at);
  return live.length ? { channel: "browser", tab: live[0]!.tab } : { channel: "desktop" };
}
