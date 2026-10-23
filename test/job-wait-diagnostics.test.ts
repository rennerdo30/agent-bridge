import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { LOG_DIR_NAME, LOG_FILE_NAME } from "../src/core/constants.js";
import { writeRunnerState } from "../src/mcp/job-host.js";
import { hookPublicationEvents, jobWaitSnapshot } from "./job-wait-diagnostics.js";
import { makeEnv } from "./helpers.js";
import { metadataFileLease } from "../src/core/metadata-file-lease.js";
import { nullLogger } from "../src/core/logger.js";
import { deliveryFailure, finalDeliverySettlementSchema } from "../src/mcp/delivery-evidence.js";
import { deliverWithRetry, inSendOrder } from "../src/mcp/job-runner.js";

it("bounds hook publication and approval stage evidence to allowlisted facts without private input", async () => {
  const env = makeEnv(), at = new Date().toISOString();
  try {
    mkdirSync(join(env.home, LOG_DIR_NAME), { recursive: true });
    writeFileSync(join(env.home, LOG_DIR_NAME, LOG_FILE_NAME),
      `${at} ERROR [server] pid=${process.pid} hook handler failed ${JSON.stringify({ event: "SessionStart", err: "PRIVATE_ERROR_TOKEN", sessionId: "PRIVATE_SESSION" })}\n` +
      `${at} ERROR [server] pid=${process.pid + 1} hook handler failed {"event":"SessionStart"}\n` +
      `${at} WARN [network] pid=${process.pid} remote approval answer refused ${JSON.stringify({ stage: "executor-lookup", idPresent: true, jobPresent: false, ownerPresent: false, body: "PRIVATE_PROMPT" })}\n`);
    expect(hookPublicationEvents(env.home, process.pid)).toMatchObject([{ stage: "hook handler failed", hook: "SessionStart" }]);
    const snapshot = jobWaitSnapshot(env.home, []);
    expect(snapshot.events).toMatchObject([{ event: "remote approval answer refused", stage: "executor-lookup", idPresent: true, jobPresent: false }]);
    expect(JSON.stringify([snapshot, hookPublicationEvents(env.home, process.pid)])).not.toContain("PRIVATE_");
  } finally { await env.cleanup(); }
});

it("retains exact final settlement and protocol admission families without private errors", async () => {
  const env = makeEnv(), id = "a1b2c3d4", messageId = "11111111-1111-4111-8111-111111111111", at = Date.now();
  const protocol = { source: "native-attestation", operation: "auth_hello", connectionGeneration: 3, clientProtocol: 6, brokerProtocol: 6 } as const;
  const finalDelivery = { messageId, at, state: "retained", cause: "permanent-refusal", attempt: 1, persisted: true, code: "protocol_mismatch", reason: "protocol-refusal", protocol } as const;
  try {
    writeRunnerState(env.home, id, { pid: process.pid, peer: `codex-job-${id}`, status: "done", updatedAt: at, report: "PRIVATE_REPORT", reportId: messageId,
      finalDelivery, retainedDeliveryCount: 1, pendingDeliveryRetention: [{ messageId, record: "PRIVATE_NOTE_INTENT" }], deliveryRetentionFailure: "attempts-exhausted" });
    mkdirSync(join(env.home, LOG_DIR_NAME), { recursive: true });
    writeFileSync(join(env.home, LOG_DIR_NAME, LOG_FILE_NAME), `${new Date(at).toISOString()} INFO [codex-job-${id}] pid=${process.pid} job final delivery settled ${JSON.stringify(finalDelivery)}\n` +
      `${new Date(at).toISOString()} ERROR [node] pid=${process.pid} broker refused this peer ${JSON.stringify({ code: "protocol_mismatch", message: "Broker did not attest the exact native identity PRIVATE_ERROR_TOKEN", protocolObservation: protocol })}\n` +
      `${new Date(at).toISOString()} ERROR [codex-job-${id}] pid=${process.pid} job runner delivery unsettled ${JSON.stringify({ reason: "attempts-exhausted", pending: 1, record: "PRIVATE_NOTE_INTENT" })}\n`);
    const snapshot = jobWaitSnapshot(env.home, [id]);
    expect(snapshot.jobs[0]?.runner).toMatchObject({ finalDelivery, retainedDeliveries: 1, delivered: false, reportPresent: true });
    expect(snapshot.events[0]).toMatchObject({ finalDelivery });
    expect(snapshot.events[1]).toMatchObject({ failure: { code: "protocol_mismatch", reason: "protocol-refusal", protocol } });
    expect(snapshot.events[2]).toMatchObject({ retentionFailure: "attempts-exhausted", pending: 1 });
    expect(snapshot.jobs[0]?.runner).toMatchObject({ pendingRetentions: 1, retentionFailure: "attempts-exhausted" });
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_REPORT|PRIVATE_ERROR_TOKEN|PRIVATE_NOTE_INTENT|did not attest/);
    expect(finalDeliverySettlementSchema.safeParse({ ...finalDelivery, body: "PRIVATE_REPORT" }).success).toBe(false);
  } finally { await env.cleanup(); }
});

