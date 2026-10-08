import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { runJobRunner } from "../src/mcp/job-runner.js";
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
    async send() {}
  } };
});
let home: string | undefined;
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = undefined; vi.clearAllMocks(); mocks.order.length = 0; });
function fixture() {
  const root = join(process.cwd(), ".agent-bridge-test"); mkdirSync(root, { recursive: true });
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
  expect(mocks.refresh).toHaveBeenCalledWith(home);
  expect(mocks.writes).not.toHaveBeenCalled();
  expect(mocks.delegate).not.toHaveBeenCalled();
  expect(existsSync(runnerStatePath(home!, spec.job.id))).toBe(false);
  ready();
  expect(await running).toBe(0);
  expect(mocks.order.slice(0, 3)).toEqual(["identities", "state", "node"]);
  expect(mocks.delegate).toHaveBeenCalledOnce();
});
it("keeps state/schema writes deferred if cold identity resolution fails", async () => {
  const { spec, file } = fixture();
  mocks.refresh.mockRejectedValue(new Error("reader identity unavailable"));
  await expect(runJobRunner(file)).rejects.toThrow("reader identity unavailable");
  expect(mocks.writes).not.toHaveBeenCalled();
  expect(mocks.delegate).not.toHaveBeenCalled();
  expect(existsSync(runnerStatePath(home!, spec.job.id))).toBe(false);
});
