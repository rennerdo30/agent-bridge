import { z } from "zod";

// Persisted data validation ONLY. These schemas/transition descriptions cannot
// mint an owner census, retirement permit, exit proof or writer capability.
export const lifecycleInstanceSchema = z.object({ nonce: z.string().uuid(), pid: z.number().int().positive(),
  creationIdentity: z.string().min(1).max(256) }).strict();
export const lifecycleActorSchema = z.object({ kind: z.enum(["old", "successor"]), instance: lifecycleInstanceSchema }).strict();
export const LIFECYCLE_STATES = Object.freeze(["accepted", "preparing", "draining", "prepared", "release_intent", "released", "binding",
  "done", "failed_serving", "unavailable", "unknown", "stop_intent", "stop_committed"] as const);
export type LifecycleState = typeof LIFECYCLE_STATES[number];
export const LIFECYCLE_NEXT: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = Object.freeze({
  accepted: Object.freeze(["preparing", "draining", "failed_serving", "unknown"] as const),
  preparing: Object.freeze(["draining", "failed_serving", "unknown"] as const),
  draining: Object.freeze(["prepared", "failed_serving", "unknown"] as const),
  prepared: Object.freeze(["release_intent", "stop_intent", "failed_serving", "unknown"] as const),
  release_intent: Object.freeze(["released", "unknown"] as const), released: Object.freeze(["binding", "unavailable", "unknown"] as const),
  binding: Object.freeze(["done", "unavailable", "unknown"] as const), stop_intent: Object.freeze(["stop_committed", "unknown"] as const),
  done: Object.freeze([]), failed_serving: Object.freeze([]), unavailable: Object.freeze([]), unknown: Object.freeze([]), stop_committed: Object.freeze([]),
});
export function sameLifecycleInstance(a: z.infer<typeof lifecycleInstanceSchema>, b: z.infer<typeof lifecycleInstanceSchema>): boolean {
  return a.nonce === b.nonce && a.pid === b.pid && a.creationIdentity === b.creationIdentity;
}

// These states require source-owned proofs not supplied by receipt fields. Even
// apparently complete caller checkpoint strings are not an authority permit.
export const LIFECYCLE_PROOF_REQUIRED: readonly LifecycleState[] = Object.freeze(["release_intent", "released", "binding", "done",
  "failed_serving", "unavailable", "stop_intent", "stop_committed"] as const);
