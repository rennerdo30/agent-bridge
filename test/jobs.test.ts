import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, MODEL_NAME_PATTERN } from "../src/core/config.js";
import type { DelegateResult } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { JobManager, type Run, type RunnerState } from "../src/mcp/jobs.js";
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
  it("persists optional ETA and clears it when a job completes", async () => {
    const { join } = await import("node:path");
    const { readStore } = await import("../src/mcp/jobs.js");
    const store = join(env.home, "jobs.json");
    jobs = new JobManager(me, nullLogger, store);
    let release!: (value: DelegateResult) => void;
    const job = jobs.start("codex", null, "estimate", (_signal, _progress, current) => {
      current.percent = 40;
      current.progressNote = "tests";
      current.etaReportedAt = Date.now();
      current.etaAt = current.etaReportedAt + 720_000;
      jobs.persist();
      return new Promise((resolve) => { release = resolve; });
    });
    expect(readStore(store).find((j) => j.id === job.id)).toMatchObject({ percent: 40, etaAt: job.etaAt, etaReportedAt: job.etaReportedAt });
    release(result("done"));
    await until(() => job.status === "done");
    expect(job.etaAt).toBeUndefined();
    expect(job.etaReportedAt).toBeUndefined();
    expect(readStore(store).find((j) => j.id === job.id)).not.toHaveProperty("etaAt");
  });

  it("keeps old active jobs addressable after newer jobs evict their history entries", () => {
    const tracked = jobs.track("codex", null, "long blocking ask");
    const running = jobs.start("codex", null, "long background job", () => new Promise(() => {}));
    for (let i = 0; i < 55; i++) {
      const newer = jobs.track("codex", null, `newer ${i}`);
      newer.end();
    }
    for (const job of [tracked.job, running]) {
      expect(jobs.list()).toContain(job);
      expect(jobs.find(job.name)).toBe(job);
      expect(jobs.find(job.id)).toBe(job);
      expect(jobs.followUp(job.name, "check progress").outcome).toBe("queued");
      expect(jobs.setTitle(job.name, "Still working")).toBe(true);
      expect(jobs.setEffort(job.id, "high")).toBe(true);
      expect(jobs.setSettings(job.name, { model: "sample" })).toBe(true);
    }
    tracked.end();
    jobs.cancel(running.name);
  });

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

  it.each(["claude", "codex", "opencode"] as const)("resumes a cancelled %s job with a fresh signal", async (agent) => {
    const resumed = vi.fn(async (signal: AbortSignal) => { expect(signal.aborted).toBe(false); return result("continued"); });
    const job = jobs.start(agent, null, "long", (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))), () => resumed);
    job.sessionId = "saved-session";
    jobs.cancel(job.name);
    await until(() => job.status === "failed");
    expect(jobs.followUp(job.name, "Continue").outcome).toBe("started");
    await until(() => job.status === "done");
    expect(resumed).toHaveBeenCalledOnce();
  });

  it.each(["claude", "codex", "opencode"] as const)("queues a %s continuation until cancellation finishes", async agent => {
    let stop!: (error: Error) => void;
    const resumed = vi.fn(async (signal: AbortSignal) => { expect(signal.aborted).toBe(false); return result("continued"); });
    const resume = vi.fn(() => resumed);
    const job = jobs.start(agent, null, "task", () => new Promise((_, reject) => { stop = reject; }), resume);
    job.sessionId = "saved-session";
    jobs.cancel(job.name);
    expect(jobs.followUp(job.name, "Continue").outcome).toBe("waiting");
    expect(jobs.followUp(job.name, "Keep the context").outcome).toBe("waiting");
    // Free capacity does not allow two turns of this same job to overlap.
    jobs.setLimit(3);
    expect(resume).not.toHaveBeenCalled();
    stop(new Error("cancelled"));
    await until(() => job.status === "done");
    expect(resume).toHaveBeenCalledWith("Continue\n\nKeep the context", "saved-session", null, null);
    expect(resumed).toHaveBeenCalledOnce();
    expect(jobs.waiting()).toEqual([]);
  });

  it("never applies an old cancellation grace timer to the resumed runner", async () => {
    let state: RunnerState | null = null;
    const kill = vi.fn();
    jobs.runners = { state: () => state, alive: () => true, send: vi.fn(), kill };
    const run: Run = Object.assign(async () => result("unused"), { hosted: () => ({ pid: 123, peer: "runner", startedAt: Date.now() }) });
    const job = jobs.start("opencode", null, "task", run, () => run);
    job.sessionId = "saved";
    jobs.cancel(job.name);
    state = { pid: 123, peer: "runner", status: "failed", updatedAt: Date.now(), delivered: true, sessionId: "saved" };
    expect(jobs.followUp(job.name, "Continue").outcome).toBe("started");
    state = null;
    // Use real timers for broker teardown; only the cancellation deadline is awaited.
    await new Promise(resolve => setTimeout(resolve, 5_100));
    expect(kill).not.toHaveBeenCalled();
    expect(job.status).toBe("running");
    jobs.cancelAll();
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
