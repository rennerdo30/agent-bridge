import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DelegateError, type runProcess } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import { createWorktree, worktreeBaseReport, WORKTREE_FETCH_TIMEOUT_MS } from "../src/core/worktree.js";

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
  const temporary = resolve(process.env.AGENT_BRIDGE_TEST_ROOT!, "tmp"); mkdirSync(temporary, { recursive: true });
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

function remoteFixture() {
  const remote = join(root, "remote.git"), writer = join(root, "writer");
  execFileSync("git", ["init", "--bare", "--initial-branch=trunk", remote], { env, stdio: "pipe" });
  git("remote", "add", "upstream", remote);
  git("push", "upstream", "HEAD:trunk");
  execFileSync("git", ["clone", remote, writer], { env, stdio: "pipe" });
  const advance = () => {
    writeFileSync(join(writer, "fresh.txt"), "fresh remote bytes");
    execFileSync("git", ["add", "."], { cwd: writer, env });
    execFileSync("git", ["-c", "user.name=Fixture Owner", "-c", "user.email=owner@example.test", "commit", "-qm", "advance remote"], { cwd: writer, env });
    execFileSync("git", ["push"], { cwd: writer, env, stdio: "pipe" });
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: writer, env, encoding: "utf8" }).trim();
  };
  return { remote, advance, writer };
}

it("forks stale local HEAD from the fetched non-origin default and reports the exact base", async () => {
  const { advance } = remoteFixture(), stale = git("rev-parse", "HEAD"), fresh = advance();
  const wt = await createWorktree({ cwd: repo, home, jobId: "fresh", log: nullLogger });
  expect(wt.base).toBe(fresh);
  expect(wt.baseRef).toBe("refs/remotes/upstream/trunk");
  expect(git("rev-parse", "HEAD")).toBe(stale);
  expect(git("rev-parse", wt.branch)).toBe(fresh);
  expect(readFileSync(join(wt.path, "fresh.txt"), "utf8")).toBe("fresh remote bytes");
  expect(worktreeBaseReport(wt)).toContain(`Base: refs/remotes/upstream/trunk ${fresh}`);
  expect(worktreeBaseReport(wt)).toContain("cwd HEAD was 1 behind refs/remotes/upstream/trunk; using refs/remotes/upstream/trunk");
  const network = mocks.process.mock.calls.map(call => call[0] as Parameters<typeof runProcess>[0]).filter(call => call.args?.includes("fetch") || call.args?.includes("ls-remote"));
  expect(network.length).toBeGreaterThan(0);
  expect(network.every(call => call.timeoutMs === WORKTREE_FETCH_TIMEOUT_MS && call.env?.GIT_TERMINAL_PROMPT === "0")).toBe(true);
});

it("keeps local-only tags despite inherited fetch pruning settings", async () => {
  const { advance } = remoteFixture(), fresh = advance();
  git("tag", "owner-only");
  const tags = git("show-ref", "--tags");
  // Only this generated repository receives the hostile owner configuration.
  writeFileSync(join(repo, ".git", "config"), readFileSync(join(repo, ".git", "config"), "utf8") + "\n[fetch]\n\tprune = true\n\tpruneTags = true\n[remote \"upstream\"]\n\tprune = true\n\tpruneTags = true\n");
  const wt = await createWorktree({ cwd: repo, home, jobId: "retain-tags", log: nullLogger });
  expect(wt.base).toBe(fresh);
  expect(git("rev-parse", "refs/remotes/upstream/trunk")).toBe(fresh);
  expect(git("show-ref", "--tags")).toBe(tags);
});

