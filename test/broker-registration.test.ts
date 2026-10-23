import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { indexFixtureFile, retainedRootJobCopy } from "./archive-fixture.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

const io = vi.hoisted(() => ({ open: vi.fn(), original: undefined as typeof import("node:fs/promises").open | undefined }));
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>(); io.original = actual.open;
  return { ...actual, open: io.open };
});
let env: TestEnv;
const clients: BridgeClient[] = [];
beforeEach(() => { io.open.mockReset().mockImplementation(io.original!); env = makeEnv(); });
afterEach(async () => { for (const client of clients.splice(0)) client.close(); vi.restoreAllMocks(); await env.cleanup(); });

async function fixture() {
  const owner = env.node("supervisor", "claude", false, "supervisor-root"); await owner.start();
  const broker = (owner as any).broker, store = broker.store;
  const row = { id: "retained", name: "codex-job-retained", agent: "codex", owner: owner.name,
    rootName: owner.name, supervisor: "supervisor-root", status: "running", projectRoot: env.home,
    workdir: env.home, startedAt: 1, sessionId: "retained-session" };
  const backup = join(env.home, "jobs.json.backup-1"), bytes = JSON.stringify({ jobs: [row] });
  writeFileSync(backup, bytes); indexFixtureFile(backup);
  mkdirSync(join(env.home, "runs"));
  const file = join(env.home, "runs", "2026-10-08-01-02-03-codex-retained.log");
  const feed = "header by supervisor\n         exact retained task\n         ---\nretained tail\n";
  writeFileSync(file, feed);
  writeFileSync(file.replace(/\.log$/, ".json"), JSON.stringify({ job: row.name, by: owner.name, session: row.sessionId, jobStartedAt: 1, byCwd: env.home, workdir: env.home }));
  const runner: PeerInfo = { id: "job:retained", name: row.name, agent: "other", jobAgent: "codex", jobOwner: row.supervisor,
    jobParent: owner.name, cwd: env.home, pid: process.pid, agentPid: null, startedAt: Date.now(), sessionId: null, autoWake: false };
  const contender: PeerInfo = { id: "competing-native", name: "competing-native", agent: "opencode", cwd: env.home,
    pid: process.pid, agentPid: null, startedAt: Date.now(), sessionId: "competing-session", autoWake: false };
  const token = loadOrCreateToken(env.home);
  const connect = async () => {
    const client = await BridgeClient.connect(env.pipe, nullLogger); clients.push(client);
    await client.request("auth", { protocol: PROTOCOL_VERSION, token }); return client;
  };
  const hello = (client: BridgeClient, peer: PeerInfo) => client.request("hello", { protocol: PROTOCOL_VERSION, token, peer }, 2000);
  const remember = vi.spyOn(store.history, "rememberPeer");
  return { owner, broker, store, row, runner, contender, file, feed, bytes, connect, hello, remember };
}

/** Suspend a real FileHandle read inside production recoverJobRecordAsync.
 * Discovery, original bytes, both authority rechecks and registration stay real. */
function holdRead(file: string) {
  let entered!: () => void, release!: () => void, fail = false, reads = 0;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  io.open.mockImplementation(async (...args: any[]) => {
    const handle = await (io.original as (...args: any[]) => Promise<any>)(...args);
    if (String(args[0]) !== file) return handle;
    const read = handle.read.bind(handle);
    handle.read = async (...parts: any[]) => {
      reads++; entered(); await gate;
      if (fail) throw Object.assign(new Error("injected retained header read failure"), { code: "EIO" });
      return read(...parts);
    };
    return handle;
  });
  return { ready, release, reject: () => { fail = true; release(); }, reads: () => reads };
}
const outcome = <T>(pending: Promise<T>) => pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));

