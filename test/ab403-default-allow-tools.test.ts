import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadConfig, type BridgeConfig } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { closeMetadataDb } from "../src/core/metadata-db.js";
import { RELAY_URL_ENV, type PermissionRequest } from "../src/core/relay.js";
import { effectiveAllowTools, isAutoApproved } from "../src/core/tool-allow.js";
import { runPermissionHook } from "../src/cli/permission-hook.js";
import { runDelegate, type RunContext } from "../src/mcp/delegate-run.js";
import type { Job } from "../src/mcp/jobs.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";

/** AB-403: every spawned or asked job gets "pair-desk:worker" unless the call or the config says otherwise. */
let home: string;
beforeEach(() => {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!;
  mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "ab403-"));
});
afterEach(() => { vi.restoreAllMocks(); closeMetadataDb(home); rmSync(home, { recursive: true, force: true }); });

const context = (jobs?: Partial<BridgeConfig["jobs"]>): RunContext => ({
  agent: "claude", cfg: { ...DEFAULT_CONFIG, jobs: { ...DEFAULT_CONFIG.jobs, ...jobs } }, home, log: nullLogger, me: () => "parent", cwd: () => home,
  jobs: { askParent: vi.fn(async () => ({ allow: false, reason: "asked" })), fromSubagent: vi.fn(), note: vi.fn() },
});
const job = (): Job => ({ id: "test", name: "codex-job-test", agent: "codex", model: null, prompt: "task", startedAt: Date.now(), controller: new AbortController(), progress: null, status: "running", sessionId: null, workdir: null, worktree: null, queue: [] });
const desk = (tool: string, agent: string): PermissionRequest => ({ agent, tool: "mcp:pair-desk", detail: `${tool}: {}` });

const WORKER_TOOLS = ["get_issue", "list_issues", "comment", "progress", "set_plan", "update_step", "create_issue", "update_issue", "set_location"];
const EXCLUDED_TOOLS = ["set_status", "set_build", "queue_command", "merge_issues"];
const HANDOFF_TOOLS = ["set_handoff", "update_handoff"];
const TARGETS = Object.keys(DELEGATION_TARGETS) as (keyof typeof DELEGATION_TARGETS)[];

/** Runs one job of `target` and returns, per tool, whether the bridge allowed it without asking the parent. */
async function decisions(rc: RunContext, target: keyof typeof DELEGATION_TARGETS, tools: string[], allow_tools?: string[]) {
  const out: Record<string, boolean> = {};
  let claudeAllowTools: readonly string[] | undefined;
  const j = job();
  vi.spyOn(DELEGATION_TARGETS[target], "run").mockImplementation(async (_cfg, req) => {
    claudeAllowTools = req.claudeAllowTools;
    for (const tool of tools) {
      const asked = vi.mocked(rc.jobs!.askParent).mock.calls.length;
      const d = await req.approve!(desk(tool, target));
      out[tool] = d.allow && vi.mocked(rc.jobs!.askParent).mock.calls.length === asked;
    }
    return { sessionId: "saved", text: "done", isError: false, details: {} };
  });
  await runDelegate(rc, target, { title: "ab403", prompt: "task", access: "edit", ...(allow_tools ? { allow_tools } : {}) }, j.controller.signal, undefined, true, j);
  return { out, claudeAllowTools };
}

