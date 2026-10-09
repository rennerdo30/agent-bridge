import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  conversationProject
} from "./chunk-CUZHUOFY.mjs";
import {
  external_exports
} from "./chunk-FDMEMG4Z.mjs";

// src/core/history-query.ts
var HISTORY_MAX_QUERY_CHARS = 1e3;
var HISTORY_MAX_LIMIT = 50;
var HISTORY_FILTER_ID_CHARS = 256;
var dateFilter = external_exports.union([external_exports.number().int().nonnegative(), external_exports.iso.datetime({ offset: true })]).transform((v) => typeof v === "number" ? v : Date.parse(v));
var historyFiltersSchema = external_exports.object({
  project: external_exports.string().min(1).max(4096).transform(conversationProject).optional(),
  session: external_exports.string().min(1).max(HISTORY_FILTER_ID_CHARS).optional(),
  job: external_exports.string().min(1).max(HISTORY_FILTER_ID_CHARS).optional(),
  agent: external_exports.enum(["claude", "codex", "opencode", "antigravity", "other"]).optional(),
  kind: external_exports.enum(["message", "run", "decision", "transcript", "approval", "progress", "report", "question"]).optional(),
  since: dateFilter.optional(),
  until: dateFilter.optional()
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
