import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { completionMessageId, COMPLETION_DEDUPE_PREFIX } from "../src/core/completion.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeError } from "../src/core/protocol.js";
import { readRunnerState, type RunnerSpec } from "../src/mcp/job-host.js";
import { publishInitialRunnerState, runOwnedJobRunner } from "../src/mcp/job-runner.js";
import { makeEnv, type TestEnv } from "./helpers.js";
import * as oversize from "../src/core/oversize.js";
import * as asyncFs from "node:fs/promises";
import * as runnerStore from "../src/mcp/job-host.js";

const mocks = vi.hoisted(() => ({ delegate: vi.fn(), node: null as any }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>() }));
vi.mock("node:timers/promises", async original => ({ ...await original<typeof import("node:timers/promises")>(),
  setTimeout: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) }));
vi.mock("../src/mcp/delegate-run.js", async original => ({ ...await original<typeof import("../src/mcp/delegate-run.js")>(), runDelegate: mocks.delegate }));
vi.mock("../src/core/node.js", async () => {
  const { EventEmitter } = await import("node:events");
  return { BridgeNode: class extends EventEmitter {
    name: string;
    send = vi.fn().mockResolvedValue({ messages: [{ id: "stored" }], deliveredTo: [], queuedFor: [] });
    sendState = vi.fn().mockResolvedValue({ state: "missing" });
    stop = vi.fn(async () => {});
    start = vi.fn(async () => {});
    constructor(options: { name: string }) { super(); this.name = options.name; mocks.node = this; }
  } };
});
let env: TestEnv;
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); if (env) await env.cleanup(); });
function spec(): RunnerSpec {
  const args = { prompt: "Controlled single provider", title: "Delivery settlement" };
  return { home: env.home, target: "codex", args, base: args, owner: "supervisor", byAgent: "codex", cwd: env.home, cfg: DEFAULT_CONFIG,
    job: { id: "abcdef12", name: "codex-job-abcdef12", owner: "supervisor", supervisor: "original-supervisor-session", agent: "codex", model: null,
      prompt: args.prompt, startedAt: Date.now(), sessionId: "original-native-session", workdir: env.home, worktree: null, allowedServers: [] } };
}

it("owns a failed refused-note retention before dispatching or settling the queued final", async () => {
  env = makeEnv(); vi.useFakeTimers(); const config = spec();
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ ...config.job, status: "running", args: config.args }] }));
  const original = asyncFs.open;
  let release!: () => void, suspended = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const retain = vi.spyOn(oversize, "quarantineTextAsync");
  const opened = vi.spyOn(asyncFs, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await original(path, flags, mode);
    if (!suspended) vi.spyOn(handle, "sync").mockImplementation(async () => {
      suspended = true; await held; throw new Error("controlled asynchronous retention fsync failure");
    });
    return handle;
  });
  mocks.delegate.mockImplementation(async (ctx, _target, _args, _signal, _progress, _background, job) => {
    ctx.jobs.fromSubagent(job, "Exact refused note before final", null, false, true);
    return { status: "done", text: "Exact dependent final", sessionId: job.sessionId };
  });
  let settled = false;
  const running = runOwnedJobRunner(config, nullLogger, null).then(code => { settled = true; return code; });
  mocks.node.send.mockRejectedValueOnce(new BridgeError("protocol_mismatch", "incompatible broker"));
  try {
    await vi.waitFor(() => expect(suspended).toBe(true));
    expect(mocks.node.send).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false); expect(mocks.node.stop).not.toHaveBeenCalled();
    const before = readRunnerState(env.home, config.job.id)!;
    expect(before).toMatchObject({ delivered: false, pendingDeliveryRetention: [{ messageId: expect.any(String), record: expect.any(String) }] });
    release();
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(await running).toBe(0);
    expect(retain).toHaveBeenCalledTimes(2);
    expect(retain.mock.calls[1]).toEqual(retain.mock.calls[0]);
    expect(mocks.node.send).toHaveBeenCalledTimes(2);
    const records = readdirSync(join(env.home, "quarantine")).filter(file => file.endsWith(".txt"));
    expect(records).toHaveLength(1);
    const pending = JSON.parse(readFileSync(join(env.home, "quarantine", records[0]!), "utf8"));
    expect(pending).toMatchObject({ body: "Exact refused note before final", to: "supervisor", authority: "evidence-only-no-replay",
      dedupeKey: mocks.node.send.mock.calls[0][0].dedupeKey });
    expect(readRunnerState(env.home, config.job.id)).toMatchObject({ delivered: true, reportId: before.reportId, report: before.report, retainedDeliveryCount: 1, pendingDeliveryRetention: [] });
    expect(readdirSync(join(env.home, "quarantine")).some(file => file.endsWith(".tmp"))).toBe(false);
    expect(opened).toHaveBeenCalledTimes(2);
  } finally { release(); await vi.advanceTimersByTimeAsync(400_000); await running; vi.clearAllTimers(); }
});

