import type { ProviderFailure, ProviderFailureAgent } from "./provider-failure.js";

/** Pure proposal policy; a due wait is NEVER execution/ownership/settlement authorization. */
export const PROVIDER_CAPACITY_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000] as const;
export const PROVIDER_CAPACITY_RETRY_MAX_DELAY_MS = 600_000;
export const DEFAULT_PROVIDER_CAPACITY_RETRY_WINDOW_MS = 3_600_000;
export const PROVIDER_CAPACITY_RETRY_JITTER_RATIO = 0.2;

export interface ProviderCapacityPins {
  agent: ProviderFailureAgent;
  /** null is allowed only before the original accepted task obtained a native session. */
  sessionId: string | null;
  requestedModel: string | null;
  /** Must be resolved before retry admission; an alias/default alone is insufficient. */
  resolvedModel: string;
  /** Opaque caller identity for accepted task, cwd/tree, effort/access/tools/sandbox/context. */
  contextKey: string;
}

export interface ProviderCapacityEpisode {
  pins: ProviderCapacityPins;
  firstWaitAt: number;
  retryWindowMs: number;
  deadlineAt: number;
  /** Original absolute task deadline: never recomputed from remaining timeout on recovery. */
  taskDeadlineAt: number;
  retryCount: number;
  /** Persist before arming; never reroll this value during recovery. */
  retryAt: number | null;
  /** Observe expiry only; mutually exclusive with retryAt and never native retry admission. */
  terminalObservationAt: number | null;
}

export type ProviderCapacityExpiryReason = "capacity" | "timeout";
export type ProviderCapacityStopReason = "nonretryable" | "capacity" | "timeout" | "disabled" | "pin_mismatch" | "invalid_state" | "retry_after_exceeds_cap";
export type ProviderCapacityDecision =
  | { type: "stop"; reason: ProviderCapacityStopReason }
  | { type: "observe_deadline"; observeAt: number; reasonAtDeadline: ProviderCapacityExpiryReason;
      nativeRetryAllowed: false; episode: ProviderCapacityEpisode }
  | { type: "wait"; retryAt: number; delayMs: number; nominalDelayMs: number; episode: ProviderCapacityEpisode };
export type ProviderCapacityWaitDecision =
  | { type: "stop"; reason: ProviderCapacityStopReason }
  | { type: "observing_deadline"; observeAt: number; reasonAtDeadline: ProviderCapacityExpiryReason; nativeRetryAllowed: false }
  | { type: "waiting"; retryAt: number }
  | { type: "due"; retryAt: number };

const timestamp = (value: number) => Number.isSafeInteger(value) && value >= 0;
const nonempty = (value: string) => typeof value === "string" && value.trim().length > 0;
const validPins = (pins: ProviderCapacityPins) => pins != null && typeof pins === "object"
  && ["codex", "claude", "opencode", "antigravity"].includes(pins.agent)
  && (pins.sessionId === null || nonempty(pins.sessionId))
  && (pins.requestedModel === null || nonempty(pins.requestedModel)) && nonempty(pins.resolvedModel) && nonempty(pins.contextKey);
const samePins = (a: ProviderCapacityPins, b: ProviderCapacityPins) => a.agent === b.agent && a.sessionId === b.sessionId
  && a.requestedModel === b.requestedModel && a.resolvedModel === b.resolvedModel && a.contextKey === b.contextKey;

/** Zero disables. Invalid config fails explicitly; it must never silently become an unlimited window. */
export function createProviderCapacityEpisode(input: {
  pins: ProviderCapacityPins; taskDeadlineAt: number; retryWindowMs?: number;
}, now: () => number): ProviderCapacityEpisode {
  const firstWaitAt = now();
  const retryWindowMs = input.retryWindowMs ?? DEFAULT_PROVIDER_CAPACITY_RETRY_WINDOW_MS;
  if (!timestamp(firstWaitAt) || !timestamp(input.taskDeadlineAt) || !timestamp(retryWindowMs)
    || !timestamp(firstWaitAt + retryWindowMs) || !validPins(input.pins)) throw new RangeError("invalid provider capacity episode");
  return { pins: { ...input.pins }, firstWaitAt, retryWindowMs, deadlineAt: firstWaitAt + retryWindowMs,
    taskDeadlineAt: input.taskDeadlineAt, retryCount: 0, retryAt: null, terminalObservationAt: null };
}

const expiryAt = (episode: ProviderCapacityEpisode) => Math.min(episode.taskDeadlineAt, episode.deadlineAt);
const expiryReason = (episode: ProviderCapacityEpisode): ProviderCapacityExpiryReason => episode.taskDeadlineAt <= episode.deadlineAt ? "timeout" : "capacity";

