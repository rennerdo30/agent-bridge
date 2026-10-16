import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadConfig, type BridgeConfig } from "../src/core/config.js";
import { nullLogger, type Logger } from "../src/core/logger.js";
import { closeMetadataDb } from "../src/core/metadata-db.js";
import { RELAY_URL_ENV, type PermissionRequest } from "../src/core/relay.js";
import { effectiveAllowTools, isAutoApproved } from "../src/core/tool-allow.js";
import { startClaudeJobMcp } from "../src/core/claude-job-mcp.js";
import { runPermissionHook } from "../src/cli/permission-hook.js";
import { resumeArgs, runDelegate, type DelegateArgs, type RunContext } from "../src/mcp/delegate-run.js";
import { JobManager, readStore, type Job } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { until } from "./helpers.js";

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
const desk = (tool: string, agent: string, server = "pair-desk"): PermissionRequest => ({ agent, tool: `mcp:${server}`, detail: `${tool}: {}` });

const WORKER_TOOLS = ["get_issue", "list_issues", "comment", "progress", "set_plan", "update_step", "update_issue", "set_location"];
// Creating issues is not part of the worker preset (owner decision 2026-10-16): it is asked like status and build writes.
const EXCLUDED_TOOLS = ["create_issue", "set_status", "set_build", "queue_command", "merge_issues"];
const HANDOFF_TOOLS = ["set_handoff", "update_handoff"];
const TARGETS = Object.keys(DELEGATION_TARGETS) as (keyof typeof DELEGATION_TARGETS)[];

type RunOptions = { allow_tools?: string[]; access?: "read" | "ask" | "edit"; server?: string; args?: Partial<DelegateArgs> };

