import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { MessageStore } from "../src/core/store.js";
import { NativeChildren } from "../src/core/native-children.js";
import { nullLogger } from "../src/core/logger.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const io = vi.hoisted(() => ({ servers: [] as any[] }));
const directories = vi.hoisted(() => ({ next: 2_000_000_000, handles: new Map<number, string>() }));
// Only the directory durability transport is simulated. Mailbox, metadata,
// registration, ownership and transaction paths below remain production code.
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, constants: { ...actual.constants, O_DIRECTORY: actual.constants.O_DIRECTORY || 0x10000 },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (actual.existsSync(args[0]) && actual.lstatSync(args[0]).isDirectory()) { const fd = directories.next++; directories.handles.set(fd, String(args[0])); return fd; }
      return actual.openSync(...args);
    },
    fstatSync: (fd: number, options?: any) => directories.handles.has(fd) ? actual.lstatSync(directories.handles.get(fd)!, options) : actual.fstatSync(fd, options),
    fsyncSync: (fd: number) => { if (!directories.handles.has(fd)) actual.fsyncSync(fd); },
    closeSync: (fd: number) => { if (!directories.handles.delete(fd)) actual.closeSync(fd); },
  };
});
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
let env: TestEnv | undefined;
const brokers: Broker[] = [];
afterEach(async () => { for (const broker of brokers.splice(0)) await broker.close(); store?.close(); store = undefined; vi.restoreAllMocks(); vi.useRealTimers(); io.servers = []; await env?.cleanup(); env = undefined; expect(directories.handles.size).toBe(0); });
function fixture(file = ":memory:") {
  store = new MessageStore(file, nullLogger); const broker = new Broker("fixture-startup", store, nullLogger, "fixture-token");
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

it("activates a compatible direct listener only after its entire preparation and current check succeed", async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  vi.spyOn(f.broker as any, "startTcpFallback").mockImplementation(async () => { entered.release(); await gate.promise; });
  const accepted = vi.spyOn(f.broker as any, "accept").mockImplementation(() => {});
  const pending = f.broker.listen(undefined, f.check, f.controller.signal);
  await entered.promise;
  expect(io.servers[0].listeners("connection")).toHaveLength(1);
  expect(accepted).not.toHaveBeenCalled(); gate.release(); await pending;
  const socket = Object.assign(new EventEmitter(), { destroy() {} }); io.servers[0].emit("connection", socket);
  expect(accepted).toHaveBeenCalledExactlyOnceWith(socket);
});

it("rejects protocol9 authentication before granting authority while protocol10 authenticates without mailbox effects", () => {
  const f = fixture(), connection = { authed: false };
  const insert = vi.spyOn(store!, "insert"), insertOnce = vi.spyOn(store!, "insertOnce");
  const auth = (f.broker as any).handlers.auth;
  expect(() => auth(connection, { protocol: 9, token: "fixture-token" })).toThrow(/protocol/i);
  expect(connection.authed).toBe(false); expect(insert).not.toHaveBeenCalled(); expect(insertOnce).not.toHaveBeenCalled();
  expect(PROTOCOL_VERSION).toBe(10); auth(connection, { protocol: 10, token: "fixture-token" });
  expect(connection.authed).toBe(true); expect(insert).not.toHaveBeenCalled(); expect(insertOnce).not.toHaveBeenCalled();
});

it("does not schedule actual file-store archive maintenance while TCP is suspended across expiry", async () => {
  env = makeEnv(); const f = fixture(env.db), gate = deferred(), entered = deferred();
  vi.spyOn(f.broker as any, "startTcpFallback").mockImplementation(async () => { entered.release(); await gate.promise; });
  const backups = vi.spyOn(store!, "startBackups");
  const pending = f.broker.listen(f.reservation as any, f.check, f.controller.signal).catch((error: unknown) => error);
  await entered.promise; const earlyCalls = backups.mock.calls.length, timer = (store as any).archiveTimer;
  f.expire(); await Promise.resolve(); const lateCalls = backups.mock.calls.length;
  gate.release(); const failure = await pending;
  expect(earlyCalls).toBe(0); expect(timer).toBeNull(); expect(lateCalls).toBe(0); expect(failure).toMatchObject({ code: "timeout" });
});

it("cancels the exact deferred producer turn when close precedes normal-serving admission", async () => {
  vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] }); const f = fixture();
  const producers = vi.spyOn(f.broker as any, "startServingMaintenance");
  await f.broker.listen(f.reservation as any, f.check, f.controller.signal);
  expect(f.reservation.activate).toHaveBeenCalledOnce(); expect(producers).not.toHaveBeenCalled();
  await f.broker.close(); await vi.runAllTimersAsync(); expect(producers).not.toHaveBeenCalled();
});

it("revokes borrowed mobile authority synchronously at abort before cleanup yields, retaining the existing disposer deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); const f = fixture();
  const get = vi.fn(), serviceClose = vi.fn();
  Object.assign(f.broker, { server: f.server, questions: { store: { get }, close: serviceClose } });
  const context = f.broker.mobileHostContext()!; expect(context.ready()).toBe(true);
  const gate = deferred(); let late!: Promise<void>;
  context.onDispose(() => late = gate.promise.then(() => { expect(() => context.ownerQuestions.store.get("held-question")).toThrow("source_unavailable"); }));
  let settled = false; const close = (f.broker as any).abortStartup().then(() => { settled = true; });
  expect(context.ready()).toBe(false); expect(() => context.ownerQuestions.store.get("held-question")).toThrow("source_unavailable");
  await vi.advanceTimersByTimeAsync(4999); expect(settled).toBe(false); expect(serviceClose).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await close; expect(serviceClose).toHaveBeenCalledOnce();
  gate.release(); await late; expect(get).not.toHaveBeenCalled(); expect(context.ready()).toBe(false);
});
