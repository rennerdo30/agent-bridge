import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { completionMessageId, COMPLETION_DEDUPE_PREFIX } from "../src/core/completion.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeError } from "../src/core/protocol.js";
import { readRunnerState, type RunnerSpec } from "../src/mcp/job-host.js";
import { runOwnedJobRunner } from "../src/mcp/job-runner.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const mocks = vi.hoisted(() => ({ delegate: vi.fn(), node: null as any }));
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
    constructor(options: { name: string }) { super(); this.name = options.name; mocks.node = this; }
    async start() {}
  } };
});
let env: TestEnv;
afterEach(async () => { vi.useRealTimers(); vi.clearAllMocks(); if (env) await env.cleanup(); });
function spec(): RunnerSpec {
  const args = { prompt: "Controlled single provider", title: "Delivery settlement" };
  return { home: env.home, target: "codex", args, base: args, owner: "supervisor", byAgent: "codex", cwd: env.home, cfg: DEFAULT_CONFIG,
    job: { id: "abcdef12", name: "codex-job-abcdef12", owner: "supervisor", supervisor: "original-supervisor-session", agent: "codex", model: null,
      prompt: args.prompt, startedAt: Date.now(), sessionId: "original-native-session", workdir: env.home, worktree: null, allowedServers: [] } };
}

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
