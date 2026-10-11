import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { HOOK_BUDGET_MS } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import { CodexWaker } from "../src/mcp/codex-wake.js";
import { buildHookResponse, type HookInput } from "../src/mcp/hooks.js";
import type { ServerContext } from "../src/mcp/server.js";

const queue = vi.hoisted(() => vi.fn());
vi.mock("../src/core/delegate.js", async (original) => ({
  ...await original<typeof import("../src/core/delegate.js")>(), runProcess: queue,
}));
vi.mock("../src/mcp/message-wait.js", async (original) => ({
  ...await original<typeof import("../src/mcp/message-wait.js")>(),
  MessageWaitStore: class { pending() { return []; } },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const hook = (event: HookInput["event"], extra: Partial<HookInput> = {}): HookInput => ({
  event, sessionId: "main-thread", stopHookActive: false, ...extra,
});

// Real hook and waker; only broker/storage and the CLI queue transport are doubles.
// No database, installed CLI, or live session is used by this fixture.
function fixture() {
  const node = Object.assign(new EventEmitter(), {
    name: "codex-main", id: "main-id", cwd: process.cwd(), currentSessionId: "main-thread",
    activity: "busy" as "busy" | "idle", autoWakeEnabled: false, lastSentAt: 0,
    isConnected: false, mail: [] as BridgeMessage[],
    setSessionId: vi.fn(async (id: string | null) => { node.currentSessionId = id ?? ""; }),
    ensureConnected: vi.fn(async () => {}), refreshPending: vi.fn(async () => {}),
    decisions: vi.fn(async () => []),
    unread: () => node.mail,
    markRead: vi.fn((ids: string[]) => { node.mail = node.mail.filter((m) => !ids.includes(m.id)); }),
    isNotificationAwaited: () => false, isAwaitedReply: () => false,
  });
  const cfg = { ...DEFAULT_CONFIG, wakeOnDirect: true, lingerSec: 0 };
  const waker = new CodexWaker(node as unknown as BridgeNode, cfg, nullLogger, { debounceMs: 10, queueTimeoutMs: 100 });
  waker.setThreadId("main-thread");
  waker.setActivity("busy");
  const activity = vi.fn((state: "busy" | "idle") => { node.activity = state; waker.setActivity(state); });
  const ctx: ServerContext = {
    agent: "codex", cfg, node: node as unknown as BridgeNode, log: nullLogger,
    home: process.env.AGENT_BRIDGE_HOME!, cwd: () => node.cwd, channelActive: () => false,
    activity, onSessionId: vi.fn(),
    wakeDelivery: { confirm: vi.fn(), release: vi.fn(), active: vi.fn(), idle: vi.fn() } as ServerContext["wakeDelivery"],
  };
  const arrive = () => {
    const m: BridgeMessage = {
      id: "retained-mail", from: { id: "peer-id", name: "claude-peer", agent: "claude" },
      to: node.name, recipient: node.name, conversationId: "work", replyTo: null,
      hop: 0, body: "Handle this after the main turn", createdAt: Date.now(), readAt: null,
    };
    node.mail.push(m); node.emit("message", m);
  };
  return { node, ctx, activity, arrive };
}

beforeEach(() => { vi.useFakeTimers(); queue.mockReset().mockResolvedValue({ code: 0, stdout: "", stderr: "" }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("main hook activity ownership (AB-269)", () => {
  it.each(["prepare", "launchKnown", "setSessionId", "ensureConnected", "refreshPending"] as const)(
    "a Stop deadline in %s recovers idle and queues exactly once without consuming mail", async (stage) => {
      const { node, ctx, activity, arrive } = fixture();
      const held = deferred();
      const input = hook("Stop");
      if (stage === "prepare") input.prepare = () => held.promise;
      else if (stage === "launchKnown") ctx.launchKnown = held.promise;
      else node[stage].mockImplementationOnce(() => held.promise);
      // Buffered Stop mail intentionally skips replay. Arrive after replay starts to test its deadline.
      if (stage !== "refreshPending") arrive();
      const response = buildHookResponse(ctx, input);
      await vi.advanceTimersByTimeAsync(0);
      if (stage === "refreshPending") { expect(node.refreshPending).toHaveBeenCalledOnce(); arrive(); }
      await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS);
      expect(await response).toEqual({});
      expect(node.activity).toBe("idle");
      expect(activity).toHaveBeenCalledExactlyOnceWith("idle");
      expect(node.mail).toHaveLength(1);
      expect(node.markRead).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(queue).toHaveBeenCalledOnce();
      expect(queue.mock.calls[0]![0].args).toEqual(expect.arrayContaining(["queue", "--thread", "main-thread"]));
      held.resolve();
      await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS * 2);
      expect(queue).toHaveBeenCalledOnce();
      expect(node.mail).toHaveLength(1);
      expect(node.markRead).not.toHaveBeenCalled();
      expect(activity).toHaveBeenCalledOnce();
    },
  );

  it.each((["prepare", "launchKnown", "setSessionId", "ensureConnected", "refreshPending"] as const)
    .flatMap((stage) => [false, true].map((autoWake) => ({ stage, autoWake }))))(
    "a superseded ordinary Stop in $stage cannot idle or consume newer-turn mail (autoWake=$autoWake)", async ({ stage, autoWake }) => {
    const { node, ctx, arrive } = fixture();
    node.autoWakeEnabled = autoWake;
    const held = deferred();
    const input = hook("Stop");
    if (stage === "prepare") input.prepare = () => held.promise;
    else if (stage === "launchKnown") ctx.launchKnown = held.promise;
    else node[stage].mockImplementationOnce(() => held.promise);
    const old = buildHookResponse(ctx, input);
    await vi.advanceTimersByTimeAsync(0);
    if (stage === "launchKnown") ctx.launchKnown = Promise.resolve();
    await buildHookResponse(ctx, hook("UserPromptSubmit"));
    arrive();
    node.markRead.mockClear();
    held.resolve();
    expect(await old).toEqual({});
    await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS);
    expect(node.activity).toBe("busy");
    expect(node.mail).toHaveLength(1);
    expect(node.markRead).not.toHaveBeenCalled();
    expect(ctx.wakeDelivery!.idle).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });

  it.each([false, true])("a newer prompt owns activity at ingress, before its metadata completes (pending=%s)", async (pending) => {
    const { node, ctx, arrive } = fixture();
    const stopHeld = deferred(), promptHeld = deferred();
    const old = buildHookResponse(ctx, hook("Stop", { prepare: () => stopHeld.promise }));
    const prompt = buildHookResponse(ctx, hook("UserPromptSubmit", pending ? { prepare: () => promptHeld.promise } : {}));
    await vi.advanceTimersByTimeAsync(0);
    arrive();
    await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS + 10);
    expect(await old).toEqual({});
    expect(node.activity).toBe("busy");
    expect(node.mail).toHaveLength(1);
    expect(queue).not.toHaveBeenCalled();
    stopHeld.resolve(); promptHeld.resolve(); await prompt;
  });

  it.each(["UserPromptSubmit", "PostToolUse", "SessionStart"] as const)("an older delayed %s cannot overwrite a newer Stop", async (event) => {
    const { node, ctx, activity, arrive } = fixture();
    const held = deferred();
    const old = buildHookResponse(ctx, hook(event, { prepare: () => held.promise }));
    await buildHookResponse(ctx, hook("Stop"));
    arrive();
    activity.mockClear();
    held.resolve();
    expect(await old).toEqual({});
    expect(activity).not.toHaveBeenCalled();
    expect(node.activity).toBe("idle");
    expect(node.mail).toHaveLength(1);
    expect(node.markRead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(queue).toHaveBeenCalledOnce();
  });

  it.each(["Stop", "UserPromptSubmit", "PostToolUse", "SessionStart"] as const)("a flagged child %s cannot prepare, change session, consume mail or invalidate the owning Stop", async (event) => {
    const { node, ctx, activity, arrive } = fixture();
    const held = deferred(), prepare = vi.fn(async () => {});
    const main = buildHookResponse(ctx, hook("Stop", { prepare: () => held.promise }));
    arrive();
    expect(await buildHookResponse(ctx, hook(event, { subagent: true, sessionId: "child-thread", prepare }))).toEqual({});
    expect(prepare).not.toHaveBeenCalled();
    expect(node.setSessionId).not.toHaveBeenCalled();
    expect(ctx.onSessionId).not.toHaveBeenCalled();
    expect(node.currentSessionId).toBe("main-thread");
    expect(node.activity).toBe("busy");
    expect(activity).not.toHaveBeenCalled();
    expect(node.markRead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS + 10);
    expect(await main).toEqual({});
    expect(node.activity).toBe("idle");
    expect(queue).toHaveBeenCalledOnce();
    expect(node.mail).toHaveLength(1);
    held.resolve();
  });

  it("normal busy activity blocks queued wake until the current Stop", async () => {
    const { node, ctx, arrive } = fixture();
    await buildHookResponse(ctx, hook("UserPromptSubmit"));
    arrive();
    await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS * 2);
    expect(node.activity).toBe("busy"); expect(queue).not.toHaveBeenCalled();
    expect(node.mail).toHaveLength(1);
    await buildHookResponse(ctx, hook("Stop"));
    await vi.advanceTimersByTimeAsync(10);
    expect(queue).toHaveBeenCalledOnce(); expect(node.mail).toHaveLength(1);
  });

  it("a current Stop that delivers mail and blocks remains busy", async () => {
    const { node, ctx, arrive } = fixture(); node.autoWakeEnabled = true;
    arrive();
    expect(await buildHookResponse(ctx, hook("Stop"))).toMatchObject({ decision: "block" });
    await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS * 2);
    expect(node.activity).toBe("busy"); expect(node.mail).toHaveLength(0);
    expect(node.markRead).toHaveBeenCalledExactlyOnceWith(["retained-mail"]);
    expect(queue).not.toHaveBeenCalled();
  });

  it.each(["UserPromptSubmit", "PostToolUse"] as const)("%s reserves busy at ingress while its metadata stalls", async (event) => {
    const { node, ctx, arrive } = fixture(), held = deferred();
    await buildHookResponse(ctx, hook("Stop"));
    expect(node.activity).toBe("idle");
    const active = buildHookResponse(ctx, hook(event, { prepare: () => held.promise }));
    arrive();
    await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS + 10);
    expect(await active).toEqual({});
    expect(node.activity).toBe("busy"); expect(queue).not.toHaveBeenCalled();
    expect(node.mail).toHaveLength(1); held.resolve();
  });

  it("host cancellation retains busy and mail without interpreting it as a deadline", async () => {
    const { node, ctx, arrive } = fixture();
    const held = deferred(), cancel = new AbortController();
    const response = buildHookResponse(ctx, hook("Stop", { signal: cancel.signal, prepare: () => held.promise }));
    arrive(); cancel.abort();
    expect(await response).toEqual({});
    await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS * 2);
    expect(node.activity).toBe("busy"); expect(node.mail).toHaveLength(1);
    expect(queue).not.toHaveBeenCalled(); held.resolve();
  });

  it("a Stop for a replaced session does not idle its successor", async () => {
    const { node, ctx, arrive } = fixture();
    const held = deferred();
    const response = buildHookResponse(ctx, hook("Stop", { prepare: () => held.promise }));
    node.currentSessionId = "replacement-thread";
    arrive();
    await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS + 10);
    expect(await response).toEqual({});
    expect(node.activity).toBe("busy"); expect(queue).not.toHaveBeenCalled();
    held.resolve();
  });

  it("hook epochs are isolated per context", async () => {
    const first = fixture(), second = fixture(), held = deferred();
    const response = buildHookResponse(first.ctx, hook("Stop", { prepare: () => held.promise }));
    await buildHookResponse(second.ctx, hook("UserPromptSubmit"));
    first.arrive();
    await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS + 10);
    expect(await response).toEqual({});
    expect(first.node.activity).toBe("idle"); expect(second.node.activity).toBe("busy");
    expect(queue).toHaveBeenCalledOnce(); held.resolve();
  });

  it.each(["claude", "opencode", "antigravity"] as const)("%s deadline behavior stays unchanged", async (agent) => {
    const { node, ctx, arrive } = fixture(), held = deferred(); ctx.agent = agent;
    const response = buildHookResponse(ctx, hook("Stop", { prepare: () => held.promise }));
    arrive(); await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS + 10);
    expect(await response).toEqual({}); expect(node.activity).toBe("busy");
    expect(queue).not.toHaveBeenCalled(); expect(node.mail).toHaveLength(1); held.resolve();
  });
});
