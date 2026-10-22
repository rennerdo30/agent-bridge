import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LOG_DIR_NAME, LOG_FILE_NAME } from "../src/core/constants.js";
import { pidAlive } from "../src/core/delegate.js";

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
  const text = typeof value === "string" ? value : "";
  if (/Proven local job report grant is unavailable/.test(text)) return "local-report-grant-unproven";
  if (/Original local remote-proxy report ownership/.test(text)) return "remote-proxy-report-owner-unproven";
  if (/Original job reporter identity/.test(text)) return "reporter-replaced";
  if (/destination.*(retained|changed|missing)/i.test(text)) return "destination-unavailable";
  if (/registration|queue.*changed/i.test(text)) return "registration-fence";
  if (/SQLITE_BUSY|database is (?:locked|busy)/i.test(text)) return "sqlite-writer-blocked";
  if (/timed? ?out|deadline/i.test(text)) return "deadline";
  if (/closed|disconnect/i.test(text)) return "connection-closed";
  return "other";
}
export function jobWaitEvents(home: string, ids: readonly string[]) {
  const known = ids.filter(id => /^[a-f0-9]{8}$/.test(id)).slice(0, 10);
  return (boundedText(join(home, LOG_DIR_NAME, LOG_FILE_NAME), 256 * 1024, true) ?? "").split("\n").flatMap(line => {
    const match = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+\w+\s+\[[^\]]+\] pid=(\d+) (job process ownership established|job runner started|job runner done|request rejected|inline report delivery failed; retained for replay)(?: (\{.*\}))?$/.exec(line);
    if (!match || match[1]!.length > 32 || !Number.isFinite(Date.parse(match[1]!))) return [];
    let fields: Record<string, any> = {};
    try { if (match[4]) fields = JSON.parse(match[4]); } catch { return []; }
    if (!object(fields) || match[3] === "request rejected" && !["hello", "inlineJobReport", "trackedSend", "remoteJob"].includes(fields.op)) return [];
    const job = known.find(id => line.includes(`-job-${id}`)), pid = Number(match[2]);
    return [{ at: match[1], event: match[3], pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined, job,
      ...(match[3] === "job runner done" ? { status: status(fields.status), delivered: fields.delivered === true } : {}),
      ...(["request rejected", "inline report delivery failed; retained for replay"].includes(match[3]!) ? { reason: reason(fields.message ?? fields.err),
        code: ["unauthorized", "bad_request", "not_registered", "job_index_preparing"].includes(fields.code) ? fields.code : "other" } : {}) }];
  }).slice(-40);
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
    return { id, local: local ? { status: status(local.status), remoteAddress: object(local.remote), explicitRemote: typeof local.args?.host === "string",
      waitingForStart: local.waitingForStart === true, hostRecorded: object(local.host), deliveryOwner: typeof local.deliveryOwner === "string",
      reportEnvelopes: Array.isArray(local.deliveryHistory) ? Math.min(100, local.deliveryHistory.length) : 0,
      reportGrants: object(local.reportRouting) ? Math.min(100, Object.keys(local.reportRouting).length) : 0 } : null,
      remote: hosted ? { status: status(hosted.job.status), pairedOrigin: typeof hosted.pair === "string", peerOrigin: typeof hosted.peer === "string",
        ownerRecorded: typeof hosted.owner === "string", supervisorRecorded: typeof hosted.job.supervisor === "string" } : null,
      cache: snapshot ? { status: status(snapshot.state?.status), alive: snapshot.alive === true, session: typeof snapshot.state?.sessionId === "string" } : null,
      runnerEvidence,
      runner: runner ? { status: status(runner.status), pid: Number.isSafeInteger(runner.pid) && runner.pid > 0 ? runner.pid : undefined,
        alive: Number.isSafeInteger(runner.pid) && runner.pid > 0 && pidAlive(runner.pid), identityRecorded: typeof runner.identity === "string",
        session: Boolean(runner.sessionId), live: runner.live === true, delivered: runner.delivered === true, reportPresent: Boolean(runner.report),
        progress: ["queued: runner startup admission", "preparing run context", "queued: waiting for root admission", "queued: waiting for machine startup admission", "starting native CLI", "queued: waiting for compatible storage readers to retain run context"].includes(runner.progress ?? "") ? runner.progress : "other" } : null };
  }), events: jobWaitEvents(home, ids) };
  } finally { try { db?.close(); } catch { /* Preserve the actual test failure. */ } }
}
