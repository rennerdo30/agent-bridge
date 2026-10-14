import { describe, expect, it } from "vitest";
import { classifyProviderFailure, type ProviderFailureAgent, type ProviderFailureKind } from "../src/core/provider-failure.js";

// Synthetic error-only fixtures: no CLI, account, provider or sleeps are involved.
const agents: ProviderFailureAgent[] = ["codex", "claude", "opencode", "antigravity"];
const fixtures: [ProviderFailureAgent, string, ProviderFailureKind][] = [
  ["codex", "Selected model is at capacity. Please try a different model.", "capacity"],
  ["codex", "You've hit your usage limit", "usage_limit"],
  ["codex", "Weekly usage limit reached", "usage_limit"],
  ["claude", "API Error: overloaded_error: Overloaded", "capacity"],
  ["claude", "You've hit your limit · resets 5pm", "usage_limit"],
  ["claude", "Plan limit exceeded", "usage_limit"],
  ["opencode", "Anthropic API overloaded_error: Overloaded", "capacity"],
  ["opencode", "Your credit balance is too low to access the Anthropic API", "no_credits"],
  ["opencode", "billing_required: billing required", "billing_required"],
  ["antigravity", "Model capacity exhausted. Try again later.", "capacity"],
  ["antigravity", "Weekly limit reached", "usage_limit"],
  ["antigravity", "Payment required", "billing_required"],
];

