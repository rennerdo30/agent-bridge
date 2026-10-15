import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.js";
import * as usage from "../src/core/usage.js";
import { nullLogger } from "../src/core/logger.js";
import { CODING_AGENTS } from "../src/core/protocol.js";
import { closeMetadataDbs } from "../src/core/metadata-db.js";
import * as delegate from "../src/core/delegate.js";
import * as startup from "../src/core/startup-admission.js";
import * as worktree from "../src/core/worktree.js";
import * as delegation from "../src/mcp/delegate-run.js";
import { registerTools } from "../src/mcp/server.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { JobManager, readStore, type Run, type RunnerControl, type RunnerState } from "../src/mcp/jobs.js";
import { ParentLink } from "../src/core/parent-link.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { CONTROL_CONVERSATION_PREFIX, JobRunners, type RunnerSpec } from "../src/mcp/job-host.js";
import * as jobHost from "../src/mcp/job-host.js";
import { runOwnedJobRunner } from "../src/mcp/job-runner.js";
import { BridgeNode } from "../src/core/node.js";
import { RemoteJobs } from "../src/network/remote-jobs.js";
import { RemoteJobHost } from "../src/mcp/remote-job-host.js";
import { remoteJobRequestSchema, remoteJobSnapshotSchema, remoteSpawnArgsSchema, REMOTE_JOB_USAGE_CAPABILITY } from "../src/network/remote-job-protocol.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { until } from "./helpers.js";
import * as processIdentity from "../src/core/process-identity.js";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
const actualSpawn = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawn;

let home: string;
const managers: JobManager[] = [], remotes: RemoteJobs[] = [];
const block: usage.UsageAdmission = { type: "block", reason: "usage_exhausted" };
const warn: usage.UsageAdmission = { type: "warn", reason: "low_allowance" };
const answer = { text: "native answer", sessionId: "same-session", isError: false, details: {} };
beforeEach(async () => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-provider-admission-")));
  // Usage tests need writable fixture metadata. A cold Windows identity probe
  // can fail closed and queue start(), so establish this prerequisite first.
  expect(await processIdentity.ownProcessIdentity()).toBeTruthy();
});
afterEach(() => {
  for (const jobs of managers.splice(0)) jobs.setDormant(true);
  for (const remote of remotes.splice(0)) remote.close();
  closeMetadataDbs(); vi.restoreAllMocks(); vi.useRealTimers(); vi.mocked(spawn).mockImplementation(actualSpawn); vi.unstubAllEnvs();
});
const probe = (agent = "codex" as usage.UsageProbe["agent"]): usage.UsageProbe => ({ agent, bin: process.execPath, cwd: home, home, model: "exact-model", log: nullLogger });

it("queues admission while its own identity is unavailable and starts after readiness", async () => {
  vi.useFakeTimers();
  const identity = vi.spyOn(processIdentity, "processIdentity").mockReturnValue(undefined);
  const jobs = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger, join(home, "jobs.json"), 2);
  managers.push(jobs);
  const run = vi.fn(async () => answer);
  const job = jobs.start("codex", null, "task", run);
  expect(job.waitingForStart).toBe(true);
  expect(run).not.toHaveBeenCalled();
  identity.mockRestore();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(run).toHaveBeenCalledOnce();
  expect(job.status).toBe("done");
});
const account = { requiresOpenaiAuth: true, account: { type: "chatgpt", email: "fixture@example.invalid", planType: "fixture" }, workspaceRouting: { chatgptAccountId: "fixture-account", backendOrigin: "https://chatgpt.com", accountRoutingOverride: "NO_CONSTRAINT" } };
function produced(percent: unknown, credits?: unknown, model: string | null = "exact-model") {
  return usage.codexAdmissionFacts({ accountBefore: account, accountAfter: account, config: { config: { model_provider: "openai" } },
    models: { data: [{ id: "exact-model", model: "exact-model", isDefault: true }] },
    limits: { rateLimits: { limitId: "codex", primary: { usedPercent: percent }, ...(credits === undefined ? {} : { credits: { balance: credits } }) } } }, { model }, "executor-account", 10_000);
}

