/** A runner's terminal result remains in its durable state until a broker receipt is saved. */
import { readRunnerState } from "./job-host.js";
export interface StoredFinalResult {
  report: string;
  reportId: string;
  /** The broker acknowledged durable storage, not necessarily parent consumption. */
  delivered: boolean;
}

const MAX_BACKOFF_MS = 30_000;
const MAX_DELIVERY_ATTEMPTS = 6;
const PERMANENT_DELIVERY_CODES = new Set(["unauthorized", "not_found", "bad_request", "too_large", "forbidden"]);

/** Persist before the first send. Bound retries so the session can settle and post a retained result. */
export async function deliverFinalResult(
  result: StoredFinalResult,
  persist: (result: StoredFinalResult) => void,
  send: (report: string, reportId: string) => Promise<{ stored: boolean } | null>,
  wait: (ms: number) => Promise<void>,
  signal?: AbortSignal,
  alreadyStored?: (reportId: string) => Promise<boolean>,
): Promise<void> {
  if (result.delivered) return;
  let backoff = 1_000;
  // Never send before the runner state holds the report for session fallback.
  for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS && !signal?.aborted; attempt++) {
    try { persist(result); break; }
    catch { if (attempt === MAX_DELIVERY_ATTEMPTS - 1) return; await wait(backoff); backoff = Math.min(backoff * 2, MAX_BACKOFF_MS); }
  }
  if (signal?.aborted) return;
  backoff = 1_000;
  for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS && !signal?.aborted; attempt++) {
    try {
      let found = false;
      try { found = alreadyStored ? await alreadyStored(result.reportId) : false; }
      catch { /* Older or restarting brokers still accept the stable send identity. */ }
      if (found) {
        persist({ ...result, delivered: true });
        return;
      }
      const receipt = await send(result.report, result.reportId);
      if (receipt?.stored) {
        persist({ ...result, delivered: true });
        return;
      }
    } catch (error) {
      if (PERMANENT_DELIVERY_CODES.has((error as { code?: string } | null)?.code ?? "")) return;
      // The result is retained; the next attempt uses the same id.
    }
    if (signal?.aborted) return;
    if (attempt === MAX_DELIVERY_ATTEMPTS - 1) return;
    await wait(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
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
