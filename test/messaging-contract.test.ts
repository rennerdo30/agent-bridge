/** Policy/refusal draft only. No fake provider result is integration evidence. */
import { describe, expect, it } from "vitest";
import { auditedRoute, compareLogicalCommand, deliveryRetryDelay, DELIVERY_RETRY_POLICY,
  draftModeDisposition, draftPairDisposition, draftRetryPrerequisitesSatisfied, MESSAGING_KINDS,
  type LogicalCommand, type MessagingRole, type RetryEvidence } from "../src/core/messaging-contract.js";

const roles: MessagingRole[] = ["session", "delegated_job", "native_child"];

describe("AB345 draft sender/receiver policy matrix (not route integration)", () => {
  for (const sender of MESSAGING_KINDS) for (const receiver of MESSAGING_KINDS) {
    for (const activity of ["idle", "busy"] as const) {
      it(`${sender} -> ${receiver}, ${activity}: refuses unnegotiated explicit effects across roles`, () => {
        for (const senderRole of roles) for (const role of roles) {
          // Busy activity and sender kind cannot create authority or protocol support.
          for (const mode of ["queue", "steer", "restart"] as const) {
            expect(draftPairDisposition(sender, senderRole, receiver, role, mode, true, activity))
              .toMatchObject({ action: "refuse", effective: "none" });
          }
          const automatic = draftPairDisposition(sender, senderRole, receiver, role, "auto", false, activity);
          const unsupported = sender === "muse" || receiver === "muse" ||
            senderRole === "native_child" && sender !== "claude" || role === "native_child" && receiver !== "claude";
          expect(automatic.action).toBe(unsupported ? "refuse" : "legacy_auto");
          expect(auditedRoute(receiver, role).explicitModesReady).toBe(false);
        }
      });
    }
  }
});

it("distinguishes owned Codex steering from a foreign session queue and scoped native mail", () => {
  expect(auditedRoute("codex", "delegated_job").nativeActiveSteering).toBe(true);
  expect(auditedRoute("codex", "session").nativeActiveSteering).toBe(false);
  expect(auditedRoute("claude", "native_child")).toMatchObject({ route: "scoped_child", conditionalIdleWake: false });
  expect(auditedRoute("antigravity", "session")).toMatchObject({ boundaryInput: true, conditionalIdleWake: false });
  for (const kind of MESSAGING_KINDS) for (const role of roles) expect(auditedRoute(kind, role).interruptRestart).toBe(false);
});

it("does not turn unknown generation or legacy auto into an effective steer/resume claim", () => {
  expect(draftModeDisposition("codex", "delegated_job", "steer")).toMatchObject({ reason: "unknown_generation" });
  expect(draftModeDisposition("codex", "delegated_job", "steer", true, "idle")).toMatchObject({ reason: "no_active_turn" });
  expect(draftModeDisposition("codex", "delegated_job", "steer", true)).toMatchObject({ reason: "unknown_activity" });
  expect(draftModeDisposition("codex", "delegated_job", "steer", true, "busy")).toMatchObject({ reason: "explicit_contract_unavailable" });
  expect(draftModeDisposition("codex", "delegated_job", "auto")).toEqual({ requested: "auto", action: "legacy_auto", effective: "unconfirmed" });
});

const command: LogicalCommand = {
  commandId: "11111111-1111-4111-8111-111111111111",
  messageId: "22222222-2222-4222-8222-222222222222",
  issuer: "authenticated-issuer", receiver: "resolved-receiver", generation: "current-generation",
  route: "session_hooks", mode: "queue", body: "Original accepted text\n", conversationId: null, replyTo: null, ifNoNewerThan: null,
};

it("recognizes the exact logical retry without modifying the original", () => {
  const original = Object.freeze({ ...command });
  expect(compareLogicalCommand(original, { ...command })).toBe("duplicate");
  expect(original.body).toBe("Original accepted text\n");
});

it("refuses every changed immutable payload/identity field", () => {
  const changes: LogicalCommand[] = [
    { ...command, commandId: "new-command" }, { ...command, messageId: "new-message" },
    { ...command, issuer: "same-display-name-different-issuer" }, { ...command, receiver: "different-receiver" },
    { ...command, generation: "next-generation" }, { ...command, route: "owned_job" },
    { ...command, mode: "restart" }, { ...command, body: command.body.trim() },
    { ...command, conversationId: "other-conversation" }, { ...command, replyTo: "other-anchor" },
    { ...command, ifNoNewerThan: "other-guard" },
  ];
  for (const changed of changes) expect(compareLogicalCommand(command, changed)).toBe("conflict");
});

const evidence: RetryEvidence = {
  negotiated: true, authenticated: true, authorized: true, generationKnown: true,
  stillCurrent: true, stopped: false, terminal: false, receiverCanReconcile: true, effectOutcome: "not_attempted",
};

it("names and bounds the delay through 5 seconds and refuses invalid indices", () => {
  expect(DELIVERY_RETRY_POLICY.name).toBe("messaging-current-generation-v1");
  expect(Array.from({ length: DELIVERY_RETRY_POLICY.maxRetries }, (_, i) => deliveryRetryDelay(i)))
    .toEqual([100, 200, 400, 800, 1600, 3200, 5000, 5000]);
  for (const invalid of [-1, 0.5, NaN, Infinity, DELIVERY_RETRY_POLICY.maxRetries]) {
    expect(() => deliveryRetryDelay(invalid)).toThrow(RangeError);
    expect(draftRetryPrerequisitesSatisfied(evidence, invalid)).toBe(false);
  }
});

it("requires real receiver reconciliation for lost ACK or restart uncertainty", () => {
  expect(draftRetryPrerequisitesSatisfied({ ...evidence, effectOutcome: "unknown" }, 0)).toBe(true);
  expect(draftRetryPrerequisitesSatisfied({ ...evidence, effectOutcome: "unknown", receiverCanReconcile: false }, 0)).toBe(false);
  expect(draftRetryPrerequisitesSatisfied({ ...evidence, effectOutcome: "accepted" }, 0)).toBe(false);
});

it("stop, terminal settlement, stale generation and revoked authority refuse retries immediately", () => {
  const refusals: RetryEvidence[] = [
    { ...evidence, stopped: true }, { ...evidence, terminal: true }, { ...evidence, stillCurrent: false },
    { ...evidence, generationKnown: false }, { ...evidence, authorized: false },
    { ...evidence, authenticated: false }, { ...evidence, negotiated: false }, { ...evidence, receiverCanReconcile: false },
  ];
  for (const refused of refusals) expect(draftRetryPrerequisitesSatisfied(refused, 0)).toBe(false);
  expect(command.body).toBe("Original accepted text\n"); // Policy has no delete/evict operation.
});
