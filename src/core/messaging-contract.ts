/**
 * AB345 isolated policy draft. No runtime caller, wire advertisement, store
 * schema, receipt issuer or provider effect is implemented here. Route facts
 * describe the audited released source; they never confer control authority.
 */
export const MESSAGING_KINDS = ["claude", "codex", "opencode", "antigravity", "muse"] as const;
export type MessagingKind = typeof MESSAGING_KINDS[number];
export type MessagingRole = "session" | "delegated_job" | "native_child";
export type MessagingMode = "auto" | "queue" | "steer" | "restart";
export type MessagingActivity = "idle" | "busy" | "unknown";
export type MessagingRoute = "session_hooks" | "owned_job" | "scoped_child" | "unsupported";

export interface AuditedRoute {
  readonly route: MessagingRoute;
  readonly nativeActiveSteering: boolean;
  readonly boundaryInput: boolean;
  /** Existing mail retention mechanism; not receiver-side transactional acceptance. */
  readonly mailRetentionMechanism: boolean;
  /** Requires the receiving session's existing policy and available endpoint. */
  readonly conditionalIdleWake: boolean;
  /** No existing route has the reviewed AB345 restart/receipt contract. */
  readonly explicitModesReady: false;
  readonly interruptRestart: false;
}

/** Mechanism inventory only, not protocol capabilities advertised to peers. */
export function auditedRoute(kind: MessagingKind, role: MessagingRole): AuditedRoute {
  if (kind === "muse" || role === "native_child" && kind !== "claude") {
    return { route: "unsupported", nativeActiveSteering: false, boundaryInput: false,
      mailRetentionMechanism: false, conditionalIdleWake: false, explicitModesReady: false, interruptRestart: false };
  }
  return {
    route: role === "session" ? "session_hooks" : role === "native_child" ? "scoped_child" : "owned_job",
    nativeActiveSteering: kind === "codex" && role === "delegated_job",
    boundaryInput: true,
    mailRetentionMechanism: true,
    conditionalIdleWake: role === "session" && kind !== "antigravity",
    explicitModesReady: false,
    interruptRestart: false,
  };
}

export type ModeDisposition =
  | { readonly requested: MessagingMode; readonly action: "legacy_auto"; readonly effective: "unconfirmed" }
  | { readonly requested: MessagingMode; readonly action: "refuse"; readonly effective: "none";
      readonly reason: "unsupported_route" | "unknown_generation" | "no_active_turn" |
        "unknown_activity" | "explicit_contract_unavailable" };

/** Fail closed until supported routes are wired and protocol/issuer review lands. */
export function draftModeDisposition(kind: MessagingKind, role: MessagingRole,
  mode: MessagingMode = "auto", generationKnown = false, activity: MessagingActivity = "unknown"): ModeDisposition {
  if (auditedRoute(kind, role).route === "unsupported") {
    return { requested: mode, action: "refuse", effective: "none", reason: "unsupported_route" };
  }
  if (mode === "auto") return { requested: mode, action: "legacy_auto", effective: "unconfirmed" };
  if (generationKnown && mode === "steer" && activity !== "busy") {
    return { requested: mode, action: "refuse", effective: "none",
      reason: activity === "idle" ? "no_active_turn" : "unknown_activity" };
  }
  return { requested: mode, action: "refuse", effective: "none",
    reason: generationKnown ? "explicit_contract_unavailable" : "unknown_generation" };
}

/** Sender kind cannot grant capabilities; both ends must have a real mechanism. */
export function draftPairDisposition(sender: MessagingKind, senderRole: MessagingRole,
  receiver: MessagingKind, receiverRole: MessagingRole, mode: MessagingMode = "auto",
  generationKnown = false, activity: MessagingActivity = "unknown"): ModeDisposition {
  if (auditedRoute(sender, senderRole).route === "unsupported") {
    return { requested: mode, action: "refuse", effective: "none", reason: "unsupported_route" };
  }
  return draftModeDisposition(receiver, receiverRole, mode, generationKnown, activity);
}

/**
 * Logical identity comparison proposal; not an authenticated caller DTO or a
 * persisted schema. Issuer/receiver/generation must be derived by the broker.
 */
export interface LogicalCommand {
  readonly commandId: string;
  readonly messageId: string;
  readonly issuer: string;
  readonly receiver: string;
  readonly generation: string;
  readonly route: MessagingRoute;
  readonly mode: MessagingMode;
  readonly body: string;
  readonly conversationId: string | null;
  readonly replyTo: string | null;
  readonly ifNoNewerThan: string | null;
}

/** Exact comparison preserves whitespace, anchors and mode intent. */
export function compareLogicalCommand(original: LogicalCommand, retry: LogicalCommand): "duplicate" | "conflict" {
  return original.commandId === retry.commandId && original.messageId === retry.messageId &&
    original.issuer === retry.issuer && original.receiver === retry.receiver &&
    original.generation === retry.generation && original.route === retry.route &&
    original.mode === retry.mode && original.body === retry.body &&
    original.conversationId === retry.conversationId && original.replyTo === retry.replyTo &&
    original.ifNoNewerThan === retry.ifNoNewerThan ? "duplicate" : "conflict";
}

export const DELIVERY_RETRY_POLICY = Object.freeze({
  name: "messaging-current-generation-v1",
  initialDelayMs: 100,
  maxDelayMs: 5_000,
  maxRetries: 8,
});

/** Failed attempt count is zero-based; this computes a delay, never schedules IO. */
export function deliveryRetryDelay(retryIndex: number): number {
  if (!Number.isInteger(retryIndex) || retryIndex < 0 || retryIndex >= DELIVERY_RETRY_POLICY.maxRetries) {
    throw new RangeError("Retry index is outside the bounded delivery policy.");
  }
  return Math.min(DELIVERY_RETRY_POLICY.initialDelayMs * 2 ** retryIndex, DELIVERY_RETRY_POLICY.maxDelayMs);
}

export interface RetryEvidence {
  readonly negotiated: boolean;
  readonly authenticated: boolean;
  readonly authorized: boolean;
  readonly generationKnown: boolean;
  readonly stillCurrent: boolean;
  readonly stopped: boolean;
  readonly terminal: boolean;
  /** A receiver can durably reconcile the effect, including a lost ACK. */
  readonly receiverCanReconcile: boolean;
  readonly effectOutcome: "not_attempted" | "unknown" | "accepted";
}

/** Boolean policy evidence never confers authority or permits an actual effect. */
export function draftRetryPrerequisitesSatisfied(evidence: RetryEvidence, retryIndex: number): boolean {
  return Number.isInteger(retryIndex) && retryIndex >= 0 && retryIndex < DELIVERY_RETRY_POLICY.maxRetries &&
    evidence.negotiated && evidence.authenticated && evidence.authorized &&
    evidence.generationKnown && evidence.stillCurrent && !evidence.stopped && !evidence.terminal &&
    evidence.receiverCanReconcile && evidence.effectOutcome !== "accepted";
}
