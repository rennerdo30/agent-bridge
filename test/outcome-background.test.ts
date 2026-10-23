import * as sqlite from "node:sqlite";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as inspection from "../src/core/job-outcomes.js";
import * as worktree from "../src/core/worktree.js";
import { cachedOutcomes, drainOutcomeInspections, outcomeSignature, pendingOutcome, type OutcomeInput } from "../src/core/outcome-background.js";
import * as metadata from "../src/core/metadata-db.js";
import { readDashboard } from "../src/core/dashboard-read.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore } from "../src/core/store.js";
import { fixturePeer, markOwned, ownedMessage } from "./owned-mail.js";
import { RECHECK_MS } from "../src/core/finished-run-bundles.js";
import { setTimeout as realDelay } from "node:timers/promises";
import { makeEnv, type TestEnv } from "./helpers.js";

vi.mock("node:sqlite", async original => {
  const actual = await original<typeof import("node:sqlite")>();
  return { ...actual, DatabaseSync: vi.fn(function (...args: unknown[]) { return Reflect.construct(actual.DatabaseSync, args); }) };
});

// Worker harness: a fake parentPort lets this thread run the outcome worker module directly,
// and the real outcome worker's replies can be held to keep an inspection pending.
const harness = vi.hoisted(() => ({ events: [] as string[], hold: false, held: [] as (() => void)[], port: undefined as any }));
vi.mock("node:worker_threads", async original => {
  const actual = await original<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  harness.port = Object.assign(new EventEmitter(), { postMessage: vi.fn((_: unknown) => { harness.events.push("reply"); }) });
  class GatedWorker extends actual.Worker {
    private readonly outcome: boolean;
    constructor(...args: ConstructorParameters<typeof actual.Worker>) { super(...args); this.outcome = String(args[0]).includes("outcome-worker"); }
    override on(event: string | symbol, listener: (...args: any[]) => void): this {
      if (event !== "message" || !this.outcome) return super.on(event, listener);
      return super.on(event, (...args: any[]) => { if (harness.hold) harness.held.push(() => listener(...args)); else listener(...args); });
    }
  }
  return { ...actual, Worker: GatedWorker, parentPort: harness.port };
});
vi.mock("../src/core/metadata-db.js", async original => {
  const actual = await original<typeof import("../src/core/metadata-db.js")>();
  return { ...actual, closeMetadataDb: vi.fn((home: string) => { harness.events.push("close"); actual.closeMetadataDb(home); }) };
});

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });
const input = (): OutcomeInput => ({ key: "codex-job-cache", kind: "job", opts: {},
  job: { id: "cache", name: "codex-job-cache", owner: "fixture", status: "done", startedAt: 100 } });
async function ready(read: () => Promise<any>, check: (value: any) => boolean): Promise<any> {
  const end = Date.now() + 10_000;
  for (;;) { const value = await read(); if (check(value)) return value; if (Date.now() > end) throw new Error("Outcome refresh did not converge"); await new Promise(resolve => setTimeout(resolve, 20)); }
}

it("repeated corpus polls perform no receipt/database/Git inspection on the request thread", async () => {
  const runs = join(env.home, "runs"); mkdirSync(runs);
  const jobs = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), name: `codex-job-${i}`, owner: "fixture", agent: "codex", status: "done", startedAt: i + 1 }));
  writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ jobs }));
  for (let i = 0; i < jobs.length; i++) {
    const name = `2026-10-08-00-00-00-codex-${i}`;
    writeFileSync(join(runs, `${name}.log`), "00:00:00 codex\n00:00:01 finished after 1s · done\n");
    writeFileSync(join(runs, `${name}.json`), JSON.stringify({ job: jobs[i]!.name, jobStartedAt: i + 1, by: "fixture" }));
  }
  const derive = vi.spyOn(inspection, "deriveJobOutcome"), receipts = vi.spyOn(inspection, "readResultDelivery"), git = vi.spyOn(worktree, "git"), opens = vi.mocked(sqlite.DatabaseSync);
  opens.mockClear();
  const ctx = { home: env.home, log: nullLogger, peers: () => [] };
  const read = async () => (await readDashboard(ctx, { path: "/api/job-outcomes", query: { limit: "20" } })).body as any;
  await ready(read, value => Object.values(value.runs).every((o: any) => o.observation.state === "ready"));
  // While the background store appears, the only request-thread database access is the packed-run
  // revision check (AB-233/245): a short-lived read-only bridge.db open, at most once per change.
  const bridge = join(env.home, "bridge.db");
  for (const args of opens.mock.calls) expect(args).toEqual([bridge, { readOnly: true, timeout: 1000 }]);
  // The outcome worker creates bridge.db while the first polls run. A change seen within
  // RECHECK_MS of the last check is confirmed by one deferred open on a later poll; on a
  // loaded host that later poll can be one of the steady polls below. Let the warmup settle
  // first: a poll made after the recheck window that needs no open has seen every change.
  for (let settled = false, round = 0; !settled; round++) {
    if (round === 5) throw new Error("bridge.db kept changing after the outcome warmup");
    opens.mockClear();
    await new Promise(resolve => setTimeout(resolve, RECHECK_MS + 50));
    await read();
    for (const args of opens.mock.calls) expect(args).toEqual([bridge, { readOnly: true, timeout: 1000 }]);
    settled = opens.mock.calls.length === 0;
  }
  opens.mockClear();
  // Steady polls: no inspection at all on the request thread. Counting the calls proves this
  // independently of how loaded the machine is; wall time only measured the host.
  for (let i = 0; i < 12; i++) {
    const value = await read();
    expect(Object.keys(value.jobs).length + Object.keys(value.runs).length).toBe(20);
  }
  expect(derive).not.toHaveBeenCalled(); expect(receipts).not.toHaveBeenCalled(); expect(opens).not.toHaveBeenCalled(); expect(git).not.toHaveBeenCalled();
});

