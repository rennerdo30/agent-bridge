import { z } from "zod";
import { isSqliteBusy } from "../core/sqlite-policy.js";

const failureCode = z.enum(["unauthorized", "unknown_target", "job_index_preparing", "internal", "timeout", "bad_request", "too_large", "forbidden", "not_found",
  "not_registered", "protocol_mismatch", "ambiguous_target", "ELEASEBUSY", "OWNER_QUIESCED", "OWNER_UNAVAILABLE", "STORE_UPGRADE_DEFERRED", "STORE_READER_ACTIVE",
  "STORE_OFFLINE_REQUIRED", "SQLITE_BUSY", "SQLITE_LOCKED", "ERR_SQLITE_ERROR", "other"]);

/** Diagnostic only: never ownership, routing, receipt or liveness authority. */
export const deliveryEvidenceSchema = z.object({
  kind: z.enum(["message", "note", "question", "final"]),
  stage: z.enum(["queued", "receipt-probe", "receipt-failed", "sending", "retrying", "refused", "stored"]),
  messageId: z.uuid(), at: z.number().int().nonnegative(), attempt: z.number().int().min(1).max(30),
  finalQueued: z.boolean(),
  code: failureCode.optional(),
  reason: z.enum(["unretained-destination", "job-grant-unproven", "job-authority-unavailable", "registration-unavailable", "writer-busy",
    "metadata-owner-unavailable", "connection-unavailable", "request-deadline", "owner-quiesced", "retained-content-mismatch", "runtime-type-error",
    "storage-admission-deferred", "storage-version-unavailable", "owner-unavailable", "ownership-proof-conflict", "mailbox-provenance-unproven", "job-route-unproven",
    "job-route-changed", "destination-binding-changed", "protocol-refusal", "admission-cancelled", "other"]).optional(),
}).strict();
export type DeliveryEvidence = z.infer<typeof deliveryEvidenceSchema>;
export function deliveryFailure(error: unknown): Pick<DeliveryEvidence, "code" | "reason"> {
  const candidate = error as { code?: unknown; message?: unknown; name?: unknown } | null;
  const parsedCode = failureCode.safeParse(candidate?.code);
  const code = parsedCode.success ? parsedCode.data : "other";
  const message = typeof candidate?.message === "string" ? candidate.message.slice(0, 4096) : "";
  // These are exact application error families, not copied exception text.
  // Classification is diagnostic only and never permits routing or recovery.
  const reason = code === "ELEASEBUSY" || /metadata lease has (?:a )?live or unknown owner|own process identity is unavailable/i.test(message) ? "metadata-owner-unavailable" :
    ["STORE_UPGRADE_DEFERRED", "STORE_READER_ACTIVE", "STORE_OFFLINE_REQUIRED"].includes(code) || /Waiting for metadata upgrade|Mailbox migration exclusion is unavailable|Mailbox changed after inspection/.test(message) ? "storage-admission-deferred" :
    /unsupported (?:JSON store|job archive) version|Metadata store is newer than this reader/.test(message) ? "storage-version-unavailable" :
    code === "OWNER_QUIESCED" || /OWNER_QUIESCED|owner.*quiesc|store producer is quiesced/i.test(message) ? "owner-quiesced" :
    code === "OWNER_UNAVAILABLE" || /store ownership cannot resume/.test(message) ? "owner-unavailable" :
    /Original destination was not retained/.test(message) ? "unretained-destination" :
    /(?:Retained (?:sender|destination) namespace is unproven|Local mailbox namespace is unavailable|Envelope belongs to a different local store namespace|Sender belongs to a different local store namespace|Remote receipt provenance is missing)/.test(message) ? "mailbox-provenance-unproven" :
    /Job report route changed during succession|Original job report grant or accepted bytes changed|Job dispatch request does not match the proven report sender/.test(message) ? "job-route-changed" :
    /Historical job route provenance is unproven|Existing ungranted job evidence remains pending|Job delivery has no matching proven local copy/.test(message) ? "job-route-unproven" :
    /Retained message ownership cannot be overwritten|Retained send ownership does not match this frontend|Pending send belongs to the original registration/.test(message) ? "ownership-proof-conflict" :
    /job report grant|supervisor binding/i.test(message) ? "job-grant-unproven" :
    code === "job_index_preparing" || /job (?:routing authority|ownership) is unavailable|Job authority unavailable|authority_store_read|authority_fence/.test(message) ? "job-authority-unavailable" :
    code === "not_registered" || /registration.*(?:ready|changed|unavailable)|Session changed while queued/.test(message) ? "registration-unavailable" :
    /already (?:stored|retained|pending) with different|accepted bytes changed/i.test(message) ? "retained-content-mismatch" :
    /Original authenticated remote host or destination binding changed|Original remote supervisor ownership is unproven|Current ownership would redirect an original remote send/.test(message) ? "destination-binding-changed" :
    code === "protocol_mismatch" ? "protocol-refusal" :
    isSqliteBusy(error) || /database is busy/.test(message) ? "writer-busy" :
    /connection closed|broker.*(?:unreachable|not reachable)|not connected/i.test(message) ? "connection-unavailable" :
    /broker request timed out|connect timeout|timed out connecting/i.test(message) ? "request-deadline" :
    candidate?.name === "AbortError" ? "admission-cancelled" :
    candidate?.name === "TypeError" || /Cannot (?:read properties|access .+ before initialization)/.test(message) ? "runtime-type-error" : "other";
  return { code, reason };
}
