import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { DelegateResult } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { JobManager } from "../src/mcp/jobs.js";
import { RewakeEndpoint, sessionFile } from "../src/mcp/rewake.js";
import type { ServerContext } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "plugins", "claude", "dist", "cli.mjs");
let env: TestEnv;
let me: BridgeNode;
let jobs: JobManager;
let rewake: RewakeEndpoint;

beforeEach(async () => {
  env = makeEnv();
  me = env.node("claude-r", "claude");
  await me.start();
  jobs = new JobManager(me, nullLogger);
  rewake = new RewakeEndpoint(env.home, me, (m: BridgeMessage) => m.from.id.startsWith("job:") || me.isAwaitedReply(m), nullLogger);
  await rewake.start();
  rewake.register("sess-1");
});
afterEach(async () => {
  await rewake.stop();
  await env.cleanup();
});

/** Run the real hook command the way Claude Code does (JSON on stdin). */
function runHook(sessionId: string, standby = false): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "rewake-hook", ...(standby ? ["--standby"] : [])], { env: { ...process.env, AGENT_BRIDGE_HOME: env.home } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify({ session_id: sessionId, hook_event_name: "Stop" }));
  });
}

const result = (text: string): DelegateResult => ({ sessionId: "s", text, isError: false, details: {} });

