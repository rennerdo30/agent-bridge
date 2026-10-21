import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, connect as connectTcp, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { APP_VERSION, HANDOVER_MARKER_FILE, HANDOVER_REPEAT_WINDOW_MS, isNewerRelease, PROTOCOL_VERSION } from "../src/core/constants.js";
import { ConnectionActivity } from "../src/core/connection-activity.js";
import { RemoteJobs } from "../src/network/remote-jobs.js";
import type { NetworkService } from "../src/network/link.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore } from "../src/core/store.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { daemonIdleExitMs } from "../src/cli/broker-daemon.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv, broker: Broker | undefined, clients: BridgeClient[];
beforeEach(() => { env = makeEnv(); clients = []; broker = undefined; });
afterEach(async () => {
  for (const client of clients) client.close();
  await broker?.close().catch(() => {});
  await env.cleanup();
});

async function start(handover?: (target: unknown) => void, now: () => number = Date.now) {
  broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, loadOrCreateToken(env.home), now);
  if (handover) { broker.setHostingMode("daemon"); broker.onNewerClient(handover); }
  await broker.listen();
  return broker;
}
async function connect(auth = true, canHost = true) {
  const client = await BridgeClient.connect(env.pipe, nullLogger); clients.push(client);
  if (auth) await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home), ...(canHost ? { canHost: true } : {}) });
  return client;
}
// A foreign PID: the idle check deliberately ignores registrations from the broker's own process.
// canHost: true is what a node that can demand-start its own daemon sends; CLI commands and job runners omit it.
const hello = (name: string, version = APP_VERSION, extra: Record<string, unknown> = {}, canHost = true) => ({ protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home),
  ...(canHost ? { canHost: true } : {}), peer: { id: randomUUID(), name, agent: "codex" as const, cwd: env.home, pid: 424242, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false, version, ...extra } });

describe("release comparison", () => {
  it("treats only a strictly newer x.y.z as newer", () => {
    expect(isNewerRelease("0.30.22", "0.30.21")).toBe(true);
    expect(isNewerRelease("0.31.0", "0.30.21")).toBe(true);
    expect(isNewerRelease("1.0.0-rc.1", "0.30.21")).toBe(true);
    for (const value of ["0.30.21", "0.30.20", "0.9.99", "", "999", "x.y.z", undefined, 1]) expect(isNewerRelease(value, "0.30.21")).toBe(false);
  });
  it("bounds the idle period and keeps the default for anything else", () => {
    expect(daemonIdleExitMs(undefined)).toBe(600_000);
    expect(daemonIdleExitMs("2000")).toBe(2_000);
    for (const value of ["0", "999", "-5", "1e3", "abc", String(25 * 60 * 60_000)]) expect(daemonIdleExitMs(value)).toBe(600_000);
  });
});

