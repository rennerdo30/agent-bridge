import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { MessageStore } from "../src/core/store.js";
import { NativeChildren } from "../src/core/native-children.js";
import { nullLogger } from "../src/core/logger.js";

const io = vi.hoisted(() => ({ servers: [] as any[] }));
vi.mock("node:net", async original => {
  const actual = await original<typeof import("node:net")>();
  return { ...actual, createServer: (accept?: (...args: any[]) => void) => {
    const server = Object.assign(new EventEmitter(), { listening: false, endpoint: "fixture", closed: false,
      listen(this: any, endpoint: string, ...args: any[]) { this.endpoint = endpoint; this.listening = true; queueMicrotask(() => { this.emit("listening"); args.find(arg => typeof arg === "function")?.(); }); return this; },
      address() { return this.endpoint; }, close(this: any, done?: () => void) { this.closed = true; this.listening = false; this.emit("close"); done?.(); return this; } });
    if (accept) server.on("connection", accept); io.servers.push(server); return server;
  } };
});
const deferred = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; };
let store: MessageStore | undefined;
const brokers: Broker[] = [];
afterEach(async () => { for (const broker of brokers.splice(0)) await broker.close(); store?.close(); store = undefined; vi.restoreAllMocks(); vi.useRealTimers(); io.servers = []; });
function fixture() {
  store = new MessageStore(":memory:", nullLogger); const broker = new Broker("fixture-startup", store, nullLogger, "fixture-token");
  brokers.push(broker);
  const server = Object.assign(new EventEmitter(), { listening: true, address: () => "fixture-startup", close(this: any, done?: () => void) { this.listening = false; this.emit("close"); done?.(); return this; } });
  const reservation = { ownedServer: () => server, activate: vi.fn(), close: vi.fn(async () => { server.listening = false; }) };
  const controller = new AbortController(); let expired = false;
  const check = () => { controller.signal.throwIfAborted(); if (expired) throw Object.assign(new Error("original startup expired"), { code: "timeout" }); };
  return { broker, server, reservation, controller, check, expire: () => { expired = true; controller.abort(Object.assign(new Error("original startup expired"), { code: "timeout" })); } };
}
it("does not start later service effects after suspended recovery resumes beyond original expiry", async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  vi.spyOn(NativeChildren.prototype, "recover").mockImplementation(async () => { entered.release(); await gate.promise; });
  const backup = vi.spyOn(store!, "startBackups"), pending = (f.broker.listen as any)(f.reservation, f.check, f.controller.signal).catch((error: unknown) => error);
  await entered.promise; f.expire(); gate.release(); const failure = await pending;
  expect(failure).toMatchObject({ code: "timeout" }); expect(backup).not.toHaveBeenCalled(); expect(f.reservation.activate).not.toHaveBeenCalled();
});
it("keeps the reserved pipe tentative while TCP startup is suspended and never activates after abort", async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  vi.spyOn(f.broker as any, "startTcpFallback").mockImplementation(async () => { entered.release(); await gate.promise; });
  const pending = (f.broker.listen as any)(f.reservation, f.check, f.controller.signal).catch((error: unknown) => error);
  await entered.promise; const beforeAbort = f.reservation.activate.mock.calls.length; f.expire(); gate.release();
  const failure = await pending; expect(beforeAbort).toBe(0); expect(failure).toMatchObject({ code: "timeout" }); expect(f.reservation.activate).not.toHaveBeenCalled();
});
it("keeps a directly bound listener from admitting requests until all services complete", async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  vi.spyOn(NativeChildren.prototype, "recover").mockImplementation(async () => { entered.release(); await gate.promise; });
  const accepted = vi.spyOn(f.broker as any, "accept"), pending = (f.broker.listen as any)(undefined, f.check, f.controller.signal).catch((error: unknown) => error);
  await entered.promise;
  const socket = Object.assign(new EventEmitter(), { destroyed: false, setEncoding() {}, destroy() { this.destroyed = true; }, setTimeout() {}, writableLength: 0 });
  io.servers[0].emit("connection", socket); const beforeAbort = accepted.mock.calls.length; f.expire(); gate.release();
  const failure = await pending; expect(beforeAbort).toBe(0); expect(failure).toMatchObject({ code: "timeout" }); expect(socket.destroyed).toBe(true);
});
