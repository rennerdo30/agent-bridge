import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeStep, parseInstallerArgs, planFor, runInstaller } from "../src/cli/installer.js";
import * as delegate from "../src/core/delegate.js";
import * as codexUsers from "../src/cli/codex-users.js";
import { APP_VERSION } from "../src/core/constants.js";

describe("installer plans", () => {
  it("only runs the official plugin commands", () => {
    expect(planFor("claude", "install").map(describeStep)).toEqual([
      "claude plugin marketplace add rennerdo30/agent-bridge",
      "claude plugin marketplace update agent-bridge",
      "claude plugin install agent-bridge@agent-bridge",
    ]);
    expect(planFor("codex", "install").map(describeStep)).toEqual([
      "codex plugin marketplace add rennerdo30/agent-bridge",
      "codex plugin marketplace upgrade agent-bridge",
      "codex plugin add agent-bridge@agent-bridge",
    ]);
    expect(planFor("claude", "uninstall").map(describeStep)).toEqual(["claude plugin uninstall agent-bridge@agent-bridge"]);
    expect(planFor("codex", "uninstall").map(describeStep)).toEqual(["codex plugin remove agent-bridge@agent-bridge"]);
    expect(planFor("opencode", "update")).toEqual([{ kind: "opencode", action: "update" }]);
    expect(planFor("codex", "update")).toEqual([{ kind: "live-update", tool: "codex" }]);
    expect(planFor("claude", "update")).toEqual([{ kind: "live-update", tool: "claude" }]);
  });

  it("selects tools from the arguments, or all of them", () => {
    expect(parseInstallerArgs("install", ["codex", "--yes"])).toEqual(["codex"]);
    expect(parseInstallerArgs("install", [])).toEqual(["claude", "codex", "opencode", "antigravity"]);
  });

  it("updates a mocked Codex without enumerating or stopping twenty running sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "ab-installer-live-")), lines: string[] = [];
    const resolver = vi.spyOn(delegate, "resolveBinary").mockReturnValue("mock-codex");
    const running = vi.spyOn(codexUsers, "listCodexUsers").mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ pid: i + 1, kind: "session", started: "now" })));
    vi.stubEnv("CODEX_HOME", join(root, "codex")); vi.stubEnv("AGENT_BRIDGE_HOME", join(root, "bridge"));
    try {
      expect(await runInstaller({ action: "update", tools: ["codex"], yes: true, out: (line) => lines.push(line) })).toBe(0);
      expect(running).not.toHaveBeenCalled();
      expect(existsSync(join(root, "codex", "plugins", "cache", "agent-bridge", "agent-bridge", APP_VERSION, "dist", "worker.mjs"))).toBe(true);
      expect(lines.join("\n")).toContain("No sessions were stopped");
      expect(lines.join("\n")).not.toContain("Skipped codex");
    } finally { resolver.mockRestore(); running.mockRestore(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true, maxRetries: 3 }); }
  });
});