it.each([false, true])("keeps exact pending evidence on %s cancellation/exhaustion and recovers retention without replay on restart", async cancel => {
  env = makeEnv(); vi.useFakeTimers(); const config = spec();
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ ...config.job, status: "running", args: config.args }] }));
  const open = asyncFs.open;
  let release!: () => void, suspended = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const opened = vi.spyOn(asyncFs, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      if (!suspended) { suspended = true; await held; }
      throw new Error("controlled persistent retention fsync failure PRIVATE_ERROR");
    });
    return handle;
  });
  const log = { ...nullLogger, info: vi.fn(), error: vi.fn() };
  let posted: Promise<unknown> | undefined;
  mocks.delegate.mockImplementation(async (ctx, _target, _args, _signal, _progress, _background, job) => {
    posted = ctx.jobs.fromSubagent(job, "Exact durable pending note", null, false, true);
    return { status: "done", text: "Exact pending dependent final", sessionId: job.sessionId };
  });
  const previousStops = process.listeners("SIGTERM");
  let settled = false;
  const running = runOwnedJobRunner(config, log, null).then(code => { settled = true; return code; });
  mocks.node.send.mockRejectedValueOnce(new BridgeError("protocol_mismatch", "exact-version refusal"));
  try {
    await vi.waitFor(() => expect(suspended).toBe(true));
    const pending = readRunnerState(env.home, config.job.id)!;
    expect(pending.reportId).toBeTypeOf("string"); expect(pending.pendingDeliveryRetention).toHaveLength(1);
    const item = pending.pendingDeliveryRetention![0]!;
    const record = JSON.parse(item.record);
    expect(record).toMatchObject({ body: "Exact durable pending note", to: "supervisor", attemptedTo: "supervisor",
      authority: "evidence-only-no-replay", supervisor: config.job.supervisor, dedupeKey: mocks.node.send.mock.calls[0][0].dedupeKey });
    if (cancel) {
      const stops = process.listeners("SIGTERM").filter(listener => !previousStops.includes(listener));
      expect(stops).toHaveLength(1); stops[0]!("SIGTERM");
      await vi.advanceTimersByTimeAsync(1);
      // Cancellation must join the actual write, rather than detach it and claim drain.
      expect(settled).toBe(false); expect(mocks.node.stop).not.toHaveBeenCalled();
    }
    release(); await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
    expect(await running).toBe(1);
    await expect(posted).rejects.toMatchObject({ code: "RUNNER_RETENTION_UNSETTLED", reason: cancel ? "shutdown" : "attempts-exhausted" });
    expect(opened).toHaveBeenCalledTimes(cancel ? 1 : 6);
    expect(mocks.node.send).toHaveBeenCalledTimes(1); expect(mocks.node.sendState).not.toHaveBeenCalled();
    expect(log.info.mock.calls.some(call => call[0] === "job runner done" || call[0] === "job final delivery settled")).toBe(false);
    expect(log.error).toHaveBeenCalledWith("job runner delivery unsettled", { reason: cancel ? "shutdown" : "attempts-exhausted", pending: 1 });
    const failed = readRunnerState(env.home, config.job.id)!;
    expect(failed).toMatchObject({ delivered: false, reportId: pending.reportId, report: pending.report,
      pendingDeliveryRetention: [item], deliveryRetentionFailure: cancel ? "shutdown" : "attempts-exhausted" });
    expect(failed.finalDelivery).toBeUndefined();
    expect(readdirSync(join(env.home, "quarantine"))).toHaveLength(0);
    opened.mockRestore();
    // Simulated restart uses real persisted state, not the old in-memory queue.
    // Even a changed current display owner never replays this original note.
    mocks.delegate.mockClear(); config.owner = "replacement-supervisor";
    await publishInitialRunnerState(config, log);
    expect(readRunnerState(env.home, config.job.id)).toMatchObject({ pendingDeliveryRetention: [item], report: pending.report, reportId: pending.reportId });
    expect(await runOwnedJobRunner(config, log, null)).toBe(0);
    expect(mocks.delegate).not.toHaveBeenCalled(); expect(mocks.node.start).not.toHaveBeenCalled(); expect(mocks.node.send).not.toHaveBeenCalled();
    const recovered = readRunnerState(env.home, config.job.id)!;
    expect(recovered).toMatchObject({ delivered: false, reportId: pending.reportId, report: pending.report, pendingDeliveryRetention: [], retainedDeliveryCount: 1 });
    expect(recovered.deliveryRetentionFailure).toBeUndefined();
    const files = readdirSync(join(env.home, "quarantine")).filter(file => file.endsWith(".txt"));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(env.home, "quarantine", files[0]!), "utf8")).toBe(item.record);
  } finally { release(); await vi.advanceTimersByTimeAsync(400_000); await running; vi.clearAllTimers(); }
});

