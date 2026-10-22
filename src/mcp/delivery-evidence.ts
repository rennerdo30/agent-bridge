import { z } from "zod";

/** Diagnostic only: never ownership, routing, receipt or liveness authority. */
export const deliveryEvidenceSchema = z.object({
  kind: z.enum(["message", "note", "question", "final"]),
  stage: z.enum(["queued", "receipt-probe", "receipt-failed", "sending", "retrying", "refused", "stored"]),
  messageId: z.uuid(), at: z.number().int().nonnegative(), attempt: z.number().int().min(1).max(30),
  finalQueued: z.boolean(),
  code: z.enum(["unauthorized", "unknown_target", "job_index_preparing", "internal", "timeout", "bad_request", "too_large", "forbidden", "not_found", "other"]).optional(),
  reason: z.enum(["unretained-destination", "job-grant-unproven", "job-authority-unavailable", "registration-unavailable", "writer-busy", "other"]).optional(),
}).strict();
export type DeliveryEvidence = z.infer<typeof deliveryEvidenceSchema>;
export function deliveryFailure(error: unknown): Pick<DeliveryEvidence, "code" | "reason"> {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = typeof candidate?.code === "string" && ["unauthorized", "unknown_target", "job_index_preparing", "internal", "timeout", "bad_request", "too_large", "forbidden", "not_found"].includes(candidate.code)
    ? candidate.code as DeliveryEvidence["code"] : "other";
  const message = typeof candidate?.message === "string" ? candidate.message.slice(0, 4096) : "";
  const reason = /Original destination was not retained/.test(message) ? "unretained-destination" : /job report grant|supervisor binding/i.test(message) ? "job-grant-unproven" :
    /job (?:routing authority|ownership) is unavailable|Job authority unavailable/.test(message) ? "job-authority-unavailable" :
    /registration.*(?:ready|changed|unavailable)|Session changed while queued/.test(message) ? "registration-unavailable" :
    /SQLITE_BUSY|database is (?:busy|locked)/.test(message) ? "writer-busy" : "other";
  return { code, reason };
}