describe("daemon handover", () => {
  it("a newer release's hello stops admission, drains admitted work and keeps accepted mail", async () => {
    let drained: Promise<boolean> | undefined;
    const handover = vi.fn(() => { drained = broker!.drain(); });
    await start(handover);
    const old = await connect(); await old.request("hello", hello("old-session"));
    const retained = await connect(); await retained.request("hello", hello("offline-retained", APP_VERSION, { sessionId: "retained-native-session" }));
    retained.close(); await until(() => !(broker as any).localPeers().some((peer: {name: string}) => peer.name === "offline-retained"));
    const events: Array<[string, unknown]> = []; old.on("event", (ev, data) => events.push([ev, data]));
    const newer = await connect();
    // Admitted first: the send must answer and be durable although the handover starts right behind it.
    const sent = old.request("send", { to: "offline-retained", body: "accepted before handover" });
    const refused = newer.request("hello", hello("newer-session", "999.0.0"));
    await expect(refused).rejects.toMatchObject({ code: "protocol_mismatch", details: { handover: true, brokerVersion: APP_VERSION } });
    const accepted = await sent;
    expect(accepted.messages[0]!.body).toBe("accepted before handover");
    expect(accepted.messages[0]!.recipientNative).toBeTruthy(); expect(accepted.messages[0]!.recipientAmbiguous).toBeUndefined();
    expect(handover).toHaveBeenCalledExactlyOnceWith({ version: "999.0.0" });
    expect(broker!.isDraining).toBe(true);
    await until(() => events.some(([ev]) => ev === "handover"));
    expect(events.find(([ev]) => ev === "handover")![1]).toEqual({ version: "999.0.0" });
    // Nothing new is admitted, on existing or new connections; refusals say nothing was applied.
    await expect(old.request("send", { to: "offline-retained", body: "after handover" })).rejects.toMatchObject({ code: "bad_request", details: { handover: true, applied: false } });
    const late = await connect(false);
    await expect(late.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home) })).rejects.toMatchObject({ code: "protocol_mismatch", details: { handover: true } });
    expect(await drained).toBe(true);
    await broker!.close(); broker = undefined;
    // The endpoint is released before any successor can bind it.
    await expect(BridgeClient.connect(env.pipe, nullLogger)).rejects.toMatchObject({ code: expect.stringMatching(/^(ENOENT|ECONNREFUSED)$/) });
    const recipient = env.node("offline-retained", "codex"); await recipient.setSessionId("retained-native-session"); await recipient.start();
    await until(() => recipient.unread().some(message => message.id === accepted.messages[0]!.id));
    expect(recipient.unread().map(message => message.body)).toEqual(["accepted before handover"]);
  });

  it("a protocol mismatch refuses mailbox authority without handover even with the right token", async () => {
    const handover = vi.fn();
    await start(handover);
    const wrong = await connect(false);
    await expect(wrong.request("auth", { protocol: PROTOCOL_VERSION + 1, token: "wrong-fixture-token", canHost: true })).rejects.toSatisfy((error: { code: string; details?: Record<string, unknown> }) =>
      error.code === "protocol_mismatch" && error.details?.handover === undefined);
    expect(handover).not.toHaveBeenCalled();
    const right = await connect(false);
    await expect(right.request("auth", { protocol: PROTOCOL_VERSION + 1, token: loadOrCreateToken(env.home), canHost: true })).rejects.toMatchObject({ code: "protocol_mismatch", details: { brokerProtocol: PROTOCOL_VERSION } });
    await expect(right.request("pending", {})).rejects.toMatchObject({ code: "unauthorized" });
    expect(handover).not.toHaveBeenCalled(); expect(broker!.isDraining).toBe(false);
  });

  it("a client that cannot host a broker (job runner, CLI command) never triggers a handover", async () => {
    const handover = vi.fn();
    await start(handover);
    const plainError = (error: { code: string; details?: Record<string, unknown> }) => error.code === "protocol_mismatch" && error.details?.handover === undefined;
    // Newer protocol on bare auth: a job runner or delegate-run node sends no canHost.
    const runner = await connect(false);
    await expect(runner.request("auth", { protocol: PROTOCOL_VERSION + 1, token: loadOrCreateToken(env.home) })).rejects.toSatisfy(plainError);
    const explicit = await connect(false);
    await expect(explicit.request("auth", { protocol: PROTOCOL_VERSION + 1, token: loadOrCreateToken(env.home), canHost: false })).rejects.toSatisfy(plainError);
    // Newer version on hello without canHost, or as a job runner even with it, registers normally.
    const cli = await connect(true, false);
    await expect(cli.request("hello", hello("newer-cli", "999.0.0", {}, false))).resolves.toMatchObject({ brokerVersion: APP_VERSION });
    const job = await connect();
    await expect(job.request("hello", hello("newer-job-runner", "999.0.0", { jobAgent: "codex" }))).resolves.toMatchObject({ brokerVersion: APP_VERSION });
    expect(handover).not.toHaveBeenCalled(); expect(broker!.isDraining).toBe(false);
    expect(existsSync(join(env.home, HANDOVER_MARKER_FILE))).toBe(false);
  });

  it("does not hand over to the same release again within the repeat window", async () => {
    let now = 1_000_000;
    const first = vi.fn();
    await start(first, () => now);
    const newer = await connect();
    await expect(newer.request("hello", hello("newer-a", "999.0.0"))).rejects.toMatchObject({ details: { handover: true } });
    expect(first).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(env.home, HANDOVER_MARKER_FILE), "utf8"))).toEqual({ target: "version:999.0.0", from: APP_VERSION, at: now });
    await broker!.close(); broker = undefined;
    // The newer daemon never came up and an older one was started again: it keeps serving that release.
    now += HANDOVER_REPEAT_WINDOW_MS - 1;
    const second = vi.fn();
    await start(second, () => now);
    const again = await connect();
    await expect(again.request("hello", hello("newer-b", "999.0.0"))).resolves.toMatchObject({ brokerVersion: APP_VERSION });
    expect(second).not.toHaveBeenCalled(); expect(broker!.isDraining).toBe(false);
    // Protocol boundaries never authorize replacement, regardless of the repeat window.
    const protocolClient = await connect(false);
    await expect(protocolClient.request("auth", { protocol: PROTOCOL_VERSION + 1, token: loadOrCreateToken(env.home), canHost: true })).rejects.toMatchObject({ code: "protocol_mismatch", details: { brokerProtocol: PROTOCOL_VERSION } });
    expect(second).not.toHaveBeenCalled(); expect(broker!.isDraining).toBe(false);
    await broker!.close(); broker = undefined;
    // After the window the same target hands over again.
    writeFileSync(join(env.home, HANDOVER_MARKER_FILE), JSON.stringify({ target: "version:999.0.0", from: APP_VERSION, at: now - HANDOVER_REPEAT_WINDOW_MS }));
    const third = vi.fn();
    await start(third, () => now);
    const late = await connect();
    await expect(late.request("hello", hello("newer-c", "999.0.0"))).rejects.toMatchObject({ details: { handover: true } });
    expect(third).toHaveBeenCalledOnce();
  });

  it("same, older, job-runner and embedded registrations never hand over", async () => {
    const handover = vi.fn();
    await start(handover);
    for (const [name, version, extra] of [["same", APP_VERSION, {}], ["older", "0.1.0", {}], ["newer-job", "999.0.0", { jobAgent: "codex" }]] as const) {
      const client = await connect();
      await expect(client.request("hello", hello(name, version, extra))).resolves.toMatchObject({ brokerVersion: APP_VERSION });
    }
    expect(handover).not.toHaveBeenCalled(); expect(broker!.isDraining).toBe(false);
    await broker!.close(); broker = undefined;
    await start(); // Embedded: no handler.
    const client = await connect();
    await expect(client.request("hello", hello("newer-embedded", "999.0.0"))).resolves.toMatchObject({ brokerVersion: APP_VERSION });
    expect(broker!.isDraining).toBe(false);
  });
});