it("recovers interruption after quarantine publication before confirmation without rewriting or replaying the note", async () => {
  env = makeEnv(); vi.useFakeTimers(); const config = spec();
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ ...config.job, status: "running", args: config.args }] }));
  const actualWrite = runnerStore.writeRunnerState;
  const confirmation = vi.spyOn(runnerStore, "writeRunnerState").mockImplementation((home, id, state) => {
    if (state.pendingDeliveryRetention?.length === 0 && state.retainedDeliveryCount === 1) throw new Error("confirmation storage unavailable");
    actualWrite(home, id, state);
  });
  const opened = vi.spyOn(asyncFs, "open");
  mocks.delegate.mockImplementation(async (ctx, _target, _args, _signal, _progress, _background, job) => {
    ctx.jobs.fromSubagent(job, "Already fsynced original note", null, false, true);
    return { status: "done", text: "Final cannot pass unconfirmed predecessor", sessionId: job.sessionId };
  });
  let settled = false;
  const running = runOwnedJobRunner(config, nullLogger, null).then(code => { settled = true; return code; });
  mocks.node.send.mockRejectedValueOnce(new BridgeError("protocol_mismatch", "incompatible broker"));
  try {
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
    expect(await running).toBe(1); expect(mocks.node.send).toHaveBeenCalledOnce();
    const pending = readRunnerState(env.home, config.job.id)!;
    const item = pending.pendingDeliveryRetention![0]!;
    expect(pending.delivered).toBe(false); expect(pending.finalDelivery).toBeUndefined();
    const files = readdirSync(join(env.home, "quarantine")); expect(files).toHaveLength(1);
    const original = readFileSync(join(env.home, "quarantine", files[0]!), "utf8");
    expect(original).toBe(item.record); expect(opened).toHaveBeenCalledOnce();
    confirmation.mockRestore(); opened.mockClear(); mocks.delegate.mockClear();
    const conflict = [item, { ...item, record: `${item.record} conflicting retained bytes` }];
    actualWrite(env.home, config.job.id, { ...pending, pendingDeliveryRetention: conflict });
    expect(await runOwnedJobRunner(config, nullLogger, null)).toBe(1);
    expect(readRunnerState(env.home, config.job.id)?.pendingDeliveryRetention).toEqual(conflict);
    expect(mocks.node.start).not.toHaveBeenCalled(); expect(mocks.node.send).not.toHaveBeenCalled(); expect(opened).not.toHaveBeenCalled();
    actualWrite(env.home, config.job.id, pending);
    await publishInitialRunnerState(config, nullLogger);
    expect(await runOwnedJobRunner(config, nullLogger, null)).toBe(0);
    expect(opened).not.toHaveBeenCalled(); expect(mocks.node.send).not.toHaveBeenCalled(); expect(mocks.node.start).not.toHaveBeenCalled(); expect(mocks.delegate).not.toHaveBeenCalled();
    expect(readFileSync(join(env.home, "quarantine", files[0]!), "utf8")).toBe(original);
    expect(readdirSync(join(env.home, "quarantine"))).toEqual(files);
    expect(readRunnerState(env.home, config.job.id)).toMatchObject({ reportId: pending.reportId, report: pending.report, delivered: false,
      pendingDeliveryRetention: [], retainedDeliveryCount: 1 });
  } finally { confirmation.mockRestore(); await vi.advanceTimersByTimeAsync(400_000); await running; vi.clearAllTimers(); }
});

