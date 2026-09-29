import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, MODEL_NAME_PATTERN } from "../src/core/config.js";
import type { DelegateResult } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { JobManager } from "../src/mcp/jobs.js";
import type { ServerContext } from "../src/mcp/server.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let me: BridgeNode;
let jobs: JobManager;

beforeEach(async () => {
  env = makeEnv();
  me = env.node("claude-j", "claude");
  await me.start();
  jobs = new JobManager(me, nullLogger);
});
afterEach(async () => {
  jobs.cancelAll();
  await env.cleanup();
});

const result = (text: string): DelegateResult => ({ sessionId: "s-9", text, isError: false, details: {} });

describe("background subagents", () => {
  it("delivers the result to the spawner's inbox", async () => {
    const job = jobs.start("codex", "gpt-6-sol", "do it", async () => result("all done"));
    expect(job.name).toMatch(/^codex-job-[0-9a-f]{8}$/);
    await until(() => me.unread().length === 1);
    const m = me.unread()[0]!;
    expect(m.from.name).toBe(job.name);
    expect(m.body).toContain("all done");
    expect(m.body).toContain("model gpt-6-sol");
    expect(m.body).toContain(`message_subagent(job="${job.name}"`);
    expect(jobs.runningCount()).toBe(0);
  });

  it("reports failures as a message too", async () => {
    jobs.start("codex", null, "fail", async () => {
      throw new Error("boom");
    });
    await until(() => me.unread().length === 1);
    expect(me.unread()[0]!.body).toContain("failed");
    expect(me.unread()[0]!.body).toContain("boom");
  });

  it("cancel aborts the run", async () => {
    let aborted = false;
    const job = jobs.start("claude", null, "long", (signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => ((aborted = true), reject(new Error("aborted"))))),
    );
    expect(jobs.cancel(job.id)).toBe(true);
    await until(() => aborted && jobs.runningCount() === 0);
  });

  it("lists blocking ask runs with their current step, without counting them as background jobs", () => {
    const tracked = jobs.track("opencode", "opencode/muse", "implement interiors");
    tracked.onProgress("bash: grep -rn Layout");
    const listed = jobs.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: expect.stringMatching(/^opencode-ask-/), progress: "bash: grep -rn Layout", foreground: true });
    expect(jobs.runningCount()).toBe(0);
    tracked.end();
    expect(jobs.list()).toHaveLength(0);
    expect(me.unread()).toHaveLength(0); // no result message for foreground runs
  });

  it("Stop waits for a running subagent and continues with its result", async () => {
    const ctx: ServerContext = {
      agent: "claude",
      cfg: { ...DEFAULT_CONFIG, lingerSec: 0 },
      node: me,
      log: nullLogger,
      home: env.home,
      cwd: () => env.home,
      channelActive: () => false,
      jobs,
    };
    jobs.start("codex", null, "slow", () => new Promise((r) => setTimeout(() => r(result("slow result")), 300)));
    const out = (await buildHookResponse(ctx, { event: "Stop", sessionId: null, stopHookActive: false })) as any;
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("slow result");
  });
});

describe("model ids", () => {
  it("accepts any real model id or alias", () => {
    for (const id of ["gpt-6-sol", "claude-opus-5-5[1m]", "opus", "us.anthropic.claude-sonnet-5-v1:0", "openai/gpt-oss-120b", "o3", "model@2026-09-01"]) {
      expect(MODEL_NAME_PATTERN.test(id), id).toBe(true);
    }
  });
  it("rejects values that could break a command line", () => {
    for (const bad of ["", "a b", 'x"y', "a&b", "a|b", "$(x)", "a;b", "x`y`"]) {
      expect(MODEL_NAME_PATTERN.test(bad), bad).toBe(false);
    }
  });
});
