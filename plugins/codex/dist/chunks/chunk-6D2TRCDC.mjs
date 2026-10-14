import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  conversationProject,
  external_exports
} from "./chunk-EA6YAI7Y.mjs";

// src/core/history-query.ts
var HISTORY_MAX_QUERY_CHARS = 1e3;
var HISTORY_MAX_LIMIT = 50;
var HISTORY_FILTER_ID_CHARS = 256;
var dateFilter = external_exports.union([external_exports.number().int().nonnegative(), external_exports.iso.datetime({ offset: true })]).transform((v) => typeof v === "number" ? v : Date.parse(v));
var historyFiltersSchema = external_exports.object({
  project: external_exports.string().min(1).max(4096).transform(conversationProject).optional().describe("Project folder (absolute path, e.g. your cwd); drive aliases of the same folder match"),
  session: external_exports.string().min(1).max(HISTORY_FILTER_ID_CHARS).optional().describe('Session peer name or CLI session id, e.g. "codex-myrepo"'),
  job: external_exports.string().min(1).max(HISTORY_FILTER_ID_CHARS).optional().describe('Delegated job name, e.g. "codex-job-1a2b3c4d"; includes its runs and native transcript'),
  agent: external_exports.enum(["claude", "codex", "opencode", "antigravity", "other"]).optional().describe("Only records of this agent kind"),
  kind: external_exports.enum(["message", "run", "decision", "transcript", "approval", "progress", "report", "question"]).optional().describe("message: bridge mail; run: delegated run logs; decision: pinned owner decisions (all revisions); transcript: native CLI chats; approval: permission requests; progress: job progress notes; report: job reports and retained job snapshots, including still-running jobs (check the job status before treating a hit as final); question: owner questions and answers"),
  since: dateFilter.optional().describe('Not before: epoch milliseconds or ISO 8601 with offset, e.g. "2026-10-14T00:00:00+09:00"'),
  until: dateFilter.optional().describe("Not after; same formats as since")
}).strict();
var historySearchSchema = external_exports.object({
  query: external_exports.string().trim().min(1).max(HISTORY_MAX_QUERY_CHARS),
  filters: historyFiltersSchema.optional(),
  limit: external_exports.number().int().min(1).max(HISTORY_MAX_LIMIT).optional()
}).strict().refine((a) => a.filters?.since === void 0 || a.filters.until === void 0 || a.filters.since <= a.filters.until, "since must not be later than until");

export {
  HISTORY_MAX_QUERY_CHARS,
  HISTORY_MAX_LIMIT,
  historyFiltersSchema,
  historySearchSchema
};
