import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { canonicalProjectRoot, migrateProjectJobs } from "../src/core/project-identity.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const git = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFileSync: git }));
let env: TestEnv;
beforeEach(() => { env = makeEnv(); git.mockReset(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

function repository(root: string): void {
  mkdirSync(join(root, ".git", "objects"), { recursive: true }); mkdirSync(join(root, ".git", "refs"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n"); writeFileSync(join(root, ".git", "config"), "[core]\n\tbare = false\n");
}
function linked(cwd: string, root: string): void {
  mkdirSync(cwd, { recursive: true });
  const gitDir = join(root, ".git", "worktrees", "fixture"); mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(cwd, ".git"), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/fixture\n");
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  writeFileSync(join(gitDir, "gitdir"), `${join(cwd, ".git")}\n`);
}

it("shares canonical roots across repeated legacy-job migrations and refreshes bounded stale results", () => {
  const cwd = join(env.home, "cwd"), first = join(env.home, "first"), second = join(env.home, "second");
  for (const root of [first, second]) repository(root);
  linked(cwd, first); let now = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const records = [{ id: "legacy", workdir: cwd, retainedField: "keep" }];
  for (let i = 0; i < 50; i++) expect(migrateProjectJobs(records)).toEqual([{ ...records[0], projectRoot: realpathSync.native(first) }]);
  expect(git).not.toHaveBeenCalled();
  expect(records[0]).not.toHaveProperty("projectRoot");
  linked(cwd, second); now += 30_001;
  expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(second));
  expect(git).not.toHaveBeenCalled();
});

it("does not retain missing paths when a project appears later", () => {
  const cwd = join(env.home, "created-later");
  expect(canonicalProjectRoot(cwd)).toBeNull();
  repository(cwd);
  expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(cwd));
  expect(git).not.toHaveBeenCalled();
});

it("invalidates a non-Git identity when an ancestor becomes a repository", () => {
  const cwd = join(env.home, "nested"); mkdirSync(cwd);
  expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(cwd));
  repository(env.home);
  expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(env.home));
});

it("resolves ordinary and linked ancestor layouts without any Git subprocess", () => {
  const root = join(env.home, "main with spaces"), wt = join(env.home, "linked with spaces"); repository(root); linked(wt, root);
  for (const cwd of [join(root, "nested", "child"), join(wt, "nested", "child")]) {
    mkdirSync(cwd, { recursive: true }); expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(root));
  }
  const gitDir = join(root, ".git", "worktrees", "fixture");
  // Git's Windows layouts accept relative pointers and either separator convention.
  writeFileSync(join(wt, ".git"), `gitdir: ${relative(wt, gitDir).split("\\").join("/")}\r\n`);
  writeFileSync(join(gitDir, "commondir"), process.platform === "win32" ? "..\\..\r\n" : "../..\r\n");
  expect(canonicalProjectRoot(wt)).toBe(realpathSync.native(root));
  expect(git).not.toHaveBeenCalled();
});

it("invalidates changed common/back pointers immediately and never guesses an ancestor for damaged layouts", () => {
  const root = join(env.home, "root"), wt = join(env.home, "linked"); repository(root); linked(wt, root);
  expect(canonicalProjectRoot(wt)).toBe(realpathSync.native(root));
  const gitDir = join(root, ".git", "worktrees", "fixture");
  writeFileSync(join(gitDir, "gitdir"), `${join(root, ".git")}\n`);
  expect(canonicalProjectRoot(wt)).toBeNull();
  writeFileSync(join(gitDir, "gitdir"), `${join(wt, ".git")}\n`);
  expect(canonicalProjectRoot(wt)).toBe(realpathSync.native(root));
  writeFileSync(join(gitDir, "commondir"), "missing-common-directory\n");
  expect(canonicalProjectRoot(wt)).toBeNull();
  expect(git).not.toHaveBeenCalled();
});

it("bounds malformed pointer reads and preserves unusual-layout fallback", () => {
  const root = join(env.home, "oversized"); mkdirSync(root); writeFileSync(join(root, ".git"), "x".repeat(16 * 1024));
  expect(canonicalProjectRoot(root)).toBeNull(); expect(git).not.toHaveBeenCalled();
  const unusual = join(env.home, "unusual"); repository(unusual); writeFileSync(join(unusual, ".git", "config"), "[core]\n bare = false\n worktree = ../elsewhere\n");
  git.mockImplementation((_file: string, args: string[]) => args.at(-1) === "--git-common-dir" ? join(unusual, ".git") : unusual);
  expect(canonicalProjectRoot(unusual)).toBe(realpathSync.native(unusual)); expect(git).toHaveBeenCalledTimes(2);
});
