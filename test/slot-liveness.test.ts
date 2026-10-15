import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore } from "../src/core/store.js";
import { RootConcurrency } from "../src/core/root-concurrency.js";
import { ResourceSlots, SLOT_LEASE_MS } from "../src/core/resource-slots.js";
import { acquireStartup, STARTUP_RESOURCE } from "../src/core/startup-admission.js";
import { SlotLiveness, slotLiveness } from "../src/core/slot-liveness.js";
import { makeEnv } from "./helpers.js";

const probes = vi.hoisted(() => ({
  foreign: new Set<number>(),
  slow: false,
  query: vi.fn<(pids: number[]) => Promise<Map<number, string>>>(),
}));
vi.mock("../src/core/process-identity.js", async original => {
  const actual = await original<typeof import("../src/core/process-identity.js")>();
  return {
    ...actual,
    readProcessIdentities: (pids: number[]) => probes.query(pids),
    processIdentity: () => "own-identity",
    // Controlled reproduction of the old synchronous lookup, with the same 5 s delay.
    recordedOwnerLiveness: (pid: number) => {
      if (probes.slow && probes.foreign.has(pid)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);
      return true;
    },
  };
});

let nextPid = 2_100_000;
function foreign(): number {
  const pid = ++nextPid;
  probes.foreign.add(pid);
  return pid;
}
function livingPids(): void {
  const kill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((pid, signal) => probes.foreign.has(pid) && signal === 0 ? true : kill(pid, signal));
}
const flushed = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(() => { vi.restoreAllMocks(); probes.foreign.clear(); probes.slow = false; probes.query.mockReset(); });

function seed(home: string, resource: string, pids: number[], identity: string | null = "original"): void {
  const db = new DatabaseSync(join(home, "resource-slots.sqlite"));
  try {
    for (const pid of pids) db.prepare("INSERT INTO slots(resource,id,pid,held,expiresAt,identity) VALUES (?,?,?,1,?,?)")
      .run(resource, `owner-${pid}`, pid, Date.now() + SLOT_LEASE_MS, identity);
  } finally { db.close(); }
}

it("answers availability and an in-flight broker RPC under 500 ms during a 5 s identity query", async () => {
  livingPids();
  const env = makeEnv(), root = new RootConcurrency(env.home, "root"), pid = foreign();
  root.setLimit(1);
  seed(env.home, `root-${createHash("sha256").update("root").digest("hex").slice(0, 40)}`, [pid]);
  const broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, "fixture-token");
  let client: BridgeClient | undefined, finished: Promise<unknown> | undefined;
  try {
    await broker.listen();
    client = await BridgeClient.connect(env.pipe, nullLogger);
    probes.slow = true;
    probes.query.mockImplementation(pids => {
      const result = delay(5_000).then(() => new Map(pids.map(p => [p, "replacement"])));
      finished = result;
      return result;
    });
    const start = performance.now();
    const reply = client.request("ping", {});
    const available = root.available();
    const accountingMs = performance.now() - start;
    await reply;
    const rpcMs = performance.now() - start;
    process.stdout.write(`AB-393 slow=5000ms availability=${accountingMs.toFixed(1)}ms broker=${rpcMs.toFixed(1)}ms\n`);
    expect(available).toBe(false);
    expect(accountingMs).toBeLessThan(500);
    expect(rpcMs).toBeLessThan(500);
    expect(probes.query).toHaveBeenCalledExactlyOnceWith([pid]);
    expect(root.available()).toBe(false);
    expect(probes.query).toHaveBeenCalledTimes(1);
    await finished;
    await flushed();
    expect(root.available()).toBe(true);
  } finally {
    await finished;
    client?.close(); root.close(); await broker.close(); await env.cleanup();
  }
});

