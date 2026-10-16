import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { closeMetadataDb } from "../src/core/metadata-db.js";
import { createWorktree } from "../src/core/worktree.js";
import { cleanupWorktrees } from "../src/core/worktree-cleanup.js";

/**
 * AB-419: on a loaded Windows runner the first PowerShell probe of this process's creation identity can time out.
 * The worktree lease then fails closed and cleanup kept a clean, merged worktree. Here the probe is made cold
 * deterministically: the synchronous probe the lease uses stays unknown until an asynchronous probe succeeds.
 */
const probe = vi.hoisted(() => ({ cold: false, failures: 0, asyncCalls: 0 }));
vi.mock("../src/core/process-identity.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/core/process-identity.js")>();
  return {
    ...real,
    processIdentity: (pid: number) => (probe.cold && pid === process.pid ? undefined : real.processIdentity(pid)),
    ownProcessIdentity: async () => {
      probe.asyncCalls++;
      if (probe.cold && probe.failures > 0) { probe.failures--; return undefined; }
      probe.cold = false;
      return real.ownProcessIdentity();
    },
  };
});

let repo: string;
let home: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  Object.assign(probe, { cold: false, failures: 0, asyncCalls: 0 });
  repo = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-repo-")));
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-home-")));
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, "global.gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  git("init", "-q");
  writeFileSync(join(repo, ".gitattributes"), "* text=auto eol=lf\n");
  git("add", ".gitattributes");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
});

afterEach(() => {
  try { git("worktree", "prune"); } catch { /* ignore */ }
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  closeMetadataDb(home);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  vi.unstubAllEnvs();
});

describe("cleanup with a cold process identity probe", () => {
  it("resolves the identity before taking the lease, so a slow first probe does not keep a clean merged worktree", async () => {
    const done = await createWorktree({ cwd: repo, home, jobId: "done", log: nullLogger });
    const dry = await cleanupWorktrees({ cwd: repo, home, all: true, apply: false, log: nullLogger });
    expect(dry.find((e) => e.branch === "agent-bridge/done")?.action).toBe("would remove");
    expect(probe.asyncCalls).toBe(0);

    Object.assign(probe, { cold: true, failures: 1 });
    const entries = await cleanupWorktrees({ cwd: repo, home, all: true, apply: true, log: nullLogger });
    const entry = entries.find((e) => e.branch === "agent-bridge/done");
    expect(entry, entry?.reason).toMatchObject({ action: "removed" });
    expect(probe.asyncCalls).toBe(2);
    expect(existsSync(done.path)).toBe(false);
    expect(git("branch", "--list", "agent-bridge/done")).toBe("");
  });

  it("keeps the worktree and its branch untouched when the identity stays unknown", async () => {
    const done = await createWorktree({ cwd: repo, home, jobId: "done", log: nullLogger });
    Object.assign(probe, { cold: true, failures: Number.POSITIVE_INFINITY });
    const entries = await cleanupWorktrees({ cwd: repo, home, all: true, apply: true, log: nullLogger });
    const entry = entries.find((e) => e.branch === "agent-bridge/done");
    expect(entry?.action).toBe("kept");
    expect(entry?.reason).toMatch(/Worktree is running, closing, or has an unreconciled lease; kept unchanged/);
    expect(probe.asyncCalls).toBe(3);
    expect(existsSync(join(done.path, ".git"))).toBe(true);
    expect(git("branch", "--list", "agent-bridge/done")).toContain("agent-bridge/done");
  });
});