it("reports actual retained admission/registration facts while bounding and excluding private fixture content", async () => {
  const env = makeEnv(), id = "1234abcd", secret = "EXCLUDED_PROMPT_BODY_ENV_PROOF";
  try {
    writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ jobs: [{ id, status: "cancelled", prompt: secret, deliveryOwner: secret,
      args: { host: "paired", prompt: secret }, deliveryHistory: [{ body: secret, senderOwner: secret }], reportRouting: {}, host: null }] }));
    writeFileSync(join(env.home, "remote-jobs.json"), JSON.stringify({ jobs: [{ pair: secret, peer: secret, owner: secret, job: { id, status: "running", supervisor: secret } }] }));
    writeRunnerState(env.home, id, { pid: process.pid, peer: `codex-job-${id}`, status: "running", updatedAt: Date.now(), identity: secret,
      sessionId: secret, progress: "queued: waiting for machine startup admission", report: secret,
      deliveryEvidence: { kind: "note", stage: "retrying", messageId: "11111111-1111-4111-8111-111111111111", at: Date.now(), attempt: 7,
        finalQueued: true, code: "unknown_target", reason: "unretained-destination" } });
    mkdirSync(join(env.home, LOG_DIR_NAME), { recursive: true });
    const log = join(env.home, LOG_DIR_NAME, LOG_FILE_NAME), at = "2026-10-23T00:00:00.000Z";
    writeFileSync(log, "discarded oversized older prefix".repeat(10_000) + "\n" + Array.from({ length: 60 }, () =>
      `${at} DEBUG [fixture] pid=10 request rejected ${JSON.stringify({ op: "inlineJobReport", code: "unauthorized", message: `Proven local job report grant is unavailable ${secret}` })}`).join("\n") +
      `\n${at} DEBUG [fixture] pid=10 effective config {"token":"${secret}"}\n`);
    const snapshot = jobWaitSnapshot(env.home, [id, "../../config", ...Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(8, "0"))]);
    expect(snapshot.jobs).toHaveLength(10); expect(snapshot.events).toHaveLength(40);
    expect(snapshot.jobs[0]).toMatchObject({ id, local: { status: "cancelled", explicitRemote: true, hostRecorded: false, reportEnvelopes: 1, reportGrants: 0 },
      remote: { pairedOrigin: true, peerOrigin: true, ownerRecorded: true }, runner: { identityRecorded: true, session: true, progress: "queued: waiting for machine startup admission",
        delivery: { kind: "note", finalQueued: true, reason: "unretained-destination", attempt: 7 } } });
    expect(snapshot.events.every(event => "reason" in event && event.reason === "local-report-grant-unproven")).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(JSON.stringify(snapshot)).not.toContain("effective config");
  } finally { await env.cleanup(); }
});

it("retains the actual lease refusal and note stage while a final waits behind retry, without exposing error text", async () => {
  const env = makeEnv(), id = "abcdef12", messageId = "22222222-2222-4222-8222-222222222222";
  const release = metadataFileLease(join(env.home, "fixture.lock"));
  let refusal: unknown;
  try { metadataFileLease(join(env.home, "fixture.lock"), 0, true); } catch (error) { refusal = error; }
  expect(refusal).toMatchObject({ code: "ELEASEBUSY" });
  vi.useFakeTimers();
  const starts: string[] = []; let attempt = 0;
  const ordered = inSendOrder(async (kind: "note" | "final") => {
    starts.push(kind);
    return deliverWithRetry(async () => { if (kind === "note" && ++attempt === 1) throw refusal; return "stored"; }, nullLogger, "fixture-owner", 2, undefined,
      (attempt, error) => {
        writeRunnerState(env.home, id, { pid: process.pid, peer: `codex-job-${id}`, status: "done", updatedAt: Date.now(),
          deliveryEvidence: { kind, stage: "retrying", messageId, at: Date.now(), attempt, finalQueued: true, ...deliveryFailure(error) } });
        mkdirSync(join(env.home, LOG_DIR_NAME), { recursive: true });
        writeFileSync(join(env.home, LOG_DIR_NAME, LOG_FILE_NAME), `${new Date().toISOString()} WARN [codex-job-${id}] pid=${process.pid} could not deliver to the session; retrying ` +
          JSON.stringify({ code: (error as any).code, err: `${(error as Error).message} EXCLUDED_PRIVATE_BODY` }) + "\n");
      });
  });
  try {
    const note = ordered("note"), final = ordered("final");
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual(["note"]);
    const snapshot = jobWaitSnapshot(env.home, [id]);
    expect(snapshot.jobs[0]?.runner?.delivery).toMatchObject({ kind: "note", stage: "retrying", finalQueued: true, code: "ELEASEBUSY", reason: "metadata-owner-unavailable" });
    expect(snapshot.events[0]).toMatchObject({ code: "ELEASEBUSY", reason: "metadata-owner-unavailable", failure: { code: "ELEASEBUSY", reason: "metadata-owner-unavailable" } });
    expect(JSON.stringify(snapshot)).not.toContain("metadata lease has");
    expect(JSON.stringify(snapshot)).not.toContain("EXCLUDED_PRIVATE_BODY");
    await vi.advanceTimersByTimeAsync(1000); expect(await note).toBe("stored"); expect(await final).toBe("stored");
    expect(starts).toEqual(["note", "final"]);
  } finally { vi.useRealTimers(); release(); await env.cleanup(); }
});
