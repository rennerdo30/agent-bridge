import { expect, it } from "vitest";
import { evaluateRehearsalAcceptance, type RehearsalAcceptanceInput, type RehearsalSample } from "../scripts/release-acceptance.js";

const current = (): RehearsalSample => ({ phase: "sessions-reload", clientVersion: "0.30.2", storageOutcome: { state: "stored", ids: ["current-message-1"] } });
const legacy = (): RehearsalSample => ({ phase: "sessions-reload", clientVersion: "0.29.17", probeError: "Error: connection to broker closed", failure: "sessions-reload: Error: connection to broker closed; stored receipt message-1",
  storageOutcome: { state: "stored", localState: "stored", copies: [{ id: "message-1" }], lookupError: undefined } });
const green = (): RehearsalAcceptanceInput => ({ functionalVerified: true, cleanupVerified: true, latencyGatesPassed: true, currentClientVersion: "0.30.2", samples: [current()], failures: [] });
const withLegacy = (): RehearsalAcceptanceInput => { const sample = legacy(); return { ...green(), samples: [current(), sample], failures: [sample.failure!] }; };

it("accepts complete green evidence", () => {
  expect(evaluateRehearsalAcceptance(green())).toEqual({ accepted: true, legacyConfirmedStoredErrors: [], blockingFailures: [], currentClientErrors: [] });
});

it("accepts only the confirmed legacy retirement error without changing strict evidence", () => {
  const input = { ...withLegacy(), success: false }, before = structuredClone(input);
  const result = evaluateRehearsalAcceptance(input);
  expect(result.accepted).toBe(true); expect(result.legacyConfirmedStoredErrors).toMatchObject([{ phase: "sessions-reload", error: "Error: connection to broker closed", messageIds: ["message-1"] }]);
  expect(result).not.toHaveProperty("success"); expect(input).toEqual(before); expect(input.success).toBe(false);
});

it("never exempts a current-client error even with a stored receipt", () => {
  const input = withLegacy(); input.samples = [current(), { ...legacy(), clientVersion: "0.30.2" }];
  const result = evaluateRehearsalAcceptance(input);
  expect(result.accepted).toBe(false); expect(result.currentClientErrors).toHaveLength(1); expect(result.legacyConfirmedStoredErrors).toEqual([]);
});

it.each([
  ["wrong phase", { phase: "migration" }], ["wrong version", { clientVersion: "0.29.16" }], ["missing version", { clientVersion: undefined }],
  ["wrong error", { probeError: "request timeout" }], ["unconfirmed storage", { storageOutcome: { state: "unknown", localState: "stored", copies: [{ id: "message-1" }] } }],
  ["unconfirmed local storage", { storageOutcome: { state: "stored", localState: "unknown", copies: [{ id: "message-1" }] } }],
  ["failed lookup", { storageOutcome: { state: "stored", localState: "stored", copies: [{ id: "message-1" }], lookupError: "failed" } }],
  ["empty copies", { storageOutcome: { state: "stored", localState: "stored", copies: [] } }],
  ["invalid copy id", { storageOutcome: { state: "stored", localState: "stored", copies: [{ id: "message-1" }, { id: 123 }] } }],
  ["blank copy id", { storageOutcome: { state: "stored", localState: "stored", copies: [{ id: " " }] } }],
  ["missing failure", { failure: undefined }], ["different failure", { failure: "different raw failure" }],
] as const)("blocks %s evidence", (_name, patch) => {
  const input = withLegacy(); input.samples = [current(), { ...legacy(), ...patch }];
  expect(evaluateRehearsalAcceptance(input).accepted).toBe(false);
});

it("does not mask an unmatched or duplicate global failure", () => {
  for (const extra of ["unknown global failure", legacy().failure!]) {
    const input = withLegacy(); input.failures = [...input.failures, extra];
    const result = evaluateRehearsalAcceptance(input); expect(result.accepted).toBe(false); expect(result.blockingFailures).toContain(extra);
  }
  const input = withLegacy(); input.failures = [];
  expect(evaluateRehearsalAcceptance(input).accepted).toBe(false);
});

it.each(["functionalVerified", "cleanupVerified", "latencyGatesPassed"] as const)("requires %s even for the legacy exception", gate => {
  const input = withLegacy(); input[gate] = false; expect(evaluateRehearsalAcceptance(input).accepted).toBe(false);
});

it("requires current-version samples and rejects an old version labeled current", () => {
  const input = withLegacy(); input.samples = [legacy()]; expect(evaluateRehearsalAcceptance(input).accepted).toBe(false);
  input.currentClientVersion = "0.29.17"; expect(evaluateRehearsalAcceptance(input).accepted).toBe(false);
});

it.each([undefined, { state: 'unknown' }, { state: 'not_stored' }])("blocks unconfirmed non-error samples: %s", storageOutcome => {
  const input = green(); input.samples = [{ ...current(), storageOutcome }];
  expect(evaluateRehearsalAcceptance(input).accepted).toBe(false);
});
