import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { reportModActivity } from "../src/mcp/hook-ownership.js";
import type { DelegateResult } from "../src/core/delegate.js";
import { buildHookResponse, claudeWakeCandidate, completionAwaitingReceipt } from "../src/mcp/hooks.js";
import { JobManager } from "../src/mcp/jobs.js";
import { RewakeEndpoint, sessionFile } from "../src/mcp/rewake.js";
import type { ServerContext } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

/**
 * AB-396: a peer message handed to the agent-bridge mod is submitted as its own turn
 * ("[agent-bridge] New actionable message(s) arrived"). A user prompt that starts first
 * must not inject the same message as hook context too, and a mod hand-out the mod
 * never submitted must not be marked read by an unrelated turn start.
 */
let env: TestEnv;
let me: BridgeNode;
let peer: BridgeNode;
let rewake: RewakeEndpoint;
let ctx: ServerContext;
let jobs: JobManager;
let sequence = 0;

type Ctx = { hookSpecificOutput?: { additionalContext: string } };

beforeEach(async () => {
  env = makeEnv();
  me = env.node("claude-w", "claude");
  peer = env.node("codex-p", "codex");
  await me.start();
  await peer.start();
  await me.setSessionId("sess-1");
  jobs = new JobManager(me, nullLogger);
  ctx = {
    agent: "claude",
    cfg: { ...DEFAULT_CONFIG },
    node: me,
    log: nullLogger,
    home: env.home,
    cwd: () => env.home,
    channelActive: () => false,
    rewakeAvailable: true,
    jobs,
  } as ServerContext;
  rewake = new RewakeEndpoint(env.home, me, (m) => claudeWakeCandidate(ctx, m), nullLogger, (event) => reportModActivity(ctx, event));
  await rewake.start();
  rewake.register("sess-1");
  ctx.wakeDelivery = rewake.delivery();
  sequence = 0;
});
afterEach(async () => {
  await rewake.stop();
  await env.cleanup();
});

function endpoint() {
  const reg = JSON.parse(readFileSync(sessionFile(env.home, "sess-1"), "utf8")) as { port: number; secret: string };
  // A mod poll with nothing to hand out holds for minutes: these polls expect an answer at once.
  return (path: string, method = "GET") => fetch(`http://127.0.0.1:${reg.port}${path}`, { method, headers: { authorization: `Bearer ${reg.secret}` }, signal: AbortSignal.timeout(3_000) });
}

/** The mod's turn.start / turn.complete report (plugins/claude/hooks/wake.ts). */
async function activity(busy: boolean, turnId: string): Promise<number> {
  return (await endpoint()(`/activity?busy=${busy ? 1 : 0}&session_id=sess-1&turn_id=${turnId}&sequence=${++sequence}&instance=mod`, "POST")).status;
}

async function modPoll(): Promise<string> {
  return ((await (await endpoint()("/wait?role=mod")).json()) as { text: string }).text;
}

const prompt = (text: string, promptId: string) => buildHookResponse(ctx, { event: "UserPromptSubmit", sessionId: "sess-1", promptId, stopHookActive: false, prompt: text }) as Promise<Ctx>;

describe("AB-396 a message handed to the mod is delivered once", () => {
  it("a user prompt that starts before the queued wake turn does not inject the same message", async () => {
    await peer.send({ to: "claude-w", body: "please review the patch" });
    await until(() => me.unread().length === 1);
    const id = me.unread()[0]!.id;
    // Idle session: the mod takes the message and submits it as its own prompt (queued in Claude Code).
    const wake = await modPoll();
    expect(wake).toContain("please review the patch");
    // The owner's prompt runs first. Its UserPromptSubmit hook fires before the mod reports the turn start.
    const user = await prompt("how is the build going?", "user-1");
    expect(user.hookSpecificOutput?.additionalContext ?? "").not.toContain(id);
    expect(me.unread().map((m) => m.id)).toEqual([id]);
    expect(await activity(true, "user-turn")).toBe(204);
    expect(await buildHookResponse(ctx, { event: "PostToolUse", sessionId: "sess-1", promptId: "user-1", stopHookActive: false })).toEqual({});
    await buildHookResponse(ctx, { event: "Stop", sessionId: "sess-1", promptId: "user-1", stopHookActive: false });
    expect(await activity(false, "user-turn")).toBe(204);
    // The queued wake turn now runs with the message as its prompt: that is the one delivery.
    expect(await activity(true, "wake-turn")).toBe(204);
    expect(await prompt(wake, "wake-1")).toEqual({});
    expect(me.unread()).toEqual([]);
  });

  it("a mod hand-out that never became a prompt stays unread and is handed out again once idle", async () => {
    await peer.send({ to: "claude-w", body: "status of the release?" });
    await until(() => me.unread().length === 1);
    expect(await modPoll()).toContain("status of the release?");
    // The mod saw a turn start before its fetch resolved and dropped the text without submitting it.
    expect(await activity(true, "user-turn")).toBe(204);
    expect(me.unread()).toHaveLength(1);
    expect(await activity(false, "user-turn")).toBe(204);
    // The next idle poll hands it out again; it was never shown, so this is its first delivery.
    expect(await modPoll()).toContain("status of the release?");
  });

  it("a hand-out the mod already submitted is confirmed by the mod's acknowledgement, not by a second turn", async () => {
    await peer.send({ to: "claude-w", body: "merge order?" });
    await until(() => me.unread().length === 1);
    await modPoll();
    expect(await activity(true, "other")).toBe(204);
    expect(await activity(false, "other")).toBe(204);
    // The re-poll returns the same ids; the mod remembers it submitted them and acknowledges instead.
    expect(await modPoll()).toContain("merge order?");
    await endpoint()("/mod?busy=1", "POST");
    await endpoint()("/mod?busy=0", "POST");
    expect(me.unread()).toEqual([]);
  });
});

