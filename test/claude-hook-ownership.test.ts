import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { reportModActivity } from "../src/mcp/hook-ownership.js";
import { RewakeEndpoint, sessionFile } from "../src/mcp/rewake.js";
import type { ServerContext } from "../src/mcp/server.js";

function fixture() {
  const mail = [{ id: "retained", conversationId: "work", from: { id: "peer", name: "peer", agent: "codex" }, to: "claude-main", recipient: "claude-main", hop: 0, body: "retained", createdAt: Date.now(), replyTo: null, readAt: null }];
  const node = Object.assign(new EventEmitter(), {
    currentSessionId: "session", name: "claude-main", id: "peer", autoWakeEnabled: false,
    setSessionId: vi.fn(async () => {}), ensureConnected: vi.fn(async () => {}), refreshPending: vi.fn(async () => {}),
    unread: () => mail, markRead: vi.fn(), lastSentAt: 0, isNotificationAwaited: () => false, isAwaitedReply: () => false,
  });
  const ctx = { agent: "claude", node, cfg: DEFAULT_CONFIG, log: nullLogger,
    home: process.env.AGENT_BRIDGE_HOME!, cwd: () => process.cwd(), channelActive: () => false,
    activity: vi.fn(), wakeDelivery: { idle: vi.fn(), active: vi.fn(), release: vi.fn(), confirm: vi.fn() },
  } as unknown as ServerContext;
  const hook = (event: "UserPromptSubmit" | "PostToolUse" | "Stop" | "StopFailure", promptId = "prompt") =>
    buildHookResponse(ctx, { event, promptId, sessionId: "session", stopHookActive: false });
  const mod = (busy: boolean, turnId: string, sequence: number, sessionId = "session") => reportModActivity(ctx, { busy, turnId, sequence, sessionId });
  return { ctx, node, hook, mod };
}

it("ignores hooks arriving after their completed prompt and accepts a new prompt", async () => {
  const { ctx, node, hook } = fixture();
  await hook("UserPromptSubmit"); await hook("Stop");
  vi.mocked(ctx.activity!).mockClear(); node.markRead.mockClear();
  await hook("PostToolUse");
  expect(ctx.activity).not.toHaveBeenCalled(); expect(node.markRead).not.toHaveBeenCalled();
  await hook("UserPromptSubmit", "next");
  expect(ctx.activity).toHaveBeenCalledWith("busy");
  node.markRead.mockClear(); await hook("Stop", "prompt");
  expect(node.markRead).not.toHaveBeenCalled();
});

it("StopFailure never confirms, consumes or blocks retained messages", async () => {
  const { ctx, node, hook } = fixture();
  await hook("UserPromptSubmit"); node.markRead.mockClear();
  vi.mocked(ctx.wakeDelivery!.confirm).mockClear();
  expect(await hook("StopFailure")).toEqual({});
  expect(ctx.activity).toHaveBeenLastCalledWith("idle");
  expect(ctx.wakeDelivery!.idle).toHaveBeenCalled(); expect(ctx.wakeDelivery!.confirm).not.toHaveBeenCalled();
  expect(node.markRead).not.toHaveBeenCalled(); expect(node.unread()).toHaveLength(1);
});

it("only matching main mod completion can idle; late tokens and other sessions cannot", () => {
  const { ctx, mod } = fixture();
  expect(mod(true, "old", 1)).toBe(true);
  expect(mod(true, "new", 3)).toBe(true);
  expect(mod(false, "old", 2)).toBe(false);
  expect(mod(false, "old", 4)).toBe(false);
  expect(mod(false, "new", 5, "other-session")).toBe(false);
  expect(mod(false, "new", 5)).toBe(true);
  expect(ctx.activity).toHaveBeenLastCalledWith("idle");
  expect(mod(true, "old", 1)).toBe(false);
});

it("a prompt supersedes an old mod completion while the next main turn can finish", async () => {
  const { ctx, hook, mod } = fixture();
  await hook("UserPromptSubmit"); mod(true, "old", 1);
  await hook("UserPromptSubmit", "next");
  expect(mod(false, "old", 2)).toBe(false);
  expect(ctx.activity).toHaveBeenLastCalledWith("busy");
  expect(mod(true, "next", 3)).toBe(true); expect(mod(false, "next", 4)).toBe(true);
});

it("rejects tokenless late PostToolUse after authoritative completion and binds a start preceding the next prompt", async () => {
  const { ctx, hook, mod } = fixture();
  await hook("UserPromptSubmit"); mod(true, "first", 1); mod(false, "first", 2);
  vi.mocked(ctx.activity!).mockClear();
  await buildHookResponse(ctx, { event: "PostToolUse", sessionId: "session", stopHookActive: false });
  expect(ctx.activity).not.toHaveBeenCalled();
  expect(mod(true, "next", 3)).toBe(true);
  await hook("UserPromptSubmit", "next");
  expect(mod(false, "next", 4)).toBe(true);
  expect(ctx.activity).toHaveBeenLastCalledWith("idle");
});

