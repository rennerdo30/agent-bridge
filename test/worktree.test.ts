import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { createWorktree, finishWorktree, gitDirsOutside, gitStatusSnapshot, handoffWarning, removeWorktreeDirectory, subagentCommitMessage, worktreeReport } from "../src/core/worktree.js";
import { cleanupWorktrees, type CleanupEntry } from "../src/core/worktree-cleanup.js";
import { formatUsage } from "../src/mcp/format.js";
import { scanWorktreeLinks } from "../src/core/worktree-links.js";

let repo: string;
let home: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  // Real paths: macOS /var is /private/var and Windows runners use short names, while link targets resolve fully.
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-repo-")));
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-home-")));
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, "global.gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  git("init", "-q");
  git("config", "user.name", "Repository Owner");
  git("config", "user.email", "owner@example.test");
  // Like the real repo, pin line endings with .gitattributes so a global core.autocrlf=true
  // (set on the CI Windows runners) cannot rewrite them on merge.
  writeFileSync(join(repo, ".gitattributes"), "* text=auto eol=lf\n");
  git("add", ".gitattributes");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
  writeFileSync(join(repo, "a.txt"), "original\n");
  git("add", "a.txt");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "add a");
});

afterEach(() => {
  try {
    git("worktree", "prune");
  } catch {
    // ignore
  }
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.unstubAllEnvs();
});

