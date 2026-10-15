import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { APP_VERSION, isNewerRelease, PROTOCOL_VERSION } from "../src/core/constants.js";
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

async function start(handover?: (target: unknown) => void) {
  broker = new Broker(env.pipe, new MessageStore(env.db, nullLogger), nullLogger, loadOrCreateToken(env.home));
  if (handover) { broker.setHostingMode("daemon"); broker.onNewerClient(handover); }
  await broker.listen();
  return broker;
}
async function connect(auth = true) {
  const client = await BridgeClient.connect(env.pipe, nullLogger); clients.push(client);
  if (auth) await client.request("auth", { protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home) });
  return client;
}
// A foreign PID: the idle check deliberately ignores registrations from the broker's own process.
const hello = (name: string, version = APP_VERSION, extra: Record<string, unknown> = {}) => ({ protocol: PROTOCOL_VERSION, token: loadOrCreateToken(env.home),
  peer: { id: randomUUID(), name, agent: "codex" as const, cwd: env.home, pid: 424242, agentPid: null, sessionId: null, startedAt: Date.now(), autoWake: false, version, ...extra } });

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
    const events: Array<[string, unknown]> = []; old.on("event", (ev, data) => events.push([ev, data]));
    const newer = await connect();
    // Admitted first: the send must answer and be durable although the handover starts right behind it.
    const sent = old.request("send", { to: "offline-retained", body: "accepted before handover" });
    const refused = newer.request("hello", hello("newer-session", "999.0.0"));
    await expect(refused).rejects.toMatchObject({ code: "protocol_mismatch", details: { handover: true, brokerVersion: APP_VERSION } });
    const accepted = await sent;
    expect(accepted.messages[0]!.body).toBe("accepted before handover");
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
    const recipient = env.node("offline-retained"); await recipient.start();
    await until(() => recipient.unread().some(message => message.id === accepted.messages[0]!.id));
    expect(recipient.unread().map(message => message.body)).toEqual(["accepted before handover"]);
  });

  it("a newer protocol hands over only with the right token", async () => {
    const handover = vi.fn();
    await start(handover);
    const wrong = await connect(false);
    await expect(wrong.request("auth", { protocol: PROTOCOL_VERSION + 1, token: "wrong-fixture-token" })).rejects.toSatisfy((error: { code: string; details?: Record<string, unknown> }) =>
      error.code === "protocol_mismatch" && error.details?.handover === undefined);
    expect(handover).not.toHaveBeenCalled();
    const right = await connect(false);
    await expect(right.request("auth", { protocol: PROTOCOL_VERSION + 1, token: loadOrCreateToken(env.home) })).rejects.toMatchObject({ code: "protocol_mismatch", details: { handover: true } });
    expect(handover).toHaveBeenCalledExactlyOnceWith({ protocol: PROTOCOL_VERSION + 1 });
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
