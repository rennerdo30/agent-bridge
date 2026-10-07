import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { readRunnerState, type RunnerSpec } from "../src/mcp/job-host.js";
import { runJobRunner } from "../src/mcp/job-runner.js";

const { delegate, ownership } = vi.hoisted(() => ({ delegate: vi.fn(), ownership: vi.fn().mockResolvedValue(null) }));
vi.mock("../src/mcp/delegate-run.js", async original => ({ ...await original<typeof import("../src/mcp/delegate-run.js")>(), runDelegate: delegate }));
vi.mock("../src/core/windows-job-scope.js", async original => ({ ...await original<typeof import("../src/core/windows-job-scope.js")>(), establishWindowsJobScope: ownership }));
vi.mock("../src/core/node.js", async () => {
  const { EventEmitter } = await import("node:events");
  return { BridgeNode: class extends EventEmitter {
    name: string;
    constructor(options: { name: string }) { super(); this.name = options.name; }
    async start() {}
    async stop() {}
    async send() {}
  } };
});
const homes: string[] = [];
afterEach(() => { homes.splice(0).forEach(home => rmSync(home, { recursive: true, force: true })); vi.clearAllMocks(); });

it.skipIf(process.platform !== "win32").each(["claude", "codex", "opencode", "antigravity"] as const)("starts a %s runner when ownership setup degrades", async target => {
  const home = mkdtempSync(join(tmpdir(), "ab-degraded-")); homes.push(home);
  const args = { prompt: "Continue", title: "Legacy continuation", session_id: "saved-session" };
  // Existing 0.29.10 runner specs need no conversion or destructive rewrite.
  const spec: RunnerSpec = { home, target, args, base: args, owner: "parent", byAgent: "codex", cwd: home, cfg: DEFAULT_CONFIG,
    job: { id: "12345678", name: target + "-job-12345678", agent: target, model: null, prompt: "Original task", startedAt: Date.now(), sessionId: "saved-session", workdir: home, worktree: null, allowedServers: [] } };
  const file = join(home, "legacy.spec.json"); writeFileSync(file, JSON.stringify(spec));
  delegate.mockResolvedValue({ sessionId: "saved-session", text: "continued", isError: false, details: {} });
  expect(await runJobRunner(file)).toBe(0);
  expect(ownership).toHaveBeenCalledOnce();
  expect(delegate).toHaveBeenCalledOnce();
  expect(delegate.mock.calls[0]![1]).toBe(target);
  expect(delegate.mock.calls[0]![3].aborted).toBe(false);
  expect(readRunnerState(home, spec.job.id)).toMatchObject({ status: "done", sessionId: "saved-session", delivered: true, report: expect.stringContaining("continued") });
});