describe("worktree isolation", () => {
  it("commits with the repository identity instead of the neutral fallback", async () => {
    git("config", "user.name", "Repository Owner");
    git("config", "user.email", "owner@example.test");
    const wt = await createWorktree({ cwd: repo, home, jobId: "identity", log: nullLogger });
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    await finishWorktree(wt, "use repository identity", nullLogger);
    expect(git("log", "-1", "--format=%an <%ae>|%cn <%ce>", wt.branch)).toBe("Repository Owner <owner@example.test>|Repository Owner <owner@example.test>");
  });

  it("inherits global identity when the repository has no local identity", async () => {
    git("config", "--unset", "user.name");
    git("config", "--unset", "user.email");
    writeFileSync(join(home, "global.gitconfig"), "[user]\nname = Global Owner\nemail = global@example.test\n");
    const wt = await createWorktree({ cwd: repo, home, jobId: "global-identity", log: nullLogger });
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    await finishWorktree(wt, "inherit global identity", nullLogger);
    expect(git("log", "-1", "--format=%an <%ae>", wt.branch)).toBe("Global Owner <global@example.test>");
  });

  it.each(["user.name", "user.email"])("preserves work when %s is missing", async (key) => {
    git("config", "--unset", key);
    const wt = await createWorktree({ cwd: repo, home, jobId: "fallback", log: nullLogger });
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    await expect(finishWorktree(wt, "checkpoint", nullLogger)).rejects.toThrow(`Configure ${key}`);
    expect(readFileSync(join(wt.path, "a.txt"), "utf8")).toBe("changed\n");
    expect(git("rev-parse", wt.branch)).toBe(wt.base);
  });

  it("keeps the working copy untouched and commits the subagent's changes on a branch", async () => {
    const wt = await createWorktree({ cwd: repo, home, jobId: "job1", log: nullLogger });
    expect(wt.branch).toBe("agent-bridge/job1");
    expect(existsSync(join(wt.path, "a.txt"))).toBe(true);

    // The "subagent" edits inside its worktree.
    writeFileSync(join(wt.path, "a.txt"), "changed by subagent\n");
    writeFileSync(join(wt.path, "b.txt"), "new file\n");

    const outcome = await finishWorktree(wt, "edit a and add b", nullLogger);
    expect(outcome.changed).toBe(true);
    expect(outcome.diffStat).toContain("a.txt");
    expect(outcome.diffStat).toContain("b.txt");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("original\n");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);

    const report = worktreeReport(wt, outcome);
    expect(report).toContain("git merge agent-bridge/job1");
    git("merge", "-q", "agent-bridge/job1");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed by subagent\n");
  });

  it("reports when nothing changed", async () => {
    const wt = await createWorktree({ cwd: repo, home, jobId: "job2", log: nullLogger });
    const outcome = await finishWorktree(wt, "look only", nullLogger);
    expect(outcome.changed).toBe(false);
    expect(worktreeReport(wt, outcome)).toContain("has no changes");
  });

  it("finds the work on a branch the job made itself, and never calls it unchanged", async () => {
    const wt = await createWorktree({ cwd: repo, home, jobId: "job8", log: nullLogger });
    const inWt = (...args: string[]) => execFileSync("git", args, { cwd: wt.path, encoding: "utf8" }).trim();
    inWt("checkout", "-q", "-b", "codex/as991-markers");
    writeFileSync(join(wt.path, "marker.txt"), "kit\n");
    inWt("add", "-A");
    inWt("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "markers");
    const outcome = await finishWorktree(wt, "unused", nullLogger);
    expect(outcome.changed).toBe(true);
    expect(outcome.branch).toBe("codex/as991-markers");
    const report = worktreeReport(wt, outcome);
    expect(report).not.toContain("has no changes");
    expect(report).toContain("git merge codex/as991-markers");
  });

  it("never reports or offers to delete a branch checked out in another worktree", async () => {
    const mainBranch = git("symbolic-ref", "--short", "HEAD");
    const wt = await createWorktree({ cwd: repo, home, jobId: "job10", log: nullLogger });
    // The main checkout moves on, and the job fast-forwards onto it: its HEAD visits the main branch's tip.
    writeFileSync(join(repo, "main.txt"), "main work\n");
    git("add", "main.txt");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "main work");
    execFileSync("git", ["merge", "-q", "--ff-only", mainBranch], { cwd: wt.path });
    const report = worktreeReport(wt, await finishWorktree(wt, "unused", nullLogger));
    expect(report).not.toContain(`branch -D ${wt.branch} ${mainBranch}`);
    expect(report).not.toMatch(new RegExp(`Also committed from this worktree: .*\\b${mainBranch}\\b`));
  });

  it("lists a branch the job committed to and then left", async () => {
    const wt = await createWorktree({ cwd: repo, home, jobId: "job9", log: nullLogger });
    const inWt = (...args: string[]) => execFileSync("git", args, { cwd: wt.path, encoding: "utf8" }).trim();
    inWt("checkout", "-q", "-b", "fix/as-999-pins");
    writeFileSync(join(wt.path, "pins.txt"), "pins\n");
    inWt("add", "-A");
    inWt("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "pins");
    inWt("checkout", "-q", wt.branch);
    const outcome = await finishWorktree(wt, "unused", nullLogger);
    expect(outcome.changed).toBe(true);
    expect(outcome.branch).toBe("fix/as-999-pins");
    expect(worktreeReport(wt, outcome)).toContain("fix/as-999-pins");
    expect(worktreeReport(wt, outcome)).not.toContain("has no changes");
  });

  it("names the git folders a worktree needs writable to commit", async () => {
    const wt = await createWorktree({ cwd: repo, home, jobId: "job4", log: nullLogger });
    const dirs = (await gitDirsOutside(wt.path, nullLogger)).map((d) => d.replace(/\\/g, "/").toLowerCase());
    const common = git("rev-parse", "--path-format=absolute", "--git-common-dir").replace(/\\/g, "/").toLowerCase();
    expect(dirs).toContain(common);
    expect(dirs.some((d) => d.endsWith("/worktrees/" + wt.path.replace(/\\/g, "/").split("/").pop()!.toLowerCase()))).toBe(true);
    expect(await gitDirsOutside(repo, nullLogger)).toEqual([]);
  });

  it.each(["codex", "claude", "opencode"])("never includes attribution or task text in %s checkpoints", async (agent) => {
    const m = subagentCommitMessage({ answer: "**Fixed** the castle gate alignment.\n\nDetails …", task: "AnimaSky (Unity 6 URP, C#). Own git worktree. First: …", job: `${agent}-job-1`, agent, model: "gpt-6.1-sol" });
    expect(m).toBe("Save worktree changes");
    vi.stubEnv("GIT_AUTHOR_NAME", "Unwanted Author");
    vi.stubEnv("GIT_AUTHOR_EMAIL", "unwanted@example.test");
    const hook = join(repo, ".git", "hooks", "prepare-commit-msg");
    writeFileSync(hook, '#!/bin/sh\nprintf "\\nCo-Authored-By: unwanted\\n" >> "$1"\n');
    chmodSync(hook, 0o755);
    const wt = await createWorktree({ cwd: repo, home, jobId: agent, log: nullLogger });
    writeFileSync(join(wt.path, "a.txt"), "changed\n");
    await finishWorktree(wt, `AI ${agent} checkpoint\n\nCo-Authored-By: unwanted`, nullLogger);
    expect(git("log", "-1", "--format=%B", wt.branch)).toBe("Save worktree changes");
    expect(git("log", "-1", "--format=%an <%ae>", wt.branch)).toBe("Repository Owner <owner@example.test>");
  });

  it("refuses outside a git repository", async () => {
    await expect(createWorktree({ cwd: home, home, jobId: "job3", log: nullLogger })).rejects.toThrow(/needs a git repository/);
  });

  it("snapshots git status to find files changed in place", async () => {
    const before = await gitStatusSnapshot(repo, nullLogger);
    writeFileSync(join(repo, "a.txt"), "edited in place\n");
    const after = await gitStatusSnapshot(repo, nullLogger);
    expect([...after!].filter((l) => !before!.has(l))).toEqual([" M a.txt"]);
  });
});

