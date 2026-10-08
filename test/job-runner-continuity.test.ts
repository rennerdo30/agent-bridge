import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { worktreeLease } from "../src/core/worktree-state.js";
import { readRunnerState, type RunnerSpec } from "../src/mcp/job-host.js";
import { runJobRunner } from "../src/mcp/job-runner.js";

const mocks = vi.hoisted(() => ({ delegate: vi.fn(), node: null as any }));
vi.mock("../src/mcp/delegate-run.js", async original => ({ ...await original<typeof import("../src/mcp/delegate-run.js")>(), runDelegate: mocks.delegate }));
vi.mock("../src/core/windows-job-scope.js", async original => ({ ...await original<typeof import("../src/core/windows-job-scope.js")>(), establishWindowsJobScope: async () => null }));
vi.mock("../src/core/node.js", async () => {
  const { EventEmitter } = await import("node:events");
  return { BridgeNode: class extends EventEmitter {
    name: string;
    peers = vi.fn().mockRejectedValueOnce(new Error("broker request timed out: peers")).mockResolvedValue([]);
    markRead = vi.fn().mockImplementationOnce(() => { throw new Error("broker request timed out: ack"); });
    updateJob = vi.fn().mockRejectedValue(new Error("broker request timed out: updateJob"));
    send = vi.fn().mockResolvedValue({});
    constructor(options: { name: string }) { super(); this.name = options.name; mocks.node = this; }
    async start() {}
    async stop() {}
  } };
});
let home: string | undefined;
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = undefined; vi.clearAllMocks(); });

it("keeps the active turn and lease through owner handoff and control ACK timeout, then reports to the new owner", async () => {
  const fixtures = join(process.cwd(), ".agent-bridge-test"); mkdirSync(fixtures, { recursive: true });
  home = mkdtempSync(join(fixtures, "runner-continuity-"));
  const wt = { path: join(home, "worktree") }; mkdirSync(wt.path);
  const userFile = join(wt.path, "owner-data.txt"); writeFileSync(userFile, "preserved bytes");
  const args = { prompt: "Continue", title: "Handoff continuity", session_id: "native-context" };
  const spec: RunnerSpec = { home, target: "codex", args, base: args, owner: "claude-main", byAgent: "claude", cwd: home, cfg: DEFAULT_CONFIG,
    job: { id: "12345678", name: "codex-job-12345678", owner: "claude-main", supervisor: "main-session", agent: "codex", model: null, prompt: "Original", startedAt: Date.now(), sessionId: "native-context", workdir: wt.path, worktree: null, allowedServers: [] } };
  const store = join(home, "jobs.json");
  const changeOwner = (owner: string) => writeFileSync(store, JSON.stringify({ version: 4, jobs: [{ ...spec.job, owner, rootName: owner, status: "running", args }] }));
  changeOwner("claude-main");
  const file = join(home, "runner.spec.json"); writeFileSync(file, JSON.stringify(spec));
  const live = { post: vi.fn() };
  let finish!: () => void, activeSignal!: AbortSignal;
  mocks.delegate.mockImplementation(async (_ctx, _target, _args, signal, _progress, _background, job) => {
    activeSignal = signal; job.live = live;
    const release = worktreeLease(home!, wt);
    try { await new Promise<void>(resolve => { finish = resolve; }); }
    finally { release(); }
    return { sessionId: "native-context", text: "finished after handoff", isError: false };
  });
  const running = runJobRunner(file);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"), { timeout: 10_000 });
  const control = { id: "control-1", from: { id: "new-session", name: "claude-main-2", agent: "claude" }, body: JSON.stringify({ type: "message", cid: "forward-1", body: "continue safely" }), conversationId: "jobctl-12345678", createdAt: Date.now(), replyTo: null, hop: 0, to: spec.job.name };
  mocks.node.emit("message", control);
  await vi.waitFor(() => expect(mocks.node.peers).toHaveBeenCalledOnce());
  changeOwner("claude-main-2");
  await vi.waitFor(() => expect(live.post).toHaveBeenCalledOnce(), { timeout: 5_000 });
  await vi.waitFor(() => expect(mocks.node.markRead).toHaveBeenCalledTimes(2), { timeout: 5_000 });
  expect(live.post).toHaveBeenCalledWith("continue safely");
  expect(activeSignal.aborted).toBe(false);
  expect(() => worktreeLease(home!, wt)).toThrow("unreconciled lease");
  mocks.node.send.mockRejectedValueOnce(new Error("broker request timed out: send"));
  mocks.node.send.mockImplementationOnce(async () => { changeOwner("claude-main-3"); throw new Error("broker request timed out: send"); });
  finish();
  expect(await running).toBe(0);
  const sent = mocks.node.send.mock.calls.map((call: any[]) => call[0]);
  expect(sent.at(-1)).toMatchObject({ to: "claude-main-3", body: expect.stringContaining("finished after handoff") });
  expect(new Set(sent.map((message: any) => message.dedupeKey)).size).toBe(1);
  expect(readRunnerState(home!, spec.job.id)).toMatchObject({ status: "done", delivered: true, sessionId: "native-context", workdir: wt.path });
  worktreeLease(home!, wt)();
  expect(existsSync(userFile)).toBe(true);
  expect(readFileSync(userFile, "utf8")).toBe("preserved bytes");
  expect(mocks.delegate).toHaveBeenCalledOnce();
}, 20_000);
