import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
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

let home: string;
beforeEach(() => {
  const root = join(process.cwd(), ".agent-bridge-test");
  mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "run-"));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

const context = (): RunContext => ({ agent: "claude", cfg: { ...DEFAULT_CONFIG }, home, log: nullLogger, me: () => "parent", cwd: () => home,
  jobs: { askParent: vi.fn(async () => ({ allow: false, reason: "Publish builds only from merged master" })), fromSubagent: vi.fn(), note: vi.fn() },
});
const job = (): Job => ({ id: "test", name: "codex-job-test", agent: "codex", model: null, prompt: "task", startedAt: Date.now(), controller: new AbortController(), progress: null, status: "running", sessionId: null, workdir: null, worktree: null, queue: [] });

describe("delegation approval routing", () => {
  it.each(["codex", "claude", "opencode"] as const)("allows desk reads by default without granting writes for %s", async (target) => {
    const rc = context();
    const j = job();
    vi.spyOn(DELEGATION_TARGETS[target], "run").mockImplementation(async (_cfg, req) => {
      for (const server of ["pair-desk", "pair_desk", "plugin_agent-pair-programming_pair-desk"]) {
        for (const tool of ["get_handoff", "get_issue", "list_issues"]) {
          expect(await req.approve!({ agent: target, tool: `mcp:${server}`, detail: `Allow server to run tool "${tool}"?` })).toEqual({ allow: true });
        }
      }
      expect(await req.approve!({ agent: target, tool: "mcp:pair-desk", detail: "set_plan: {}" })).toMatchObject({ allow: false });
      expect(await req.approve!({ agent: target, tool: "mcp:other", detail: "get_handoff: {}" })).toMatchObject({ allow: false });
      expect(await req.approve!({ agent: target, tool: "mcp:pair-desk", detail: "update_handoff: {}" })).toMatchObject({ allow: false });
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    await runDelegate(rc, target, { title: "read", prompt: "task", access: "read" }, j.controller.signal, undefined, true, j);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
  });

  it("forwards job cleanup to its supervisor with the full command", async () => {
    const rc = context();
    const j = job();
    const command = "[System.IO.Directory]::Delete('C:/worktree/Library')";
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      expect(await req.approve!({ agent: "codex", tool: "command", detail: command })).toMatchObject({ allow: false, message: expect.stringContaining("Denied by supervisor parent") });
      return { sessionId: "saved", text: "cleanup denied", isError: false, details: {} };
    });
    const result = await runDelegate(rc, "codex", { title: "cleanup", prompt: "task", access: "edit" }, j.controller.signal, undefined, true, j);
    expect(rc.jobs!.askParent).toHaveBeenCalledWith(j, expect.stringContaining(command), expect.any(Number), expect.objectContaining({ tool: "command" }));
    expect(result.text).toContain("denied by parent: command");
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
      expect(req.prompt).toContain("Never create symlinks, directory junctions");
      expect(req.prompt).toContain("Copy caches");
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

  it("does not auto-commit through a worktree root replaced by an external junction", async () => {
    const rc = context(); const root = join(home, "worktrees", "linked-root"); const outside = join(home, "owner");
    mkdirSync(join(home, "worktrees")); mkdirSync(outside);
    symlinkSync(outside, root, "junction");
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockResolvedValue({ sessionId: "saved", text: "done", isError: false, details: {} });
    const result = await runDelegate(rc, "codex", { title: "root", prompt: "task", access: "read", _worktree: { repoRoot: home, path: root, cwd: root, branch: "agent-bridge/test", base: "base" } }, new AbortController().signal, undefined, true);
    expect(result.text).toContain("Auto-commit skipped: the worktree root is an external link");
    expect(result.text).not.toContain("Could not commit");
  });
  it("publishes native-dialog approvals without changing foreground routing", async () => {
    const rc = context();
    rc.askUser = vi.fn(() => new Promise<PermissionDecision>(() => {}));
    const j = { ...job(), owner: "parent", foreground: true };
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      const permission: PermissionRequest = { agent: "codex", tool: "shell", detail: "npm test", reason: "Run checks" };
      const decision = req.approve!(permission);
      await until(() => listPendingApprovals(home).length === 1);
      const [entry] = listPendingApprovals(home);
      expect(entry).toMatchObject({ job: j.name, owner: "parent", command: "npm test", reason: "Run checks" });
      expect(await answerPendingApproval(home, entry!.id, { decision: "deny", reason: "Revise it" })).toBe("answered");
      expect(await decision).toEqual({ allow: false, message: "Revise it" });
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    await runDelegate(rc, "codex", { title: "test", prompt: "task", access: "edit" }, j.controller.signal, undefined, false, j);
    expect(rc.askUser).toHaveBeenCalledOnce();
    expect(rc.jobs!.askParent).not.toHaveBeenCalled();
    expect(listPendingApprovals(home)).toEqual([]);
  });

  for (const target of ["codex", "claude", "opencode"] as const) it(`keeps supervisor denial reasons and worker access for ${target}`, async () => {
    const rc = context();
    const j = job();
    vi.spyOn(DELEGATION_TARGETS[target], "run").mockImplementation(async (_cfg, req) => {
      expect(await req.approve!({ agent: target, tool: "mcp:pair-desk", detail: "set_plan: {}" })).toEqual({ allow: true });
      const denied = await req.approve!({ agent: target, tool: "mcp:pair-desk", detail: "set_build: {}" });
      expect(denied).toEqual({ allow: false, message: "Denied by supervisor parent: Publish builds only from merged master" });
      const handoff = await req.approve!({ agent: target, tool: "mcp:pair-desk", detail: "set_handoff: {}" });
      expect(handoff.allow).toBe(false);
      if (handoff.allow || denied.allow) throw new Error("Expected denials");
      expect(handoff.message).toContain("Declined by agent-bridge");
      req.onDenied?.(denied.message!);
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    await runDelegate(rc, target, { title: "test", prompt: "task", access: "read", allow_tools: ["pair-desk:worker"] }, j.controller.signal, undefined, true, j);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
    expect(j.queue).toEqual(["Denied by supervisor parent: Publish builds only from merged master"]);
  });
});

describe("delegated resource slot ownership", () => {
  for (const fail of [false, true]) it(`releases slots when a run ${fail ? "fails" : "ends"}`, async () => {
    const rc = context();
    rc.cfg.resourceSlots = { unity: 1 };
    const slots = new ResourceSlots(home);
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      expect(req.prompt).toContain("shared resource slots are enabled");
      expect(req.extraEnv?.AGENT_BRIDGE_HOME).toBe(home);
      const owner = { id: req.extraEnv![SLOT_OWNER_ENV]!, pid: Number(req.extraEnv![SLOT_PID_ENV]) };
      expect(slots.tryAcquire("unity", 1, owner)).toBe(true);
      expect(slots.list()).toHaveLength(1);
      if (fail) throw new DelegateError("hard failure", "failed");
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    try {
      const run = runDelegate(rc, "codex", { title: "test", prompt: "task", access: "read" }, new AbortController().signal, undefined, true);
      if (fail) await expect(run).rejects.toThrow("hard failure");
      else await run;
      expect(slots.list()).toEqual([]);
    } finally { slots.close(); }
  });
});
