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

const OPEN_QUESTIONS = `
SELECT q.id, q.from_name AS job, q.from_agent AS agent, q.recipient, q.conversation_id, q.body, q.created_at, q.read_at
FROM messages q
WHERE q.from_id LIKE 'job:%' AND (q.conversation_id LIKE 'job-%:question' OR q.conversation_id LIKE 'job-%:question:fallback')
  AND NOT EXISTS (SELECT 1 FROM messages c WHERE c.recipient = q.from_name AND c.conversation_id LIKE 'jobctl-%' AND c.created_at >= q.created_at
    AND CASE WHEN json_valid(c.body) THEN json_extract(c.body, '$.type') END IN ('message', 'cancel'))
  AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.from_id = q.from_id AND r.created_at > q.created_at AND r.conversation_id LIKE 'job-%'
    AND r.conversation_id NOT LIKE '%:question' AND r.conversation_id NOT LIKE '%:question:fallback'
    AND r.conversation_id NOT LIKE '%:note' AND r.conversation_id NOT LIKE '%:ack')
ORDER BY q.created_at DESC, q.id
LIMIT ?`;

/** Unanswered job questions in the broker store, newest first. Cached until the store changes. */
export function openJobQuestions(dbPath: string): JobQuestion[] {
  if (!existsSync(dbPath)) return [];
  const signature = [dbPath, `${dbPath}-wal`].map((p) => existsSync(p) ? fileSignature(statSync(p)) : "missing").join("|");
  const saved = cache.get(dbPath);
  if (saved?.signature === signature) return saved.questions;
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 50 });
  const byId = new Map<string, JobQuestion>();
  try {
    for (const row of db.prepare(OPEN_QUESTIONS).all(MAX_QUESTIONS)) {
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
