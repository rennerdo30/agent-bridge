import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Broker } from "../src/core/broker.js";
import { BridgeNode } from "../src/core/node.js";
import { BridgeError, type BridgeMessage } from "../src/core/protocol.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import type { MessageStore } from "../src/core/store.js";
import * as index from "../src/core/job-run-index.js";
import { recoverJobRecordAsync } from "../src/core/job-recovery.js";
import * as feeds from "../src/core/job-recovery-feed.js";
import * as runner from "../src/core/runner-store.js";
import { controlDashboardJob, DASHBOARD_JOB_CONVERSATION } from "../src/core/job-control.js";
import { attachDashboardJobControl } from "../src/mcp/dashboard-control.js";
import { JobManager, type Job } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { registerTools } from "../src/mcp/server.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await env.cleanup(); });

type Row = Record<string, unknown>;
type FixtureBroker = {
  conns: Set<unknown>;
  jobForControl(peer: unknown, ref: string): Promise<Row | undefined>;
  handlers: {
    jobAuthority(conn: unknown, args: { job: string }): Promise<Job | null>;
    projectJobs(conn: unknown): Promise<Row[]>;
  };
};
function brokerFixture() {
  const registry = join(env.home, "jobs.json");
  writeFileSync(registry, JSON.stringify({ version: 4, jobs: [] }));
  const debug = vi.fn(), log = { ...nullLogger, debug };
  const broker = new Broker(env.pipe, {} as MessageStore, log, "fixture-only", Date.now, registry) as unknown as FixtureBroker;
  const conn = { peer: { id: "owner", name: "owner", agent: "other", cwd: env.home } };
  return { broker, conn, registry, debug };
}
function envelope(id: string, name = "codex-job-tiny"): BridgeMessage {
  return { id, from: { id: `job:${name}`, name, agent: "codex" }, to: "owner", body: "private retained result bytes",
    createdAt: 1, conversationId: "fixture" } as BridgeMessage;
}

async function localCaller() {
  const f = brokerFixture();
  vi.spyOn(index, "waitForJobRunIndex").mockResolvedValue("discover");
  const node = Object.assign(new LocalCoordinator("owner", "fixture-session"), {
    jobAuthority: (job: string) => f.broker.handlers.jobAuthority(f.conn, { job }),
    setNotificationWaitHandlers: vi.fn(),
  });
  const jobs = new JobManager(node, nullLogger);
  const received: string[] = [];
  let entered!: () => void, finish!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  const job = jobs.start("codex", null, "local private task", async (_signal, _prompt, current) => {
    current.live = { post: body => { received.push(body); } };
    entered(); await held;
    return { sessionId: null, text: "", isError: false, details: {} };
  });
  await ready;
  mkdirSync(join(env.home, "runs"));
  writeFileSync(join(env.home, "runs", "2026-10-06-06-32-18-codex-dashboard.log"), "06:32:18 codex\n");
  writeFileSync(join(env.home, "runs", "2026-10-06-06-32-18-codex-dashboard.json"), JSON.stringify({ by: node.name, job: job.name }));
  return { ...f, node, jobs, job, received, close: () => { finish(); jobs.setDormant(true); jobs.cancelAll(); } };
}

it("label-only absence has bounded finish attribution and local message_subagent still delivers", async () => {
  const f = await localCaller();
  const server = new McpServer({ name: "caller-fixture", version: "0" });
  const client = new Client({ name: "caller-fixture", version: "0" });
  registerTools(server, { agent: "codex", cfg: { ...DEFAULT_CONFIG }, node: f.node as unknown as BridgeNode,
    jobs: f.jobs, home: env.home, cwd: () => env.home, channelActive: () => false, log: nullLogger }, []);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const lookup = vi.spyOn(f.jobs, "findAsync"), observer = vi.fn();
  try {
    expect(await recoverJobRecordAsync(env.home, f.job.name, { onUnavailable: observer })).toBeUndefined();
    expect(observer).toHaveBeenCalledExactlyOnceWith({ reason: "recovery_context_unavailable", stage: "finish" });
    expect(await f.broker.handlers.jobAuthority(f.conn, { job: f.job.name })).toBeNull();
    const result = await client.callTool({ name: "message_subagent", arguments: { job: f.job.name, message: "local continuation" } });
    expect(result.isError).not.toBe(true);
    expect(f.received).toEqual(["local continuation"]);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(f.job.name);
  } finally { f.close(); await client.close(); await server.close(); }
});

function dashboard(node: LocalCoordinator, jobs: JobManager) {
  // Actual authenticated command/reply handlers, in memory, without UI/server/process startup.
  const requester = new LocalCoordinator("dashboard", "dashboard-session");
  const sent = vi.fn(async (args: { to: string; replyTo?: string; body: string; conversationId?: string }, _options?: { quiet: boolean }) => {
    requester.emit("job_control", { ...envelope("reply"), from: { name: node.name }, ...args });
    return { messages: [] };
  });
  Object.assign(node, { send: sent });
  Object.assign(requester, { peers: async () => [{ name: node.name }] });
  attachDashboardJobControl(node as unknown as BridgeNode, jobs, nullLogger);
  const submit = vi.fn(async (args: { body: string }) => {
    node.emit("job_control", { ...envelope("command"), from: { name: requester.name }, body: args.body, jobControlAuthorized: true });
    return { messages: [] };
  });
  return { requester, sent, submit, run: (job: string, command: Parameters<typeof controlDashboardJob>[3]) =>
    controlDashboardJob(requester as unknown as BridgeNode, node.name, job, command,
      submit as unknown as NonNullable<Parameters<typeof controlDashboardJob>[4]>) };
}

