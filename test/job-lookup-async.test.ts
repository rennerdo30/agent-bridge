import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import * as recovery from "../src/core/job-recovery.js";
import * as feeds from "../src/core/job-recovery-feed.js";
import * as relay from "../src/core/relay.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import { JobManager, type Job } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { registerTools } from "../src/mcp/server.js";
import { attachDashboardJobControl } from "../src/mcp/dashboard-control.js";
import type { BridgeMessage } from "../src/core/protocol.js";

let home: string;
const managers: JobManager[] = [], clients: Client[] = [], servers: McpServer[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ab-lookup-async-")); });
afterEach(async () => {
  for (const manager of managers.splice(0)) { manager.setDormant(true); manager.cancelAll(); }
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
  // Retain these synthetic fixtures, including any failed asynchronous lookup witness.
});
function manager(owner = "owner", parentJob?: string) {
  const node = new LocalCoordinator(owner, "root-session");
  const jobs = new JobManager(node, nullLogger, join(home, "jobs.json"), 2,
    parentJob ? { parentJob, rootSession: "root-session", rootName: "owner", escalate: async () => {} } : undefined);
  managers.push(jobs);
  jobs.restore(() => () => async () => ({ sessionId: "retained-native", text: "continued", isError: false, details: {} }));
  return { jobs, node };
}
function fixture(id = "lookupfixture", prompt = "exact retained context", owner = "owner", parentJob?: string) {
  const name = `codex-job-${id}`;
  mkdirSync(join(home, "runs"), { recursive: true });
  const run = join(home, "runs", `2026-10-08-01-02-03-codex-${id}`);
  writeFileSync(`${run}.json`, JSON.stringify({ job: name, by: owner, session: "retained-native", workdir: home, byCwd: home, parentJob, access: "read" }));
  writeFileSync(`${run}.log`, `01:02:03 running by ${owner}\n         ${prompt}\n         ---\n${"retained body\n".repeat(1_500_000)}`);
  return { id, name, prompt };
}
const saved = (id: string, owner = "owner", extra = {}) => ({ id, name: `codex-job-${id}`, agent: "codex", model: null,
  owner, status: "done", startedAt: 2, sessionId: "latest-native", prompt: "latest exact context", workdir: home, worktree: null, ...extra });
const registry = (jobs: unknown[]) => writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: 4, jobs }));
function holdHeader() {
  let entered!: () => void, release!: (value: { header: string; prompt: string }) => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(feeds, "readRecoveryHeader").mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  return { ready, release: (prompt = "exact retained context") => release({ header: "running by owner", prompt }) };
}
async function connect(jobs: JobManager, node: LocalCoordinator) {
  Object.assign(node, { setNotificationWaitHandlers: vi.fn() });
  const server = new McpServer({ name: "lookup-test", version: "0" }); servers.push(server);
  registerTools(server, { agent: "codex", cfg: { ...DEFAULT_CONFIG }, node: node as unknown as BridgeNode, jobs,
    home, cwd: () => home, channelActive: () => false, log: nullLogger }, []);
  const client = new Client({ name: "lookup-test", version: "0" }); clients.push(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

it("keeps a large missing-prompt MCP approval lookup responsive before broker authority", async () => {
  const { jobs, node } = manager();
  const f = fixture("largerequest", "exact context ".repeat(80_000));
  const synchronous = vi.spyOn(recovery, "recoverJobRecord").mockImplementation(() => { throw new Error("full synchronous feed fallback forbidden on requests"); });
  let beats = 0, ticking = true;
  const tick = () => { if (ticking) { beats++; setImmediate(tick); } };
  setImmediate(tick);
  const authority = vi.fn(async () => { expect(beats).toBeGreaterThan(1); expect(synchronous).not.toHaveBeenCalled(); return saved(f.id); });
  Object.assign(node, { jobAuthority: authority });
  const approvalId = "00000000-0000-4000-8000-000000000001";
  vi.spyOn(relay, "listPendingApprovals").mockReturnValue([{ id: approvalId, job: f.name }] as ReturnType<typeof relay.listPendingApprovals>);
  vi.spyOn(relay, "answerPendingApproval").mockResolvedValue("answered");
  const client = await connect(jobs, node);
  try {
    const result = await client.callTool({ name: "decide", arguments: { approval_id: approvalId, decision: "allow" } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(authority).toHaveBeenCalledWith(f.name);
    expect(jobs.find(f.name)?.prompt).toBe(f.prompt);
  } finally { ticking = false; }
});

it("uses current durable ownership instead of stale context after asynchronous recovery", async () => {
  const { jobs } = manager(); const f = fixture(); const held = holdHeader();
  const lookup = jobs.findAsync(f.name); await held.ready;
  registry([saved(f.id, "new-owner")]); held.release();
  expect(await lookup).toBeUndefined();
  expect(jobs.find(f.name)).toBeUndefined();
});

it.each([undefined, "owner"])("preserves a live turn with executionOwner %s that appears during old-context recovery", async executionOwner => {
  const { jobs } = manager(); const f = fixture(); const held = holdHeader();
  const lookup = jobs.findAsync(f.name); await held.ready;
  const live = jobs.start("codex", null, "actual current context", async () => new Promise(() => {}));
  // Publish the recovered name as this real held runtime generation; no second run is launched.
  const internals = jobs as unknown as { history: Map<string, Job>; running: Map<string, Job> };
  internals.history.delete(live.id); internals.running.delete(live.id);
  live.id = f.id; live.name = f.name; live.queue.push("accepted current message");
  live.executionOwner = executionOwner;
  internals.history.set(live.id, live); internals.running.set(live.id, live);
  const controller = live.controller;
  registry([saved(f.id, "owner", { status: "running", startedAt: live.startedAt, prompt: "stale saved execution context", executionOwner })]);
  held.release();
  expect(await lookup).toBe(live);
  expect(live.controller).toBe(controller); expect(controller.signal.aborted).toBe(false);
  expect(live.prompt).toBe("actual current context"); expect(live.queue).toEqual(["accepted current message"]);
});

it("rechecks outcome ownership after the final async lookup promise boundary without synchronous recovery", async () => {
  const { jobs, node } = manager(); const record = saved("finalboundary"); registry([record]);
  const original = jobs.find(record.name)!;
  const events: unknown[] = [], originalFind = jobs.find.bind(jobs);
  vi.spyOn(jobs, "find").mockImplementation((ref, recover) => {
    const result = originalFind(ref, recover); events.push({ event: "find", recover, owner: result?.owner }); return result;
  });
  vi.spyOn(jobs, "findAsync").mockImplementation(async () => {
    queueMicrotask(() => { registry([{ ...record, owner: "new-owner", masters: ["new-owner"] }]); events.push({ event: "handoff" }); });
    return original;
  });
  const synchronous = vi.spyOn(recovery, "recoverJobRecord").mockImplementation(() => { throw new Error("synchronous request fallback forbidden"); });
  const client = await connect(jobs, node);
  const result = await client.callTool({ name: "set_job_outcome", arguments: { job: record.name, state: "held", reason: "synthetic review" } });
  expect(result.isError, JSON.stringify({ result, stored: JSON.parse(readFileSync(join(home, "jobs.json"), "utf8")),
    events, calls: vi.mocked(jobs.findAsync).mock.calls })).toBe(true); expect(JSON.stringify(result)).toContain("Unknown job");
  expect(synchronous).not.toHaveBeenCalled();
});

it.each<{ owner: string; parentJob?: string; lineage?: string }>([{ owner: "owner" }, { owner: "foreign" },
  { owner: "owner", parentJob: "parent" }, { owner: "foreign", parentJob: "parent", lineage: "parent" },
  { owner: "owner", parentJob: "other", lineage: "parent" }])("matches offline lookup permission/lineage and exact recovery context for %j", async input => {
  const { jobs: responsive } = manager("owner", input.lineage), { jobs: offline } = manager("owner", input.lineage);
  const f = fixture("parity", "exact retained context", input.owner, input.parentJob);
  const asyncJob = await responsive.findAsync(f.name), syncJob = offline.find(f.name);
  const projection = (job?: Job) => job && ({ name: job.name, owner: job.owner, prompt: job.prompt, sessionId: job.sessionId,
    workdir: job.workdir, worktree: job.worktree, args: job.args, status: job.status, parentJob: job.parentJob });
  expect(projection(asyncJob)).toEqual(projection(syncJob));
});

it.each(["send", "set_job_outcome"])("uses responsive retained lookup for the %s MCP request", async name => {
  const { jobs, node } = manager(); const f = fixture();
  const synchronous = vi.spyOn(recovery, "recoverJobRecord").mockImplementation(() => { throw new Error("synchronous request fallback forbidden"); });
  const client = await connect(jobs, node);
  const result = await client.callTool({ name, arguments: name === "send" ? { to: f.name, message: "hello" } : { job: f.name, state: "held", reason: "synthetic review" } });
  expect(synchronous).not.toHaveBeenCalled();
  expect(jobs.find(f.name)?.prompt).toBe(f.prompt);
  if (name === "send") expect(result.isError).not.toBe(true);
  else expect(JSON.stringify(result)).toContain("Only finished jobs"); // Recovery does not fabricate completion.
});

it("uses asynchronous lookup when broker authority is absent and does not retry a synchronous unknown lookup", async () => {
  const { jobs, node } = manager(); const f = fixture();
  Object.assign(node, { jobAuthority: async () => null });
  const synchronous = vi.spyOn(recovery, "recoverJobRecord").mockImplementation(() => { throw new Error("synchronous request fallback forbidden"); });
  expect((await jobs.share(f.name))?.prompt).toBe(f.prompt);
  const client = await connect(jobs, node);
  for (const name of ["message_subagent", "cancel_subagent"]) {
    expect((await client.callTool({ name, arguments: { job: "codex-job-missing" } })).isError).toBe(true);
  }
  expect(synchronous).not.toHaveBeenCalled();
});

it.each(["owner", "foreign-executor"])("revokes a changed captured shared grant with executionOwner %s before lookup or adoption", async executionOwner => {
  const { jobs, node } = manager();
  const active = jobs.start("codex", null, "actual held context", async () => new Promise(() => {}));
  active.queue.push("accepted held message");
  const controller = active.controller;
  const original = saved(active.id, "foreign-owner", { status: "running", startedAt: active.startedAt,
    executionOwner, prompt: "saved authority context", masters: ["foreign-master"],
    ownershipHistory: [{ from: "former-foreign", to: "foreign-owner" }] });
  registry([original]);
  Object.assign(node, { jobAuthority: async () => original });
  const shared = await jobs.share(active.name); // Broker grants this project master access.
  expect(shared).toBeDefined();
  if (executionOwner === "owner") expect(shared).toBe(active);
  expect((jobs as unknown as { sharedGrants: Set<string> }).sharedGrants.has(active.id)).toBe(true);
  const revoked = { ...original, owner: "new-foreign-owner", masters: ["new-foreign-master"],
    ownershipHistory: [{ from: "other-foreign", to: "new-foreign-owner" }] };
  registry([revoked]);
  expect(await jobs.findAsync(active.name)).toBeUndefined();
  expect(jobs.find(active.name, false)).toBeUndefined();
  expect((jobs as unknown as { sharedGrants: Set<string> }).sharedGrants.has(active.id)).toBe(false);
  expect(controller.signal.aborted).toBe(false);
  expect(active.controller).toBe(controller); expect(active.prompt).toBe("actual held context");
  expect(active.queue).toEqual(["accepted held message"]);
});

it("binds an awaited broker grant to its authorized record instead of an already-revoked durable replacement", async () => {
  const { jobs, node } = manager();
  const active = jobs.start("codex", null, "actual held context", async () => new Promise(() => {}));
  active.queue.push("accepted held message");
  const controller = active.controller;
  const authorized = saved(active.id, "foreign-owner", { status: "running", startedAt: active.startedAt,
    executionOwner: "owner", prompt: "old retained authority context", masters: ["foreign-master"],
    ownershipHistory: [{ from: "former-foreign", to: "foreign-owner" }] });
  registry([authorized]);
  let release!: (value: typeof authorized) => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  Object.assign(node, { jobAuthority: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const lookup = jobs.share(active.name); await ready;
  registry([{ ...authorized, owner: "new-foreign-owner", masters: ["new-foreign-master"],
    ownershipHistory: [{ from: "other-foreign", to: "new-foreign-owner" }] }]);
  release(authorized);
  expect(await lookup).toBeUndefined();
  expect(await jobs.findAsync(active.name)).toBeUndefined();
  expect(jobs.find(active.name, false)).toBeUndefined();
  expect((jobs as unknown as { sharedGrants: Set<string> }).sharedGrants.has(active.id)).toBe(false);
  expect(active.controller).toBe(controller); expect(controller.signal.aborted).toBe(false);
  expect(active.prompt).toBe("actual held context"); expect(active.queue).toEqual(["accepted held message"]);
});

it("keeps an unchanged permission witness through a normal saved native continuation and metadata update", async () => {
  const { jobs, node } = manager();
  const authorized = saved("validgrant", "foreign-owner", { metadataVersion: 1,
    ownershipHistory: [{ from: "former-foreign", to: "foreign-owner" }] });
  registry([authorized]); Object.assign(node, { jobAuthority: async () => authorized });
  expect(await jobs.share(authorized.name)).toBeDefined();
  registry([{ ...authorized, startedAt: authorized.startedAt + 1, metadataVersion: 2, prompt: "new exact native context" }]);
  expect(await jobs.findAsync(authorized.name)).toMatchObject({ startedAt: authorized.startedAt + 1, prompt: "new exact native context" });
  expect((jobs as unknown as { sharedGrants: Set<string> }).sharedGrants.has(authorized.id)).toBe(true);
});

it.each([false, true])("does not retry shared control synchronously when authorization fails (reject=%s)", async reject => {
  const { jobs, node } = manager();
  const warning = vi.fn(); (jobs as unknown as { log: typeof nullLogger }).log = { ...nullLogger, warn: warning };
  if (reject) vi.spyOn(jobs, "share").mockRejectedValue(new Error("authorization timed out"));
  else vi.spyOn(jobs, "share").mockResolvedValue(undefined);
  const synchronous = vi.spyOn(recovery, "recoverJobRecord").mockImplementation(() => { throw new Error("synchronous control fallback forbidden"); });
  const followUp = vi.spyOn(jobs, "followUp");
  node.emit("shared_job_control", { job: "codex-job-missing", control: { type: "message", body: "accepted command" } });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(followUp).not.toHaveBeenCalled(); expect(synchronous).not.toHaveBeenCalled();
  if (reject) expect(warning).toHaveBeenCalledWith("shared job control failed", expect.objectContaining({ err: "Error: authorization timed out" }));
});

it("does not recover synchronously or mutate a missing shared-control job after a stale successful authorization reply", async () => {
  const { jobs, node } = manager();
  vi.spyOn(jobs, "share").mockResolvedValue(saved("missing") as unknown as Job);
  const synchronous = vi.spyOn(recovery, "recoverJobRecord").mockImplementation(() => { throw new Error("synchronous control fallback forbidden"); });
  const followUp = vi.spyOn(jobs, "followUp");
  node.emit("shared_job_control", { job: "codex-job-missing", control: { type: "message", body: "accepted command" } });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(followUp).not.toHaveBeenCalled(); expect(synchronous).not.toHaveBeenCalled();
});

it.each([["message", false], ["settings", false], ["message", true], ["settings", true]] as const)("returns the dashboard's existing unknown result without synchronous retry for %s (old response=%s)", async (type, oldResponse) => {
  const { jobs, node } = manager(); const send = vi.fn(async (_args: { body: string }) => ({})); Object.assign(node, { send });
  attachDashboardJobControl(node as unknown as BridgeNode, jobs, nullLogger);
  vi.spyOn(jobs, "share").mockResolvedValue(oldResponse ? saved("missing") as unknown as Job : undefined);
  const synchronous = vi.spyOn(recovery, "recoverJobRecord").mockImplementation(() => { throw new Error("synchronous dashboard fallback forbidden"); });
  node.emit("job_control", { id: "synthetic-command", from: { name: "dashboard" }, body: JSON.stringify({ requestId: "synthetic-request",
    job: "codex-job-missing", type, body: "accepted message", settings: { effort: "high" } }) } as BridgeMessage);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.parse(send.mock.calls[0]![0]!.body)).toMatchObject({ type: "result", requestId: "synthetic-request", outcome: "unknown", isError: true });
  expect(synchronous).not.toHaveBeenCalled();
});
