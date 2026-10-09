import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { JOBS_FILE, PROTOCOL_VERSION } from "../src/core/constants.js";
import { indexedJobProjectionCurrent, markJobProjection, storeJobRecords } from "../src/core/job-archive-index.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv } from "./helpers.js";

/**
 * A blocking ask handed off mid-run: the broker had cached a record it recovered from history while the
 * old caller still owned the job. With the indexed job projection current, that cached copy was listed
 * ahead of the stored record, so every later report went to the old caller instead of the new owner.
 */
it("routes inline job reports to the stored owner, not a recovery cached before the handoff", async () => {
  const env = makeEnv(), token = loadOrCreateToken(env.home), clients: BridgeClient[] = [];
  const path = join(env.home, JOBS_FILE), startedAt = Date.now();
  const before = { id: "55c939e2", name: "claude-ask-55c939e2", agent: "claude", status: "running", prompt: "blocking work",
    supervisor: "codex-source", owner: "codex-source", executionOwner: "codex-source", rootSession: "codex-source", rootName: "codex-source",
    projectRoot: env.home, workdir: env.home, startedAt, args: {} };
  const after = { ...before, status: "done", finishedAt: startedAt + 1, supervisor: "claude-target", owner: "claude-target", rootSession: "claude-target",
    rootName: "claude-target", ownershipHistory: [{ from: "codex-source", to: "claude-target", fromRootName: "codex-source", rootName: "claude-target", at: startedAt }] };
  writeFileSync(path, JSON.stringify({ version: 4, jobs: [after] }));
  storeJobRecords(path, [after]);
  markJobProjection(path, [after]);
  expect(indexedJobProjectionCurrent(path)).toBe(true);
  const broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, token, Date.now, path);
  try {
    await broker.listen();
    for (const [name, agent] of [["codex-source", "codex"], ["claude-target", "claude"]] as const) {
      const client = await BridgeClient.connect(env.pipe, nullLogger); clients.push(client);
      await client.request("hello", { protocol: PROTOCOL_VERSION, token, peer: {
        id: `peer-${name}`, name, agent, cwd: env.home, pid: process.pid, agentPid: null, sessionId: null, startedAt, autoWake: false,
      } });
    }
    const [source, target] = clients as [BridgeClient, BridgeClient];
    // What jobForControl caches after recovering the job from a history copy written before the handoff.
    (broker as unknown as { recoveredJobs: Map<string, Record<string, unknown>> }).recoveredJobs.set(before.id, { ...before });
    const report = { id: randomUUID(), from: { id: `job:${before.id}`, name: before.name, agent: "claude" as const }, to: "codex-source", recipient: "codex-source",
      conversationId: `job-${before.id}`, replyTo: null, hop: 0, body: "Inherited runner finished", createdAt: Date.now(), readAt: null };
    expect(await source.request("inlineJobReport", report)).toEqual({ saved: true });
    const delivered = (await target.request("pending", {})).filter((message) => message.id === report.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.recipient).toBe("claude-target");
    expect((await source.request("pending", {})).some((message) => message.id === report.id)).toBe(false);
  } finally {
    for (const client of clients) client.close();
    await broker.close(); await env.cleanup();
  }
});