describe("formatUsage", () => {
  it("summarizes tokens and cost", () => {
    expect(formatUsage({ usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 30 } })).toMatch(/^Usage: 1.200|^Usage: 1,200/);
    expect(formatUsage({ costUsd: 0.01234 })).toBe("Usage: $0.0123");
    expect(formatUsage({})).toBeNull();
  });
});

describe("review diff and handoff files", () => {
  const commitIn = (dir: string, file: string, msg: string) => {
    writeFileSync(join(dir, file), `${file}\n`);
    execFileSync("git", ["add", file], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg], { cwd: dir });
  };
  const mergeIn = (dir: string, branch: string) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-edit", branch], { cwd: dir });

  it("uses the actual fork point when a job creates a branch from another base", async () => {
    const mainBranch = git("symbolic-ref", "--short", "HEAD");
    git("checkout", "-q", "-b", "look4/candidate");
    commitIn(repo, "candidate.txt", "candidate work");
    const fork = git("rev-parse", "HEAD");
    git("checkout", "-q", mainBranch);
    commitIn(repo, "supervisor.txt", "supervisor work");
    const wt = await createWorktree({ cwd: repo, home, jobId: "switched", log: nullLogger });
    execFileSync("git", ["checkout", "-q", "-b", "look4/fix", "look4/candidate"], { cwd: wt.path });
    commitIn(wt.path, "job.txt", "job work");
    const outcome = await finishWorktree(wt, "unused", nullLogger);
    expect(outcome.reviewBase).toBe(fork);
    expect(outcome.files).toEqual(["job.txt"]);
    expect(outcome.branch).toBe("look4/fix");
    expect(outcome.otherBranches).toEqual([]);
    const report = worktreeReport(wt, outcome);
    expect(report).toContain(`Review base: ${fork} (job fork point)`);
    expect(report).not.toContain("candidate.txt");
    expect(report).not.toContain("supervisor.txt");
  });

  it("keeps each switched branch's base and commit count when the job leaves its work", async () => {
    const mainBranch = git("symbolic-ref", "--short", "HEAD");
    git("checkout", "-q", "-b", "candidate");
    commitIn(repo, "candidate.txt", "candidate work");
    const fork = git("rev-parse", "HEAD");
    git("checkout", "-q", mainBranch);
    const wt = await createWorktree({ cwd: repo, home, jobId: "left-switched", log: nullLogger });
    const inWt = (...args: string[]) => execFileSync("git", args, { cwd: wt.path });
    inWt("checkout", "-q", "-b", "fix/first", "candidate");
    commitIn(wt.path, "first.txt", "first work");
    inWt("checkout", "-q", "-b", "fix/second", "candidate");
    commitIn(wt.path, "second.txt", "second work");
    inWt("checkout", "-q", "fix/first");
    inWt("checkout", "-q", wt.branch);
    const outcome = await finishWorktree(wt, "unused", nullLogger);
    expect(outcome.reviewBase).toBe(fork);
    expect(outcome.files).toEqual(["first.txt"]);
    expect(outcome.otherBranches).toEqual([{ name: "fix/second", commits: 1 }]);
    expect(worktreeReport(wt, outcome)).not.toContain("candidate (1 commit)");
  });

  it("excludes newer alternate-base work that a switched job merged", async () => {
    const mainBranch = git("symbolic-ref", "--short", "HEAD");
    git("checkout", "-q", "-b", "candidate");
    commitIn(repo, "candidate.txt", "candidate work");
    git("checkout", "-q", mainBranch);
    const wt = await createWorktree({ cwd: repo, home, jobId: "merged-switched", log: nullLogger });
    execFileSync("git", ["checkout", "-q", "-b", "fix/merged", "candidate"], { cwd: wt.path });
    commitIn(wt.path, "job.txt", "job work");
    git("checkout", "-q", "candidate");
    commitIn(repo, "newer.txt", "newer candidate work");
    const fork = git("rev-parse", "HEAD");
    git("checkout", "-q", mainBranch);
    mergeIn(wt.path, "candidate");
    const outcome = await finishWorktree(wt, "unused", nullLogger);
    expect(outcome.reviewBase).toBe(fork);
    expect(outcome.files).toEqual(["job.txt"]);
    expect(outcome.otherBranches).toEqual([]);
  });

  it("does not report upstream work when a job only switches branches", async () => {
    const mainBranch = git("symbolic-ref", "--short", "HEAD");
    git("checkout", "-q", "-b", "candidate");
    commitIn(repo, "candidate.txt", "candidate work");
    git("checkout", "-q", mainBranch);
    const wt = await createWorktree({ cwd: repo, home, jobId: "switch-only", log: nullLogger });
    execFileSync("git", ["checkout", "-q", "-b", "fix/empty", "candidate"], { cwd: wt.path });
    const outcome = await finishWorktree(wt, "unused", nullLogger);
    expect(outcome.changed).toBe(false);
    expect(outcome.otherBranches).toEqual([]);
  });

  it("shows only the job's work when the job merged a newer base into its branch", async () => {
    const mainBranch = git("symbolic-ref", "--short", "HEAD");
    const wt = await createWorktree({ cwd: repo, home, jobId: "job5", log: nullLogger });
    expect(wt.baseBranch).toBe(mainBranch);
    commitIn(wt.path, "job.txt", "job work");
    // Meanwhile the base branch moves on, and the job merges it in.
    for (let i = 0; i < 5; i++) commitIn(repo, `other${i}.txt`, `other ${i}`);
    mergeIn(wt.path, mainBranch);
    const outcome = await finishWorktree(wt, "unused", nullLogger);
    expect(outcome.files).toEqual(["job.txt"]);
    expect(outcome.diffStat).not.toContain("other0.txt");
    expect(outcome.reviewBase).toBe(git("rev-parse", mainBranch));
    expect(worktreeReport(wt, outcome)).toContain(`Review: git diff ${outcome.reviewBase.slice(0, 12)}..agent-bridge/job5`);
  });

  it("also when the worktree was created from a stale detached checkout", async () => {
    const mainBranch = git("symbolic-ref", "--short", "HEAD");
    commitIn(repo, "newer.txt", "newer");
    git("checkout", "-q", "--detach", "HEAD~1");
    const wt = await createWorktree({ cwd: repo, home, jobId: "job6", log: nullLogger });
    git("checkout", "-q", mainBranch);
    expect(wt.baseBranch).toBeNull();
    commitIn(wt.path, "job.txt", "job work");
    mergeIn(wt.path, mainBranch);
    const outcome = await finishWorktree(wt, "unused", nullLogger);
    expect(outcome.files).toEqual(["job.txt"]);
  });

  it("warns when a job changed HANDOFF.md or TODO.md", async () => {
    const wt = await createWorktree({ cwd: repo, home, jobId: "job7", log: nullLogger });
    writeFileSync(join(wt.path, "HANDOFF.md"), "the job's own handoff\n");
    const report = worktreeReport(wt, await finishWorktree(wt, "handoff", nullLogger));
    expect(report).toMatch(/WARNING: this job changed HANDOFF\.md/);
    expect(handoffWarning(["src/a.ts", "docs/TODO.md"])).toContain("docs/TODO.md");
    expect(handoffWarning(["src/a.ts"])).toBeNull();
  });

  it("leaves no worktree locked", async () => {
    const wt = await createWorktree({ cwd: repo, home, jobId: "job8", log: nullLogger });
    expect(git("worktree", "list", "--porcelain")).not.toMatch(/^locked/m);
    // A lock left behind (e.g. "initializing" from an interrupted add) is released when the job ends.
    git("worktree", "lock", "--reason", "initializing", wt.path);
    await finishWorktree(wt, "unused", nullLogger);
    expect(git("worktree", "list", "--porcelain")).not.toMatch(/^locked/m);
  });
});

