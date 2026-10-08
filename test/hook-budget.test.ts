import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { HOOK_BUDGET_MS } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { JobManager } from "../src/mcp/jobs.js";
import { MessageWaitStore } from "../src/mcp/message-wait.js";
import { registerTools, type ServerContext } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const input = { event: "PostToolUse" as const, sessionId: null, stopHookActive: false };
const context = (node: any, extra: Partial<ServerContext> = {}): ServerContext => ({ agent: "codex", cfg: DEFAULT_CONFIG, node, log: nullLogger, home: env.home, cwd: () => env.home, channelActive: () => false, ...extra });
it.each(["metadata", "connect", "refresh"])("bounds slow %s work and retains late mail for the next hook", async phase => {
  const node = env.node("bounded", "codex"), peer = env.node("sender", "opencode");
  await node.start(); await peer.start();
  await peer.send({ to: node.name, body: "RETAIN_LATE_MAIL" });
  await until(() => node.unread().length === 1);
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const prepare = phase === "metadata" ? () => slow : undefined;
  const spy = phase === "metadata" ? undefined : vi.spyOn(node, phase === "connect" ? "ensureConnected" : "refreshPending").mockImplementationOnce(() => slow);
  const timers = vi.spyOn(globalThis, "setTimeout");
  expect(await buildHookResponse(context(node), { ...input, prepare })).toEqual({});
  expect(timers.mock.calls.some(([, delay]) => delay === HOOK_BUDGET_MS)).toBe(true);
  timers.mockRestore();
  release(); await new Promise(resolve => setTimeout(resolve, 20));
  expect(node.unread()).toHaveLength(1);
  spy?.mockRestore();
  expect(JSON.stringify(await buildHookResponse(context(node), input))).toContain("RETAIN_LATE_MAIL");
  expect(node.unread()).toHaveLength(0);
});
it("Stop immediately arms one notify wait for running jobs, with no polling", async () => {
  const node = env.node("owner", "codex"); await node.start();
  const jobs = new JobManager(node, nullLogger);
  vi.spyOn(jobs, "runningCount").mockReturnValue(1);
  const wait = vi.spyOn(node, "waitForMessage");
  expect(await buildHookResponse(context(node, { jobs }), { ...input, event: "Stop" })).toEqual({});
  expect(wait).not.toHaveBeenCalled();
  expect(new MessageWaitStore(env.home).pending(node)).toMatchObject([{ mode: "notify" }]);
  await buildHookResponse(context(node, { jobs }), { ...input, event: "Stop" });
  expect(new MessageWaitStore(env.home).pending(node)).toHaveLength(1);
});
it("retains a late parent inbox response and delivers it on the next hook", async () => {
  let release!: (value: any[]) => void;
  const inbox = vi.fn(() => new Promise<any[]>(resolve => { release = resolve; }));
  const ctx = context(null, { parent: { name: "parent", inbox } as any });
  expect(await buildHookResponse(ctx, input)).toEqual({});
  release([{ id: "parent-mail", body: "LATE_PARENT", sentAt: Date.now() }]);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(JSON.stringify(await buildHookResponse(ctx, input))).toContain("LATE_PARENT");
  expect(inbox).toHaveBeenCalledTimes(1);
});

it.each(["running child", "buffered final"])("Stop does not wait for a stalled replay with a %s", async mode => {
  const node = env.node("owner", "codex"); await node.start();
  const jobs = new JobManager(node, nullLogger);
  vi.spyOn(jobs, "runningCount").mockReturnValue(mode === "running child" ? 1 : 0);
  if (mode === "buffered final") node.deliverLocal({ id: "buffered-final", recipient: node.name, to: node.name,
    from: { id: "job:complete", name: "codex-job-complete", agent: "codex" }, body: "BUFFERED_FINAL",
    conversationId: "job-complete", replyTo: null, hop: 0, createdAt: Date.now(), readAt: null });
  let release!: () => void;
  const replay = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(node, "refreshPending").mockReturnValueOnce(replay);
  const wait = vi.spyOn(node, "waitForMessage");
  try {
    const result = await buildHookResponse(context(node, { jobs }), { ...input, event: "Stop" });
    expect(wait).not.toHaveBeenCalled();
    if (mode === "running child") {
      expect(result).toEqual({});
      expect(new MessageWaitStore(env.home).pending(node)).toMatchObject([{ mode: "notify" }]);
    } else {
      expect(result).toMatchObject({ decision: "block" });
      expect(JSON.stringify(result)).toContain("BUFFERED_FINAL");
      expect(node.unread()).toHaveLength(0);
    }
  } finally { release(); }
});

it("bounds metadata at the registered MCP hook entry", async () => {
  const callbacks = new Map<string, (...args: any[]) => Promise<any>>();
  const server = { registerTool: (name: string, _config: unknown, callback: any) => callbacks.set(name, callback) };
  const ctx = context(null, { observeMeta: () => new Promise<void>(() => {}) });
  registerTools(server as any, ctx, []);
  const timers = vi.spyOn(globalThis, "setTimeout");
  const response = await callbacks.get("hook_event")!({ event: "Stop" }, { signal: new AbortController().signal, _meta: {} });
  expect(timers.mock.calls.some(([, delay]) => delay === HOOK_BUDGET_MS)).toBe(true);
  timers.mockRestore();
  expect(response.content[0].text).toBe("{}");
});
