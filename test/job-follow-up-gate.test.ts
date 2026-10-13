import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { pidAlive } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import { metadataFileLease } from "../src/core/metadata-file-lease.js";
import { JobManager, type FollowUpGate, type Job, type RunnerState } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { registerTools, type ServerContext } from "../src/mcp/server.js";

// Mock external probes/leases, never the decision branches or their authorization.
vi.mock("../src/core/delegate.js", async original => ({
  ...await original<typeof import("../src/core/delegate.js")>(), pidAlive: vi.fn(() => true),
}));
vi.mock("../src/core/metadata-file-lease.js", () => ({ metadataFileLease: vi.fn(() => vi.fn()) }));
vi.mock("../src/core/relay.js", async original => ({
  ...await original<typeof import("../src/core/relay.js")>(), listPendingApprovals: vi.fn(() => []),
}));

const SECRET = "synthetic-private-content-must-not-escape";
const reasons: FollowUpGate["reason"][] = ["control_lock_busy", "interrupted_executor_probe",
  "cancellation_guard_foreign_or_unowned", "cancellation_guard_no_resume", "runner_terminal_not_settled"];
let jobs: JobManager, job: Job, home: string, store: string;
let resume: ReturnType<typeof vi.fn>, control: ReturnType<typeof vi.fn>, start: ReturnType<typeof vi.fn>;
const closes: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(metadataFileLease).mockImplementation(() => vi.fn());
  vi.mocked(pidAlive).mockReturnValue(true);
  home = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "follow-up-gate-"));
  store = join(home, "jobs.json");
  const node = new LocalCoordinator("owner", "owner-session");
  control = vi.fn(async () => {});
  Object.assign(node, { controlInlineJob: control });
  jobs = new JobManager(node, nullLogger);
  start = vi.fn(async () => ({ text: SECRET, sessionId: SECRET, isError: false, details: {} }));
  resume = vi.fn(() => start);
  job = jobs.track("codex", null, SECRET, resume, { command: SECRET, auth: SECRET, env: SECRET }).job;
  job.sessionId = SECRET; job.workdir = SECRET; job.progress = SECRET;
  job.queue = [SECRET];
});

afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  jobs.cancelAll();
  vi.restoreAllMocks();
});

function retainFixture(): string {
  writeFileSync(store, JSON.stringify([storedFixture()]));
  // Install only a synthetic durable fixture after creating the tracked exact turn.
  Object.defineProperty(jobs, "storePath", { value: store });
  return readFileSync(store, "utf8");
}

function storedFixture() {
  const { id, name, agent, model, prompt, startedAt, status, sessionId, workdir, worktree,
    owner, executionOwner, executionPid, cancellingTurn, host, args } = job;
  return { id, name, agent, model, prompt, startedAt, status, sessionId, workdir, worktree,
    owner, executionOwner, executionPid, cancellingTurn, host, args, queuedMessages: [...job.queue] };
}

function prepare(reason: FollowUpGate["reason"]): void {
  if (reason === "interrupted_executor_probe") { job.status = "interrupted"; job.executionPid = 987; }
  if (reason === "cancellation_guard_foreign_or_unowned") {
    job.executionOwner = "other-executor"; job.controller.abort();
  }
  if (reason === "cancellation_guard_no_resume") { job.resume = undefined; job.controller.abort(); }
  if (reason === "runner_terminal_not_settled") {
    job.host = { pid: 987, peer: job.name, startedAt: job.startedAt };
    // A foreground job is not in running: checkHosted cannot settle it yet.
    // Even an old/foreign runner record must not enter diagnostic output.
    const state: RunnerState = { pid: 987, peer: SECRET, identity: SECRET, status: "done",
      updatedAt: job.startedAt - 1, reportId: SECRET, report: SECRET };
    jobs.runners = { state: vi.fn(() => state), alive: vi.fn(() => true), send: control, kill: vi.fn() };
  }
  if (reason === "control_lock_busy") vi.mocked(metadataFileLease).mockImplementation(() => {
    throw Object.assign(new Error("synthetic contention"), { code: "ELEASEBUSY" });
  });
}