it("invalidates receipt cache for delivery, read acknowledgement and archived database changes", async () => {
  const store = new MessageStore(env.db, nullLogger);
  const i = input(), read = () => cachedOutcomes(env.home, [i], nullLogger);
  try {
    await ready(read, value => value[i.key].observation.state === "ready");
    const peer = fixturePeer(store, "fixture");
    store.insert(ownedMessage(store, peer, { id: "outcome-cache-result", from: { id: "job:cache", name: i.job.name, agent: "codex" }, recipient: "fixture", to: "fixture", conversationId: "job-cache", replyTo: null, hop: 0,
      body: "Subagent codex-job-cache (codex) done after 1s.", createdAt: 200, readAt: null }));
    const delivered = await ready(read, value => value[i.key].delivery.status === "delivered");
    expect(delivered[i.key].delivery.messageId).toBe("outcome-cache-result");
    expect(markOwned(store, peer, ["outcome-cache-result"], 300)).toBe(1);
    const consumed = await ready(read, value => value[i.key].delivery.status === "read");
    expect(consumed[i.key].delivery.readAt).toBe(300);
    store.purgeOlderThan(400);
    const archived = await ready(read, value => value[i.key].observation.state === "ready" && value[i.key].delivery.status === "read");
    expect(archived[i.key].delivery.messageId).toBe("outcome-cache-result");
  } finally { store.close(); }
});

it("returns safe unknown evidence for unavailable storage and retries after repair", async () => {
  const i = input(); writeFileSync(env.db, "synthetic invalid database");
  const first = await cachedOutcomes(env.home, [i], nullLogger);
  expect(first[i.key]).toMatchObject({ delivery: { status: "unknown" }, merge: { state: "unmerged" } });
  expect(pendingOutcome(i).merge.reason).toContain("not cleanup authority");
  // Preserve the generated damaged bytes before replacing the synthetic fixture database.
  renameSync(env.db, `${env.db}.unavailable-fixture`);
  const store = new MessageStore(env.db, nullLogger);
  try {
    store.insert({ id: "repaired-result", from: { id: "job:cache", name: i.job.name, agent: "codex" }, recipient: "fixture", to: "fixture", conversationId: "job-cache", replyTo: null, hop: 0,
      body: "Subagent codex-job-cache (codex) done after 1s.", createdAt: 200, readAt: null });
    expect((await ready(() => cachedOutcomes(env.home, [i], nullLogger), value => value[i.key].delivery.status === "delivered"))[i.key].delivery.messageId).toBe("repaired-result");
  } finally { store.close(); }
});

it("drain() resolves only after pending outcome inspections complete", async () => {
  const i = input();
  harness.hold = true;
  try {
    // The read gives up waiting after its display budget; the held reply keeps the inspection pending.
    expect((await cachedOutcomes(env.home, [i], nullLogger))[i.key]?.observation?.state).toBe("pending");
    const end = Date.now() + 10_000;
    while (!harness.held.length) { if (Date.now() > end) throw new Error("Outcome worker did not reply"); await realDelay(10); }
    const order: string[] = [];
    const draining = drainOutcomeInspections().then(() => { order.push("drained"); });
    await realDelay(50);
    expect(order).toEqual([]);
    harness.hold = false;
    order.push("reply delivered");
    for (const deliver of harness.held.splice(0)) deliver();
    await draining;
    expect(order).toEqual(["reply delivered", "drained"]);
  } finally { harness.hold = false; for (const deliver of harness.held.splice(0)) deliver(); }
});

describe("outcome worker replies", () => {
  const close = vi.mocked(metadata.closeMetadataDb);
  async function inspect(id: number) {
    const i = input(), signature = await outcomeSignature(env.home, [i]);
    const replied = new Promise<any>(resolve => harness.port.postMessage.mockImplementationOnce((reply: unknown) => { harness.events.push("reply"); resolve(reply); }));
    harness.port.emit("message", { id, home: env.home, inputs: [i], signature, gitPaths: [] });
    return replied;
  }
  beforeEach(async () => { await import("../src/core/outcome-worker.js"); harness.events.length = 0; close.mockClear(); });

  it("posts the reply only after the metadata handle is closed", async () => {
    const reply = await inspect(1);
    expect(reply).toMatchObject({ id: 1, result: { "codex-job-cache": expect.any(Object) } });
    expect(close).toHaveBeenCalledWith(env.home);
    expect(harness.events).toEqual(["close", "reply"]);
  });

  it("still replies when closing the metadata handle throws, and keeps serving", async () => {
    const actual = await vi.importActual<typeof metadata>("../src/core/metadata-db.js");
    close.mockImplementationOnce((home: string) => { harness.events.push("close"); actual.closeMetadataDb(home); throw new Error("synthetic close failure"); });
    expect(await inspect(2)).toMatchObject({ id: 2, result: { "codex-job-cache": expect.any(Object) } });
    expect(harness.events).toEqual(["close", "reply"]);
    harness.events.length = 0;
    expect(await inspect(3)).toMatchObject({ id: 3, result: { "codex-job-cache": expect.any(Object) } });
    expect(harness.events).toEqual(["close", "reply"]);
  });
});
