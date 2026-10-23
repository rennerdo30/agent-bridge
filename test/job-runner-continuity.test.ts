import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { worktreeLease } from "../src/core/worktree-state.js";
import { closeMetadataDbs } from "../src/core/metadata-db.js";
import { readRunnerState, type RunnerSpec } from "../src/mcp/job-host.js";
import { runJobRunner } from "../src/mcp/job-runner.js";
import { completionMessageId, COMPLETION_DEDUPE_PREFIX } from "../src/core/completion.js";
import { MessageStore } from "../src/core/store.js";
import { Broker } from "../src/core/broker.js";
import { nullLogger } from "../src/core/logger.js";
import { fixtureConnection, fixtureJobReport, fixtureOwner, fixturePeer } from "./owned-mail.js";
import { fixtureProject } from "./helpers.js";

const mocks = vi.hoisted(() => ({ delegate: vi.fn(), node: null as any }));
// A broker send result always carries the stored messages (SendResult.messages is required by the protocol).
const stored = vi.hoisted(() => ({ messages: [{ id: "stored" }], deliveredTo: [], queuedFor: [] }));
vi.mock("../src/mcp/delegate-run.js", async original => ({ ...await original<typeof import("../src/mcp/delegate-run.js")>(), runDelegate: mocks.delegate }));
vi.mock("../src/core/windows-job-scope.js", async original => ({ ...await original<typeof import("../src/core/windows-job-scope.js")>(), establishWindowsJobScope: async () => null }));
vi.mock("../src/core/worktree-processes.js", async original => ({
  ...await original<typeof import("../src/core/worktree-processes.js")>(),
  worktreeProcesses: async () => ({ complete: true, processes: [{ pid: 789, identity: "fixture-start-ticks", name: "python.exe" }] }),
}));
vi.mock("../src/core/node.js", async () => {
  const { EventEmitter } = await import("node:events");
  return { BridgeNode: class extends EventEmitter {
    name: string;
    peers = vi.fn().mockRejectedValueOnce(new Error("broker request timed out: peers")).mockResolvedValue([]);
    markRead = vi.fn().mockImplementationOnce(() => { throw new Error("broker request timed out: ack"); });
    updateJob = vi.fn().mockRejectedValue(new Error("broker request timed out: updateJob"));
    send = vi.fn().mockResolvedValue(stored);
    constructor(options: { name: string }) { super(); this.name = options.name; mocks.node = this; }
    async start() {}
    async stop() {}
  } };
});
let home: string | undefined;
afterEach(() => { closeMetadataDbs(); if (home) rmSync(home, { recursive: true, force: true }); home = undefined; vi.clearAllMocks(); });

it("fences an old-turn cancel after the runner starts a queued continuation and publishes current stopping", async () => {
  home = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "runner-cancel-generation-"));
  const startedAt = Date.now() - 1_000;
  const args = { prompt: "First turn", title: "Cancel generations", session_id: "native-context" };
  const spec: RunnerSpec = { home, target: "codex", args, base: args, owner: "owner", byAgent: "claude", cwd: home, cfg: DEFAULT_CONFIG,
    job: { id: "cancelgeneration", name: "codex-job-cancelgeneration", owner: "owner", agent: "codex", model: null, prompt: args.prompt, startedAt, sessionId: "native-context", workdir: home, worktree: null, allowedServers: [] } };
  writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ ...spec.job, status: "running" }] }));
  const file = join(home, "runner.spec.json"); writeFileSync(file, JSON.stringify(spec));
  let finish!: (result: unknown) => void, continued!: () => void, signal!: AbortSignal;
  const continuation = new Promise<void>(resolve => { continued = resolve; });
  mocks.delegate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mocks.delegate.mockImplementationOnce((_rc, _target, _args, active: AbortSignal) => {
    signal = active; continued();
    return new Promise((_, reject) => active.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  });
  const running = runJobRunner(file);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 10));
  // This fixture exercises native lifecycle ordering, not broker ACK retries.
  mocks.node.markRead.mockReset(); mocks.node.updateJob.mockResolvedValue({});
  const control = (id: string, body: unknown, createdAt: number) => ({ id, from: { id: "owner-session", name: "owner", agent: "claude" }, body: JSON.stringify(body), conversationId: "jobctl-cancelgeneration", createdAt });
  mocks.node.emit("message", control("queued", { type: "message", body: "Continue", cid: "queued" }, Date.now()));
  while (!readRunnerState(home, spec.job.id)?.seen?.includes("queued")) await new Promise(resolve => setTimeout(resolve, 10));
  finish({ text: "first finished", sessionId: "native-context", isError: false });
  await continuation;
  mocks.node.emit("message", control("old-cancel", { type: "cancel" }, startedAt + 1));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(signal.aborted).toBe(false);
  mocks.node.emit("message", control("current-cancel", { type: "cancel" }, Date.now() + 1));
  while (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 10));
  expect(readRunnerState(home, spec.job.id)?.stopping).toBe(true);
  expect(await running).toBe(0);
  expect(readRunnerState(home, spec.job.id)).toMatchObject({ status: "cancelled", sessionId: "native-context", stopping: true });
});