it("acquires account/model/numeric facts in one app-server context and invalidates cached auth", async () => {
  vi.useFakeTimers();
  vi.stubEnv("CODEX_HOME", home);
  writeFileSync(join(home, "auth.json"), "fixture credentials one");
  let percent = 100, respond = true;
  const requests: any[] = [];
  vi.mocked(spawn).mockImplementation((() => {
    const child = Object.assign(new ChildProcess(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.on("data", chunk => {
      const m = JSON.parse(String(chunk)); if (!m.id) return;
      requests.push(m); if (!respond) return;
      const result = m.method === "account/read" ? account : m.method === "config/read" ? { config: { model_provider: "openai" } }
        : m.method === "model/list" ? { data: [{ id: "exact-model", model: "exact-model", isDefault: true }] }
        : m.method === "account/rateLimits/read" ? { rateLimits: { limitId: "codex", primary: { usedPercent: percent } } } : {};
      child.stdout.write(JSON.stringify({ id: m.id, result }) + "\n");
    });
    return child;
  }) as typeof spawn);
  let result = usage.checkUsagePreflight(probe()); await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject(block);
  result = usage.checkUsagePreflight(probe()); await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject(block);
  expect(requests.map(r => r.method)).toEqual(["initialize", "account/read", "model/list", "config/read", "account/rateLimits/read", "account/read", "initialize", "account/read", "model/list", "config/read", "account/read"]);
  writeFileSync(join(home, "auth.json"), "fixture credentials two");
  percent = 30;
  result = usage.checkUsagePreflight(probe()); await vi.advanceTimersByTimeAsync(100);
  expect((await result).type).toBe("allow");
  expect(requests).toHaveLength(17);
  expect(requests.some(r => /turn\/|thread\//.test(r.method))).toBe(false);
  writeFileSync(join(home, "auth.json"), "fixture credentials three"); respond = false;
  let finished = false;
  result = usage.checkUsagePreflight(probe()); void result.then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(2_999); expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(await result).toEqual({ type: "allow", reason: "read_failed" });
});

it("only decodes authenticated, exactly applicable numeric exhaustion", async () => {
  for (const [percent, credits, expected] of [[100, undefined, "block"], [99.9, 2, "warn"], [10, "0.000", "block"], [10, "0.2", "warn"], [101, "", "allow"], [NaN, false, "allow"]] as const) {
    const check = usage.createUsagePreflight({ now: () => 10_000, key: () => "scope", read: async () => produced(percent, credits) });
    expect((await check(probe())).type).toBe(expected);
  }
  expect(produced(100, undefined, "alias")).toBeNull();
  expect(usage.codexAdmissionFacts({ accountBefore: account, accountAfter: { account: { ...account.account, email: "changed@example.invalid" } }, models: {}, limits: {}, config: {} }, probe(), "executor", 10_000)).toBeNull();
  expect(usage.codexAdmissionFacts({ accountBefore: account, accountAfter: account, config: { config: { model_provider: "openai" } },
    models: { data: [{ id: "exact-model", model: "exact-model" }] }, limits: { rateLimitsByLimitId: { unrelated: { primary: { usedPercent: 100 } } } } }, probe(), "executor", 10_000)?.facts).toEqual([]);
});

it("deduplicates reads and warnings, expires at TTL equality, and fails open on stale/changed/failed facts", async () => {
  let now = 10_000, key = "account-one";
  const read = vi.fn(async () => produced(95));
  const check = usage.createUsagePreflight({ now: () => now, key: () => key, read });
  expect((await Promise.all([check(probe()), check(probe())])).map(r => r.type)).toEqual(["warn", "warn"]);
  expect(read).toHaveBeenCalledTimes(1);
  expect((await check(probe(), true)).type).toBe("allow");
  now += 30_000;
  expect((await check(probe())).type).toBe("allow"); // producer's old observation is stale
  expect(read).toHaveBeenCalledTimes(2);
  key = "account-two";
  read.mockRejectedValueOnce(new Error("offline"));
  expect(await check(probe())).toEqual({ type: "allow", reason: "read_failed" });
  expect(read).toHaveBeenCalledTimes(3);
  const changed = usage.createUsagePreflight({ now: () => 10_000, key: () => key, read: async () => { key = "changed-during-read"; return produced(100); } });
  expect(await changed(probe())).toEqual({ type: "allow", reason: "scope_mismatch" });
});

it("shares one deadline across cache reauthentication and a replacement quota probe", async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  const deadlines: number[] = [];
  const read = vi.fn(async (_probe: usage.UsageProbe, _observed: number, deadline: number) => {
    deadlines.push(deadline);
    if (deadlines.length > 1) await new Promise(resolve => setTimeout(resolve, 200));
    return produced(100);
  });
  const authenticate = vi.fn(async (_probe, _cached, deadline: number) => {
    deadlines.push(deadline);
    await new Promise(resolve => setTimeout(resolve, 2_900)); return false;
  });
  const check = usage.createUsagePreflight({ now: Date.now, key: () => "stable-local-config", read, authenticate });
  expect(await check(probe())).toMatchObject(block);
  let finished = false;
  const result = check(probe()); void result.then(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(2_900);
  expect(read).toHaveBeenCalledTimes(2);
  expect(deadlines).toEqual([13_000, 13_000, 13_000]);
  await vi.advanceTimersByTimeAsync(99); expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toEqual({ type: "allow", reason: "read_failed" });
  await vi.advanceTimersByTimeAsync(100); // A late exhausted result cannot replace the fail-open decision.
  expect(await result).toEqual({ type: "allow", reason: "read_failed" });
});

function handlers() {
  const callbacks = new Map<string, (args: any, extra: any) => Promise<any>>();
  const jobs = { canStart: () => true, restore: () => {}, persist: vi.fn(), limit: 4,
    start: vi.fn((..._args: any[]) => ({ id: "fixture", name: "fixture-job", startedAt: 100, args: {} })),
    track: vi.fn((..._args: any[]) => ({ job: { id: "fixture", name: "fixture-job", startedAt: 100, args: {}, controller: new AbortController() }, onProgress: () => {}, end: vi.fn() })) };
  registerTools({ registerTool: (name: string, _config: unknown, cb: any) => callbacks.set(name, cb) } as any,
    { agent: "claude", cfg: DEFAULT_CONFIG, log: nullLogger, node: null, home, cwd: () => home, channelActive: () => false, jobs: jobs as any }, [...CODING_AGENTS]);
  return { jobs, call: (tool: string, args: any = {}) => callbacks.get(tool)!({ title: "Fixture", prompt: "task", ...args }, { signal: new AbortController().signal, sendNotification: async () => {} }) };
}
it.each(CODING_AGENTS)("%s ask/spawn block before tracking/start; low warns once without changing the model", async agent => {
  const read = vi.spyOn(usage, "checkUsagePreflight").mockResolvedValue(block);
  const run = vi.spyOn(delegation, "runDelegate").mockResolvedValue(answer);
  const h = handlers();
  expect((await h.call(`ask_${agent}`)).isError).toBe(true);
  expect((await h.call(`spawn_${agent}`)).isError).toBe(true);
  expect(h.jobs.track).not.toHaveBeenCalled(); expect(h.jobs.start).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  read.mockResolvedValue(warn);
  const ask = await h.call(`ask_${agent}`, { model: "selected-model" });
  expect(ask.content[0].text.match(/allowance is low/g)).toHaveLength(1);
  expect(run.mock.calls[0]![2].model).toBe("selected-model");
  const spawn = await h.call(`spawn_${agent}`, { model: "selected-model" });
  expect(spawn.content[0].text.match(/allowance is low/g)).toHaveLength(1);
  expect(h.jobs.start.mock.calls[0]![1]).toBe("selected-model");
  expect(read.mock.calls.every(([p]) => p.agent === agent)).toBe(true);
  read.mockResolvedValue({ type: "allow", reason: "read_failed" });
  expect((await h.call(`ask_${agent}`, { model: "selected-model" })).isError).not.toBe(true);
  expect((await h.call(`spawn_${agent}`, { model: "selected-model" })).isError).not.toBe(true);
});

it("checks again after startup admission before invoking a native adapter", async () => {
  let admitted = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(startup, "acquireStartup").mockImplementation(async () => { admitted = true; await gate; return () => {}; });
  const check = vi.spyOn(usage, "checkUsagePreflight").mockResolvedValue(block);
  vi.spyOn(worktree, "gitDirsOutside").mockResolvedValue([]);
  const run = vi.spyOn(DELEGATION_TARGETS.codex, "run").mockResolvedValue(answer);
  const call = delegation.runDelegate({ agent: "claude", cfg: DEFAULT_CONFIG, home, log: nullLogger, me: () => "owner", cwd: () => home }, "codex",
    { title: "Late fixture", prompt: "original task", model: "selected-model" }, new AbortController().signal, undefined, false);
  const rejected = expect(call).rejects.toThrow("Provider usage exhausted");
  await until(() => admitted);
  expect(check).not.toHaveBeenCalled();
  release(); await rejected;
  expect(run).not.toHaveBeenCalled();
  expect(check.mock.calls[0]![0].model).toBe("selected-model");
});

it("persists a refused turn, retains its queue across restore, and resumes only on explicit follow-up", async () => {
  const path = join(home, "jobs.json"), node = new LocalCoordinator("owner", "owner-session");
  let jobs = new JobManager(node, nullLogger, path, 2); managers.push(jobs);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const resume = vi.fn((..._args: any[]) => async () => answer);
  const job = jobs.start("codex", "selected-model", "task", async (_signal, _progress, current) => {
    current.sessionId = "same-session";
    await gate;
    current.providerUsage = { turnStartedAt: current.startedAt, decision: block, warningReported: false };
    throw new Error(usage.usageAdmissionText(block));
  }, resume);
  await until(() => job.sessionId === "same-session");
  jobs.followUp(job.name, "retained steering");
  finish(); await until(() => job.status === "failed");
  expect(job.queue).toEqual(["retained steering"]); expect(resume).not.toHaveBeenCalled();
  jobs.persist();
  expect(readStore(path).find(j => j.id === job.id)?.providerUsage?.decision).toEqual(block);
  jobs.setDormant(true);
  jobs = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger, path, 2); managers.push(jobs);
  jobs.restore(() => resume);
  await until(() => Boolean(jobs.find(job.name, false)));
  const restored = jobs.find(job.name, false)!;
  expect(restored.queue).toEqual(["retained steering"]); expect(resume).not.toHaveBeenCalled();
  jobs.followUp(job.name, "explicit continuation");
  await until(() => resume.mock.calls.length === 1);
  expect(resume.mock.calls[0]![0]).toBe("retained steering\n\nexplicit continuation");
});

it("restores ACKed hosted steering by control ID, preserving identical bodies once per accepted control", async () => {
  const path = join(home, "jobs.json");
  let jobs = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger, path, 2); managers.push(jobs);
  let alive = true;
  let state: RunnerState = { pid: 123, peer: "fixture-runner", updatedAt: Date.now(), status: "running", sessionId: "same-session" };
  const send = vi.fn((_job: unknown, _control: RunnerControl) => {});
  jobs.runners = { state: () => state, alive: () => alive, send, kill: () => {} };
  const resume = vi.fn((..._args: any[]) => async () => answer);
  const inline = vi.fn(async () => answer);
  const run: Run = Object.assign(inline, { hosted: () => ({ pid: 123, peer: "fixture-runner", startedAt: Date.now() }) });
  const job = jobs.start("codex", "selected-model", "task", run, resume);
  expect(inline).not.toHaveBeenCalled();
  for (const body of ["identical steering", "identical steering", "unseen steering"]) jobs.followUp(job.name, body);
  const controls = send.mock.calls.map(([, control]) => control).filter((c): c is Extract<RunnerControl, { type: "message" }> => c.type === "message");
  expect(controls).toHaveLength(3);
  const link = new ParentLink("owner", () => {}, nullLogger);
  for (const control of controls.slice(0, 2)) link.post(control.body, undefined, control.cid);
  const pending = await link.closeMessages();
  expect(pending.map(m => m.controlId)).toEqual(controls.slice(0, 2).map(c => c.cid));
  const retainedControls = pending.map(m => ({ cid: m.controlId!, body: m.body }));
  state = remoteJobSnapshotSchema.parse({ alive: false, approvals: [], state: { ...state, status: "failed", report: "usage refusal", delivered: true,
    seen: controls.slice(0, 2).map(c => c.cid), providerUsage: { turnStartedAt: job.startedAt, decision: block, warningReported: false,
      retainedControls: [...retainedControls, retainedControls[0]!] } } }).state!;
  alive = false;
  (jobs as any).checkHosted(job);
  expect(job.status).toBe("failed");
  expect(job.queue).toEqual(["identical steering", "identical steering", "unseen steering"]);
  expect(resume).not.toHaveBeenCalled();
  expect(readStore(path).find(j => j.id === job.id)?.queuedMessages).toEqual(job.queue);
  jobs.setDormant(true);
  jobs = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger, path, 2); managers.push(jobs);
  jobs.restore(() => resume);
  const restored = jobs.find(job.name, false)!;
  expect(restored.queue).toEqual(["identical steering", "identical steering", "unseen steering"]);
  expect(resume).not.toHaveBeenCalled();
  jobs.followUp(job.name, "explicit continuation");
  await until(() => resume.mock.calls.length === 1);
  expect(resume.mock.calls[0]![0]).toBe("identical steering\n\nidentical steering\n\nunseen steering\n\nexplicit continuation");
  const legacy = new ParentLink("owner", () => {}, nullLogger); legacy.post("legacy body");
  expect(await legacy.close()).toEqual(["legacy body"]);
});

it("retains a runner's submitted continuation through late refusal and an explicitly refused retry", async () => {
  let runnerNode!: BridgeNode;
  vi.spyOn(BridgeNode.prototype, "start").mockImplementation(async function (this: BridgeNode) { runnerNode = this; });
  vi.spyOn(BridgeNode.prototype, "stop").mockResolvedValue();
  vi.spyOn(BridgeNode.prototype, "updateJob").mockResolvedValue();
  vi.spyOn(BridgeNode.prototype, "markRead").mockImplementation(() => {});
  vi.spyOn(BridgeNode.prototype, "send").mockResolvedValue({ deliveredTo: ["owner"], queuedFor: [] } as any);
  vi.spyOn(startup, "acquireStartup").mockResolvedValue(() => {});
  vi.spyOn(worktree, "gitDirsOutside").mockResolvedValue([]);
  const check = vi.spyOn(usage, "checkUsagePreflight").mockResolvedValue(block);
  const native = vi.spyOn(DELEGATION_TARGETS.codex, "run").mockResolvedValue(answer);
  const path = join(home, "jobs.json"), jobs = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger, path, 2);
  managers.push(jobs);
  let alive = true;
  let state: RunnerState = { pid: process.pid, peer: "fixture-runner", updatedAt: Date.now(), status: "running" };
  vi.spyOn(jobHost, "writeRunnerState").mockImplementation((_home, _id, value) => { state = structuredClone(value); });
  const send = vi.fn((_job: unknown, _control: RunnerControl) => {});
  jobs.runners = { state: () => state, alive: () => alive, send, kill: () => {} };
  const originalDelegate = delegation.runDelegate;
  const args = { cwd: home, prompt: "task", title: "Fixture", access: "read" as const, model: "selected-model" };
  const resume = vi.fn((message: string) => async (signal: AbortSignal, progress: any, current: any) => originalDelegate(
    { agent: "claude", cfg: DEFAULT_CONFIG, home, log: nullLogger, me: () => "owner", cwd: () => home, jobs }, "codex", { ...args, prompt: message, session_id: "same-session" }, signal, progress, true, current));
  const run: Run = Object.assign(async () => answer, { hosted: () => ({ pid: process.pid, peer: "fixture-runner", startedAt: Date.now() }) });
  const job = jobs.start("codex", "selected-model", "task", run, resume);
  jobs.followUp(job.name, "accepted continuation");
  const control = send.mock.calls[0]![1];
  let turns = 0;
  vi.spyOn(delegation, "runDelegate").mockImplementation(async (...call) => {
    if (++turns !== 1) return originalDelegate(...call);
    runnerNode.emit("message", { id: "fixture-control", from: { id: "owner-session", name: "owner", agent: "claude" }, to: job.name, recipient: job.name,
      conversationId: `${CONTROL_CONVERSATION_PREFIX}${job.id}`, replyTo: null, hop: 0, readAt: null, body: JSON.stringify(control), createdAt: Date.now() });
    await until(() => call[6]!.queue.length === 1);
    return answer;
  });
  const spec: RunnerSpec = { home, target: "codex", args, base: args, job: { ...job, allowedServers: [] }, owner: "owner", byAgent: "claude", cwd: home, cfg: DEFAULT_CONFIG };
  expect(await runOwnedJobRunner(spec, nullLogger, null)).toBe(0);
  expect(turns).toBe(2); expect(native).not.toHaveBeenCalled();
  expect(state.providerUsage?.retainedControls).toContainEqual({ cid: (control as any).cid, body: "accepted continuation" });
  alive = false; (jobs as any).checkHosted(job);
  expect(job.queue).toEqual(["accepted continuation"]); expect(resume).not.toHaveBeenCalled();
  jobs.followUp(job.name, "explicit retry");
  await until(() => job.status === "failed");
  expect(job.queue).toEqual(["accepted continuation", "explicit retry"]);
  expect(readStore(path).find(saved => saved.id === job.id)?.queuedMessages).toEqual(job.queue);
  check.mockResolvedValue({ type: "allow", reason: "allowance_available" });
  jobs.followUp(job.name, "allowance restored");
  await until(() => job.status === "done");
  expect(native).toHaveBeenCalledTimes(1); expect(job.queue).toEqual([]);
  expect(resume.mock.calls.map(([message]) => message)).toEqual(["accepted continuation\n\nexplicit retry", "accepted continuation\n\nexplicit retry\n\nallowance restored"]);
});