it.each(["done", "cancelled"] as const)("keeps a %s final pending behind an accepted note until storage, including runner shutdown", async status => {
  env = makeEnv(); vi.useFakeTimers();
  const config = spec();
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ ...config.job, status: "running", args: config.args }] }));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  mocks.delegate.mockImplementation(async (ctx, _target, _args, _signal, _progress, _background, job) => {
    ctx.jobs.fromSubagent(job, "Private retained note", null, false, true);
    return { status, text: "Private exact final body", sessionId: job.sessionId };
  });
  let settled = false;
  const previousStops = process.listeners("SIGTERM");
  const running = runOwnedJobRunner(config, nullLogger, null).then(code => { settled = true; return code; });
  mocks.node.send.mockImplementationOnce(async () => { await held; return { messages: [{ id: "note" }] }; });
  try {
    await vi.waitFor(() => expect(readRunnerState(env.home, config.job.id)?.reportId).toBeTypeOf("string"));
    const retained = readRunnerState(env.home, config.job.id)!;
    expect(retained).toMatchObject({ status, delivered: false, report: expect.stringContaining("Private exact final body") });
    expect(mocks.node.send).toHaveBeenCalledTimes(1); expect(settled).toBe(false); expect(mocks.node.stop).not.toHaveBeenCalled();
    if (status === "cancelled") {
      // Invoke only this runner's owned stop handler; no process signal/provider is launched.
      const ownedStops = process.listeners("SIGTERM").filter(listener => !previousStops.includes(listener));
      expect(ownedStops).toHaveLength(1); ownedStops[0]!("SIGTERM");
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false); expect(mocks.node.stop).not.toHaveBeenCalled();
    }
    release(); expect(await running).toBe(0);
    const final = readRunnerState(env.home, config.job.id)!;
    expect(final).toMatchObject({ status, reportId: retained.reportId, report: retained.report, delivered: true,
      finalDelivery: { state: "stored", cause: "send-receipt", attempt: 1, persisted: true, messageId: completionMessageId(`job:${config.job.id}`, retained.reportId!) } });
    expect(mocks.node.send.mock.calls[1][0]).toMatchObject({ body: retained.report, dedupeKey: `${COMPLETION_DEDUPE_PREFIX}${retained.reportId}` });
    expect(mocks.node.stop).toHaveBeenCalledOnce();
  } finally { release(); if (!settled) await running; vi.clearAllTimers(); }
});

