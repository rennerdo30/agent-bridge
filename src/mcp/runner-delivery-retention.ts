/** Immutable evidence, not an outgoing envelope, receipt or replay grant. */
export interface PendingRunnerRetention { messageId: string; record: string }
export interface RunnerDeliveryLedger { version: 1; namespace: string; generation: string; job: string; principal: string; entries: PendingRunnerRetention[] }
/** Public durable principal/generation fields, never credentials or a name-only grant. */
export function runnerLedgerPrincipal(spec: { owner?: unknown; job?: unknown }): string {
  const job = spec.job as Record<string, unknown> | undefined;
  return JSON.stringify([job?.id, job?.name, job?.agent, job?.startedAt, job?.supervisor, job?.parentJob, job?.rootSession, job?.sessionId, spec.owner]);
}
export interface RunnerInputBatch { generation: string; phase: "pending" | "admitted" | "provider-admitted" | "consumed" | "evidence";
  bodies: string[]; controls: { cid: string; body: string }[]; batch?: string;
  admission?: { startedAt: number; sessionId: string | null };
  result?: { reportId: string; report: string; status: string } }
/** The root fields are a conservative compatibility projection, never the
 * executing identity. Each accepted batch below keeps its immutable payload. */
export interface RunnerInputIntent extends RunnerInputBatch { batches?: RunnerInputBatch[] }
const settledInput = (input: RunnerInputBatch) => input.phase === "evidence" || input.phase === "consumed";
export function runnerInputRecord(input: RunnerInputBatch): string {
  return JSON.stringify([input.generation, input.bodies, input.controls, ...(input.batch ? [input.batch] : [])]);
}
export function runnerInputBatches(input: RunnerInputIntent | undefined): RunnerInputBatch[] {
  if (input === undefined) return [];
  const valid = (v: RunnerInputBatch) => v && typeof v.generation === "string" && v.generation.length > 0 &&
    ["pending", "admitted", "provider-admitted", "consumed", "evidence"].includes(v.phase) && Array.isArray(v.bodies) && v.bodies.length <= 128 &&
    v.bodies.every(body => typeof body === "string") && Array.isArray(v.controls) && v.controls.length <= 128 &&
    v.controls.every(c => c && typeof c.cid === "string" && typeof c.body === "string");
  if (!valid(input) || Buffer.byteLength(JSON.stringify(input)) > RUNNER_LEDGER_MAX_BYTES) throw new RunnerRetentionUnsettled("invalid-evidence");
  if (input.batches === undefined) return [input]; // Original single-batch evidence stays exact.
  if (!Array.isArray(input.batches) || input.batches.length > 128 || new Set(input.batches.map(b => b?.batch)).size !== input.batches.length ||
      input.batches.some(b => !valid(b) || b.generation !== input.generation || typeof b.batch !== "string" || !/^[a-f0-9-]{36}$/.test(b.batch) ||
        (b.phase === "provider-admitted" || b.phase === "consumed") && (!b.admission || !Number.isSafeInteger(b.admission.startedAt) || b.admission.startedAt < 0 ||
          b.admission.sessionId !== null && typeof b.admission.sessionId !== "string") ||
        b.phase === "consumed" && (!b.result || typeof b.result.reportId !== "string" || typeof b.result.report !== "string" || !["done", "failed", "cancelled", "paused"].includes(b.result.status))))
    throw new RunnerRetentionUnsettled("invalid-evidence");
  const projection = projectRunnerInputs(input.generation, input.batches);
  if (projection.phase !== input.phase || JSON.stringify(projection.bodies) !== JSON.stringify(input.bodies) || JSON.stringify(projection.controls) !== JSON.stringify(input.controls))
    throw new RunnerRetentionUnsettled("invalid-evidence");
  return input.batches;
}
export function projectRunnerInputs(generation: string, batches: RunnerInputBatch[]): RunnerInputIntent {
  const active = batches.filter(b => b.phase === "provider-admitted" || b.phase === "admitted"), pending = batches.filter(b => b.phase === "pending");
  const phase = active.some(b => b.phase === "provider-admitted") ? "provider-admitted" : active.length ? "admitted" : pending.length ? "pending" :
    batches.some(b => b.phase === "consumed") ? "consumed" : "evidence";
  const projected = active.length ? active : pending.length ? pending : batches;
  return { generation, phase, bodies: projected.flatMap(b => b.bodies), controls: projected.flatMap(b => b.controls), batches };
}
export const RUNNER_LEDGER_MAX_ITEMS = 128;
export const RUNNER_LEDGER_MAX_BYTES = 8 * 1024 * 1024;

export function hasUnsettledRunnerRetention(state: { pendingDeliveryRetention?: unknown; deliveryRetentionFailure?: unknown; deliveryLedger?: unknown; retainedRunnerInputs?: unknown } | null | undefined): boolean {
  const pending = state?.pendingDeliveryRetention;
  const ledger = state?.deliveryLedger as RunnerDeliveryLedger | undefined, input = state?.retainedRunnerInputs as RunnerInputIntent | undefined;
  let inputsUnsettled = false;
  try { inputsUnsettled = runnerInputBatches(input).some(b => !settledInput(b)); } catch { inputsUnsettled = true; }
  return Boolean(state?.deliveryRetentionFailure || pending !== undefined && (!Array.isArray(pending) || pending.length) ||
    ledger !== undefined && (!ledger || ledger.version !== 1 || typeof ledger.namespace !== "string" || !/^[a-f0-9]{64}$/.test(ledger.namespace) ||
      typeof ledger.principal !== "string" || !ledger.principal || typeof ledger.generation !== "string" || !ledger.generation ||
      typeof ledger.job !== "string" || !ledger.job || !Array.isArray(ledger.entries) || ledger.entries.length) ||
    inputsUnsettled);
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