it("correlates a later hosted usage refusal by run identity while excluding another generation", () => {
  const jobs = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger, join(home, "jobs.json"), 2); managers.push(jobs);
  let alive = true;
  let state: RunnerState = { pid: 123, peer: "fixture-runner", updatedAt: Date.now(), status: "running", sessionId: "same-session" };
  const send = vi.fn((_job: unknown, _control: RunnerControl) => {});
  jobs.runners = { state: () => state, alive: () => alive, send, kill: () => {} };
  const resume = vi.fn((..._args: any[]) => async () => answer);
  const run: Run = Object.assign(async () => answer, { hosted: () => ({ pid: 123, peer: "fixture-runner", startedAt: Date.now() }) });
  const job = jobs.start("codex", null, "task", run, resume);
  state.providerUsage = { runId: "another-run", turnStartedAt: job.startedAt, decision: block, warningReported: false };
  (jobs as any).checkHosted(job); expect(job.providerUsage).toBeUndefined();
  jobs.followUp(job.name, "ACKed on later turn"); jobs.followUp(job.name, "unseen on later turn");
  const control = send.mock.calls[0]![1] as Extract<RunnerControl, { type: "message" }>;
  // The supervisor's submitted batch was consumed during an earlier internal turn.
  job.usagePendingControls = [{ cid: "consumed-on-first-turn", body: "already executed" }];
  const submitted = { cid: "submitted-before-late-control", body: "pending continuation batch" };
  state = { ...state, status: "failed", delivered: true, seen: [control.cid], providerUsage: { runId: job.usageRunId,
    turnStartedAt: job.startedAt + 10_000, decision: block, warningReported: false, admittedControls: ["consumed-on-first-turn"], retainedControls: [submitted, control] } };
  alive = false; (jobs as any).checkHosted(job);
  expect(usage.usageRefused(job)).toBe(true); expect(job.status).toBe("failed");
  expect(job.queue).toEqual(["pending continuation batch", "ACKed on later turn", "unseen on later turn"]); expect(resume).not.toHaveBeenCalled();
});

