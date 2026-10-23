import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { deliverFinalResult, PERMANENT_DELIVERY_CODES, readJobReport, readStoredFinalResult, resultDeliveryLabel, type StoredFinalResult } from "../src/mcp/final-result.js";
import { JobRunners, writeRunnerState } from "../src/mcp/job-host.js";
import { publishRunnerSpec, runnerLedgerNamespace } from "../src/core/runner-store.js";
import { runnerLedgerPrincipal } from "../src/mcp/runner-delivery-retention.js";
import { quarantineTextAsync } from "../src/core/oversize.js";
import { deliverWithRetry, inSendOrder } from "../src/mcp/job-runner.js";
import { deliveryEvidenceSchema, deliveryFailure } from "../src/mcp/delivery-evidence.js";
import { JobManager, readStore, type Job, type RunnerState } from "../src/mcp/jobs.js";
import { nullLogger } from "../src/core/logger.js";
import { BridgeError } from "../src/core/protocol.js";
import { JOBS_FILE, PROTOCOL_VERSION } from "../src/core/constants.js";
import { makeEnv, until } from "./helpers.js";
import { jobWaitSnapshot } from "./job-wait-diagnostics.js";

const report = "Subagent codex-job-12345678 done after 1s.\n\nFinal review";
const initial = (): StoredFinalResult => ({ report, reportId: "turn-one", delivered: false });

it("retries only compatible handover without weakening terminal protocol refusal", async () => {
  const waits = vi.fn(async () => {}), persist = vi.fn();
  const send = vi.fn().mockRejectedValueOnce(new BridgeError("protocol_mismatch", "broker is stopping", { handover: true, brokerProtocol: PROTOCOL_VERSION }))
    .mockResolvedValue({ stored: true });
  expect(await deliverFinalResult(initial(), persist, send, waits)).toMatchObject({ state: "stored", cause: "send-receipt", attempt: 2 });
  expect(send).toHaveBeenCalledTimes(2); expect(waits).toHaveBeenCalledOnce();
  send.mockReset().mockRejectedValue(new BridgeError("protocol_mismatch", "broker speaks protocol 5", { handover: true, brokerProtocol: PROTOCOL_VERSION - 1 }));
  waits.mockClear(); persist.mockClear();
  expect(await deliverFinalResult(initial(), persist, send, waits)).toMatchObject({ state: "retained", cause: "permanent-refusal", attempt: 1, persisted: true, code: "protocol_mismatch" });
  expect(send).toHaveBeenCalledOnce(); expect(waits).not.toHaveBeenCalled(); expect(persist).toHaveBeenLastCalledWith(initial());
});

it("stores before a failed send, then retries with the same identity", async () => {
  let saved: StoredFinalResult | null = null;
  const persist = vi.fn((state: StoredFinalResult) => { saved = { ...state }; });
  const send = vi.fn().mockRejectedValueOnce(new Error("broker restarted")).mockResolvedValue({ stored: true });
  await deliverFinalResult(initial(), persist, send, async () => {});
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[0]).toEqual([report, "turn-one"]);
  expect(send.mock.calls[1]).toEqual([report, "turn-one"]);
  expect(persist.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
  expect(saved).toMatchObject({ delivered: true });
});

it("does not send while durable storage rejects the result", async () => {
  const persist = vi.fn().mockImplementationOnce(() => { throw new Error("database busy"); }).mockImplementation(() => {});
  const send = vi.fn().mockResolvedValue({ stored: true });
  await deliverFinalResult(initial(), persist, send, async () => {});
  expect(persist).toHaveBeenCalledTimes(3);
  expect(persist.mock.invocationCallOrder[1]).toBeLessThan(send.mock.invocationCallOrder[0]!);
});

it("resumes an undelivered stored result after the sender restarts", async () => {
  let saved = initial();
  const controller = new AbortController();
  const send = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ stored: true });
  await deliverFinalResult(saved, (state) => { saved = { ...state }; }, send, async () => controller.abort(), controller.signal);
  expect(saved).toMatchObject({ report, reportId: "turn-one", delivered: false });
  expect(resultDeliveryLabel(saved, false)).toBe("result stored, not delivered");
  await deliverFinalResult(saved, (state) => { saved = { ...state }; }, send, async () => {});
  expect(send).toHaveBeenCalledTimes(2);
  expect(saved.delivered).toBe(true);
});

