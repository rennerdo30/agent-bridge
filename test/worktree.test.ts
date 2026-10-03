import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { createWorktree, finishWorktree, gitDirsOutside, gitStatusSnapshot, handoffWarning, subagentCommitMessage, worktreeReport } from "../src/core/worktree.js";
import { cleanupWorktrees, type CleanupEntry } from "../src/core/worktree-cleanup.js";
import { formatUsage } from "../src/mcp/format.js";

let repo: string;
let home: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ab-repo-"));
  home = mkdtempSync(join(tmpdir(), "ab-home-"));
  git("init", "-q");
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
});

describe("worktree isolation", () => {
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

  it("builds commit messages from the answer, not the task", () => {
    const m = subagentCommitMessage({ answer: "**Fixed** the castle gate alignment.\n\nDetails …", task: "AnimaSky (Unity 6 URP, C#). Own git worktree. First: …", job: "codex-job-1", agent: "codex", model: "gpt-6.1-sol" });
    const [subject, , body] = m.split("\n");
    expect(subject).toBe("Fixed the castle gate alignment.");
    expect(body).toContain("codex-job-1");
    expect(m).toContain("Co-Authored-By: gpt-6.1-sol via codex <noreply@openai.com>");
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

describe("cleanup", () => {
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
    const dry = byBranch(await cleanupWorktrees({ home, apply: false, log: nullLogger }));
    expect(dry["agent-bridge/done"]!.action).toBe("would remove");
    expect(dry["agent-bridge/unmerged"]!.action).toBe("kept");
    expect(dry["agent-bridge/unmerged"]!.reason).toMatch(/not merged/);
    expect(dry["agent-bridge/dirty"]!.reason).toMatch(/uncommitted/);
    expect(dry["agent-bridge/running"]!.reason).toMatch(/codex-job-running is running/);
    expect(existsSync(done.path)).toBe(true);
    const leftovers = (await cleanupWorktrees({ home, apply: false, log: nullLogger })).filter((e) => !e.branch);
    expect(leftovers.find((e) => e.path === leftover)?.action).toBe("would remove");
    expect(leftovers.find((e) => e.path === foreign)?.action).toBe("kept");

    const res = byBranch(await cleanupWorktrees({ home, apply: true, log: nullLogger }));
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