it("keeps submitted remote CIDs pending across refusal and restore until executor admission confirms them", async () => {
  const executorHome = join(home, "executor"); mkdirSync(executorHome);
  writeFileSync(join(executorHome, "config.json"), JSON.stringify({ version: 4, maxJobs: 16, network: { ...DEFAULT_NETWORK_CONFIG,
    remoteJobs: { enabled: true, allowRoots: [home], agents: ["codex"], allowPeers: ["paired"] } } }));
  vi.spyOn(delegate, "bundledCli").mockReturnValue("fixture-cli");
  vi.spyOn(worktree, "gitDirsOutside").mockResolvedValue([]);
  const check = vi.spyOn(usage, "checkUsagePreflight").mockResolvedValue({ type: "allow", reason: "allowance_available" });
  let executorState: RunnerState | null = null;
  vi.spyOn(jobHost, "readRunnerState").mockImplementation(() => executorState);
  vi.spyOn(JobRunners.prototype, "alive").mockImplementation(() => false);
  const start = vi.spyOn(JobRunners.prototype, "startAsync").mockImplementation(async current => {
    // This runner protocol ACK models the same admission boundary exercised by the real-loop fixture.
    usage.confirmUsageAdmission(current, (current.usagePendingControls ?? []).map(control => control.cid));
    executorState = { pid: 0, peer: current.name, updatedAt: Date.now(), status: "done", delivered: true,
      sessionId: "remote-session", workdir: home, providerUsage: structuredClone(current.providerUsage), usageSubmission: usage.usageSubmissionReceipt(current) };
    return { pid: 0, peer: current.name, startedAt: Date.now() };
  });
  const executor = new RemoteJobs({ registerExtension() {} } as any, executorHome, nullLogger, async () => {}); remotes.push(executor);
  const requests: any[] = [];
  const node = new LocalCoordinator("owner", "owner-session");
  const remoteNode = { remoteJob: async (_host: string, raw: any) => {
    const request = remoteJobRequestSchema.parse(JSON.parse(JSON.stringify(raw))); requests.push(request);
    return remoteJobSnapshotSchema.parse(await (executor as any).handle({ id: "pair", name: "paired" }, { id: "owner-session", name: "owner", supervisor: "owner-session" }, request));
  } };
  const host = new RemoteJobHost(remoteNode as any, home, nullLogger);
  const path = join(home, "jobs.json"), jobs = new JobManager(node, nullLogger, path, 2); managers.push(jobs);
  jobs.runners = { state: current => host.state(current), alive: current => host.alive(current), send: (current, control) => host.send(current, control), kill() {} };
  const args = { cwd: home, prompt: "task", title: "Remote fixture", model: "selected-model", access: "read" as const, sandbox: "read-only" };
  const runFor = (prompt: string): Run => Object.assign(async () => answer, { hosted: (current: any) => host.start(current, "paired", "codex", { ...args, prompt }) });
  const resume = vi.fn((message: string) => runFor(message));
  const job = jobs.start("codex", args.model, "task", runFor("task"), resume);
  await until(() => host.state(job)?.status === "done"); (jobs as any).checkHosted(job);
  expect(job.status).toBe("done"); expect(start).toHaveBeenCalledTimes(1);
  check.mockResolvedValue(block);
  jobs.followUp(job.name, "remote steering");
  const submitted = structuredClone(job.usagePendingControls!);
  expect(submitted).toHaveLength(1); expect(job.queue).toEqual([]);
  await until(() => host.state(job)?.status === "failed"); (jobs as any).checkHosted(job);
  expect(job.queue).toEqual(["remote steering"]); expect(job.usagePendingControls).toEqual(submitted);
  expect(host.state(job)?.providerUsage?.retainedControls).toEqual(submitted);
  expect(requests.filter(request => request.op === "spawn")[1].usageControls).toEqual(submitted);
  expect(start).toHaveBeenCalledTimes(1); expect(resume).toHaveBeenCalledTimes(1);
  expect(readStore(path).find(saved => saved.id === job.id)?.usagePendingControls).toEqual(submitted);
  jobs.setDormant(true);
  const restoredJobs = new JobManager(node, nullLogger, path, 2); managers.push(restoredJobs); restoredJobs.runners = jobs.runners;
  restoredJobs.restore(() => resume);
  const restored = restoredJobs.find(job.name, false)!;
  expect(restored.queue).toEqual(["remote steering"]); expect(restored.usagePendingControls).toEqual(submitted);
  // A reload may observe the submitted receipt before refusal settlement restored its queue view.
  restored.queue = []; restored.usagePendingHeld = undefined; restoredJobs.persist();
  restoredJobs.followUp(restored.name, "still exhausted");
  expect(restored.usagePendingControls?.[0]).toEqual(submitted[0]);
  await until(() => host.state(restored)?.status === "failed"); (restoredJobs as any).checkHosted(restored);
  expect(restored.queue).toEqual(["remote steering", "still exhausted"]); expect(start).toHaveBeenCalledTimes(1);
  check.mockResolvedValue({ type: "allow", reason: "allowance_available" });
  restoredJobs.followUp(restored.name, "allowance restored");
  expect(restored.usagePendingControls?.[0]).toEqual(submitted[0]);
  await until(() => host.state(restored)?.status === "done"); (restoredJobs as any).checkHosted(restored);
  expect(restored.status).toBe("done"); expect(restored.queue).toEqual([]); expect(restored.usagePendingControls).toBeUndefined();
  expect(start).toHaveBeenCalledTimes(2);
  expect(resume.mock.calls.map(([message]) => message)).toEqual(["remote steering", "remote steering\n\nstill exhausted", "remote steering\n\nstill exhausted\n\nallowance restored"]);
});

