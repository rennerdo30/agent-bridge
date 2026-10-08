import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { confirmRehearsalHandover, readRehearsalCursor, recordRehearsalConnection, rehearsalBytes } from "../scripts/release-rehearsal.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function handover() {
  const identity = { pid: 4100, version: "0.30.2", id: "candidate-id", name: "candidate", sessionId: "synthetic-session" };
  const ping = deferred<unknown>(), peers = deferred<unknown>();
  const request = vi.fn((op: string) => op === "ping" ? ping.promise : peers.promise);
  const state = { broker: {} as object | null, client: { request } as { request: typeof request } | null, connected: true, identity: { ...identity }, connections: [{ at: 101, ...identity, isBroker: true }] };
  const confirm = () => confirmRehearsalHandover({ capture: () => state, expected: identity, retirementStartedAt: 100, now: () => 450 });
  return { state, identity, ping, peers, request, confirm };
}

describe("authenticated release handover witness", () => {
  it("retains ordered public IPC connection evidence independently of a later phase failure", () => {
    const timeline: Parameters<typeof recordRehearsalConnection>[0] = [];
    const event = { at: 100, pid: 4100, version: "0.29.17", role: "old-runner", name: "synthetic-runner", sessionId: "synthetic-session", isBroker: false };
    expect(recordRehearsalConnection(timeline, { ...event, requestBody: "must not be retained", token: "synthetic-secret" })).toBe(true);
    expect(recordRehearsalConnection(timeline, { ...event, at: 450 })).toBe(true);
    expect(recordRehearsalConnection(timeline, { ...event, pid: null })).toBe(false);
    expect(timeline).toEqual([event, { ...event, at: 450 }]);
    const failedReport = { error: "Synthetic later verification failure", childConnectionTimelines: [{ events: timeline }] };
    expect(JSON.parse(JSON.stringify(failedReport)).childConnectionTimelines[0].events).toEqual(timeline);
  });
  it("does not mistake a present listener for its own completed auth and hello", async () => {
    const fixture = handover(); fixture.state.connected = false;
    expect(await fixture.confirm()).toBeNull(); expect(fixture.request).not.toHaveBeenCalled();
    fixture.state.connected = true; fixture.state.connections = [];
    expect(await fixture.confirm()).toBeNull(); expect(fixture.request).not.toHaveBeenCalled();
  });
  it.each(["before-retirement", "other-broker", "other-session", "other-version"])("rejects a %s connection witness", async reason => {
    const fixture = handover(), witness = fixture.state.connections[0]!;
    if (reason === "before-retirement") witness.at = 99;
    if (reason === "other-broker") witness.isBroker = false;
    if (reason === "other-session") witness.sessionId = "foreign-session";
    if (reason === "other-version") witness.version = "0.29.17";
    expect(await fixture.confirm()).toBeNull(); expect(fixture.request).not.toHaveBeenCalled();
  });
  it("confirms only after both roundtrips on the captured authenticated client", async () => {
    const fixture = handover(); let completed = false;
    const result = fixture.confirm().then(value => { completed = true; return value; });
    expect(fixture.request.mock.calls.map(call => call[0])).toEqual(["ping"]);
    expect(completed).toBe(false);
    fixture.ping.resolve({ brokerPid: 4100, brokerVersion: "0.30.2" }); await Promise.resolve();
    expect(fixture.request.mock.calls.map(call => call[0])).toEqual(["ping", "peers"]); expect(completed).toBe(false);
    fixture.peers.resolve([{ ...fixture.identity }]);
    expect(await result).toMatchObject({ verified: true, confirmedAt: 450, identity: fixture.identity, ownPeer: fixture.identity });
  });
  it.each(["broker", "client", "identity", "disconnected"])("rejects %s replacement during ping before trusting peers", async changed => {
    const fixture = handover(), result = fixture.confirm();
    if (changed === "broker") fixture.state.broker = {};
    if (changed === "client") fixture.state.client = { request: vi.fn() };
    if (changed === "identity") fixture.state.identity = { ...fixture.identity, sessionId: "replacement" };
    if (changed === "disconnected") fixture.state.connected = false;
    fixture.ping.resolve({ brokerPid: 4100, brokerVersion: "0.30.2" });
    await expect(result).rejects.toThrow("changed during readiness");
    expect(fixture.request.mock.calls.map(call => call[0])).toEqual(["ping"]);
  });
  it("rejects identity replacement while authenticated peers is in flight", async () => {
    const fixture = handover(), result = fixture.confirm();
    fixture.ping.resolve({ brokerPid: 4100, brokerVersion: "0.30.2" }); await Promise.resolve();
    fixture.state.identity = { ...fixture.identity, name: "replacement" };
    fixture.peers.resolve([{ ...fixture.identity }]);
    await expect(result).rejects.toThrow("changed during readiness");
  });
  it.each([{ brokerPid: 4101, brokerVersion: "0.30.2" }, { brokerPid: 4100, brokerVersion: "0.29.17" }])("rejects a listener serving another broker identity %j", async ping => {
    const fixture = handover(), result = fixture.confirm(); fixture.ping.resolve(ping);
    await expect(result).rejects.toThrow("ping identifies another broker");
  });
  it("requires peers to prove the expected hosting session, not just successful ping", async () => {
    const fixture = handover(), result = fixture.confirm();
    fixture.ping.resolve({ brokerPid: 4100, brokerVersion: "0.30.2" });
    fixture.peers.resolve([{ ...fixture.identity, sessionId: "foreign-session" }]);
    await expect(result).rejects.toThrow("omit the expected hosting session");
  });
});

