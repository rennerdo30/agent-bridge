import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as childProcess from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { T3Host, T3HostError, T3_TOOL_NAMES, t3TransportFromEnv, type T3Connect, type T3TransportConfig } from "../src/core/t3-host.js";
import { withoutT3Context } from "../src/core/t3-identity.js";
import { childEnv } from "../src/core/delegate.js";
import { jobEnvironment } from "../src/core/job-environment.js";
import { daemonEnvironment, launchDaemon } from "../src/core/daemon-launcher.js";
import { BridgeNode } from "../src/core/node.js";
import { loadConfig } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { channelPusher, registerTools, type ServerContext } from "../src/mcp/server.js";
import { T3Waker } from "../src/mcp/t3-wake.js";
import { T3WakeJournal, T3_WAKE_MESSAGE_LIMIT } from "../src/core/t3-wake-journal.js";
import * as jsonStore from "../src/core/json-store.js";
import { makeEnv } from "./helpers.js";
import { registrationIdentity } from "../src/core/store.js";
import type { PeerInfo } from "../src/core/protocol.js";
import type { BridgeMessage } from "../src/core/protocol.js";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

const binding = (threadId: string) => ({ kind: "t3" as const, scope: "a".repeat(64), threadId, providerInstanceId: "custom-provider" });
const peer = (threadId: string): PeerInfo & { frontend: ReturnType<typeof binding> } => ({
  id: threadId, name: "codex-project", agent: "codex", cwd: process.cwd(), pid: 100,
  agentPid: 200, agentStartedAt: "same-provider-host", sessionId: null, startedAt: 1,
  autoWake: false, frontend: binding(threadId),
});

it("keeps two T3 threads distinct before either provider session ID is known", () => {
  expect(registrationIdentity(peer("thread-a"))).not.toBe(registrationIdentity(peer("thread-b")));
});