it("retains an internal batch when preparation throws before any admission or usage decision", async () => {
  let runnerNode!: BridgeNode;
  vi.spyOn(BridgeNode.prototype, "start").mockImplementation(async function (this: BridgeNode) { runnerNode = this; });
  vi.spyOn(BridgeNode.prototype, "stop").mockResolvedValue();
  vi.spyOn(BridgeNode.prototype, "updateJob").mockResolvedValue();
  vi.spyOn(BridgeNode.prototype, "markRead").mockImplementation(() => {});
  vi.spyOn(BridgeNode.prototype, "send").mockResolvedValue({ deliveredTo: ["owner"], queuedFor: [] } as any);
  const check = vi.spyOn(usage, "checkUsagePreflight");
  const native = vi.spyOn(DELEGATION_TARGETS.codex, "run");
  let state: RunnerState = { pid: process.pid, peer: "fixture-runner", updatedAt: Date.now(), status: "running" };
  vi.spyOn(jobHost, "writeRunnerState").mockImplementation((_home, _id, value) => { state = structuredClone(value); });
  const jobs = new JobManager(new LocalCoordinator("owner", "owner-session"), nullLogger, join(home, "jobs.json"), 2); managers.push(jobs);
  let alive = true;
  const send = vi.fn((_job: unknown, _control: RunnerControl) => {});
  jobs.runners = { state: () => state, alive: () => alive, send, kill() {} };
  const resume = vi.fn((..._args: any[]) => async () => answer);
  const run: Run = Object.assign(async () => answer, { hosted: () => ({ pid: process.pid, peer: "fixture-runner", startedAt: Date.now() }) });
  const job = jobs.start("codex", null, "task", run, resume);
  jobs.followUp(job.name, "prepared but never admitted");
  const control = send.mock.calls[0]![1] as Extract<RunnerControl, { type: "message" }>;
  let turns = 0;
  vi.spyOn(delegation, "runDelegate").mockImplementation(async (...call) => {
    if (++turns > 1) throw new Error("preparation failed before admission");
    runnerNode.emit("message", { id: "preparation-control", from: { id: "owner-session", name: "owner", agent: "claude" }, to: job.name, recipient: job.name,
      conversationId: `${CONTROL_CONVERSATION_PREFIX}${job.id}`, replyTo: null, hop: 0, readAt: null, body: JSON.stringify(control), createdAt: Date.now() });
    await until(() => call[6]!.queue.length === 1);
    return answer;
  });
  const args = { cwd: home, prompt: "task", title: "Preparation fixture", access: "read" as const };
  const spec: RunnerSpec = { home, target: "codex", args, base: args, job: { ...job, allowedServers: [] }, owner: "owner", byAgent: "claude", cwd: home, cfg: DEFAULT_CONFIG };
  expect(await runOwnedJobRunner(spec, nullLogger, null)).toBe(0);
  expect(turns).toBe(2); expect(check).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
  expect(state.providerUsage).toBeUndefined(); expect(state.seen).toContain(control.cid);
  expect(state.usageSubmission?.pending).toEqual([{ cid: control.cid, body: control.body }]);
  alive = false; (jobs as any).checkHosted(job);
  expect(job.status).toBe("failed"); expect(job.queue).toEqual([control.body]);
  expect(job.usagePendingControls).toEqual([{ cid: control.cid, body: control.body }]); expect(resume).not.toHaveBeenCalled();
});