it("allows the parent to fetch the stored report after delivery fails", async () => {
  const env = makeEnv();
  try {
    const controller = new AbortController();
    await deliverFinalResult(initial(), (state) => writeRunnerState(env.home, "12345678", {
      pid: process.pid, peer: "codex-job-12345678", status: "done", updatedAt: Date.now(), ...state,
    }), async () => { throw new Error("offline"); }, async () => controller.abort(), controller.signal);
    const fetched = readStoredFinalResult(env.home, "12345678");
    expect(fetched?.report).toBe(report);
    expect(resultDeliveryLabel(fetched, false)).toBe("result stored, not delivered");
  } finally { await env.cleanup(); }
});

it("does not send again after a durable receipt", async () => {
  const send = vi.fn();
  await deliverFinalResult({ ...initial(), delivered: true }, () => {}, send, async () => {});
  expect(send).not.toHaveBeenCalled();
  const persist = vi.fn();
  const receipt = vi.fn().mockResolvedValue(true);
  await deliverFinalResult(initial(), persist, send, async () => {}, undefined, receipt);
  expect(receipt).toHaveBeenCalledWith("turn-one");
  expect(send).not.toHaveBeenCalled();
  expect(persist).toHaveBeenLastCalledWith({ ...initial(), delivered: true });
  expect(resultDeliveryLabel(initial(), true)).toBe("delivered");
});

it("stops on a permanent refusal so the retained result can be posted by the session", async () => {
  let saved = initial();
  const send = vi.fn().mockRejectedValue(Object.assign(new Error("owner unavailable"), { code: "unauthorized" }));
  const wait = vi.fn(async () => {});
  await deliverFinalResult(saved, state => { saved = state; }, send, wait);
  expect(send).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
  expect(saved).toEqual(initial());
  const env = makeEnv();
  const node = env.node("claude-permanent-refusal", "claude");
  await node.start();
  const jobs = new JobManager(node, nullLogger);
  try {
    const job = jobs.start("codex", null, "review", async () => new Promise(() => {}));
    job.host = { pid: process.pid, peer: job.name, startedAt: job.startedAt };
    const final: RunnerState = { pid: process.pid, peer: job.name, status: "done", updatedAt: Date.now(), ...saved };
    jobs.runners = { state: () => final, alive: () => false, send: vi.fn(), kill: vi.fn() };
    (jobs as unknown as { checkHosted(job: Job, ownershipRefreshed: boolean, polledState: RunnerState): void }).checkHosted(job, true, final);
    await until(() => node.unread().some(message => message.body === report));
    expect(job.status).toBe("done");
    expect(job.report).toBe(report);
  } finally { jobs.cancelAll(); await env.cleanup(); }
});

it("caps transient delivery attempts with the same ID and leaves the result for session fallback", async () => {
  let saved = initial();
  const send = vi.fn().mockRejectedValue(new Error("broker offline"));
  const waits: number[] = [];
  await deliverFinalResult(saved, state => { saved = state; }, send, async ms => { waits.push(ms); });
  expect(send).toHaveBeenCalledTimes(6);
  expect(send.mock.calls.every(call => call[1] === "turn-one")).toBe(true);
  expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  expect(saved.delivered).toBe(false);
});

