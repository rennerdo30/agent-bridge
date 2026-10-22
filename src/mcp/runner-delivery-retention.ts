/** Immutable evidence, not an outgoing envelope, receipt or replay grant. */
export interface PendingRunnerRetention { messageId: string; record: string }

export function hasUnsettledRunnerRetention(state: { pendingDeliveryRetention?: PendingRunnerRetention[]; deliveryRetentionFailure?: string } | null | undefined): boolean {
  const pending = state?.pendingDeliveryRetention;
  return Boolean(state?.deliveryRetentionFailure || pending !== undefined && (!Array.isArray(pending) || pending.length));
}

/** A queue-owned failure: later sends must not pass it as an ordinary failed send. */
export class RunnerRetentionUnsettled extends Error {
  readonly code = "RUNNER_RETENTION_UNSETTLED";
  constructor(readonly reason: "attempts-exhausted" | "shutdown" | "invalid-evidence") {
    super(`Runner delivery retention remains unsettled (${reason}); original pending evidence requires recovery.`);
  }
}

/** Six attempts, 3.1s total backoff. Never abandon an in-flight writer on cancellation. */
export async function retainRunnerDelivery(commit: () => Promise<void>, signal: AbortSignal,
  wait: (ms: number) => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { await commit(); return; }
    catch {
      if (signal.aborted) throw new RunnerRetentionUnsettled("shutdown");
      if (attempt === 6) throw new RunnerRetentionUnsettled("attempts-exhausted");
    }
    // The caller's wait observes cancellation without detaching the actual write.
    try { await wait(100 * 2 ** (attempt - 1)); }
    catch { throw new RunnerRetentionUnsettled("shutdown"); }
  }
}
