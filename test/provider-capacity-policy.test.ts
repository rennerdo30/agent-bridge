import { describe, expect, it, vi } from "vitest";
import { classifyProviderFailure } from "../src/core/provider-failure.js";
import { createProviderCapacityEpisode, inspectProviderCapacityWait, planProviderCapacityRetry,
  type ProviderCapacityDecision, type ProviderCapacityEpisode, type ProviderCapacityPins } from "../src/core/provider-capacity-policy.js";

const pins: ProviderCapacityPins = { agent: "codex", sessionId: "same-native-session", requestedModel: "alias",
  resolvedModel: "reported-effective-model", contextKey: "accepted-task/tree/effort/access/tools/sandbox" };
const capacity = classifyProviderFailure({ agent: "codex", model: pins.resolvedModel, message: "Selected model is at capacity" });
const start = (retryWindowMs?: number, taskDeadlineAt = 10_000_000) => createProviderCapacityEpisode({ pins, taskDeadlineAt, retryWindowMs }, () => 1_000);
const wait = (decision: ProviderCapacityDecision) => {
  expect(decision.type).toBe("wait");
  if (decision.type !== "wait") throw new Error("expected wait proposal");
  return decision;
};
const observation = (decision: ProviderCapacityDecision) => {
  expect(decision.type).toBe("observe_deadline");
  if (decision.type !== "observe_deadline") throw new Error("expected terminal-only observation");
  return decision;
};

