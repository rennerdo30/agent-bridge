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
import { closeMetadataDb, metadataDb } from "../src/core/metadata-db.js";
import { assertRunnerArchiveAdmission, publishRunnerSpec, readPendingRunnerSpec, readOriginalRunnerSpec, writeRunnerStateRecord } from "../src/core/runner-store.js";

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
    updateJob = vi.fn(async () => {});
    markRead = vi.fn();
    constructor(options: { name: string }) { super(); this.name = options.name; mocks.node = this; }
  } };
});
let env: TestEnv;
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); if (env) await env.cleanup(); });
function spec(): RunnerSpec {
  const args = { prompt: "Controlled single provider", title: "Delivery settlement" };
  const config: RunnerSpec = { home: env.home, target: "codex", args, base: args, owner: "supervisor", byAgent: "codex", cwd: env.home, cfg: DEFAULT_CONFIG,
    job: { id: "abcdef12", name: "codex-job-abcdef12", owner: "supervisor", supervisor: "original-supervisor-session", agent: "codex", model: null,
      prompt: args.prompt, startedAt: Date.now(), sessionId: "original-native-session", workdir: env.home, worktree: null, allowedServers: [] } };
  publishRunnerSpec(env.home, config.job.id, { ...config });
  return config;
}

it("completes exact archived input proofs through multiple suspended overlapping control batches", async () => {
  env = makeEnv(); vi.useFakeTimers(); const config = spec();
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ ...config.job, status: "running", args: config.args }] }));
  const releases: (() => void)[] = [], turns: any[] = [];
  mocks.delegate.mockImplementation(async (ctx, _target, args, _signal, _progress, _background, job) => {
    turns.push({ ctx, job, args });
    await new Promise<void>(resolve => { releases.push(resolve); });
    return { status: "done", text: `Exact result ${turns.length}`, sessionId: job.sessionId };
  });
  const running = runOwnedJobRunner(config, nullLogger, null);
  const control = async (n: number) => {
    mocks.node.emit("message", { id: `mail-${n}`, from: { name: "supervisor" }, conversationId: `jobctl-${config.job.id}`,
      createdAt: Date.now(), body: JSON.stringify({ type: "message", cid: `control-${n}`, body: `Exact continuation ${n}` }) });
    await vi.waitFor(() => expect(mocks.node.markRead).toHaveBeenCalledWith([`mail-${n}`]));
  };
  try {
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    for (let n = 1; n <= 3; n++) {
      await control(n);
      const accepted = readRunnerState(env.home, config.job.id)!.retainedRunnerInputs!;
      if (n > 1) expect(accepted.batches!.find(b => b.controls.some(c => c.cid === `control-${n - 1}`)))
        .toMatchObject({ phase: "provider-admitted", bodies: [`Exact continuation ${n - 1}`] });
      expect(accepted.batches!.find(b => b.controls.some(c => c.cid === `control-${n}`)))
        .toMatchObject({ phase: "pending", bodies: [`Exact continuation ${n}`] });
      // Complete an actual accepted note while Cn is queued and C(n-1) is
      // suspended in the provider: this archives the production input evidence.
      turns[n - 1].ctx.jobs.fromSubagent(turns[n - 1].job, `Exact overlap note ${n}`, null, false, true);
      await vi.waitFor(() => expect(readRunnerState(env.home, config.job.id)?.deliveryLedger?.entries).toHaveLength(0));
      releases[n - 1]!();
      await vi.waitFor(() => expect(turns).toHaveLength(n + 1));
      if (n > 1) {
        const completed = readRunnerState(env.home, config.job.id)!.retainedRunnerInputs!.batches!.find(b => b.controls[0]?.cid === `control-${n - 1}`)!;
        expect(completed).toMatchObject({ phase: "consumed", result: { reportId: expect.any(String), report: expect.stringContaining(`Exact result ${n}`) } });
        const proofs = metadataDb(env.home).prepare("SELECT value FROM bridge_metadata WHERE domain='runner-retention-proof'").all();
        expect(proofs.some(row => JSON.parse(String(row.value)).messageId === `input:${completed.batch}`)).toBe(true);
      }
    }
    releases[3]!(); expect(await running).toBe(0);
    expect(mocks.delegate).toHaveBeenCalledTimes(4);
    expect(mocks.node.markRead.mock.calls).toEqual([[['mail-1']], [['mail-2']], [['mail-3']]]);
    expect(mocks.node.send.mock.calls.filter(([m]: any) => m.body.includes("Exact result 4"))).toHaveLength(1);
    expect(() => assertRunnerArchiveAdmission(env.home, config.job.id)).not.toThrow();
    const state = readRunnerState(env.home, config.job.id)!;
    expect(state).toMatchObject({ delivered: true, deliveryLedger: { entries: [] }, retainedRunnerInputs: { phase: "consumed" } });
    const db = metadataDb(env.home), originals = db.prepare("SELECT value FROM bridge_metadata WHERE domain='job-state-archive'").all();
    for (let n = 1; n <= 3; n++) expect(originals.some(row => String(row.value).includes(`Exact continuation ${n}`))).toBe(true);
    closeMetadataDb(env.home);
    expect(() => assertRunnerArchiveAdmission(env.home, config.job.id)).not.toThrow();
  } finally { for (const release of releases) release(); await vi.advanceTimersByTimeAsync(400_000); await running; vi.clearAllTimers(); }
});

