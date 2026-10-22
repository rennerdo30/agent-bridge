import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { LOG_DIR_NAME, LOG_FILE_NAME } from "../src/core/constants.js";
import { writeRunnerState } from "../src/mcp/job-host.js";
import { jobWaitSnapshot } from "./job-wait-diagnostics.js";
import { makeEnv } from "./helpers.js";

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
