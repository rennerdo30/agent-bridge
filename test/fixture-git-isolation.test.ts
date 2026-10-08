import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { canonicalProjectRoot } from "../src/core/project-identity.js";
import { resolveHome, resolvePipePath } from "../src/core/paths.js";

it("isolates default bridge storage and endpoints from the invoking session", () => {
  const home = join(process.cwd(), ".agent-bridge-test", "default-home");
  expect(resolveHome()).toBe(home);
  expect(process.env.AGENT_BRIDGE_PIPE).toBeUndefined();
  expect(resolvePipePath(home)).toBe(resolvePipePath(home, {}));
});

it("prevents empty fixtures from discovering the source repository while allowing fixture repositories", () => {
  const fixtureRoot = join(process.cwd(), ".agent-bridge-test");
  mkdirSync(fixtureRoot, { recursive: true });
  const direct = mkdtempSync(join(fixtureRoot, "git-isolation-"));
  const temporary = mkdtempSync(join(tmpdir(), "git-isolation-"));
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: "pipe" }).trim();
  const before = git(process.cwd(), ["rev-parse", "HEAD"]);
  try {
    for (const path of [direct, temporary]) {
      expect(() => git(path, ["rev-parse", "--show-toplevel"])).toThrow();
      expect(canonicalProjectRoot(path)).toBe(path);
    }
    const cli = join(direct, "fixture-cli");
    writeFileSync(cli, "require('node:fs'); process.stdout.write('fixture-commonjs');");
    expect(execFileSync(process.execPath, [cli], { cwd: direct, encoding: "utf8" })).toBe("fixture-commonjs");
    git(direct, ["init", "--quiet"]);
    expect(git(direct, ["rev-parse", "--show-toplevel"]).replaceAll("\\", "/")).toBe(direct.replaceAll("\\", "/"));
    expect(git(process.cwd(), ["rev-parse", "HEAD"])).toBe(before);
  } finally {
    for (const path of [direct, temporary]) rmSync(path, { recursive: true, force: true, maxRetries: 5 });
  }
});