it("retains queued and executing batch identities on cancellation and recovers the dead generation without another turn", async () => {
  env = makeEnv(); vi.useFakeTimers(); const config = spec();
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ ...config.job, status: "running", args: config.args }] }));
  let release!: () => void;
  mocks.delegate.mockImplementation(async (_ctx, _target, _args, _signal, _progress, _background, job) => {
    if (mocks.delegate.mock.calls.length === 2) await new Promise<void>(resolve => { release = resolve; });
    else job.queue.push("First continuation");
    return { status: "done", text: "Original completed context", sessionId: job.sessionId };
  });
  const previous = process.listeners("SIGTERM");
  const running = runOwnedJobRunner(config, nullLogger, null);
  try {
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    mocks.node.emit("message", { id: "late-control", from: { name: "supervisor" }, conversationId: `jobctl-${config.job.id}`, createdAt: Date.now(),
      body: JSON.stringify({ type: "message", cid: "late-cid", body: "Unconsumed exact late input" }) });
    await vi.waitFor(() => expect(mocks.node.markRead).toHaveBeenCalledWith(["late-control"]));
    const accepted = readRunnerState(env.home, config.job.id)!.retainedRunnerInputs!.batches!;
    expect(accepted.map(b => b.phase)).toEqual(["provider-admitted", "pending"]);
    const stop = process.listeners("SIGTERM").find(listener => !previous.includes(listener))!; stop("SIGTERM");
    release(); expect(await running).toBe(1);
    const pending = readRunnerState(env.home, config.job.id)!;
    expect(pending.delivered).toBe(false); expect(pending.retainedRunnerInputs!.batches!.map(b => [b.batch, b.bodies, b.controls])).toEqual(accepted.map(b => [b.batch, b.bodies, b.controls]));
    expect(() => publishRunnerSpec(env.home, config.job.id, { owner: "replacement" })).toThrow(/unsettled/);
    writeRunnerStateRecord(env.home, config.job.id, { ...pending, pid: 2147483647, identity: "owned-dead-generation" });
    const host = new runnerStore.JobRunners({} as any, env.home, "unused-cli", nullLogger);
    const recovery = host.recoverRetention({ ...config.job, controller: new AbortController(), allowedServers: new Set(), queue: [] } as any);
    await vi.runAllTimersAsync(); await recovery;
    expect(mocks.delegate).toHaveBeenCalledTimes(2);
    const recovered = readRunnerState(env.home, config.job.id)!;
    expect(recovered.retainedRunnerInputs!.batches!.map(b => [b.batch, b.bodies, b.controls])).toEqual(accepted.map(b => [b.batch, b.bodies, b.controls]));
    expect(recovered.retainedRunnerInputs!.batches!.map(b => b.phase)).toEqual(["consumed", "evidence"]);
    expect(recovered).toMatchObject({ delivered: false, reportId: pending.reportId, report: pending.report });
    expect(() => assertRunnerArchiveAdmission(env.home, config.job.id)).not.toThrow();
  } finally { release?.(); await vi.advanceTimersByTimeAsync(400_000); await running; vi.clearAllTimers(); }
});