it.each(["exception", "cancellation", "crash"] as const)("retries only unacknowledged CIDs once after a partial ACK and %s", async exit => {
  const path = join(home, "jobs.json"), node = new LocalCoordinator("owner", "owner-session");
  let jobs = new JobManager(node, nullLogger, path, 2); managers.push(jobs);
  let state: RunnerState | null = null;
  jobs.runners = { state: () => state, alive: () => false, send() {}, kill() {} };
  let submitted: { cid: string; body: string }[] = [], retry: { cid: string; body: string }[] = [];
  let hostedAttempts = 0;
  const inlineRetry = vi.fn(async (_signal: AbortSignal, _progress: unknown, current: any) => { retry = structuredClone(current.usagePendingControls ?? []); return answer; });
  const resume = vi.fn((message: string): Run => {
    return Object.assign(inlineRetry, { hosted: (current: any) => {
      if (hostedAttempts) return null;
      hostedAttempts++;
      submitted = structuredClone(current.usagePendingControls);
      state = remoteJobSnapshotSchema.parse({ alive: false, approvals: [], state: { pid: 0, peer: "fixture-runner", updatedAt: Date.now(),
        status: exit === "crash" ? "running" : exit === "cancellation" ? "cancelled" : "failed", sessionId: "same-session", delivered: true,
        usageSubmission: { runId: current.usageRunId, turnStartedAt: current.startedAt + 1, pending: [submitted[1]], queued: [], admitted: [submitted[0]!.cid] } } }).state;
      return { pid: 0, peer: "fixture-runner", startedAt: Date.now() };
    } });
  });
  let finishInitial!: () => void;
  const initial = new Promise<void>(resolve => { finishInitial = resolve; });
  const job = jobs.start("codex", null, "task", async (_signal, _progress, current) => { current.sessionId = "same-session"; await initial; return answer; }, resume);
  await until(() => job.sessionId === "same-session");
  jobs.followUp(job.name, "ACKed steering"); jobs.followUp(job.name, "unACKed steering");
  expect(job.queue).toEqual(["ACKed steering", "unACKed steering"]);
  finishInitial(); await until(() => hostedAttempts === 1);
  expect(job.status).toBe("running"); expect(job.host?.peer).toBe("fixture-runner"); expect(inlineRetry).not.toHaveBeenCalled();
  expect(submitted.map(control => control.body)).toEqual(["ACKed steering", "unACKed steering"]);
  (jobs as any).checkHosted(job);
  expect(job.queue).toEqual(["unACKed steering"]); expect(job.usagePendingControls).toEqual([submitted[1]]);
  expect(resume).toHaveBeenCalledTimes(1);
  jobs.setDormant(true);
  jobs = new JobManager(node, nullLogger, path, 2); managers.push(jobs); jobs.restore(() => resume);
  const restored = jobs.find(job.name, false)!;
  expect(restored.queue).toEqual(["unACKed steering"]);
  jobs.followUp(restored.name, "explicit retry");
  await until(() => restored.status === "done");
  expect(retry.filter(control => submitted.some(original => original.cid === control.cid))).toEqual([submitted[1]]);
  expect(retry.map(control => control.body)).toEqual(["unACKed steering", "explicit retry"]);
  expect(inlineRetry).toHaveBeenCalledTimes(1);
  expect(resume.mock.calls[1]![0]).toBe("unACKed steering\n\nexplicit retry");
  expect(restored.queue).toEqual([]); expect(restored.usagePendingControls).toBeUndefined();
});

