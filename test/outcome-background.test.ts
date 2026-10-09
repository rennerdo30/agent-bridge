import * as sqlite from "node:sqlite";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as inspection from "../src/core/job-outcomes.js";
import * as worktree from "../src/core/worktree.js";
import { cachedOutcomes, pendingOutcome, type OutcomeInput } from "../src/core/outcome-background.js";
import { readDashboard } from "../src/core/dashboard-read.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore } from "../src/core/store.js";
import { RECHECK_MS } from "../src/core/finished-run-bundles.js";
import { makeEnv, type TestEnv } from "./helpers.js";

vi.mock("node:sqlite", async original => {
  const actual = await original<typeof import("node:sqlite")>();
  return { ...actual, DatabaseSync: vi.fn(function (...args: unknown[]) { return Reflect.construct(actual.DatabaseSync, args); }) };
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
    store.insert({ id: "outcome-cache-result", from: { id: "job:cache", name: i.job.name, agent: "codex" }, recipient: "fixture", to: "fixture", conversationId: "job-cache", replyTo: null, hop: 0,
      body: "Subagent codex-job-cache (codex) done after 1s.", createdAt: 200, readAt: null });
    const delivered = await ready(read, value => value[i.key].delivery.status === "delivered");
    expect(delivered[i.key].delivery.messageId).toBe("outcome-cache-result");
    store.markRead("fixture", ["outcome-cache-result"], 300);
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