it("holds exact accepted evidence on a malformed send response without a false receipt or final dispatch", async () => {
  env = makeEnv(); vi.useFakeTimers(); const config = spec();
  mocks.delegate.mockImplementation(async (ctx, _target, _args, _signal, _progress, _background, job) => {
    ctx.jobs.fromSubagent(job, "Original malformed-response note", null, false, true);
    return { status: "done", text: "Unsettled dependent final", sessionId: job.sessionId };
  });
  const running = runOwnedJobRunner(config, nullLogger, null);
  mocks.node.send.mockResolvedValue({ deliveredTo: ["supervisor"], queuedFor: [] });
  expect(await running).toBe(1);
  expect(mocks.node.send).toHaveBeenCalledOnce();
  const state = readRunnerState(env.home, config.job.id)!;
  expect(state).toMatchObject({ delivered: false, deliveryRetentionFailure: "invalid-evidence" });
  expect(JSON.parse(state.deliveryLedger!.entries[0]!.record)).toMatchObject({ body: "Original malformed-response note", to: "supervisor", dedupeKey: mocks.node.send.mock.calls[0][0].dedupeKey });
});

it.each([false, true])("captures all accepted successors and holds %s continuation input behind suspended failed retention", async continuation => {
  env = makeEnv(); vi.useFakeTimers(); const config = spec();
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ ...config.job, status: "running", args: config.args }] }));
  let release!: () => void, suspended = false, activeJob: any;
  const held = new Promise<void>(resolve => { release = resolve; });
  const open = asyncFs.open;
  const failedWriter = vi.spyOn(asyncFs, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    vi.spyOn(handle, "sync").mockImplementation(async () => {
      if (!suspended) { suspended = true; await held; }
      throw new Error("controlled retention failure");
    });
    return handle;
  });
  mocks.delegate.mockImplementation(async (ctx, _target, _args, _signal, _progress, _background, job) => {
    activeJob = job;
    if (mocks.delegate.mock.calls.length === 1) {
      for (const body of ["First accepted note", "Second accepted note", "Third accepted note"]) ctx.jobs.fromSubagent(job, body, null, false, true);
      if (continuation) { job.queue.push("Original queued continuation"); job.usageQueuedControls = [{ cid: "original-control", body: "Original queued continuation" }]; }
    }
    return { status: "done", text: "Exact dependent final", sessionId: job.sessionId };
  });
  let settled = false;
  const running = runOwnedJobRunner(config, nullLogger, null).then(code => { settled = true; return code; });
  mocks.node.send.mockRejectedValue(new BridgeError("protocol_mismatch", "terminal refusal"));
  try {
    await vi.waitFor(() => expect(suspended).toBe(true));
    expect(mocks.delegate).toHaveBeenCalledOnce();
    if (continuation) expect(activeJob.queue).toEqual(["Original queued continuation"]);
    const ledger = (readRunnerState(env.home, config.job.id) as any).deliveryLedger;
    expect(ledger.entries.slice(0, 3).map((entry: any) => JSON.parse(entry.record).body)).toEqual(["First accepted note", "Second accepted note", "Third accepted note"]);
    expect(new Set(ledger.entries.map((entry: any) => entry.messageId)).size).toBe(ledger.entries.length);
    expect(mocks.node.send).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    release(); await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 });
    expect(await running).toBe(1); expect(mocks.delegate).toHaveBeenCalledOnce();
    const after = (readRunnerState(env.home, config.job.id) as any).deliveryLedger;
    expect(after).toEqual(ledger);
    failedWriter.mockRestore();
    const failed = readRunnerState(env.home, config.job.id)!;
    writeRunnerStateRecord(env.home, config.job.id, { ...failed, pid: 2147483647, identity: "original-dead-process" });
    const host = new runnerStore.JobRunners({} as any, env.home, "unused-cli", nullLogger);
    const job = { ...config.job, controller: new AbortController(), allowedServers: new Set(), queue: [] } as any;
    const originalSpec = readOriginalRunnerSpec(env.home, config.job.id)!;
    const originalNode = mocks.node;
    await expect(host.recoverRetention({ ...job, startedAt: job.startedAt + 1 })).rejects.toMatchObject({ code: "RUNNER_RETENTION_UNSETTLED" });
    expect((readRunnerState(env.home, config.job.id) as any).deliveryLedger).toEqual(ledger);
    const db = metadataDb(env.home);
    db.prepare("UPDATE bridge_metadata SET value=? WHERE domain='job-spec' AND key=?").run(JSON.stringify({ ...originalSpec, owner: "foreign-owner" }), config.job.id);
    await expect(host.recoverRetention(job)).rejects.toMatchObject({ code: "RUNNER_RETENTION_UNSETTLED" });
    expect((readRunnerState(env.home, config.job.id) as any).deliveryLedger).toEqual(ledger);
    db.prepare("UPDATE bridge_metadata SET value=? WHERE domain='job-spec' AND key=?").run(JSON.stringify(originalSpec), config.job.id);
    const namespace = db.prepare("SELECT value FROM bridge_metadata WHERE domain='runner-retention-index' AND key='namespace'").get()!.value;
    db.prepare("UPDATE bridge_metadata SET value=? WHERE domain='runner-retention-index' AND key='namespace'").run(JSON.stringify({ version: 1, namespace: "f".repeat(64) }));
    await expect(host.recoverRetention(job)).rejects.toMatchObject({ code: "RUNNER_RETENTION_UNSETTLED" });
    expect((readRunnerState(env.home, config.job.id) as any).deliveryLedger).toEqual(ledger);
    db.prepare("UPDATE bridge_metadata SET value=? WHERE domain='runner-retention-index' AND key='namespace'").run(namespace!);
    const restart = host.startAsync(job, config);
    const refused = expect(restart).rejects.toMatchObject({ code: "RUNNER_PRIOR_GENERATION_RECOVERED" });
    await vi.runAllTimersAsync(); await refused;
    expect(mocks.delegate).toHaveBeenCalledOnce(); expect(mocks.node).toBe(originalNode);
    expect(mocks.node.send).toHaveBeenCalledOnce();
    const recovered = readRunnerState(env.home, config.job.id)!;
    expect(recovered.deliveryLedger).toEqual({ ...ledger, entries: [] });
    expect(recovered).toMatchObject({ report: failed.report, reportId: failed.reportId, delivered: false, pendingDeliveryRetention: [] });
    expect(readOriginalRunnerSpec(env.home, config.job.id)).toEqual(originalSpec);
    const records = readdirSync(join(env.home, "quarantine")).map(file => readFileSync(join(env.home, "quarantine", file), "utf8"));
    for (const entry of ledger.entries) expect(records.filter(record => record === entry.record)).toHaveLength(1);
    if (continuation) expect(recovered.retainedRunnerInputs).toMatchObject({ phase: "evidence", bodies: ["Original queued continuation"], controls: [{ cid: "original-control", body: "Original queued continuation" }] });
  } finally { release(); await vi.advanceTimersByTimeAsync(400_000); await running; vi.clearAllTimers(); }
});

