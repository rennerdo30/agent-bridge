import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { DelegateError } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { parseWorkItem, type TrackerAdapter, type WorkItemEvent, type WorkItemRef } from "../src/core/work-items.js";
import { JobManager, readStore, type Resume, type RunResult } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { registerTools } from "../src/mcp/server.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { until, removeHome } from "./helpers.js";

let home: string;
const managers: JobManager[] = [];
const clients: Client[] = [];
const servers: McpServer[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ab-workitems-jobs-")); });
afterEach(async () => {
  for (const manager of managers.splice(0)) { manager.cancelAll(); }
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close().catch(() => {});
  vi.restoreAllMocks();
  await removeHome(home);
});

const ok = (text: string, sessionId = "ses-1"): RunResult => ({ sessionId, text, isError: false, details: {} });

/** A fake tracker: records every post; optionally throws instead. */
function fakeTracker(throwOnPost = false) {
  const posts: { ref: WorkItemRef; event: WorkItemEvent }[] = [];
  const adapter: TrackerAdapter = {
    type: "pair-desk",
    post: async (ref, event) => {
      if (throwOnPost) throw new Error("tracker exploded");
      posts.push({ ref, event });
    },
  };
  const provider = () => new Map([["pair-desk", adapter]]);
  return { posts, adapter, provider };
}

function manager(provider?: () => Map<string, TrackerAdapter>, cap = 4) {
  const jobs = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger, join(home, "jobs.json"), cap,
    undefined, undefined, provider);
  managers.push(jobs);
  return jobs;
}

function fakeAgent(reply: (message: string) => RunResult = (message) => ok(`reply to: ${message}`)) {
  const resume: Resume = (message, sessionId, workdir) => async () => reply(message);
  return resume;
}