it("keeps local branches unmoved despite configured fetch mappings onto heads", async () => {
  const { advance } = remoteFixture();
  git("branch", "owner-base");
  const heads = git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
  const fresh = advance();
  writeFileSync(join(repo, ".git", "config"), readFileSync(join(repo, ".git", "config"), "utf8") + "\n[remote \"upstream\"]\n\tfetch = +refs/heads/trunk:refs/heads/owner-base\n");
  const wt = await createWorktree({ cwd: repo, home, jobId: "retain-heads", log: nullLogger });
  expect(wt.base).toBe(fresh);
  expect(git("rev-parse", "refs/remotes/upstream/trunk")).toBe(fresh);
  expect(git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/").split("\n").filter(line => !line.startsWith(`refs/heads/${wt.branch} `)).join("\n")).toBe(heads);
});

it("honors an explicit base from an unborn HEAD", async () => {
  const explicit = git("rev-parse", "HEAD");
  git("tag", "explicit-base", explicit);
  git("checkout", "--orphan", "unborn");
  const wt = await createWorktree({ cwd: repo, home, jobId: "unborn-explicit", log: nullLogger, base: "explicit-base" });
  expect(wt.base).toBe(explicit);
  expect(wt.baseRef).toBe("explicit-base");
  expect(git("rev-parse", wt.branch)).toBe(explicit);
  expect(readFileSync(join(wt.path, "source.txt"), "utf8")).toBe("base bytes");
  expect(git("symbolic-ref", "HEAD")).toBe("refs/heads/unborn");
});

it("rejects an unborn HEAD without an explicit base clearly", async () => {
  git("checkout", "--orphan", "unborn");
  const refs = git("show-ref");
  await expect(createWorktree({ cwd: repo, home, jobId: "unborn", log: nullLogger })).rejects.toThrow("needs a valid HEAD commit or an explicit base");
  expect(git("show-ref")).toBe(refs);
  expect(adds()).toEqual([]);
});

it("honors an explicit base while still warning about the stale cwd", async () => {
  const { advance } = remoteFixture(), explicit = git("rev-parse", "HEAD"); advance();
  git("tag", "explicit-base", explicit);
  const wt = await createWorktree({ cwd: repo, home, jobId: "explicit", log: nullLogger, base: "explicit-base" });
  expect(wt.base).toBe(explicit);
  expect(wt.baseRef).toBe("explicit-base");
  expect(worktreeBaseReport(wt)).toContain("is behind");
});

it("uses the last fetched remote default explicitly when offline", async () => {
  const { advance } = remoteFixture(), fresh = advance();
  git("fetch", "upstream");
  git("symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/trunk");
  git("remote", "set-url", "upstream", join(root, "offline.git"));
  const wt = await createWorktree({ cwd: repo, home, jobId: "offline", log: nullLogger });
  expect(wt.base).toBe(fresh);
  expect(worktreeBaseReport(wt)).toContain("fetch failed or offline; using last fetched remote ref upstream/trunk");
});

it("uses cached default after a bounded fetch timeout without changing any existing branch", async () => {
  const { advance } = remoteFixture(), fresh = advance(); git("fetch", "upstream");
  const original = git("show-ref", "--heads");
  mocks.process.mockImplementation(async (options: Parameters<typeof runProcess>[0]) => {
    if (options.args?.includes("fetch")) throw new DelegateError("fetch timed out", "timeout");
    return actualRun({ ...options, env: { ...options.env, ...env } });
  });
  const wt = await createWorktree({ cwd: repo, home, jobId: "timeout", log: nullLogger });
  expect(wt.base).toBe(fresh);
  expect(worktreeBaseReport(wt)).toContain("fetch failed or offline");
  expect(git("show-ref", "--heads")).toContain(original);
});

it("reports local HEAD for a local-only repository", async () => {
  const wt = await createWorktree({ cwd: repo, home, jobId: "local", log: nullLogger });
  expect(wt.base).toBe(git("rev-parse", "HEAD"));
  expect(worktreeBaseReport(wt)).toContain("Base: local HEAD");
  expect(worktreeBaseReport(wt)).toContain("Repository has no remote");
});

it("warns before falling back to HEAD when an offline remote has never been fetched", async () => {
  git("remote", "add", "upstream", join(root, "unavailable.git"));
  const wt = await createWorktree({ cwd: repo, home, jobId: "uncached", log: nullLogger });
  expect(wt.base).toBe(git("rev-parse", "HEAD"));
  expect(worktreeBaseReport(wt)).toContain("WARNING: no remote default tracking ref available; falling back to local HEAD");
});

it("does not infer the default from a sole cached feature branch while offline", async () => {
  const remote = join(root, "single-branch.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=trunk", remote], { env, stdio: "pipe" });
  git("push", remote, "HEAD:trunk", "HEAD:feature");
  git("remote", "add", "origin", remote);
  git("fetch", "origin", "refs/heads/feature:refs/remotes/origin/feature");
  const cached = git("rev-parse", "refs/remotes/origin/feature");
  expect(git("for-each-ref", "--format=%(refname)", "refs/remotes/")).toBe("refs/remotes/origin/feature");
  writeFileSync(join(repo, "local.txt"), "local-only work"); git("add", "local.txt");
  git("-c", "user.name=Fixture Owner", "-c", "user.email=owner@example.test", "commit", "-qm", "advance local HEAD");
  const head = git("rev-parse", "HEAD");
  expect(head).not.toBe(cached);
  git("remote", "set-url", "origin", join(root, "offline.git"));
  const wt = await createWorktree({ cwd: repo, home, jobId: "feature-offline", log: nullLogger });
  expect(wt.base).toBe(head);
  expect(wt.baseRef).toBe("local HEAD");
  expect(git("rev-parse", wt.branch)).toBe(head);
  expect(git("rev-parse", "refs/remotes/origin/feature")).toBe(cached);
  expect(readFileSync(join(wt.path, "local.txt"), "utf8")).toBe("local-only work");
  expect(worktreeBaseReport(wt)).toContain("discovery failed or offline");
  expect(worktreeBaseReport(wt)).toContain("WARNING: no remote default tracking ref available; falling back to local HEAD");
  expect(worktreeBaseReport(wt)).not.toContain("cached default");
  expect(mocks.process.mock.calls.some(call => (call[0] as Parameters<typeof runProcess>[0]).args?.includes("fetch"))).toBe(false);
});

