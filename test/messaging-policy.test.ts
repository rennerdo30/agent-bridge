import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { isPureAcknowledgement } from "../src/core/job-messaging.js";
import { isQuietMessage, TRANSFER_PROGRESS_PREFIX, type BridgeMessage } from "../src/core/protocol.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { JobManager } from "../src/mcp/jobs.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { shouldWakeClaudeMessage } from "../src/mcp/rewake.js";
import type { ServerContext } from "../src/mcp/server.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

function mail(conversationId: string, body: string, createdAt = Date.now()): BridgeMessage {
  return { id: randomUUID(), from: { id: "job:worker", name: "worker", agent: "codex" },
    to: "supervisor", recipient: "supervisor", conversationId, replyTo: null, hop: 0,
    body, createdAt, readAt: null };
}

describe("messaging context policy", () => {
  it.each([false, true])("keeps transfer updates pollable without waking or hook injection with channel=%s", async (channel) => {
    const node = env.node("supervisor");
    await node.start();
    await node.setAutoWake(true);
    const progress = ["queued", "preparing", "transferring", "paused"].map((status) =>
      mail(`${TRANSFER_PROGRESS_PREFIX}transfer-id`, `files: 10% · ${status}`));
    progress.forEach((m) => node.deliverLocal(m));
    expect(progress.every(isQuietMessage)).toBe(true);
    expect(progress.every((m) => !shouldWakeClaudeMessage(node, DEFAULT_CONFIG, m))).toBe(true);
    const ctx = { node, home: env.home, log: nullLogger, cfg: DEFAULT_CONFIG, channelActive: () => channel } as unknown as ServerContext;
    const output = await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false });
    expect(JSON.stringify(output)).not.toContain("files:");
    expect(node.unread()).toEqual(progress);
    for (const status of ["completed", "failed", "cancelled"]) {
      const result = mail("transfer-id", `files: ${status}`);
      expect(isQuietMessage(result)).toBe(false);
      expect(shouldWakeClaudeMessage(node, DEFAULT_CONFIG, result)).toBe(true);
    }
  });

  it.each([false, true])("never injects observer backlog even with channel=%s", async (channel) => {
    const node = env.node("supervisor");
    await node.start();
    const notes = Array.from({ length: 169 }, (_, i) => mail(`siblings-${i}:note`, `Old handover ${i}`, i));
    notes.forEach((m) => node.deliverLocal(m));
    const result = mail("job-worker", "Tests passed; capture is ready", 170);
    node.deliverLocal(result);
    const ctx = { node, home: env.home, log: nullLogger, cfg: DEFAULT_CONFIG, channelActive: () => channel } as unknown as ServerContext;
    const output = await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false });
    if (channel) expect(output).toEqual({}); // Actionable results are pushed by the active channel.
    else expect(JSON.stringify(output)).toContain(result.body);
    expect(JSON.stringify(output)).not.toContain("Old handover");
    expect(node.unread()).toHaveLength(notes.length + Number(channel));
    expect(node.unread().filter(isQuietMessage)).toHaveLength(notes.length);
  });

  it("prioritizes active mail over more than a pending page of quiet copies without removing data", () => {
    const store = new MessageStore(env.db, nullLogger);
    try {
      for (let i = 0; i < 501; i++) store.insert(mail(i % 2 ? `siblings-${i}:note` : `${TRANSFER_PROGRESS_PREFIX}${i}`, `History ${i}`, i));
      const blocker = mail("job-worker", "Blocked: missing permission", 502);
      store.insert(blocker);
      expect(store.unread("supervisor", 500)[0]?.id).toBe(blocker.id);
      expect(store.unread("supervisor", 1_000)).toHaveLength(502);
      expect(store.byId(blocker.id)?.readAt).toBeNull();
    } finally { store.close(); }
  });

  it("retains double acknowledgements on demand and injects only the substantive result", async () => {
    const node = env.node("supervisor");
    await node.start();
    const jobs = new JobManager(node, nullLogger);
    const job = jobs.start("codex", null, "task", () => new Promise<never>(() => {}));
    try {
      jobs.fromSubagent(job, "Understood, I'll check the capture.", randomUUID(), true);
      jobs.fromSubagent(job, "Understood, I'll check the capture.", null);
      jobs.fromSubagent(job, "Capture checked: terrain has no seams.", null, true);
      const acknowledgements = node.unread().filter(isQuietMessage);
      expect(acknowledgements).toHaveLength(2);
      expect(acknowledgements.every((m) => !shouldWakeClaudeMessage(node, DEFAULT_CONFIG, m))).toBe(true);
      const ctx = { node, jobs, home: env.home, log: nullLogger, cfg: DEFAULT_CONFIG, channelActive: () => false } as unknown as ServerContext;
      const output = await buildHookResponse(ctx, { event: "PostToolUse", sessionId: null, stopHookActive: false });
      expect(JSON.stringify(output)).toContain("Capture checked");
      expect(JSON.stringify(output)).not.toContain("Understood");
      expect(node.unread()).toHaveLength(2);
    } finally { jobs.cancelAll(); }
  });

  it("recognizes only acknowledgement phrases and preserves facts, blockers and questions", () => {
    for (const text of ["Received", "Thanks!", "Got it", "Understood, I'll inspect the source."]) expect(isPureAcknowledgement(text)).toBe(true);
    for (const text of ["Understood, but I cannot acquire the lock", "Understood, I'll commit 123abc", "Tests passed", "Lock is yours", "Ready for review", "Thanks, which branch?", "Understood.\nBuild failed."]) expect(isPureAcknowledgement(text)).toBe(false);
  });
});
