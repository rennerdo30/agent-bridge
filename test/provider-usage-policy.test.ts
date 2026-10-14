import { describe, expect, it } from "vitest";
import { decideProviderUsage, PROVIDER_USAGE_TTL_MS, PROVIDER_USAGE_LOW_WARNING_PERCENT,
  PROVIDER_USAGE_LOW_CREDITS_THRESHOLD, PROVIDER_USAGE_LOW_BALANCE_THRESHOLDS,
  type ProviderUsageFact, type ProviderUsageReading, type ProviderUsageScope } from "../src/core/provider-usage-policy.js";

const observedAt = 1_000_000;
const target: ProviderUsageScope = { executorId: "executor", agent: "codex", accountId: "account",
  providerId: "provider", modelId: "effective-model" };
const known = (reading: ProviderUsageReading): Extract<ProviderUsageFact, { state: "known" }> => ({
  state: "known", scope: { ...target }, observedAt, reading,
});
const percent = (value: number): ProviderUsageReading => ({ kind: "percent_used", value, unit: "percent" });
const evaluate = (fact: ProviderUsageFact | null | undefined, now = observedAt) => decideProviderUsage(fact, { target, now });

describe("pure pre-spawn usage decisions (no producer or admission wiring)", () => {
  it.each([
    [percent(100), "usage_exhausted"],
    [{ kind: "credits_remaining", value: 0, unit: "credits" }, "credits_exhausted"],
    [{ kind: "balance_remaining", value: 0, unit: "USD" }, "balance_exhausted"],
    [{ kind: "balance_remaining", value: 0, unit: "JPY" }, "balance_exhausted"],
  ] as const)("blocks only explicit exhaustion: %j", (reading, reason) => {
    expect(evaluate(known(reading))).toEqual({ type: "block", reason });
  });

  it.each(["claude", "codex", "opencode", "antigravity", "another-agent"])("uses the same policy for %s", agent => {
    const scope = { ...target, agent };
    expect(decideProviderUsage({ ...known(percent(100)), scope }, { target: scope, now: observedAt }))
      .toEqual({ type: "block", reason: "usage_exhausted" });
  });

  it.each([
    percent(PROVIDER_USAGE_LOW_WARNING_PERCENT), percent(92), percent(99.999),
    { kind: "credits_remaining", value: PROVIDER_USAGE_LOW_CREDITS_THRESHOLD / 2, unit: "credits" },
    { kind: "balance_remaining", value: PROVIDER_USAGE_LOW_BALANCE_THRESHOLDS.USD! / 2, unit: "USD" },
  ] as const)("warns and permits low positive allowance: %j", reading => {
    expect(evaluate(known(reading))).toEqual({ type: "warn", reason: "low_allowance" });
  });

  it.each([
    percent(0), percent(PROVIDER_USAGE_LOW_WARNING_PERCENT - 0.001),
    { kind: "credits_remaining", value: PROVIDER_USAGE_LOW_CREDITS_THRESHOLD, unit: "credits" },
    { kind: "balance_remaining", value: PROVIDER_USAGE_LOW_BALANCE_THRESHOLDS.USD!, unit: "USD" },
    { kind: "balance_remaining", value: 0.001, unit: "JPY" },
  ] as const)("allows available allowance without rounding or currency conversion: %j", reading => {
    expect(evaluate(known(reading))).toEqual({ type: "allow", reason: "allowance_available" });
  });

  it("offers one parent-result warning and never suppresses an exhaustion refusal", () => {
    const input = { target, now: observedAt, warningAlreadyReported: true };
    expect(decideProviderUsage(known(percent(92)), input)).toEqual({ type: "allow", reason: "warning_already_reported" });
    expect(decideProviderUsage(known(percent(100)), input)).toEqual({ type: "block", reason: "usage_exhausted" });
    expect(decideProviderUsage(known(percent(92)), { ...input, warningAlreadyReported: false }))
      .toEqual({ type: "warn", reason: "low_allowance" });
  });

  it.each([null, undefined, { state: "unknown" } as const])("allows missing/unknown readings: %j", fact => {
    expect(evaluate(fact)).toEqual({ type: "allow", reason: "unknown" });
  });
  it("allows a failed read", () => {
    expect(evaluate({ state: "read_failed" })).toEqual({ type: "allow", reason: "read_failed" });
  });

  it("expires cached exhaustion exactly at the TTL using injected time", () => {
    const fact = known(percent(100));
    expect(evaluate(fact, observedAt + PROVIDER_USAGE_TTL_MS - 1)).toEqual({ type: "block", reason: "usage_exhausted" });
    expect(evaluate(fact, observedAt + PROVIDER_USAGE_TTL_MS)).toEqual({ type: "allow", reason: "stale" });
    expect(evaluate(fact, observedAt + PROVIDER_USAGE_TTL_MS + 1)).toEqual({ type: "allow", reason: "stale" });
    expect(evaluate(known(percent(92)), observedAt + PROVIDER_USAGE_TTL_MS)).toEqual({ type: "allow", reason: "stale" });
  });

  it("requires a new observation to restore exhaustion after TTL expiry", () => {
    const now = observedAt + PROVIDER_USAGE_TTL_MS;
    expect(evaluate(known(percent(100)), now)).toEqual({ type: "allow", reason: "stale" });
    expect(evaluate({ ...known(percent(100)), observedAt: now }, now)).toEqual({ type: "block", reason: "usage_exhausted" });
  });

  it.each(["executorId", "agent", "accountId", "providerId", "modelId"] as const)("allows %s mismatch", key => {
    expect(evaluate({ ...known(percent(100)), scope: { ...target, [key]: "other" } }))
      .toEqual({ type: "allow", reason: "scope_mismatch" });
    expect(decideProviderUsage(known(percent(100)), { target: { ...target, [key]: "other" }, now: observedAt }))
      .toEqual({ type: "allow", reason: "scope_mismatch" });
  });

  it.each(["executorId", "agent", "accountId", "providerId", "modelId"] as const)("allows incomplete %s applicability", key => {
    expect(evaluate({ ...known(percent(100)), scope: { ...target, [key]: " " } }))
      .toEqual({ type: "allow", reason: "invalid_fact" });
  });

  it("expires only a reported reset, at equality, without inventing a reset for missing data", () => {
    const resetAt = observedAt + 100;
    const fact = { ...known(percent(100)), resetAt };
    expect(evaluate(fact, resetAt - 1)).toEqual({ type: "block", reason: "usage_exhausted" });
    expect(evaluate(fact, resetAt)).toEqual({ type: "allow", reason: "reset_elapsed" });
    expect(evaluate(fact, resetAt + 1)).toEqual({ type: "allow", reason: "reset_elapsed" });
    expect(evaluate(known(percent(100)), resetAt)).toEqual({ type: "block", reason: "usage_exhausted" });
  });

  // Deliberately malformed decoded producer payloads: never coerce strings/null/NaN into zero.
  it.each([
    {}, { state: "invalid" }, { ...known(percent(100)), scope: null },
    { ...known(percent(100)), observedAt: undefined }, { ...known(percent(100)), observedAt: observedAt + 1 },
    { ...known(percent(100)), observedAt: -1 }, { ...known(percent(100)), observedAt: NaN },
    { ...known(percent(100)), resetAt: null }, { ...known(percent(100)), resetAt: observedAt },
    { ...known(percent(100)), resetAt: Infinity }, { ...known(percent(100)), reading: null },
    ...[NaN, Infinity, -1, 100.001, "100", null, undefined].map(value => known({ ...percent(100), value } as ProviderUsageReading)),
    ...["credits_remaining", "balance_remaining"].flatMap(kind => [NaN, Infinity, -1, "0", null, undefined]
      .map(value => ({ ...known(percent(100)), reading: { kind, value, unit: kind === "credits_remaining" ? "credits" : "USD" } }))),
    { ...known(percent(100)), reading: { kind: "percent_used", value: 100, unit: "credits" } },
    { ...known(percent(100)), reading: { kind: "credits_remaining", value: 0, unit: "USD" } },
    ...["", " ", "usd", "credits", null, undefined].map(unit => ({ ...known(percent(100)),
      reading: { kind: "balance_remaining", value: 0, unit } })),
    { ...known(percent(100)), reading: { kind: "other", value: 0, unit: "credits" } },
  ])("allows invalid facts: %j", fact => {
    expect(evaluate(fact as ProviderUsageFact)).toEqual({ type: "allow", reason: "invalid_fact" });
  });

  it.each([-1, NaN, Infinity, observedAt - 1, observedAt + 0.5])("allows invalid or reversed injected time: %s", now => {
    expect(evaluate(known(percent(100)), now)).toEqual({ type: "allow", reason: "invalid_fact" });
  });

  it("does not mutate facts, target, or warning state and returns deterministic decisions", () => {
    const fact = Object.freeze({ ...known(percent(92)), scope: Object.freeze({ ...target }), reading: Object.freeze(percent(92)) });
    const input = Object.freeze({ target: Object.freeze({ ...target }), now: observedAt });
    const before = JSON.stringify({ fact, input });
    expect(decideProviderUsage(fact, input)).toEqual({ type: "warn", reason: "low_allowance" });
    expect(decideProviderUsage(fact, input)).toEqual({ type: "warn", reason: "low_allowance" });
    expect(JSON.stringify({ fact, input })).toBe(before);
  });
});
