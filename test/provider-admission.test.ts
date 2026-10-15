import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
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
import { JobManager, readStore } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { JobRunners } from "../src/mcp/job-host.js";
import { RemoteJobs } from "../src/network/remote-jobs.js";
import { remoteJobSnapshotSchema } from "../src/network/remote-job-protocol.js";
import { DEFAULT_NETWORK_CONFIG } from "../src/network/config.js";
import { until } from "./helpers.js";

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
beforeEach(() => { home = realpathSync.native(mkdtempSync(join(tmpdir(), "ab-provider-admission-"))); });
afterEach(() => {
  for (const jobs of managers.splice(0)) jobs.setDormant(true);
  for (const remote of remotes.splice(0)) remote.close();
  closeMetadataDbs(); vi.restoreAllMocks(); vi.useRealTimers(); vi.mocked(spawn).mockImplementation(actualSpawn); vi.unstubAllEnvs();
});
const probe = (agent = "codex" as usage.UsageProbe["agent"]): usage.UsageProbe => ({ agent, bin: process.execPath, cwd: home, home, model: "exact-model", log: nullLogger });
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
