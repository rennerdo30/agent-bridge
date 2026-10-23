import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { JOBS_FILE, MAX_BODY_CHARS, MAX_FRAME_BYTES, PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { QUARANTINE_DIR, quarantineMessage } from "../src/core/oversize.js";
import { BridgeError, FrameDecoder, type BridgeMessage } from "../src/core/protocol.js";
import { transientRequestError } from "../src/core/request-retry.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { worktreeReport, type Worktree, type WorktreeOutcome } from "../src/core/worktree.js";
import { JobManager, jobReport } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { deliverWithRetry } from "../src/mcp/job-runner.js";
import { makeEnv, seedInbox, until, type TestEnv } from "./helpers.js";
import { fixtureAck, fixtureJobReport, fixtureOwner, fixturePeer, ownedMessage } from "./owned-mail.js";

/** Over the 4 MiB frame limit, like the 6.1 MB report of the incident. */
const HUGE = "left on disk: " + "x/".repeat(Math.ceil(MAX_FRAME_BYTES / 2) + 1024);

function message(id: string, body: string, createdAt = Date.now()): BridgeMessage {
  return { id, from: { id: "job:big", name: "codex-job-big", agent: "codex" }, to: "reader", recipient: "reader",
    conversationId: "job-big", replyTo: null, hop: 0, body, createdAt, readAt: null };
}

const stubPath = (body: string) => /full text at (.+)$/.exec(body)?.[1] ?? "";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

async function hello(client: BridgeClient, token: string): Promise<void> {
  await client.request("hello", { protocol: PROTOCOL_VERSION, token, peer: { id: "reader", name: "reader", agent: "opencode", cwd: env.home,
    pid: process.pid, agentPid: null, sessionId: "reader-session", startedAt: Date.now(), autoWake: false } });
}
const reader = (store: MessageStore) => fixturePeer(store, "reader", { id: "reader", agent: "opencode", sessionId: "reader-session" });

describe("AB-380 oversized frames", () => {
  it("keeps a worktree report with 50k skipped files small", () => {
    const skippedFiles = [
      ...Array.from({ length: 45_000 }, (_, i) => ({ path: `node_modules/pkg-${i}/index.js`, reason: "untracked; not explicitly staged" as const })),
      ...Array.from({ length: 4_926 }, (_, i) => ({ path: `dist/chunk-${i}.js`, reason: "generated noise" as const })),
      ...Array.from({ length: 148 }, (_, i) => ({ path: `loose-${i}.txt`, reason: "untracked; not explicitly staged" as const })),
    ];
    expect(skippedFiles).toHaveLength(50_074);
    const wt = { repoRoot: env.home, path: join(env.home, "wt"), cwd: join(env.home, "wt"), branch: "job/x", base: "a".repeat(40), baseBranch: "main" } satisfies Worktree;
    const outcome = { changed: false, branch: "job/x", otherBranches: [], diffStat: "", reviewBase: "a".repeat(40), files: [], skippedFiles } as WorktreeOutcome;
    const text = worktreeReport(wt, outcome);
    expect(text.length).toBeLessThan(10_000);
    expect(text).toContain("50074 files");
    expect(text).toContain("node_modules/ (45000 files, untracked; not explicitly staged)");
    expect(text).toContain("… and 100 more");
    // Few files are still listed one by one.
    const few = worktreeReport(wt, { ...outcome, skippedFiles: skippedFiles.slice(0, 3) });
    expect(few).toContain("node_modules/pkg-2/index.js (untracked; not explicitly staged)");
  });

  it("caps a job report and keeps the full text retrievable", () => {
    const report = jobReport({ name: "codex-job-big", agent: "codex", model: null, sessionId: "s" }, "done", 5, HUGE, null, env.home);
    expect(report.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(report).toContain("Subagent codex-job-big");
    const file = /full text at (.+)\]$/.exec(report)?.[1] ?? "";
    expect(file.startsWith(join(env.home, QUARANTINE_DIR))).toBe(true);
    const full = readFileSync(file, "utf8");
    expect(full).toContain(HUGE);
    expect(full.startsWith(report.slice(0, 1_000))).toBe(true);
    // Small reports are unchanged.
    expect(jobReport({ name: "j", agent: "codex", model: null, sessionId: null }, "done", 1, "ok", null, env.home)).toBe("Subagent j (codex) done after 1s.\n\nok");
  });

  it("measures decoder limits in bytes, not UTF-16 units", () => {
    const decoder = new FrameDecoder(1_000);
    expect(() => decoder.push("\"" + "é".repeat(600))).toThrow(BridgeError);
    expect(new FrameDecoder(1_000).push(JSON.stringify({ t: "evt", ev: "replaced", data: { by: "é".repeat(300) } }) + "\n")).toHaveLength(1);
  });

  it("fails an oversized client request locally as non-retryable too_large", async () => {
    const token = loadOrCreateToken(env.home), store = new MessageStore(env.db, nullLogger);
    const broker = new Broker(env.pipe, store, nullLogger, token, Date.now, join(env.home, JOBS_FILE));
    await broker.listen();
    const client = await BridgeClient.connect(env.pipe, nullLogger);
    try {
      await hello(client, token);
      const error = await client.request("send", { to: "reader", body: HUGE }).then(() => null, (err: unknown) => err);
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toBe("too_large");
      expect((error as BridgeError).details?.retryable).toBe(false);
      expect(transientRequestError(error)).toBe(false);
      expect(client.isClosed).toBe(false);
      expect(await client.request("ping", {} as never)).toMatchObject({ protocol: PROTOCOL_VERSION });
    } finally { client.close(); await broker.close(); }
  });

  it("skips an oversized event without dropping the connection", async () => {
    const token = loadOrCreateToken(env.home), store = new MessageStore(env.db, nullLogger);
    const broker = new Broker(env.pipe, store, nullLogger, token);
    await broker.listen();
    const client = await BridgeClient.connect(env.pipe, nullLogger);
    const seen: string[] = [];
    client.on("event", (name, data) => { if (name === "message") seen.push((data as BridgeMessage).id); });
    try {
      await hello(client, token);
      const conn = (broker as unknown as { connByName(name: string): unknown }).connByName("reader");
      const emit = (m: BridgeMessage) => (broker as unknown as { emit(conn: unknown, ev: string, data: unknown): void }).emit(conn, "message", m);
      const owner = reader(store), big = ownedMessage(store, owner, message(randomUUID(), HUGE)), small = ownedMessage(store, owner, message(randomUUID(), "small"));
      emit(big); emit(small);
      await until(() => seen.includes(small.id));
      expect(seen).not.toContain(big.id);
      expect(client.isClosed).toBe(false);
    } finally { client.close(); await broker.close(); }
  });

  it("quarantines a stored >4 MiB message on replay and keeps its id", async () => {
    const token = loadOrCreateToken(env.home), store = new MessageStore(env.db, nullLogger);
    const owner = reader(store), big = ownedMessage(store, owner, message(randomUUID(), HUGE, Date.now())), small = ownedMessage(store, owner, message(randomUUID(), "after the big one", Date.now() + 1));
    seedInbox(store, [big, small]);
    const broker = new Broker(env.pipe, store, nullLogger, token, Date.now, join(env.home, JOBS_FILE));
    await broker.listen();
    const client = await BridgeClient.connect(env.pipe, nullLogger);
    const seen = new Map<string, string>();
    client.on("event", (name, data) => { if (name === "message") seen.set((data as BridgeMessage).id, (data as BridgeMessage).body); });
    try {
      await hello(client, token);
      await until(() => seen.has(small.id));
      const stub = seen.get(big.id) ?? "";
      expect(stub).toMatch(/^Report too large \(\d+ bytes\); full text at /);
      const file = stubPath(stub);
      expect(file.startsWith(join(env.home, QUARANTINE_DIR))).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(HUGE);
      expect(client.isClosed).toBe(false);
      // The pending refill gets the same stub, and the stored original is never modified.
      const pending = await client.request("pending", { limit: 10 });
      expect(pending.map((m) => m.id)).toEqual([big.id, small.id]);
      expect(pending[0]!.body).toBe(stub);
      expect(store.byId(big.id)?.body).toBe(HUGE);
      // Acknowledging the stub id consumes the stored row: it is not replayed or refilled again.
      await client.request("ack", fixtureAck([big]));
      expect(store.byId(big.id)?.readAt).not.toBeNull();
      expect((await client.request("pending", { limit: 10 })).map((m) => m.id)).toEqual([small.id]);
      const again = await BridgeClient.connect(env.pipe, nullLogger);
      const replayed: string[] = [];
      again.on("event", (name, data) => { if (name === "message") replayed.push((data as BridgeMessage).id); });
      try {
        client.close();
        await until(() => !(broker as unknown as { connByName(name: string): unknown }).connByName("reader"));
        await hello(again, token);
        await until(() => replayed.includes(small.id));
        expect(replayed).not.toContain(big.id);
      } finally { again.close(); }
    } finally { client.close(); await broker.close(); }
  });

  it("settles a request whose response is oversized as a too_large error", async () => {
    const token = loadOrCreateToken(env.home), store = new MessageStore(env.db, nullLogger);
    const broker = new Broker(env.pipe, store, nullLogger, token);
    (broker as unknown as { handlers: Record<string, unknown> }).handlers.ping = () => ({ huge: HUGE });
    await broker.listen();
    const client = await BridgeClient.connect(env.pipe, nullLogger);
    try {
      const error = await client.request("ping", {} as never).then(() => null, (err: unknown) => err);
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).code).toBe("too_large");
      expect((error as BridgeError).details?.retryable).toBe(false);
      expect(client.isClosed).toBe(false);
    } finally { client.close(); await broker.close(); }
  });

  it("quarantines an oversized stored delivery-history report when rerouting it", async () => {
    const store = new MessageStore(env.db, nullLogger), owner = reader(store);
    const jobs = join(env.home, JOBS_FILE), big = ownedMessage(store, owner, message(randomUUID(), HUGE));
    const job = { id: "big", name: "codex-job-big", agent: "codex", startedAt: Date.now(), status: "done", owner: "reader", rootName: "reader",
      workdir: env.home, projectRoot: env.home, rootSession: "fixture-root", supervisor: "fixture-root",
      deliveryOwner: fixtureOwner(store, owner), deliveryOwners: { reader: fixtureOwner(store, owner) },
      ownershipHistory: [{ from: "old", to: "reader" }] };
    const report = fixtureJobReport(store, job, owner, owner, big);
    writeFileSync(jobs, JSON.stringify({ version: 4, jobs: [{ ...job, deliveryHistory: [report.message], reportRouting: { [big.id]: report.draft } }] }));
    const broker = new Broker(env.pipe, store, nullLogger, loadOrCreateToken(env.home), Date.now, jobs);
    await broker.listen();
    try {
      await broker.routePendingJobMail();
      const stored = store.byId(big.id);
      expect(stored?.body).toMatch(/^Report too large \(\d+ bytes\); full text at /);
      expect(readFileSync(stubPath(stored!.body), "utf8")).toBe(HUGE);
      // jobs.json keeps the original envelope.
      expect(readFileSync(jobs, "utf8")).toContain(HUGE);
    } finally { await broker.close(); }
  });

  it("sends a restored oversized pending report as a stub with the same id", async () => {
    const home = mkdtempSync(join(tmpdir(), "ab380-jobs-"));
    const node = new LocalCoordinator("owner", "owner-session");
    const jobs = new JobManager(node, nullLogger, join(home, "jobs.json"));
    try {
      const big = { ...message("restored-id", HUGE), from: { id: "job:selected", name: "selected-job", agent: "codex" as const } };
      writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: 4, jobs: [{ id: "selected", name: "selected-job", owner: "owner", deliveryHistory: [big] }] }));
      const send = vi.fn(async (_m: BridgeMessage) => ({ saved: true }));
      Object.assign(node, { reportInlineJob: send });
      // As restore leaves it: the exact durable envelope, retained for delivery.
      (jobs as any).pendingReports.set(big.id, { jobId: "selected", message: big });
      (jobs as any).scheduleReportRetry();
      await until(() => send.mock.calls.length === 1);
      const sent = send.mock.calls[0]![0];
      expect(sent.id).toBe("restored-id");
      expect(sent.body).toMatch(/^Report too large \(\d+ bytes\); full text at /);
      expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThan(MAX_FRAME_BYTES);
      const file = stubPath(sent.body);
      expect(file.startsWith(join(home, QUARANTINE_DIR))).toBe(true);
      expect(existsSync(file) && readFileSync(file, "utf8")).toBe(HUGE);
      await until(() => !(jobs as any).pendingReports.size);
    } finally { jobs.setDormant(true); jobs.cancelAll(); rmSync(home, { recursive: true, force: true }); }
  });

  it("stores the original report durably even when the quarantine write fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "ab380-fail-"));
    writeFileSync(join(home, QUARANTINE_DIR), "a file where the quarantine directory belongs");
    const node = new LocalCoordinator("owner", "owner-session");
    const jobs = new JobManager(node, nullLogger, join(home, "jobs.json"));
    try {
      const send = vi.fn(async (_m: BridgeMessage) => ({ saved: true }));
      Object.assign(node, { reportInlineJob: send });
      const job = { id: "failing", name: "codex-job-failing", agent: "codex", owner: "owner" } as any;
      const id = (jobs as any).post(job, HUGE) as string;
      expect(job.deliveryHistory).toHaveLength(1);
      expect(job.deliveryHistory[0].body).toBe(HUGE);
      expect((jobs as any).pendingReports.get(id).message.body).toBe(HUGE);
      // A stub never replaces the only copy: without a written file, the original stays as it is.
      const m = message("unwritable", HUGE);
      expect(quarantineMessage(home, m)).toBe(m);
      expect(quarantineMessage(home, m, "jobs.json").body).toContain("full text at jobs.json (message unwritable)");
    } finally { jobs.setDormant(true); jobs.cancelAll(); rmSync(home, { recursive: true, force: true }); }
  });

  it("job-runner delivery does not retry too_large and keeps what it sent", async () => {
    const send = vi.fn(async () => { throw new BridgeError("too_large", "frame too large", { retryable: false }); });
    expect(await deliverWithRetry(send, nullLogger, "owner")).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    // A transient failure is still retried.
    let calls = 0;
    expect(await deliverWithRetry(async () => { if (++calls === 1) throw new Error("connection to broker closed"); return "sent"; }, nullLogger, "owner")).toBe("sent");
    expect(calls).toBe(2);
  });

  it("pendingMail continues past an oversized head item", async () => {
    const store = new MessageStore(env.db, nullLogger);
    const broker = new Broker(env.pipe, store, nullLogger, loadOrCreateToken(env.home));
    try {
      const huge = { ...message(randomUUID(), "stub"), conversationId: "job-big-" + "c".repeat(MAX_FRAME_BYTES) }, small = message(randomUUID(), "small");
      vi.spyOn(broker as unknown as { unreadMail(r: string, l: number): BridgeMessage[] }, "unreadMail").mockReturnValue([huge, small]);
      const result = (broker as unknown as { pendingMail(r: string, l: number): BridgeMessage[] }).pendingMail("reader", 10);
      expect(result.map((m) => m.id)).toEqual([small.id]);
    } finally { await broker.close(); }
  });
});
