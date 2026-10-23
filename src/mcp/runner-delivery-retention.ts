/** Immutable evidence, not an outgoing envelope, receipt or replay grant. */
export interface PendingRunnerRetention { messageId: string; record: string }
export interface RunnerDeliveryLedger { version: 1; namespace: string; generation: string; job: string; principal: string; entries: PendingRunnerRetention[] }
/** Public durable principal/generation fields, never credentials or a name-only grant. */
export function runnerLedgerPrincipal(spec: { owner?: unknown; job?: unknown }): string {
  const job = spec.job as Record<string, unknown> | undefined;
  return JSON.stringify([job?.id, job?.name, job?.agent, job?.startedAt, job?.supervisor, job?.parentJob, job?.rootSession, job?.sessionId, spec.owner]);
}
export interface RunnerInputIntent { generation: string; phase: "pending" | "admitted" | "provider-admitted" | "consumed" | "evidence"; bodies: string[]; controls: { cid: string; body: string }[] }
export const RUNNER_LEDGER_MAX_ITEMS = 128;
export const RUNNER_LEDGER_MAX_BYTES = 8 * 1024 * 1024;

export function hasUnsettledRunnerRetention(state: { pendingDeliveryRetention?: unknown; deliveryRetentionFailure?: unknown; deliveryLedger?: unknown; retainedRunnerInputs?: unknown } | null | undefined): boolean {
  const pending = state?.pendingDeliveryRetention;
  const ledger = state?.deliveryLedger as RunnerDeliveryLedger | undefined, input = state?.retainedRunnerInputs as RunnerInputIntent | undefined;
  return Boolean(state?.deliveryRetentionFailure || pending !== undefined && (!Array.isArray(pending) || pending.length) ||
    ledger !== undefined && (!ledger || ledger.version !== 1 || typeof ledger.namespace !== "string" || !/^[a-f0-9]{64}$/.test(ledger.namespace) ||
      typeof ledger.principal !== "string" || !ledger.principal || typeof ledger.generation !== "string" || !ledger.generation ||
      typeof ledger.job !== "string" || !ledger.job || !Array.isArray(ledger.entries) || ledger.entries.length) ||
    input !== undefined && (!input || !["evidence", "consumed"].includes(input.phase)));
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
