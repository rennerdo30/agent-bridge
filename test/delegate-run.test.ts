import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