const result = (text: string): DelegateResult => ({ sessionId: "s", text, isError: false, details: {} });
const hook = (event: "UserPromptSubmit" | "PostToolUse" | "Stop" | "StopFailure", promptId: string) =>
  buildHookResponse(ctx, { event, sessionId: "sess-1", promptId, stopHookActive: false, prompt: event === "UserPromptSubmit" ? "go on" : undefined }) as Promise<Ctx>;

describe("AB-396 hook hand-outs and repeats", () => {
  it("a job result a hook handed out never becomes a wake turn while its receipt is pending", async () => {
    await hook("UserPromptSubmit", "p1");
    jobs.start("codex", null, "task", async () => result("tiles are done"));
    await until(() => me.unread().length === 1);
    const id = me.unread()[0]!.id;
    expect(claudeWakeCandidate(ctx, me.unread()[0]!)).toBe(true);
    expect((await hook("PostToolUse", "p1")).hookSpecificOutput?.additionalContext).toContain("tiles are done");
    // Held unread until a later boundary (AB-400), but already delivered for the wake path.
    expect(completionAwaitingReceipt(ctx, id)).toBe(true);
    expect(me.unread().map((m) => m.id)).toEqual([id]);
    expect(claudeWakeCandidate(ctx, me.unread()[0]!)).toBe(false);
    await hook("Stop", "p1");
    expect(me.unread()).toEqual([]);
  });

  it("a completion whose hand-out was discarded by StopFailure is delivered again, marked as a repeat", async () => {
    await hook("UserPromptSubmit", "p1");
    jobs.start("codex", null, "task", async () => result("doors are done"));
    await until(() => me.unread().length === 1);
    expect((await hook("PostToolUse", "p1")).hookSpecificOutput?.additionalContext).not.toContain('repeat="true"');
    expect(await hook("StopFailure", "p1")).toEqual({});
    // Never dropped: the next prompt shows it again, saying it may have been shown before.
    const again = (await hook("UserPromptSubmit", "p2")).hookSpecificOutput?.additionalContext ?? "";
    expect(again).toContain("doors are done");
    expect(again).toContain('repeat="true"');
  });

  it("a Stop-hook wake-up released by a new prompt goes out with that prompt as a repeat", async () => {
    const wake = endpoint()("/wait").then((r) => r.json() as Promise<{ text: string }>);
    await until(() => rewake.waiting);
    await peer.send({ to: "claude-w", body: "can you rebase?" });
    expect((await wake).text).toContain("can you rebase?");
    // Claude Code may still start the wake-up's turn: the prompt's copy says it may be a repeat.
    const out = (await prompt("next task", "user-1")).hookSpecificOutput?.additionalContext ?? "";
    expect(out).toContain("can you rebase?");
    expect(out).toContain('repeat="true"');
  });

  it("a mod hand-out nobody took again returns to the hooks after two turn ends, as a repeat", async () => {
    await peer.send({ to: "claude-w", body: "ping from codex" });
    await until(() => me.unread().length === 1);
    expect(await modPoll()).toContain("ping from codex");
    // The mod stops polling (e.g. it was unloaded). Two ordinary turns pass without its prompt.
    for (const turn of ["t1", "t2"]) {
      expect((await hook("UserPromptSubmit", turn)).hookSpecificOutput?.additionalContext ?? "").not.toContain("ping from codex");
      await hook("Stop", turn);
    }
    const out = (await hook("UserPromptSubmit", "t3")).hookSpecificOutput?.additionalContext ?? "";
    expect(out).toContain("ping from codex");
    expect(out).toContain('repeat="true"');
    expect(me.unread()).toEqual([]);
  });
});
