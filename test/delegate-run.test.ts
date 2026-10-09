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

let home: string;
beforeEach(() => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!;
  mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "run-"));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

const context = (): RunContext => ({ agent: "claude", cfg: { ...DEFAULT_CONFIG }, home, log: nullLogger, me: () => "parent", cwd: () => home,
  jobs: { askParent: vi.fn(async () => ({ allow: false, reason: "Publish builds only from merged master" })), fromSubagent: vi.fn(), note: vi.fn() },
});
const job = (): Job => ({ id: "test", name: "codex-job-test", agent: "codex", model: null, prompt: "task", startedAt: Date.now(), controller: new AbortController(), progress: null, status: "running", sessionId: null, workdir: null, worktree: null, queue: [] });

describe("delegation approval routing", () => {
  it("requires a supervisor decision for reviewer refusals despite tool allowlists or cached allows", async () => {
    const rc = context();
    rc.cfg.autoApproveTools = ["pair-desk.get_*"];
    const j = job();
    j.allowedServers = new Set(["mcp:pair-desk"]);
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      expect(await req.approve!({ agent: "codex", tool: "mcp:pair-desk", detail: 'tool "get_issue" refused', automaticReview: true })).toMatchObject({ allow: false });
      expect(await req.approve!({ agent: "codex", tool: "mcp:pair-desk", detail: 'tool "list_projects" refused', automaticReview: true })).toMatchObject({ allow: false });
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    await runDelegate(rc, "codex", { title: "review", prompt: "task", access: "read" }, j.controller.signal, undefined, true, j);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
  });
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