it("batches N foreign PIDs once per poll, reuses evidence briefly, and isolates creation identities", async () => {
  livingPids();
  const cache = new SlotLiveness(nullLogger, "linux"), pids = Array.from({ length: 20 }, foreign), at = Date.now();
  let finish!: (result: Map<number, string>) => void;
  probes.query.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  for (const pid of pids) expect(cache.alive(pid, "old", at)).toBe(true);
  await flushed();
  expect(probes.query).toHaveBeenCalledExactlyOnceWith(pids);
  for (const pid of pids) cache.alive(pid, "old", at);
  expect(cache.alive(pids[0]!, "new", at)).toBe(true); // replacement arrives during the old query
  await flushed();
  expect(probes.query).toHaveBeenCalledTimes(1);
  finish(new Map(pids.map(pid => [pid, "new"])));
  await flushed();
  for (const pid of pids) expect(cache.alive(pid, "old", at)).toBe(false);
  expect(cache.alive(pids[0]!, "new", at)).toBe(true); // no stale verdict from the old owner
  await flushed();
  expect(probes.query).toHaveBeenCalledTimes(2);
  finish(new Map([[pids[0]!, "new"]]));
  await flushed();
  expect(cache.alive(pids[0]!, "new", at)).toBe(true);
  const clock = vi.spyOn(Date, "now").mockReturnValue(at + 59_000);
  expect(cache.alive(pids[0]!, "old", at)).toBe(false); // dead evidence is permanent
  expect(cache.alive(pids[0]!, "new", at)).toBe(true);
  await flushed();
  expect(probes.query).toHaveBeenCalledTimes(2);
  clock.mockReturnValue(at + 61_000);
  expect(cache.alive(pids[0]!, "old", at)).toBe(false);
  expect(cache.alive(pids[0]!, "new", at)).toBe(true); // positive evidence expires conservatively
  await flushed();
  expect(probes.query).toHaveBeenCalledTimes(3);
  finish(new Map());
  await flushed();
});

it("resolves captures queued during a query without another poll, and settled waits for them", async () => {
  const cache = new SlotLiveness(nullLogger, "linux"), first = foreign(), second = foreign();
  const firstListener = vi.fn(), nextListener = vi.fn();
  let finishFirst!: (result: Map<number, string>) => void;
  let finishNext!: (result: Map<number, string>) => void;
  probes.query
    .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishNext = resolve; }));
  cache.capture(first, "first", firstListener);
  await flushed();
  const settled = cache.settled(), completed = vi.fn();
  void settled.then(completed);
  cache.capture(second, "during-query", nextListener);
  expect(probes.query).toHaveBeenCalledExactlyOnceWith([first]);
  finishFirst(new Map([[first, "first-identity"]]));
  await flushed();
  expect(firstListener).toHaveBeenCalledExactlyOnceWith("first-identity");
  expect(probes.query.mock.calls).toEqual([[[first]], [[second]]]);
  expect(completed).not.toHaveBeenCalled();
  expect(nextListener).not.toHaveBeenCalled();
  finishNext(new Map([[second, "second-identity"]]));
  await settled;
  expect(nextListener).toHaveBeenCalledExactlyOnceWith("second-identity");
  expect(completed).toHaveBeenCalledTimes(1);
  expect(probes.query).toHaveBeenCalledTimes(2);
});

it("splits 20 darwin owners into sequential chunks of 8, 8 and 4 PIDs", async () => {
  livingPids();
  const cache = new SlotLiveness(nullLogger, "darwin"), pids = Array.from({ length: 20 }, foreign), at = Date.now();
  probes.query.mockImplementation(async batch => new Map(batch.map(pid => [pid, "same"])));
  for (const pid of pids) expect(cache.alive(pid, "same", at)).toBe(true);
  await cache.settled();
  expect(probes.query.mock.calls).toEqual([[pids.slice(0, 8)], [pids.slice(8, 16)], [pids.slice(16)]]);
  for (const pid of pids) expect(cache.alive(pid, "same", at)).toBe(true);
  expect(probes.query).toHaveBeenCalledTimes(3);
});

it("retains a dead verdict until a slow poller returns, and caches its own identity permanently", async () => {
  livingPids();
  const cache = new SlotLiveness(), pid = foreign(), at = Date.now();
  probes.query.mockResolvedValue(new Map([[pid, "replacement"], [process.pid, "own"]]));
  expect(cache.alive(pid, "original", at)).toBe(true);
  expect(cache.identity(process.pid)).toBeNull();
  await cache.settled();
  vi.spyOn(Date, "now").mockReturnValue(at + 3_600_000);
  vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("protected PID"), { code: "EPERM" }); });
  expect(cache.alive(pid, "original", at)).toBe(false);
  expect(cache.identity(process.pid)).toBe("own");
  await flushed();
  expect(probes.query).toHaveBeenCalledTimes(1);
});