it.each(reasons)("labels the real %s refusal without new queue, launch, control or durable writes", reason => {
  prepare(reason);
  const bytes = retainFixture(), queue = [...job.queue], controller = job.controller, turn = job.startedAt;
  const persist = vi.spyOn(jobs, "persist");
  const before = Date.now();
  const result = jobs.followUp(job.name, "new synthetic message");
  expect(result.outcome).toBe("stopping");
  expect(result.gate).toEqual({ reason, jobId: job.id, startedAt: turn, observedAt: expect.any(Number),
    executorIdentity: "unknown", controllerAborted: controller.signal.aborted,
    hasResume: Boolean(job.resume), hasSession: true });
  expect(result.gate!.observedAt).toBeGreaterThanOrEqual(before);
  expect(result.gate!.observedAt).toBeLessThanOrEqual(Date.now());
  expect(JSON.stringify(result.gate)).not.toContain(SECRET);
  expect(job.queue).toEqual(queue); expect(job.startedAt).toBe(turn); expect(job.controller).toBe(controller);
  expect(persist).not.toHaveBeenCalled(); expect(control).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
  expect(readFileSync(store, "utf8")).toBe(bytes);
  if (reason === "interrupted_executor_probe") expect(pidAlive).toHaveBeenCalledWith(987);
  else expect(pidAlive).not.toHaveBeenCalled();
  if (jobs.runners) expect(jobs.runners.state).toHaveBeenCalledTimes(2); // Existing reads only.
});

async function clientFor(admitCodex?: ServerContext["admitCodex"]): Promise<Client> {
  const ctx: ServerContext = { node: null, jobs, home, cfg: DEFAULT_CONFIG, agent: "codex", log: nullLogger,
    cwd: () => home, channelActive: () => false, admitCodex };
  const server = new McpServer({ name: "gate-test", version: "1" });
  registerTools(server, ctx, []);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  closes.push(async () => { await client.close(); await server.close(); });
  return client;
}

it.each(reasons)("renders only whitelisted facts for authorized MCP %s", async reason => {
  prepare(reason); const bytes = retainFixture();
  const client = await clientFor();
  const response = await client.callTool({ name: "message_subagent", arguments: { job: job.name, message: SECRET } });
  expect(response.isError).toBe(true);
  const rendered = JSON.stringify(response.content);
  expect(rendered).toContain(reason); expect(rendered).toContain("executor identity unknown");
  expect(rendered).not.toContain(SECRET);
  expect(job.queue).toEqual([SECRET]); expect(start).not.toHaveBeenCalled(); expect(control).not.toHaveBeenCalled();
  expect(readFileSync(store, "utf8")).toBe(bytes);
});

it.each([false, true])("denies foreign authority even with a %s newer durable generation", async newer => {
  job.controller.abort();
  const oldTurn = job.startedAt;
  retainFixture();
  writeFileSync(store, JSON.stringify([{ ...storedFixture(), owner: "foreign-owner", startedAt: oldTurn + (newer ? 1 : 0) }]));
  const bytes = readFileSync(store, "utf8");
  expect(jobs.followUp(job.name, SECRET)).toEqual({ outcome: "unknown" });
  const client = await clientFor();
  const response = await client.callTool({ name: "message_subagent", arguments: { job: job.name, message: SECRET } });
  expect(response.isError).toBe(true);
  expect(JSON.stringify(response.content)).not.toContain("gate observation");
  expect(JSON.stringify(response.content)).not.toContain(SECRET);
  expect(readFileSync(store, "utf8")).toBe(bytes);
  expect(job.queue).toEqual([SECRET]); expect(resume).not.toHaveBeenCalled(); expect(control).not.toHaveBeenCalled();
});

it("keeps unverified callers denied regardless of caller-supplied session text", async () => {
  prepare("cancellation_guard_no_resume");
  const client = await clientFor(() => false);
  const followUp = vi.spyOn(jobs, "followUp");
  const response = await client.callTool({ name: "message_subagent", arguments: { job: job.name, message: SECRET },
    _meta: { sessionId: "owner-session", threadId: "owner-session" } });
  expect(response.isError).toBe(true); expect(followUp).not.toHaveBeenCalled();
  expect(JSON.stringify(response.content)).not.toContain("gate observation");
});

it("preserves a valid active executor and never reuses an earlier refusal", () => {
  job.resume = undefined; job.controller.abort();
  expect(jobs.followUp(job.name, "refused").gate?.reason).toBe("cancellation_guard_no_resume");
  job.startedAt += 1; job.controller = new AbortController(); job.live = { post: control };
  const controller = job.controller, queue = [...job.queue];
  const result = jobs.followUp(job.name, "active message");
  expect(result).toMatchObject({ outcome: "delivered" }); expect(result.gate).toBeUndefined();
  expect(control).toHaveBeenCalledExactlyOnceWith("active message");
  expect(job.status).toBe("running"); expect(job.controller).toBe(controller);
  expect(controller.signal.aborted).toBe(false); expect(job.queue).toEqual(queue); expect(start).not.toHaveBeenCalled();
});