const scopedEnv = { AGENT_BRIDGE_HOST: "t3", T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:4321/scoped/mcp", T3_ACP_MCP_AUTHORIZATION: "Bearer fixture-only" };
const transport = (): T3TransportConfig => t3TransportFromEnv(scopedEnv)!;
const envelope = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const caps = () => ({ parentThreadId: "t3-parent", inheritedProviderInstanceId: "custom-provider", inheritedModel: "custom-model",
  runtimeMode: "full-access", interactionMode: "default", features: { appOwnedSubagents: true, cancellation: true, threadManagement: true },
  providers: [{ providerInstanceId: "custom-provider", driverKind: "fixture", displayName: "Custom composer provider", canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [], runtimeModes: ["full-access"],
    models: [{ id: "custom-model", label: "Custom model", options: [{ id: "effort", label: "Effort", type: "select", currentValue: "medium", options: [{ id: "medium", label: "Medium" }, { id: "high", label: "High" }] }] }] }] });
const task = () => ({ taskId: "task-1", childNodeId: "child-node", childThreadId: "child-thread", childRunId: "child-run",
  status: "completed", workState: "waiting_for_children", hasPendingChildRuns: true, hasPendingQuestion: true, waitTimedOut: false,
  summary: "Original published result", providerInstanceId: "custom-provider", model: "custom-model", resultContextTransferId: null,
  latestTerminalResultContextTransferId: null, latestTerminalRunId: "later-run", latestTerminalStatus: "failed", latestTerminalSummary: "Later follow-up failed" });
type Call = { name: string; args: Record<string, unknown> };
function replay(override?: (name: string, args: Record<string, unknown>) => unknown | Promise<unknown>) {
  const calls: Call[] = [], connections: { closed: boolean }[] = [];
  const defaults = (name: string, args: Record<string, unknown>) => {
    switch (name) {
      case "orchestrator_capabilities": return envelope(caps());
      case "t3_thread_list": return envelope({ currentThreadId: "t3-parent", projectId: "project" });
      case "t3_thread_send": return envelope({ threadId: args.threadId, messageId: "message-1", runId: "run-1", delivery: "queued", status: "queued" });
      case "delegate_task": case "task_status": return envelope(task());
      case "task_cancel": return envelope({ taskId: args.taskId, status: "completed" });
      default: throw new Error("Unexpected tool");
    }
  };
  const connect: T3Connect = async () => {
    const connection = { closed: false }; connections.push(connection);
    return { listTools: async () => ({ tools: T3_TOOL_NAMES.map(name => ({ name })) }),
      callTool: async (name, args) => { calls.push({ name, args }); return await override?.(name, args) ?? defaults(name, args); },
      close: async () => { connection.closed = true; } };
  };
  return { host: new T3Host(transport(), connect), calls, connections, connect };
}

it("requires explicit opt-in and refuses missing, partial, unsafe or credential-bearing transport", () => {
  expect(t3TransportFromEnv({ ...scopedEnv, AGENT_BRIDGE_HOST: undefined })).toBeUndefined();
  for (const env of [ { AGENT_BRIDGE_HOST: "t3" }, { ...scopedEnv, T3_ACP_MCP_AUTHORIZATION: "" },
    ...["http://example.com/mcp", "http://localhost/mcp", "http://127.1/mcp", "http://2130706433/mcp", "ftp://127.0.0.1/mcp", "https://user:secret@example.com/mcp", "https://example.com/mcp?token=secret", "https://example.com/mcp#secret", "https://example.com/\n"].map(T3_ACP_MCP_ENDPOINT => ({ ...scopedEnv, T3_ACP_MCP_ENDPOINT })),
    { ...scopedEnv, T3_ACP_MCP_AUTHORIZATION: "Bearer fixture\r\nheader" } ]) {
    expect(() => t3TransportFromEnv(env)).toThrow(T3HostError);
  }
  expect(t3TransportFromEnv({ ...scopedEnv, T3_ACP_MCP_ENDPOINT: "https://host.example/mcp" })?.scope).toMatch(/^[a-f0-9]{64}$/);
  expect(t3TransportFromEnv({ ...scopedEnv, T3_ACP_MCP_ENDPOINT: "http://[::1]:1234/mcp" })).toBeDefined();
});

it("strips all T3 host context from delegates and detached jobs without changing other grants", () => {
  for (const [key, value] of Object.entries({ ...scopedEnv, T3_ACP_MCP_NODE: "fixture-node", t3_acp_mcp_entrypoint: "fixture-entry", AGENT_BRIDGE_PARENT_TOKEN: "fixture-parent" })) vi.stubEnv(key, value);
  for (const result of [childEnv({ T3_ACP_MCP_ENDPOINT: "injected", AGENT_BRIDGE_HOST: "t3", KEEP_EXTRA: "yes" }), jobEnvironment(process.env), withoutT3Context(process.env)]) {
    expect(Object.keys(result).filter(key => key.toUpperCase() === "AGENT_BRIDGE_HOST" || key.toUpperCase().startsWith("T3_ACP_MCP_"))).toEqual([]);
    expect(result.AGENT_BRIDGE_PARENT_TOKEN).toBe("fixture-parent");
  }
  expect(childEnv({ KEEP_EXTRA: "yes" }).KEEP_EXTRA).toBe("yes");
  expect(jobEnvironment({ KEEP: "yes" }).KEEP).toBe("yes");
});

it("attests the exact T3 parent independently of native metadata and closes every connection", async () => {
  const r = replay();
  const discovered = await r.host.capabilities();
  expect(discovered.binding).toMatchObject({ threadId: "t3-parent", providerInstanceId: "custom-provider" });
  expect(discovered.capabilities.providers[0]?.models[0]?.id).toBe("custom-model");
  const sent = await r.host.send({ message: "hello", clientRequestId: "send-1" });
  expect(sent.consumption).toBe("unconfirmed");
  expect(r.calls.filter(c => c.name === "t3_thread_send")).toEqual([{ name: "t3_thread_send", args: { threadId: "t3-parent", message: "hello", clientRequestId: "send-1", mode: "queue" } }]);
  expect(r.connections).toHaveLength(2);
  expect(r.connections.every(c => c.closed)).toBe(true);
  expect(JSON.stringify(discovered)).not.toContain(scopedEnv.T3_ACP_MCP_AUTHORIZATION);
});

it.each(["wrong-parent", "changed-parent", "isError", "malformed", "missing-tool"])("fails closed before effects for %s", async kind => {
  let changed = false;
  const r = replay(name => {
    if (name === "t3_thread_list" && (kind === "wrong-parent" || changed)) return envelope({ currentThreadId: "other-parent", projectId: "project" });
    if (name === "orchestrator_capabilities" && kind === "isError") return { ...envelope(caps()), structuredContent: caps(), isError: true };
    if (name === "orchestrator_capabilities" && kind === "malformed") return envelope({ parentThreadId: "t3-parent" });
  });
  let host = r.host;
  if (kind === "changed-parent") { await host.capabilities(); changed = true; }
  if (kind === "missing-tool") host = new T3Host(transport(), async (...args) => ({ ...await r.connect(...args), listTools: async () => ({ tools: [{ name: "orchestrator_capabilities" }] }) }));
  await expect(host.send({ message: "no side effect", clientRequestId: "send-2" })).rejects.toMatchObject({ stage: "refused" });
  expect(r.calls.some(c => c.name === "t3_thread_send")).toBe(false);
  expect(r.connections.every(c => c.closed)).toBe(true);
});

it("preserves unknown send/delegate outcomes without retry or transport error disclosure", async () => {
  for (const tool of ["t3_thread_send", "delegate_task"]) {
    const r = replay(name => { if (name === tool) throw new Error(`sensitive transport ${scopedEnv.T3_ACP_MCP_AUTHORIZATION} ${scopedEnv.T3_ACP_MCP_ENDPOINT}`); });
    const operation = tool === "t3_thread_send" ? r.host.send({ message: "hello", clientRequestId: "stable-send" }) : r.host.delegate({ task: "work", clientRequestId: "stable-delegate" });
    const error = await operation.catch(e => e as T3HostError);
    expect(error).toMatchObject({ stage: "unknown" });
    expect(String(error)).not.toContain("fixture-only");
    expect(String(error)).not.toContain("4321");
    expect(r.calls.filter(c => c.name === tool)).toHaveLength(1);
    expect(r.connections.every(c => c.closed)).toBe(true);
  }
});

it("rejects error/mismatched effect receipts and validates task ownership before child send", async () => {
  for (const response of [{ ...envelope({}), isError: true }, envelope({ threadId: "wrong", messageId: "m", runId: "r", delivery: "queued", status: "queued" })]) {
    const r = replay(name => name === "t3_thread_send" ? response : undefined);
    await expect(r.host.send({ message: "hello", clientRequestId: "effect-id" })).rejects.toMatchObject({ stage: "unknown" });
  }
  const r = replay(name => name === "task_status" ? envelope({ ...task(), taskId: "foreign" }) : undefined);
  await expect(r.host.status("task-1")).rejects.toMatchObject({ stage: "refused" });
  await expect(r.host.send({ taskId: "task-1", message: "hello", clientRequestId: "follow-up" })).rejects.toMatchObject({ stage: "refused" });
  expect(r.calls.some(c => c.name === "t3_thread_send")).toBe(false);
});

it("keeps T3 task handles, custom model options, descendants, questions and cancellation separate", async () => {
  const r = replay();
  const created = await r.host.delegate({ task: "bounded package", clientRequestId: "round-1", target: { providerInstanceId: "custom-provider", model: "custom-model", options: [{ id: "effort", value: "high" }] } });
  expect(created).toMatchObject({ ownership: "t3", task: task() });
  expect(r.calls.find(c => c.name === "delegate_task")?.args).toMatchObject({ mode: "async", isolation: "worktree", clientRequestId: "round-1" });
  expect(r.calls.find(c => c.name === "delegate_task")?.args).not.toHaveProperty("runtimeMode");
  expect(await r.host.status("task-1")).toMatchObject({ ownership: "t3", task: { workState: "waiting_for_children", hasPendingQuestion: true, hasPendingChildRuns: true, summary: "Original published result", latestTerminalStatus: "failed" } });
  expect(await r.host.cancel("task-1", "cancel-1", "requested")).toMatchObject({ ownership: "t3", receipt: { taskId: "task-1", status: "completed" } });
  await r.host.send({ taskId: "task-1", message: "follow-up", clientRequestId: "follow-up-1", mode: "steer" });
  expect(r.calls.findLast(c => c.name === "t3_thread_send")?.args).toMatchObject({ threadId: "child-thread", mode: "steer" });
  expect(r.calls.every(c => T3_TOOL_NAMES.includes(c.name as typeof T3_TOOL_NAMES[number]))).toBe(true);
});

it("refuses missing features, unavailable models and unknown options before delegation", async () => {
  const r = replay();
  for (const target of [ { providerInstanceId: "native-list-only", model: "custom-model" }, { providerInstanceId: "custom-provider", model: "not-in-composer" },
    { providerInstanceId: "custom-provider", model: "custom-model", options: [{ id: "effort", value: "invented" }] } ]) {
    await expect(r.host.delegate({ task: "work", clientRequestId: "round-invalid", target })).rejects.toMatchObject({ stage: "refused" });
  }
  const unavailable = replay(name => name === "orchestrator_capabilities" ? envelope({ ...caps(), features: { ...caps().features, appOwnedSubagents: false, cancellation: false, threadManagement: false } }) : undefined);
  await expect(unavailable.host.delegate({ task: "work", clientRequestId: "no-feature" })).rejects.toMatchObject({ stage: "refused" });
  await expect(unavailable.host.cancel("task-1", "cancel-1")).rejects.toMatchObject({ stage: "refused" });
  await expect(unavailable.host.send({ message: "hello", clientRequestId: "send-1" })).rejects.toMatchObject({ stage: "refused" });
  expect([...r.calls, ...unavailable.calls].some(c => ["delegate_task", "task_cancel", "t3_thread_send"].includes(c.name))).toBe(false);
});

it("bounds hung requests, closes late transports, and aborts shutdown without cancelling app tasks", async () => {
  vi.useFakeTimers();
  const closed = vi.fn(async () => {});
  let finish!: (connection: Awaited<ReturnType<T3Connect>>) => void;
  const host = new T3Host(transport(), async () => new Promise(resolve => { finish = resolve; }));
  const pending = host.capabilities().catch(error => error as T3HostError);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await pending).toMatchObject({ stage: "refused" });
  finish({ listTools: async () => ({ tools: [] }), callTool: async () => ({}), close: closed });
  await Promise.resolve(); await Promise.resolve();
  expect(closed).toHaveBeenCalledOnce();
  await host.close();
  await expect(host.capabilities()).rejects.toMatchObject({ stage: "unavailable" });
});