describe("auto-commit filtering", () => {
  const unityProject = () => {
    mkdirSync(join(repo, "ProjectSettings"));
    writeFileSync(join(repo, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0\n");
    writeFileSync(join(repo, "ProjectSettings", "ProjectSettings.asset"), "setting: value\n");
    git("add", "ProjectSettings");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "settings");
  };

  it("leaves whitespace-only settings changes uncommitted and explains the rule", async () => {
    unityProject();
    const wt = await createWorktree({ cwd: repo, home, jobId: "whitespace", log: nullLogger });
    const settings = "ProjectSettings/ProjectSettings.asset";
    writeFileSync(join(wt.path, settings), "setting: value \n");
    const outcome = await finishWorktree(wt, "verification only", nullLogger);
    expect(outcome.changed).toBe(false);
    expect(git("rev-parse", wt.branch)).toBe(wt.base);
    expect(outcome.skippedFiles).toEqual([{ path: settings, reason: "whitespace only" }]);
    expect(readFileSync(join(wt.path, settings), "utf8")).toBe("setting: value \n");
    expect(worktreeReport(wt, outcome)).toContain("has no real changes");
    expect(worktreeReport(wt, outcome)).toContain("Auto-commit skipped whitespace/line-ending-only changes");
  });

  it("excludes staged whitespace and generated noise while committing real settings and code", async () => {
    unityProject();
    const wt = await createWorktree({ cwd: repo, home, jobId: "mixed", log: nullLogger });
    writeFileSync(join(wt.path, "a.txt"), "original \n");
    writeFileSync(join(wt.path, "ProjectSettings", "ProjectSettings.asset"), "setting: new value\n");
    mkdirSync(join(wt.path, "Library"));
    writeFileSync(join(wt.path, "Library", "cache.asset"), "generated cache\n");
    const code = "code [one] 日本語.txt";
    writeFileSync(join(wt.path, code), "new code\n");
    execFileSync("git", ["add", "-A"], { cwd: wt.path });
    const outcome = await finishWorktree(wt, "real changes", nullLogger);
    expect(outcome.files.sort()).toEqual(["ProjectSettings/ProjectSettings.asset", code].sort());
    expect(outcome.skippedFiles).toEqual([
      { path: "Library/cache.asset", reason: "generated noise" },
      { path: "a.txt", reason: "whitespace only" },
    ]);
    expect(existsSync(join(wt.path, "Library", "cache.asset"))).toBe(true);
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: wt.path, encoding: "utf8" }).trim()).toBe("");
    expect(worktreeReport(wt, outcome)).toContain("Library/cache.asset (generated noise)");
  });

  it("skips raw EOL-only changes even when already staged", async () => {
    writeFileSync(join(repo, ".gitattributes"), "* -text\n");
    git("add", ".gitattributes");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "raw endings");
    const wt = await createWorktree({ cwd: repo, home, jobId: "eol", log: nullLogger });
    writeFileSync(join(wt.path, "a.txt"), "original\r\n");
    execFileSync("git", ["add", "a.txt"], { cwd: wt.path });
    const outcome = await finishWorktree(wt, "verification only", nullLogger);
    expect(outcome.changed).toBe(false);
    expect(outcome.skippedFiles).toEqual([{ path: "a.txt", reason: "whitespace only" }]);
    expect(git("rev-parse", wt.branch)).toBe(wt.base);
  });

  it("preserves additions, deletions, renames and binary changes", async () => {
    writeFileSync(join(repo, "image.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(repo, "remove.txt"), "remove me\n");
    git("add", "image.bin", "remove.txt");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "binary");
    const wt = await createWorktree({ cwd: repo, home, jobId: "structural", log: nullLogger });
    execFileSync("git", ["mv", "a.txt", "renamed.txt"], { cwd: wt.path });
    writeFileSync(join(wt.path, "empty.txt"), "");
    writeFileSync(join(wt.path, "image.bin"), Buffer.from([0, 1, 3]));
    rmSync(join(wt.path, "remove.txt"));
    const outcome = await finishWorktree(wt, "structural changes", nullLogger);
    expect(outcome.changed).toBe(true);
    expect(outcome.skippedFiles).toEqual([]);
    expect(git("show", `${wt.branch}:empty.txt`)).toBe("");
    expect(git("show", `${wt.branch}:renamed.txt`)).toBe("original");
    expect(git("ls-tree", "--name-only", wt.branch)).not.toContain("a.txt");
    expect(git("ls-tree", "--name-only", wt.branch)).not.toContain("remove.txt");
    expect(execFileSync("git", ["show", `${wt.branch}:image.bin`], { cwd: repo })).toEqual(Buffer.from([0, 1, 3]));
  });

  it("filters tracked and untracked caches in nested Unity projects but keeps source libraries", async () => {
    const project = join(repo, "unity", "Game");
    mkdirSync(join(project, "ProjectSettings"), { recursive: true });
    mkdirSync(join(project, "Library"));
    writeFileSync(join(project, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0\n");
    writeFileSync(join(project, "Library", "tracked.asset"), "old cache\n");
    git("add", "unity");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "legacy tracked cache");
    const wt = await createWorktree({ cwd: repo, home, jobId: "nested-noise", log: nullLogger });
    writeFileSync(join(wt.path, "unity", "Game", "Library", "tracked.asset"), "regenerated cache\n");
    mkdirSync(join(wt.path, "node_modules"));
    writeFileSync(join(wt.path, "node_modules", "cache.js"), "dependency\n");
    mkdirSync(join(wt.path, "Library"));
    writeFileSync(join(wt.path, "Library", "source.txt"), "source library\n");
    const outcome = await finishWorktree(wt, "source library", nullLogger);
    expect(outcome.files).toEqual(["Library/source.txt"]);
    expect(outcome.skippedFiles).toEqual([
      { path: "unity/Game/Library/tracked.asset", reason: "generated noise" },
      { path: "node_modules/cache.js", reason: "generated noise" },
    ]);
    expect(git("show", `${wt.branch}:unity/Game/Library/tracked.asset`)).toBe("old cache");
  });
});