it("dashboard label-only local job keeps successful message and settings control", async () => {
  const f = await localCaller(), d = dashboard(f.node, f.jobs);
  try {
    expect(await d.run(f.job.name, { type: "message", body: "dashboard continuation" })).toMatchObject({ outcome: "delivered", isError: false });
    expect(f.received).toEqual(["dashboard continuation"]);
    expect(await d.run(f.job.name, { type: "settings", settings: { effort: "high" } })).toMatchObject({ outcome: "saved", isError: false });
    expect(f.job.args).toMatchObject({ effort: "high" });
  } finally { f.close(); }
});

it("a failed header read is N2 when metadata proves a native session; no local substitute is used", async () => {
  // A read that fails (not a whole, unchanged label-only log, which has no prompt to recover) stays uncertainty.
  const f = await localCaller(), read = vi.spyOn(feeds, "readRecoveryHeader").mockResolvedValueOnce(undefined), follow = vi.spyOn(f.jobs, "followUp");
  const lookup = vi.spyOn(f.jobs, "findAsync");
  writeFileSync(join(env.home, "runs", "2026-10-06-06-32-18-codex-dashboard.json"), JSON.stringify({ by: "owner", job: f.job.name, session: "native" }));
  const before = { status: f.job.status, args: f.job.args, sessionId: f.job.sessionId };
  try {
    await expect(f.jobs.share(f.job.name)).rejects.toMatchObject({ code: "job_index_preparing",
      details: { reason: "recovery_header_unavailable", stage: "header_read" } });
    expect(read).toHaveBeenCalledTimes(1);
    expect(lookup).not.toHaveBeenCalled(); expect(follow).not.toHaveBeenCalled();
    expect({ status: f.job.status, args: f.job.args, sessionId: f.job.sessionId }).toEqual(before);
  } finally { f.close(); }
});

it.each(["stale", "no-pid", "fresh"] as const)("label-only early check uses the exact %s runner-session gate and run-derived start", async kind => {
  const f = await localCaller(), startedAt = Date.UTC(2026, 9, 6, 6, 32, 18);
  const state = { ...(kind === "no-pid" ? {} : { pid: 0 }), status: "done", sessionId: "runner-native",
    updatedAt: kind === "stale" ? startedAt - 1 : startedAt };
  vi.spyOn(runner, "readRunnerStateRecord").mockReturnValue(state);
  // The fresh session reaches the header read; make that read fail so the gate's N2 path is what is observed.
  const read = vi.spyOn(feeds, "readRecoveryHeader").mockResolvedValueOnce(undefined), observer = vi.fn();
  try {
    expect(await recoverJobRecordAsync(env.home, f.job.name, { onUnavailable: observer })).toBeUndefined();
    expect(observer).toHaveBeenCalledExactlyOnceWith(kind === "fresh"
      ? { reason: "recovery_header_unavailable", stage: "header_read" }
      : { reason: "recovery_context_unavailable", stage: "finish" });
    expect(read).toHaveBeenCalledTimes(kind === "fresh" ? 1 : 0);
  } finally { f.close(); }
});

it.each(["name", "agent", "prompt"])("definitive first-pass missing/invalid %s remains null with report-only attribution", async missing => {
  const f = brokerFixture(), row: Row = { id: "tiny", name: "codex-job-tiny", agent: "codex", owner: "owner" };
  if (missing === "name") delete row.name;
  if (missing === "agent") row.agent = "invalid";
  writeFileSync(f.registry, JSON.stringify({ version: 4, jobs: [row] }));
  vi.spyOn(index, "waitForJobRunIndex").mockResolvedValue("discover");
  const observer = vi.fn();
  expect(await recoverJobRecordAsync(env.home, "tiny", { onUnavailable: observer })).toBeUndefined();
  expect(observer).toHaveBeenCalledExactlyOnceWith({ reason: "recovery_context_unavailable", stage: "prepare" });
  expect(await f.broker.handlers.jobAuthority(f.conn, { job: "tiny" })).toBeNull();
  expect(f.debug).toHaveBeenCalledWith("job context not reconstructible", { reason: "recovery_context_unavailable", stage: "prepare" });
});

const named = new BridgeError("job_index_preparing", "Job recovery unavailable (recovery_header_unavailable; header_read). No control submitted.",
  { reason: "recovery_header_unavailable", stage: "header_read" });
