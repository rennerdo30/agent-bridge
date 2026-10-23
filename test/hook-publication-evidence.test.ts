import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { HOOK_BUDGET_MS } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { registerTools, type ServerContext } from "../src/mcp/server.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await env?.cleanup(); });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  env = makeEnv();
  const callbacks = new Map<string, (...args: any[]) => Promise<any>>();
  const warn = vi.fn(), node = { currentSessionId: null as string | null, name: "observer", id: "observer-id", wasReplaced: false, isConnected: true,
    async setSessionId(id: string) { this.currentSessionId = id; }, setNotificationWaitHandlers: vi.fn(), on: vi.fn(),
    ensureConnected: vi.fn(async () => {}), refreshPending: vi.fn(async () => {}), unread: () => [] };
  const ctx = { agent: "claude", cfg: DEFAULT_CONFIG, node, log: { ...nullLogger, warn }, home: env.home, cwd: () => env.home, channelActive: () => true } as unknown as ServerContext;
  registerTools({ registerTool: (name: string, _config: unknown, callback: any) => callbacks.set(name, callback) } as any, ctx, []);
  const hook = (signal = new AbortController().signal) => callbacks.get("hook_event")!({ event: "SessionStart", session_id: "original-private-session" }, { signal, _meta: {} });
  return { ctx, node, warn, hook };
}
it.each(["prepare", "launch-inspection", "session-update"])("records the exact incomplete SessionStart stage at the real registered hook boundary: %s", async stage => {
  vi.useFakeTimers(); const f = fixture(), gate = deferred();
  if (stage === "prepare") f.ctx.observeMeta = () => gate.promise;
  if (stage === "launch-inspection") f.ctx.launchKnown = gate.promise;
  if (stage === "session-update") vi.spyOn(f.node, "setSessionId").mockImplementation(async id => { await gate.promise; f.node.currentSessionId = id; });
  const pending = f.hook();
  await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS);
  const result = await pending;
  expect(result).toMatchObject({ content: [{ text: "{}" }] }); expect(result.isError).not.toBe(true);
  expect(f.node.currentSessionId).toBeNull(); expect(f.node.refreshPending).not.toHaveBeenCalled();
  expect(f.warn).toHaveBeenCalledWith("hook publication incomplete", expect.objectContaining({ event: "SessionStart", stage, reason: "deadline", sessionUpdate: stage === "session-update" ? "pending" : "not-started", localSession: "missing", connected: true }));
  expect(JSON.stringify(f.warn.mock.calls)).not.toContain("original-private-session");
  gate.resolve(); await vi.advanceTimersByTimeAsync(0); // Settle original work, never a detached replacement/retry.
  expect(f.node.refreshPending).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it("distinguishes a failed identity write from a headless return without substituting a session", async () => {
  const f = fixture(); vi.spyOn(f.node, "setSessionId").mockRejectedValue(new Error("private error must not reach diagnostic"));
  f.node.refreshPending.mockImplementation(async () => { throw new Error("stop after identity stage"); });
  await f.hook();
  expect(f.warn).toHaveBeenCalledWith("hook publication incomplete", expect.objectContaining({ sessionUpdate: "failed", localSession: "missing" }));
  expect(JSON.stringify(f.warn.mock.calls)).not.toContain("private error");
  f.warn.mockClear(); f.ctx.headless = true;
  await f.hook();
  expect(f.warn).toHaveBeenCalledWith("hook publication incomplete", expect.objectContaining({ stage: "launch-inspection", reason: "headless", sessionUpdate: "not-started" }));
});
it.each([-86_400_000, 86_400_000])("does not attribute a wall-clock step of %s to incomplete hook work", async step => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const f = fixture(), gate = deferred(); f.ctx.launchKnown = gate.promise;
  const originalWall = Date.now(); vi.spyOn(Date, "now").mockReturnValue(originalWall);
  const pending = f.hook(); await vi.advanceTimersByTimeAsync(0);
  vi.mocked(Date.now).mockReturnValue(originalWall + step);
  await vi.advanceTimersByTimeAsync(HOOK_BUDGET_MS); await pending;
  expect(f.warn).toHaveBeenCalledWith("hook publication incomplete", expect.objectContaining({ stage: "launch-inspection", reason: "deadline", elapsedMs: HOOK_BUDGET_MS }));
  expect(f.node.currentSessionId).toBeNull(); gate.resolve(); await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0);
});
