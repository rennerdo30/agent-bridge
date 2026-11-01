import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  conversationProject,
  external_exports
} from "./chunk-7TGCOQY2.mjs";

// src/core/history-query.ts
var HISTORY_MAX_QUERY_CHARS = 1e3;
var HISTORY_MAX_LIMIT = 50;
var HISTORY_FILTER_ID_CHARS = 256;
var dateFilter = external_exports.union([external_exports.number().int().nonnegative(), external_exports.iso.datetime({ offset: true })]).transform((v) => typeof v === "number" ? v : Date.parse(v));
var historyFiltersSchema = external_exports.object({
  project: external_exports.string().min(1).max(4096).transform(conversationProject).optional().describe("Project folder (absolute path; drive aliases match)"),
  session: external_exports.string().min(1).max(HISTORY_FILTER_ID_CHARS).optional().describe('Session peer name or CLI session id, e.g. "codex-myrepo"'),
  job: external_exports.string().min(1).max(HISTORY_FILTER_ID_CHARS).optional().describe('Delegated job name, e.g. "codex-job-1a2b3c4d"; includes runs and native transcript'),
  agent: external_exports.enum(["claude", "codex", "opencode", "antigravity", "muse", "other"]).optional().describe("Only records of this agent kind"),
  kind: external_exports.enum(["message", "run", "decision", "transcript", "approval", "progress", "report", "question"]).optional().describe("message: bridge mail; run: delegated run logs; decision: owner decisions (all revisions); transcript: native CLI chats; approval: permission requests; progress: job progress notes; report: job reports and snapshots, including still-running jobs (check job status before treating a hit as final); question: owner questions/answers"),
  since: dateFilter.optional().describe('Earliest time: epoch ms or ISO 8601 with offset, e.g. "2026-10-14T00:00:00+09:00"'),
  until: dateFilter.optional().describe("Not after; same formats as since")
}).strict();
var HISTORY_SEARCH_TOOL_DESCRIPTION = "Search local history: bridge messages and archives, owner decisions/questions, delegated run logs and job reports, and native claude/codex/opencode/antigravity/muse transcripts. Use before starting or resuming work, after handoff/restart, and for any reference to an earlier decision, job, branch or message - search, do not guess or read log files. The query splits into at most 32 literal word/number tokens that must all match, in any order; punctuation/quotes are dropped and OR or AND are searched as ordinary words. Put scoping ids (job, session, project) in filters, not only in the query. Returns bounded snippets with stable ids/links; read a whole thread with get_conversation. No model calls unless answer=true, which spends tokens on a configured cheap model. Indexing is incremental; agent-bridge reindex rebuilds it.";
var historySearchToolInput = {
  query: external_exports.string().trim().min(1).max(HISTORY_MAX_QUERY_CHARS).describe("Words that must all appear, in any order; punctuation/quotes dropped, OR/AND are ordinary words. Scope with filters (job, session, project)"),
  filters: historyFiltersSchema.optional(),
  limit: external_exports.number().int().min(1).max(HISTORY_MAX_LIMIT).optional().describe(`Maximum hits (1-${HISTORY_MAX_LIMIT}); raise it for broad questions`),
  answer: external_exports.boolean().optional().describe("Also summarize hits with a cheap model (spends tokens); default false")
};
var historySearchSchema = external_exports.object({
  query: external_exports.string().trim().min(1).max(HISTORY_MAX_QUERY_CHARS),
  filters: historyFiltersSchema.optional(),
  limit: external_exports.number().int().min(1).max(HISTORY_MAX_LIMIT).optional()
}).strict().refine((a) => a.filters?.since === void 0 || a.filters.until === void 0 || a.filters.since <= a.filters.until, "since must not be later than until");

export {
  historyFiltersSchema,
  HISTORY_SEARCH_TOOL_DESCRIPTION,
  historySearchToolInput,
  historySearchSchema
};
