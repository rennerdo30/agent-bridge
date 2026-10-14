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
    .describe("message: bridge mail; run: delegated run logs; decision: pinned owner decisions (all revisions); transcript: native CLI chats; approval: permission requests; progress: job progress notes; report: job reports and retained job snapshots, including still-running jobs (check the job status before treating a hit as final); question: owner questions and answers"),
  since: dateFilter.optional().describe("Not before: epoch milliseconds or ISO 8601 with offset, e.g. \"2026-10-14T00:00:00+09:00\""),
  until: dateFilter.optional().describe("Not after; same formats as since"),
}).strict();
/** Published search_history tool description; agents rely on it, so it must match terms()/search() in history.ts. */
export const HISTORY_SEARCH_TOOL_DESCRIPTION =
  "Search local bridge messages (including archives), owner decisions and questions, delegated run logs and job reports, and native Claude, Codex, opencode and Antigravity transcripts. " +
  "Use it before starting or resuming work, after a handoff or restart, and whenever someone refers to an earlier decision, job, branch or message: search instead of guessing or reading log files. " +
  "The query is split into at most 32 literal word/number tokens that must all match, in any order. Punctuation and quotes are dropped, and words such as OR or AND are searched as ordinary words, not operators. " +
  "Put ids that scope the search (job, session, project) into filters, not only into the query. " +
  "Returns bounded snippets with stable source ids and links; pass a hit's conversation to get_conversation to read the whole thread. " +
  "Ordinary search makes no model calls. answer=true explicitly spends model tokens on a configured cheap model chosen by availability and usage_limits. Indexing is incremental; use agent-bridge reindex to rebuild.";

/** Published search_history input shape (the MCP SDK takes a raw shape). */
export const historySearchToolInput = {
  query: z.string().trim().min(1).max(HISTORY_MAX_QUERY_CHARS)
    .describe("Words that must all appear, in any order; punctuation and quotes are dropped and OR/AND are ordinary words. Example: branch limit. Scope by job, session or project with filters"),
  filters: historyFiltersSchema.optional(),
  limit: z.number().int().min(1).max(HISTORY_MAX_LIMIT).optional().describe(`Maximum hits (1-${HISTORY_MAX_LIMIT}); raise it for broad questions`),
  answer: z.boolean().optional().describe("Also summarize the hits with a cheap model (spends tokens); default false"),
};

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