describe.skipIf(!existsSync(CLI))("background wake-ups", () => {
  it("wakes the session (exit 2) with a finished subagent's result", async () => {
    const hook = runHook("sess-1");
    await until(() => rewake.waiting, 10_000);
    jobs.start("opencode", null, "task", async () => result("interiors are done"));
    const { code, stderr } = await hook;
    expect(code).toBe(2);
    expect(stderr).toContain("interiors are done");
    // Handed to the wake-up, but only read once the session shows activity.
    expect(me.unread()).toHaveLength(1);
    rewake.confirmDelivery();
    expect(me.unread()).toHaveLength(0);
  });

  it("keeps a lost wake-up's messages for the next prompt instead of dropping them", async () => {
    const ctx = {
      agent: "claude",
      cfg: { ...DEFAULT_CONFIG },
      node: me,
      log: nullLogger,
      home: env.home,
      cwd: () => env.home,
      channelActive: () => false,
      jobs,
      rewakeAvailable: true,
      wakeDelivery: { confirm: () => rewake.confirmDelivery(), release: () => rewake.releaseUndelivered(), active: () => rewake.sessionActive() },
    } as ServerContext;
    const hook = runHook("sess-1");
    await until(() => rewake.waiting, 10_000);
    jobs.start("codex", null, "task", async () => result("caves are done"));
    expect((await hook).code).toBe(2);
    // Claude Code never started the wake-up's turn; the user writes next.
    const out = (await buildHookResponse(ctx, { event: "UserPromptSubmit", sessionId: null, stopHookActive: false })) as { hookSpecificOutput?: { additionalContext: string } };
    expect(out.hookSpecificOutput?.additionalContext).toContain("caves are done");
    expect(me.unread()).toHaveLength(0);
  });

  it("does not show a delivered wake-up's messages again in its own turn", async () => {
    const ctx = {
      agent: "claude",
      cfg: { ...DEFAULT_CONFIG },
      node: me,
      log: nullLogger,
      home: env.home,
      cwd: () => env.home,
      channelActive: () => false,
      jobs,
      rewakeAvailable: true,
      wakeDelivery: { confirm: () => rewake.confirmDelivery(), release: () => rewake.releaseUndelivered(), active: () => rewake.sessionActive() },
    } as ServerContext;
    const hook = runHook("sess-1");
    await until(() => rewake.waiting, 10_000);
    jobs.start("codex", null, "task", async () => result("bridges are done"));
    expect((await hook).code).toBe(2);
    // The wake-up's turn runs a tool: its messages are not injected a second time.
    expect(await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false })).toEqual({});
    expect(me.unread()).toHaveLength(0);
  });

  it("treats the wake-up's own prompt as delivery, not as a new user prompt", async () => {
    const ctx = {
      agent: "claude",
      cfg: { ...DEFAULT_CONFIG },
      node: me,
      log: nullLogger,
      home: env.home,
      cwd: () => env.home,
      channelActive: () => false,
      jobs,
      rewakeAvailable: true,
      wakeDelivery: { confirm: () => rewake.confirmDelivery(), release: () => rewake.releaseUndelivered(), active: () => rewake.sessionActive() },
    } as ServerContext;
    const hook = runHook("sess-1");
    await until(() => rewake.waiting, 10_000);
    jobs.start("codex", null, "task", async () => result("towers are done"));
    const { stderr } = await hook;
    // Claude Code runs the prompt hook for the wake-up's text: no second copy of the message.
    expect(await buildHookResponse(ctx, { event: "UserPromptSubmit", sessionId: null, stopHookActive: false, prompt: `Stop hook feedback: ${stderr}` })).toEqual({});
    expect(me.unread()).toHaveLength(0);
  });

  it("leaves mid-turn results to the tool hooks instead of the previous turn end's waiter", async () => {
    const ctx = {
      agent: "claude",
      cfg: { ...DEFAULT_CONFIG },
      node: me,
      log: nullLogger,
      home: env.home,
      cwd: () => env.home,
      channelActive: () => false,
      jobs,
      rewakeAvailable: true,
      wakeDelivery: { confirm: () => rewake.confirmDelivery(), release: () => rewake.releaseUndelivered(), active: () => rewake.sessionActive() },
    } as ServerContext;
    const hook = runHook("sess-1");
    await until(() => rewake.waiting, 10_000);
    // The user starts a new turn: the old waiter ends without taking anything.
    await buildHookResponse(ctx, { event: "UserPromptSubmit", sessionId: null, stopHookActive: false, prompt: "go on" });
    expect((await hook).code).toBe(0);
    jobs.start("codex", null, "task", async () => result("gates are done"));
    await until(() => me.unread().length === 1);
    const out = (await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false })) as { hookSpecificOutput?: { additionalContext: string } };
    expect(out.hookSpecificOutput?.additionalContext).toContain("gates are done");
  });

  it("retries a wake-up that Claude Code did not take through the standby hook", async () => {
    const primary = runHook("sess-1");
    const standby = runHook("sess-1", true);
    await until(() => rewake.waiting, 10_000);
    jobs.start("codex", null, "task", async () => result("bridges are done"));
    expect((await primary).code).toBe(2);
    // No session activity follows: after the confirmation window the standby wakes with the same message.
    const second = await standby;
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("bridges are done");
  }, 40_000);

  it("wakes through the standby for a result that arrives when nothing else waits", async () => {
    const standby = runHook("sess-1", true);
    await new Promise((r) => setTimeout(r, 500));
    jobs.start("codex", null, "task", async () => result("walls are done"));
    const { code, stderr } = await standby;
    expect(code).toBe(2);
    expect(stderr).toContain("walls are done");
  }, 20_000);

  it("wakes for a reply to a question this session asked, not for unrelated chatter", async () => {
    const peer = env.node("codex-r", "codex");
    await peer.start();
    const q = await me.send({ to: "codex-r", body: "question?" });
    const hook = runHook("sess-1");
    await until(() => rewake.waiting, 10_000);
    await peer.send({ to: "claude-r", body: "unrelated chatter" });
    await new Promise((r) => setTimeout(r, 300));
    await peer.send({ to: "claude-r", body: "the answer", replyTo: q.messages[0]!.id });
    const { code, stderr } = await hook;
    expect(code).toBe(2);
    expect(stderr).toContain("the answer");
    expect(stderr).not.toContain("unrelated chatter");
  });

  it("an older waiter ends quietly when a newer turn starts waiting", async () => {
    const older = runHook("sess-1");
    await until(() => rewake.waiting, 10_000);
    const newer = runHook("sess-1");
    expect((await older).code).toBe(0);
    await until(() => rewake.waiting, 10_000);
    jobs.start("codex", null, "t", async () => result("ok"));
    expect((await newer).code).toBe(2);
  });

  it("does nothing for unknown sessions", async () => {
    expect((await runHook("other-session")).code).toBe(0);
    await rewake.stop();
    expect(existsSync(sessionFile(env.home, "sess-1"))).toBe(false);
  });

  it("Stop no longer holds the turn open while background jobs run", async () => {
    const ctx: ServerContext = {
      agent: "claude",
      cfg: { ...DEFAULT_CONFIG },
      node: me,
      log: nullLogger,
      home: env.home,
      cwd: () => env.home,
      channelActive: () => false,
      jobs,
      rewakeAvailable: true,
    };
    const job = jobs.start("opencode", null, "long", (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")))));
    const started = Date.now();
    expect(await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false })).toEqual({});
    expect(Date.now() - started).toBeLessThan(500);
    jobs.cancel(job.id);
  });
});