describe("cleanup", () => {
  const DEEP_SEGMENTS = 8;
  const DEEP_SEGMENT = "unity-cache-with-a-long-generated-folder-name";
  const deepPath = (root: string) => join(root, "Library", ...Array<string>(DEEP_SEGMENTS).fill(DEEP_SEGMENT));

  it("preserves deep ignored files with repository long paths disabled", async () => {
    git("config", "core.longpaths", "false");
    writeFileSync(join(repo, ".git", "info", "exclude"), "Library/\n");
    const wt = await createWorktree({ cwd: repo, home, jobId: "deep", log: nullLogger });
    const deep = toNamespacedPath(deepPath(wt.path));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "cache.asset"), "generated\n");
    const entries = await cleanupWorktrees({ cwd: repo, home, all: true, apply: true, log: nullLogger });
    // Ignored files (e.g. a Unity cache) may be unique user data: the worktree is kept, nothing is deleted.
    expect(entries.find((e) => e.path === wt.path)?.action).toBe("kept");
    expect(entries.find((e) => e.path === wt.path)?.reason).toContain("unique user data");
    expect(readFileSync(join(deep, "cache.asset"), "utf8")).toBe("generated\n");
    expect(git("config", "core.longpaths")).toBe("false");
    expect(worktreeReport(wt, { changed: false, branch: wt.branch, otherBranches: [], diffStat: "", reviewBase: wt.base, files: [] }))
      .toContain("git -c core.longpaths=true worktree remove");
  });

  it("preserves ignored owner notes in an otherwise clean merged worktree", async () => {
    writeFileSync(join(repo, ".git", "info", "exclude"), "owner-notes.txt\n");
    const wt = await createWorktree({ cwd: repo, home, jobId: "ignored-owner", log: nullLogger });
    writeFileSync(join(wt.path, "owner-notes.txt"), "unique owner data\n");
    const entries = await cleanupWorktrees({ cwd: repo, home, all: true, apply: true, log: nullLogger });
    expect(entries.find((e) => e.path === wt.path)?.action).toBe("kept");
    expect(readFileSync(join(wt.path, "owner-notes.txt"), "utf8")).toBe("unique owner data\n");
    expect(git("branch", "--list", wt.branch)).toContain(wt.branch);
  });

  it("deletes deep leftovers through the filesystem fallback", async () => {
    const wt = await createWorktree({ cwd: repo, home, jobId: "deep-fallback", log: nullLogger });
    const deep = toNamespacedPath(deepPath(wt.path));
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "cache.asset"), "generated\n");
    removeWorktreeDirectory(wt.path);
    expect(existsSync(wt.path)).toBe(false);
    git("worktree", "prune");
    expect(git("worktree", "list", "--porcelain")).not.toContain(wt.path.replace(/\\/g, "/"));
  });

  it("cleans deep orphan folders without following their junctions", async () => {
    const shared = join(home, "shared-deep");
    mkdirSync(shared);
    writeFileSync(join(shared, "keep.txt"), "keep\n");
    const orphan = join(home, "worktrees", "deep-orphan");
    const deep = toNamespacedPath(deepPath(orphan));
    mkdirSync(deep, { recursive: true });
    symlinkSync(shared, join(deep, "shared"), "junction");
    const dry = await cleanupWorktrees({ cwd: repo, home, all: true, apply: false, log: nullLogger });
    expect(dry.find((e) => e.path === orphan)?.action).toBe("would remove");
    expect(dry.find((e) => e.path === orphan)?.externalLinks?.map((l) => ({ ...l, path: toNamespacedPath(l.path) }))).toEqual([{ path: join(deep, "shared"), target: shared }]);
    expect(dry.find((e) => e.path === orphan)?.reason).toContain("external worktree links");
    const entries = await cleanupWorktrees({ cwd: repo, home, all: true, apply: true, log: nullLogger });
    expect(entries.find((e) => e.path === orphan)?.action).toBe("removed");
    expect(existsSync(orphan)).toBe(false);
    expect(readFileSync(join(shared, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("removes only finished, merged, clean job worktrees and never follows links inside them", async () => {
    // Like a Unity Library folder: ignored, and a junction to a folder outside the worktree.
    writeFileSync(join(repo, ".git", "info", "exclude"), "Library\n");
    const shared = join(home, "shared");
    mkdirSync(shared);
    writeFileSync(join(shared, "keep.txt"), "must survive\n");

    const done = await createWorktree({ cwd: repo, home, jobId: "done", log: nullLogger });
    symlinkSync(shared, join(done.path, "Library"), "junction");
    const unmerged = await createWorktree({ cwd: repo, home, jobId: "unmerged", log: nullLogger });
    writeFileSync(join(unmerged.path, "x.txt"), "x\n");
    await finishWorktree(unmerged, "unmerged work", nullLogger);
    const dirty = await createWorktree({ cwd: repo, home, jobId: "dirty", log: nullLogger });
    writeFileSync(join(dirty.path, "a.txt"), "uncommitted\n");
    const running = await createWorktree({ cwd: repo, home, jobId: "running", log: nullLogger });
    writeFileSync(join(home, "jobs.json"), JSON.stringify([{ id: "r", name: "codex-job-running", status: "running", worktree: running }]));
    // Left by an older removal that stopped at a junction; and a folder of someone's files.
    const leftover = join(home, "worktrees", "proj-leftover");
    mkdirSync(join(leftover, "unity", "Game"), { recursive: true });
    symlinkSync(shared, join(leftover, "unity", "Game", "Library"), "junction");
    const foreign = join(home, "worktrees", "proj-foreign");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "notes.txt"), "mine\n");

    const byBranch = (entries: CleanupEntry[]) => Object.fromEntries(entries.map((e) => [e.branch, e]));
    const dryEntries = await cleanupWorktrees({ cwd: repo, home, all: true, apply: false, log: nullLogger });
    const dry = byBranch(dryEntries);
    expect(dry["agent-bridge/done"]!.action).toBe("would remove");
    expect(dry["agent-bridge/unmerged"]!.action).toBe("kept");
    expect(dry["agent-bridge/unmerged"]!.reason).toMatch(/not merged/);
    expect(dry["agent-bridge/dirty"]!.reason).toMatch(/uncommitted/);
    expect(dry["agent-bridge/running"]!.reason).toMatch(/codex-job-running is running/);
    expect(existsSync(done.path)).toBe(true);
    const leftovers = dryEntries.filter((e) => !e.branch);
    expect(leftovers.find((e) => e.path === leftover)?.action).toBe("would remove");
    expect(leftovers.find((e) => e.path === foreign)?.action).toBe("kept");

    const res = byBranch(await cleanupWorktrees({ cwd: repo, home, all: true, apply: true, log: nullLogger }));
    expect(res["agent-bridge/done"]!.action).toBe("removed");
    expect(res["agent-bridge/done"]!.reason).toMatch(/unlinked 1 link/);
    expect(existsSync(done.path)).toBe(false);
    expect(readFileSync(join(shared, "keep.txt"), "utf8")).toBe("must survive\n");
    expect(git("branch", "--list", "agent-bridge/done")).toBe("");
    for (const wt of [unmerged, dirty, running]) expect(existsSync(wt.path)).toBe(true);
    expect(existsSync(leftover)).toBe(false);
    expect(readFileSync(join(foreign, "notes.txt"), "utf8")).toBe("mine\n");
  });
});

describe("cleanup with unreadable folders", () => {
  // Windows ACL denial needs another account; POSIX modes stand in for it (root reads anything).
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("keeps a leftover folder it cannot read and still inspects the rest", async () => {
    const worktrees = join(home, "worktrees");
    const locked = join(worktrees, "other-project-1234abcd", "cache", "locked");
    mkdirSync(locked, { recursive: true });
    mkdirSync(join(worktrees, "empty-leftover-5678abcd", "folder"), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const entries = await cleanupWorktrees({ cwd: repo, home, all: true, apply: false, log: nullLogger });
      expect(entries.find((e) => e.path.includes("other-project"))).toMatchObject({ action: "kept" });
      expect(entries.find((e) => e.path.includes("empty-leftover"))).toMatchObject({ action: "would remove" });
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
