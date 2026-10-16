import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { museUsage, recordMuseUsage, antigravityUsage, describeOpencodeCosts, formatCodexLimits, parseAntigravityUsage, parseClaudeUsage, parseOpencodeModelCosts, parseOpencodeStats, supportsAntigravityUsage } from "../src/core/usage.js";

describe("Muse plan usage", () => {
  const usage = (observedAtMs: number, used: number) => ({ observedAtMs, tier: "tier-a", window: { usedPercent: used, resetsAtMs: observedAtMs + 3_600_000, windowDurationMins: 300 }, weekly: { usedPercent: 9, resetsAtMs: observedAtMs + 86_400_000 } });
  it("shows the newest observation a Muse job recorded, and says when none exists", () => {
    const home = mkdtempSync(join(tmpdir(), "ab-muse-usage-"));
    try {
      expect(museUsage(home)).toMatchObject({ agent: "muse", limits: [], maxUsedPercent: null, lines: [expect.stringContaining("after the next Muse job")] });
      recordMuseUsage(home, usage(2_000_000, 40));
      recordMuseUsage(home, usage(1_000_000, 90)); // an older observation from a concurrent job
      recordMuseUsage(home, { observedAtMs: 3_000_000, tier: "tier-a" }); // malformed: ignored
      const report = museUsage(home, 2_000_100);
      expect(report.limits).toEqual([{ name: "5-hour window", usedPercent: 40, resets: expect.any(String) }, { name: "weekly", usedPercent: 9, resets: expect.any(String) }]);
      expect(report.maxUsedPercent).toBe(40);
      expect(report.lines[0]).toMatch(/^muse \[tier-a\]: 5-hour window 40% used/);
      // After the window reset only the weekly figure still holds.
      expect(museUsage(home, 2_000_000 + 7_200_000).maxUsedPercent).toBe(9);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

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
    expect(parseOpencodeStats(JSON.stringify({cost:0,tokens:{input:0,output:0}})).lines[1]).toBe("Today: cost $0, 0 input tokens, 0 output tokens");
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

  it("parses standalone Antigravity usage, quota, and credits JSONL output", () => {
    expect(supportsAntigravityUsage("Antigravity CLI version 1.1.10")).toBe(false);
    expect(supportsAntigravityUsage("Antigravity CLI version 1.1.11")).toBe(true);
    expect(supportsAntigravityUsage("1.2.0-rc.1")).toBe(false);
    expect(supportsAntigravityUsage("unknown")).toBe(false);
    expect(supportsAntigravityUsage("1.3.5 (f1ff571a79d7b6b5bd3be1fa9dd9c3ca4ab6fb48)")).toBe(true);
    const liveUsageJson = JSON.stringify({
      conversation_id: "",
      status: "SUCCESS",
      response: "Gemini Models\nWeekly Limit Remaining: 91%\nFive Hour Limit Remaining: 67%\n",
      duration_seconds: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
      command: {
        name: "usage",
        data: {
          description: "Your Google AI Plan includes two types of limits",
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.9197499752044678, reset_time: "2026-10-21T06:31:30Z" },
                { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.6790000796318054, reset_time: "2026-10-14T11:31:30Z" },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [
                { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-21T09:18:22Z" },
                { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-10-14T14:18:22Z" },
              ],
            },
          ],
        },
      },
    });
    const liveCreditsJson = JSON.stringify({
      conversation_id: "",
      status: "SUCCESS",
      response: "Remaining credits\t0\nUpgrade\thttps://antigravity.google/g1-upgrade\n",
      duration_seconds: 0,
      num_turns: 0,
      command: {
        name: "credits",
        data: {
          remaining_credits: 0,
          upgrade_uri: "https://antigravity.google/g1-upgrade",
        },
      },
    });
    const parsed = parseAntigravityUsage([liveUsageJson, liveCreditsJson].join("\n"));
    expect(parsed.agent).toBe("antigravity");
    expect(parsed.maxUsedPercent).toBe(32);
    expect(parsed.credits).toBeNull();
    expect(parsed.limits).toEqual([
      { name: "Gemini Models: weekly", usedPercent: 8, resets: expect.any(String) },
      { name: "Gemini Models: 5-hour window", usedPercent: 32, resets: expect.any(String) },
      { name: "Claude and GPT models: weekly", usedPercent: 0, resets: expect.any(String) },
      { name: "Claude and GPT models: 5-hour window", usedPercent: 0, resets: expect.any(String) },
    ]);
    expect(parsed.lines[0]).toContain("Gemini Models: weekly 8% used");
    expect(parsed.lines[0]).toContain("5-hour window 32% used");
    expect(parsed.lines.at(-1)).toBe("Credits: 0 available (plan quota remains usable)");

    const turn = parseAntigravityUsage(JSON.stringify({ type: "result", status: "SUCCESS", num_turns: 1, conversation_id: "conv-1", command: { name: "usage", data: {} } }));
    expect(turn.maxUsedPercent).toBeNull();
    expect(turn.lines[0]).toContain("conversation turn");

    const authErr = parseAntigravityUsage(JSON.stringify({ type: "result", status: "ERROR", error: "Authentication required" }));
    expect(authErr.maxUsedPercent).toBeNull();
    expect(authErr.lines).toEqual(["Account limit availability is unknown: Antigravity usage report failed (Authentication required)."]);
  });

  it("does not round non-exhausted Antigravity buckets to 100% or infer active credit spend across model groups", () => {
    const nearExhausted = parseAntigravityUsage(JSON.stringify({
      type: "result",
      status: "SUCCESS",
      num_turns: 0,
      conversation_id: "",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { window: "5h", remaining_fraction: 0.004, reset_time: "2026-10-14T12:00:00Z" },
                { window: "weekly", disabled: true },
              ],
            },
          ],
          remaining_credits: 4200,
        },
      },
    }));
    expect(nearExhausted.maxUsedPercent).toBe(99);
    expect(nearExhausted.limits[0]?.usedPercent).toBe(99);
    expect(nearExhausted.credits).toEqual({ balance: "4,200", unlimited: false, inUse: false });
    expect(nearExhausted.lines.at(-1)).toBe("Credits: 4,200 available");
    expect(nearExhausted.lines.join("\n")).not.toContain("running on credits");

    const mixedExhausted = parseAntigravityUsage([
      JSON.stringify({
        type: "result",
        status: "SUCCESS",
        num_turns: 0,
        conversation_id: "",
        command: {
          name: "usage",
          data: {
            groups: [
              { name: "Claude and GPT models", buckets: [{ window: "5h", remaining_fraction: 0 }] },
              { name: "Gemini Models", buckets: [{ window: "5h", remaining_fraction: 1 }] },
            ],
          },
        },
      }),
      JSON.stringify({
        type: "result",
        status: "SUCCESS",
        num_turns: 0,
        conversation_id: "",
        command: { name: "credits", data: { remaining_credits: 250 } },
      }),
    ].join("\n"));
    expect(mixedExhausted.maxUsedPercent).toBe(100);
    expect(mixedExhausted.credits).toEqual({ balance: "250", unlimited: false, inUse: false });
    expect(mixedExhausted.lines.at(-1)).toBe("Credits: 250 available");
    expect(mixedExhausted.lines.join("\n")).not.toContain("running on credits");

    const unlimitedNotInUse = parseAntigravityUsage(JSON.stringify({
      type: "result",
      status: "SUCCESS",
      num_turns: 0,
      conversation_id: "",
      command: {
        name: "usage",
        data: {
          groups: [{ name: "Claude and GPT models", buckets: [{ window: "5h", remaining_fraction: 0 }] }],
          credits: { unlimited: true },
        },
      },
    }));
    expect(unlimitedNotInUse.credits).toEqual({ balance: "unlimited", unlimited: true, inUse: false });
    expect(unlimitedNotInUse.lines.at(-1)).toBe("Credits: unlimited available");

    // F5 regression: every group's weekly window is exhausted (remaining_fraction: 0), even though 5h is 100% remaining.
    const weeklyBlockedAllGroups = parseAntigravityUsage([
      JSON.stringify({
        type: "result",
        status: "SUCCESS",
        num_turns: 0,
        conversation_id: "",
        command: {
          name: "usage",
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  { window: "weekly", remaining_fraction: 0 },
                  { window: "5h", remaining_fraction: 1 },
                ],
              },
              {
                name: "Claude and GPT models",
                buckets: [
                  { window: "weekly", remaining_fraction: 0 },
                  { window: "5h", remaining_fraction: 1 },
                ],
              },
            ],
          },
        },
      }),
      JSON.stringify({
        type: "result",
        status: "SUCCESS",
        num_turns: 0,
        conversation_id: "",
        command: { name: "credits", data: { remaining_credits: 0 } },
      }),
    ].join("\n"));
    expect(weeklyBlockedAllGroups.maxUsedPercent).toBe(100);
    expect(weeklyBlockedAllGroups.credits).toBeNull();
    expect(weeklyBlockedAllGroups.lines.at(-1)).toBe("Credits: 0 available");
    expect(weeklyBlockedAllGroups.lines.join("\n")).not.toContain("plan quota remains usable");

    // Distinct usable-group case: one group is blocked by its weekly window, while another group is unexhausted across all its windows.
    const oneUsableGroupWithZeroCredits = parseAntigravityUsage([
      JSON.stringify({
        type: "result",
        status: "SUCCESS",
        num_turns: 0,
        conversation_id: "",
        command: {
          name: "usage",
          data: {
            groups: [
              {
                name: "Claude and GPT models",
                buckets: [
                  { window: "weekly", remaining_fraction: 0 },
                  { window: "5h", remaining_fraction: 1 },
                ],
              },
              {
                name: "Gemini Models",
                buckets: [
                  { window: "weekly", remaining_fraction: 0.5 },
                  { window: "5h", remaining_fraction: 0.8 },
                ],
              },
            ],
          },
        },
      }),
      JSON.stringify({
        type: "result",
        status: "SUCCESS",
        num_turns: 0,
        conversation_id: "",
        command: { name: "credits", data: { remaining_credits: 0 } },
      }),
    ].join("\n"));
    expect(oneUsableGroupWithZeroCredits.maxUsedPercent).toBe(100);
    expect(oneUsableGroupWithZeroCredits.credits).toBeNull();
    expect(oneUsableGroupWithZeroCredits.lines.at(-1)).toBe("Credits: 0 available (plan quota remains usable)");
  });

  it("handles Antigravity CLI transport errors and oversized output safely", async () => {
    const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as any;
    const nonZero = await antigravityUsage(process.execPath, process.cwd(), log, [
      "-e",
      "const arg = process.argv.at(-1); if (arg === '--version') { console.log('1.3.5'); } else { console.log(JSON.stringify({ status: 'SUCCESS', num_turns: 0, conversation_id: '', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [{ window: '5h', remaining_fraction: 0.8 }] }] } } })); process.exit(1); }",
      "--",
    ]);
    expect(nonZero.maxUsedPercent).toBeNull();
    expect(nonZero.lines[0]).toContain("exit code 1");

    const unsupportedVersion = await antigravityUsage(process.execPath, process.cwd(), log, [
      "-e",
      "const arg = process.argv.at(-1); if (arg === '--version') { console.log('1.1.10'); } else { console.log(JSON.stringify({ status: 'SUCCESS', num_turns: 0, conversation_id: '', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [{ window: '5h', remaining_fraction: 0.8 }] }] } } })); }",
      "--",
    ]);
    expect(unsupportedVersion.maxUsedPercent).toBeNull();
    expect(unsupportedVersion.lines[0]).toContain("requires agy 1.1.11+");

    const oversized = await antigravityUsage(process.execPath, process.cwd(), log, [
      "-e",
      "const arg = process.argv.at(-1); if (arg === '--version') { console.log('1.3.5'); } else { console.log('x'.repeat(300000)); }",
      "--",
    ]);
    expect(oversized.maxUsedPercent).toBeNull();
    expect(oversized.lines[0]).toContain("exceeded 262144 bytes");
  });
});