it("reuses legacy evidence across waiter renewals instead of querying every poll", async () => {
  livingPids();
  const cache = new SlotLiveness(), pid = foreign(), at = Date.now();
  probes.query.mockResolvedValue(new Map([[pid, "unparseable-legacy-identity"]]));
  expect(cache.alive(pid, null, at)).toBe(true);
  await cache.settled();
  const clock = vi.spyOn(Date, "now");
  for (let elapsed = 250; elapsed < 60_000; elapsed += 250) {
    clock.mockReturnValue(at + elapsed);
    expect(cache.alive(pid, null, at + elapsed)).toBe(true);
    await flushed();
  }
  expect(probes.query).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(at + 61_000);
  expect(cache.alive(pid, null, at + 61_000)).toBe(true);
  await cache.settled();
  expect(probes.query).toHaveBeenCalledTimes(2);
});

it("caches an unreadable capture for the same record instead of querying every poll", async () => {
  const cache = new SlotLiveness(), pid = foreign(), listener = vi.fn(), at = Date.now();
  probes.query.mockResolvedValue(new Map());
  cache.capture(pid, "same-record", listener);
  await cache.settled();
  const clock = vi.spyOn(Date, "now");
  for (let elapsed = 250; elapsed < 60_000; elapsed += 250) {
    clock.mockReturnValue(at + elapsed);
    cache.capture(pid, "same-record", listener);
    await flushed();
  }
  expect(probes.query).toHaveBeenCalledTimes(1);
  expect(listener).not.toHaveBeenCalled();
});

it("contains a throwing capture listener, logs it, and still notifies the remaining listeners", async () => {
  const log = { warn: vi.fn() }, cache = new SlotLiveness(log), first = foreign(), second = foreign();
  const next = vi.fn();
  probes.query.mockResolvedValue(new Map([[first, "first"], [second, "second"]]));
  cache.capture(first, "throwing", () => { throw new Error("SQLite failure"); });
  cache.capture(second, "following", next);
  await expect(cache.settled()).resolves.toBeUndefined();
  expect(log.warn).toHaveBeenCalledExactlyOnceWith("slot identity capture listener failed", { error: expect.any(Error) });
  expect(next).toHaveBeenCalledExactlyOnceWith("second");
  // A diagnostic sink failure must not turn the contained listener error into a rejection.
  log.warn.mockImplementation(() => { throw new Error("logging failure"); });
  cache.capture(first, "throwing", () => { throw new Error("cached listener failure"); });
  await expect(cache.settled()).resolves.toBeUndefined();
  expect(probes.query).toHaveBeenCalledTimes(1);
});

it.each(["win32", "darwin"] as const)("bounds batch size and concurrent readers on %s", async platform => {
  livingPids();
  const cache = new SlotLiveness(nullLogger, platform), pids = Array.from({ length: 530 }, foreign), at = Date.now();
  let inFlight = 0, peak = 0;
  probes.query.mockImplementation(async batch => {
    inFlight += batch.length; peak = Math.max(peak, inFlight);
    await flushed();
    inFlight -= batch.length;
    return new Map(batch.map(pid => [pid, "same"]));
  });
  for (const pid of pids) cache.alive(pid, "same", at);
  await cache.settled();
  const limit = platform === "darwin" ? 8 : 256;
  expect(probes.query.mock.calls.map(([batch]) => batch).flat()).toEqual(pids);
  expect(probes.query.mock.calls.every(([batch]) => batch.length <= limit)).toBe(true);
  expect(peak).toBeLessThanOrEqual(limit);
  expect(inFlight).toBe(0);
});