describe("per-CLI provider failure evidence", () => {
  it.each(fixtures)("%s: %s => %s", (agent, message, kind) => {
    expect(classifyProviderFailure({ agent, model: "reported-model", message })).toEqual({
      agent, model: "reported-model", message, kind, retryable: kind === "capacity",
    });
  });

  it.each(agents)("%s terminal codes beat capacity regardless of order", agent => {
    for (const [code, kind] of [["usage_limit", "usage_limit"], ["no_credits", "no_credits"], ["billing_required", "billing_required"]] as const) {
      for (const codes of [["model_at_capacity", code], [code, "model_at_capacity"]]) {
        const result = classifyProviderFailure({ agent, model: "m", message: "Model is at capacity", codes });
        expect(result.kind).toBe(kind);
        expect(result.retryable).toBe(false);
      }
    }
  });

  it.each(agents)("%s terminal text in a separate error fragment wins", agent => {
    const result = classifyProviderFailure({ agent, model: "m", message: "Model is at capacity",
      additionalMessages: ["Your credit balance is too low to access the Anthropic API"] });
    expect(result.kind).toBe("no_credits");
    expect(result.retryable).toBe(false);
    expect(result.message).toContain("credit balance");
  });

  it("classifies terminal evidence beyond the stored-message bound", () => {
    const result = classifyProviderFailure({ agent: "codex", model: "m",
      message: "Selected model is at capacity " + "x".repeat(2_100), additionalMessages: ["usage limit reached"] });
    expect(result).toMatchObject({ kind: "usage_limit", retryable: false });
    expect(result.message.length).toBe(2_000);
    expect(result.message).toContain("usage limit reached");
  });

  it("uses a stable terminal tie break without making mixed errors retryable", () => {
    expect(classifyProviderFailure({ agent: "opencode", model: "m", message: "Overloaded",
      additionalMessages: ["usage limit reached", "no credits", "billing required"] })).toMatchObject({ kind: "billing_required", retryable: false });
  });

  it.each(["429", "HTTP 429 Too Many Requests", "RESOURCE_EXHAUSTED", "quota exceeded", "credits: {}", "credits: null",
    "billing status unknown", "internal server error 500", "ECONNRESET", "SQLITE_BUSY", "upstream unavailable", ""])("keeps ambiguous evidence nonretryable: %s", message => {
    for (const agent of agents) expect(classifyProviderFailure({ agent, model: null, message })).toMatchObject({ kind: "unknown", retryable: false, model: null });
  });

  it("never infers quota or transient capacity from a bare status/code, even with a retry header", () => {
    expect(classifyProviderFailure({ agent: "antigravity", model: "m", message: "", codes: ["RESOURCE_EXHAUSTED"] })).toMatchObject({ kind: "unknown" });
    expect(classifyProviderFailure({ agent: "codex", model: "m", message: "HTTP 429", codes: ["429"], reportedRetryAfterMs: 30_000 })).toMatchObject({ kind: "unknown", retryable: false });
    expect(classifyProviderFailure({ agent: "opencode", model: "m", message: "Overloaded; quota status unknown" })).toMatchObject({ kind: "unknown", retryable: false });
  });

  it("keeps CLI-specific overload patterns scoped", () => {
    expect(classifyProviderFailure({ agent: "codex", model: "m", message: "Overloaded" }).kind).toBe("unknown");
    expect(classifyProviderFailure({ agent: "antigravity", model: "m", message: "Overloaded" }).kind).toBe("unknown");
    expect(classifyProviderFailure({ agent: "claude", model: "m", message: "", codes: [" OVERLOADED_ERROR "] }).kind).toBe("capacity");
  });

  it.each(["Model is not at capacity", "It is not true that model is at capacity", "Model is at capacity: false",
    "Model capacity exhausted? unknown", "Service is not overloaded", "No overload detected", "Overloaded: false",
    "Possibly overloaded", "Unknown whether model is overloaded", "No usage limit reached", "Usage limit status unknown",
    "Usage limit reached: false", "Weekly limit not reached", "Billing is not required", "Billing required? unknown",
    "Credit balance is not too low", "Insufficient credits: false", "No credits issue detected", "No evidence of rate limit exceeded",
    "Rate limit exceeded: false", "Too many requests? unknown"])("does not turn a denial/ambiguous report into positive evidence: %s", message => {
    for (const agent of agents) expect(classifyProviderFailure({ agent, model: null, message, reportedRetryAfterMs: 1 })).toMatchObject({ kind: "unknown", retryable: false });
  });

  it("retains proved terminal facts independently of a later negated overload or unknown model", () => {
    expect(classifyProviderFailure({ agent: "codex", model: null, message: "Usage limit reached. Model is not at capacity" })).toMatchObject({ kind: "usage_limit", retryable: false });
    expect(classifyProviderFailure({ agent: "opencode", model: null, message: "Overloaded: false", additionalMessages: ["no credits"] })).toMatchObject({ kind: "no_credits", retryable: false });
    expect(classifyProviderFailure({ agent: "claude", model: null, message: "Unknown model", codes: ["billing_required"] })).toMatchObject({ kind: "billing_required", retryable: false });
  });

  it("does not retry contradictory transient codes or a vague usage-limit mention", () => {
    expect(classifyProviderFailure({ agent: "claude", model: "m", message: "Overloaded: false", codes: ["overloaded_error"] })).toMatchObject({ kind: "unknown", retryable: false });
    expect(classifyProviderFailure({ agent: "codex", model: "m", message: "Selected model is at capacity; usage limit status unknown" })).toMatchObject({ kind: "unknown", retryable: false });
    expect(classifyProviderFailure({ agent: "codex", model: null, message: "usage limit" })).toMatchObject({ kind: "unknown", retryable: false });
    expect(classifyProviderFailure({ agent: "codex", model: "m", message: "Model is at capacity. Model is not at capacity" })).toMatchObject({ kind: "unknown", retryable: false });
  });

  it.each([
    ["Usage limit reached, reset time unknown", "usage_limit"],
    ["Usage limit reached, model attribution unknown", "usage_limit"],
    ["Weekly limit reached, details unclear", "usage_limit"],
    ["Your credit balance is too low, billing instructions unknown", "no_credits"],
    ["No credits, reset date unknown", "no_credits"],
    ["Billing required, payment instructions unknown", "billing_required"],
  ] as const)("keeps definite terminal proof despite uncertain details: %s", (message, kind) => {
    for (const agent of agents) {
      const result = classifyProviderFailure({ agent, model: null, message });
      expect(result).toMatchObject({ kind, retryable: false, model: null });
      expect(result).not.toHaveProperty("resetAt");
      expect(result).not.toHaveProperty("retryAfterMs");
    }
  });

  it.each(["Usage limit not reached, reset time unknown", "Usage limit reached, actually not reached",
    "Usage limit reached, actually false", "Usage limit reached, quota status unknown", "No credits, credits status unknown",
    "Your credit balance is not too low, billing instructions unknown", "Billing is not required, details unknown",
    "Usage limit reached, reset time unknown and usage limit not reached", "Usage limit reached. Usage limit not reached",
    "No credits. Credit balance is not too low"])("keeps actual exhaustion denials/contradictions unknown: %s", message => {
    for (const agent of agents) expect(classifyProviderFailure({ agent, model: null, message })).toMatchObject({ kind: "unknown", retryable: false });
  });

  it.each(agents)("%s rate-limit retry-after boundaries require actual positive short facts", agent => {
    for (const reportedRetryAfterMs of [1, 60_000]) expect(classifyProviderFailure({ agent, model: "m", message: "Rate limit exceeded", reportedRetryAfterMs })).toMatchObject({ kind: "capacity", retryAfterMs: reportedRetryAfterMs });
    for (const reportedRetryAfterMs of [undefined, 0, -1, 60_001, Infinity, NaN, 0.5]) expect(classifyProviderFailure({ agent, model: "m", message: "Rate limit exceeded", reportedRetryAfterMs })).toMatchObject({ kind: "unknown", retryable: false });
    // Rate limit plus overload still needs an explicit short rate-limit delay.
    expect(classifyProviderFailure({ agent, model: "m", message: "Model is at capacity; rate limit exceeded" }).kind).toBe("unknown");
    expect(classifyProviderFailure({ agent, model: "m", message: "Usage limit reached; rate limit exceeded", reportedRetryAfterMs: 1 }).kind).toBe("usage_limit");
  });

  it("does not invent reset times from human local times or capacity backoff", () => {
    expect(classifyProviderFailure({ agent: "claude", model: "m", message: "You've hit your limit · resets 5pm" })).not.toHaveProperty("resetAt");
    expect(classifyProviderFailure({ agent: "codex", model: "m", message: "Model is at capacity" })).not.toHaveProperty("retryAfterMs");
    const facts = classifyProviderFailure({ agent: "opencode", model: "m", message: "no credits", reportedResetAt: 1_900_000_000_000, reportedRetryAfterMs: 5_000 });
    expect(facts).toMatchObject({ kind: "no_credits", resetAt: 1_900_000_000_000, retryAfterMs: 5_000, retryable: false });
  });

  it.each(["usage limit reached", "no credits", "billing required"])("stops proved terminal evidence without model attribution: %s", message => {
    expect(classifyProviderFailure({ agent: "codex", model: null, message })).toMatchObject({ model: null, retryable: false });
    expect(classifyProviderFailure({ agent: "codex", model: null, message }).kind).not.toBe("unknown");
  });

  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid reported timestamps: %s", reportedResetAt => {
    expect(classifyProviderFailure({ agent: "codex", model: "m", message: "usage limit reached", reportedResetAt })).not.toHaveProperty("resetAt");
  });
});