it("accepts a reloaded mod's sequence and retires prior instance events", () => {
  const { ctx } = fixture();
  const mod = (instance: string, busy: boolean, sequence: number) => reportModActivity(ctx, { sessionId: "session", turnId: instance, instance, busy, sequence });
  expect(mod("old", true, 100)).toBe(true);
  expect(mod("invalid", true, NaN)).toBe(false);
  expect(mod("old", false, 101)).toBe(true);
  expect(mod("new", true, 1)).toBe(true);
  expect(mod("old", true, 102)).toBe(false);
  expect(mod("old", false, 103)).toBe(false);
  expect(mod("new", false, 2)).toBe(true);
});

it("authenticated mod completion reaches idle with retained mail; confirmation toggles are not activity", async () => {
  const { ctx, node } = fixture();
  mkdirSync(ctx.home, { recursive: true });
  const endpoint = new RewakeEndpoint(ctx.home, node as any, () => true, nullLogger, event => reportModActivity(ctx, event));
  await endpoint.start(); endpoint.register("session");
  ctx.wakeDelivery!.active = () => endpoint.sessionActive(); ctx.wakeDelivery!.idle = () => endpoint.sessionIdle();
  const reg = JSON.parse(readFileSync(sessionFile(ctx.home, "session"), "utf8"));
  const call = (path: string) => fetch(`http://127.0.0.1:${reg.port}${path}`, { method: "POST", headers: { authorization: `Bearer ${reg.secret}` } });
  try {
    expect((await call("/activity?busy=1&session_id=session&turn_id=main&sequence=1")).status).toBe(204);
    await call("/mod?busy=1"); await call("/mod?busy=0");
    expect(ctx.activity).toHaveBeenLastCalledWith("busy");
    expect((await call("/activity?busy=0&session_id=session&turn_id=main&sequence=2")).status).toBe(204);
    expect(ctx.activity).toHaveBeenLastCalledWith("idle"); expect(node.unread()).toHaveLength(1);
    expect((await call("/activity?busy=1&session_id=session&turn_id=old&sequence=1")).status).toBe(409);
  } finally { await endpoint.stop(); }
});

it("the Claude mod ignores child starts and completes main turns without a Stop hook", async () => {
  vi.resetModules();
  const modulePath = "../plugins/claude/hooks/wake.ts";
  const { register } = await import(modulePath);
  const handlers = new Map<string, (...a: any[]) => Promise<unknown>>();
  register(((name: string, fn: any) => handlers.set(name, fn)) as any);
  const requests: string[] = [];
  const engine = { session: { id: async () => "session" }, env: { get: async () => "fixture" },
    clock: { sleep: async () => new Promise(() => {}) },
    fs: { read: async () => JSON.stringify({ port: 1, secret: "fixture" }) },
    http: { fetch: async (url: string) => { requests.push(url); return { ok: true, text: JSON.stringify({ superseded: true }) }; } },
  };
  const next = vi.fn(async (e: any) => e);
  await handlers.get("turn.start")!(engine, { turnId: "child", agentId: "child" }, next);
  await handlers.get("turn.start")!(engine, { turnId: "main" }, next);
  await handlers.get("turn.complete")!(engine, { turnId: "child", agentId: "child" }, next);
  await handlers.get("turn.complete")!(engine, { turnId: "main" }, next);
  expect(requests.filter(url => url.includes("/activity"))).toEqual([
    expect.stringContaining("busy=1&session_id=session&turn_id=main&sequence=1"),
    expect.stringContaining("busy=0&session_id=session&turn_id=main&sequence=2"),
  ]);
});

it("a stalled mod activity endpoint does not hold turn start open or infer idle", async () => {
  vi.resetModules();
  const modulePath = "../plugins/claude/hooks/wake.ts";
  const { register } = await import(modulePath);
  const handlers = new Map<string, (...a: any[]) => Promise<unknown>>();
  register(((name: string, fn: any) => handlers.set(name, fn)) as any);
  const fetch = vi.fn(async (_url: string) => new Promise(() => {})), next = vi.fn(async (e: any) => e);
  const engine = { session: { id: async () => "session" }, env: { get: async () => "fixture" },
    fs: { read: async () => JSON.stringify({ port: 1, secret: "fixture" }) },
    http: { fetch }, clock: { sleep: vi.fn(async () => {}) },
  };
  await handlers.get("turn.start")!(engine, { turnId: "main" }, next);
  expect(next).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]![0]).toContain("busy=1");
});
