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
import { preferredDriveFixture } from "./preferred-drive-fixture.js";
import * as feeds from "../src/core/runfeed.js";
import { closeMetadataDb } from "../src/core/metadata-db.js";

let home: string;
beforeEach(() => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!;
  mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "run-"));
});
afterEach(() => { vi.restoreAllMocks(); closeMetadataDb(home); rmSync(home, { recursive: true, force: true }); });

const context = (): RunContext => ({ agent: "claude", cfg: { ...DEFAULT_CONFIG }, home, log: nullLogger, me: () => "parent", cwd: () => home,
  jobs: { askParent: vi.fn(async () => ({ allow: false, reason: "Publish builds only from merged master" })), fromSubagent: vi.fn(), note: vi.fn() },
});
const job = (): Job => ({ id: "test", name: "codex-job-test", agent: "codex", model: null, prompt: "task", startedAt: Date.now(), controller: new AbortController(), progress: null, status: "running", sessionId: null, workdir: null, worktree: null, queue: [] });

describe("delegation approval routing", () => {
  it("formats result and log paths without changing execution or saved workdir", async () => {
    await preferredDriveFixture();
    const actual = home;
    const startFeed = feeds.startRunFeedReady;
    vi.spyOn(feeds, "startRunFeedReady").mockImplementation(async (...args) => ({ ...await startFeed(...args), logPath: "Q:/logs/run.log" }));
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      expect(req.cwd).toBe(actual);
      return { sessionId: "saved", text: 'Report: "Q:/future/report.md"', isError: false, details: {} };
    });
    const result = await runDelegate(context(), "codex", { title: "paths", prompt: "task", access: "read" }, new AbortController().signal, undefined, true);
    expect(result.text).toContain('Report: "X:/future/report.md"');
    expect(result.text).toContain("Step-by-step log: X:/logs/run.log");
    expect(result.workdir).toBe(actual);
  });
  it("formats failure paths while retaining the original error type", async () => {
    await preferredDriveFixture();
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockRejectedValue(new DelegateError('failed in "Q:/work"', "failed"));
    const run = runDelegate(context(), "codex", { title: "failure", prompt: "task", access: "read" }, new AbortController().signal, undefined, true);
    await expect(run).rejects.toMatchObject({ message: 'failed in "X:/work"', kind: "failed" });
  });
  it("requires a supervisor decision for reviewer refusals despite tool allowlists or cached allows", async () => {
    const rc = context();
    rc.cfg.autoApproveTools = ["pair-desk.get_*"];
    const j = job();
    j.allowedServers = new Set(["mcp:pair-desk"]);
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      // The real Codex review-retry shape (codex-appserver.ts): "<tool>: <reason>\nAction: …\nApprove a retry …".
      const retry = (tool: string) => `${tool}: Automatic approval review refused this action\nAction: {"toolName":"${tool}"}\nApprove a retry of this exact action? Codex policy still applies.`;
      expect(await req.approve!({ agent: "codex", tool: "mcp:pair-desk", detail: retry("get_issue"), automaticReview: true })).toMatchObject({ allow: false });
      expect(await req.approve!({ agent: "codex", tool: "mcp:pair-desk", detail: retry("list_projects"), automaticReview: true })).toMatchObject({ allow: false });
      // A refused handoff write is still declined outright: the parent is never asked to approve a retry (AB-423).
      expect(await req.approve!({ agent: "codex", tool: "mcp:pair-desk", detail: retry("set_handoff"), automaticReview: true })).toMatchObject({ allow: false });
      return { sessionId: "saved", text: "done", isError: false, details: {} };
    });
    await runDelegate(rc, "codex", { title: "review", prompt: "task", access: "read" }, j.controller.signal, undefined, true, j);
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
  });
  it.each(["codex", "claude", "opencode"] as const)("allows desk reads by default without granting writes for %s", async (target) => {
    const rc = context();
    // Read access alone grants desk reads; the default job allowance (AB-403) is cleared to isolate it.
    rc.cfg.jobs = { ...rc.cfg.jobs, defaultAllowTools: [] };
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
