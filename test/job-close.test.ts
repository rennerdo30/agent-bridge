import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeJobWorktree, prepareWorktreeContinuation, recordWorktreeOrigin } from "../src/core/job-close.js";
import { createWorktree, type Worktree } from "../src/core/worktree.js";
import { readWorktreeState, recordWorktreeProcessProof, saveWorktreeState, worktreeLease } from "../src/core/worktree-state.js";
import { closeMetadataDbs } from "../src/core/metadata-db.js";
import * as worktreeModule from "../src/core/worktree.js";
import { setJobOutcome } from "../src/core/job-outcomes.js";
import { nullLogger } from "../src/core/logger.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import { runJobClose } from "../src/cli/job-close.js";
import { writeRunnerStateRecord } from "../src/core/runner-store.js";
import { processIdentity } from "../src/core/process-identity.js";

let home: string, repo: string, remote: string, wt: Worktree;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.longpaths=true", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const close = (name = "opencode-job-test", enabled = true) => closeJobWorktree({ home, job: { name, status: "done", worktree: wt }, enabled, log: nullLogger });
const commit = (message: string) => { git(wt.path, "add", "-A"); git(wt.path, "commit", "-qm", message); return git(wt.path, "rev-parse", "HEAD"); };
beforeEach(async () => {
  mkdirSync(process.env.AGENT_BRIDGE_TEST_ROOT!, { recursive: true }); home = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "close-"));
  repo = join(home, "repo"); remote = join(home, "remote.git"); mkdirSync(repo);
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, "empty-config")); vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Owner"); git(repo, "config", "user.email", "owner@example.test");
  mkdirSync(join(repo, "unity", "ProjectSettings"), { recursive: true });
  writeFileSync(join(repo, "unity", "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.1f1\n");
  writeFileSync(join(repo, ".gitignore"), "unity/Library/\nowner-notes.txt\n");
  writeFileSync(join(repo, "source.txt"), "base\n"); git(repo, "add", "-A"); git(repo, "commit", "-qm", "base");
  git(repo, "init", "--bare", "-q", remote); git(repo, "remote", "add", "origin", remote);
  wt = await createWorktree({ cwd: repo, home, jobId: "test", log: nullLogger });
  await recordWorktreeOrigin(home, wt, nullLogger);
  recordWorktreeProcessProof(home, wt, true);
});
afterEach(() => { closeMetadataDbs(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });

describe("opt-in job close retention", () => {
  it.each(["codex", "claude", "opencode"])("pushes all %s work before dropping its own cache and retains the local branch", async (agent) => {
    writeFileSync(join(wt.path, "source.txt"), "job change\n"); const tip = commit("Change source");
    const cache = join(wt.path, "unity", "Library"); mkdirSync(cache); writeFileSync(join(cache, "regenerable.bin"), "derived");
    const result = await close(`${agent}-job-test`);
    expect(result.action, result.reason).toBe("reaped");
    expect(git(remote, "rev-parse", `refs/heads/wip/${agent}-job-test`)).toBe(tip);
    expect(existsSync(wt.path)).toBe(false);
    expect(git(repo, "rev-parse", wt.branch)).toBe(tip);
    await prepareWorktreeContinuation(home, wt, nullLogger);
    expect(readFileSync(join(wt.path, "source.txt"), "utf8")).toBe("job change\n");
    expect(existsSync(cache)).toBe(false);
    expect(readWorktreeState(home, wt)?.reapedAt).toBeUndefined();
  });
  it("archives reset and abandoned branch commits that are only in the worktree reflog", async () => {
    git(wt.path, "checkout", "-qb", "abandoned");
    writeFileSync(join(wt.path, "lost.txt"), "never lose this"); const abandoned = commit("Save abandoned work");
    git(wt.path, "checkout", "-q", wt.branch); git(repo, "branch", "-D", "abandoned");
    expect((await close()).action).toBe("reaped");
    expect(git(remote, "rev-parse", `refs/heads/wip/opencode-job-test-history-${abandoned}`)).toBe(abandoned);
    expect(git(remote, "show", `${abandoned}:lost.txt`)).toBe("never lose this");
  });
  it.each(["modified", "untracked", "ignored"])("keeps %s owner data and does not drop even its own Library", async (kind) => {
    const file = kind === "modified" ? "source.txt" : kind === "ignored" ? "owner-notes.txt" : "untracked.txt";
    writeFileSync(join(wt.path, file), "unique owner content");
    const cache = join(wt.path, "unity", "Library"); mkdirSync(cache); writeFileSync(join(cache, "data"), "derived");
    expect((await close()).action).toBe("kept");
    expect(readFileSync(join(wt.path, file), "utf8")).toBe("unique owner content");
    expect(readFileSync(join(cache, "data"), "utf8")).toBe("derived");
    expect(git(remote, "for-each-ref")).toBe("");
  });
  it("retains pre-existing physical Libraries without inferring cache ownership from their name", async () => {
    const cache = join(wt.path, "unity", "Library"); mkdirSync(cache); writeFileSync(join(cache, "keep"), "existing cache");
    await recordWorktreeOrigin(home, wt, nullLogger);
    recordWorktreeProcessProof(home, wt, true);
    expect(readWorktreeState(home, wt)?.libraries).toEqual([]);
    expect((await close()).action).toBe("kept");
    expect(readFileSync(join(cache, "keep"), "utf8")).toBe("existing cache");
  });
  it("keeps linked/shared Libraries and internal links without touching targets", async () => {
    const shared = join(home, "shared"); mkdirSync(shared); writeFileSync(join(shared, "keep"), "shared bytes");
    symlinkSync(shared, join(wt.path, "unity", "Library"), "junction");
    const result = await close(); expect(result.action).toBe("kept"); expect(result.reason).toContain("Linked");
    expect(readFileSync(join(shared, "keep"), "utf8")).toBe("shared bytes");
    expect(existsSync(join(wt.path, "unity", "Library"))).toBe(true);
  });
  it("never force pushes over an existing unrelated archive branch", async () => {
    writeFileSync(join(wt.path, "source.txt"), "first\n"); const tip = commit("First");
    git(repo, "push", "-q", "origin", `${tip}:refs/heads/wip/opencode-job-test`);
    git(wt.path, "reset", "--hard", wt.base); writeFileSync(join(wt.path, "source.txt"), "second\n"); commit("Second");
    expect((await close()).action).toBe("kept");
    expect(git(remote, "rev-parse", "refs/heads/wip/opencode-job-test")).toBe(tip);
    expect(readFileSync(join(wt.path, "source.txt"), "utf8")).toBe("second\n");
  });
  it("retains a clean tree when the push fails", async () => {
    git(repo, "remote", "set-url", "origin", join(home, "unavailable.git"));
    const result = await close(); expect(result.action).toBe("kept"); expect(result.reason).toContain("push");
    expect(existsSync(wt.path)).toBe(true);
  });
  it("retains changed files when an edit arrives during push", async () => {
    const original = worktreeModule.git;
    vi.spyOn(worktreeModule, "git").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[0].includes("push")) writeFileSync(join(wt.path, "source.txt"), "new owner edit\n");
      return result;
    });
    expect((await close()).action).toBe("kept");
    expect(readFileSync(join(wt.path, "source.txt"), "utf8")).toBe("new owner edit\n");
  });
  it("keeps the checkout if remote hashes do not match the pushed commits", async () => {
    const original = worktreeModule.git;
    vi.spyOn(worktreeModule, "git").mockImplementation(async (...args) => args[0].includes("ls-remote") ? "" : original(...args));
    const result = await close(); expect(result.action).toBe("kept"); expect(result.reason).toContain("Remote commit verification");
    expect(existsSync(wt.path)).toBe(true);
  });
  it("keeps a tree when process shutdown is unproven", async () => {
    recordWorktreeProcessProof(home, wt, false);
    expect((await close()).reason).toContain("shutdown is unproven");
    expect(existsSync(wt.path)).toBe(true);
  });
  it("recreates the actual final branch when a failed job switched branches", async () => {
    git(wt.path, "checkout", "-qb", "actual-failed-branch");
    writeFileSync(join(wt.path, "source.txt"), "partial committed work\n"); commit("Preserve partial work");
    expect((await close()).action).toBe("reaped");
    await prepareWorktreeContinuation(home, wt, nullLogger);
    expect(wt.branch).toBe("actual-failed-branch");
    expect(readFileSync(join(wt.path, "source.txt"), "utf8")).toBe("partial committed work\n");
  });
  it("defaults off and keeps running, queued, busy and legacy worktrees", async () => {
    expect(DEFAULT_CONFIG.jobCloseCleanup).toBe(false);
    expect((await close("opencode-job-test", false)).action).toBe("disabled");
    for (const job of [{ name: "test", status: "running", worktree: wt }, { name: "test", status: "done", queue: ["continue"], worktree: wt }]) expect((await closeJobWorktree({ home, job, enabled: true, log: nullLogger })).action).toBe("kept");
    const release = worktreeLease(home, wt); try { expect((await close()).reason).toContain("lease"); } finally { release(); }
    const legacy = await createWorktree({ cwd: repo, home, jobId: "legacy", log: nullLogger });
    expect((await closeJobWorktree({ home, job: { name: "test", status: "done", worktree: legacy }, enabled: true, log: nullLogger })).reason).toContain("legacy");
    expect(existsSync(wt.path)).toBe(true); expect(existsSync(legacy.path)).toBe(true);
  });
  it("exposes read-only lifecycle state and respects dry run", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ jobCloseCleanup: true, codexWindowsSandbox: "elevated" }));
    const cfg = loadConfig(home, "other", nullLogger, {});
    expect(cfg.jobCloseCleanup).toBe(true); expect(cfg.codexWindowsSandbox).toBe("elevated");
    writeFileSync(join(home, "jobs.json"), JSON.stringify([{ id: "test", name: "opencode-job-test", agent: "opencode", status: "done", startedAt: 1, finishedAt: 2, worktree: wt }]));
    const output: string[] = [];
    expect(await runJobClose("job-state", ["opencode-job-test"], home, cfg, nullLogger, (line) => output.push(line))).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ job: "opencode-job-test", status: "done", closedAt: null, reapedAt: null });
    expect(await runJobClose("job-close", ["opencode-job-test"], home, cfg, nullLogger, () => {})).toBe(0);
    expect(existsSync(wt.path)).toBe(true); expect(git(remote, "for-each-ref")).toBe("");
  });
  it("keeps held and recently continued jobs during the 24-hour idle sweep", async () => {
    const stored = { id: "test", name: "opencode-job-test", agent: "opencode", owner: "parent", status: "done", startedAt: 1, finishedAt: 2, worktree: wt };
    writeFileSync(join(home, "jobs.json"), JSON.stringify([stored]));
    const cfg = { ...DEFAULT_CONFIG, jobCloseCleanup: true };
    await runJobClose("close-idle-jobs", ["--yes"], home, cfg, nullLogger, () => {});
    expect(existsSync(wt.path)).toBe(true);
    saveWorktreeState(home, wt, { ...readWorktreeState(home, wt)!, lastContinuation: 1 });
    setJobOutcome(home, stored, "parent", "held", "Owner review pending");
    await runJobClose("close-idle-jobs", ["--yes"], home, cfg, nullLogger, () => {});
    expect(existsSync(wt.path)).toBe(true);
    setJobOutcome(home, stored, "parent", "discarded");
    await runJobClose("close-idle-jobs", ["--yes"], home, cfg, nullLogger, () => {});
    expect(existsSync(wt.path)).toBe(false);
  });
  it("keeps a verified live runner but not a process that merely reuses the runner's PID (AB-256)", async () => {
    writeFileSync(join(home, "jobs.json"), JSON.stringify([{ id: "test", name: "opencode-job-test", agent: "opencode", status: "done", startedAt: 1, finishedAt: 2, worktree: wt }]));
    const cfg = { ...DEFAULT_CONFIG, jobCloseCleanup: true };
    const output: string[] = [];
    writeRunnerStateRecord(home, "test", { pid: process.pid, peer: "job:opencode-job-test", status: "done", updatedAt: Date.now(), identity: processIdentity(process.pid) });
    expect(await runJobClose("job-close", ["opencode-job-test", "--yes"], home, cfg, nullLogger, line => output.push(line))).toBe(1);
    expect(output.at(-1)).toContain("Live runner");
    expect(existsSync(wt.path)).toBe(true);
    // The live PID now has a different creation identity: that runner is gone.
    writeRunnerStateRecord(home, "test", { pid: process.pid, peer: "job:opencode-job-test", status: "done", updatedAt: Date.now(), identity: "1" });
    expect(await runJobClose("job-close", ["opencode-job-test", "--yes"], home, cfg, nullLogger, line => output.push(line))).toBe(0);
    expect(output.at(-1)).toContain("reaped");
    expect(existsSync(wt.path)).toBe(false);
  });
  it("inspects malformed state without repairing, renaming or deleting any original", async () => {
    writeFileSync(join(home, "jobs.json"), JSON.stringify([{ id: "test", name: "test", agent: "opencode", status: "done", startedAt: 1, worktree: wt }]));
    const stateDir = join(home, "worktree-state");
    const stateFile = readdirSync(stateDir).find((name) => name.endsWith(".json"))!;
    writeFileSync(join(stateDir, stateFile), "{unique malformed state");
    mkdirSync(join(home, "jobs")); writeFileSync(join(home, "jobs", "test.json"), "{unique malformed runner");
    const before = readdirSync(stateDir);
    const output: string[] = [];
    await runJobClose("job-state", ["test"], home, DEFAULT_CONFIG, nullLogger, (line) => output.push(line));
    expect(JSON.parse(output[0]!)).toMatchObject({ runnerStatus: null, lastContinuation: null });
    expect(readdirSync(stateDir)).toEqual(before);
    expect(readFileSync(join(stateDir, stateFile), "utf8")).toBe("{unique malformed state");
    expect(readFileSync(join(home, "jobs", "test.json"), "utf8")).toBe("{unique malformed runner");
    writeFileSync(join(home, "jobs.json"), "{unique malformed jobs");
    await expect(runJobClose("job-close", ["test", "--yes"], home, { ...DEFAULT_CONFIG, jobCloseCleanup: true }, nullLogger, () => {})).rejects.toThrow("unreadable");
    expect(readFileSync(join(home, "jobs.json"), "utf8")).toBe("{unique malformed jobs");
    expect(existsSync(wt.path)).toBe(true);
  });
});
