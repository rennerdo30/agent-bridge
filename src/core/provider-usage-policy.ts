/** Pure proposal only. Producers and callers must authenticate scope before using this policy. */
export const PROVIDER_USAGE_TTL_MS = 30_000;
export const PROVIDER_USAGE_LOW_WARNING_PERCENT = 90;
export const PROVIDER_USAGE_LOW_CREDITS_THRESHOLD = 1;
/** Balance floors are unit-specific; an unlisted currency has no inferred warning floor. */
export const PROVIDER_USAGE_LOW_BALANCE_THRESHOLDS: Readonly<Record<string, number>> = Object.freeze({ USD: 1 });

export interface ProviderUsageScope {
  executorId: string;
  agent: string;
  accountId: string;
  providerId: string;
  /** Effective model identity, not an unresolved default or alias. */
  modelId: string;
}

export type ProviderUsageReading =
  | { kind: "percent_used"; value: number; unit: "percent" }
  | { kind: "credits_remaining"; value: number; unit: "credits" }
  | { kind: "balance_remaining"; value: number; unit: string };

export type ProviderUsageFact =
  | { state: "unknown" | "read_failed" }
  | { state: "known"; scope: ProviderUsageScope; observedAt: number; reading: ProviderUsageReading;
      /** Only a decoded provider reset timestamp; never an estimate. */
      resetAt?: number };

export type ProviderUsageReason = "unknown" | "read_failed" | "invalid_fact" | "scope_mismatch" | "stale"
  | "reset_elapsed" | "usage_exhausted" | "credits_exhausted" | "balance_exhausted"
  | "low_allowance" | "warning_already_reported" | "allowance_available";
export interface ProviderUsageDecision {
  /** warn permits execution. It is a single parent-result warning, never a retry or model switch. */
  type: "block" | "warn" | "allow";
  reason: ProviderUsageReason;
}

const scopeKeys = ["executorId", "agent", "accountId", "providerId", "modelId"] as const;
const timestamp = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validScope = (scope: ProviderUsageScope) => scope != null && typeof scope === "object"
  && scopeKeys.every(key => typeof scope[key] === "string" && scope[key].trim().length > 0);
const allow = (reason: ProviderUsageReason): ProviderUsageDecision => ({ type: "allow", reason });

/**
 * Evaluate one scoped reading at an injected epoch-millisecond time. No I/O or mutable cache.
 * TTL equality expires the reading. A passed reset expires it even within the TTL; refresh is
 * external. Callers aggregate warnings once per parent result and supply warningAlreadyReported
 * for subsequent readings. This function cannot authenticate a producer or enforce admission.
 */
export function decideProviderUsage(fact: ProviderUsageFact | null | undefined, input: {
  target: ProviderUsageScope; now: number; warningAlreadyReported?: boolean;
}): ProviderUsageDecision {
  if (fact == null || fact.state === "unknown") return allow("unknown");
  if (fact.state === "read_failed") return allow("read_failed");
  if (fact.state !== "known" || !timestamp(input.now) || !timestamp(fact.observedAt)
    || fact.observedAt > input.now || !validScope(fact.scope) || !validScope(input.target)
    || (input.warningAlreadyReported !== undefined && typeof input.warningAlreadyReported !== "boolean")) {
    return allow("invalid_fact");
  }
  if (scopeKeys.some(key => fact.scope[key] !== input.target[key])) return allow("scope_mismatch");
  if (input.now - fact.observedAt >= PROVIDER_USAGE_TTL_MS) return allow("stale");
  if (fact.resetAt !== undefined) {
    if (!timestamp(fact.resetAt) || fact.resetAt <= fact.observedAt) return allow("invalid_fact");
    if (input.now >= fact.resetAt) return allow("reset_elapsed");
  }

  const reading = fact.reading;
  if (reading == null || !Number.isFinite(reading.value) || reading.value < 0) return allow("invalid_fact");
  let exhausted: ProviderUsageReason;
  let low: boolean;
  switch (reading.kind) {
    case "percent_used":
      if (reading.unit !== "percent" || reading.value > 100) return allow("invalid_fact");
      if (reading.value === 100) return { type: "block", reason: "usage_exhausted" };
      low = reading.value >= PROVIDER_USAGE_LOW_WARNING_PERCENT;
      break;
    case "credits_remaining":
      if (reading.unit !== "credits") return allow("invalid_fact");
      exhausted = "credits_exhausted";
      if (reading.value === 0) return { type: "block", reason: exhausted };
      low = reading.value < PROVIDER_USAGE_LOW_CREDITS_THRESHOLD;
      break;
    case "balance_remaining": {
      if (typeof reading.unit !== "string" || !/^[A-Z]{3}$/.test(reading.unit)) return allow("invalid_fact");
      exhausted = "balance_exhausted";
      if (reading.value === 0) return { type: "block", reason: exhausted };
      const floor = PROVIDER_USAGE_LOW_BALANCE_THRESHOLDS[reading.unit];
      low = floor !== undefined && reading.value < floor;
      break;
    }
    default: return allow("invalid_fact");
  }
  if (!low) return allow("allowance_available");
  return input.warningAlreadyReported ? allow("warning_already_reported") : { type: "warn", reason: "low_allowance" };
}
