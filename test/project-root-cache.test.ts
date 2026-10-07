import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { canonicalProjectRoot, migrateProjectJobs } from "../src/core/project-identity.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const git = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFileSync: git }));
let env: TestEnv;
beforeEach(() => { env = makeEnv(); git.mockReset(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

it("shares canonical roots across repeated legacy-job migrations and refreshes bounded stale results", () => {
  const cwd = join(env.home, "cwd"), first = join(env.home, "first"), second = join(env.home, "second");
  for (const root of [cwd, first, second]) mkdirSync(join(root, ".git"), { recursive: true });
  let root = first, now = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  git.mockImplementation((_file: string, args: string[]) => args.at(-1) === "--git-common-dir" ? join(root, ".git") : root);
  const records = [{ id: "legacy", workdir: cwd, retainedField: "keep" }];
  for (let i = 0; i < 50; i++) expect(migrateProjectJobs(records)).toEqual([{ ...records[0], projectRoot: realpathSync.native(first) }]);
  expect(git).toHaveBeenCalledTimes(2);
  expect(records[0]).not.toHaveProperty("projectRoot");
  root = second; now += 30_001;
  expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(second));
  expect(git).toHaveBeenCalledTimes(4);
});

it("does not retain missing paths when a project appears later", () => {
  const cwd = join(env.home, "created-later");
  expect(canonicalProjectRoot(cwd)).toBeNull();
  mkdirSync(join(cwd, ".git"), { recursive: true });
  git.mockImplementation((_file: string, args: string[]) => args.at(-1) === "--git-common-dir" ? join(cwd, ".git") : cwd);
  expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(cwd));
  expect(git).toHaveBeenCalledTimes(2);
});

it("invalidates a non-Git identity when an ancestor becomes a repository", () => {
  const cwd = join(env.home, "nested"); mkdirSync(cwd);
  git.mockImplementation(() => { throw new Error("not a repository"); });
  expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(cwd));
  mkdirSync(join(env.home, ".git"));
  git.mockImplementation((_file: string, args: string[]) => args.at(-1) === "--git-common-dir" ? join(env.home, ".git") : env.home);
  expect(canonicalProjectRoot(cwd)).toBe(realpathSync.native(env.home));
});
