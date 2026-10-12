import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BridgeConfig, loadConfig, saveConfigValue, watchConfig } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { until } from "./helpers.js";
import { configurePathDisplay, pathDisplayPrefersAlias } from "../src/core/display-paths.js";

describe("config file", () => {
  it("updates alias display preference when the home config is reloaded", async () => {
    const home = mkdtempSync(join(tmpdir(), "ab-cfg-paths-"));
    let stop: (() => void) | undefined;
    try {
      saveConfigValue(home, "pathDisplay", { preferAlias: true });
      loadConfig(home, "codex", nullLogger, {});
      let seen = false;
      stop = watchConfig(home, "codex", nullLogger, (cfg) => { seen = cfg.pathDisplay.preferAlias === false; });
      saveConfigValue(home, "pathDisplay", { preferAlias: false });
      await until(() => seen, 10_000);
      expect(pathDisplayPrefersAlias()).toBe(false);
    } finally { stop?.(); configurePathDisplay({ preferAlias: true }); rmSync(home, { recursive: true, force: true }); }
  }, 20_000);
  it("loads an absolute new-worktree root and rejects relative configuration", () => {
    const home = mkdtempSync(join(tmpdir(), "ab-cfg-")), root = join(home, "new-root");
    try {
      writeFileSync(join(home, "config.json"), JSON.stringify({ worktreeRoot: root }));
      expect(loadConfig(home, "codex", nullLogger, {}).worktreeRoot).toBe(root);
      writeFileSync(join(home, "config.json"), JSON.stringify({ worktreeRoot: "relative-root" }));
      expect(loadConfig(home, "codex", nullLogger, {}).worktreeRoot).toBeNull();
      expect(loadConfig(home, "codex", nullLogger, { AGENT_BRIDGE_WORKTREE_ROOT: root }).worktreeRoot).toBe(root);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it("loads worktree sandbox and workspace network options with safe defaults", () => {
    const home = mkdtempSync(join(tmpdir(), "ab-cfg-"));
    try {
      expect(loadConfig(home, "claude", nullLogger, {})).toMatchObject({ codexSandbox: "read-only", codexWorktreeSandbox: null, codexWorkspaceWriteNetworkAccess: null });
      writeFileSync(join(home, "config.json"), JSON.stringify({ codexWorktreeSandbox: "danger-full-access", codexWorkspaceWriteNetworkAccess: true, claude: { codexWorktreeSandbox: "workspace-write", codexWorkspaceWriteNetworkAccess: false } }));
      expect(loadConfig(home, "codex", nullLogger, {})).toMatchObject({ codexWorktreeSandbox: "danger-full-access", codexWorkspaceWriteNetworkAccess: true });
      expect(loadConfig(home, "claude", nullLogger, {})).toMatchObject({ codexWorktreeSandbox: "workspace-write", codexWorkspaceWriteNetworkAccess: false });
      saveConfigValue(home, "codexWorktreeSandbox", "invalid");
      expect(loadConfig(home, "codex", nullLogger, {}).codexWorktreeSandbox).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("is applied again when it changes", async () => {
    const home = mkdtempSync(join(tmpdir(), "ab-cfg-"));
    try {
      saveConfigValue(home, "maxJobs", 8);
      let seen: BridgeConfig | null = null;
      const stop = watchConfig(home, "claude", nullLogger, (c) => (seen = c));
      await new Promise((r) => setTimeout(r, 1_100)); // a new mtime, also on coarse file systems
      writeFileSync(join(home, "config.json"), JSON.stringify({ maxJobs: 12, claude: { maxJobs: 14 } }));
      await until(() => seen !== null, 10_000);
      expect(seen!.maxJobs).toBe(14);
      stop();
      saveConfigValue(home, "autoWake", true);
      expect(loadConfig(home, "codex", nullLogger, {})).toMatchObject({ maxJobs: 12, autoWake: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);

  it("reads a default effort for all subagents or per target", () => {
    const home = mkdtempSync(join(tmpdir(), "ab-cfg-"));
    try {
      saveConfigValue(home, "effort", "high");
      expect(loadConfig(home, "claude", nullLogger, {}).effort).toMatchObject({ codex: "high", claude: "high", opencode: "high" });
      saveConfigValue(home, "effort", { codex: "xhigh", bogus: "x", claude: "bad value!" });
      expect(loadConfig(home, "claude", nullLogger, {}).effort).toEqual({ codex: "xhigh" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