it("never recovers a durable admitted CID evicted from the runner seen window after crash and reload", async () => {
  const path = join(home, "jobs.json"), node = new LocalCoordinator("owner", "owner-session");
  let jobs = new JobManager(node, nullLogger, path, 2); managers.push(jobs);
  let alive = true;
  const controls = Array.from({ length: 102 }, (_, index) => ({ cid: `eviction-control-${index}`, body: `steering ${index}` }));
  const deliveries = new Map<string, number>([[controls[0]!.cid, 1]]);
  let retry: { cid: string; body: string }[] = [];
  let state: RunnerState = { pid: 0, peer: "fixture-runner", updatedAt: Date.now(), status: "running", sessionId: "same-session" };
  const runners = { state: () => state, alive: () => alive, send() {}, kill() {} }; jobs.runners = runners;
  const resume = vi.fn((_message: string): Run => async (_signal, _progress, current) => {
    retry = structuredClone(current.usagePendingControls ?? []);
    for (const control of retry) deliveries.set(control.cid, (deliveries.get(control.cid) ?? 0) + 1);
    return answer;
  });
  const run: Run = Object.assign(async () => answer, { hosted: () => ({ pid: 0, peer: "fixture-runner", startedAt: Date.now() }) });
  const job = jobs.start("codex", null, "task", run, resume);
  job.forwarded = structuredClone(controls);
  const allSeen = controls.map(control => control.cid);
  state = { ...state, seen: allSeen.slice(-100), usageSubmission: { runId: job.usageRunId, turnStartedAt: job.startedAt,
    admitted: [controls[0]!.cid], pending: controls.slice(1), queued: [] } };
  expect(allSeen.length).toBeGreaterThan(100); expect(state.seen).toHaveLength(100);
  expect(state.seen).not.toContain(controls[0]!.cid); expect(job.forwarded).toHaveLength(102);
  (jobs as any).checkHosted(job); jobs.persist();
  expect(readStore(path).find(saved => saved.id === job.id)?.usageAdmittedControls).toContain(controls[0]!.cid);
  jobs.setDormant(true);
  // The durable job ACK, rather than this later checkpoint's seen/ACK arrays, proves consumption.
  state = { ...state, usageSubmission: { ...state.usageSubmission!, admitted: [] } };
  jobs = new JobManager(node, nullLogger, path, 2); managers.push(jobs); jobs.runners = runners; jobs.restore(() => resume);
  const restored = jobs.find(job.name, false)!;
  expect(restored.status).toBe("running"); expect(restored.forwarded).toHaveLength(102);
  restored.usageAdmittedControls = []; jobs.persist(); // A stale writer must not erase a durable ACK.
  expect(readStore(path).find(saved => saved.id === job.id)?.usageAdmittedControls).toContain(controls[0]!.cid);
  alive = false; (jobs as any).checkHosted(restored);
  expect(restored.queue).toEqual(controls.slice(1).map(control => control.body));
  expect(restored.usagePendingControls).toEqual(controls.slice(1)); expect(resume).not.toHaveBeenCalled();
  jobs.followUp(restored.name, "explicit retry");
  await until(() => restored.status === "done");
  expect(retry.some(control => control.cid === controls[0]!.cid)).toBe(false);
  for (const control of controls) expect(deliveries.get(control.cid)).toBe(1);
  expect(resume).toHaveBeenCalledTimes(1); expect(restored.queue).toEqual([]);
  expect(restored.usageAdmittedControls).toContain(controls[0]!.cid);
  expect(readStore(path).find(saved => saved.id === job.id)?.usageAdmittedControls).toContain(controls[0]!.cid);
});