it("uses SDK HTTP negotiation with env auth, rejects redirects and never opens a notification watcher", async () => {
  const http: { method: string; redirect: RequestRedirect | undefined; authorization: string | null }[] = [];
  let redirected = false;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    http.push({ method: init?.method ?? "GET", redirect: init?.redirect, authorization: new Headers(init?.headers).get("authorization") });
    if (redirected) throw new Error("redirect with sensitive fixture-only response");
    const request = JSON.parse(String(init?.body));
    if (request.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (request.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture-t3", version: "fixture" } };
    else if (request.method === "tools/list") result = { tools: T3_TOOL_NAMES.map(name => ({ name, inputSchema: { type: "object" } })) };
    else if (request.params.name === "orchestrator_capabilities") result = envelope(caps());
    else if (request.params.name === "t3_thread_list") result = envelope({ currentThreadId: "t3-parent", projectId: "project" });
    else throw new Error("Unexpected HTTP operation");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "content-type": "application/json" } });
  });
  const host = new T3Host(transport());
  expect((await host.capabilities()).binding.threadId).toBe("t3-parent");
  expect(http.length).toBeGreaterThan(3);
  expect(http.every(r => r.method === "POST" && r.redirect === "error" && r.authorization === scopedEnv.T3_ACP_MCP_AUTHORIZATION)).toBe(true);
  redirected = true;
  await expect(host.capabilities()).rejects.toMatchObject({ stage: "refused" });
  expect(fetch).toHaveBeenCalled();
  await host.close();
});

