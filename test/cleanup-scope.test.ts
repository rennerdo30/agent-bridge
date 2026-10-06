import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCleanup } from "../src/cli/cleanup.js";
import { nullLogger } from "../src/core/logger.js";
import { cleanupWorktrees, repositoryCommonDir } from "../src/core/worktree-cleanup.js";
import { createWorktree } from "../src/core/worktree.js";

let root: string;
let home: string;
let first: string;
let second: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ab-cleanup-scope-"));
  home = join(root, "home");
  first = join(root, "first");
  second = join(root, "second");
  for (const repo of [first, second]) {
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "base");
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const worktree = (cwd: string, jobId: string) => createWorktree({ cwd, home, jobId, log: nullLogger });

describe("cleanup repository scope", () => {
  it("defaults to the caller repository even from a linked worktree and nested folder", async () => {
    const a = await worktree(first, "one");
    const b = await worktree(second, "two");
    mkdirSync(join(a.path, "nested"));
    const entries = await cleanupWorktrees({ home, cwd: join(a.path, "nested"), apply: true, log: nullLogger });
    expect(entries.map((e) => e.path)).toEqual([a.path]);
    expect(entries[0]?.action).toBe("removed");
    expect(existsSync(b.path)).toBe(true);
    expect(git(second, "branch", "--list", b.branch)).toContain(b.branch);
  });

  it("selects --repo and announces scope and per-project paths before deleting", async () => {
    const a = await worktree(first, "one");
    const b = await worktree(second, "two");
    const lines: string[] = [];
    await runCleanup(["--repo", second, "--yes"], { home, cwd: first, log: nullLogger, out: (line) => {
      if (line.startsWith("Cleanup scope:")) expect(existsSync(b.path)).toBe(true);
      lines.push(line);
    } });
    expect(lines[0]).toContain(await repositoryCommonDir(second, nullLogger));
    expect(lines[1]).toContain("1 worktree(s)");
    expect(lines[2]).toContain(b.path);
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(false);
  });

  it("lists all projects in a dry run and only removes both with --all --yes", async () => {
    const a = await worktree(first, "one");
    const b = await worktree(second, "two");
    const lines: string[] = [];
    const opts = { home, cwd: root, log: nullLogger, out: (line: string) => lines.push(line) };
    await runCleanup(["--all", "--dry-run", "--yes"], opts);
    expect(lines[0]).toBe("Cleanup scope: all repositories (dry run)");
    expect(lines.filter((l) => l.startsWith("Repository:"))).toHaveLength(2);
    expect(lines).toContain(`  ${a.path}`);
    expect(lines).toContain(`  ${b.path}`);
    expect(existsSync(a.path) && existsSync(b.path)).toBe(true);
    await runCleanup(["--all", "--yes"], opts);
    expect(existsSync(a.path) || existsSync(b.path)).toBe(false);
  });

  it("rejects invalid scopes before mutation and does not guess an orphan's repository", async () => {
    const a = await worktree(first, "one");
    const orphan = join(home, "worktrees", "orphan");
    mkdirSync(orphan);
    writeFileSync(join(orphan, "keep.txt"), "keep");
    const opts = { home, cwd: first, log: nullLogger, out: () => {} };
    await expect(runCleanup(["--all", "--repo", first, "--yes"], opts)).rejects.toThrow("either");
    await expect(runCleanup(["--repo"], opts)).rejects.toThrow("requires");
    await expect(runCleanup(["--yes"], { ...opts, cwd: root })).rejects.toThrow();
    expect(existsSync(a.path)).toBe(true);
    const entries = await cleanupWorktrees({ ...opts, apply: false });
    expect(entries.map((e) => e.path)).toEqual([a.path]);
    expect(existsSync(orphan)).toBe(true);
  });

  it("does not inherit repository identity from the parent of an orphan folder", async () => {
    const scopedHome = join(first, "bridge-home");
    mkdirSync(join(scopedHome, "worktrees", "orphan"), { recursive: true });
    const entries = await cleanupWorktrees({ home: scopedHome, cwd: first, apply: true, log: nullLogger });
    expect(entries).toEqual([]);
    expect(existsSync(join(scopedHome, "worktrees", "orphan"))).toBe(true);
  });

  it("keeps a candidate rebound to another repository after the scope listing", async () => {
    const a = await worktree(first, "one");
    const entries = await cleanupWorktrees({ home, cwd: first, apply: true, log: nullLogger, onScope: () => {
      git(first, "worktree", "remove", a.path);
      git(second, "worktree", "add", "-b", "agent-bridge/rebound", a.path);
    } });
    expect(entries[0]).toMatchObject({ action: "kept", reason: "repository changed after scope selection" });
    expect(existsSync(a.path)).toBe(true);
  });
});