it("persists and delivers a cancelled hosted job's final report to the parent", async () => {
  home = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "runner-cancel-report-"));
  const args = { prompt: "Cancelled turn", title: "Cancelled report", session_id: "cancel-context" };
  const spec: RunnerSpec = { home, target: "codex", args, base: args, owner: "parent", byAgent: "claude", cwd: home, cfg: DEFAULT_CONFIG,
    job: { id: "cancelreport", name: "codex-job-cancelreport", owner: "parent", agent: "codex", model: null, prompt: args.prompt, startedAt: Date.now() - 1_000, sessionId: "cancel-context", workdir: home, worktree: null, allowedServers: [] } };
  writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ ...spec.job, status: "running", args }] }));
  const file = join(home, "runner.spec.json"); writeFileSync(file, JSON.stringify(spec));
  let signal!: AbortSignal;
  mocks.delegate.mockImplementationOnce((_rc, _target, _args, active: AbortSignal) => {
    signal = active;
    return new Promise((_, reject) => active.addEventListener("abort", () => reject(new Error("partial output before cancel")), { once: true }));
  });
  const running = runJobRunner(file);
  while (!signal) await new Promise(resolve => setTimeout(resolve, 10));
  mocks.node.markRead.mockReset(); mocks.node.updateJob.mockResolvedValue({});
  mocks.node.emit("message", { id: "cancel", from: { id: "parent-session", name: "parent", agent: "claude" }, body: JSON.stringify({ type: "cancel" }), conversationId: "jobctl-cancelreport", createdAt: Date.now() + 1 });
  expect(await running).toBe(0);
  expect(signal.aborted).toBe(true);
  const state = readRunnerState(home, spec.job.id);
  expect(state).toMatchObject({ status: "cancelled", delivered: true, reportId: expect.any(String), report: expect.stringContaining("cancelled") });
  const sent = mocks.node.send.mock.calls.at(-1)?.[0];
  expect(sent).toMatchObject({ to: "parent", body: state?.report, dedupeKey: `${COMPLETION_DEDUPE_PREFIX}${state?.reportId}` });
});

it("reports surviving worktree tools to the supervisor when a cancelled runner has degraded containment", async () => {
  home = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "runner-survivors-"));
  const path = join(home, "worktree"); mkdirSync(path);
  const wt = { path, cwd: path, repoRoot: home, branch: "fixture", base: "fixture" };
  const args = { prompt: "Cancelled fixture", title: "Surviving tools", session_id: "retained-context" };
  const spec: RunnerSpec = { home, target: "codex", args, base: args, owner: "fixture-supervisor", byAgent: "claude", cwd: home, cfg: DEFAULT_CONFIG,
    job: { id: "survivors", name: "codex-job-survivors", owner: "fixture-supervisor", agent: "codex", model: null, prompt: args.prompt, startedAt: Date.now(), sessionId: args.session_id, workdir: path, worktree: wt, allowedServers: [] } };
  writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ ...spec.job, status: "running", args }] }));
  const file = join(home, "runner.spec.json"); writeFileSync(file, JSON.stringify(spec));
  mocks.delegate.mockResolvedValue({ sessionId: args.session_id, worktree: wt, status: "cancelled", text: "cancelled", isError: false });
  expect(await runJobRunner(file)).toBe(0);
  expect(readRunnerState(home, spec.job.id)?.report).toContain("PID 789, python.exe, creation identity fixture-start-ticks");
  expect(mocks.node.send.mock.calls.at(-1)?.[0]).toMatchObject({ to: "fixture-supervisor", body: expect.stringContaining("Supervisor review required before cleanup") });
});

