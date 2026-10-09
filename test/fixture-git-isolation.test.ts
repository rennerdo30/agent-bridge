import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { canonicalProjectRoot } from "../src/core/project-identity.js";
import { resolveHome, resolvePipePath } from "../src/core/paths.js";
import { testFixtureRoot } from "../scripts/test-fixture-root.mjs";

it("refuses an explicitly supplied fixture root inside a generated repository before writing", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixture-root-refusal-"));
  mkdirSync(join(repository, ".git"));
  const root = join(repository, "must-stay-absent");
  const saved = process.env.AGENT_BRIDGE_TEST_ROOT;
  try {
    process.env.AGENT_BRIDGE_TEST_ROOT = root;
    expect(() => testFixtureRoot()).toThrow("outside every repository");
    expect(existsSync(root)).toBe(false);
  } finally {
    process.env.AGENT_BRIDGE_TEST_ROOT = saved;
  }
});

it("isolates default bridge storage and endpoints from the invoking session", () => {
  const home = join(process.env.AGENT_BRIDGE_TEST_ROOT!, "default-home");
  expect(resolveHome()).toBe(home);
  expect(process.env.AGENT_BRIDGE_PIPE).toBeUndefined();
  expect(resolvePipePath(home)).toBe(resolvePipePath(home, {}));
});

it("prevents empty fixtures from discovering the source repository while allowing fixture repositories", () => {
  const fixtureRoot = process.env.AGENT_BRIDGE_TEST_ROOT!;
  mkdirSync(fixtureRoot, { recursive: true });
  const direct = mkdtempSync(join(fixtureRoot, "git-isolation-"));
  const temporary = mkdtempSync(join(tmpdir(), "git-isolation-"));
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: "pipe" }).trim();
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
  } finally {
    for (const path of [direct, temporary]) rmSync(path, { recursive: true, force: true, maxRetries: 5 });
  }
});