it("captures bounded refusal evidence without exposing payloads or altering delivery retries", async () => {
  vi.useFakeTimers();
  const secret = "EXCLUDED_BODY_OWNER_TOKEN", refusal = Object.assign(new Error(`Original destination was not retained ${secret}`), { code: "unknown_target" });
  const evidence: unknown[] = [], send = vi.fn().mockRejectedValueOnce(refusal).mockResolvedValue("stored");
  try {
    const result = deliverWithRetry(send, nullLogger, "owner", 2, undefined, (attempt, error) => evidence.push({ attempt, ...deliveryFailure(error) }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe("stored"); expect(send).toHaveBeenCalledTimes(2);
    expect(evidence).toEqual([{ attempt: 1, code: "unknown_target", reason: "unretained-destination" }]);
    expect(JSON.stringify(evidence)).not.toContain(secret);
    const proof = { kind: "note", stage: "retrying", messageId: "11111111-1111-4111-8111-111111111111", at: 1, attempt: 1, finalQueued: true, ...deliveryFailure(refusal) };
    expect(deliveryEvidenceSchema.safeParse(proof).success).toBe(true);
    expect(deliveryEvidenceSchema.safeParse({ ...proof, body: secret }).success).toBe(false);
    const permanent = Object.assign(new Error("Original local job report grant is unavailable"), { code: "unauthorized" });
    await expect(deliverWithRetry(async () => { throw permanent; }, nullLogger, "owner", 1, PERMANENT_DELIVERY_CODES,
      () => { throw new Error("diagnostic sink failed"); })).rejects.toBe(permanent);
  } finally { vi.useRealTimers(); }
});

it.each([
  ["metadata lease has live or unknown owner", "metadata-owner-unavailable"],
  ["broker connection closed", "connection-unavailable"],
  ["broker request timed out: trackedSend", "request-deadline"],
  ["OWNER_QUIESCED", "owner-quiesced"],
  ["Message id already retained with different content", "retained-content-mismatch"],
  ["Cannot read properties of undefined", "runtime-type-error"],
])("categorizes retained delivery refusal %s without copying arbitrary error content", (message, reason) => {
  const evidence = deliveryFailure(new Error(`${message}; EXCLUDED_PRIVATE_BODY`));
  expect(evidence.reason).toBe(reason);
  expect(JSON.stringify(evidence)).not.toContain("EXCLUDED_PRIVATE_BODY");
});

it.each([
  ["ELEASEBUSY", "metadata lease has a live or unknown owner", "metadata-owner-unavailable"],
  ["STORE_UPGRADE_DEFERRED", "Waiting for metadata upgrade", "storage-admission-deferred"],
  ["OWNER_UNAVAILABLE", "store ownership cannot resume", "owner-unavailable"],
  ["not_registered", "Registration admission changed or closed before durable recovery completed", "registration-unavailable"],
  ["internal", "Retained message ownership cannot be overwritten.", "ownership-proof-conflict"],
  ["internal", "Retained sender namespace is unproven; recovery requires explicit reviewed evidence.", "mailbox-provenance-unproven"],
  ["internal", "Historical job route provenance is unproven; pending report retained.", "job-route-unproven"],
  ["internal", "Job report route changed during succession", "job-route-changed"],
  ["internal", "unsupported job archive version 7; retry later", "storage-version-unavailable"],
  ["job_index_preparing", "Job authority unavailable (authority_store_read; authority_fence)", "job-authority-unavailable"],
  ["protocol_mismatch", "Mailbox registration requires ownership and succession provenance", "protocol-refusal"],
])("retains allowlisted ownership/admission failure %s as %s", (code, message, reason) => {
  const evidence = deliveryFailure(Object.assign(new Error(`${message} EXCLUDED_BODY_TOKEN_PROOF`), { code }));
  expect(evidence.reason).toBe(reason);
  expect(JSON.stringify(evidence)).not.toContain("EXCLUDED_BODY_TOKEN_PROOF");
});

it("posts the same retained report when the runner exits without delivery", async () => {
  const env = makeEnv();
  const node = env.node("claude-final-fallback", "claude");
  await node.start();
  const jobs = new JobManager(node, nullLogger);
  try {
    const job = jobs.start("codex", null, "review", async () => new Promise(() => {}));
    job.host = { pid: process.pid, peer: job.name, startedAt: job.startedAt };
    const final = { pid: process.pid, peer: job.name, status: "done" as const, updatedAt: Date.now(),
      finishedAt: 12345, report, reportId: "turn-one", delivered: false };
    jobs.runners = { state: () => final, alive: () => false, send: vi.fn(), kill: vi.fn() };
    (jobs as unknown as { checkHosted(job: Job, ownershipRefreshed: boolean, polledState: RunnerState): void }).checkHosted(job, true, final);
    await until(() => node.unread().some(message => message.body === report));
    expect(job).toMatchObject({ status: "done", report, finishedAt: 12345 });
    expect(node.unread().filter(message => message.body === report)).toHaveLength(1);
  } finally { jobs.cancelAll(); await env.cleanup(); }
});

it("holds session fallback behind durable unsettled retention, then posts only the original final once", async () => {
  const env = makeEnv(), node = env.node("claude-pending-retention", "claude");
  await node.start();
  const jobs = new JobManager(node, nullLogger);
  try {
    const job = jobs.start("codex", null, "review", async () => new Promise(() => {}));
    job.host = { pid: process.pid, peer: job.name, startedAt: job.startedAt };
    const spec = { owner: node.name, job: { ...job, allowedServers: [] } };
    publishRunnerSpec(env.home, job.id, spec);
    const namespace = runnerLedgerNamespace(env.home, true);
    const pending = [{ messageId: randomUUID(), record: JSON.stringify({ namespace, job: job.id, body: "Original immutable evidence, not replay authority", authority: "evidence-only-no-replay" }) }];
    const ledger = { version: 1 as const, namespace, generation: randomUUID(), principal: runnerLedgerPrincipal(spec), job: job.id, entries: pending };
    const failed: RunnerState = { pid: process.pid, peer: job.name, status: "done", updatedAt: Date.now(),
      report, reportId: "original-final", delivered: false, deliveryLedger: ledger, pendingDeliveryRetention: pending, deliveryRetentionFailure: "attempts-exhausted" };
    writeRunnerState(env.home, job.id, failed);
    let state = failed;
    const admission = new JobRunners(node, env.home, "unused-cli", nullLogger);
    jobs.runners = { state: () => state, alive: () => false, send: vi.fn(), kill: vi.fn(), assertTurnAdmission: job => admission.assertTurnAdmission(job) };
    const check = () => (jobs as unknown as { checkHosted(job: Job, ownershipRefreshed: boolean, polledState: RunnerState): void }).checkHosted(job, true, state);
    check(); check();
    expect(job.host).not.toBeNull(); expect(job.status).toBe("running");
    expect(job.progress).toContain("delivery unsettled");
    expect(node.unread().some(message => message.body === report)).toBe(false);
    expect(readStoredFinalResult(env.home, job.id)).toEqual({ report, reportId: "original-final", delivered: false });
    // Confirmed evidence retention clears the barrier, never replays the note.
    state = { ...failed, deliveryLedger: { ...ledger, entries: [] }, pendingDeliveryRetention: [], deliveryRetentionFailure: undefined, retainedDeliveryCount: 1 };
    await quarantineTextAsync(env.home, pending[0]!.messageId, pending[0]!.record, () => writeRunnerState(env.home, job.id, state));
    check(); check();
    await until(() => node.unread().some(message => message.body === report));
    expect(node.unread().filter(message => message.body === report)).toHaveLength(1);
    expect(job.status).toBe("done"); expect(job.report).toBe(report);
    expect(node.unread().some(message => message.body.includes("Original immutable evidence"))).toBe(false);
  } finally { jobs.cancelAll(); await env.cleanup(); }
});

it("clears a stored report when a new turn starts", async () => {
  const env = makeEnv();
  const node = env.node("claude-result-turns", "claude");
  await node.start();
  const jobs = new JobManager(node, nullLogger);
  try {
    const job = jobs.start("codex", null, "review", async () => ({ sessionId: "first", text: "Old report", isError: false, details: {} }),
      () => async () => new Promise(() => {}));
    await until(() => job.status === "done");
    expect(job.report).toContain("Old report");
    expect(job.finishedAt).toBeTypeOf("number");
    expect(jobs.followUp(job.name, "next review").outcome).toBe("started");
    expect(job).toMatchObject({ status: "running" });
    expect(job.report).toBeUndefined();
    expect(job.finishedAt).toBeUndefined();
  } finally { jobs.cancelAll(); await env.cleanup(); }
});

it("persists and sends a cancelled turn's report even when the signal it is given is already aborted", async () => {
  const aborted = new AbortController(); aborted.abort();
  const persist = vi.fn();
  const send = vi.fn().mockResolvedValue({ stored: true });
  await deliverFinalResult(initial(), persist, send, async () => {}, aborted.signal);
  expect(persist).toHaveBeenNthCalledWith(1, initial());
  expect(send).toHaveBeenCalledWith(report, "turn-one");
  expect(persist.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
  expect(persist).toHaveBeenLastCalledWith({ ...initial(), delivered: true });
});

it("still sends best-effort with the same completion ID when durable storage stays locked", async () => {
  const locked = Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
  const persist = vi.fn(() => { throw locked; });
  const send = vi.fn().mockResolvedValue({ stored: true });
  const waits: number[] = [];
  await deliverFinalResult(initial(), persist, send, async ms => { waits.push(ms); });
  expect(persist).toHaveBeenCalledTimes(7);
  expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(report, "turn-one");
});

it("hands a permanent refusal to the session fallback at once through the real ordered retry path", async () => {
  const brokerSend = vi.fn<(body: string) => Promise<{ messages: { id: string }[] }>>()
    .mockRejectedValueOnce(new BridgeError("unauthorized", "Job ownership is unavailable."))
    .mockResolvedValue({ messages: [{ id: "later" }] });
  const inOrder = inSendOrder((body: string, final: boolean) =>
    deliverWithRetry(() => brokerSend(body), nullLogger, "owner", final ? 1 : 30, final ? PERMANENT_DELIVERY_CODES : undefined));
  const wait = vi.fn(async () => {});
  let saved = initial();
  await deliverFinalResult(saved, state => { saved = state; }, async body => {
    const result = await inOrder(body, true);
    return result && { stored: result.messages.length > 0 };
  }, wait);
  expect(brokerSend).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
  expect(saved).toEqual(initial());
  // The refused final send never blocks later mail in the same order.
  expect(await inOrder("later note", false)).toEqual({ messages: [{ id: "later" }] });
});

it("bounds transient final-result attempts on the real retry path so the fallback starts promptly", async () => {
  const brokerSend = vi.fn<() => Promise<{ messages: { id: string }[] }>>().mockRejectedValue(new Error("broker request timed out: send"));
  const inOrder = inSendOrder(() => deliverWithRetry(() => brokerSend(), nullLogger, "owner", 1, PERMANENT_DELIVERY_CODES));
  const waits: number[] = [];
  await deliverFinalResult(initial(), () => {}, async () => {
    const result = await inOrder();
    return result && { stored: true };
  }, async ms => { waits.push(ms); });
  expect(brokerSend).toHaveBeenCalledTimes(6);
  expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
});

it("keeps only the report location in jobs.json and serves the text from the message store", async () => {
  const env = makeEnv();
  const node = env.node("claude-report-location", "claude");
  await node.start();
  const store = join(env.home, JOBS_FILE);
  const jobs = new JobManager(node, nullLogger, store);
  let stage = "initial-admission", observed: Job | undefined;
  try {
    const job = jobs.start("codex", null, "review", async () => ({ sessionId: "located", text: "Located final review", isError: false, details: {} }));
    observed = job; stage = "recipient-inbox";
    await until(() => node.unread().some(m => m.body.includes("Located final review")));
    const saved = readStore(store).find(j => j.id === job.id)!;
    expect(saved).toMatchObject({ status: "done", resultStored: true, reportId: expect.any(String) });
    expect(saved).not.toHaveProperty("report");
    expect(JSON.parse(readFileSync(store, "utf8")).jobs.find((j: { id: string }) => j.id === job.id)).not.toHaveProperty("report");
    expect(node.unread().find(m => m.body.includes("Located final review"))?.id).toBe(saved.reportId);
    stage = "stored-report-text";
    await until(() => readJobReport(env.home, saved) !== null);
    expect(readJobReport(env.home, saved)).toContain("Located final review");
  } catch (error) {
    try { console.error("Report location settlement diagnostics:", JSON.stringify({ stage, status: observed?.status,
      ownerBound: Boolean(observed?.deliveryOwner), resultStored: observed?.resultStored === true, reportIdPresent: Boolean(observed?.reportId),
      pendingReports: (jobs as any).pendingReports?.size, inboxCount: node.unread().length,
      admission: jobWaitSnapshot(env.home, observed ? [observed.id] : []) })); } catch { /* Original failure wins. */ }
    throw error;
  } finally { jobs.cancelAll(); await env.cleanup(); }
});