async function connect(jobs: JobManager, node: LocalCoordinator) {
  Object.assign(node, { setNotificationWaitHandlers: vi.fn() });
  const server = new McpServer({ name: "workitems-test", version: "0" });
  servers.push(server);
  registerTools(server, {
    agent: "codex", cfg: { ...DEFAULT_CONFIG }, node: node as unknown as BridgeNode, jobs,
    home, cwd: () => home, channelActive: () => false, log: nullLogger,
  }, ["codex"]);
  const client = new Client({ name: "workitems-test", version: "0" });
  clients.push(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

describe("spawn work_item tool wiring", () => {
  it("exposes work_item on spawn_codex only, not on ask_codex", async () => {
    const node = new LocalCoordinator("owner", "owner-session");
    const jobs = manager();
    const client = await connect(jobs, node);
    const tools = (await client.listTools()).tools;
    const spawn = tools.find((t) => t.name === "spawn_codex")!;
    const ask = tools.find((t) => t.name === "ask_codex")!;
    expect(Object.keys(spawn.inputSchema.properties ?? {})).toContain("work_item");
    expect(Object.keys(ask.inputSchema.properties ?? {})).not.toContain("work_item");
  });

  it("rejects an invalid work_item without creating a job", async () => {
    const node = new LocalCoordinator("owner", "owner-session");
    const jobs = manager(fakeTracker().provider);
    const client = await connect(jobs, node);
    const result = await client.callTool({
      name: "spawn_codex",
      arguments: { prompt: "do things", title: "Bad link", cwd: home, work_item: "not-a-reference" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("invalid work item");
    expect(jobs.list()).toEqual([]);
  });

  it("posts exactly one started and one finished event for a spawned job", async () => {
    const { posts, provider } = fakeTracker();
    const node = new LocalCoordinator("owner", "owner-session");
    const jobs = manager(provider);
    vi.spyOn(DELEGATION_TARGETS.codex, "run").mockResolvedValue({ text: "did the thing", sessionId: "ses-9", isError: false, details: {} });
    const client = await connect(jobs, node);
    const spawned = textOf(await client.callTool({
      name: "spawn_codex",
      arguments: { prompt: "do things", title: "Build things", cwd: home, work_item: "pair-desk:AB-12" },
    }));
    const name = /Subagent (codex-job-[\da-f]+) started/.exec(spawned)?.[1];
    expect(name).toBeTruthy();
    await until(() => jobs.find(name!)?.status === "done");
    await until(() => posts.length === 2);
    expect(posts[0]).toEqual({
      ref: { tracker: "pair-desk", id: "AB-12" },
      event: { kind: "started", job: name, agent: "codex", title: "Build things" },
    });
    expect(posts[1]).toEqual({
      ref: { tracker: "pair-desk", id: "AB-12" },
      // runDelegate appends its step-by-step log trailer to the finished text.
      event: { kind: "finished", job: name, agent: "codex", summary: expect.stringContaining("did the thing") },
    });
    // Stored with the job, with both halves marked posted; never in the run args.
    const job = jobs.find(name!);
    expect(job?.args).not.toHaveProperty("work_item");
    expect(job?.args).not.toHaveProperty("workItem");
    await until(() => readStore(join(home, "jobs.json")).find((j) => j.id === job!.id)?.workItemPosted?.finished === true);
    expect(readStore(join(home, "jobs.json")).find((j) => j.id === job!.id)).toMatchObject({
      workItem: { tracker: "pair-desk", id: "AB-12" },
      workItemPosted: { started: true, finished: true },
    });
  });
});

describe("JobManager work-item events", () => {
  it("posts one failed event with the cause", async () => {
    const { posts, provider } = fakeTracker();
    const jobs = manager(provider);
    const job = jobs.start("codex", null, "fail task", async () => { throw new Error("boom"); }, fakeAgent(),
      { title: "Failing" }, parseWorkItem("pair-desk:AB-3"));
    await until(() => job.status === "failed");
    await until(() => posts.length === 2);
    expect(posts[0]!.event).toMatchObject({ kind: "started", title: "Failing" });
    expect(posts[1]).toEqual({
      ref: { tracker: "pair-desk", id: "AB-3" },
      event: { kind: "failed", job: job.name, agent: "codex", reason: "error: boom" },
    });
  });

  it("posts nothing without a work item", async () => {
    const { posts, provider } = fakeTracker();
    const jobs = manager(provider);
    const job = jobs.start("codex", null, "plain task", async () => ok("fine"), fakeAgent());
    await until(() => job.status === "done");
    await new Promise((r) => setTimeout(r, 100));
    expect(posts).toEqual([]);
  });

  it("still finishes the job when the adapter throws", async () => {
    const { posts, provider } = fakeTracker(true);
    const jobs = manager(provider);
    const job = jobs.start("codex", null, "task", async () => ok("answer"), fakeAgent(),
      undefined, parseWorkItem("pair-desk:AB-4"));
    await until(() => job.status === "done");
    expect(posts).toEqual([]);
    expect(job.workItemPosted).toEqual({ started: true, finished: true });
  });

  it("posts reason cancelled for a cancelled job", async () => {
    const { posts, provider } = fakeTracker();
    const jobs = manager(provider);
    const job = jobs.start("codex", null, "slow", (signal) => new Promise<RunResult>((_, reject) =>
      signal.addEventListener("abort", () => reject(new DelegateError("delegate aborted", "aborted", "", "", "s-9"))),
    ), fakeAgent(), undefined, parseWorkItem("pair-desk:AB-5"));
    await until(() => jobs.runningCount() === 1);
    expect(jobs.cancel(job.name)).toBe(true);
    await until(() => job.status === "cancelled");
    await until(() => posts.length === 2);
    expect(posts[1]).toEqual({
      ref: { tracker: "pair-desk", id: "AB-5" },
      event: { kind: "failed", job: job.name, agent: "codex", reason: "cancelled" },
    });
  });

  it("never posts again for a follow-up turn in the same job", async () => {
    const { posts, provider } = fakeTracker();
    const jobs = manager(provider);
    const job = jobs.start("codex", null, "task", async () => ok("first", "ses-A"), fakeAgent((m) => ok(`second:${m}`, "ses-A")),
      undefined, parseWorkItem("pair-desk:AB-6"));
    await until(() => job.status === "done");
    await until(() => posts.length === 2);
    expect(jobs.followUp(job.name, "more").outcome).toBe("started");
    await until(() => job.status === "done" && job.sessionId === "ses-A");
    await new Promise((r) => setTimeout(r, 200));
    expect(posts.length).toBe(2);
    expect(posts[1]!.event).toMatchObject({ kind: "finished" });
  });

  it("does not repost when a finished job is reloaded and adopted", async () => {
    const store = join(home, "jobs.json");
    const { posts, provider } = fakeTracker();
    const jobs = manager(provider);
    const job = jobs.start("codex", null, "task", async () => ok("answer", "ses-R"), fakeAgent(),
      undefined, parseWorkItem("pair-desk:AB-7"));
    await until(() => job.status === "done");
    await until(() => posts.length === 2);
    jobs.cancelAll();
    const second = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger, store, 4,
      undefined, undefined, provider);
    managers.push(second);
    second.restore(() => fakeAgent());
    expect(second.find(job.name)).toMatchObject({ status: "done" });
    await new Promise((r) => setTimeout(r, 200));
    expect(posts.length).toBe(2);
    second.cancelAll();
  });
});