describe("AB-403 default allow_tools for spawned jobs", () => {
  it("defaults the config key to the pair-desk worker preset and lets the home config change or clear it", () => {
    expect(DEFAULT_CONFIG.jobs.defaultAllowTools).toEqual(["pair-desk:worker"]);
    expect(loadConfig(home, "claude", nullLogger, {}).jobs.defaultAllowTools).toEqual(["pair-desk:worker"]);
    writeFileSync(join(home, "config.json"), JSON.stringify({ jobs: { defaultAllowTools: [] } }));
    expect(loadConfig(home, "claude", nullLogger, {}).jobs.defaultAllowTools).toEqual([]);
    writeFileSync(join(home, "config.json"), JSON.stringify({ jobs: { defaultAllowTools: ["pair-desk.get_*"] }, codex: { jobs: { defaultAllowTools: ["other"] } } }));
    expect(loadConfig(home, "claude", nullLogger, {}).jobs.defaultAllowTools).toEqual(["pair-desk.get_*"]);
    expect(loadConfig(home, "codex", nullLogger, {}).jobs.defaultAllowTools).toEqual(["other"]);
    // An invalid value falls back to the default instead of widening or clearing it.
    writeFileSync(join(home, "config.json"), JSON.stringify({ jobs: { defaultAllowTools: "pair-desk:worker,x" } }));
    expect(loadConfig(home, "claude", nullLogger, {}).jobs.defaultAllowTools).toEqual(["pair-desk:worker", "x"]);
    writeFileSync(join(home, "config.json"), JSON.stringify({ jobs: { defaultAllowTools: [1] } }));
    expect(loadConfig(home, "claude", nullLogger, {}).jobs.defaultAllowTools).toEqual(["pair-desk:worker"]);
  });

  it("cannot be set by a repository's project config", () => {
    const project = join(home, "repo");
    mkdirSync(join(project, ".agent-bridge"), { recursive: true });
    writeFileSync(join(project, ".agent-bridge", "config.json"), JSON.stringify({ jobs: { defaultAllowTools: ["*"] }, claude: { jobs: { defaultAllowTools: ["*"] } } }));
    expect(loadConfig(home, "claude", nullLogger, {}, project).jobs.defaultAllowTools).toEqual(["pair-desk:worker"]);
  });

  it("resolves an explicit list as a replacement and an explicit [] as none", () => {
    expect(effectiveAllowTools(undefined, ["pair-desk:worker"])).toEqual(["pair-desk:worker"]);
    expect(effectiveAllowTools([], ["pair-desk:worker"])).toEqual([]);
    expect(effectiveAllowTools(["pair-desk.set_build"], ["pair-desk:worker"])).toEqual(["pair-desk.set_build"]);
    expect(effectiveAllowTools(undefined, [])).toEqual([]);
  });

  it("keeps status, build, handoff and other non-worker desk writes out of the worker preset", () => {
    for (const tool of WORKER_TOOLS) expect(isAutoApproved(desk(tool, "codex"), ["pair-desk:worker"]), tool).toBe(true);
    for (const tool of [...EXCLUDED_TOOLS, ...HANDOFF_TOOLS]) expect(isAutoApproved(desk(tool, "codex"), ["pair-desk:worker"]), tool).toBe(false);
  });

  it.each(TARGETS)("gives a %s job without allow_tools the worker preset and nothing more", async (target) => {
    const rc = context();
    const { out, claudeAllowTools } = await decisions(rc, target, [...WORKER_TOOLS, ...EXCLUDED_TOOLS, ...HANDOFF_TOOLS]);
    for (const tool of WORKER_TOOLS) expect(out[tool], tool).toBe(true);
    for (const tool of [...EXCLUDED_TOOLS, ...HANDOFF_TOOLS]) expect(out[tool], tool).toBe(false);
    // Handoff writes are declined outright; status and build writes still go to the parent.
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(EXCLUDED_TOOLS.length);
    if (target === "claude") expect(claudeAllowTools).toEqual(["pair-desk:worker"]);
  });

  it.each(TARGETS)("turns the default off for a %s job with an explicit allow_tools: []", async (target) => {
    const rc = context();
    const { out, claudeAllowTools } = await decisions(rc, target, ["set_plan", "comment"], []);
    expect(out).toEqual({ set_plan: false, comment: false });
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
    if (target === "claude") expect(claudeAllowTools).toEqual([]);
  });

  it.each(TARGETS)("replaces the default with an explicit list for a %s job", async (target) => {
    const rc = context();
    const { out } = await decisions(rc, target, ["set_build", "set_plan"], ["pair-desk.set_build"]);
    expect(out).toEqual({ set_build: true, set_plan: false });
    const extended = await decisions(context(), target, ["set_build", "set_plan", "set_status"], ["pair-desk:worker", "pair-desk.set_build"]);
    expect(extended.out).toEqual({ set_build: true, set_plan: true, set_status: false });
  });

  it.each(TARGETS)("applies nothing to a %s job when the config clears the default", async (target) => {
    const rc = context({ defaultAllowTools: [] });
    const { out, claudeAllowTools } = await decisions(rc, target, ["set_plan", "get_issue"]);
    expect(out).toEqual({ set_plan: false, get_issue: false });
    if (target === "claude") expect(claudeAllowTools).toEqual([]);
  });

  it("does not reach native children or the main session: the permission hook stays silent outside a bridge job", async () => {
    const saved = process.env[RELAY_URL_ENV];
    delete process.env[RELAY_URL_ENV];
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await runPermissionHook("claude")).toBe(0);
      expect(write).not.toHaveBeenCalled();
    } finally {
      if (saved !== undefined) process.env[RELAY_URL_ENV] = saved;
    }
  });
});