it("honors caller cancellation before effects and reports unknown after an in-flight send is aborted", async () => {
  const controller = new AbortController(); controller.abort();
  const r = replay();
  await expect(r.host.send({ message: "cancelled", clientRequestId: "cancelled-1" }, controller.signal)).rejects.toMatchObject({ stage: "unavailable" });
  expect(r.calls).toEqual([]);
  let entered!: () => void;
  const sent = new Promise<void>(resolve => { entered = resolve; });
  const sending = replay(name => { if (name === "t3_thread_send") { entered(); return new Promise(() => {}); } });
  const active = new AbortController();
  const result = sending.host.send({ message: "in flight", clientRequestId: "cancelled-2" }, active.signal).catch(error => error as T3HostError);
  await sent; active.abort();
  expect(await result).toMatchObject({ stage: "unknown" });
  expect(sending.connections.every(c => c.closed)).toBe(true);
  expect(sending.calls.filter(c => c.name === "t3_thread_send")).toHaveLength(1);
  expect(sending.calls.some(c => c.name === "task_cancel")).toBe(false);
});

const mail = (id: string, overrides: Partial<BridgeMessage> = {}): BridgeMessage => ({ id, from: { id: "peer", name: "peer", agent: "claude" }, to: "receiver", recipient: "receiver", conversationId: "conversation", replyTo: null, hop: 1, body: "private mail body", createdAt: 1, readAt: null, ...overrides });
function wakeFixture(messages: BridgeMessage[]) {
  const cfg = { maxHops: 5, wakeOnDirect: true } as ReturnType<typeof loadConfig>;
  const node = Object.assign(new EventEmitter(), { name: "receiver", id: "receiver-id", autoWakeEnabled: false, isConnected: true, wasReplaced: false,
    unread: () => messages, isAwaitedReply: () => false, isNotificationAwaited: () => false, markRead: vi.fn(), get: (id: string) => messages.find(m => m.id === id) }) as unknown as BridgeNode;
  return { node, cfg };
}

