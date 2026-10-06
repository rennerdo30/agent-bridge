import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RELAY_DEFINITIONS = [
  ["claude", "codex.md", "ask_codex"],
  ["claude", "opencode.md", "ask_opencode"],
  ["opencode", "codex.agent.md", "bridge_ask_codex"],
  ["opencode", "claude.agent.md", "bridge_ask_claude"],
] as const;

describe("native relay agent contracts (AB-74)", () => {
  it.each(RELAY_DEFINITIONS)("keeps %s/%s a single-call relay", (provider, file, tool) => {
    const definition = readFileSync(join(import.meta.dirname, "..", "plugins", provider, "agents", file), "utf8");
    const frontmatter = definition.split("---")[1]!;
    expect(frontmatter).not.toMatch(/^maxTurns:/m); // Task duration must not exhaust a relay turn budget.
    if (provider === "claude") expect(frontmatter).toContain(`tools: mcp__plugin_agent-bridge_bridge__${tool}`);
    expect(definition).toContain(`Call \`${tool}\` exactly once`);
    expect(definition).toContain("one blocking tool call");
    expect(definition).toContain("Do not poll");
    expect(definition).toContain("Do not retry automatically");
    expect(definition).toContain("job id, session_id, result and any error");
    expect(definition).not.toContain("call once more");
    expect(definition).not.toContain("the task did not reach");
  });
});
