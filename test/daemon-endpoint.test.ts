import { once } from "node:events";
import { existsSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EndpointReservation, TENTATIVE_CONNECTION_LIMIT, TENTATIVE_FRAME_BYTES } from "../src/core/endpoint-reservation.js";
import { Broker } from "../src/core/broker.js";
import { BridgeClient } from "../src/core/client.js";
import { MessageStore } from "../src/core/store.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv, reservations: EndpointReservation[], sockets: Socket[], brokers: Broker[];
beforeEach(() => { env = makeEnv(); reservations = []; sockets = []; brokers = []; });
afterEach(async () => {
  vi.restoreAllMocks(); for (const socket of sockets) socket.destroy();
  for (const broker of brokers) await broker.close();
  for (const reservation of reservations) await reservation.close(); await env.cleanup();
});
async function reserve() { const value = await EndpointReservation.bind(env.pipe); reservations.push(value); return value; }
async function raw() { const socket = connect(env.pipe); sockets.push(socket); socket.on("error", () => {}); await once(socket, "connect"); return socket; }
function ownedBroker() { const store = new MessageStore(env.db, nullLogger), broker = new Broker(env.pipe, store, nullLogger, "fixture-token"); brokers.push(broker); return broker; }

describe("exclusive tentative endpoint before broker-owner initialization", () => {
  it("ten bind attempts have one owner and losers create no stores/leases/auth material or endpoint cleanup", async () => {
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => reserve()));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const losers = results.filter(result => result.status === "rejected"); expect(losers).toHaveLength(9);
    for (const loser of losers) if (loser.status === "rejected") expect(loser.reason).toMatchObject({ code: "EADDRINUSE" });
    expect(existsSync(env.db)).toBe(false); expect(existsSync(join(env.home, ".storage-users"))).toBe(false);
    expect(existsSync(join(env.home, "token"))).toBe(false); expect(existsSync(join(env.home, ".core-lifecycle"))).toBe(false);
    const client = await BridgeClient.connect(env.pipe, nullLogger);
    try { await expect(client.request("auth", { protocol: PROTOCOL_VERSION, token: "fixture-token" })).rejects.toMatchObject({ code: "internal" }); }
    finally { client.close(); }
  });
  it("auth/ready remains unavailable during delayed actual initialization then uses unchanged authentication", async () => {
    const reservation = await reserve(), broker = ownedBroker(), children = Reflect.get(broker, "nativeChildren");
    const original = children.recover.bind(children); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const spy = vi.spyOn(children, "recover").mockImplementation(async () => { await gate; await original(); });
    const listening = broker.listen(reservation);
    const tentative = await BridgeClient.connect(env.pipe, nullLogger);
    try { await expect(tentative.request("auth", { protocol: PROTOCOL_VERSION, token: "fixture-token" })).rejects.toMatchObject({ code: "internal" }); }
    finally { tentative.close(); release(); }
    await listening; spy.mockRestore();
    const client = await BridgeClient.connect(env.pipe, nullLogger);
    try {
      await expect(client.request("auth", { protocol: PROTOCOL_VERSION, token: "wrong-fixture-token" })).rejects.toMatchObject({ code: "unauthorized" });
      expect(await client.request("auth", { protocol: PROTOCOL_VERSION, token: "fixture-token" })).toMatchObject({ brokerPid: process.pid });
    } finally { client.close(); }
  });
  it("a failed initializer releases only its owned tentative listener without any ready acknowledgement", async () => {
    const reservation = await reserve(), broker = ownedBroker();
    vi.spyOn(Reflect.get(broker, "nativeChildren"), "recover").mockRejectedValue(new Error("fixture startup failure"));
    await expect(broker.listen(reservation)).rejects.toThrow("fixture startup failure");
    await expect(BridgeClient.connect(env.pipe, nullLogger)).rejects.toHaveProperty("code");
    expect(broker.mobileHostContext()).toBeUndefined();
  });
  it("oversized tentative input is closed without authentication/store initialization", async () => {
    await reserve(); const socket = await raw(), closed = once(socket, "close");
    socket.write("x".repeat(TENTATIVE_FRAME_BYTES + 1) + "\n"); await closed;
    expect(socket.destroyed).toBe(true); expect(existsSync(env.db)).toBe(false);
  });
  it("tentative aggregate connections are bounded without an admitted request queue", async () => {
    const reservation = await reserve(), connections: Socket[] = [];
    for (let index = 0; index < TENTATIVE_CONNECTION_LIMIT; index++) connections.push(await raw());
    const extra = connect(env.pipe); sockets.push(extra); extra.on("error", () => {});
    await once(extra, "close");
    const server = reservation.ownedServer(env.pipe);
    const count = await new Promise<number>((resolve, reject) => server.getConnections((error, value) => error ? reject(error) : resolve(value)));
    expect(count).toBeLessThanOrEqual(TENTATIVE_CONNECTION_LIMIT); expect(extra.destroyed).toBe(true);
    expect(existsSync(env.db)).toBe(false);
  });
});
