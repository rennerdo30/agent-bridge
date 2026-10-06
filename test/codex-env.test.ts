import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexEnvironmentNote, codexExecutionPrompt, codexWindowsSandbox } from "../src/core/codex-env.js";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function home(toml: string): string {
  const h = mkdtempSync(join(tmpdir(), "ab-cxenv-"));
  homes.push(h);
  mkdirSync(join(h, ".codex"));
  writeFileSync(join(h, ".codex", "config.toml"), toml);
  return h;
}

describe("codex environment note", () => {
  it("reads the Windows sandbox kind from its own table only", () => {
    const h = home('sandbox = "outside"\n[windows]\nsandbox = "elevated"\n[projects.x]\nsandbox = "other"\n');
    expect(codexWindowsSandbox(h, "win32")).toBe("elevated");
    expect(codexEnvironmentNote(h, "win32")).toContain("python is not recognized");
  });

  it("limits separate-user warnings to elevated sandboxed execution", () => {
    expect(codexWindowsSandbox(home('[windows]\nsandbox = "elevated"\n'), "linux")).toBeNull();
    expect(codexEnvironmentNote(home('[windows]\nsandbox = "elevated"\n'), "linux")).toBe("");
    for (const h of [home('[windows]\nsandbox = "unelevated"\n'), home('model = "x"\n')]) {
      const note = codexEnvironmentNote(h, "win32");
      expect(note).toContain("danger-full-access executes as the bridge process user");
      expect(note).toContain("USB/adb");
      expect(note).not.toContain("This machine uses a separate Windows sandbox user");
    }
  });

  it.each(["read-only", "workspace-write", "danger-full-access"] as const)("instructs %s jobs to check identity before reporting absent devices", (sandbox) => {
    const prompt = codexExecutionPrompt("inspect phone", sandbox, "win32");
    expect(prompt).toContain("inspect phone");
    expect(prompt).toContain("verify with whoami");
    expect(prompt).toContain("can't see devices from the sandbox");
    expect(prompt).toContain("claude/opencode subagent");
    expect(prompt.includes("Full-access commands should run as the bridge process user")).toBe(sandbox === "danger-full-access");
    expect(codexExecutionPrompt("inspect phone", sandbox, "linux")).toBe("inspect phone");
  });
});
