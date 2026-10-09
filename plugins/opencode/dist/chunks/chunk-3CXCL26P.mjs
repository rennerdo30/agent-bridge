import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);
import {
  external_exports
} from "./chunk-FDMEMG4Z.mjs";

// src/core/conversation-query.ts
var conversationPageSchema = external_exports.object({
  id: external_exports.string().min(1).max(512),
  after: external_exports.number().int().nonnegative().optional(),
  limit: external_exports.number().int().min(1).max(100).optional()
}).strict();

export {
  conversationPageSchema
};
