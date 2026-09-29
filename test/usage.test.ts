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
  });

  it("picks the limit lines out of claude /usage", () => {
    const r = parseClaudeUsage("Usage\n\nCurrent session: 6% used · resets 10am\nCurrent week (all models): 66% used · resets Oct 6\n\nWhat's contributing …\n");
    expect(r.lines).toEqual(["Current session: 6% used · resets 10am", "Current week (all models): 66% used · resets Oct 6"]);
    expect(r.maxUsedPercent).toBe(66);
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