it.each(["release", "renewal", "replacement", "closed"])("fences capture writes after %s during a lookup", async action => {
  livingPids();
  const env = makeEnv(), pid = foreign(), owner = { id: "capture-owner", pid };
  let clock = Date.now(), finish!: (result: Map<number, string>) => void;
  probes.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const slots = new ResourceSlots(env.home, undefined, () => clock);
  const db = new DatabaseSync(join(env.home, "resource-slots.sqlite"));
  let closed = false;
  try {
    expect(slots.tryAcquire("gpu", 1, owner)).toBe(true);
    await flushed();
    expect(probes.query).toHaveBeenCalledExactlyOnceWith([pid]);
    const before = db.prepare("SELECT * FROM slots").get()!;
    expect(before.identity).toBeNull();
    let prepare: ReturnType<typeof vi.spyOn> | undefined;
    if (action === "release") slots.release(owner);
    if (action === "renewal") { clock += 1_000; slots.renew(owner); }
    if (action === "replacement") {
      slots.release(owner);
      db.prepare("INSERT INTO slots(resource,id,pid,held,expiresAt,identity) VALUES ('gpu',?,?,1,?,'replacement')")
        .run(owner.id, pid, before.expiresAt!);
    }
    if (action === "closed") {
      slots.close(); closed = true;
      prepare = vi.spyOn((slots as unknown as { db: DatabaseSync }).db, "prepare");
    }
    const expected = db.prepare("SELECT * FROM slots").all();
    finish(new Map([[pid, "queried-identity"]]));
    await expect(slotLiveness.settled()).resolves.toBeUndefined();
    expect(db.prepare("SELECT * FROM slots").all()).toEqual(expected);
    if (action === "release") expect(expected).toEqual([]);
    if (action === "renewal") expect(expected[0]!.expiresAt).toBe(Number(before.expiresAt) + 1_000);
    if (action === "replacement") {
      expect(expected[0]!.identity).toBe("replacement");
      expect(expected[0]!.ticket).not.toBe(before.ticket);
    }
    if (action === "closed") expect(prepare).not.toHaveBeenCalled();
  } finally {
    if (!closed) slots.close();
    db.close(); await env.cleanup();
  }
});

it.each(["failed", "missing", "unreadable"])("keeps an unknown %s owner occupied", async result => {
  livingPids();
  probes.query.mockImplementation(async pids => {
    if (result === "failed") throw new Error("query failed");
    return result === "missing" ? new Map() : new Map(pids.map(pid => [pid, ""]));
  });
  const env = makeEnv(), slots = new ResourceSlots(env.home), pid = foreign();
  try {
    seed(env.home, "gpu", [pid]);
    expect(slots.list()).toHaveLength(1);
    await flushed();
    expect(slots.list()).toHaveLength(1);
    expect(slots.tryAcquire("gpu", 1, { id: "contender", pid: process.pid })).toBe(false);
    await flushed();
  } finally { slots.close(); await env.cleanup(); }
});

it("startup acquisition leaves the event loop responsive and reclaims replaced owners after one batch", async () => {
  livingPids();
  const env = makeEnv(), slots = new ResourceSlots(env.home), pids = [foreign(), foreign()];
  let finish!: (result: Map<number, string>) => void;
  probes.query.mockImplementation(async pids => new Map(pids.map(pid => [pid, "own-identity"])))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  let release: (() => void) | undefined;
  try {
    seed(env.home, STARTUP_RESOURCE, pids);
    const start = performance.now(), acquired = acquireStartup(env.home, controller.signal);
    await flushed();
    expect(performance.now() - start).toBeLessThan(500);
    expect(probes.query).toHaveBeenCalledTimes(1);
    expect(probes.query.mock.calls[0]![0]).toEqual(expect.arrayContaining(pids));
    expect(slots.list().filter(row => row.held)).toHaveLength(2);
    finish(new Map([...pids.map(pid => [pid, "replacement"] as const), [process.pid, "own-identity"]]));
    release = await acquired;
    expect(slots.list().filter(row => row.held)).toHaveLength(1);
    expect(probes.query.mock.calls.filter(([batch]) => batch.some(pid => pids.includes(pid)))).toHaveLength(1);
    await flushed();
  } finally { controller.abort(); release?.(); slots.close(); await env.cleanup(); }
});
