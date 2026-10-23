import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LOG_DIR_NAME, LOG_FILE_NAME } from "../src/core/constants.js";
import { pidAlive } from "../src/core/delegate.js";
import { deliveryEvidenceSchema, deliveryFailure, finalDeliverySettlementSchema } from "../src/mcp/delivery-evidence.js";

/** Fixture-only evidence, never a recovery/ownership decision. All reads are
 * bounded and output is allowlisted: no prompts, bodies, env, tokens or specs. */
function boundedText(file: string, limit: number, tail = false): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r"); const size = fstatSync(fd).size;
    if (!tail && size > limit) return undefined;
    const start = tail ? Math.max(0, size - limit) : 0, buffer = Buffer.alloc(Math.min(size, limit));
    const read = readSync(fd, buffer, 0, buffer.length, start), text = buffer.subarray(0, read).toString("utf8");
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } catch { return undefined; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* Original test failure wins. */ } }
}
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function document(home: string, file: string): Record<string, any> | undefined {
  try { const value: unknown = JSON.parse(boundedText(join(home, file), 2 * 1024 * 1024) ?? "null"); return object(value) ? value : undefined; }
  catch { return undefined; }
}
const statuses = new Set(["running", "paused", "done", "failed", "cancelled", "interrupted"]);
const status = (value: unknown) => typeof value === "string" && statuses.has(value) ? value : "unknown";
function reason(value: unknown): string {
  const text = typeof value === "string" ? value.slice(0, 4096) : "";
  if (/Proven local job report grant is unavailable/.test(text)) return "local-report-grant-unproven";
  if (/Original local remote-proxy report ownership/.test(text)) return "remote-proxy-report-owner-unproven";
  if (/Original job reporter identity/.test(text)) return "reporter-replaced";
  if (/destination.*(retained|changed|missing)/i.test(text)) return "destination-unavailable";
  if (/registration|queue.*changed/i.test(text)) return "registration-fence";
  if (/SQLITE_BUSY|database is (?:locked|busy)/i.test(text)) return "sqlite-writer-blocked";
  if (/timed? ?out|deadline/i.test(text)) return "deadline";
  if (/closed|disconnect/i.test(text)) return "connection-closed";
  return deliveryFailure({ message: text }).reason ?? "other";
}
export function jobWaitEvents(home: string, ids: readonly string[]) {
  const known = ids.filter(id => /^[a-f0-9]{8}$/.test(id)).slice(0, 10);
  return (boundedText(join(home, LOG_DIR_NAME, LOG_FILE_NAME), 256 * 1024, true) ?? "").split("\n").flatMap(line => {
    const match = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+\w+\s+\[[^\]]+\] pid=(\d+) (job process ownership established|job runner started|job runner done|job runner delivery unsettled|job delivery evidence|job final delivery settled|client protocol refusal observation|broker refused this peer|could not deliver to the session; retrying|request rejected|inline report delivery failed; retained for replay|remote approval answer refused)(?: (\{.*\}))?$/.exec(line);
    if (!match || match[1]!.length > 32 || !Number.isFinite(Date.parse(match[1]!))) return [];
    let fields: Record<string, any> = {};
    try { if (match[4]) fields = JSON.parse(match[4]); } catch { return []; }
    if (!object(fields) || match[3] === "request rejected" && !["hello", "inlineJobReport", "trackedSend", "remoteJob"].includes(fields.op)) return [];
    const job = known.find(id => line.includes(`-job-${id}`)), pid = Number(match[2]);
    const delivery = match[3] === "job delivery evidence" ? deliveryEvidenceSchema.safeParse(fields) : undefined;
    const finalDelivery = match[3] === "job final delivery settled" ? finalDeliverySettlementSchema.safeParse(fields) : undefined;
    const failure = deliveryFailure({ code: fields.code, message: fields.message ?? fields.err, details: { protocolObservation: fields.protocolObservation } });
    const coarse = reason(fields.message ?? fields.err);
    return [{ at: match[1], event: match[3], pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined, job,
      ...(match[3] === "job runner done" ? { status: status(fields.status), delivered: fields.delivered === true } : {}),
      ...(match[3] === "job runner delivery unsettled" ? { retentionFailure: ["attempts-exhausted", "shutdown", "invalid-evidence"].includes(fields.reason) ? fields.reason : "other",
        pending: Number.isSafeInteger(fields.pending) && fields.pending >= 0 ? Math.min(65_535, fields.pending) : undefined } : {}),
      ...(delivery?.success ? { delivery: delivery.data } : {}),
      ...(finalDelivery?.success ? { finalDelivery: finalDelivery.data } : {}),
      ...(match[3] === "remote approval answer refused" ? {
        stage: ["executor-lookup", "executor-relay", "requester-deadline", "requester-rpc"].includes(fields.stage) ? fields.stage : "unknown",
        outcome: ["expired", "unavailable"].includes(fields.outcome) ? fields.outcome : undefined,
        idPresent: fields.idPresent === true, jobPresent: fields.jobPresent === true, ownerPresent: fields.ownerPresent === true,
      } : {}),
      ...(["request rejected", "client protocol refusal observation", "broker refused this peer", "inline report delivery failed; retained for replay", "could not deliver to the session; retrying"].includes(match[3]!) ? {
        // Retain existing coarse labels where they were already meaningful,
        // alongside the same strict taxonomy used in the actual runner state.
        code: failure.code, reason: coarse !== "other" ? coarse : failure.reason, failure } : {}) }];
  }).slice(-40);
}
/** Failure-only hook evidence from this fixture's exact public peer PID. No
 * session strings, response text, notification content or private errors. */