it.each(["accepted", "unknown"])("does not re-batch an %s wake across reload with partial reads and new mail", async outcome => {
  const env = makeEnv(), messages = [mail("old-a"), mail("old-b")], { node, cfg } = wakeFixture(messages);
  const r = replay(name => { if (name === "t3_thread_send" && outcome === "unknown") throw new Error("lost receipt"); });
  await r.host.capabilities();
  const create = () => new T3Waker(r.host, node, cfg, nullLogger, 10, env.home);
  let waker = create();
  try {
    await waker.flush(); waker.stop();
    const file = new T3WakeJournal(env.home, r.host.binding).file;
    const original = JSON.parse(readFileSync(file, "utf8")).operations[0];
    expect(original).toMatchObject({ state: outcome, messageIds: ["old-a", "old-b"] });
    messages.shift(); messages.push(mail("new-c"));
    waker = create(); await waker.flush();
    const sends = r.calls.filter(c => c.name === "t3_thread_send");
    expect(sends).toHaveLength(2);
    expect(sends[1]?.args.message).toContain("new-c");
    expect(sends[1]?.args.message).not.toContain("old-b");
    expect(JSON.parse(readFileSync(file, "utf8")).operations[0]).toEqual(original);
    expect(node.markRead).not.toHaveBeenCalled();
  } finally { waker.stop(); await env.cleanup(); }
});

it("does not implicitly acknowledge child completion during send success or failure", async () => {
  let failSend = false;
  const r = replay(name => { if (name === "t3_thread_send" && failSend) throw new Error("lost receipt"); });
  await r.host.capabilities();
  await expect(r.host.send({ taskId: "task-1", message: "follow-up", clientRequestId: "unknown-child" })).rejects.toThrow(/explicit.*t3_task_status/i);
  expect(r.calls.some(c => c.name === "task_status")).toBe(false);
  expect((await r.host.status("task-1")).task.summary).toBe("Original published result");
  await r.host.send({ taskId: "task-1", message: "follow-up", clientRequestId: "known-child" });
  failSend = true;
  await expect(r.host.send({ taskId: "task-1", message: "later follow-up", clientRequestId: "lost-child-send" })).rejects.toMatchObject({ stage: "unknown" });
  expect(r.calls.filter(c => c.name === "task_status")).toHaveLength(1);
});

it("strips scoped T3 context from shared daemon environments without removing discovery settings", () => {
  for (const [key, value] of Object.entries({ ...scopedEnv, t3_acp_mcp_entrypoint: "fixture-entry", T3_ACP_MCP_NODE: "fixture-node", CODEX_HOME: "fixture-discovery" })) vi.stubEnv(key, value);
  const result = daemonEnvironment({ cli: "fixture", home: "fixture-home", pipe: "fixture-pipe", cwd: "fixture-cwd" });
  expect(Object.keys(result).filter(key => key.toUpperCase() === "AGENT_BRIDGE_HOST" || key.toUpperCase().startsWith("T3_ACP_MCP_"))).toEqual([]);
  expect(result.CODEX_HOME).toBe("fixture-discovery");
  expect(result.AGENT_BRIDGE_HOME).toBe("fixture-home");
  expect(result.AGENT_BRIDGE_PIPE).toBe("fixture-pipe");
});