it("keeps the active turn and lease through owner handoff and control ACK timeout, then reports to the new owner", async () => {
  const fixtures = process.env.AGENT_BRIDGE_TEST_ROOT!; mkdirSync(fixtures, { recursive: true });
  home = mkdtempSync(join(fixtures, "runner-continuity-"));
  const wt = { path: join(home, "worktree") }; mkdirSync(wt.path);
  const userFile = join(wt.path, "owner-data.txt"); writeFileSync(userFile, "preserved bytes");
  const args = { prompt: "Continue", title: "Handoff continuity", session_id: "native-context" };
  const spec: RunnerSpec = { home, target: "codex", args, base: args, owner: "claude-main", byAgent: "claude", cwd: home, cfg: DEFAULT_CONFIG,
    job: { id: "12345678", name: "codex-job-12345678", owner: "claude-main", supervisor: "main-session", agent: "codex", model: null, prompt: "Original", startedAt: Date.now(), sessionId: "native-context", workdir: wt.path, worktree: null, allowedServers: [] } };
  const store = join(home, "jobs.json");
  fixtureProject(home);
  const mailbox = new MessageStore(join(home, "bridge.db"), nullLogger), router = new Broker("fixture-unbound", mailbox, nullLogger, "fixture-only", Date.now, store);
  try {
  const supervisors = ["claude-main", "claude-main-2", "claude-main-3"].map(name => fixturePeer(mailbox, name, {
    agent: "claude", cwd: home!, sessionId: name === "claude-main" ? spec.job.supervisor : `${name}-session` }));
  for (const peer of supervisors) {
    const conn = fixtureConnection(mailbox, peer);
    Object.assign(conn.socket, { writableLength: 0, write: () => true, destroy: () => { conn.socket.destroyed = true; } }); (router as any).conns.add(conn);
  }
  const deliveryOwners = Object.fromEntries(supervisors.map(peer => [peer.name, fixtureOwner(mailbox, peer)]));
  let current = "claude-main", history: any[] = [];
  const changeOwner = (owner: string) => {
    if (owner !== current) history = [...history, { from: current, to: owner, fromRootName: current,
      fromRoot: supervisors.find(peer => peer.name === current)!.sessionId, rootName: owner, at: Date.now() }];
    current = owner;
    writeFileSync(store, JSON.stringify({ version: 4, jobs: [{ ...spec.job, owner, supervisor: supervisors.find(peer => peer.name === owner)!.sessionId, rootName: owner, ownershipHistory: history,
      deliveryOwner: deliveryOwners["claude-main"], deliveryOwners, projectRoot: home, status: "running", args }] }));
  };
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
  expect(live.post).toHaveBeenCalledWith("continue safely", undefined, "forward-1");
  expect(activeSignal.aborted).toBe(false);
  expect(() => worktreeLease(home!, wt)).toThrow("unreconciled lease");
  mocks.node.send.mockRejectedValueOnce(new Error("broker request timed out: send"));
  let original: ReturnType<typeof fixtureJobReport> | undefined;
  const persisted = () => mailbox.messagesById(original!.message.id).find(message => message.recipient === "claude-main-3")!;
  mocks.node.send.mockImplementationOnce(async (message: any) => {
    const job = JSON.parse(readFileSync(store, "utf8")).jobs[0];
    original = fixtureJobReport(mailbox, job, supervisors[0]!, supervisors[1]!, {
      id: completionMessageId(`job:${job.id}`, message.dedupeKey.slice(COMPLETION_DEDUPE_PREFIX.length)),
      from: { id: `job:${job.id}`, name: job.name, agent: job.agent }, recipient: message.to, to: message.to, body: message.body,
      conversationId: message.conversationId, replyTo: null, hop: 0, createdAt: Date.now(), readAt: null,
    });
    mailbox.insertJobDelivery(original.message, original.grant);
    changeOwner("claude-main-3"); supervisors[1]!.unavailable = true;
    await router.routePendingJobMail();
    throw new Error("broker request timed out: send");
  });
  mocks.node.send.mockImplementation(async () => {
    expect(mailbox.insertJobDelivery(original!.message, original!.grant)).toBe(false);
    return { messages: [persisted()], deliveredTo: [persisted().recipient], queuedFor: [] };
  });
  finish();
  expect(await running).toBe(0);
  const sent = mocks.node.send.mock.calls.map((call: any[]) => call[0]);
  expect(sent.every((message: { to: string }) => message.to === "claude-main-2")).toBe(true); // Original dispatch intent never retargets.
  expect(persisted()).toMatchObject({ recipient: "claude-main-3", body: expect.stringContaining("finished after handoff") });
  expect(mailbox.messagesById(original!.message.id)).toHaveLength(2);
  expect(mailbox.jobRoutingGrant(original!.message.id)!.grant).toEqual(original!.grant);
  expect(new Set(sent.map((message: any) => message.dedupeKey)).size).toBe(1);
  expect(readRunnerState(home!, spec.job.id)).toMatchObject({ status: "done", delivered: true, sessionId: "native-context", workdir: wt.path });
  worktreeLease(home!, wt)();
  expect(existsSync(userFile)).toBe(true);
  expect(readFileSync(userFile, "utf8")).toBe("preserved bytes");
  expect(mocks.delegate).toHaveBeenCalledOnce();
  } finally { await router.close(); }
}, 20_000);

