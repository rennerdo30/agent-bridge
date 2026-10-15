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
import { SlotLiveness } from "../src/core/slot-liveness.js";
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
  const cache = new SlotLiveness(), pids = Array.from({ length: 20 }, foreign), at = Date.now();
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
  vi.spyOn(Date, "now").mockReturnValue(at + 2_000);
  expect(cache.alive(pids[0]!, "old", at)).toBe(true); // expired negative evidence fails closed
  await flushed();
  expect(probes.query).toHaveBeenCalledTimes(3);
  finish(new Map());
  await flushed();
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
