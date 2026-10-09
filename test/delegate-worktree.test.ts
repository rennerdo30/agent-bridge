import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { DelegateError } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import { ResourceSlots, SLOT_OWNER_ENV, SLOT_PID_ENV } from "../src/core/resource-slots.js";
import { runDelegate, type RunContext } from "../src/mcp/delegate-run.js";
import type { Job } from "../src/mcp/jobs.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { answerPendingApproval, listPendingApprovals, type PermissionDecision, type PermissionRequest } from "../src/core/relay.js";
import { until } from "./helpers.js";
import { readWorktreeState, rootId, saveWorktreeState } from "../src/core/worktree-state.js";
import { closeJobWorktree } from "../src/core/job-close.js";
import { closeMetadataDb } from "../src/core/metadata-db.js";

let home: string;
beforeEach(() => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!;
  mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "run-"));
});
afterEach(() => { vi.restoreAllMocks(); closeMetadataDb(home); rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const context = (): RunContext => ({ agent: "claude", cfg: { ...DEFAULT_CONFIG }, home, log: nullLogger, me: () => "parent", cwd: () => home,
  jobs: { askParent: vi.fn(async () => ({ allow: false, reason: "Publish builds only from merged master" })), fromSubagent: vi.fn(), note: vi.fn() },
});
const job = (): Job => ({ id: "test", name: "codex-job-test", agent: "codex", model: null, prompt: "task", startedAt: Date.now(), controller: new AbortController(), progress: null, status: "running", sessionId: null, workdir: null, worktree: null, queue: [] });

describe("delegated worktree contracts", () => {
  it.each(["codex", "claude", "opencode"] as const)("fences implicit managed cwd jobs and invalidates prior shutdown proof for %s", async (target) => {
    const root = join(home, "worktrees", "existing"); const cwd = join(root, "client");
    mkdirSync(cwd, { recursive: true });
    const wt = { path: root, cwd: root, repoRoot: home, branch: "saved", base: "base" };
    saveWorktreeState(home, wt, { contractVersion: 1, path: root, repoRoot: home, base: "base", rootId: rootId(root), libraries: [], lastContinuation: 1, processesStopped: true });
    const close = () => closeJobWorktree({ home, job: { name: "saved-job", status: "done", worktree: wt }, enabled: true, log: nullLogger });
    vi.spyOn(DELEGATION_TARGETS[target], "run").mockImplementation(async () => {
      expect(await close()).toMatchObject({ action: "kept", reason: expect.stringContaining("lease") });
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    await runDelegate(context(), target, { title: "nested", prompt: "task", cwd, access: "read" }, new AbortController().signal, undefined, true);
    expect(readWorktreeState(home, wt)?.processesStopped).toBe(false);
    expect(readWorktreeState(home, wt)?.lastContinuation).toBeGreaterThan(1);
    expect(await close()).toMatchObject({ action: "kept", reason: expect.stringContaining("shutdown is unproven") });
  });
  it("records the actual finished branch and tip in run metadata and the saved worktree", async () => {
    const repo = join(home, "repo");
    mkdirSync(repo);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(repo, "init", "-q");
    git(repo, "config", "--local", "user.name", "Test");
    git(repo, "config", "--local", "user.email", "test@example.test");
    git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "base");
    const rc = { ...context(), cwd: () => repo };
    const j = job();
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      git(req.cwd, "checkout", "-qb", "finished-work");
      writeFileSync(join(req.cwd, "result.txt"), "done\n");
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    const result = await runDelegate(rc, "codex", { title: "task", prompt: "task", access: "edit", worktree: true, _job: j.name }, j.controller.signal, undefined, true, j);
    const metadata = readdirSync(join(home, "runs")).find((f) => f.endsWith(".json"))!;
    const saved = JSON.parse(readFileSync(join(home, "runs", metadata), "utf8"));
    expect(saved).toMatchObject({ branch: "finished-work", jobStartedAt: j.startedAt });
    // On a subst drive (E: for D:) git reports the backing drive: compare without the drive letter.
    expect(String(saved.repoRoot).replace(/^[A-Za-z]:/, "")).toBe(repo.replace(/\\/g, "/").replace(/^[A-Za-z]:/, ""));
    expect(saved.branchHead).toMatch(/^[a-f0-9]{40}$/);
    expect(result.worktree?.branch).toBe("finished-work");
    expect(result.worktree?.branchHead).toBe(saved.branchHead);
  });
  it.each([false, true])("instructs continued worktrees and reports ignored external links (failure=%s)", async (fail) => {
    const rc = context();
    const root = join(home, "worktrees", "existing");
    const outside = join(home, "owner-cache");
    mkdirSync(root, { recursive: true }); mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "owner data");
    symlinkSync(outside, join(root, "Library"), "junction");
    const wt = { repoRoot: home, path: root, cwd: root, branch: "agent-bridge/test", base: "base" };
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      expect(req.prompt).toContain("only for read-only access to Git-ignored caches");
      expect(req.prompt).toContain("never substitute an incomplete cache copy");
      expect(req.prompt).toContain("Never write, delete, truncate or change permissions in a linked source");
      if (fail) throw new DelegateError("failed task", "failed");
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    const run = runDelegate(rc, "codex", { title: "worktree", prompt: "task", session_id: "continued", _worktree: wt, access: "read" }, new AbortController().signal, undefined, true);
    if (fail) await expect(run).rejects.toThrow(/external worktree links[\s\S]*Library[\s\S]*owner-cache/);
    else expect((await run).text).toMatch(/external worktree links[\s\S]*Library[\s\S]*owner-cache/);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("owner data");
  });

  it("inspects the entire managed worktree when a job starts in a nested project folder", async () => {
    const rc = context();
    const root = join(home, "worktrees", "existing"); const cwd = join(root, "client"); const outside = join(home, "owner-cache");
    mkdirSync(cwd, { recursive: true }); mkdirSync(outside);
    symlinkSync(outside, join(root, "Library"), "junction");
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      expect(req.prompt).toContain("worktree isolation is mandatory");
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    const result = await runDelegate(rc, "codex", { title: "nested", prompt: "task", cwd, access: "read" }, new AbortController().signal, undefined, true);
    // On a subst drive (E: for D:), Windows stores a junction's target under the real drive letter.
    expect(result.text).toContain(`${join(root, "Library")} -> `);
    expect(result.text).toMatch(/Library -> [A-Z]:\\.*owner-cache|Library -> \/.*owner-cache/);
  });

  it("refuses a continued worktree root replaced by an external junction before launching tools", async () => {
    const rc = context(); const root = join(home, "worktrees", "linked-root"); const outside = join(home, "owner");
    mkdirSync(join(home, "worktrees")); mkdirSync(outside);
    symlinkSync(outside, root, "junction");
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockResolvedValue({ sessionId: "saved", text: "done", isError: false, details: {} });
    await expect(runDelegate(rc, "codex", { title: "root", prompt: "task", access: "read", _worktree: { repoRoot: home, path: root, cwd: root, branch: "agent-bridge/test", base: "base" } }, new AbortController().signal, undefined, true)).rejects.toThrow("through a link");
    expect(DELEGATION_TARGETS.codex.run).not.toHaveBeenCalled();
  });
});