function localCommit() {
  writeFileSync(join(repo, "local-work.txt"), "unpublished feature work"); git("add", "local-work.txt");
  git("-c", "user.name=Fixture Owner", "-c", "user.email=owner@example.test", "commit", "-qm", "local work");
  return git("rev-parse", "HEAD");
}

it("keeps feature HEAD ahead of its upstream and fetches only that upstream", async () => {
  const { advance } = remoteFixture();
  git("push", "upstream", "HEAD:feature");
  git("checkout", "-qb", "feature", "--track", "upstream/feature");
  const head = localCommit(); advance();
  const wt = await createWorktree({ cwd: repo, home, jobId: "ahead", log: nullLogger });
  expect(wt.base).toBe(head);
  expect(wt.baseRef).toBe("local HEAD");
  expect(readFileSync(join(wt.path, "local-work.txt"), "utf8")).toBe("unpublished feature work");
  const calls = mocks.process.mock.calls.map(call => (call[0] as Parameters<typeof runProcess>[0]).args ?? []);
  const fetches = calls.filter(args => args.includes("fetch"));
  expect(fetches).toHaveLength(1);
  expect(fetches[0]).toContain("refs/heads/feature:refs/remotes/upstream/feature");
  expect(calls.some(args => args.includes("ls-remote"))).toBe(false);
});

it.each([false, true])("keeps diverged HEAD with both SHAs and behind count (upstream=%s)", async upstream => {
  const { advance, writer } = remoteFixture();
  if (upstream) {
    git("push", "upstream", "HEAD:feature");
    git("checkout", "-qb", "feature", "--track", "upstream/feature");
  }
  const head = localCommit(), tip = advance();
  if (upstream) execFileSync("git", ["push", "origin", "HEAD:feature"], { cwd: writer, env, stdio: "pipe" });
  const ref = `refs/remotes/upstream/${upstream ? "feature" : "trunk"}`;
  const wt = await createWorktree({ cwd: repo, home, jobId: "diverged", log: nullLogger });
  expect(wt.base).toBe(head);
  expect(wt.baseRef).toBe("local HEAD");
  expect(worktreeBaseReport(wt)).toContain(`WARNING: DIVERGED cwd HEAD ${head} and ${ref} ${tip}: 1 behind, 1 ahead; keeping local HEAD`);
  expect(git("rev-parse", wt.branch)).toBe(head);
});

it("keeps equal HEAD rather than changing its base label to the reference", async () => {
  remoteFixture(); const head = git("rev-parse", "HEAD");
  const wt = await createWorktree({ cwd: repo, home, jobId: "equal", log: nullLogger });
  expect(wt.base).toBe(head);
  expect(wt.baseRef).toBe("local HEAD");
});

it("advances a purely behind feature checkout from its fetched upstream", async () => {
  const { advance, writer } = remoteFixture();
  git("push", "upstream", "HEAD:feature");
  git("checkout", "-qb", "feature", "--track", "upstream/feature");
  const tip = advance();
  execFileSync("git", ["push", "origin", "HEAD:feature"], { cwd: writer, env, stdio: "pipe" });
  const wt = await createWorktree({ cwd: repo, home, jobId: "behind-feature", log: nullLogger });
  expect(wt.base).toBe(tip);
  expect(wt.baseRef).toBe("refs/remotes/upstream/feature");
  expect(worktreeBaseReport(wt)).toContain("cwd HEAD was 1 behind refs/remotes/upstream/feature; using refs/remotes/upstream/feature");
});

it("rejects an invalid explicit base without creating or changing any branch", async () => {
  const refs = git("show-ref");
  await expect(createWorktree({ cwd: repo, home, jobId: "invalid", log: nullLogger, base: "--bad-ref" })).rejects.toThrow();
  expect(git("show-ref")).toBe(refs);
  expect(adds()).toEqual([]);
});

it("pins the selected SHA even if the caller branch moves before worktree add", async () => {
  const { advance } = remoteFixture(), selected = advance();
  mocks.process.mockImplementation(async (options: Parameters<typeof runProcess>[0]) => {
    if (options.args?.includes("worktree") && options.args.includes("add")) {
      writeFileSync(join(repo, "moved.txt"), "caller moved after selection"); git("add", "moved.txt");
      git("-c", "user.name=Fixture Owner", "-c", "user.email=owner@example.test", "commit", "-qm", "move cwd");
    }
    return actualRun({ ...options, env: { ...options.env, ...env } });
  });
  const wt = await createWorktree({ cwd: repo, home, jobId: "moved", log: nullLogger });
  expect(wt.base).toBe(selected);
  expect(git("rev-parse", wt.branch)).toBe(selected);
});