describe("daemon idle exit", () => {
  it("a pending remote-job start or a connected paired PC keeps the daemon serving", async () => {
    await start(() => {});
    const network = { registerExtension: () => {}, activeLinks: 0, close: async () => {} };
    const jobs = new RemoteJobs(network as unknown as NetworkService, env.home, nullLogger, async () => {});
    Reflect.set(broker!, "remoteJobs", jobs); Reflect.set(broker!, "network", network);
    try {
      // A spawn admitted from a paired PC whose runner is still starting.
      const pendingStarts = Reflect.get(jobs, "pendingStarts") as Map<string, unknown>;
      pendingStarts.set("fixture-job", { controller: new AbortController() });
      expect(jobs.busy).toBe(true);
      const onIdle = vi.fn();
      broker!.exitWhenIdle(100, onIdle);
      await new Promise(resolve => setTimeout(resolve, 450));
      expect(onIdle).not.toHaveBeenCalled();
      pendingStarts.clear();
      expect(jobs.busy).toBe(false);
      network.activeLinks = 1; // A paired PC is connected.
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(onIdle).not.toHaveBeenCalled();
      network.activeLinks = 0;
      await until(() => onIdle.mock.calls.length === 1);
      // A host keep-alive (dashboard or phone connections) also re-arms the period.
      const host = vi.fn().mockReturnValueOnce("dashboard_client").mockReturnValue(undefined), later = vi.fn();
      broker!.exitWhenIdle(100, later, host);
      await until(() => later.mock.calls.length === 1);
      expect(host).toHaveBeenCalledTimes(2);
    } finally { jobs.close(); Reflect.set(broker!, "remoteJobs", null); Reflect.set(broker!, "network", null); }
  });
  it("counts open and recent dashboard or phone connections", async () => {
    let now = 5_000;
    const activity = new ConnectionActivity(() => now), server: Server = createServer(socket => socket.resume());
    activity.track(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      expect(activity.active(1_000)).toBe(false);
      const socket = connectTcp((server.address() as { port: number }).port, "127.0.0.1");
      await until(() => activity.openConnections === 1);
      now += 10_000; expect(activity.active(1_000)).toBe(true); // Open, however long ago.
      socket.destroy(); await until(() => activity.openConnections === 0);
      expect(activity.active(1_000)).toBe(true); // Closed just now: a polling phone counts.
      now += 1_000; expect(activity.active(1_000)).toBe(false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("fires only after no client of another process has been connected for the idle period", async () => {
    await start(() => {});
    const onIdle = vi.fn();
    const client = await connect(false);
    broker!.exitWhenIdle(150, onIdle);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(onIdle).not.toHaveBeenCalled();
    client.close();
    await until(() => onIdle.mock.calls.length === 1);
    // The daemon's own dashboard sender (same process) is no reason to stay up.
    onIdle.mockClear(); broker!.exitWhenIdle(150, onIdle);
    const own = await connect(); await own.request("hello", { ...hello("own-dashboard"), peer: { ...hello("own-dashboard").peer, pid: process.pid } });
    await until(() => onIdle.mock.calls.length === 1);
    expect(own.isClosed).toBe(false);
  });
});
