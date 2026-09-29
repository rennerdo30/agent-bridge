import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codexEnvironmentNote, codexWindowsSandbox } from "../src/core/codex-env.js";

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

  it("says nothing elsewhere or without the elevated sandbox", () => {
    expect(codexWindowsSandbox(home('[windows]\nsandbox = "elevated"\n'), "linux")).toBeNull();
    expect(codexEnvironmentNote(home('[windows]\nsandbox = "unelevated"\n'), "win32")).toBe("");
    expect(codexEnvironmentNote(home("model = \"x\"\n"), "win32")).toBe("");
  });
});
