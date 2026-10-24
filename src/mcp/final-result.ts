/** A runner's terminal result remains in its durable state until a broker receipt is saved. */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readRunnerState } from "./job-host.js";
import { resolveDbPath } from "../core/paths.js";
import { archiveDbPath } from "../core/sqlite-maintenance.js";
import { PROTOCOL_VERSION } from "../core/constants.js";
import { deliveryFailure, type FinalDeliveryOutcome } from "./delivery-evidence.js";
export interface StoredFinalResult {
  report: string;
  reportId: string;
  /** The broker acknowledged durable storage, not necessarily parent consumption. */
  delivered: boolean;
}

const MAX_BACKOFF_MS = 30_000;
const MAX_DELIVERY_ATTEMPTS = 6;
/** Refusals that no retry can fix: the session fallback must take over at once. */
export const PERMANENT_DELIVERY_CODES: ReadonlySet<string> = new Set(["unauthorized", "not_found", "bad_request", "too_large", "forbidden", "protocol_mismatch"]);
export function compatibleDeliveryHandover(error: unknown): boolean {
  const value = error as { code?: unknown; details?: { handover?: unknown; brokerProtocol?: unknown } } | null;
  return value?.code === "protocol_mismatch" && value.details?.handover === true && value.details.brokerProtocol === PROTOCOL_VERSION;
}
export function permanentDeliveryRefusal(error: unknown): boolean {
  return PERMANENT_DELIVERY_CODES.has((error as { code?: string } | null)?.code ?? "") && !compatibleDeliveryHandover(error);
}

/**
 * Persist before the first send. Bound retries so the session can settle and post a retained result.
 * `shutdown` is the runner's own shutdown, never a turn's cancel signal: a cancelled turn still has a final report.
 * Even when shutdown has begun, the report is persisted and sent once; shutdown only ends further retries.
 */
export async function deliverFinalResult(
  result: StoredFinalResult,
  persist: (result: StoredFinalResult) => void,
  send: (report: string, reportId: string) => Promise<{ stored: boolean } | null>,
  wait: (ms: number) => Promise<void>,
  shutdown?: AbortSignal,
  alreadyStored?: (reportId: string) => Promise<boolean>,
): Promise<FinalDeliveryOutcome> {
  if (result.delivered===true) return { state: "stored", cause: "previous-receipt", attempt: 0, persisted: true };
  let persisted = false, failure: unknown;
  const retained = (cause: FinalDeliveryOutcome["cause"], attempt: number): FinalDeliveryOutcome => ({
    state: persisted ? "retained" : "unretained", cause, attempt, persisted, ...(failure ? deliveryFailure(failure) : {}),
  });
  let backoff = 1_000;
  // Never send before the runner state holds the report for session fallback.
  for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
    try { persist(result); persisted = true; break; }
    catch (error) {
      failure = error;
      // Exhaustion retains an explicit unretained outcome; it cannot authorize output.
      if (attempt === MAX_DELIVERY_ATTEMPTS - 1 || shutdown?.aborted) break;
      await wait(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
  if(!persisted)return retained(shutdown?.aborted?'shutdown':'attempts-exhausted',MAX_DELIVERY_ATTEMPTS);
  const markDelivered = () => {
    try { persist({ ...result, delivered: true }); persisted = true; }
    catch { /* The broker holds the result; the same completion ID dedupes a session fallback. */ }
  };
  backoff = 1_000;
  for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
    try {
      let found = false;
      try { found = alreadyStored ? await alreadyStored(result.reportId) : false; }
      catch { /* Older or restarting brokers still accept the stable send identity. */ }
      if (found===true) { markDelivered(); return { state: "stored", cause: "receipt-probe", attempt: attempt + 1, persisted }; }
      const receipt = await send(result.report, result.reportId);
      if (receipt?.stored===true) { markDelivered(); return { state: "stored", cause: "send-receipt", attempt: attempt + 1, persisted }; }
    } catch (error) {
      failure = error;
      if (permanentDeliveryRefusal(error)) return retained("permanent-refusal", attempt + 1);
      // The result is retained; the next attempt uses the same id.
    }
    if (shutdown?.aborted || attempt === MAX_DELIVERY_ATTEMPTS - 1) return retained(shutdown?.aborted ? "shutdown" : "attempts-exhausted", attempt + 1);
    await wait(backoff);
    if (shutdown?.aborted) return retained("shutdown", attempt + 1);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
  return retained("attempts-exhausted", MAX_DELIVERY_ATTEMPTS);
}

/** A broker storage acknowledgement alone does not prove that the parent received the result. */
export function resultDeliveryLabel(result: Pick<StoredFinalResult, "report"> | null, readReceipt: boolean): string | null {
  if (!result?.report) return null;
  return readReceipt ? "delivered" : "result stored, not delivered";
}

/** Job status can serve a result even while the broker is unavailable. */
export function readStoredFinalResult(home: string, id: string): StoredFinalResult | null {
  const state = readRunnerState(home, id);
  return state && typeof state.report === "string" && typeof state.reportId === "string"
    ? { report: state.report, reportId: state.reportId, delivered: state.delivered === true }
    : null;
}

/**
 * A finished job's report text for peers(job=...). jobs.json keeps only resultStored and reportId, so the text
 * comes from the runner state (hosted jobs) or the message store, including its archive, by report message id.
 */
export function readJobReport(home: string, job: { id: string; resultStored?: boolean; reportId?: string }): string | null {
  try {
    const stored = readStoredFinalResult(home, job.id);
    if (stored) return stored.report;
  } catch { /* The message store may still hold the report. */ }
  if (!job.reportId) return null;
  const path = resolveDbPath(home);
  for (const file of [path, archiveDbPath(path)]) {
    if (!existsSync(file)) continue;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: true, timeout: 50 });
      for (const table of ["messages", "archived_messages"]) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
        const row = db.prepare(`SELECT body FROM ${table} WHERE id = ? LIMIT 1`).get(job.reportId) as { body?: unknown } | undefined;
        if (typeof row?.body === "string") return row.body;
      }
    } catch { /* Unavailable evidence: try the other store. */ }
    finally { db?.close(); }
  }
  return null;
}
