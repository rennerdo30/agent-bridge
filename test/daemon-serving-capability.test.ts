import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Broker, assertLifecycleServingCapability } from "../src/core/broker.js";
import { EndpointReservation } from "../src/core/endpoint-reservation.js";
import { BridgeClient } from "../src/core/client.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv, broker: Broker | undefined, store: MessageStore | undefined, reservation: EndpointReservation | undefined;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => {
  vi.restoreAllMocks(); await broker?.close(); await reservation?.close();
  broker = undefined; store = undefined; reservation = undefined; await env.cleanup();
});
async function own(endpoint = env.pipe) {
  reservation = await EndpointReservation.bind(endpoint);
  store = new MessageStore(env.db, nullLogger); broker = new Broker(endpoint, store, nullLogger, "fixture-token");
  broker.setHostingMode("daemon"); return broker;
}
async function authenticated(endpoint = env.pipe) {
  const client = await BridgeClient.connect(endpoint, nullLogger);
  try { await client.request("auth", { protocol: PROTOCOL_VERSION, token: "fixture-token" }); expect(await client.request("ping", {})).toBeTruthy(); }
  finally { client.close(); }
}

describe("source-owned activated serving capability (not bootstrap/role-transfer acceptance)", () => {
  it("real reserved activation/authentication permits an opaque phase grant; copy/wrong phase/expiry/close cannot", async () => {
    const b = await own(); await b.listen(reservation); await authenticated();
    const cap = b.lifecycleServingCapability("prepare", performance.now() + 5000);
    expect(Object.keys(cap)).toHaveLength(0); expect(Object.isFrozen(cap)).toBe(true);
    const actual = assertLifecycleServingCapability(cap, "prepare");
    expect(actual.endpoint).toBe(env.pipe); expect(actual.ownerInstance).toMatch(/^[a-f0-9-]{36}$/);
    expect(() => assertLifecycleServingCapability({ ...cap }, "prepare")).toThrow("unavailable");
    expect(() => assertLifecycleServingCapability(cap, "write")).toThrow("unavailable");
    expect(() => b.lifecycleServingCapability("write", performance.now() - 1)).toThrow("unavailable");
    const expiring = b.lifecycleServingCapability("admission", performance.now() + 20);
    // Explicit real-clock expiry observation; no actor work is cancelled/retried.
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(() => assertLifecycleServingCapability(expiring, "admission")).toThrow("unavailable");
    const live = b.lifecycleServingCapability("prepare", performance.now() + 5000);
    await b.close(); expect(() => assertLifecycleServingCapability(live, "prepare")).toThrow("unavailable");
  });
  it("a constructor/flag or actual tentative listener cannot mint before real initialization/activation", async () => {
    const b = await own(), actual = Reflect.get(b, "startServices").bind(b);
    let opened!: () => void, resume!: () => void;
    const entering = new Promise<void>(resolve => { opened = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
    Reflect.set(b, "startServices", async (...args: unknown[]) => { opened(); await gate; return actual(...args); });
    const start = b.listen(reservation);
    try {
      await entering;
      expect(() => b.lifecycleServingCapability("prepare", performance.now() + 5000)).toThrow("unavailable");
      const fake = Object.assign(Object.create(Broker.prototype), { hosting: { mode: "daemon" } });
      expect(() => fake.lifecycleServingCapability("prepare", performance.now() + 5000)).toThrow("unavailable");
    } finally { resume(); }
    await start; await authenticated();
    expect(assertLifecycleServingCapability(b.lifecycleServingCapability("prepare", performance.now() + 5000), "prepare").generation).toBe(0);
  });
  it("actual activation then injected failure has no issuer while real asynchronous cleanup is held", async () => {
    const b = await own(), activate = reservation!.activate.bind(reservation), close = store!.closeBackups.bind(store);
    let cleanupEntered!: () => void, resume!: () => void;
    const entering = new Promise<void>(resolve => { cleanupEntered = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(reservation!, "activate").mockImplementation(accept => { activate(accept); throw new Error("SIMULATED post-activation failure"); });
    vi.spyOn(store!, "closeBackups").mockImplementation(async () => { cleanupEntered(); await gate; return close(); });
    const start = b.listen(reservation), failed = expect(start).rejects.toThrow("SIMULATED post-activation failure");
    try { await entering; expect(() => b.lifecycleServingCapability("prepare", performance.now() + 5000)).toThrow("unavailable"); }
    finally { resume(); }
    await failed;
    expect(() => b.lifecycleServingCapability("prepare", performance.now() + 5000)).toThrow("unavailable");
  });
  it("an actually serving custom endpoint retains ordinary authenticated behavior but has no canonical lifecycle grant", async () => {
    const endpoint = `${env.pipe}-other`, b = await own(endpoint); await b.listen(reservation); await authenticated(endpoint);
    expect(() => b.lifecycleServingCapability("prepare", performance.now() + 5000)).toThrow("unavailable");
  });
});
