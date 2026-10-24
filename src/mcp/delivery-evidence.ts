import { types } from "node:util";
import { z } from "zod";
import { isSqliteBusy } from "../core/sqlite-policy.js";

const failureCode = z.enum(["unauthorized", "unknown_target", "job_index_preparing", "internal", "timeout", "bad_request", "too_large", "forbidden", "not_found",
  "not_registered", "protocol_mismatch", "ambiguous_target", "ELEASEBUSY", "OWNER_QUIESCED", "OWNER_UNAVAILABLE", "STORE_UPGRADE_DEFERRED", "STORE_READER_ACTIVE",
  "STORE_OFFLINE_REQUIRED", "SQLITE_BUSY", "SQLITE_LOCKED", "ERR_SQLITE_ERROR", "other"]);
const protocolEvidenceSchema = z.object({
  source: z.enum(["version", "native-attestation", "frontend-attestation", "mailbox-attestation", "schema-admission", "unsupported-operation", "handover", "prior-endpoint", "storage-reader", "legacy-storage", "unspecified"]),
  operation: z.enum(["tracked_send", "legacy_send", "auth_hello", "ack", "status_read", "other"]).optional(),
  connectionGeneration: z.number().int().min(1).max(2_147_483_647).optional(),
  clientProtocol: z.number().int().min(0).max(65_535).optional(), brokerProtocol: z.number().int().min(0).max(65_535).optional(),
}).strict();

/** Diagnostic only: never ownership, routing, receipt or liveness authority. */
export const deliveryEvidenceSchema = z.object({
  kind: z.enum(["message", "note", "question", "final"]),
  stage: z.enum(["queued", "receipt-probe", "receipt-failed", "sending", "retrying", "refused", "stored"]),
  messageId: z.uuid(), at: z.number().int().nonnegative(), attempt: z.number().int().min(1).max(30),
  finalQueued: z.boolean(),
  code: failureCode.optional(),
  protocol: protocolEvidenceSchema.optional(),
  reason: z.enum(["unretained-destination", "job-grant-unproven", "job-authority-unavailable", "registration-unavailable", "writer-busy",
    "metadata-owner-unavailable", "connection-unavailable", "request-deadline", "owner-quiesced", "retained-content-mismatch", "runtime-type-error",
    "storage-admission-deferred", "storage-version-unavailable", "owner-unavailable", "ownership-proof-conflict", "mailbox-provenance-unproven", "job-route-unproven",
    "job-route-changed", "destination-binding-changed", "protocol-refusal", "admission-cancelled", "other"]).optional(),
}).strict();
export type DeliveryEvidence = z.infer<typeof deliveryEvidenceSchema>;
export const finalDeliverySettlementSchema = z.object({
  messageId: z.uuid(), at: z.number().int().nonnegative(),
  state: z.enum(["stored", "retained", "unretained"]),
  cause: z.enum(["previous-receipt", "receipt-probe", "send-receipt", "permanent-refusal", "attempts-exhausted", "shutdown"]),
  attempt: z.number().int().min(0).max(6), persisted: z.boolean(),
  code: failureCode.optional(), reason: deliveryEvidenceSchema.shape.reason, protocol: protocolEvidenceSchema.optional(),
}).strict();
export type FinalDeliveryOutcome = Omit<z.infer<typeof finalDeliverySettlementSchema>, "messageId" | "at">;

// Diagnostics must not invoke exception getters, proxy traps or coercion hooks.
function dataField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function errorName(error: unknown): unknown {
  const ownName = dataField(error, "name");
  if (ownName !== undefined || !types.isNativeError(error)) return ownName;
  // Native Error names normally live on their prototype. Only inspect bounded
  // data descriptors; a custom subclass/prototype cannot introduce getter calls.
  let prototype: object | null = error as object;
  for (let depth = 0; depth < 4 && prototype && !types.isProxy(prototype); depth++) {
    const name = dataField(prototype, "name");
    if (name !== undefined) return name;
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return undefined;
}

export function deliveryFailure(error: unknown): Pick<DeliveryEvidence, "code" | "reason" | "protocol"> {
  const rawCode = dataField(error, "code"), rawMessage = dataField(error, "message"), rawErrcode = dataField(error, "errcode");
  const boundedCode = typeof rawCode === "string" && rawCode.length <= 64 ? rawCode : "";
  const parsedCode = failureCode.safeParse(boundedCode);
  const code = parsedCode.success ? parsedCode.data : "other";
  const message = typeof rawMessage === "string" ? rawMessage.slice(0, 4096) : "";
  const name = errorName(error);
  // Only the primary busy/locked numeric codes understood by isSqliteBusy are
  // admitted. No numeric coercion, fractions, nonfinite or extended-code guessing.
  const errcode = typeof rawErrcode === "number" && Number.isInteger(rawErrcode) && (rawErrcode === 5 || rawErrcode === 6) ? rawErrcode : undefined;
  const sqliteCode = parsedCode.success || /^(?:SQLITE_BUSY|SQLITE_LOCKED)(?:_[A-Z][A-Z0-9_]{0,47})?$/.test(boundedCode) ? boundedCode : "other";
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
    isSqliteBusy({ code: sqliteCode, errcode, message }) || /database is busy/.test(message) ? "writer-busy" :
    /connection closed|broker.*(?:unreachable|not reachable)|not connected/i.test(message) ? "connection-unavailable" :
    /broker request timed out|connect timeout|timed out connecting/i.test(message) ? "request-deadline" :
    name === "AbortError" ? "admission-cancelled" :
    name === "TypeError" || /Cannot (?:read properties|access .+ before initialization)/.test(message) ? "runtime-type-error" : "other";
  if (code !== "protocol_mismatch") return { code, reason };
  const source = /broker speaks protocol/.test(message) ? "version" : /did not attest the exact native identity/.test(message) ? "native-attestation" :
    /did not attest the exact T3 frontend/.test(message) ? "frontend-attestation" : /lacks schema15 local mailbox provenance/.test(message) ? "mailbox-attestation" :
    /requires schema15 ownership/.test(message) ? "schema-admission" : /unknown op:|does not support \w+ required/.test(message) ? "unsupported-operation" :
    /broker is stopping/.test(message) ? "handover" :
    /Prior Core endpoint .* is retained by an unproven storage reader;/.test(message) ? "storage-reader" :
    /Prior Core endpoint .* is (?:a pre-lease schema2\/3 store|a component[12] metadata store)/.test(message) ? "legacy-storage" :
    /Prior Core endpoint .* is (?:unresponsive|active|inaccessible|not a verified private socket)/.test(message) ? "prior-endpoint" : "unspecified";
  const observed = dataField(dataField(error, "details"), "protocolObservation");
  const protocol: z.infer<typeof protocolEvidenceSchema> = { source };
  const operation = dataField(observed, "operation");
  if (["tracked_send", "legacy_send", "auth_hello", "ack", "status_read", "other"].some(value => value === operation)) protocol.operation = operation as NonNullable<typeof protocol.operation>;
  for (const key of ["connectionGeneration", "clientProtocol", "brokerProtocol"] as const) {
    const value = dataField(observed, key), max = key === "connectionGeneration" ? 2_147_483_647 : 65_535;
    if (typeof value === "number" && Number.isInteger(value) && value >= (key === "connectionGeneration" ? 1 : 0) && value <= max) protocol[key] = value;
  }
  return { code, reason, protocol };
}
