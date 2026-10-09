import { createRequire as __abCreateRequire } from 'node:module'; const require = __abCreateRequire(import.meta.url);

// src/core/completion.ts
import { createHash } from "node:crypto";
function completionMessageId(sender, reportId) {
  const hex = createHash("sha256").update(JSON.stringify(["job-completion", sender, reportId])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
var COMPLETION_DEDUPE_PREFIX = "job-completion:";

export {
  completionMessageId,
  COMPLETION_DEDUPE_PREFIX
};