function stopReason(episode: ProviderCapacityEpisode, pins: ProviderCapacityPins, now: number): ProviderCapacityStopReason | null {
  if (episode == null || typeof episode !== "object" || !timestamp(now) || !timestamp(episode.firstWaitAt) || now < episode.firstWaitAt || !timestamp(episode.retryWindowMs)
    || !timestamp(episode.deadlineAt) || episode.deadlineAt !== episode.firstWaitAt + episode.retryWindowMs
    || !timestamp(episode.taskDeadlineAt) || !timestamp(episode.retryCount) || episode.retryCount === Number.MAX_SAFE_INTEGER
    || !validPins(episode.pins) || !validPins(pins)
    || (episode.terminalObservationAt !== null && (!timestamp(episode.terminalObservationAt)
      || episode.terminalObservationAt !== expiryAt(episode) || episode.retryAt !== null))
    || (episode.retryAt !== null && (episode.retryCount < 1 || !timestamp(episode.retryAt) || episode.retryAt <= episode.firstWaitAt
      || episode.retryAt >= expiryAt(episode)))) return "invalid_state";
  if (!samePins(episode.pins, pins)) return "pin_mismatch";
  if (episode.retryWindowMs === 0) return "disabled";
  if (now >= expiryAt(episode)) return expiryReason(episode);
  return null;
}

/** Caller supplies independent clock and uniform [0,1] sample; there are no timers or real sleeps. */
export function planProviderCapacityRetry(episode: ProviderCapacityEpisode, failure: ProviderFailure,
  currentPins: ProviderCapacityPins, injected: { now: () => number; jitter: () => number }): ProviderCapacityDecision {
  if (failure.kind !== "capacity" || !failure.retryable) return { type: "stop", reason: "nonretryable" };
  const now = injected.now();
  const reason = stopReason(episode, currentPins, now);
  if (reason) return { type: "stop", reason };
  if (failure.agent !== episode.pins.agent || failure.model !== episode.pins.resolvedModel) return { type: "stop", reason: "pin_mismatch" };
  // An existing persisted wait is inspected, not rescheduled. Clear it only after fenced admission.
  if (episode.retryAt !== null || episode.terminalObservationAt !== null) return { type: "stop", reason: "invalid_state" };
  const retryAfterMs = failure.retryAfterMs ?? 0;
  if (!timestamp(retryAfterMs)) return { type: "stop", reason: "invalid_state" };
  if (retryAfterMs > PROVIDER_CAPACITY_RETRY_MAX_DELAY_MS) return { type: "stop", reason: "retry_after_exceeds_cap" };
  const sample = injected.jitter();
  if (!Number.isFinite(sample) || sample < 0 || sample > 1) return { type: "stop", reason: "invalid_state" };
  const nominalDelayMs = PROVIDER_CAPACITY_RETRY_DELAYS_MS[Math.min(episode.retryCount, PROVIDER_CAPACITY_RETRY_DELAYS_MS.length - 1)]!;
  const jittered = Math.round(nominalDelayMs * (1 + (2 * sample - 1) * PROVIDER_CAPACITY_RETRY_JITTER_RATIO));
  const delayMs = Math.max(retryAfterMs, Math.min(PROVIDER_CAPACITY_RETRY_MAX_DELAY_MS, jittered));
  const retryAt = now + delayMs;
  // A delay that does not fit is not an expired deadline. Preserve the full window/timeout.
  // This observation cannot become "due" or increase the count of native retry proposals.
  if (retryAt >= expiryAt(episode)) {
    const observeAt = expiryAt(episode);
    return { type: "observe_deadline", observeAt, reasonAtDeadline: expiryReason(episode), nativeRetryAllowed: false,
      episode: { ...episode, pins: { ...episode.pins }, terminalObservationAt: observeAt } };
  }
  if (!timestamp(retryAt)) return { type: "stop", reason: "invalid_state" };
  return { type: "wait", retryAt, delayMs, nominalDelayMs,
    episode: { ...episode, pins: { ...episode.pins }, retryCount: episode.retryCount + 1, retryAt } };
}

/** Restart projection only. Even "due" requires external exact-turn settlement and durable CAS. */
export function inspectProviderCapacityWait(episode: ProviderCapacityEpisode, currentPins: ProviderCapacityPins,
  clock: () => number): ProviderCapacityWaitDecision {
  const now = clock();
  const reason = stopReason(episode, currentPins, now);
  if (reason) return { type: "stop", reason };
  if (episode.terminalObservationAt !== null) return { type: "observing_deadline", observeAt: episode.terminalObservationAt,
    reasonAtDeadline: expiryReason(episode), nativeRetryAllowed: false };
  if (episode.retryAt === null) return { type: "stop", reason: "invalid_state" };
  return { type: now >= episode.retryAt ? "due" : "waiting", retryAt: episode.retryAt };
}