it.each(CODING_AGENTS)("remote %s preflight uses executor context and persists typed refusal without a runner", async target => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 4, maxJobs: 16, network: { ...DEFAULT_NETWORK_CONFIG,
    remoteJobs: { enabled: true, allowRoots: [home], agents: [target], allowPeers: ["paired"] } } }));
  expect(loadConfig(home, "other", nullLogger, {}).network.remoteJobs.agents).toEqual([target]);
  vi.spyOn(delegate, "bundledCli").mockReturnValue("fixture-cli");
  vi.spyOn(worktree, "gitDirsOutside").mockResolvedValue([]);
  const read = vi.spyOn(usage, "checkUsagePreflight").mockResolvedValue(block);
  const start = vi.spyOn(JobRunners.prototype, "startAsync").mockResolvedValue({ pid: null, peer: "runner", startedAt: 1 });
  const remote = new RemoteJobs({ registerExtension() {} } as any, home, nullLogger, async () => {}); remotes.push(remote);
  const request = { op: "spawn", job: "12345678", target, usageTurn: "12345678:100", args: { cwd: home, model: "selected-model", prompt: "task", title: "Fixture" } };
  const snapshot = await (remote as any).handle({ id: "pair", name: "paired" }, { id: "supervisor", name: "sender", supervisor: "session" }, request);
  expect(start).not.toHaveBeenCalled();
  expect(read.mock.calls[0]![0]).toMatchObject({ home, cwd: home, agent: target, model: "selected-model" });
  expect(remoteJobSnapshotSchema.parse(snapshot).state?.providerUsage?.decision).toEqual(block);
  expect(snapshot).toMatchObject({ alive: false, usageTurn: request.usageTurn });
  expect(JSON.parse(readFileSync(join(home, "remote-jobs.json"), "utf8")).jobs[0].usageRefusal.providerUsage.decision).toEqual(block);
  remote.close();
  const restored = new RemoteJobs({ registerExtension() {} } as any, home, nullLogger, async () => {}); remotes.push(restored);
  const state = await (restored as any).handle({ id: "pair", name: "paired" }, { id: "supervisor", name: "sender", supervisor: "session" }, { op: "state", job: "12345678" });
  expect(state.state.providerUsage.decision).toEqual(block);
});

it("negotiates only usage correlation, preserving permissions for strict legacy executors", async () => {
  vi.spyOn(delegate, "bundledCli").mockReturnValue(null);
  const request = { op: "spawn", job: "12345678", target: "codex", usageTurn: "12345678:100",
    args: { cwd: home, prompt: "task", title: "Fixture", model: "selected-model", access: "read", sandbox: "read-only", allow_tools: ["pair-desk.get_issue"] } } as const;
  const legacy = z.object({ op: z.literal("spawn"), job: z.string(), target: z.literal("codex"), args: remoteSpawnArgsSchema }).strict();
  expect(legacy.safeParse(request).success).toBe(false);
  for (const supportsUsage of [false, true]) {
    let receive!: (frame: any, pair: any) => Promise<void>;
    let serialized: any;
    const network = {
      registerExtension: vi.fn((_frame, _capability, handler, _extra) => { receive = handler; }),
      peerSupports: (_host: string, capability: string) => capability !== REMOTE_JOB_USAGE_CAPABILITY || supportsUsage,
      sendExtension: vi.fn(async (_host: string, _frame: string, payload: any) => {
        serialized = payload.request;
        await receive({ kind: "response", rid: payload.rid, value: { state: null, alive: false, approvals: [] } }, { id: "pair", name: "paired" });
      }),
    };
    const remote = new RemoteJobs(network as any, home, nullLogger, async () => {}); remotes.push(remote);
    await remote.request("paired", { id: "supervisor", name: "owner" }, request as any);
    expect(network.registerExtension.mock.calls[0]![3]).toContain(REMOTE_JOB_USAGE_CAPABILITY);
    expect(serialized.args).toEqual(request.args);
    if (supportsUsage) expect(serialized.usageTurn).toBe(request.usageTurn);
    else {
      expect(legacy.parse(serialized).args).toEqual(request.args); expect(serialized).not.toHaveProperty("usageTurn");
      const sends = network.sendExtension.mock.calls.length;
      await expect(remote.request("paired", { id: "supervisor", name: "owner" }, { ...request, usageControls: [{ cid: "submitted-cid", body: "task" }] } as any)).rejects.toThrow("submitted steering requires remote-jobs-usage-v1");
      expect(network.sendExtension).toHaveBeenCalledTimes(sends);
    }
  }
});
