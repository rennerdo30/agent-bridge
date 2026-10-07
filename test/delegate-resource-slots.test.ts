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
  const root = join(process.cwd(), ".agent-bridge-test");
  mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "run-"));
});
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });

const context = (): RunContext => ({ agent: "claude", cfg: { ...DEFAULT_CONFIG }, home, log: nullLogger, me: () => "parent", cwd: () => home,
  jobs: { askParent: vi.fn(async () => ({ allow: false, reason: "Publish builds only from merged master" })), fromSubagent: vi.fn(), note: vi.fn() },
});
const job = (): Job => ({ id: "test", name: "codex-job-test", agent: "codex", model: null, prompt: "task", startedAt: Date.now(), controller: new AbortController(), progress: null, status: "running", sessionId: null, workdir: null, worktree: null, queue: [] });

describe("delegated resource slot ownership", () => {
  for (const fail of [false, true]) it(`releases slots when a run ${fail ? "fails" : "ends"}`, async () => {
    const rc = context();
    rc.cfg.resourceSlots = { unity: 1 };
    const slots = new ResourceSlots(home);
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, req) => {
      // Native tools run after the CLI reports its session and releases startup admission.
      req.onSession?.("saved");
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
