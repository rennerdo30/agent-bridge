import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { JobManager, type Resume } from "../src/mcp/jobs.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

const HISTORY_PRESSURE = 55;
const STORE_PRESSURE = 210;
let env: TestEnv;
let me: BridgeNode;
let jobs: JobManager;
let store: string;
const calls: { message: string; session: string; workdir: string | null }[] = [];
const resume: Resume = (message, session, workdir) => async () => {
  calls.push({ message, session, workdir });
  return { sessionId: session, text: "continued", isError: false, details: {} };
};

beforeEach(async () => {
  env = makeEnv();
  me = env.node("claude-history", "claude");
  await me.start();
  store = join(env.home, "jobs.json");
  jobs = new JobManager(me, nullLogger, store);
  calls.length = 0;
});

afterEach(async () => {
  jobs.cancelAll();
  await env.cleanup();
});

function saved(index: number, owner = me.name) {
  const id = index.toString(16).padStart(8, "0");
  return { id, name: `codex-job-${id}`, agent: "codex", model: "gpt-6-sol", prompt: "task", startedAt: index, finishedAt: index, status: "done", sessionId: `thread-${index}`, workdir: env.home, worktree: null, args: { access: "edit", effort: "high", title: "Original title" }, owner, host: null };
}

function runFile(job: string, patch: Record<string, unknown> = {}) {
  const dir = join(env.home, "runs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-10-05-18-14-23-codex-9f266d28.json"), JSON.stringify({ by: me.name, job, model: "gpt-6-sol", access: "edit", effort: "high", session: "legacy-thread", workdir: env.home, ...patch }));
}

describe("addressing older jobs", () => {
  it("keeps a current session's old jobs addressable beyond the in-memory history limit", async () => {
    const first = jobs.track("codex", null, "first task", resume);
    first.end({ result: { sessionId: "old-thread", text: "done", isError: false, details: {}, workdir: env.home } });
    for (let i = 0; i < HISTORY_PRESSURE; i++) {
      const tracked = jobs.track("codex", null, `task ${i}`, resume);
      tracked.end({ result: { sessionId: `thread-${i}`, text: "done", isError: false, details: {} } });
    }
    expect(jobs.find(first.job.name)?.sessionId).toBe("old-thread");
    expect(jobs.followUp(first.job.name, "next round").outcome).toBe("started");
    await until(() => calls.length === 1);
    expect(calls[0]).toEqual({ message: "next round", session: "old-thread", workdir: env.home });
  });

  it("restores an older owned job even when newer jobs belong to other sessions", async () => {
    const oldest = saved(1);
    const others = Array.from({ length: HISTORY_PRESSURE }, (_, i) => saved(i + 2, "claude-other"));
    writeFileSync(store, JSON.stringify([oldest, ...others]));
    jobs.restore(() => resume);
    expect(jobs.find(oldest.name)).toMatchObject({ sessionId: oldest.sessionId, args: oldest.args });
    expect(jobs.followUp(oldest.name, "finish round two").outcome).toBe("started");
    await until(() => calls.length === 1);
    expect(calls[0]!.session).toBe(oldest.sessionId);
  });

  it("archives jobs evicted from the shared store and restores them by name with their options", async () => {
    const stored = Array.from({ length: STORE_PRESSURE }, (_, i) => saved(i + 1));
    writeFileSync(store, JSON.stringify(stored));
    jobs.persist();
    const newest = JSON.parse(readFileSync(store, "utf8")) as { id: string }[];
    expect(newest.some((j) => j.id === stored[0]!.id)).toBe(false);
    const options: Record<string, unknown>[] = [];
    jobs.restore((_agent, args) => { options.push(args); return resume; });
    const oldest = jobs.find(stored[0]!.name);
    expect(oldest).toMatchObject({ sessionId: stored[0]!.sessionId, args: stored[0]!.args });
    expect(options).toContainEqual(stored[0]!.args);
    expect(jobs.recent().some((j) => j.id === oldest!.id)).toBe(false);
    expect(jobs.followUp(oldest!.id, "more work").outcome).toBe("started");
    await until(() => calls.length === 1);
    expect(calls[0]!.session).toBe(stored[0]!.sessionId);
  });

  it("recovers an evicted legacy job from its retained run metadata", async () => {
    const name = "codex-job-cfaded15";
    runFile(name);
    jobs.restore(() => resume);
    expect(jobs.find(name)).toMatchObject({ name, sessionId: "legacy-thread", owner: me.name, workdir: env.home, args: { access: "edit", effort: "high" } });
    expect(jobs.followUp(name, "next look round").outcome).toBe("started");
    await until(() => calls.length === 1);
    expect(calls[0]).toEqual({ message: "next look round", session: "legacy-thread", workdir: env.home });
  });

  it("distinguishes a missing legacy working folder and a missing session from an unknown job", () => {
    const name = "codex-job-cfaded15";
    runFile(name, { workdir: join(env.home, "deleted-worktree") });
    jobs.restore(() => resume);
    expect(jobs.followUp(name, "next round").outcome).toBe("missing-workdir");
    runFile("codex-job-abcdef00", { session: null });
    expect(jobs.followUp("codex-job-abcdef00", "next round").outcome).toBe("no-session");
    expect(jobs.followUp("codex-job-abcdef01", "next round").outcome).toBe("unknown");
    expect(calls).toEqual([]);
  });

  it("adopts an old stand-in job beyond the restore limit only after its owner goes offline", () => {
    const oldest = saved(1, `${me.name}-2`);
    writeFileSync(store, JSON.stringify([oldest, ...Array.from({ length: HISTORY_PRESSURE }, (_, i) => saved(i + 2, "claude-other"))]));
    jobs.restore(() => resume);
    expect(jobs.adoptStandIns(new Set([me.name, oldest.owner]))).toEqual([]);
    expect(jobs.recent().some((j) => j.id === oldest.id)).toBe(false);
    expect(jobs.adoptStandIns(new Set([me.name]))).toEqual([oldest.owner]);
    expect(jobs.recent().some((j) => j.id === oldest.id)).toBe(true);
  });

  it("does not evict running jobs when the shared store is full", () => {
    const running = { ...saved(1), status: "running" };
    writeFileSync(store, JSON.stringify([running, ...Array.from({ length: STORE_PRESSURE }, (_, i) => saved(i + 2))]));
    jobs.persist();
    expect(JSON.parse(readFileSync(store, "utf8"))).toContainEqual(running);
  });
});