it.each(["linux", "win32"] as const)("strips T3 grants at the actual mocked %s daemon launch boundary", async platform => {
  const env = makeEnv();
  try {
    for (const [key, value] of Object.entries(scopedEnv)) vi.stubEnv(key, value);
    if (platform === "win32") {
      // Make helper discovery hermetic on Linux/macOS too; spawn below is always mocked.
      vi.stubEnv("SystemRoot", env.home);
      const helper = join(env.home, "System32", "WindowsPowerShell", "v1.0");
      mkdirSync(helper, { recursive: true }); writeFileSync(join(helper, "powershell.exe"), "mock helper, never executed");
    }
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), unref: vi.fn(), kill: vi.fn() });
    let input = "";
    child.stdin.setEncoding("utf8").on("data", chunk => { input += chunk; });
    const spawned = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      queueMicrotask(() => {
        if (platform === "win32") { child.stdout.write('{"code":0,"pid":1234}'); child.emit("close", 0); }
        else child.emit("spawn");
      });
      return child as unknown as childProcess.ChildProcess;
    });
    expect(await launchDaemon({ cli: process.execPath, home: env.home, pipe: env.pipe, cwd: env.home })).toEqual({ kind: "created" });
    const launchEnv = spawned.mock.calls[0]?.[2]?.env;
    expect(launchEnv).toBeDefined();
    expect(Object.keys(launchEnv!).filter(key => key.toUpperCase() === "AGENT_BRIDGE_HOST" || key.toUpperCase().startsWith("T3_ACP_MCP_"))).toEqual([]);
    if (platform === "win32") expect(JSON.parse(input).environment.some((entry: string) => /^(AGENT_BRIDGE_HOST|T3_ACP_MCP_)/i.test(entry))).toBe(false);
  } finally { vi.restoreAllMocks(); await env.cleanup(); }
});

it("refuses dispatch if the immutable wake operation cannot be retained", async () => {
  const env = makeEnv(), r = replay(), { node, cfg } = wakeFixture([mail("persist-first")]);
  await r.host.capabilities();
  const warn = vi.fn(), log = { ...nullLogger, warn };
  const write = vi.spyOn(jsonStore, "writeJsonStore").mockImplementationOnce(() => { throw new Error("fixture-only write failure"); });
  const waker = new T3Waker(r.host, node, cfg, log, 10, env.home);
  try {
    await waker.flush(); await waker.flush();
    expect(write).toHaveBeenCalledOnce();
    expect(r.calls.some(c => c.name === "t3_thread_send")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("journal blocked"), { reason: "unavailable" });
  } finally { waker.stop(); await env.cleanup(); }
});

it.each(["corrupt", "future-contract", "future-json", "wrong-binding"])("preserves an %s journal and refuses all dispatch", async kind => {
  const env = makeEnv(), r = replay(), { node, cfg } = wakeFixture([mail("persisted-a"), mail("new-b")]);
  await r.host.capabilities();
  const journal = new T3WakeJournal(env.home, r.host.binding);
  journal.admit(["persisted-a"]);
  const previous = JSON.parse(readFileSync(journal.file, "utf8"));
  if (kind === "future-contract") previous.contractVersion++;
  if (kind === "future-json") previous.version++;
  if (kind === "wrong-binding") previous.binding.threadId = "other-thread";
  const raw = kind === "corrupt" ? '{"partial":' : JSON.stringify(previous);
  writeFileSync(journal.file, raw);
  const warn = vi.fn(), waker = new T3Waker(r.host, node, cfg, { ...nullLogger, warn }, 10, env.home);
  try {
    await waker.flush();
    expect(r.calls.some(c => c.name === "t3_thread_send")).toBe(false);
    expect(readFileSync(journal.file, "utf8")).toBe(raw);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("journal blocked"), { reason: "invalid" });
  } finally { waker.stop(); await env.cleanup(); }
});

it("retains submitted uncertainty after outcome-persistence failure and never resends after restart", async () => {
  const env = makeEnv(), r = replay(), { node, cfg } = wakeFixture([mail("accepted-a")]);
  await r.host.capabilities();
  const realWrite = jsonStore.writeJsonStore;
  let writes = 0;
  const write = vi.spyOn(jsonStore, "writeJsonStore").mockImplementation((...args) => { if (++writes === 2) throw new Error("lost outcome write"); return realWrite(...args); });
  let waker = new T3Waker(r.host, node, cfg, nullLogger, 10, env.home);
  try {
    await waker.flush(); waker.stop(); write.mockRestore();
    const journal = new T3WakeJournal(env.home, r.host.binding), raw = readFileSync(journal.file, "utf8");
    expect(JSON.parse(raw).operations[0].state).toBe("submitted");
    waker = new T3Waker(r.host, node, cfg, nullLogger, 10, env.home); await waker.flush();
    expect(r.calls.filter(c => c.name === "t3_thread_send")).toHaveLength(1);
    expect(readFileSync(journal.file, "utf8")).toBe(raw);
  } finally { waker.stop(); await env.cleanup(); }
});