for (const type of ["message", "settings"] as const) {
  it.each(["named", "unknown"] as const)(`dashboard ${type} returns authenticated %s share rejection before its timeout`, async kind => {
    vi.useFakeTimers();
    const node = new LocalCoordinator("owner", "fixture-session"), jobs = new JobManager(node, nullLogger);
    const share = vi.spyOn(jobs, "share").mockRejectedValue(kind === "named" ? named : new Error("private exception marker"));
    const lookup = vi.spyOn(jobs, "findAsync"), follow = vi.spyOn(jobs, "followUp"), settings = vi.spyOn(jobs, "setSettings");
    const d = dashboard(node, jobs);
    const pending = d.run("codex-job-tiny", type === "message" ? { type, body: "do not submit" } : { type, settings: { effort: "high" } });
    let settled = false; void pending.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      const result = await pending;
      expect(result).toMatchObject({ outcome: "rejected", isError: true,
        text: kind === "named" ? named.message : "Job authority unavailable; nothing was changed." });
      expect(d.sent).toHaveBeenCalledTimes(1);
      const [reply, options] = d.sent.mock.calls[0]!;
      expect(reply).toMatchObject({ to: "dashboard", replyTo: "command", conversationId: DASHBOARD_JOB_CONVERSATION });
      expect(options).toEqual({ quiet: true });
      expect(JSON.parse(reply.body).requestId).toBe(JSON.parse(d.submit.mock.calls[0]![0].body).requestId);
      expect(JSON.stringify(reply)).not.toContain("private exception marker");
      expect(JSON.stringify(reply)).not.toContain("do not submit");
      expect(share).toHaveBeenCalledExactlyOnceWith("codex-job-tiny");
      expect(lookup).not.toHaveBeenCalled(); expect(follow).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled();
    } finally { vi.clearAllTimers(); jobs.setDormant(true); jobs.cancelAll(); }
  });
}

function handoffFixture() {
  const node = env.node("owner"), first = envelope("refused"), second = envelope("reported", "codex-job-other");
  const inbox = (node as unknown as { inbox: Map<string, BridgeMessage> }).inbox;
  inbox.set(first.id, first); inbox.set(second.id, second);
  const debug = vi.fn(); Object.assign(node, { log: { ...nullLogger, debug } });
  const request = vi.fn(async (op: string, args: unknown): Promise<unknown> => {
    if (op === "jobAuthority") {
      if ((args as { job: string }).job === first.from.name) throw new Error("private preflight marker");
      return { owner: "owner" };
    }
    return op === "handoffSubagents" ? { to: "next", jobs: [] } : {};
  });
  Object.assign(node, { withClient: async (run: (client: { request: typeof request }) => Promise<unknown>) => run({ request }) });
  return { node, request, debug, first, second };
}
it("handoff retains a refused preflight envelope unread and reports other envelopes before submitting", async () => {
  const f = handoffFixture();
  expect(await f.node.handoffSubagents({ to: "next", jobs: "all" })).toEqual({ to: "next", jobs: [] });
  expect(f.request.mock.calls).toEqual([["jobAuthority", { job: f.first.from.name }], ["jobAuthority", { job: f.second.from.name }],
    ["inlineJobReport", f.second], ["handoffSubagents", { to: "next", jobs: "all" }]]);
  expect(f.node.unread()).toEqual([f.first, f.second]);
  expect(JSON.stringify(f.debug.mock.calls)).not.toMatch(/private|retained result bytes/);
});
it.each(["handoffSubagents", "inlineJobReport"])("handoff still propagates actual %s submission/permission errors", async failure => {
  const f = handoffFixture(), error = new BridgeError("unauthorized", "actual submission refused");
  f.request.mockImplementation(async op => {
    if (op === "jobAuthority") return { owner: "owner" };
    if (op === failure) throw error;
    return {};
  });
  await expect(f.node.handoffSubagents({ to: "next" })).rejects.toBe(error);
  expect(f.node.unread()).toEqual([f.first, f.second]);
  if (failure === "inlineJobReport") expect(f.request.mock.calls.some(([op]) => op === "handoffSubagents")).toBe(false);
});

it("one failed runner enrichment leaves other project rows and final permission filtering intact", async () => {
  const f = brokerFixture();
  const kept = { id: "kept", name: "codex-job-kept", agent: "codex", owner: "owner", prompt: "task", startedAt: 1, status: "done", args: {} };
  writeFileSync(f.registry, JSON.stringify({ version: 4, jobs: [kept, { ...kept, id: "foreign", name: "codex-job-foreign", owner: "foreign" }] }));
  for (const name of ["codex-job-refused", "codex-job-after"]) f.broker.conns.add({ socket: { destroyed: false }, peer: { id: name, name, agent: "codex", jobAgent: "codex", cwd: env.home } });
  const enrich = vi.spyOn(f.broker, "jobForControl").mockRejectedValueOnce(new Error("private enrichment marker")).mockResolvedValueOnce(undefined);
  expect(await f.broker.handlers.projectJobs(f.conn)).toEqual([kept]);
  expect(enrich.mock.calls.map(([, ref]) => ref)).toEqual(["codex-job-refused", "codex-job-after"]);
  expect(JSON.stringify(f.debug.mock.calls)).not.toContain("private enrichment marker");
});
