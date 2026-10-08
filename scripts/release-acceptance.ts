/** Release policy only. Raw rehearsal samples/failures and the strict success flag stay unchanged. */
export interface RehearsalSample {
  phase: string;
  clientVersion?: string;
  probeError?: string;
  failure?: string;
  storageOutcome?: {
    state?: string;
    localState?: string;
    copies?: readonly { id?: unknown; [key: string]: unknown }[];
    lookupError?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface RehearsalAcceptanceInput {
  functionalVerified: boolean;
  cleanupVerified: boolean;
  /** Caller verifies finite, complete global/per-phase/current send/peers/reload p95 < 1000 ms. */
  latencyGatesPassed: boolean;
  /** Measured from old broker retirement beginning to the current broker being observed. */
  reloadHandoffMs: number;
  currentClientVersion: string;
  samples: readonly RehearsalSample[];
  failures: readonly string[];
}
export interface RehearsalErrorEvidence {
  sampleIndex: number;
  phase: string;
  clientVersion?: string;
  error: string;
  failure?: string;
  messageIds: string[];
}
export interface RehearsalAcceptance {
  accepted: boolean;
  legacyConfirmedStoredErrors: RehearsalErrorEvidence[];
  blockingFailures: string[];
  currentClientErrors: RehearsalErrorEvidence[];
}

export function evaluateRehearsalAcceptance(input: RehearsalAcceptanceInput): RehearsalAcceptance {
  const blockingFailures: string[] = [];
  const legacyConfirmedStoredErrors: RehearsalErrorEvidence[] = [];
  const currentClientErrors: RehearsalErrorEvidence[] = [];
  const matchedFailures = new Set<number>();
  if (input.functionalVerified !== true) blockingFailures.push("Functional verification incomplete");
  if (input.cleanupVerified !== true) blockingFailures.push("Owned-process cleanup verification incomplete");
  if (input.latencyGatesPassed !== true) blockingFailures.push("Strict latency gates failed or incomplete");
  if (!Number.isFinite(input.reloadHandoffMs) || input.reloadHandoffMs < 0 || input.reloadHandoffMs >= 1_000)
    blockingFailures.push("Reload handoff latency failed or incomplete (must be finite and below 1000 ms)");
  if (!input.currentClientVersion.trim() || input.currentClientVersion === "0.29.17") blockingFailures.push("Current client version is invalid");
  if (!input.samples.some(sample => sample.clientVersion === input.currentClientVersion)) blockingFailures.push("Current-version client samples missing");

  input.samples.forEach((sample, sampleIndex) => {
    if (sample.storageOutcome?.state !== "stored") blockingFailures.push(`Unconfirmed message storage in ${sample.phase}`);
    const error = sample.probeError || sample.failure;
    if (!error) return;
    const copies = sample.storageOutcome?.copies;
    const validCopies = Array.isArray(copies) && copies.length > 0 && copies.every(copy => copy && typeof copy.id === "string" && copy.id.trim().length > 0);
    const evidence: RehearsalErrorEvidence = { sampleIndex, phase: sample.phase, clientVersion: sample.clientVersion, error, failure: sample.failure,
      messageIds: validCopies ? copies!.map(copy => copy.id as string) : [] };
    if (sample.clientVersion === input.currentClientVersion) currentClientErrors.push(evidence);
    const legacyAllowed = sample.phase === "sessions-reload" && sample.clientVersion === "0.29.17" &&
      typeof sample.probeError === "string" && sample.probeError.includes("connection to broker closed") &&
      sample.storageOutcome?.state === "stored" && sample.storageOutcome.localState === "stored" && validCopies &&
      sample.storageOutcome.lookupError == null && typeof sample.failure === "string" && sample.failure.length > 0;
    const failureIndex = legacyAllowed ? input.failures.findIndex((failure, index) => !matchedFailures.has(index) && failure === sample.failure) : -1;
    if (failureIndex >= 0) { matchedFailures.add(failureIndex); legacyConfirmedStoredErrors.push(evidence); }
    else blockingFailures.push(`Unaccepted client error in ${sample.phase}: ${error}`);
  });
  input.failures.forEach((failure, index) => { if (!matchedFailures.has(index)) blockingFailures.push(failure); });
  return { accepted: blockingFailures.length === 0 && currentClientErrors.length === 0, legacyConfirmedStoredErrors, blockingFailures, currentClientErrors };
}
