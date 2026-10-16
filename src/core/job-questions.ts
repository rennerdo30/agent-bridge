import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileSignature } from "./file-cache.js";

/**
 * Open questions from delegated jobs to their parent (AB-249): a job's send with message_kind="question"
 * is stored in conversation `job-<id>:question` (`:fallback` when it was rerouted to the project main).
 * A question is open until the job hears back (message_subagent or cancel through its control
 * conversation), or the job moves on and sends a report or reply of its own. Read-only.
 */
export interface JobQuestion {
  id: string;
  /** The job's name, e.g. claude-job-1a2b3c4d. */
  job: string;
  agent: string;
  /** Who got the question: the parent, or the project main when the parent was not connected. */
  recipient: string;
  rerouted: boolean;
  body: string;
  createdAt: number;
  readAt: number | null;
}

const MAX_QUESTIONS = 50;
const cache = new Map<string, { signature: string; questions: JobQuestion[] }>();

// Three single passes instead of correlated subqueries, which rescanned every message once per question (about a
// second per dashboard refresh on a 23,000-message store).
const QUESTIONS = `
SELECT id, from_id, from_name AS job, from_agent AS agent, recipient, conversation_id, body, created_at, read_at
FROM messages
WHERE from_id LIKE 'job:%' AND (conversation_id LIKE 'job-%:question' OR conversation_id LIKE 'job-%:question:fallback')`;
/** Latest answer (message_subagent or cancel) each job got through its control conversation. */
const ANSWERED = `
SELECT recipient, max(created_at) AS at FROM messages
WHERE conversation_id LIKE 'jobctl-%' AND CASE WHEN json_valid(body) THEN json_extract(body, '$.type') END IN ('message', 'cancel')
GROUP BY recipient`;
/** Latest report or reply of each job's own (not a question, note or ack). */
const MOVED_ON = `
SELECT from_id, max(created_at) AS at FROM messages
WHERE from_id LIKE 'job:%' AND conversation_id LIKE 'job-%'
  AND conversation_id NOT LIKE '%:question' AND conversation_id NOT LIKE '%:question:fallback'
  AND conversation_id NOT LIKE '%:note' AND conversation_id NOT LIKE '%:ack'
GROUP BY from_id`;

/** Unanswered job questions in the broker store, newest first. Cached until the store changes. */
export function openJobQuestions(dbPath: string): JobQuestion[] {
  if (!existsSync(dbPath)) return [];
  const signature = [dbPath, `${dbPath}-wal`].map((p) => existsSync(p) ? fileSignature(statSync(p, { bigint: true })) : "missing").join("|");
  const saved = cache.get(dbPath);
  if (saved?.signature === signature) return saved.questions;
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 50 });
  const byId = new Map<string, JobQuestion>();
  try {
    const latest = (sql: string) => new Map(db.prepare(sql).all().map((row) => [String(Object.values(row)[0]), Number(row.at)]));
    const answered = latest(ANSWERED), movedOn = latest(MOVED_ON);
    const open = db.prepare(QUESTIONS).all().filter((q) => {
      const at = Number(q.created_at);
      // Answered at or after the question, or a later message of the job's own.
      return !((answered.get(String(q.job)) ?? -Infinity) >= at) && !((movedOn.get(String(q.from_id)) ?? -Infinity) > at);
    }).sort((a, b) => Number(b.created_at) - Number(a.created_at) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    for (const row of open) {
      if (byId.size >= MAX_QUESTIONS) break;
      const id = String(row.id);
      if (byId.has(id)) continue;
      byId.set(id, {
        id, job: String(row.job), agent: String(row.agent), recipient: String(row.recipient),
        rerouted: String(row.conversation_id).endsWith(":fallback"), body: String(row.body),
        createdAt: Number(row.created_at), readAt: row.read_at === null ? null : Number(row.read_at),
      });
    }
  } finally { db.close(); }
  const questions = [...byId.values()];
  cache.set(dbPath, { signature, questions });
  return questions;
}
