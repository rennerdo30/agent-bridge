import { METADATA_STORE_VERSION } from "../src/core/metadata-db.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { APP_VERSION } from "../src/core/constants.js";
import { SQLITE_STORE_VERSION } from "../src/core/store-version.js";
import { readRunnerState } from "../src/mcp/job-host.js";
import { closeMetadataDbs } from "../src/core/metadata-db.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { INITIAL_STATE_DEADLINE_MS, runJobRunner } from "../src/mcp/job-runner.js";
import { runnerStatePath, type RunnerSpec } from "../src/mcp/job-host.js";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), delegate: vi.fn(), writes: vi.fn(), order: [] as string[] }));
vi.mock("../src/core/store-compatibility.js", async original => ({ ...await original<typeof import("../src/core/store-compatibility.js")>(), refreshStorePeerIdentities: mocks.refresh }));
vi.mock("../src/mcp/job-host.js", async original => {
  const host = await original<typeof import("../src/mcp/job-host.js")>();
  return { ...host, writeRunnerState: (...args: Parameters<typeof host.writeRunnerState>) => { mocks.order.push("state"); mocks.writes(...args); host.writeRunnerState(...args); } };
});
vi.mock("../src/mcp/delegate-run.js", async original => ({ ...await original<typeof import("../src/mcp/delegate-run.js")>(), runDelegate: mocks.delegate }));
vi.mock("../src/core/windows-job-scope.js", async original => ({ ...await original<typeof import("../src/core/windows-job-scope.js")>(), establishWindowsJobScope: async () => null }));
vi.mock("../src/core/node.js", async () => {
  const { EventEmitter } = await import("node:events");
  return { BridgeNode: class extends EventEmitter {
    name: string;
    constructor(options: { name: string }) { super(); this.name = options.name; mocks.order.push("node"); }
    async start() {}
    async stop() {}
    async send() { return { messages: [{ id: "accepted" }] }; }
    async sendState() { return { state: "missing" }; }
  } };
});
let home: string | undefined;
afterEach(() => { closeMetadataDbs(); vi.useRealTimers(); if (home) rmSync(home, { recursive: true, force: true }); home = undefined; vi.resetAllMocks(); mocks.order.length = 0; });
function fixture() {
  const root = process.env.AGENT_BRIDGE_TEST_ROOT!; mkdirSync(root, { recursive: true });
  home = mkdtempSync(join(root, "runner-startup-"));
  const args = { prompt: "Continue", title: "Cold startup" };
  const spec: RunnerSpec = { home, target: "codex", args, base: args, owner: "parent", byAgent: "claude", cwd: home, cfg: DEFAULT_CONFIG,
    job: { id: "coldstart", name: "codex-job-coldstart", agent: "codex", model: null, prompt: "Original task", startedAt: Date.now(), sessionId: "native-context", workdir: home, worktree: null, allowedServers: [] } };
  const file = join(home, "runner.spec.json"); writeFileSync(file, JSON.stringify(spec));
  return { spec, file };
}
it("awaits cold retained-reader identity readiness before any runner state write or native delegate", async () => {
  const { spec, file } = fixture();
  let ready!: () => void;
  mocks.refresh.mockImplementation(async () => { await new Promise<void>(resolve => { ready = resolve; }); mocks.order.push("identities"); });
  mocks.delegate.mockResolvedValue({ text: "continued", sessionId: "native-context", isError: false });
  const running = runJobRunner(file);
  expect(mocks.refresh).toHaveBeenCalledWith(home, expect.any(AbortSignal));
  expect(mocks.writes).not.toHaveBeenCalled();
  expect(mocks.delegate).not.toHaveBeenCalled();
  expect(existsSync(runnerStatePath(home!, spec.job.id))).toBe(false);
  ready();
  expect(await running).toBe(0);
  expect(mocks.order.slice(0, 3)).toEqual(["identities", "state", "node"]);
  expect(mocks.delegate).toHaveBeenCalledOnce();
});
it("keeps state/schema writes deferred while cold identity resolution fails, retrying until cancelled (AB-278)", async () => {
  const { spec, file } = fixture();
  const rejectionListeners = process.listeners("unhandledRejection"), exceptionListeners = process.listeners("uncaughtException");
  const beforeTerm = process.listeners("SIGTERM");
  let attempts = 0, retried!: () => void;
  const retry = new Promise<void>(resolve => { retried = resolve; });
  mocks.refresh.mockImplementation(async () => { if (++attempts === 3) retried(); throw new Error("reader identity unavailable"); });
  const failed = expect(runJobRunner(file)).rejects.toThrow();
  await retry;
  process.listeners("SIGTERM").find(listener => !beforeTerm.includes(listener))!("SIGTERM");
  await failed;
  expect(mocks.writes).not.toHaveBeenCalled();
  expect(mocks.delegate).not.toHaveBeenCalled();
  expect(existsSync(runnerStatePath(home!, spec.job.id))).toBe(false);
  expect(process.listeners("unhandledRejection")).toEqual(rejectionListeners);
  expect(process.listeners("uncaughtException")).toEqual(exceptionListeners);
});