describe("pure bounded capacity wait proposals", () => {
  it("uses the exact nominal schedule, saturating at ten minutes without extending either deadline", () => {
    let episode = start(), now = 1_000;
    expect(episode.deadlineAt).toBe(3_601_000);
    for (const expectedDelay of [30_000, 60_000, 120_000, 300_000, 600_000, 600_000]) {
      const decision = wait(planProviderCapacityRetry(episode, capacity, pins, { now: () => now, jitter: () => 0.5 }));
      expect(decision.delayMs).toBe(expectedDelay);
      expect(decision.nominalDelayMs).toBe(expectedDelay);
      expect(decision.retryAt).toBe(now + expectedDelay);
      expect(decision.episode).toMatchObject({ firstWaitAt: 1_000, deadlineAt: 3_601_000, taskDeadlineAt: 10_000_000, pins });
      now = decision.retryAt;
      // Simulates external fenced admission, not automatic execution by this package.
      episode = { ...decision.episode, retryAt: null };
    }
    expect(planProviderCapacityRetry(episode, capacity, pins, { now: () => 3_601_000, jitter: () => 0.5 })).toEqual({ type: "stop", reason: "capacity" });
  });

  it.each([[0, 24_000], [0.5, 30_000], [1, 36_000]])("bounds the first delay for jitter sample %s", (sample, expected) => {
    expect(wait(planProviderCapacityRetry(start(), capacity, pins, { now: () => 1_000, jitter: () => sample })).delayMs).toBe(expected);
  });

  it("caps positive jitter and bounds negative jitter on saturated attempts", () => {
    const episode = { ...start(), retryCount: 99 };
    expect(wait(planProviderCapacityRetry(episode, capacity, pins, { now: () => 1_000, jitter: () => 1 })).delayMs).toBe(600_000);
    expect(wait(planProviderCapacityRetry(episode, capacity, pins, { now: () => 1_000, jitter: () => 0 })).delayMs).toBe(480_000);
  });

  it("uses retry-after as a lower bound, never an excuse to retry before it or beyond the cap", () => {
    for (const [retryAfterMs, expected] of [[1, 24_000], [35_000, 35_000], [600_000, 600_000]]) {
      expect(wait(planProviderCapacityRetry(start(), { ...capacity, retryAfterMs }, pins, { now: () => 1_000, jitter: () => 0 })).delayMs).toBe(expected);
    }
    expect(planProviderCapacityRetry(start(), { ...capacity, retryAfterMs: 600_001 }, pins, { now: () => 1_000, jitter: () => 0 })).toEqual({ type: "stop", reason: "retry_after_exceeds_cap" });
    expect(planProviderCapacityRetry(start(), { ...capacity, retryAfterMs: 60_000 }, pins, { now: () => 1_000, jitter: () => 0.5 })).toMatchObject({ retryAt: 61_000 });
    expect(planProviderCapacityRetry(start(), { ...capacity, resetAt: 8_000_000 }, pins, { now: () => 1_000, jitter: () => 0.5 })).toMatchObject({ retryAt: 31_000 });
  });

  it("observes an exact future boundary and admits a retry one millisecond before it", () => {
    expect(observation(planProviderCapacityRetry(start(30_000), capacity, pins, { now: () => 1_000, jitter: () => 0.5 }))).toMatchObject({ observeAt: 31_000, reasonAtDeadline: "capacity", nativeRetryAllowed: false });
    expect(planProviderCapacityRetry(start(30_001), capacity, pins, { now: () => 1_000, jitter: () => 0.5 }).type).toBe("wait");
    expect(observation(planProviderCapacityRetry(start(undefined, 31_000), capacity, pins, { now: () => 1_000, jitter: () => 0.5 }))).toMatchObject({ observeAt: 31_000, reasonAtDeadline: "timeout", nativeRetryAllowed: false });
    expect(planProviderCapacityRetry(start(undefined, 31_001), capacity, pins, { now: () => 1_000, jitter: () => 0.5 }).type).toBe("wait");
    expect(planProviderCapacityRetry(start(30_000, 31_000), capacity, pins, { now: () => 31_000, jitter: () => 0.5 })).toEqual({ type: "stop", reason: "timeout" });
  });

  it.each(["capacity", "timeout", "tie"] as const)("preserves the last15s instead of ending early: %s", earlier => {
    const episode = start(earlier === "timeout" ? undefined : 15_000, earlier === "capacity" ? 10_000_000 : 16_000);
    const jitter = vi.fn(() => 0.5);
    const decision = observation(planProviderCapacityRetry(episode, capacity, pins, { now: () => 1_000, jitter }));
    const reason = earlier === "capacity" ? "capacity" : "timeout";
    expect(decision).toMatchObject({ observeAt: 16_000, reasonAtDeadline: reason, nativeRetryAllowed: false });
    expect(decision).not.toHaveProperty("retryAt");
    expect(decision.episode).toEqual({ ...episode, terminalObservationAt: 16_000 });
    expect(decision.episode.retryCount).toBe(0);
    const recovered = JSON.parse(JSON.stringify(decision.episode)) as ProviderCapacityEpisode;
    expect(inspectProviderCapacityWait(recovered, pins, () => 15_999)).toEqual({ type: "observing_deadline", observeAt: 16_000, reasonAtDeadline: reason, nativeRetryAllowed: false });
    expect(inspectProviderCapacityWait(recovered, pins, () => 16_000)).toEqual({ type: "stop", reason });
    expect(inspectProviderCapacityWait(recovered, pins, () => 20_000)).toEqual({ type: "stop", reason });
    expect(planProviderCapacityRetry(recovered, capacity, pins, { now: () => 2_000, jitter })).toEqual({ type: "stop", reason: "invalid_state" });
    expect(jitter).toHaveBeenCalledTimes(1);
    expect(episode.terminalObservationAt).toBeNull();
  });

  it.each(["capacity", "timeout"] as const)("observes original expiry when a late ten-minute retry cannot fit: %s", earlier => {
    const episode = { ...start(undefined, earlier === "timeout" ? 3_501_000 : 10_000_000), retryCount: 4 };
    const decision = observation(planProviderCapacityRetry(episode, capacity, pins, { now: () => 3_301_000, jitter: () => 1 }));
    const deadline = earlier === "timeout" ? 3_501_000 : 3_601_000;
    expect(decision).toMatchObject({ observeAt: deadline, reasonAtDeadline: earlier, nativeRetryAllowed: false });
    expect(decision.episode).toEqual({ ...episode, terminalObservationAt: deadline });
    expect(decision.episode.retryCount).toBe(4);
    expect(decision.episode.retryAt).toBeNull();
    expect(inspectProviderCapacityWait(decision.episode, pins, () => deadline - 1)).toMatchObject({ type: "observing_deadline", nativeRetryAllowed: false });
    expect(inspectProviderCapacityWait(decision.episode, pins, () => deadline)).toEqual({ type: "stop", reason: earlier });
  });

  it("honors retry-after even when only deadline observation fits, without retry admission at expiry", () => {
    const episode = start(undefined, 61_000);
    const decision = observation(planProviderCapacityRetry(episode, { ...capacity, retryAfterMs: 60_000 }, pins, { now: () => 1_000, jitter: () => 0 }));
    expect(decision).toMatchObject({ observeAt: 61_000, reasonAtDeadline: "timeout", nativeRetryAllowed: false });
    expect(inspectProviderCapacityWait(decision.episode, pins, () => 61_000)).toEqual({ type: "stop", reason: "timeout" });
  });

  it("keeps the earlier original task timeout even after both deadlines have expired", () => {
    expect(planProviderCapacityRetry(start(60_000, 40_000), capacity, pins, { now: () => 90_000, jitter: () => 0.5 })).toEqual({ type: "stop", reason: "timeout" });
    expect(planProviderCapacityRetry(start(30_000, 90_000), capacity, pins, { now: () => 100_000, jitter: () => 0.5 })).toEqual({ type: "stop", reason: "capacity" });
  });

  it("retains a persisted absolute wait on restart without sampling again or refreshing the budget", () => {
    const jitter = vi.fn(() => 0.75);
    const decision = wait(planProviderCapacityRetry(start(), capacity, pins, { now: () => 1_000, jitter }));
    const recovered = JSON.parse(JSON.stringify(decision.episode)) as ProviderCapacityEpisode;
    expect(inspectProviderCapacityWait(recovered, pins, () => 33_999)).toEqual({ type: "waiting", retryAt: 34_000 });
    expect(inspectProviderCapacityWait(recovered, pins, () => 34_000)).toEqual({ type: "due", retryAt: 34_000 });
    expect(inspectProviderCapacityWait(recovered, pins, () => 40_000)).toEqual({ type: "due", retryAt: 34_000 });
    expect(inspectProviderCapacityWait(recovered, pins, () => 3_601_000)).toEqual({ type: "stop", reason: "capacity" });
    expect(planProviderCapacityRetry(recovered, capacity, pins, { now: () => 2_000, jitter })).toEqual({ type: "stop", reason: "invalid_state" });
    expect(jitter).toHaveBeenCalledTimes(1);
  });

  it.each(["sessionId", "requestedModel", "resolvedModel", "contextKey", "agent"] as const)("stops if the %s pin changes", key => {
    const current = { ...pins, [key]: key === "agent" ? "claude" : "replacement" } as ProviderCapacityPins;
    expect(planProviderCapacityRetry(start(), capacity, current, { now: () => 1_000, jitter: () => 0.5 })).toEqual({ type: "stop", reason: "pin_mismatch" });
    const pending = wait(planProviderCapacityRetry(start(), capacity, pins, { now: () => 1_000, jitter: () => 0.5 })).episode;
    expect(inspectProviderCapacityWait(pending, current, () => 31_000)).toEqual({ type: "stop", reason: "pin_mismatch" });
  });

  it("requires the actual resolved failure model and agent, not just the requested alias", () => {
    for (const failure of [{ ...capacity, model: "alias" }, { ...capacity, model: null }, { ...capacity, agent: "claude" as const }]) {
      expect(planProviderCapacityRetry(start(), failure, pins, { now: () => 1_000, jitter: () => 0.5 })).toEqual({ type: "stop", reason: "pin_mismatch" });
    }
  });

  it("keeps pre-session proposals pinned to the original accepted context", () => {
    const beforeSession = { ...pins, sessionId: null };
    const episode = createProviderCapacityEpisode({ pins: beforeSession, taskDeadlineAt: 10_000_000 }, () => 1_000);
    expect(wait(planProviderCapacityRetry(episode, capacity, beforeSession, { now: () => 1_000, jitter: () => 0.5 })).episode.pins).toEqual(beforeSession);
    expect(planProviderCapacityRetry(episode, capacity, pins, { now: () => 1_000, jitter: () => 0.5 })).toEqual({ type: "stop", reason: "pin_mismatch" });
  });

  it.each(["usage limit reached", "no credits", "billing required", "429", "unknown error"])("stops %s without reading clock/jitter or mutating the episode", message => {
    const episode = start(), before = JSON.stringify(episode), now = vi.fn(() => 1_000), jitter = vi.fn(() => 0.5);
    const failure = classifyProviderFailure({ agent: "codex", model: pins.resolvedModel, message });
    expect(planProviderCapacityRetry(episode, failure, pins, { now, jitter })).toEqual({ type: "stop", reason: "nonretryable" });
    expect(now).not.toHaveBeenCalled(); expect(jitter).not.toHaveBeenCalled();
    expect(JSON.stringify(episode)).toBe(before);
  });

  it("zero disables proposals and invalid retry windows fail explicitly", () => {
    const jitter = vi.fn(() => 0.5);
    expect(planProviderCapacityRetry(start(0), capacity, pins, { now: () => 1_000, jitter })).toEqual({ type: "stop", reason: "disabled" });
    expect(jitter).not.toHaveBeenCalled();
    for (const invalid of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER]) expect(() => start(invalid)).toThrow(RangeError);
    expect(() => createProviderCapacityEpisode({ pins: { ...pins, resolvedModel: "" }, taskDeadlineAt: 10_000_000 }, () => 1_000)).toThrow(RangeError);
  });

  it("stops terminal failures without requiring model/session attribution or a valid capacity episode", () => {
    const unresolved = { ...pins, sessionId: null, resolvedModel: "" };
    const invalidEpisode = { ...start(), pins: unresolved };
    for (const message of ["usage limit reached", "no credits", "billing required"]) {
      const failure = classifyProviderFailure({ agent: "codex", model: null, message });
      expect(planProviderCapacityRetry(invalidEpisode, failure, unresolved, { now: () => 1_000, jitter: () => 0.5 })).toEqual({ type: "stop", reason: "nonretryable" });
    }
    expect(planProviderCapacityRetry(invalidEpisode, capacity, unresolved, { now: () => 1_000, jitter: () => 0.5 })).toEqual({ type: "stop", reason: "invalid_state" });
  });

  it.each([-0.01, 1.01, NaN, Infinity])("rejects invalid injected jitter %s", sample => {
    expect(planProviderCapacityRetry(start(), capacity, pins, { now: () => 1_000, jitter: () => sample })).toEqual({ type: "stop", reason: "invalid_state" });
  });

  it("holds corrupt recovered state and backward/invalid clocks without execution proposals", () => {
    for (const episode of [{ ...start(), retryCount: -1 }, { ...start(), retryCount: 0.5 }, { ...start(), deadlineAt: 9_000_000 },
      { ...start(), retryAt: 3_601_000 }, { ...start(), retryAt: 0 }, { ...start(), taskDeadlineAt: Infinity },
      { ...start(), terminalObservationAt: 3_600_999 }, { ...start(), terminalObservationAt: 3_601_000, retryAt: 31_000, retryCount: 1 }]) {
      expect(planProviderCapacityRetry(episode, capacity, pins, { now: () => 1_000, jitter: () => 0.5 })).toEqual({ type: "stop", reason: "invalid_state" });
    }
    for (const time of [999, NaN, Infinity]) expect(planProviderCapacityRetry(start(), capacity, pins, { now: () => time, jitter: () => 0.5 })).toEqual({ type: "stop", reason: "invalid_state" });
    expect(inspectProviderCapacityWait(start(), pins, () => 1_000)).toEqual({ type: "stop", reason: "invalid_state" });
    expect(inspectProviderCapacityWait({ ...start(), pins: null } as unknown as ProviderCapacityEpisode, pins, () => 1_000)).toEqual({ type: "stop", reason: "invalid_state" });
    expect(inspectProviderCapacityWait(null as unknown as ProviderCapacityEpisode, pins, () => 1_000)).toEqual({ type: "stop", reason: "invalid_state" });
  });
});