/** Runs one job of `target` and returns, per tool, whether the bridge allowed it without asking the parent. */
async function decisions(rc: RunContext, target: keyof typeof DELEGATION_TARGETS, tools: string[], options: RunOptions = {}) {
  const out: Record<string, boolean> = {};
  let claudeAllowTools: readonly string[] | undefined;
  let claudeRequiredAllowTools: readonly string[] | undefined;
  const j = job();
  vi.spyOn(DELEGATION_TARGETS[target], "run").mockImplementation(async (_cfg, req) => {
    claudeAllowTools = req.claudeAllowTools;
    claudeRequiredAllowTools = req.claudeRequiredAllowTools;
    for (const tool of tools) {
      const asked = vi.mocked(rc.jobs!.askParent).mock.calls.length;
      const d = await req.approve!(desk(tool, target, options.server));
      out[tool] = d.allow && vi.mocked(rc.jobs!.askParent).mock.calls.length === asked;
    }
    return { sessionId: "saved", text: "done", isError: false, details: {} };
  });
  const args = options.args ?? { title: "ab403", prompt: "task", access: options.access ?? "edit", ...(options.allow_tools ? { allow_tools: options.allow_tools } : {}) };
  await runDelegate(rc, target, args as DelegateArgs, j.controller.signal, undefined, true, j);
  vi.mocked(DELEGATION_TARGETS[target].run).mockRestore();
  return { out, claudeAllowTools, claudeRequiredAllowTools };
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
    // A comma-separated string is a valid list, like the other pattern settings.
    writeFileSync(join(home, "config.json"), JSON.stringify({ jobs: { defaultAllowTools: "pair-desk:worker,x" } }));
    expect(loadConfig(home, "claude", nullLogger, {}).jobs.defaultAllowTools).toEqual(["pair-desk:worker", "x"]);
    // An invalid value (a non-string entry) falls back to the default instead of widening or clearing it.
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

  it("keeps issue creation, status, build, handoff and other non-worker desk writes out of the worker preset", () => {
    for (const tool of WORKER_TOOLS) expect(isAutoApproved(desk(tool, "codex"), ["pair-desk:worker"]), tool).toBe(true);
    for (const tool of [...EXCLUDED_TOOLS, ...HANDOFF_TOOLS]) expect(isAutoApproved(desk(tool, "codex"), ["pair-desk:worker"]), tool).toBe(false);
    // An explicit grant still allows creating issues.
    expect(isAutoApproved(desk("create_issue", "codex"), ["pair-desk:worker", "pair-desk.create_issue"])).toBe(true);
  });

  it.each(TARGETS)("gives a %s job without allow_tools the worker preset and nothing more", async (target) => {
    const rc = context();
    const { out, claudeAllowTools, claudeRequiredAllowTools } = await decisions(rc, target, [...WORKER_TOOLS, ...EXCLUDED_TOOLS, ...HANDOFF_TOOLS]);
    for (const tool of WORKER_TOOLS) expect(out[tool], tool).toBe(true);
    for (const tool of [...EXCLUDED_TOOLS, ...HANDOFF_TOOLS]) expect(out[tool], tool).toBe(false);
    // Handoff writes are declined outright; issue creation, status and build writes still go to the parent.
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(EXCLUDED_TOOLS.length);
    if (target === "claude") {
      expect(claudeAllowTools).toEqual(["pair-desk:worker"]);
      // Only the default selects the desk server: a Claude job may run without it when it cannot start.
      expect(claudeRequiredAllowTools).toEqual([]);
    }
  });

  it.each(TARGETS)("asks before a %s job creates an issue under the default", async (target) => {
    const rc = context();
    const { out } = await decisions(rc, target, ["create_issue"]);
    expect(out).toEqual({ create_issue: false });
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(1);
    const granted = await decisions(context(), target, ["create_issue"], { allow_tools: ["pair-desk:worker", "pair-desk.create_issue"] });
    expect(granted.out).toEqual({ create_issue: true });
  });

  it.each(TARGETS)("adds the worker writes to read access for a %s job", async (target) => {
    const rc = context();
    const { out } = await decisions(rc, target, ["get_handoff", "list_issues", "comment", "set_plan", "update_issue", "set_status", "create_issue"], { access: "read" });
    expect(out).toEqual({ get_handoff: true, list_issues: true, comment: true, set_plan: true, update_issue: true, set_status: false, create_issue: false });
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
  });

  it.each(["pair_desk", "plugin_agent-pair-programming_pair-desk", "plugin_other_pair-desk"])("matches the %s server spelling under the default", async (server) => {
    for (const target of ["codex", "claude"] as const) {
      const rc = context();
      const { out } = await decisions(rc, target, ["set_plan", "comment", "set_status"], { server });
      expect(out, `${target} ${server}`).toEqual({ set_plan: true, comment: true, set_status: false });
    }
  });

  it.each(["pair-desk-evil", "plugin_x_y_pair-desk", "other", "pair-deskx", "evil_pair-desk"])("keeps asking for the %s server under the default", async (server) => {
    for (const target of ["codex", "claude"] as const) {
      const rc = context();
      const { out } = await decisions(rc, target, ["set_plan", "comment", "get_issue"], { server });
      expect(out, `${target} ${server}`).toEqual({ set_plan: false, comment: false, get_issue: false });
      expect(rc.jobs!.askParent).toHaveBeenCalledTimes(3);
    }
  });

  it.each(TARGETS)("turns the default off for a %s job with an explicit allow_tools: []", async (target) => {
    const rc = context();
    const { out, claudeAllowTools } = await decisions(rc, target, ["set_plan", "comment"], { allow_tools: [] });
    expect(out).toEqual({ set_plan: false, comment: false });
    expect(rc.jobs!.askParent).toHaveBeenCalledTimes(2);
    if (target === "claude") expect(claudeAllowTools).toEqual([]);
  });

  it.each(TARGETS)("keeps allow_tools: [] for follow-ups of a %s job, also after a restore from stored args", async (target) => {
    const original = { title: "ab403", prompt: "task", access: "edit", allow_tools: [] } as DelegateArgs;
    // A follow-up in the same server: the original call's args plus the job's saved args.
    const followUp = resumeArgs(original, "codex-job-test", "next", "saved", home, null, { title: "ab403", access: "edit", allow_tools: [] });
    expect(followUp.allow_tools).toEqual([]);
    const live = await decisions(context(), target, ["set_plan"], { args: followUp });
    expect(live.out).toEqual({ set_plan: false });

    // A restored job: its args come back from the job store, as the server rebuilds them on restore.
    const store = join(home, `jobs-${target}.json`);
    const manager = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger, store, 2);
    try {
      const done = manager.start(target, null, "task", async () => ({ text: "done", sessionId: "saved", isError: false, details: {} }), undefined, { title: "ab403", access: "edit", allow_tools: [] });
      await until(() => done.status === "done" && readStore(store).some((j) => j.id === done.id && j.status === "done"));
      const stored = readStore(store).find((j) => j.id === done.id)!.args!;
      expect(stored.allow_tools).toEqual([]);
      const restored = resumeArgs({ prompt: "", ...stored } as DelegateArgs, "codex-job-test", "next", "saved", home, null, stored);
      expect(restored.allow_tools).toEqual([]);
      const { out } = await decisions(context(), target, ["set_plan", "comment"], { args: restored });
      expect(out).toEqual({ set_plan: false, comment: false });
    } finally {
      manager.cancelAll();
    }
  });

  it.each(TARGETS)("replaces the default with an explicit list for a %s job", async (target) => {
    const rc = context();
    const { out, claudeRequiredAllowTools } = await decisions(rc, target, ["set_build", "set_plan"], { allow_tools: ["pair-desk.set_build"] });
    expect(out).toEqual({ set_build: true, set_plan: false });
    if (target === "claude") expect(claudeRequiredAllowTools).toEqual(["pair-desk.set_build"]);
    const extended = await decisions(context(), target, ["set_build", "set_plan", "set_status"], { allow_tools: ["pair-desk:worker", "pair-desk.set_build"] });
    expect(extended.out).toEqual({ set_build: true, set_plan: true, set_status: false });
  });

  it.each(TARGETS)("applies nothing to a %s job when the config clears the default", async (target) => {
    const rc = context({ defaultAllowTools: [] });
    const { out, claudeAllowTools } = await decisions(rc, target, ["set_plan", "get_issue"]);
    expect(out).toEqual({ set_plan: false, get_issue: false });
    if (target === "claude") expect(claudeAllowTools).toEqual([]);
  });

  it("uses the built-in default for a runner spec written without a jobs key", async () => {
    const rc = context();
    const { jobs: _jobs, ...older } = rc.cfg;
    rc.cfg = older as BridgeConfig;
    const { out } = await decisions(rc, "codex", ["set_plan", "set_status"]);
    expect(out).toEqual({ set_plan: true, set_status: false });
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

describe("AB-403 Claude job desk server availability", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
  /** A Claude config dir whose one installed plugin declares a pair-desk server at `url`. */
  function deskPlugin(url: string): string {
    const configDir = join(home, "claude-config");
    const plugin = join(home, "plugin");
    mkdirSync(join(configDir, "plugins"), { recursive: true });
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ mcpServers: { "pair-desk": { type: "http", url } } }));
    writeFileSync(join(configDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "fixture@market": [{ installPath: plugin, scope: "user" }] } }));
    return configDir;
  }
  async function listen(handler: Parameters<typeof createServer>[1]): Promise<Server> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    return server;
  }
  /** A port nothing listens on: the desk server cannot be reached. */
  async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((done) => server.close(() => done()));
    return port;
  }
  const logger = () => ({ ...nullLogger, warn: vi.fn() }) satisfies Logger;

  it("continues without a default-only desk server that fails to launch, and fails for an explicit grant", async () => {
    const configDir = deskPlugin(`http://127.0.0.1:${await closedPort()}/mcp`);
    const log = logger();
    const mcp = await startClaudeJobMcp({ cwd: home, patterns: ["pair-desk:worker"], requiredPatterns: [], env: { CLAUDE_CONFIG_DIR: configDir }, log, timeoutMs: 5_000 });
    try {
      expect(mcp.config).toEqual({});
      expect(mcp.allowed).toEqual([]);
      // The ambient server stays denied: the job runs without the desk, never with an unfiltered one.
      expect(mcp.denied).toEqual(["mcp__plugin_fixture_pair-desk"]);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("did not start"), { server: "plugin_fixture_pair-desk", reason: "launch failed" });
    } finally {
      await mcp.stop();
    }
    await expect(startClaudeJobMcp({ cwd: home, patterns: ["pair-desk:worker"], requiredPatterns: ["pair-desk:worker"], env: { CLAUDE_CONFIG_DIR: configDir }, log: nullLogger, timeoutMs: 5_000 }))
      .rejects.toThrow("refusing an unfiltered fallback");
    // Callers that do not say which grants are required keep the strict behaviour.
    await expect(startClaudeJobMcp({ cwd: home, patterns: ["pair-desk:worker"], env: { CLAUDE_CONFIG_DIR: configDir }, log: nullLogger, timeoutMs: 5_000 }))
      .rejects.toThrow("refusing an unfiltered fallback");
  });

  it("continues without a default-only desk server that does not answer in time, and fails for an explicit grant", async () => {
    // Accepts requests and never answers them.
    const server = await listen(() => {});
    const configDir = deskPlugin(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    const log = logger();
    const mcp = await startClaudeJobMcp({ cwd: home, patterns: ["pair-desk:worker"], requiredPatterns: [], env: { CLAUDE_CONFIG_DIR: configDir }, log, timeoutMs: 300 });
    try {
      expect(mcp.config).toEqual({});
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("did not start"), { server: "plugin_fixture_pair-desk", reason: "timeout" });
    } finally {
      await mcp.stop();
    }
    await expect(startClaudeJobMcp({ cwd: home, patterns: ["pair-desk:worker"], requiredPatterns: ["pair-desk.set_plan"], env: { CLAUDE_CONFIG_DIR: configDir }, log: nullLogger, timeoutMs: 300 }))
      .rejects.toThrow("refusing an unfiltered fallback");
  });

  it("still fails a job that is cancelled while a default-only desk server starts", async () => {
    const server = await listen(() => {});
    const configDir = deskPlugin(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    const controller = new AbortController();
    const started = startClaudeJobMcp({ cwd: home, patterns: ["pair-desk:worker"], requiredPatterns: [], env: { CLAUDE_CONFIG_DIR: configDir }, log: nullLogger, signal: controller.signal, timeoutMs: 5_000 });
    controller.abort(new Error("cancelled"));
    await expect(started).rejects.toThrow("refusing an unfiltered fallback");
  });
});
