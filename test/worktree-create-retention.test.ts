import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DelegateError, type runProcess } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import { createWorktree } from "../src/core/worktree.js";

const mocks = vi.hoisted(() => ({ process: vi.fn(), uuid: vi.fn() }));
vi.mock("../src/core/delegate.js", async original => ({ ...await original<typeof import("../src/core/delegate.js")>(), runProcess: mocks.process }));
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(), randomUUID: mocks.uuid }));
let root: string, repo: string, home: string, env: NodeJS.ProcessEnv;
let actualRun: typeof runProcess;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
const adds = () => mocks.process.mock.calls.map(call => call[0] as Parameters<typeof runProcess>[0]).filter(call => call.args?.includes("add") && call.args.includes("worktree"));
const branch = "agent-bridge/retained";
const attemptPath = () => join(home, "worktrees", `${basename(repo)}-retained`);

beforeEach(async () => {
  const temporary = resolve(".agent-bridge-test/tmp"); mkdirSync(temporary, { recursive: true });
  root = realpathSync.native(mkdtempSync(join(temporary, "worktree-retention-")));
  repo = join(root, "repo"); home = join(root, "home"); mkdirSync(repo); mkdirSync(home);
  // Every Git command has a local discovery ceiling; empty home cannot find the release repository.
  env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary, GIT_CEILING_DIRECTORIES: root,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "empty-global.gitconfig") };
  actualRun = (await vi.importActual<typeof import("../src/core/delegate.js")>("../src/core/delegate.js")).runProcess;
  mocks.process.mockReset().mockImplementation((options: Parameters<typeof runProcess>[0]) => actualRun({ ...options, env: { ...options.env, ...env } }));
  mocks.uuid.mockReset().mockImplementation((await vi.importActual<typeof import("node:crypto")>("node:crypto")).randomUUID);
  git("init", "-q"); writeFileSync(join(repo, "source.txt"), "base bytes");
  git("add", "source.txt"); git("-c", "user.name=Fixture Owner", "-c", "user.email=owner@example.test", "commit", "-q", "-m", "fixture base");
});
afterEach(() => {
  // Retain every synthetic failed attempt as audit evidence; no shared refs or paths are cleaned up.
  const mutations = mocks.process.mock.calls.map(call => (call[0] as Parameters<typeof runProcess>[0]).args ?? []);
  expect(mutations.some(args => args.includes("remove") || args.includes("prune") || args.includes("-D"))).toBe(false);
});

it("rejects an empty outside-Git fixture without ancestor repository discovery", async () => {
  await expect(createWorktree({ cwd: home, home, jobId: "retained", log: nullLogger })).rejects.toThrow("needs a git repository");
  expect(adds()).toEqual([]);
});

it("retains an existing branch's unique commits without attempting worktree add", async () => {
  git("checkout", "-q", "-b", branch);
  writeFileSync(join(repo, "unique.txt"), "original branch data"); git("add", "unique.txt");
  git("-c", "user.name=Fixture Owner", "-c", "user.email=owner@example.test", "commit", "-q", "-m", "unique data");
  const tip = git("rev-parse", branch);
  await expect(createWorktree({ cwd: repo, home, jobId: "retained", log: nullLogger })).rejects.toThrow("existing branch or path retained");
  expect(git("rev-parse", branch)).toBe(tip);
  expect(git("show", `${branch}:unique.txt`)).toBe("original branch data");
  expect(adds()).toEqual([]);
});

it("retains an occupied checkout path and its untracked bytes without attempting add", async () => {
  mkdirSync(attemptPath(), { recursive: true }); writeFileSync(join(attemptPath(), "owner.txt"), "existing path data");
  await expect(createWorktree({ cwd: repo, home, jobId: "retained", log: nullLogger })).rejects.toThrow("existing branch or path retained");
  expect(readFileSync(join(attemptPath(), "owner.txt"), "utf8")).toBe("existing path data");
  expect(adds()).toEqual([]);
  expect(git("branch", "--list", branch)).toBe("");
});

function partialFailure(error: Error) {
  let first = true;
  mocks.process.mockImplementation(async (options: Parameters<typeof runProcess>[0]) => {
    if (first && options.args?.includes("worktree") && options.args.includes("add")) {
      first = false;
      const b = options.args[options.args.indexOf("-b") + 1]!, path = options.args[options.args.indexOf("-b") + 2]!;
      git("branch", b); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "partial.txt"), "failed attempt data");
      throw error;
    }
    return actualRun({ ...options, env: { ...options.env, ...env } });
  });
}

it("retains branch and partial checkout after a non-timeout add failure", async () => {
  partialFailure(new Error("checkout failed after writing data"));
  await expect(createWorktree({ cwd: repo, home, jobId: "retained", log: nullLogger })).rejects.toThrow("retained branch");
  expect(git("rev-parse", branch)).toBe(git("rev-parse", "HEAD"));
  expect(readFileSync(join(attemptPath(), "partial.txt"), "utf8")).toBe("failed attempt data");
  expect(adds()).toHaveLength(1);
});

it("retains a timed-out first attempt and skips occupied retry branch and path names", async () => {
  const occupiedBranch = `${branch}-r2-branch-collision`, occupiedPath = `${attemptPath()}-r2-path-collision`;
  git("branch", occupiedBranch); const tip = git("rev-parse", occupiedBranch);
  mkdirSync(occupiedPath, { recursive: true }); writeFileSync(join(occupiedPath, "owner.txt"), "retry collision data");
  mocks.uuid.mockReturnValueOnce("branch-collision").mockReturnValueOnce("path-collision").mockReturnValueOnce("unused");
  partialFailure(new DelegateError("git worktree add timed out", "timeout"));
  const wt = await createWorktree({ cwd: repo, home, jobId: "retained", log: nullLogger });
  expect(wt.branch).toBe(`${branch}-r2-unused`);
  expect(readFileSync(join(wt.path, "source.txt"), "utf8")).toBe("base bytes");
  expect(readFileSync(join(attemptPath(), "partial.txt"), "utf8")).toBe("failed attempt data");
  expect(git("rev-parse", occupiedBranch)).toBe(tip);
  expect(readFileSync(join(occupiedPath, "owner.txt"), "utf8")).toBe("retry collision data");
  expect(adds()).toHaveLength(2);
});

it("retains both branches and partial data when the timeout retry also fails", async () => {
  mocks.uuid.mockReturnValue("unused");
  mocks.process.mockImplementation(async (options: Parameters<typeof runProcess>[0]) => {
    if (options.args?.includes("worktree") && options.args.includes("add")) {
      const b = options.args[options.args.indexOf("-b") + 1]!, path = options.args[options.args.indexOf("-b") + 2]!;
      git("branch", b); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "partial.txt"), b);
      throw b === branch ? new DelegateError("add timed out", "timeout") : new Error("retry checkout failed");
    }
    return actualRun({ ...options, env: { ...options.env, ...env } });
  });
  await expect(createWorktree({ cwd: repo, home, jobId: "retained", log: nullLogger })).rejects.toThrow("retained both attempts");
  for (const suffix of ["", "-r2-unused"]) {
    expect(git("rev-parse", branch + suffix)).toBe(git("rev-parse", "HEAD"));
    expect(readFileSync(join(attemptPath() + suffix, "partial.txt"), "utf8")).toBe(branch + suffix);
  }
});