it("refuses the real runner start and spec publication before resetting an unsettled original generation", () => {
  env = makeEnv(); const config = spec();
  const path = publishRunnerSpec(env.home, config.job.id, { ...config });
  runnerStore.writeRunnerState(env.home, config.job.id, { pid: process.pid, peer: config.job.name, status: "done", updatedAt: Date.now(), report: "Original final", reportId: "original-final",
    pendingDeliveryRetention: [{ messageId: "11111111-1111-4111-8111-111111111111", record: "Original evidence" }] });
  const original = readRunnerState(env.home, config.job.id), originalSpec = readPendingRunnerSpec(env.home, config.job.id);
  const runners = new runnerStore.JobRunners({} as any, env.home, "unused-cli", nullLogger);
  const job = { ...config.job, controller: new AbortController(), allowedServers: new Set(), queue: [] } as any;
  expect(() => runners.start(job, config)).toThrow(/retention.*unsettled/i);
  expect(readRunnerState(env.home, config.job.id)).toEqual(original);
  expect(readPendingRunnerSpec(env.home, config.job.id)).toEqual(originalSpec);
  expect(() => publishRunnerSpec(env.home, config.job.id, { ...config, replacement: true })).toThrow(/retention.*unsettled/i);
  expect(readPendingRunnerSpec(env.home, config.job.id)).toEqual(originalSpec);
  expect(path).toContain(config.job.id);
});

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
    expect(retain.mock.calls[1]!.slice(0, 3)).toEqual(retain.mock.calls[0]!.slice(0, 3));
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
    mocks.delegate.mockClear(); mocks.node.start.mockClear(); mocks.node.send.mockClear(); config.owner = "replacement-supervisor";
    await expect(publishInitialRunnerState(config, log)).rejects.toMatchObject({ code: "RUNNER_RETENTION_UNSETTLED" });
    expect(readRunnerState(env.home, config.job.id)).toMatchObject({ pendingDeliveryRetention: [item], report: pending.report, reportId: pending.reportId });
    // The old generation is proven gone via a controlled liveness boundary,
    // while all real production spec/state/namespace/CAS checks remain active.
    writeRunnerStateRecord(env.home, config.job.id, { ...failed, pid: 2147483647, identity: "dead-original-incarnation" });
    const host = new runnerStore.JobRunners({} as any, env.home, "unused-cli", nullLogger);
    const job = { ...config.job, controller: new AbortController(), queue: [], allowedServers: new Set() } as any;
    const start = host.startAsync(job, config);
    const refused = expect(start).rejects.toMatchObject({ code: "RUNNER_PRIOR_GENERATION_RECOVERED" });
    await vi.runAllTimersAsync(); await refused;
    expect(mocks.delegate).not.toHaveBeenCalled(); expect(mocks.node.start).not.toHaveBeenCalled(); expect(mocks.node.send).not.toHaveBeenCalled();
    const recovered = readRunnerState(env.home, config.job.id)!;
    expect(recovered).toMatchObject({ delivered: false, reportId: pending.reportId, report: pending.report, pendingDeliveryRetention: [], retainedDeliveryCount: 2 });
    expect(recovered.deliveryRetentionFailure).toBeUndefined();
    const files = readdirSync(join(env.home, "quarantine")).filter(file => file.endsWith(".txt"));
    expect(files).toHaveLength(2);
    expect(files.map(file => readFileSync(join(env.home, "quarantine", file), "utf8"))).toContain(item.record);
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
    confirmation.mockRestore(); opened.mockClear(); mocks.delegate.mockClear(); mocks.node.start.mockClear(); mocks.node.send.mockClear();
    const conflict = [item, { ...item, record: `${item.record} conflicting retained bytes` }];
    actualWrite(env.home, config.job.id, { ...pending, pendingDeliveryRetention: conflict });
    expect(await runOwnedJobRunner(config, nullLogger, null)).toBe(1);
    expect(readRunnerState(env.home, config.job.id)?.pendingDeliveryRetention).toEqual(conflict);
    expect(mocks.node.start).not.toHaveBeenCalled(); expect(mocks.node.send).not.toHaveBeenCalled(); expect(opened).not.toHaveBeenCalled();
    expect(() => actualWrite(env.home, config.job.id, pending)).toThrow(/unsettled/);
    // Restore only the fixture-injected conflicting corruption, preserving the
    // original canonical snapshot; production repair cannot clear it by field.
    metadataDb(env.home).prepare("UPDATE bridge_metadata SET value=? WHERE domain='job-state' AND key=?").run(JSON.stringify(pending), config.job.id);
    await expect(publishInitialRunnerState(config, nullLogger)).rejects.toMatchObject({ code: "RUNNER_RETENTION_UNSETTLED" });
    writeRunnerStateRecord(env.home, config.job.id, { ...pending, pid: 2147483647, identity: "dead-original-incarnation" });
    const host = new runnerStore.JobRunners({} as any, env.home, "unused-cli", nullLogger);
    const job = { ...config.job, controller: new AbortController(), queue: [], allowedServers: new Set() } as any;
    const recovery = host.recoverRetention(job); await vi.runAllTimersAsync(); await recovery;
    expect(mocks.node.send).not.toHaveBeenCalled(); expect(mocks.node.start).not.toHaveBeenCalled(); expect(mocks.delegate).not.toHaveBeenCalled();
    expect(readFileSync(join(env.home, "quarantine", files[0]!), "utf8")).toBe(original);
    expect(readdirSync(join(env.home, "quarantine"))).toEqual(expect.arrayContaining(files));
    expect(readRunnerState(env.home, config.job.id)).toMatchObject({ reportId: pending.reportId, report: pending.report, delivered: false,
      pendingDeliveryRetention: [], retainedDeliveryCount: 2 });
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
    expect(pending).toMatchObject({ version: 1, kind: "accepted-runner-delivery", job: config.job.id, intendedSender: { kind: "job", agent: "codex", id: `job:${config.job.id}` },
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

it("retains every refused predecessor before admitting the queued turn and dispatching its final exactly once", async () => {
  env = makeEnv(); vi.useFakeTimers(); const config = spec();
  let release!: () => void, suspended = false, settled = false;
  const held = new Promise<void>(resolve => { release = resolve; }), open = asyncFs.open;
  vi.spyOn(asyncFs, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (!suspended) vi.spyOn(handle, "sync").mockImplementationOnce(async () => { suspended = true; await held; throw new Error("controlled first retention interruption"); });
    return handle;
  });
  mocks.delegate.mockImplementation(async (ctx, _target, _args, _signal, _progress, _background, job) => {
    if (mocks.delegate.mock.calls.length === 1) {
      for (const body of ["one", "two", "three"]) ctx.jobs.fromSubagent(job, body, null, false, true);
      job.queue.push("Original continuation"); job.usageQueuedControls = [{ cid: "original-cid", body: "Original continuation" }];
      return { status: "done", text: "first turn result", sessionId: job.sessionId };
    }
    const originals = readdirSync(join(env.home, "quarantine")).filter(file => file.endsWith(".txt")).map(file => JSON.parse(readFileSync(join(env.home, "quarantine", file), "utf8")));
    expect(originals.map(item => item.body).sort()).toEqual(["one", "three", "two"]);
    expect(readRunnerState(env.home, config.job.id)?.retainedRunnerInputs).toMatchObject({ phase: "provider-admitted", bodies: ["Original continuation"] });
    return { status: "done", text: "second exact final", sessionId: job.sessionId };
  });
  const running = runOwnedJobRunner(config, nullLogger, null).then(code => { settled = true; return code; });
  mocks.node.send.mockRejectedValueOnce(new BridgeError("protocol_mismatch", "first refused note"))
    .mockRejectedValueOnce(new BridgeError("protocol_mismatch", "second refused note"))
    .mockRejectedValueOnce(new BridgeError("protocol_mismatch", "third refused note"));
  try {
    await vi.waitFor(() => expect(suspended).toBe(true)); expect(mocks.delegate).toHaveBeenCalledOnce();
    const original = readRunnerState(env.home, config.job.id)!.deliveryLedger!.entries;
    release(); await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5_000 }); expect(await running).toBe(0);
    expect(mocks.delegate).toHaveBeenCalledTimes(2);
    const records = readdirSync(join(env.home, "quarantine")).filter(file => file.endsWith(".txt")).map(file => readFileSync(join(env.home, "quarantine", file), "utf8"));
    for (const entry of original) expect(records.filter(record => record === entry.record)).toHaveLength(1);
    expect(mocks.node.send.mock.calls.filter(([m]: [{ body: string }]) => m.body.includes("second exact final"))).toHaveLength(1);
    expect(readRunnerState(env.home, config.job.id)).toMatchObject({ delivered: true, retainedDeliveryCount: 3, deliveryLedger: { entries: [] }, retainedRunnerInputs: { phase: "consumed" } });
  } finally { release(); if (!settled) await vi.advanceTimersByTimeAsync(400_000); await running; vi.clearAllTimers(); }
});
