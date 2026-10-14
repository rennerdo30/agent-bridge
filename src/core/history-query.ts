import { z } from "zod";
import { conversationProject } from "./project-identity.js";
export const HISTORY_MAX_QUERY_CHARS = 1_000;
export const HISTORY_MAX_LIMIT = 50;
const HISTORY_FILTER_ID_CHARS = 256;
const dateFilter = z.union([z.number().int().nonnegative(), z.iso.datetime({ offset: true })]).transform((v) => typeof v === "number" ? v : Date.parse(v));
export const historyFiltersSchema = z.object({
  project: z.string().min(1).max(4096).transform(conversationProject).optional()
    .describe("Project folder (absolute path, e.g. your cwd); drive aliases of the same folder match"),
  session: z.string().min(1).max(HISTORY_FILTER_ID_CHARS).optional()
    .describe("Session peer name or CLI session id, e.g. \"codex-myrepo\""),
  job: z.string().min(1).max(HISTORY_FILTER_ID_CHARS).optional()
    .describe("Delegated job name, e.g. \"codex-job-1a2b3c4d\"; includes its runs and native transcript"),
  agent: z.enum(["claude", "codex", "opencode", "antigravity", "other"]).optional().describe("Only records of this agent kind"),
  kind: z.enum(["message", "run", "decision", "transcript", "approval", "progress", "report", "question"]).optional()
    .describe("message: bridge mail; run: delegated run logs; decision: pinned owner decisions (all revisions); transcript: native CLI chats; approval: permission requests; progress: job progress notes; report: final job reports; question: owner questions and answers"),
  since: dateFilter.optional().describe("Not before: epoch milliseconds or ISO 8601 with offset, e.g. \"2026-10-14T00:00:00+09:00\""),
  until: dateFilter.optional().describe("Not after; same formats as since"),
}).strict();
export const historySearchSchema = z.object({
  query: z.string().trim().min(1).max(HISTORY_MAX_QUERY_CHARS),
  filters: historyFiltersSchema.optional(), limit: z.number().int().min(1).max(HISTORY_MAX_LIMIT).optional(),
}).strict().refine((a) => a.filters?.since === undefined || a.filters.until === undefined || a.filters.since <= a.filters.until, "since must not be later than until");
export type HistorySearch = z.input<typeof historySearchSchema>;
export interface HistoryHit {
  id: string; kind: "message" | "run" | "decision" | "transcript" | "approval" | "progress" | "report" | "question"; agent: string; at: number;
  snippet: string; link: string; sourceLink: string; message: string | null; job: string | null; run: string | null;
  session: string | null; cursor: string | null; conversation?: string | null; project?: string | null;
}
export interface HistoryResult {
  engine: "fts5" | "plain"; hits: HistoryHit[];
  /** Set while results come from the legacy store because the history store migration has not finished (AB-224). */
  migration?: { ready: false; readsFrom: "legacy"; phase: string; percent: number; error: string | null; notice: string };
}
