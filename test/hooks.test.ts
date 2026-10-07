import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import type { ServerContext } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let me: BridgeNode;
let peer: BridgeNode;

const ctx = (over: Partial<ServerContext> = {}): ServerContext => ({
  agent: "codex",
  cfg: { ...DEFAULT_CONFIG, maxHops: 2, lingerSec: 1 },
  node: me,
  log: nullLogger,
  home: env.home,
  cwd: () => env.home,
  channelActive: () => false,
  ...over,
});

beforeEach(async () => {
  env = makeEnv();
  me = env.node("codex-h", "codex");
  peer = env.node("claude-h", "claude");
  await me.start();
  await peer.start();
});
afterEach(async () => {
  await env.cleanup();
});

const input = (event: "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop") => ({ event, sessionId: "s1", stopHookActive: false });

describe("hook responses", () => {
  it("SessionStart reports identity and peers", async () => {
    const out = (await buildHookResponse(ctx(), input("SessionStart"))) as any;
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain('"codex-h"');
    expect(out.hookSpecificOutput.additionalContext).toContain("claude-h");
    expect(me.currentSessionId).toBe("s1");
  });

  it("UserPromptSubmit injects unread messages once", async () => {
    await peer.send({ to: "codex-h", body: "ping" });
    await until(() => me.unread().length === 1);
    const out = (await buildHookResponse(ctx(), input("UserPromptSubmit"))) as any;
    expect(out.hookSpecificOutput.additionalContext).toContain("ping");
    expect(me.unread()).toHaveLength(0);
    expect(await buildHookResponse(ctx(), input("UserPromptSubmit"))).toEqual({});
  });

  it("channel mode leaves delivery to the channel", async () => {
    await peer.send({ to: "codex-h", body: "ping" });
    await until(() => me.unread().length === 1);
    expect(await buildHookResponse(ctx({ channelActive: () => true }), input("PostToolUse"))).toEqual({});
    expect(me.unread()).toHaveLength(1);
  });

  it("Stop does nothing unless auto-wake is on", async () => {
    await peer.send({ to: "codex-h", body: "work" });
    await until(() => me.unread().length === 1);
    expect(await buildHookResponse(ctx(), input("Stop"))).toEqual({});
    await me.setAutoWake(true);
    const out = (await buildHookResponse(ctx(), input("Stop"))) as any;
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("work");
  });

  it("Stop defers a later reply to the next hook without consuming it", async () => {
    const sent = await me.send({ to: "claude-h", body: "question?" });
    const started = Date.now();
    expect(await buildHookResponse(ctx(), input("Stop"))).toEqual({});
    expect(Date.now() - started).toBeLessThan(500);
    await peer.send({ to: "codex-h", body: "answer!", replyTo: sent.messages[0]!.id });
    await until(() => me.unread().length === 1);
    expect(JSON.stringify(await buildHookResponse(ctx(), input("PostToolUse")))).toContain("answer!");
  });

  it("Stop returns immediately when the session is not in a conversation", async () => {
    const started = Date.now();
    expect(await buildHookResponse(ctx({ cfg: { ...DEFAULT_CONFIG, lingerSec: 60 } }), input("Stop"))).toEqual({});
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("Stop stops waiting when the hook call is aborted", async () => {
    await me.send({ to: "claude-h", body: "hello" });
    const ac = new AbortController();
    const c = ctx({ cfg: { ...DEFAULT_CONFIG, lingerSec: 60 } });
    const stop = buildHookResponse(c, { ...input("Stop"), signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    expect(await stop).toEqual({});
  });

  it("Stop respects the hop limit", async () => {
    await me.setAutoWake(true);
    // Build a chain: hop 0 -> 1 -> 2 (maxHops = 2 in ctx)
    const first = await peer.send({ to: "codex-h", body: "h0" });
    const second = await me.send({ to: "claude-h", body: "h1", replyTo: first.messages[0]!.id });
    await peer.send({ to: "codex-h", body: "h2", replyTo: second.messages[0]!.id });
    await until(() => me.unread().length === 2);
    me.markRead([first.messages[0]!.id]);
    expect(me.unread()[0]!.hop).toBe(2);
    expect(await buildHookResponse(ctx(), input("Stop"))).toEqual({});
    // Still visible on the next prompt.
    const out = (await buildHookResponse(ctx(), input("UserPromptSubmit"))) as any;
    expect(out.hookSpecificOutput.additionalContext).toContain("h2");
  });
});