export function hookPublicationEvents(home: string, pid: number | undefined) {
  if (!Number.isSafeInteger(pid) || !pid || pid < 1) return [];
  return (boundedText(join(home, LOG_DIR_NAME, LOG_FILE_NAME), 128 * 1024, true) ?? "").split("\n").flatMap(line => {
    if (line.length > 8192) return [];
    const match = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+\w+\s+\[[^\]]+\] pid=(\d+) (hook event|hook deferred slow work|hook handler failed|request rejected|broker refused this peer)(?: (\{.*\}))?$/.exec(line);
    if (!match || Number(match[2]) !== pid || match[1]!.length > 32 || !Number.isFinite(Date.parse(match[1]!))) return [];
    let fields: any;
    try { fields = JSON.parse(match[4] ?? "{}"); } catch { return []; }
    return [{ at: match[1], stage: match[3], hook: ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"].includes(fields?.event) ? fields.event : undefined,
      operation: ["hello", "updatePeer"].includes(fields?.op) ? fields.op : undefined,
      failure: deliveryFailure({ code: fields?.code, message: fields?.message ?? fields?.err }) }];
  }).slice(-16);
}
export function jobWaitSnapshot(home: string, ids: readonly string[]) {
  const registry = document(home, "jobs.json"), remote = document(home, "remote-jobs.json");
  let db: DatabaseSync | undefined;
  try { db = new DatabaseSync(join(home, "bridge.db"), { readOnly: true, timeout: 0 }); }
  catch { /* No creating/opening a production metadata writer for diagnostics. */ }
  try {
  return { jobs: ids.filter(id => /^[a-f0-9]{8}$/.test(id)).slice(0, 10).map(id => {
    let runner: Record<string, any> | undefined, runnerEvidence = "unavailable";
    try {
      const row = db?.prepare("SELECT value FROM bridge_metadata WHERE domain='job-state' AND key=? AND length(value)<=2097152").get(id);
      if (row && typeof row.value === "string") { const value: unknown = JSON.parse(row.value); if (object(value)) { runner = value; runnerEvidence = "metadata-row"; } }
    } catch { /* A busy/corrupt/missing table remains unavailable; never import/migrate. */ }
    if (!runner) { runner = document(home, `jobs/${id}.json`); if (runner) runnerEvidence = "file-only"; }
    const local = Array.isArray(registry?.jobs) ? registry.jobs.find((row: any) => object(row) && row.id === id) : undefined;
    const hosted = Array.isArray(remote?.jobs) ? remote.jobs.find((row: any) => object(row) && object(row.job) && row.job.id === id) : undefined;
    const cached = document(home, `remote-job-states/${id}.json`), snapshot = object(cached?.snapshot) ? cached.snapshot : undefined;
    const delivery = deliveryEvidenceSchema.safeParse(runner?.deliveryEvidence);
    const finalDelivery = finalDeliverySettlementSchema.safeParse(runner?.finalDelivery);
    return { id, local: local ? { status: status(local.status), remoteAddress: object(local.remote), explicitRemote: typeof local.args?.host === "string",
      waitingForStart: local.waitingForStart === true, hostRecorded: object(local.host), deliveryOwner: typeof local.deliveryOwner === "string",
      reportEnvelopes: Array.isArray(local.deliveryHistory) ? Math.min(100, local.deliveryHistory.length) : 0,
      reportGrants: object(local.reportRouting) ? Math.min(100, Object.keys(local.reportRouting).length) : 0 } : null,
      remote: hosted ? { status: status(hosted.job.status), pairedOrigin: typeof hosted.pair === "string", peerOrigin: typeof hosted.peer === "string",
        ownerRecorded: typeof hosted.owner === "string", supervisorRecorded: typeof hosted.job.supervisor === "string" } : null,
      cache: snapshot ? { status: status(snapshot.state?.status), alive: snapshot.alive === true, session: typeof snapshot.state?.sessionId === "string" } : null,
      runnerEvidence,
      runner: runner ? { status: status(runner.status), pid: Number.isSafeInteger(runner.pid) && runner.pid > 0 ? runner.pid : undefined,
        ...(delivery.success ? { delivery: delivery.data } : {}),
        ...(finalDelivery.success ? { finalDelivery: finalDelivery.data } : {}),
        retainedDeliveries: typeof runner.retainedDeliveryCount === "number" && Number.isSafeInteger(runner.retainedDeliveryCount) && runner.retainedDeliveryCount >= 0 ? Math.min(65_535, runner.retainedDeliveryCount) : undefined,
        pendingRetentions: Array.isArray(runner.pendingDeliveryRetention) ? Math.min(65_535, runner.pendingDeliveryRetention.length) : 0,
        acceptedDeliveries: Array.isArray(runner.deliveryLedger?.entries) ? Math.min(129, runner.deliveryLedger.entries.length) : undefined,
        inputLedger: object(runner.retainedRunnerInputs) ? {
          phase: ["pending", "admitted", "provider-admitted", "consumed", "evidence"].includes(runner.retainedRunnerInputs.phase) ? runner.retainedRunnerInputs.phase : "unknown",
          batches: Array.isArray(runner.retainedRunnerInputs.batches) ? runner.retainedRunnerInputs.batches.slice(0, 8).map((batch: any) => ({
            phase: ["pending", "admitted", "provider-admitted", "consumed", "evidence"].includes(batch?.phase) ? batch.phase : "unknown",
            inputs: Array.isArray(batch?.bodies) ? Math.min(128, batch.bodies.length) : undefined, controls: Array.isArray(batch?.controls) ? Math.min(128, batch.controls.length) : undefined,
            admitted: object(batch?.admission), result: object(batch?.result) })) : undefined } : undefined,
        retentionFailure: ["attempts-exhausted", "shutdown", "invalid-evidence"].includes(runner.deliveryRetentionFailure) ? runner.deliveryRetentionFailure : undefined,
        alive: Number.isSafeInteger(runner.pid) && runner.pid > 0 && pidAlive(runner.pid), identityRecorded: typeof runner.identity === "string",
        session: Boolean(runner.sessionId), live: runner.live === true, delivered: runner.delivered === true, reportPresent: Boolean(runner.report),
        progress: ["queued: runner startup admission", "preparing run context", "queued: waiting for root admission", "queued: waiting for machine startup admission", "starting native CLI", "queued: waiting for compatible storage readers to retain run context"].includes(runner.progress ?? "") ? runner.progress : "other" } : null };
  }), events: jobWaitEvents(home, ids) };
  } finally { try { db?.close(); } catch { /* Preserve the actual test failure. */ } }
}
