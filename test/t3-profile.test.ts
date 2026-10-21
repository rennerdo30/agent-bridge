import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { T3Host, T3HostError, T3_TOOL_NAMES, t3TransportFromEnv, type T3Connect } from "../src/core/t3-host.js";
import { withoutT3Context } from "../src/core/job-environment.js";
import { childEnv } from "../src/core/delegate.js";
import { jobEnvironment } from "../src/core/job-environment.js";
import { daemonEnvironment } from "../src/core/daemon-launcher.js";
import { instructionsFor, registerTools, startServer, type ServerContext } from "../src/mcp/server.js";

const boundary = vi.hoisted(() => ({ hello: vi.fn(), usage: vi.fn(), run: vi.fn(), remote: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: () => { throw Error("Unexpected subprocess"); }, execFile: () => { throw Error("Unexpected exec"); }, execFileSync: () => { throw Error("Unexpected exec"); }, spawnSync: () => { throw Error("Unexpected exec"); } }));
vi.mock("node:net", async original => ({ ...await original<typeof import("node:net")>(), connect: () => { throw Error("Unexpected socket"); }, createServer: () => { throw Error("Unexpected server"); } }));
vi.mock("node:worker_threads", async original => ({ ...await original<typeof import("node:worker_threads")>(), Worker: class { constructor() { throw Error("Unexpected production worker"); } } }));
vi.mock("../src/core/node.js", () => ({ BridgeNode: class { constructor(options: unknown) { boundary.hello(options); throw Error("STOP before broker"); } } }));
vi.mock("../src/core/token.js", () => ({ loadOrCreateToken: () => "fixture-only" }));
vi.mock("../src/core/project-identity.js", async original => ({ ...await original<typeof import("../src/core/project-identity.js")>(), canonicalProjectRoot: () => null }));
vi.mock("../src/core/config.js", async original => ({ ...await original<typeof import("../src/core/config.js")>(), loadConfig: () => structuredClone(DEFAULT_CONFIG) }));
vi.mock("../src/core/logger.js", async original => { const actual = await original<typeof import("../src/core/logger.js")>(); return { ...actual, createLogger: () => actual.nullLogger }; });
vi.mock("../src/core/models.js", () => ({ modelParameterDescription: () => "Remote model ID", describeModels: vi.fn(), readModels: vi.fn() }));
vi.mock("../src/core/usage.js", () => ({ usageProbeFor: vi.fn(), checkUsagePreflight: boundary.usage, usageAdmissionText: vi.fn(), readUsage: vi.fn(), codexAppServerCall: vi.fn() }));
vi.mock("../src/mcp/delegate-run.js", () => ({ isInside: () => false, isBridgeWorktree: () => false, runDelegate: boundary.run, resumeArgs: vi.fn() }));
vi.mock("../src/mcp/remote-ask.js", () => ({ runRemoteAsk: boundary.remote }));
vi.mock("../src/mcp/message-wait.js", async original => ({ ...await original<typeof import("../src/mcp/message-wait.js")>(), MessageWaitStore: class { attach() {} } }));
// No worker, socket, daemon, lifecycle or provider is started by registration.
vi.mock("../src/mcp/jobs.js", async original => ({ ...await original<typeof import("../src/mcp/jobs.js")>(), JobManager: class {} }));