it("retains a protocol-refused note before releasing its final, without retrying or claiming storage", async () => {
  env = makeEnv(); vi.useFakeTimers(); const config = spec();
  mkdirSync(join(env.home, "quarantine"));
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ ...config.job, status: "running", args: config.args }] }));
  const refusal = new BridgeError("protocol_mismatch", "Broker did not attest the exact native identity; mailbox access refused. PRIVATE_ERROR_TOKEN", {
    protocolObservation: { operation: "auth_hello", connectionGeneration: 2, clientProtocol: 6, brokerProtocol: 6 } });
  mocks.delegate.mockImplementation(async (ctx, _target, _args, _signal, _progress, _background, job) => {
    ctx.jobs.fromSubagent(job, "Private exact refused note", null, false, true);
    return { status: "done", text: "Private exact final body", sessionId: job.sessionId };
  });
  let settled = false;
  const running = runOwnedJobRunner(config, nullLogger, null).then(code => { settled = true; return code; });
  mocks.node.send.mockRejectedValue(refusal); mocks.node.sendState.mockRejectedValue(refusal);
  try {
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2_000 });
    expect(await running).toBe(0); expect(mocks.node.send).toHaveBeenCalledTimes(2);
    const retained = readRunnerState(env.home, config.job.id)!;
    expect(retained).toMatchObject({ status: "done", delivered: false, report: expect.stringContaining("Private exact final body"),
      finalDelivery: { state: "retained", cause: "permanent-refusal", attempt: 1, persisted: true, code: "protocol_mismatch", reason: "protocol-refusal",
        protocol: { source: "native-attestation", operation: "auth_hello", connectionGeneration: 2, clientProtocol: 6, brokerProtocol: 6 } } });
    const files = readdirSync(join(env.home, "quarantine")).filter(file => file.endsWith(".txt"));
    expect(files).toHaveLength(1);
    const pending = JSON.parse(readFileSync(join(env.home, "quarantine", files[0]!), "utf8"));
    expect(pending).toMatchObject({ version: 1, kind: "refused-runner-delivery", job: config.job.id, intendedSender: { kind: "job", agent: "codex", id: `job:${config.job.id}` },
      to: "supervisor", body: "Private exact refused note", dedupeKey: mocks.node.send.mock.calls[0][0].dedupeKey, authority: "evidence-only-no-replay" });
    expect(pending).toMatchObject({ wireBody: mocks.node.send.mock.calls[0][0].body, conversationId: mocks.node.send.mock.calls[0][0].conversationId });
    expect(pending.messageId).toBe(completionMessageId(`send:${config.job.name}`, pending.dedupeKey));
    expect(JSON.stringify(retained.finalDelivery)).not.toMatch(/Private|PRIVATE_ERROR_TOKEN/);
    expect(mocks.node.stop).toHaveBeenCalledOnce();
  } finally {
    // Base code has the finite old30-note/6-final retry budget; drain only fake time for cleanup.
    if (!settled) await vi.advanceTimersByTimeAsync(400_000);
    await running; vi.clearAllTimers();
  }
});

it("recovers a lost final ACK by its original receipt without replaying a new body or UUID", async () => {
  env = makeEnv(); vi.useFakeTimers(); const config = spec();
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ ...config.job, status: "running", args: config.args }] }));
  mocks.delegate.mockResolvedValue({ status: "done", text: "Private accepted final", sessionId: config.job.sessionId });
  let accepted: { body: string; dedupeKey: string } | undefined;
  const running = runOwnedJobRunner(config, nullLogger, null);
  mocks.node.send.mockImplementation(async (message: typeof accepted) => { accepted = message; throw new Error("broker request timed out: send"); });
  mocks.node.sendState.mockImplementation(async () => ({ state: accepted ? "stored" : "missing" }));
  try {
    await vi.waitFor(() => expect(accepted).toBeDefined());
    const retained = readRunnerState(env.home, config.job.id)!;
    expect(retained.delivered).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000); expect(await running).toBe(0);
    expect(readRunnerState(env.home, config.job.id)).toMatchObject({ reportId: retained.reportId, report: retained.report, delivered: true,
      finalDelivery: { state: "stored", cause: "receipt-probe", attempt: 2, messageId: completionMessageId(`job:${config.job.id}`, retained.reportId!) } });
    expect(accepted).toMatchObject({ body: retained.report, dedupeKey: `${COMPLETION_DEDUPE_PREFIX}${retained.reportId}` });
    expect(mocks.node.send).toHaveBeenCalledOnce();
  } finally { vi.clearAllTimers(); }
});