function checkpoint(): string {
  const root = join(process.cwd(), ".agent-bridge-test"); mkdirSync(root, { recursive: true });
  const snapshot = join(mkdtempSync(join(root, "rehearsal-cursor-")), "snapshot.db");
  const db = new DatabaseSync(`${snapshot}.progress.db`);
  try {
    db.exec("CREATE TABLE table_state(table_name,generation,snapshot_after,snapshot_rows,snapshot_verify_after,snapshot_verify_rows,copy_after,copy_rows,verify_after,verify_rows); INSERT INTO table_state VALUES('conversation_records',0,1,1,NULL,0,NULL,0,NULL,0)");
  } finally { db.close(); }
  return snapshot;
}
async function lock(snapshot: string, milliseconds: number | null): Promise<Worker> {
  const worker = new Worker(`const {DatabaseSync}=require('node:sqlite'); const {parentPort,workerData}=require('node:worker_threads'); const db=new DatabaseSync(workerData.path); db.exec('BEGIN EXCLUSIVE'); db.prepare('UPDATE table_state SET generation=1').run(); parentPort.postMessage('locked'); const release=()=>{db.exec('COMMIT');db.close();parentPort.close()}; if(workerData.milliseconds===null) parentPort.once('message',release); else setTimeout(release,workerData.milliseconds)`, { eval: true, workerData: { path: `${snapshot}.progress.db`, milliseconds } });
  await new Promise<void>((resolve, reject) => { worker.once("message", () => resolve()); worker.once("error", reject); });
  return worker;
}

describe("opt-in release rehearsal checkpoint inspection", () => {
  it("parses bounded opt-in sizes", () => {
    expect(rehearsalBytes("8MiB")).toBe(8 * 1024 ** 2);
    expect(rehearsalBytes("20GiB")).toBe(20 * 1024 ** 3);
    expect(() => rehearsalBytes("65GiB")).toThrow();
  });
  it("yields and retries a transient exclusive checkpoint lock", async () => {
    const snapshot = checkpoint(), worker = await lock(snapshot, 350);
    try { expect(await readRehearsalCursor({ snapshot })).toMatchObject({ generation: 1, snapshot_after: 1 }); }
    finally { await worker.terminate(); }
  });
  it("fails bounded inspection without treating a persistent lock as verification failure", async () => {
    const snapshot = checkpoint(), worker = await lock(snapshot, null);
    try {
      await expect(readRehearsalCursor({ snapshot }, 150)).rejects.toThrow("Checkpoint inspection remained busy");
    } finally { await worker.terminate(); }
  });
});
