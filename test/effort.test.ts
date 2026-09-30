import { describe, expect, it } from "vitest";
import { claudeSettingsEffort, codexConfigEffort } from "../src/core/effort.js";

describe("default reasoning effort", () => {
  it("reads Codex's top-level model_reasoning_effort, not one inside a table", () => {
    expect(codexConfigEffort('model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\n[profiles.x]\nmodel_reasoning_effort = "high"')).toBe("low");
    expect(codexConfigEffort('model = "x"\n[profiles.x]\nmodel_reasoning_effort = "high"')).toBeNull();
  });

  it("prefers Claude's per-model effortLevel over the global one", () => {
    const settings = JSON.stringify({ effortLevel: "high", modelSettings: { "claude-opus-5-5": { effortLevel: "medium" } } });
    expect(claudeSettingsEffort(settings, "claude-opus-5-5[1m]")).toBe("medium");
    expect(claudeSettingsEffort(settings, "claude-sonnet-5-5")).toBe("high");
    expect(claudeSettingsEffort(JSON.stringify({}), "claude-opus-5-5")).toBeNull();
  });
});