it("keeps the main owner's turn usable through a slow second-session control timeout and escaped callbacks", async () => {
  const fixtures = process.env.AGENT_BRIDGE_TEST_ROOT!; mkdirSync(fixtures, { recursive: true });
  home = mkdtempSync(join(fixtures, "runner-second-session-"));
  const wt = { path: join(home, "worktree") }; mkdirSync(wt.path);
  const userFile = join(wt.path, "owner-data.txt"); writeFileSync(userFile, "preserved second-session bytes");
  const args = { prompt: "Continue", title: "Second session continuity", session_id: "main-native-context" };
  const spec: RunnerSpec = { home, target: "codex", args, base: args, owner: "claude-main", byAgent: "claude", cwd: home, cfg: DEFAULT_CONFIG,
    job: { id: "secondsession", name: "codex-job-secondsession", owner: "claude-main", agent: "codex", model: null, prompt: "Original", startedAt: Date.now(), sessionId: "main-native-context", workdir: wt.path, worktree: null, allowedServers: [] } };
  const store = join(home, "jobs.json"), original = JSON.stringify({ version: 4, jobs: [{ ...spec.job, status: "running", args }] });
  writeFileSync(store, original);
  const file = join(home, "runner.spec.json"); writeFileSync(file, JSON.stringify(spec));
  const live = { post: vi.fn() };
  const beforeRejection = process.listeners("unhandledRejection"), beforeException = process.listeners("uncaughtException");
  let finish!: () => void, signal!: AbortSignal;
  mocks.delegate.mockImplementation(async (_ctx, _target, _args, currentSignal, _progress, _background, job) => {
    signal = currentSignal; job.live = live;
    const release = worktreeLease(home!, wt);
    try { await new Promise<void>(resolve => { finish = resolve; }); }
    finally { release(); }
    return { sessionId: "main-native-context", text: "main turn still completed", isError: false };
  });
  const running = runJobRunner(file);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"), { timeout: 10_000 });
  let rejectPeers!: (error: Error) => void;
  mocks.node.peers.mockReset().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPeers = reject; })).mockResolvedValue([]);
  mocks.node.markRead.mockReset(); mocks.node.send.mockReset().mockResolvedValue(stored);
  const control = (id: string, from: string) => ({ id, from: { id: from, name: from, agent: "claude" }, body: JSON.stringify({ type: "message", cid: id, body: id }), conversationId: "jobctl-secondsession", createdAt: Date.now(), replyTo: null, hop: 0, to: spec.job.name });
  mocks.node.emit("message", control("secondary-control", "claude-main-2"));
  await vi.waitFor(() => expect(rejectPeers).toBeTypeOf("function"));
  expect(signal.aborted).toBe(false);
  rejectPeers(new Error("slow broker peers validation timed out"));
  const rejection = process.listeners("unhandledRejection").find(listener => !beforeRejection.includes(listener));
  const exception = process.listeners("uncaughtException").find(listener => !beforeException.includes(listener));
  expect(rejection).toBeTypeOf("function"); expect(exception).toBeTypeOf("function");
  // Invoke only the runner's guards; emitting on Vitest's process would invoke its own fatal-error hooks.
  rejection!(new Error("escaped request rejection"), Promise.resolve());
  exception!(new Error("escaped timer exception"), "uncaughtException");
  await vi.waitFor(() => expect(mocks.node.peers).toHaveBeenCalledTimes(2), { timeout: 5_000 });
  expect(live.post).not.toHaveBeenCalled();
  expect(readFileSync(store, "utf8")).toBe(original);
  expect(mocks.node.updateJob).not.toHaveBeenCalled();
  expect(signal.aborted).toBe(false);
  expect(() => worktreeLease(home!, wt)).toThrow("unreconciled lease");
  mocks.node.emit("message", control("main-control", "claude-main"));
  await vi.waitFor(() => expect(live.post).toHaveBeenCalledWith("main-control", undefined, "main-control"));
  finish(); expect(await running).toBe(0);
  expect(mocks.node.send.mock.calls.at(-1)?.[0]).toMatchObject({ to: "claude-main", body: expect.stringContaining("main turn still completed") });
  expect(readRunnerState(home, spec.job.id)).toMatchObject({ status: "done", delivered: true, sessionId: "main-native-context", workdir: wt.path });
  expect(process.listeners("unhandledRejection")).toEqual(beforeRejection);
  expect(process.listeners("uncaughtException")).toEqual(beforeException);
  expect(mocks.delegate).toHaveBeenCalledOnce();
  worktreeLease(home, wt)(); expect(readFileSync(userFile, "utf8")).toBe("preserved second-session bytes");
}, 20_000);
