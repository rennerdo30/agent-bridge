import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { createWorktree, finishWorktree, gitDirsOutside, gitStatusSnapshot, subagentCommitMessage, worktreeReport } from "../src/core/worktree.js";
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