it("admits a wake once across overlapping wakers and keeps different frontend journals separate", async () => {
  const env = makeEnv(), r = replay(), { node, cfg } = wakeFixture([mail("overlap-a")]);
  await r.host.capabilities();
  const one = new T3Waker(r.host, node, cfg, nullLogger, 10, env.home), two = new T3Waker(r.host, node, cfg, nullLogger, 10, env.home);
  try {
    await Promise.all([one.flush(), two.flush()]);
    expect(r.calls.filter(c => c.name === "t3_thread_send")).toHaveLength(1);
    const journal = new T3WakeJournal(env.home, r.host.binding), other = new T3WakeJournal(env.home, { ...r.host.binding, threadId: "other-thread" });
    expect(other.file).not.toBe(journal.file);
    expect(other.admit(["overlap-a"])).toBeDefined();
    const raw = readFileSync(journal.file, "utf8");
    expect(raw).not.toContain(scopedEnv.T3_ACP_MCP_AUTHORIZATION);
    expect(raw).not.toContain(scopedEnv.T3_ACP_MCP_ENDPOINT);
  } finally { one.stop(); two.stop(); await env.cleanup(); }
});

it("fails closed at journal capacity without deleting accepted or outstanding records", async () => {
  const env = makeEnv(), r = replay(); await r.host.capabilities();
  const journal = new T3WakeJournal(env.home, r.host.binding);
  for (let start = 0; start < T3_WAKE_MESSAGE_LIMIT; start += 100) journal.admit(Array.from({ length: 100 }, (_, index) => `retained-${start + index}`));
  const raw = readFileSync(journal.file, "utf8"), { node, cfg } = wakeFixture([mail("one-more")]);
  const warn = vi.fn(), waker = new T3Waker(r.host, node, cfg, { ...nullLogger, warn }, 10, env.home);
  try {
    await waker.flush();
    expect(r.calls.some(c => c.name === "t3_thread_send")).toBe(false);
    expect(readFileSync(journal.file, "utf8")).toBe(raw);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("journal blocked"), { reason: "full" });
  } finally { waker.stop(); await env.cleanup(); }
});

it("coalesces policy-eligible pointer wakes without consuming mail or retrying unknown sends", async () => {
  vi.useFakeTimers();
  const env = makeEnv();
  const messages = [mail("one"), mail("two"), mail("quiet", { conversationId: "conversation:note" }), mail("hop", { hop: 5 }), mail("kind", { to: "codex", recipient: "receiver" })];
  const { node, cfg } = wakeFixture(messages), r = replay();
  await r.host.capabilities();
  const waker = new T3Waker(r.host, node, cfg, nullLogger, 10, env.home);
  node.emit("message", messages[0]!); node.emit("message", messages[1]!);
  await vi.advanceTimersByTimeAsync(10);
  const sends = r.calls.filter(c => c.name === "t3_thread_send");
  expect(sends).toHaveLength(1);
  expect(sends[0]?.args).toMatchObject({ threadId: "t3-parent", mode: "queue" });
  expect(sends[0]?.args.message).toContain("one, two");
  expect(sends[0]?.args.message).not.toContain("private mail body");
  expect(node.markRead).not.toHaveBeenCalled();
  node.emit("notification_waits_changed"); await vi.advanceTimersByTimeAsync(100);
  expect(r.calls.filter(c => c.name === "t3_thread_send")).toHaveLength(1);
  waker.stop();

  const failed = replay(name => { if (name === "t3_thread_send") throw new Error("lost receipt"); });
  await failed.host.capabilities();
  messages.push(mail("three"));
  const other = new T3Waker(failed.host, node, cfg, nullLogger, 10, env.home);
  await other.flush(); await other.flush();
  expect(failed.calls.filter(c => c.name === "t3_thread_send")).toHaveLength(1);
  expect(node.markRead).not.toHaveBeenCalled();
  other.stop();
  await env.cleanup();
});

it("disables Claude channel consumption in host mode and respects disconnected/retired peers", async () => {
  const messages = [mail("one")], { node, cfg } = wakeFixture(messages), r = replay();
  await r.host.capabilities();
  const notify = vi.fn(async () => {});
  await channelPusher({ node, cfg, agent: "claude", t3Host: r.host, log: nullLogger } as ServerContext, () => true, notify)(messages[0]!);
  expect(notify).not.toHaveBeenCalled(); expect(node.markRead).not.toHaveBeenCalled();
  const waker = new T3Waker(r.host, node, cfg, nullLogger);
  Object.defineProperty(node, "wasReplaced", { value: true });
  await waker.flush();
  expect(r.calls.some(c => c.name === "t3_thread_send")).toBe(false);
  waker.stop();
});

