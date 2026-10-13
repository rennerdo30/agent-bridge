import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi, type Mock, type MockInstance } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { metadataFileLease } from "../src/core/metadata-file-lease.js";
import { JobManager, type FollowUpGate, type Job, type Resume, type Run, type RunnerState } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { registerTools, type ServerContext } from "../src/mcp/server.js";

// Mock external probes/leases, never the decision branches or their authorization.
vi.mock("../src/core/metadata-file-lease.js", () => ({ metadataFileLease: vi.fn(() => vi.fn()) }));

const SECRET = "synthetic-private-content-must-not-escape";
const reasons: FollowUpGate["reason"][] = ["control_lock_busy", "interrupted_executor_probe",
  "cancellation_guard_foreign_or_unowned", "cancellation_guard_no_resume", "runner_terminal_not_settled"];
let jobs: JobManager, job: Job, home: string, store: string;
let resume: Mock<Resume>, control: Mock<(...args: unknown[]) => Promise<void>>, start: Mock<Run>;
let probe: MockInstance<typeof process.kill>;
const closes: (() => Promise<void>)[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(metadataFileLease).mockImplementation(() => vi.fn());
  probe = vi.spyOn(process, "kill").mockImplementation(() => true);
  home = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "follow-up-gate-"));
  store = join(home, "jobs.json");
  const node = new LocalCoordinator("owner", "owner-session");
  control = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
  Object.assign(node, { controlInlineJob: control });
  jobs = new JobManager(node, nullLogger);
  start = vi.fn<Run>(async () => ({ text: SECRET, sessionId: SECRET, isError: false, details: {} }));
  resume = vi.fn<Resume>(() => start);
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
  Object.defineProperty(jobs, "storePath", { value: store, configurable: true });
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
  expect(result.gate).toEqual({ reason, jobId: job.id, observedLocalStartedAt: turn, durableTurn: "unknown", observedAt: expect.any(Number),
    executorIdentity: "unknown", controllerAborted: controller.signal.aborted,
    hasResume: Boolean(job.resume), hasSession: true });
  expect(result.gate!.observedAt).toBeGreaterThanOrEqual(before);
  expect(result.gate!.observedAt).toBeLessThanOrEqual(Date.now());
  expect(JSON.stringify(result.gate)).not.toContain(SECRET);
  expect(job.queue).toEqual(queue); expect(job.startedAt).toBe(turn); expect(job.controller).toBe(controller);
  expect(persist).not.toHaveBeenCalled(); expect(control).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
  expect(readFileSync(store, "utf8")).toBe(bytes);
  if (reason === "interrupted_executor_probe") expect(probe).toHaveBeenCalledWith(987, 0);
  else expect(probe).not.toHaveBeenCalled();
  if (jobs.runners) expect(jobs.runners.state).toHaveBeenCalledTimes(2); // Existing reads only.
});

async function clientFor(admitCodex?: ServerContext["admitCodex"]): Promise<Client> {
  const ctx: ServerContext = { node: null, jobs, home, cfg: DEFAULT_CONFIG, agent: "codex", log: nullLogger,
    cwd: () => home, channelActive: () => false, admitCodex };
  const server = new McpServer({ name: "gate-test", version: "1" });
  // Registration ordinarily restores/persists saved jobs. That is fixture setup,
  // outside the rejection under test; install the durable fixture only afterward.
  Object.defineProperty(jobs, "storePath", { value: null, configurable: true });
  registerTools(server, ctx, []);
  // The controlled fake run has no startup restoration factory.
  jobs.restore(() => undefined);
  Object.defineProperty(jobs, "storePath", { value: store, configurable: true });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  closes.push(async () => { await client.close(); await server.close(); });
  return client;
}

it.each(reasons)("renders only whitelisted facts for authorized MCP %s", async reason => {
  prepare(reason); const bytes = retainFixture();
  const client = await clientFor();
  // Registration installs a generic resumer on existing jobs; the controlled
  // fixture for this gate deliberately has none at the measured command boundary.
  if (reason === "cancellation_guard_no_resume") job.resume = undefined;
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

it("labels only the cached local turn when a newer permitted durable turn is locked", async () => {
  const localTurn = job.startedAt, controller = job.controller;
  retainFixture();
  writeFileSync(store, JSON.stringify([{ ...storedFixture(), startedAt: localTurn + 100, cancellingTurn: localTurn + 100 }]));
  prepare("control_lock_busy");
  const bytes = readFileSync(store, "utf8");
  const result = jobs.followUp(job.name, SECRET);
  expect(result.gate).toMatchObject({ reason: "control_lock_busy", observedLocalStartedAt: localTurn,
    durableTurn: "unknown", executorIdentity: "unknown" });
  const client = await clientFor();
  const response = await client.callTool({ name: "message_subagent", arguments: { job: job.name, message: SECRET } });
  expect(response.isError).toBe(true);
  const rendered = JSON.stringify(response.content);
  // Existing share/findAsync rejects a stale generation before MCP metadata exposure.
  expect(rendered).not.toContain("gate observation"); expect(rendered).not.toContain(SECRET);
  expect(job.controller).toBe(controller); expect(job.startedAt).toBe(localTurn);
  expect(job.queue).toEqual([SECRET]); expect(readFileSync(store, "utf8")).toBe(bytes);
  expect(resume).not.toHaveBeenCalled(); expect(control).not.toHaveBeenCalled();
});

it.each(["interrupted_executor_probe", "control_lock_busy"] as const)("keeps a real hydrated malformed turn private at %s", async reason => {
  const record = { ...storedFixture(), status: "interrupted", executionPid: 987, startedAt: { privateMarker: SECRET } };
  jobs.cancelAll();
  jobs = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger);
  const client = await clientFor();
  writeFileSync(store, JSON.stringify([record]));
  // Exercise production retained-record hydration, not a mocked gate or timestamp.
  jobs.restore(() => undefined);
  const restored = jobs.find(record.name)!;
  expect(restored.startedAt).toEqual(record.startedAt);
  expect(restored.status).toBe("interrupted");
  if (reason === "control_lock_busy") prepare(reason);
  const bytes = readFileSync(store, "utf8"), queue = [...restored.queue], controller = restored.controller;
  const persist = vi.spyOn(jobs, "persist");
  const response = await client.callTool({ name: "message_subagent", arguments: { job: record.name, message: "check gate" } });
  expect(response.isError).toBe(true);
  const rendered = JSON.stringify(response.content);
  expect(rendered).toContain(reason); expect(rendered).not.toContain(SECRET); expect(rendered).not.toContain("privateMarker");
  const item = response.content as { type: string; text?: string }[];
  const line = item.map(part => part.text ?? "").join("\n").split("\n").find(part => part.startsWith("Local follow-up gate observation"))!;
  const gate = JSON.parse(line.slice(line.indexOf("{ ") >= 0 ? line.indexOf("{ ") : line.indexOf("{")));
  expect(gate.observedLocalStartedAt).toBeNull();
  for (const value of Object.values(gate)) expect(value === null || ["string", "number", "boolean"].includes(typeof value)).toBe(true);
  expect(restored.startedAt).toEqual(record.startedAt); expect(restored.status).toBe("interrupted");
  expect(restored.controller).toBe(controller); expect(restored.queue).toEqual(queue);
  expect(readFileSync(store, "utf8")).toBe(bytes); expect(persist).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(control).not.toHaveBeenCalled();
});