it.each(["contender-first", "recovery-first"])("reserves one connection during actual job recovery with %s completion", async order => {
  const f = await fixture(), client = await f.connect(), held = holdRead(f.file);
  const first = outcome(f.hello(client, f.runner));
  try {
    await held.ready;
    expect(held.reads()).toBe(1);
    const conn = [...f.broker.conns].find((c: any) => c.authed && !c.peer) as any;
    expect(conn).toBeDefined(); expect(f.remember).not.toHaveBeenCalled();
    let second: Awaited<ReturnType<typeof outcome>>;
    if (order === "contender-first") {
      const reservation = conn.helloAdmission;
      second = await outcome(f.hello(client, f.contender));
      expect(conn.helloAdmission).toBe(reservation);
      held.release();
    } else {
      held.release(); expect((await first).error).toBeUndefined();
      second = await outcome(f.hello(client, f.contender));
    }
    expect((await first).error).toBeUndefined();
    // On the broken base B publishes first, then recovered A overwrites it.
    // There must be exactly one accepted/publicized identity on this wire.
    expect(f.remember.mock.calls.map(([peer]) => (peer as PeerInfo).id)).toEqual([f.runner.id]);
    expect(second.error).toMatchObject({ code: "bad_request" });
    expect(conn.peer.id).toBe(f.runner.id); expect(conn.registered).toBe(true);
    expect(conn.helloAdmission).toBeUndefined();
    expect((await client.request("peers", {})).some(p => p.id === f.contender.id)).toBe(false);
    expect(f.store.namesFor(f.contender)).toEqual([]);
    expect(f.store.recipientOwnership(f.contender.name)).toMatchObject({ recipientAmbiguous: true });
    expect(f.broker.recoveredJobs.get(f.row.id)).toMatchObject({ prompt: "exact retained task" });
    await expect(f.hello(client, f.contender)).rejects.toMatchObject({ code: "bad_request" });
    expect(retainedRootJobCopy(env.home, "jobs.json.backup-1")).toBe(f.bytes); expect(readFileSync(f.file, "utf8")).toBe(f.feed);
  } finally { held.release(); await first; }
});

it("releases only the failed hello admission after a suspended real recovery read rejects", async () => {
  const f = await fixture(), client = await f.connect(), held = holdRead(f.file), first = outcome(f.hello(client, f.runner));
  try {
    await held.ready;
    const conn = [...f.broker.conns].find((c: any) => c.authed && !c.peer) as any;
    const second = await outcome(f.hello(client, f.contender));
    held.reject(); expect((await first).error).toMatchObject({ code: "unauthorized" });
    expect(second.error).toMatchObject({ code: "bad_request" });
    expect(f.remember).not.toHaveBeenCalled(); expect(f.broker.recoveredJobs.has(f.row.id)).toBe(false);
    expect(conn.helloAdmission).toBeUndefined(); expect(f.store.namesFor(f.runner)).toEqual([]);
    expect((await f.hello(client, f.contender)).name).toBe(f.contender.name);
    await expect(f.hello(client, f.runner)).rejects.toMatchObject({ code: "bad_request" });
    expect(f.remember.mock.calls.map(([peer]) => (peer as PeerInfo).id)).toEqual([f.contender.id]);
    expect(f.store.namesFor(f.runner)).toEqual([]);
  } finally { held.release(); await first; }
});

it("does not publish a cancelled recovering connection over a legitimate new runner connection", async () => {
  const f = await fixture(), client = await f.connect(), held = holdRead(f.file), first = outcome(f.hello(client, f.runner));
  try {
    await held.ready;
    const old = [...f.broker.conns].find((c: any) => c.authed && !c.peer) as any;
    client.close(); await until(() => old.socket.destroyed);
    const replacement = await f.connect(), next = outcome(f.hello(replacement, f.runner));
    held.release();
    expect((await first).error).toBeDefined(); expect((await next).error).toBeUndefined();
    await until(() => old.inFlight === 0);
    expect(old.peer).toBeNull();
    expect(old.helloAdmission).toBeUndefined();
    expect(f.remember.mock.calls.map(([peer]) => (peer as PeerInfo).id)).toEqual([f.runner.id]);
    await expect(f.hello(replacement, f.contender)).rejects.toMatchObject({ code: "bad_request" });
    expect(f.broker.localPeers().filter((p: PeerInfo) => p.id === f.runner.id)).toHaveLength(1);
  } finally { held.release(); await first; }
});
