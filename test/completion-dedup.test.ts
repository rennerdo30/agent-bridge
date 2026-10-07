import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeNode } from "../src/core/node.js";
import { completionMessageId, COMPLETION_DEDUPE_PREFIX } from "../src/core/completion.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { JobManager, jobReport, type Run, type RunnerState } from "../src/mcp/jobs.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

describe("completion delivery under delayed acknowledgements", () => {
  it("contains a runner-state failure in the socket message callback and retries on later mail", async () => {
    const owner = env.node("owner"); await owner.start();
    const manager = new JobManager(owner, nullLogger);
    let fail = true;
    manager.runners = { state: (job) => { if (fail) throw new Error("temporary state failure"); return { pid: process.pid, peer: job.name, status: "done", delivered: true, updatedAt: Date.now() }; }, alive: () => false, send: () => {}, kill: () => {} };
    const run = Object.assign(async () => new Promise<never>(() => {}), { hosted: () => ({ pid: process.pid, peer: "runner", startedAt: Date.now() }) }) as Run;
    const job = manager.start("codex", null, "task", run);
    const note = { id: randomUUID(), from: { id: `job:${job.id}`, name: job.name, agent: job.agent }, recipient: owner.name, to: owner.name, body: "state changed", conversationId: `job-${job.id}:note`, replyTo: null, hop: 0, createdAt: Date.now(), readAt: null };
    try {
      expect(() => owner.deliverLocal(note)).not.toThrow();
      expect(job.status).toBe("running");
      expect(await owner.peers()).toHaveLength(1);
      fail = false; owner.deliverLocal({ ...note, id: randomUUID() });
      expect(job.status).toBe("done");
    } finally { manager.cancelAll(); }
  });
  it.each([false, true])("shares the report identity when fallback arrives first=%s", async (fallbackFirst) => {
    const owner = env.node("owner"); await owner.start();
    const manager = new JobManager(owner, nullLogger);
    let state: RunnerState | null = null;
    manager.runners = { state: () => state, alive: () => false, send: () => {}, kill: () => {} };
    const run = Object.assign(async () => new Promise<never>(() => {}), { hosted: () => ({ pid: process.pid, peer: "runner", startedAt: Date.now() }) }) as Run;
    const job = manager.start("codex", null, "task", run);
    const reportId = randomUUID(), report = jobReport(job, "done", 1, "result", null);
    state = { pid: process.pid, peer: job.name, status: "done", report, reportId, delivered: false, updatedAt: Date.now(), finishedAt: Date.now() };
    const id = completionMessageId(`job:${job.id}`, reportId);
    const incoming = { id, from: { id: `job:${job.id}`, name: job.name, agent: job.agent }, recipient: owner.name, to: owner.name, body: report, conversationId: `job-${job.id}`, replyTo: null, hop: 0, createdAt: Date.now(), readAt: null };
    try {
      if (fallbackFirst) (manager as any).checkHosted(job);
      owner.deliverLocal(incoming);
      expect(job.status).toBe("done");
      expect(owner.unread().filter((m) => m.from.name === job.name)).toMatchObject([{ id, body: report }]);
      expect(owner.unread().filter((m) => m.from.name === job.name)).toHaveLength(1);
      // A later turn in the same job must remain separately deliverable.
      owner.deliverLocal({ ...incoming, id: completionMessageId(`job:${job.id}`, randomUUID()), body: "next turn" });
      expect(owner.unread().filter((m) => m.from.name === job.name)).toHaveLength(2);
    } finally { manager.cancelAll(); }
  });

  it("uses the same opaque UUID for a runner's broker delivery", async () => {
    const owner = env.node("owner"); await owner.start();
    const runner = new BridgeNode({ pipePath: env.pipe, dbPath: env.db, token: loadOrCreateToken(env.home), agent: "codex", name: "codex-job-aabbccdd", id: "job:aabbccdd", jobAgent: "codex", jobOwner: "root", jobParent: owner.name, cwd: env.home, autoWake: false, canHostBroker: false, log: nullLogger });
    await runner.start();
    const reportId = randomUUID();
    try {
      const sent = await runner.send({ to: owner.name, body: "Subagent finished", dedupeKey: `${COMPLETION_DEDUPE_PREFIX}${reportId}` }, { quiet: true });
      expect(sent.messages[0]?.id).toBe(completionMessageId("job:aabbccdd", reportId));
      expect(sent.messages[0]?.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-8[\da-f]{3}-[\da-f]{12}$/);
    } finally { await runner.stop(); }
  });
});
