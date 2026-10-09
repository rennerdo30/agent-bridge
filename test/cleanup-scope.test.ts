import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCleanup } from "../src/cli/cleanup.js";
import { nullLogger } from "../src/core/logger.js";
import { cleanupWorktrees, repositoryCommonDir } from "../src/core/worktree-cleanup.js";
import { createWorktree } from "../src/core/worktree.js";
import { closeMetadataDb } from "../src/core/metadata-db.js";

let root: string;
let home: string;
let first: string;
let second: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-cleanup-scope-")));
  home = join(root, "home");
  first = join(root, "first");
  second = join(root, "second");
  for (const repo of [first, second]) {
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "base");
  }
});
afterEach(() => { for (const h of [home, join(root, "home-alias")]) closeMetadataDb(h); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const worktree = (cwd: string, jobId: string) => createWorktree({ cwd, home, jobId, log: nullLogger });

describe("cleanup repository scope", () => {
  it("finds trees under a configured worktreeRoot but never other folders there (AB-177)", async () => {
    const custom = join(root, "custom-trees");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ worktreeRoot: custom }));
    const tree = await createWorktree({ cwd: first, home, jobId: "c0ffee01", log: nullLogger, worktreeRoot: custom });
    mkdirSync(join(custom, "unrelated-folder"));
    const { isBridgeWorktree } = await import("../src/mcp/delegate-run.js");
    expect(isBridgeWorktree(join(tree.path, "src"), home)).toBe(true);
    expect(isBridgeWorktree(join(custom, "unrelated-folder"), home)).toBe(false);
    const entries = await cleanupWorktrees({ home, cwd: first, apply: false, log: nullLogger });
    expect(entries.map(e => e.path)).toEqual([tree.path]);
    expect(existsSync(join(custom, "unrelated-folder"))).toBe(true);
  });
  it("cleans through a home alias above the container while preserving linked cache sources", async () => {
    const a = await worktree(first, "alias-one");
    const alias = join(root, "home-alias"), cache = join(root, "cache-source");
    mkdirSync(cache);
    writeFileSync(join(cache, "keep.txt"), "unique cache bytes\n");
    symlinkSync(home, alias, "junction");
    writeFileSync(join(first, ".git", "info", "exclude"), "Library\n");
    symlinkSync(cache, join(a.path, "Library"), "junction");
    const entries = await cleanupWorktrees({ home: alias, cwd: first, apply: true, log: nullLogger });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe("removed");
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(alias)).toBe(true);
    expect(readFileSync(join(cache, "keep.txt"), "utf8")).toBe("unique cache bytes\n");
  });

  it("refuses a linked worktree container and never removes its target contents", async () => {
    const owner = join(root, "owner"), container = join(home, "worktrees");
    mkdirSync(owner); mkdirSync(home);
    writeFileSync(join(owner, "keep.txt"), "unique owner bytes\n");
    symlinkSync(owner, container, "junction");
    await expect(cleanupWorktrees({ home, cwd: first, apply: true, log: nullLogger })).rejects.toThrow("linked path");
    expect(readFileSync(join(owner, "keep.txt"), "utf8")).toBe("unique owner bytes\n");
  });

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

  it("keeps a worktree git refuses to remove instead of deleting it recursively (AB-222)", async () => {
    // A submodule's own ignored files are invisible to the superproject's status and ignored-file scan, and git
    // refuses `worktree remove` for a tree with an initialized submodule. That refusal must keep the folder.
    const sub = join(root, "sub");
    mkdirSync(sub);
    git(sub, "init", "-q");
    writeFileSync(join(sub, ".gitignore"), ".env\n");
    git(sub, "add", ".gitignore");
    git(sub, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "sub");
    git(first, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
    git(first, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "add sub");
    const a = await worktree(first, "5ab00001");
    git(a.path, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q");
    writeFileSync(join(a.path, "sub", ".env"), "unique secret\n");
    expect(git(a.path, "status", "--porcelain")).toBe("");
    const entries = await cleanupWorktrees({ home, cwd: first, apply: true, log: nullLogger });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).not.toBe("removed");
    expect(readFileSync(join(a.path, "sub", ".env"), "utf8")).toBe("unique secret\n");
    expect(git(first, "branch", "--list", a.branch)).toContain(a.branch);
  });
});
