/** A runner's terminal result remains in its durable state until a broker receipt is saved. */
import { readRunnerState } from "./job-host.js";
export interface StoredFinalResult {
  report: string;
  reportId: string;
  /** The broker acknowledged durable storage, not necessarily parent consumption. */
  delivered: boolean;
}

const MAX_BACKOFF_MS = 30_000;

/** Persist before the first send. Retry the same identity until the broker confirms storage. */
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
  // A transient writer failure must hold the report in memory and prevent any send.
  while (!signal?.aborted) {
    try { persist(result); break; }
    catch { await wait(backoff); backoff = Math.min(backoff * 2, MAX_BACKOFF_MS); }
  }
  if (signal?.aborted) return;
  backoff = 1_000;
  while (!signal?.aborted) {
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
    } catch { /* The result is retained; the next attempt uses the same id. */ }
    if (signal?.aborted) return;
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