it("reverifies a live reader published between readiness and the first actual state write", async () => {
  const { spec, file } = fixture();
  const compatibility = await vi.importActual<typeof import("../src/core/store-compatibility.js")>("../src/core/store-compatibility.js");
  mocks.refresh.mockImplementation(compatibility.refreshStorePeerIdentities);
  mocks.writes.mockImplementationOnce(() => {
    const directory = join(home!, "storage-capabilities"); mkdirSync(directory);
    // The parent is a real live foreign process. Its newly published capability
    // has not been verified in this runner's cache when the real writer checks it.
    writeFileSync(join(directory, `${process.ppid}.json`), JSON.stringify({ schemaVersion: 1,
      pid: process.ppid, name: "concurrent-runner", version: APP_VERSION, explicit: true, json: 4, sqlite: SQLITE_STORE_VERSION, metadata: METADATA_STORE_VERSION }));
    expect(mocks.delegate).not.toHaveBeenCalled();
  });
  mocks.delegate.mockResolvedValue({ text: "continued", sessionId: "native-context", isError: false });
  expect(await runJobRunner(file)).toBe(0);
  expect(mocks.refresh.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(mocks.order.slice(0, 3)).toEqual(["state", "state", "node"]);
  expect(mocks.delegate).toHaveBeenCalledOnce();
  expect(readRunnerState(home!, spec.job.id)?.sessionId).toBe("native-context");
});

it("keeps a genuinely incompatible live reader blocking until owned startup cancellation", async () => {
  const { spec, file } = fixture();
  const directory = join(home!, "storage-capabilities"); mkdirSync(directory);
  const presence = JSON.stringify({ schemaVersion: 1, pid: process.ppid, name: "old-runner", version: "0.29.12", explicit: true, json: 3, sqlite: 7 });
  const path = join(directory, `${process.ppid}.json`); writeFileSync(path, presence);
  const compatibility = await vi.importActual<typeof import("../src/core/store-compatibility.js")>("../src/core/store-compatibility.js");
  mocks.refresh.mockImplementation(compatibility.refreshStorePeerIdentities);
  const beforeTerm = process.listeners("SIGTERM"), beforeInt = process.listeners("SIGINT");
  let checked!: () => void;
  const checking = new Promise<void>(resolve => { checked = resolve; });
  mocks.writes.mockImplementationOnce(() => checked());
  const running = runJobRunner(file);
  const failed = expect(running).rejects.toMatchObject({ name: "AbortError" });
  await checking;
  expect(existsSync(runnerStatePath(home!, spec.job.id))).toBe(false);
  expect(mocks.delegate).not.toHaveBeenCalled();
  const stop = process.listeners("SIGTERM").find(listener => !beforeTerm.includes(listener))!;
  expect(stop).toBeTypeOf("function"); stop("SIGTERM");
  await failed;
  expect(readFileSync(path, "utf8")).toBe(presence);
  expect(process.listeners("SIGTERM")).toEqual(beforeTerm);
  expect(process.listeners("SIGINT")).toEqual(beforeInt);
});

it("bounds repeated initial admission deferral and removes its timers and listeners", async () => {
  const { spec, file } = fixture(); vi.useFakeTimers();
  mocks.refresh.mockResolvedValue(undefined);
  let retried!: () => void;
  const retry = new Promise<void>(resolve => { retried = resolve; });
  mocks.writes.mockImplementation(() => {
    if (mocks.writes.mock.calls.length === 2) retried();
    throw Object.assign(new Error("reader pending"), { code: "STORE_UPGRADE_DEFERRED" });
  });
  const beforeTerm = process.listeners("SIGTERM"), beforeInt = process.listeners("SIGINT");
  const beforeRejection = process.listeners("unhandledRejection"), beforeException = process.listeners("uncaughtException");
  const failed = expect(runJobRunner(file)).rejects.toMatchObject({ name: "AbortError" });
  // Promise-based backoff uses Node's real timers; the separately owned deadline
  // is controlled here only after observing an actual second admission attempt.
  await retry;
  await vi.advanceTimersByTimeAsync(INITIAL_STATE_DEADLINE_MS); await failed;
  expect(mocks.writes.mock.calls.length).toBeGreaterThan(1);
  expect(mocks.delegate).not.toHaveBeenCalled();
  expect(existsSync(runnerStatePath(home!, spec.job.id))).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(process.listeners("SIGTERM")).toEqual(beforeTerm);
  expect(process.listeners("SIGINT")).toEqual(beforeInt);
  expect(process.listeners("unhandledRejection")).toEqual(beforeRejection);
  expect(process.listeners("uncaughtException")).toEqual(beforeException);
});

it("propagates a non-admission write failure without retry or native fallback", async () => {
  const { spec, file } = fixture();
  mocks.refresh.mockResolvedValue(undefined);
  const error = Object.assign(new Error("state IO failed"), { code: "EIO" });
  mocks.writes.mockImplementationOnce(() => { throw error; });
  const beforeTerm = process.listeners("SIGTERM"), beforeInt = process.listeners("SIGINT");
  await expect(runJobRunner(file)).rejects.toBe(error);
  expect(mocks.writes).toHaveBeenCalledOnce();
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(mocks.delegate).not.toHaveBeenCalled();
  expect(existsSync(runnerStatePath(home!, spec.job.id))).toBe(false);
  expect(process.listeners("SIGTERM")).toEqual(beforeTerm);
  expect(process.listeners("SIGINT")).toEqual(beforeInt);
});