const injected = { T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:4321/scoped/mcp", T3_ACP_MCP_AUTHORIZATION: "Bearer fixture-only" };
const caps = (legacy = false): Record<string, unknown> => ({ parentThreadId: "parent", inheritedProviderInstanceId: "provider", inheritedModel: "custom-model",
  inheritedOptions: [{ id: "effort", value: "high" }], runtimeMode: "full-access", interactionMode: "default",
  features: { appOwnedSubagents: true, cancellation: true, threadManagement: true }, providers: [{ providerInstanceId: "provider", driverKind: "fixture", displayName: null,
    canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [], omittedModels: 3,
    models: [{ id: "custom-model", ...(legacy ? { label: "Custom" } : {}), options: legacy
      ? [{ id: "effort", label: "Effort", type: "select", options: [{ id: "high", label: "High" }] }]
      : [{ id: "effort", values: ["high", "medium"], default: "medium" }, { id: "fast", values: [true, false], default: false }] }] }] });
const envelope = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
function replay(catalog = caps(), currentThreadId = "parent", override?: (name: string, args: Record<string, unknown>) => unknown) {
  const calls = vi.fn(async (name: string, _args: Record<string, unknown>) => {
    const result = override?.(name, _args);
    if (result !== undefined) return envelope(result);
    if (name === "orchestrator_capabilities") return envelope(catalog);
    if (name === "t3_thread_list") return envelope({ currentThreadId, projectId: "project" });
    throw Error("Unexpected effect");
  });
  const close = vi.fn(async () => {});
  const connect: T3Connect = async () => ({ listTools: async () => ({ tools: T3_TOOL_NAMES.map(name => ({ name })) }), callTool: calls, close });
  return { host: new T3Host(t3TransportFromEnv({ ...injected, AGENT_BRIDGE_HOST: "t3" })!, connect), calls, close };
}
const taskReceipt = (options?: { id: string; value: string | boolean }[], model = "custom-model") => ({ taskId: "task", childNodeId: "child", childThreadId: "child-thread", childRunId: null,
  status: "queued", workState: "working", hasPendingChildRuns: false, hasPendingQuestion: false, waitTimedOut: false, summary: null,
  providerInstanceId: "provider", model, options, resultContextTransferId: null, latestTerminalResultContextTransferId: null,
  latestTerminalRunId: null, latestTerminalStatus: null, latestTerminalSummary: null });

beforeEach(() => {
  for (const key of ["AGENT_BRIDGE_HOST", "AGENT_BRIDGE_MCP_PROFILE", "T3_ACP_MCP_ENDPOINT", "T3_ACP_MCP_AUTHORIZATION", "AGENT_BRIDGE_DELEGATE_DEPTH", "AGENT_BRIDGE_INTERNAL"]) vi.stubEnv(key, undefined);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Unexpected network"); }));
  vi.clearAllMocks();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("automatically discovers only injected transport; explicit selectors never get auto-overridden", () => {
  for (const AGENT_BRIDGE_HOST of [undefined, "auto", "t3"]) expect(t3TransportFromEnv({ ...injected, AGENT_BRIDGE_HOST })?.scope).toMatch(/^[a-f0-9]{64}$/);
  expect(t3TransportFromEnv({})).toBeUndefined();
  expect(t3TransportFromEnv({ AGENT_BRIDGE_HOST: "auto", T3_ACP_MCP_NODE: "node" })).toBeUndefined();
  for (const AGENT_BRIDGE_HOST of ["off", "native", "full", "foreign", ""]) expect(t3TransportFromEnv({ ...injected, AGENT_BRIDGE_HOST })).toBeUndefined();
  for (const env of [{ T3_ACP_MCP_ENDPOINT: injected.T3_ACP_MCP_ENDPOINT }, { T3_ACP_MCP_AUTHORIZATION: injected.T3_ACP_MCP_AUTHORIZATION }, { ...injected, T3_ACP_MCP_ENDPOINT: "http://foreign.invalid/mcp" }, { ...injected, T3_ACP_MCP_AUTHORIZATION: "bad\r\nheader" }]) {
    expect(() => t3TransportFromEnv(env)).toThrow(T3HostError);
  }
});

it.each([false, true])("negotiates current/legacy catalog without losing options, inherited settings or omitted count (legacy=%s)", async legacy => {
  const r = replay(caps(legacy));
  const result = await r.host.capabilities();
  expect(result.capabilities).toMatchObject({ inheritedOptions: [{ id: "effort", value: "high" }], providers: [{ omittedModels: 3, models: [{ id: "custom-model" }] }] });
  expect(result.capabilities.providers[0]?.models[0]?.options).toEqual((caps(legacy).providers as any[])[0].models[0].options);
  expect(r.calls.mock.calls.map(c => c[0])).toEqual(["orchestrator_capabilities", "t3_thread_list"]);
  expect(r.close).toHaveBeenCalledOnce();
});

it("rejects foreign/expired/malformed handshakes without effects or secret disclosure", async () => {
  for (const r of [replay(caps(), "foreign"), replay({ ...caps(), inheritedOptions: [{ id: "effort", value: 42 }] }), replay({ ...caps(), providers: [] })]) {
    await expect(r.host.capabilities()).rejects.toThrow(T3HostError);
    expect(r.calls.mock.calls.every(c => ["orchestrator_capabilities", "t3_thread_list"].includes(c[0]))).toBe(true);
  }
  const host = new T3Host(t3TransportFromEnv({ ...injected, AGENT_BRIDGE_HOST: "t3" })!, async () => { throw Error(injected.T3_ACP_MCP_AUTHORIZATION); });
  await expect(host.capabilities()).rejects.toThrow(/No native fallback/);
  await expect(host.capabilities()).rejects.not.toThrow(/fixture-only/);
});

it("bounds discovery and an unresponsive injected handshake without any native fallback", async () => {
  const close = vi.fn(async () => {}), listTools = vi.fn(async () => ({ tools: [{ name: "orchestrator_capabilities" }, { name: "t3_thread_list" }], nextCursor: "again" })), callTool = vi.fn();
  const config = t3TransportFromEnv(injected)!;
  const paged = new T3Host(config, async () => ({ listTools, callTool, close }));
  await expect(paged.capabilities()).rejects.toMatchObject({ stage: "refused" });
  expect(listTools).toHaveBeenCalledTimes(8); expect(callTool).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  vi.useFakeTimers();
  try {
    const hung = new T3Host(config, async () => ({ listTools: () => new Promise(() => {}), callTool, close }));
    const pending = hung.capabilities().catch(error => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ stage: "refused" }); expect(callTool).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it("validates typed current and legacy options, inherits settings, and refuses mismatched receipts without retry", async () => {
  for (const legacy of [false, true]) {
    const r = replay(caps(legacy), "parent", name => name === "delegate_task" ? taskReceipt([{ id: "effort", value: "high" }]) : undefined);
    const result = await r.host.delegate({ task: "work", clientRequestId: "inherit" });
    expect(result.task.options).toEqual([{ id: "effort", value: "high" }]);
    // Omitting target lets T3 inherit; Bridge never invents a target/options override.
    expect(r.calls.mock.calls.find(c => c[0] === "delegate_task")![1]).not.toHaveProperty("target");
    for (const options of [[{ id: "effort", value: true }], [{ id: "unknown", value: "high" }], [{ id: "effort", value: "high" }, { id: "effort", value: "high" }]]) {
      const before = r.calls.mock.calls.filter(c => c[0] === "delegate_task").length;
      await expect(r.host.delegate({ task: "work", clientRequestId: "invalid", target: { providerInstanceId: "provider", model: "custom-model", options } })).rejects.toThrow();
      expect(r.calls.mock.calls.filter(c => c[0] === "delegate_task")).toHaveLength(before);
    }
  }
  const options = [{ id: "effort", value: "medium" }, { id: "fast", value: true }];
  const r = replay(caps(), "parent", name => name === "delegate_task" ? taskReceipt(options) : undefined);
  expect((await r.host.delegate({ task: "work", clientRequestId: "override", target: { providerInstanceId: "provider", model: "custom-model", options: { effort: "medium", fast: true } } })).task.options).toEqual(options);
  expect(r.calls.mock.calls.find(c => c[0] === "delegate_task")![1]).toMatchObject({ target: { options } });
  const cleared = replay(caps(), "parent", name => name === "delegate_task" ? taskReceipt([]) : undefined);
  await expect(cleared.host.delegate({ task: "work", clientRequestId: "clear", target: { providerInstanceId: "provider", model: "custom-model", options: [] } })).resolves.toMatchObject({ task: { options: [] } });
  const mismatch = replay(caps(), "parent", name => name === "delegate_task" ? taskReceipt([{ id: "effort", value: "medium" }]) : undefined);
  await expect(mismatch.host.delegate({ task: "work", clientRequestId: "stable-id" })).rejects.toMatchObject({ stage: "unknown" });
  expect(mismatch.calls.mock.calls.filter(c => c[0] === "delegate_task")).toHaveLength(1);
});

it("discovers omitted custom models with one bounded catalog search instead of restricting selection to favorites", async () => {
  const searched = caps();
  (searched.providers as any[])[0].models[0].id = "omitted-custom";
  const r = replay(caps(), "parent", (name, args) => name === "orchestrator_capabilities" && args.search ? searched : name === "delegate_task" ? taskReceipt([], "omitted-custom") : undefined);
  await expect(r.host.delegate({ task: "work", clientRequestId: "custom", target: { providerInstanceId: "provider", model: "omitted-custom" } })).resolves.toMatchObject({ task: { model: "omitted-custom" } });
  expect(r.calls.mock.calls.filter(c => c[0] === "orchestrator_capabilities").map(c => c[1])).toEqual([{}, { search: "omitted-custom" }]);
  expect((await r.host.capabilities(undefined, "omitted-custom")).capabilities.providers[0]?.models[0]?.id).toBe("omitted-custom");
  const foreign = replay(caps(), "parent", (name, args) => name === "orchestrator_capabilities" && args.search ? { ...searched, parentThreadId: "foreign" } : undefined);
  await expect(foreign.host.delegate({ task: "work", clientRequestId: "foreign", target: { providerInstanceId: "provider", model: "omitted-custom" } })).rejects.toMatchObject({ stage: "refused" });
  expect(foreign.calls.mock.calls.some(c => c[0] === "delegate_task")).toBe(false);
});

type Entry = { spec: { inputSchema: Record<string, z.ZodType>; description: string }; call: (args: any, extra: any) => Promise<any> };
async function registry(profile?: string, hosted = true, agent: "codex" | "claude" = "codex") {
  vi.stubEnv("AGENT_BRIDGE_MCP_PROFILE", profile);
  const r = replay(caps(true));
  if (hosted) await r.host.capabilities();
  const node = Object.assign(new EventEmitter(), { name: "fixture", currentSessionId: "native", wasReplaced: false, unread: vi.fn(() => []), nativeChildren: vi.fn(async () => []), noteFailure: vi.fn() });
  const jobs = { canStart: vi.fn(() => true), track: vi.fn(), start: vi.fn(), find: vi.fn(), restore: vi.fn(), share: vi.fn(), cancel: vi.fn(), persist: vi.fn(), recipient: vi.fn(async () => "fixture"), waiting: vi.fn(() => []), limit: 3 };
  const entries = new Map<string, Entry>();
  const mcp = { registerTool: (name: string, spec: Entry["spec"], call: Entry["call"]) => entries.set(name, { spec, call }) };
  const ctx = { agent, node, cfg: structuredClone(DEFAULT_CONFIG), log: nullLogger, home: process.env.AGENT_BRIDGE_HOME!, cwd: () => "/fixture", channelActive: () => false,
    jobs, runners: {}, ...(hosted ? { t3Host: r.host } : {}) } as unknown as ServerContext;
  registerTools(mcp as unknown as McpServer, ctx, ["codex"]);
  return { entries, jobs, ctx, node };
}
const extra = () => ({ signal: new AbortController().signal });

it("defaults validated T3 to reduced registration with remote-only spawn/ask; full and ordinary keep the legacy surface", async () => {
  const reduced = await registry();
  const hidden = ["t3_capabilities", "t3_delegate", "t3_task_status", "t3_task_cancel", "t3_send", "list_models", "usage_limits", "max_subagents", "resource_slots", "handoff_subagents", "job_checklist", "set_job_outcome"];
  for (const name of hidden) expect(reduced.entries.has(name), name).toBe(false);
  for (const name of ["send", "inbox", "wait_for_message", "peers", "health", "decide", "decisions", "ask_owner", "auto_wake", "hook_event", "project_main", "project_checklist", "search_history", "get_conversation", "send_files", "fetch_files", "spawn_codex", "ask_codex", "message_subagent", "pause_subagent", "resume_subagent", "cancel_subagent"]) expect(reduced.entries.has(name), name).toBe(true);
  for (const name of ["spawn_codex", "ask_codex"]) {
    const tool = reduced.entries.get(name)!;
    expect(tool.spec.description).toMatch(/remote|paired/i);
    for (const host of [undefined, "", " ", "invalid/name"]) expect(tool.spec.inputSchema.host!.safeParse(host).success).toBe(false);
    expect(tool.spec.inputSchema.host!.safeParse("paired-pc").success).toBe(true);
  }
  for (const [profile, hosted] of [["full", true], [undefined, false]] as const) {
    const full = await registry(profile, hosted);
    expect(full.entries.has("list_models")).toBe(true);
    expect(full.entries.get("spawn_codex")!.spec.inputSchema.host!.safeParse(undefined).success).toBe(true);
    expect(full.entries.has("t3_delegate")).toBe(hosted);
  }
});

it("refuses reduced without validated host and does not trust profile environment before handshake", async () => {
  await expect(registry("reduced", false)).rejects.toThrow(/validated T3/i);
  await expect(registry("invalid", true)).rejects.toThrow(/profile/i);
});

it("remote locality refusal precedes usage, checklist and job side effects, even if SDK validation is bypassed", async () => {
  const r = await registry();
  for (const name of ["spawn_codex", "ask_codex"]) for (const host of [undefined, "", " ", "invalid/name"]) {
    const result = await r.entries.get(name)!.call({ prompt: "work", title: "Remote work", host, checklist: [{ text: "must not read a project" }] }, extra());
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/remote|paired/i);
  }
  expect(boundary.usage).not.toHaveBeenCalled(); expect(boundary.run).not.toHaveBeenCalled(); expect(boundary.remote).not.toHaveBeenCalled();
  expect(r.jobs.start).not.toHaveBeenCalled(); expect(r.jobs.track).not.toHaveBeenCalled();
  // A valid remote request reaches existing remote validation, never local fallback.
  const result = await r.entries.get("spawn_codex")!.call({ prompt: "work", title: "Remote work", host: "paired-pc", cwd: "/remote", send_to: ["local"] }, extra());
  expect(result.isError).toBe(true); expect(JSON.stringify(result)).toMatch(/send_to is local-only/);
});

it("retains native Codex/Claude child refusal before ordinary tool side effects", async () => {
  for (const agent of ["codex", "claude"] as const) {
    const r = await registry(undefined, true, agent);
    r.ctx.admitCodex = agent === "codex" ? () => false : undefined;
    const result = await r.entries.get("spawn_codex")!.call({ host: "paired-pc", prompt: "work", title: "Work" }, { ...extra(), _meta: { agentId: "child" } });
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).toMatch(/child|parent authority/i);
    expect(r.jobs.start).not.toHaveBeenCalled();
  }
});

it("retains the existing remote ask route with supervisor ownership and without local provider usage", async () => {
  const r = await registry();
  const job = { id: "12345678", name: "codex-job-12345678", startedAt: 1, controller: new AbortController() };
  const end = vi.fn();
  r.jobs.track.mockReturnValue({ job, end });
  boundary.remote.mockResolvedValue({ text: "remote result", sessionId: "remote-session" });
  const result = await r.entries.get("ask_codex")!.call({ prompt: "work", title: "Remote work", host: "paired-pc", cwd: "/remote" }, extra());
  expect(result.isError, JSON.stringify(result)).not.toBe(true); expect(boundary.remote).toHaveBeenCalledOnce();
  expect(boundary.remote.mock.calls[0]![2]).toMatchObject({ host: "paired-pc", cwd: "/remote" });
  expect(job).toMatchObject({ remote: { host: "paired-pc", name: "codex-job-12345678" } });
  expect(end).toHaveBeenCalledOnce(); expect(boundary.usage).not.toHaveBeenCalled(); expect(boundary.run).not.toHaveBeenCalled();
});

it("does not broaden delegated depth registration or full-profile T3 delegate depth", async () => {
  const r = await registry("full");
  vi.stubEnv("AGENT_BRIDGE_DELEGATE_DEPTH", String(r.ctx.cfg.maxDelegateDepth));
  const result = await r.entries.get("t3_delegate")!.call({ task: "work", clientRequestId: "depth" }, extra());
  expect(result.isError).toBe(true); expect(JSON.stringify(result)).toMatch(/depth/i);
  const names: string[] = [];
  registerTools({ registerTool: (name: string) => names.push(name) } as unknown as McpServer, { ...r.ctx, node: null, t3Host: undefined, parent: { name: "parent" } as ServerContext["parent"] }, ["codex"]);
  expect(names).not.toContain("spawn_codex"); expect(names).not.toContain("ask_codex"); expect(names).toContain("report_progress");
});

it("uses profile-specific server instructions without advertising hidden tools", () => {
  const reduced = (instructionsFor as (...a: any[]) => string)("codex", ["codex"], "reduced");
  expect(reduced).toMatch(/T3.*native|native.*T3/i);
  expect(reduced).toMatch(/host/);
  for (const name of ["list_models", "usage_limits", "max_subagents", "job_checklist", "t3_delegate"]) expect(reduced).not.toContain(`"${name}"`);
  expect(instructionsFor("codex", ["codex"])).toContain('"list_models"');
});

it("strips profile and host selectors case-insensitively at shared child boundary without changing grants", () => {
  const clean = withoutT3Context({ ...injected, agent_bridge_host: "t3", agent_bridge_mcp_profile: "reduced", T3_ACP_MCP_NODE: "node", AGENT_BRIDGE_PARENT_TOKEN: "fixture-parent", KEEP: "yes" });
  expect(Object.keys(clean).filter(k => /^(AGENT_BRIDGE_HOST|AGENT_BRIDGE_MCP_PROFILE|T3_ACP_MCP_.*)$/i.test(k))).toEqual([]);
  expect(clean).toEqual({ AGENT_BRIDGE_PARENT_TOKEN: "fixture-parent", KEEP: "yes" });
  for (const [key, value] of Object.entries({ ...injected, AGENT_BRIDGE_HOST: "t3", AGENT_BRIDGE_MCP_PROFILE: "reduced" })) vi.stubEnv(key, value);
  for (const env of [childEnv({ AGENT_BRIDGE_MCP_PROFILE: "full" }), jobEnvironment(process.env), daemonEnvironment({ cli: "/fixture/cli", home: "/fixture/home", pipe: "fixture-pipe", cwd: "/fixture" })]) {
    expect(Object.keys(env).filter(k => /^(AGENT_BRIDGE_HOST|AGENT_BRIDGE_MCP_PROFILE|T3_ACP_MCP_.*)$/i.test(k))).toEqual([]);
  }
});

it("validates host before constructing a Bridge registration; inherited delegated/internal host refuses", async () => {
  for (const [key, value] of Object.entries(injected)) vi.stubEnv(key, value);
  const r = replay(caps(true));
  const negotiated = await r.host.capabilities();
  const handshake = vi.spyOn(T3Host.prototype, "capabilities").mockResolvedValue(negotiated);
  vi.spyOn(T3Host.prototype, "binding", "get").mockReturnValue(negotiated.binding);
  await expect(startServer(["--agent=codex"])).rejects.toThrow("STOP before broker");
  expect(handshake).toHaveBeenCalledOnce(); expect(boundary.hello).toHaveBeenCalledWith(expect.objectContaining({ frontend: negotiated.binding }));
  expect(handshake.mock.invocationCallOrder[0]!).toBeLessThan(boundary.hello.mock.invocationCallOrder[0]!);
  boundary.hello.mockClear(); handshake.mockRejectedValue(new T3HostError("refused", "capabilities"));
  await expect(startServer(["--agent=codex"])).rejects.toThrow(T3HostError); expect(boundary.hello).not.toHaveBeenCalled();
  for (const [key, value] of [["AGENT_BRIDGE_DELEGATE_DEPTH", "1"], ["AGENT_BRIDGE_INTERNAL", "1"]]) {
    handshake.mockClear(); vi.stubEnv(key!, value!);
    await expect(startServer(["--agent=codex"])).rejects.toThrow(/inherited host context/);
    expect(handshake).not.toHaveBeenCalled(); expect(boundary.hello).not.toHaveBeenCalled(); vi.stubEnv(key!, undefined);
  }
});
