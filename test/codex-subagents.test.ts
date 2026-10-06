import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexSubagentConfig } from "../src/core/codex-subagents.js";
import { loadConfig } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { changedJobArgs, parseJobSettings } from "../src/mcp/job-settings.js";
import { DELEGATION_TARGETS, nativeSubagentsSchema } from "../src/mcp/targets.js";
import { remoteSpawnArgsSchema } from "../src/network/remote-job-protocol.js";

describe("native Codex subagent limits", () => {
  it("uses six by default and disables both native backends without passing an invalid zero cap", () => {
    expect(codexSubagentConfig()).toMatchObject({ "agents.max_threads": 6, "features.multi_agent": true, "agents.enabled": true });
    expect(codexSubagentConfig(0)).toEqual({ "agents.max_threads": 1, "features.multi_agent": false, "features.multi_agent_v2": false, "agents.enabled": false });
    for (const value of [-1, 33, 1.5, NaN]) expect(() => codexSubagentConfig(value)).toThrow(/integer/);
  });

  it("loads legacy config and validates the default with per-agent precedence", () => {
    const home = mkdtempSync(join(tmpdir(), "ab-native-cfg-"));
    try {
      expect(loadConfig(home, "codex", nullLogger, {}).codexSubagents).toBe(6);
      writeFileSync(join(home, "config.json"), JSON.stringify({ codexSubagents: 3, codex: { codexSubagents: 0 } }));
      expect(loadConfig(home, "codex", nullLogger, {}).codexSubagents).toBe(0);
      expect(loadConfig(home, "claude", nullLogger, {}).codexSubagents).toBe(3);
      for (const value of [-1, 33, 1.5, "2bad", "1.5", null]) {
        writeFileSync(join(home, "config.json"), JSON.stringify({ codexSubagents: value }));
        expect(loadConfig(home, "codex", nullLogger, {}).codexSubagents).toBe(6);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("shares integer bounds across MCP, continuation, dashboard and optional remote spawn fields", () => {
    const old = { prompt: "task", title: "test", cwd: "/repo" };
    expect(remoteSpawnArgsSchema.parse(old)).not.toHaveProperty("native_subagents");
    expect(DELEGATION_TARGETS.codex.schema.native_subagents).toBe(nativeSubagentsSchema);
    for (const native_subagents of [0, 6, 32]) {
      expect(nativeSubagentsSchema.parse(native_subagents)).toBe(native_subagents);
      expect(remoteSpawnArgsSchema.parse({ ...old, native_subagents }).native_subagents).toBe(native_subagents);
      expect(parseJobSettings({ native_subagents }, "codex")).toEqual({ native_subagents });
    }
    for (const value of [-1, 33, 1.5, "2", null]) {
      expect(nativeSubagentsSchema.safeParse(value).success).toBe(false);
      expect(remoteSpawnArgsSchema.safeParse({ ...old, native_subagents: value }).success).toBe(false);
      expect(parseJobSettings({ native_subagents: value }, "codex")).toBe("invalid native_subagents");
    }
    expect(parseJobSettings({ native_subagents: 0 }, "claude")).toBe("native_subagents applies only to codex jobs.");
    expect(parseJobSettings({ native_subagents: 1 }, "opencode")).toBe("native_subagents applies only to codex jobs.");
    expect(changedJobArgs({ model: "saved", access: "read", native_subagents: 6 }, { native_subagents: 0 })).toEqual({ model: "saved", access: "read", native_subagents: 0 });
  });
});