it("registers explicit host tools only in opt-in sessions and preserves depth/native-child gates", async () => {
  const env = makeEnv(), r = replay();
  await r.host.capabilities();
  const node = env.node("fixture-host", "claude");
  const cfg = loadConfig(env.home, "claude", nullLogger, {});
  const mcp = new McpServer({ name: "fixture-bridge", version: "1" }), client = new Client({ name: "fixture-host", version: "1" });
  const ctx: ServerContext = { agent: "claude", node, cfg, log: nullLogger, home: env.home, cwd: () => env.home, channelActive: () => false, t3Host: r.host };
  registerTools(mcp, ctx, []);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(serverTransport); await client.connect(clientTransport);
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(expect.arrayContaining(["t3_capabilities", "t3_delegate", "t3_task_status", "t3_task_cancel", "t3_send"]));
    const hook = await client.callTool({ name: "hook_event", arguments: { event: "UserPromptSubmit", session_id: "native-id" } });
    expect(hook.content).toEqual([{ type: "text", text: "{}" }]);
    expect(node.currentSessionId).toBeNull();
    vi.stubEnv("AGENT_BRIDGE_DELEGATE_DEPTH", String(cfg.maxDelegateDepth));
    const depth = await client.callTool({ name: "t3_delegate", arguments: { task: "work", clientRequestId: "depth-1" } });
    expect(depth.isError).toBe(true);
    vi.stubEnv("AGENT_BRIDGE_DELEGATE_DEPTH", "0");
    ctx.admitCodex = () => false;
    expect((await client.callTool({ name: "t3_send", arguments: { message: "hello", clientRequestId: "child-1" } })).isError).toBe(true);
    expect(r.calls.some(c => ["delegate_task", "t3_thread_send"].includes(c.name))).toBe(false);
  } finally { await client.close(); await mcp.close(); await env.cleanup(); }
});

it("registers ordinary provider tools without the T3 surface when host mode is absent", async () => {
  const env = makeEnv(), node = env.node("fixture-plain", "claude");
  const mcp = new McpServer({ name: "fixture-bridge", version: "1" }), client = new Client({ name: "fixture-host", version: "1" });
  registerTools(mcp, { agent: "claude", node, cfg: loadConfig(env.home, "claude", nullLogger, {}), log: nullLogger, home: env.home, cwd: () => env.home, channelActive: () => false }, ["codex"]);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await mcp.connect(serverTransport); await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toEqual(expect.arrayContaining(["send", "inbox", "spawn_codex", "hook_event"]));
    expect(names.some(name => name.startsWith("t3_"))).toBe(false);
  } finally { await client.close(); await mcp.close(); await env.cleanup(); }
});

it("registers two same-process T3 threads without recovering or replacing the other's provider identity", async () => {
  const env = makeEnv(), nodes: BridgeNode[] = [];
  const create = (threadId: string) => {
    const node = new BridgeNode({ pipePath: env.pipe, token: "fixture-token", dbPath: env.db, agent: "codex", name: "codex-project", cwd: env.home,
      autoWake: false, log: nullLogger, frontend: binding(threadId) });
    nodes.push(node); return node;
  };
  try {
    const one = create("thread-a"); await one.start(); await one.setSessionId("native-provider-a");
    const two = create("thread-b"); await two.start();
    expect(one.wasReplaced).toBe(false);
    expect(two.currentSessionId).toBeNull();
    expect(two.name).not.toBe(one.name);
    await two.setSessionId("native-provider-a"); // Even a reused native ID must not cross the frontend fence.
    expect(one.wasReplaced).toBe(false);
    const peers = await one.peers();
    expect(peers.filter(p => p.frontend).map(p => p.frontend?.threadId).sort()).toEqual(["thread-a", "thread-b"]);
    expect(peers.every(p => p.agent === "codex" && p.sessionId === "native-provider-a")).toBe(true);
    const replacement = create("thread-b"); await replacement.setSessionId("native-provider-b-restarted"); await replacement.start();
    expect(two.wasReplaced).toBe(true);
    expect(one.wasReplaced).toBe(false);
    expect(replacement.currentSessionId).toBe("native-provider-b-restarted");
    expect((await one.peers()).filter(p => p.frontend).map(p => p.frontend?.threadId).sort()).toEqual(["thread-a", "thread-b"]);
  } finally { await Promise.all(nodes.map(n => n.stop())); await env.cleanup(); }
});
