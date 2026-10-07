import { createHash } from "node:crypto";

/** One opaque UUID per runner turn, shared by broker delivery and supervisor fallback.
 * A slow acknowledgement or a stale final-state read must not create a second report.
 */
export function completionMessageId(sender: string, reportId: string): string {
  const hex = createHash("sha256").update(JSON.stringify(["job-completion", sender, reportId])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export const COMPLETION_DEDUPE_PREFIX = "job-completion:";
