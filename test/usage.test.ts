import { describe, expect, it } from "vitest";
import { describeOpencodeCosts, formatCodexLimits, parseClaudeUsage, parseOpencodeModelCosts, parseOpencodeStats } from "../src/core/usage.js";

describe("usage limits", () => {
  it("formats Codex rate limits with windows and the highest usage", () => {
    const r = formatCodexLimits({
      rateLimitsByLimitId: {
        codex: { limitId: "codex", planType: "pro", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null }, secondary: { usedPercent: 95, windowDurationMins: 10080, resetsAt: null } },
      },
    });
    expect(r.lines).toEqual(["codex [pro]: 5-hour window 12% used, weekly 95% used"]);
    expect(r.maxUsedPercent).toBe(95);
    expect(r.limits).toEqual([{ name: "5-hour window", usedPercent: 12, resets: null }, { name: "weekly", usedPercent: 95, resets: null }]);
  });

  it("reads Codex credits, and whether they are in use", () => {
    const r = formatCodexLimits({
      rateLimits: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: null }, credits: { hasCredits: true, unlimited: false, balance: "62082.3000850000" }, rateLimitReachedType: "rate_limit_reached" },
    });
    expect(r.credits).toEqual({ balance: "62,082", unlimited: false, inUse: true });
    expect(r.lines[0]).toContain("usable, plan limit reached, running on credits (62,082 left)");
  });

  it("keeps credit-backed Codex usable when ordinary included usage is denied (AB-71)", () => {
    const r = formatCodexLimits({ ordinaryUsageAllowed: false, rateLimitsByLimitId: {
      codex: { planType: "pro", secondary: { usedPercent: 100, windowDurationMins: 10080 }, credits: { hasCredits: true, balance: "45914" }, rateLimitReachedType: "rate_limit_reached" },
    } });
    expect(r.lines).toEqual(["codex [pro]: weekly 100% used, usable, plan limit reached, running on credits (45,914 left)"]);
    expect(r.credits).toEqual({ balance: "45,914", unlimited: false, inUse: true });
    expect(r.maxUsedPercent).toBe(100); // The dashboard still shows the exhausted plan bar.
    expect(r.lines.join("\n")).not.toMatch(/unusable|LIMIT REACHED|does not allow ordinary usage/);
  });

  it("supports unlimited credits and exhaustion without a reached-type flag", () => {
    const r = formatCodexLimits({ ordinaryUsageAllowed: false, rateLimits: { credits: { hasCredits: true, unlimited: true, balance: null } } });
    expect(r.credits).toEqual({ balance: "unlimited", unlimited: true, inUse: true });
    expect(r.lines).toEqual(["codex: usable, plan limit reached, running on credits (unlimited left)"]);
  });

  it("does not mistake zero, negative, malformed or disabled credits for usable funds", () => {
    for (const credit of [
      { hasCredits: true, balance: "0" }, { hasCredits: true, balance: "-1" },
      { hasCredits: true, balance: "unknown" }, { hasCredits: false, balance: "45914" },
    ]) {
      const r = formatCodexLimits({ ordinaryUsageAllowed: false, rateLimits: { credits: credit, rateLimitReachedType: "rate_limit_reached" } });
      expect(r.credits).toBeNull();
      expect(r.lines.join("\n")).not.toContain("running on credits");
    }
    expect(formatCodexLimits({ ordinaryUsageAllowed: false, rateLimits: { credits: { hasCredits: false, balance: "0" } } }).lines).toContain("Unusable: included usage is unavailable and credits are exhausted.");
    expect(formatCodexLimits({ ordinaryUsageAllowed: false, rateLimits: { credits: { hasCredits: true, balance: "unknown" } } }).lines).toContain("Included usage is unavailable; credit-backed usage availability is unknown.");
  });

  it("does not call an unknown usage state unusable based on a plan flag alone", () => {
    const r = formatCodexLimits({ ordinaryUsageAllowed: null, rateLimits: { rateLimitReachedType: "rate_limit_reached" } });
    expect(r.lines).toEqual(["codex: Plan limit reached (rate_limit_reached)"]);
  });

  it("keeps workspace and spend-control blocks visible even with credits", () => {
    for (const state of [
      { rateLimitReachedType: "workspace_owner_credits_depleted" },
      { rateLimitReachedType: "workspace_member_credits_depleted" },
      { rateLimitReachedType: "workspace_owner_usage_limit_reached" },
      { rateLimitReachedType: "workspace_member_usage_limit_reached" },
      { spendControlReached: true },
    ]) {
      const r = formatCodexLimits({ ordinaryUsageAllowed: false, rateLimits: { ...state, credits: { hasCredits: true, balance: "45914" } } });
      expect(r.credits?.inUse).toBe(false);
      expect(r.lines.join("\n")).toContain("unusable:");
      expect(r.lines.join("\n")).not.toContain("running on credits");
    }
  });

  it("preserves active credit state across buckets and small positive balances", () => {
    const r = formatCodexLimits({ rateLimitsByLimitId: {
      codex: { primary: { usedPercent: 100, windowDurationMins: 300 }, credits: { hasCredits: true, balance: "0.25" } },
      review: { credits: { hasCredits: true, balance: "0.25" } },
    } });
    expect(r.credits).toEqual({ balance: "0.25", unlimited: false, inUse: true });
    expect(r.lines[0]).toContain("running on credits (0.25 left)");
    expect(r.lines[1]).toContain("credits 0.25 available");
  });

  it("falls back to the historical snapshot when the bucket map is empty", () => {
    const r = formatCodexLimits({ rateLimitsByLimitId: {}, rateLimits: { credits: { hasCredits: true, balance: "45914" } } });
    expect(r.credits?.balance).toBe("45,914");
    expect(r.credits?.inUse).toBe(false);
  });

  it("picks the limit lines out of claude /usage", () => {
    const r = parseClaudeUsage("Usage\n\nCurrent session: 6% used · resets 10am\nCurrent week (all models): 66% used · resets Oct 6\n\nWhat's contributing …\n");
    expect(r.lines).toEqual(["Current session: 6% used · resets 10am", "Current week (all models): 66% used · resets Oct 6"]);
    expect(r.maxUsedPercent).toBe(66);
    expect(r.limits).toEqual([{ name: "session", usedPercent: 6, resets: "10am" }, { name: "week (all models)", usedPercent: 66, resets: "Oct 6" }]);
  });

  it("reads opencode spend and which models are free", () => {
    expect(parseOpencodeStats("│Total Cost      $0.12 │\n│Input   3.8M │\n│Output  171.3K │").lines[1]).toBe("Last 24 hours: cost $0.12, 3.8M input tokens, 171.3K output tokens");
    const verbose = [
      "opencode/muse-spark-1.3-free",
      JSON.stringify({ id: "muse", cost: { input: 0, output: 0 } }, null, 2),
      "anthropic/claude-sonnet-5",
      JSON.stringify({ id: "sonnet", cost: { input: 3, output: 15 } }, null, 2),
    ].join("\n");
    const costs = parseOpencodeModelCosts(verbose);
    expect(costs).toEqual([
      { id: "opencode/muse-spark-1.3-free", input: 0, output: 0 },
      { id: "anthropic/claude-sonnet-5", input: 3, output: 15 },
    ]);
    const lines = describeOpencodeCosts(costs, "claude-sonnet-5");
    expect(lines[0]).toBe("Model anthropic/claude-sonnet-5 costs $3 input / $15 output per million tokens.");
    expect(lines[1]).toContain("opencode/muse-spark-1.3-free");
  });
});
