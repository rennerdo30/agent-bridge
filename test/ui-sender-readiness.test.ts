import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { retainedUiSender } from "../src/cli/ui-sender.js";

// Execute the actual UI factory and HTTP cancellation adapter with mock-only
// dependencies. Importing startUi would load unrelated storage/native modules.
const ui = readFileSync(new URL("../src/cli/ui.ts", import.meta.url), "utf8");
const factory = ui.slice(ui.indexOf("const sender = retainedUiSender("), ui.indexOf("  const networkRequest ="));
const adapter = ui.slice(ui.indexOf("const server = createServer((req, res) => {"), ui.indexOf("  // Open browser connections"))
  .replaceAll("(err as Error)", "err"); // Erase only the adapter's TypeScript casts.
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  try {
    await Promise.all(cleanups.splice(0).map(close => close()));
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

function fixture(start: () => Promise<void> = async () => {}, construct: () => void = () => {}) {
  const identity = deferred<string | undefined>();
  const prepare = vi.fn(() => identity.promise);
  const nodes: Peer[] = [];
  class Peer {
    metadata = false;
    readState = false;
    stopping = false;
    observations: Array<[boolean, boolean]> = [];
    start = vi.fn(() => { this.observations.push([this.metadata, this.readState]); return start(); });
    stop = vi.fn(async () => { this.stopping = true; });
    send = vi.fn(async () => "confirmed");
    control = vi.fn();
    constructor(readonly options: Record<string, unknown>) {
      construct();
      this.metadata = this.readState = true;
      nodes.push(this);
    }
  }
  const config = vi.fn(() => ({ network: "fixture-network" }));
  const sender = new Function("retainedUiSender", "ownProcessIdentity", "BridgeNode", "opts", "token", "dbPath", "UI_PEER_NAME", "loadConfig",
    `${factory}\nreturn sender;`)(retainedUiSender, prepare, Peer,
    { pipe: "fixture-pipe", home: "fixture-home", log: {}, brokerDaemon: { cli: "fixture-cli" } }, "fixture-token", "fixture-db", "you", config) as ReturnType<typeof retainedUiSender<Peer>>;
  cleanups.push(sender.close);
  const request = (signal?: AbortSignal) => {
    const state: { value?: string; error?: unknown; settled: boolean } = { settled: false };
    const done = sender.get(signal).then(node => node.send()).then(
      value => { state.value = value; state.settled = true; },
      error => { state.error = error; state.settled = true; });
    return { state, done };
  };
  return { sender, identity, prepare, nodes, request, config };
}

it("bounds initialization before construction/election/send and closes without waiting for late preparation", async () => {
  const f = fixture();
  const request = f.request();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(request.state.error).toBeInstanceOf(Error);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.nodes).toHaveLength(0);
  await f.sender.close();
  f.identity.resolve(undefined);
  await request.done;
  await vi.advanceTimersByTimeAsync(0);
  expect(f.nodes).toHaveLength(0);
  await expect(f.sender.get()).rejects.toThrow("unavailable");
});

it("charges five seconds of initialization against the same eight-second readiness budget", async () => {
  const election = deferred<void>(), f = fixture(() => election.promise);
  const request = f.request();
  await vi.advanceTimersByTimeAsync(5_000);
  f.identity.resolve("known");
  await vi.advanceTimersByTimeAsync(2_999);
  expect(request.state.settled).toBe(false);
  expect(f.nodes[0]!.observations).toEqual([[true, true]]);
  await vi.advanceTimersByTimeAsync(1);
  expect(request.state.error).toBeInstanceOf(Error);
  expect(f.nodes[0]!.send).not.toHaveBeenCalled();
  election.resolve();
  await request.done;
});

it("retains one unknown-launch node across two timed-out requests and eventual readiness", async () => {
  let election: Promise<void> | undefined, latch = false, discoveries = 0;
  const launch = vi.fn();
  const f = fixture(() => election ??= (async () => {
    if (!latch) { latch = true; launch(); }
    for (let n = 0; n < 20; n++) { discoveries++; await delay(599); }
    throw new Error("ENOENT");
  })());
  const first = f.request(); f.identity.resolve(undefined);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(first.state.error).toBeInstanceOf(Error);
  const second = f.request();
  await vi.advanceTimersByTimeAsync(3_980);
  expect(discoveries).toBe(20);
  expect(second.state.error).toMatchObject({ message: "ENOENT" });
  expect(f.nodes).toHaveLength(1);
  expect(f.nodes[0]!.start).toHaveBeenCalledTimes(2);
  expect(f.nodes[0]!.observations).toEqual([[true, true], [true, true]]);
  expect(f.nodes[0]!.send).not.toHaveBeenCalled();
  expect(launch).toHaveBeenCalledOnce();
  election = Promise.resolve(); // Mock authenticated readiness on the SAME peer.
  const third = f.request(); await vi.advanceTimersByTimeAsync(0);
  expect(third.state.value).toBe("confirmed");
  expect(f.nodes).toHaveLength(1);
  expect(f.nodes[0]!.send).toHaveBeenCalledOnce();
  expect(launch).toHaveBeenCalledOnce();
  expect(f.config).toHaveBeenCalledOnce();
  expect(f.nodes[0]!.options).toMatchObject({ name: "you", autoWake: false, dbPath: "fixture-db", daemon: { cli: "fixture-cli" }, network: { home: "fixture-home", config: "fixture-network" } });
});

it("coalesces overlapping requests but gives each its own remaining budget", async () => {
  const election = deferred<void>(), f = fixture(() => election.promise);
  const first = f.request();
  await vi.advanceTimersByTimeAsync(4_000);
  const second = f.request(); f.identity.resolve("known");
  await vi.advanceTimersByTimeAsync(4_000);
  expect(first.state.error).toBeInstanceOf(Error);
  expect(second.state.settled).toBe(false);
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.nodes[0]!.start).toHaveBeenCalledOnce();
  election.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(second.state.value).toBe("confirmed");
  expect(f.nodes[0]!.send).toHaveBeenCalledOnce();
});

it("does not let an old start settlement clear a newer shared readiness attempt", async () => {
  const old = deferred<void>(), next = deferred<void>();
  let calls = 0;
  const f = fixture(() => ++calls === 1 ? old.promise : next.promise);
  const first = f.request(); f.identity.resolve("known");
  await vi.advanceTimersByTimeAsync(8_000);
  expect(first.state.error).toBeInstanceOf(Error);
  const second = f.request(); await vi.advanceTimersByTimeAsync(0);
  old.reject(new Error("old election failed")); await vi.advanceTimersByTimeAsync(0);
  const third = f.request(); await vi.advanceTimersByTimeAsync(0);
  expect(f.nodes[0]!.start).toHaveBeenCalledTimes(2);
  next.resolve(); await Promise.all([second.done, third.done]);
  expect(f.nodes[0]!.send).toHaveBeenCalledTimes(2);
});

it("keeps initialization failure stable without replacing the peer or leaking rejection/timers", async () => {
  const f = fixture(), failure = new Error("prepare failed"), first = f.request();
  f.identity.reject(failure); await first.done;
  const second = f.request(); await second.done;
  expect(first.state.error).toBe(failure); expect(second.state.error).toBe(failure);
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.nodes).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops the owned node immediately while start is pending and refuses its late success", async () => {
  const election = deferred<void>(), f = fixture(() => election.promise);
  const request = f.request(); f.identity.resolve("known"); await vi.advanceTimersByTimeAsync(0);
  const node = f.nodes[0]!;
  await f.sender.close();
  expect(node.stopping).toBe(true); expect(node.stop).toHaveBeenCalledOnce();
  await request.done;
  expect(request.state.error).toBeInstanceOf(Error);
  election.resolve(); await request.done;
  await f.sender.close();
  expect(node.send).not.toHaveBeenCalled(); expect(node.stop).toHaveBeenCalledOnce();
  expect(f.nodes).toHaveLength(1);
});

it("cancels a disconnected HTTP wait before a late send or control and detaches listeners", async () => {
  const election = deferred<void>(), f = fixture(() => election.promise);
  const req = new EventEmitter(), res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: true });
  const response = vi.fn(), log = { warn: vi.fn() };
  const handle = async (_req: unknown, _res: unknown, signal: AbortSignal) => {
    const node = await f.sender.get(signal);
    await node.send(); node.control();
  };
  const listener = new Function("createServer", "handle", "opts", "send", `${adapter}\nreturn server;`)(
    (callback: unknown) => callback, handle, { log }, response) as (req: EventEmitter, res: EventEmitter) => void;
  listener(req, res); f.identity.resolve("known"); await vi.advanceTimersByTimeAsync(0);
  res.emit("close"); await vi.advanceTimersByTimeAsync(0);
  election.resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(f.nodes[0]!.send).not.toHaveBeenCalled(); expect(f.nodes[0]!.control).not.toHaveBeenCalled();
  expect(response).not.toHaveBeenCalled();
  expect(req.listenerCount("aborted")).toBe(0); expect(res.listenerCount("close")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("returns the existing HTTP 500 error path before body/control invocation on readiness expiry", async () => {
  const f = fixture(), response = vi.fn();
  const req = new EventEmitter(), res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false });
  const handle = async (_req: unknown, _res: unknown, signal: AbortSignal) => {
    const node = await f.sender.get(signal); await node.send(); node.control();
  };
  const listener = new Function("createServer", "handle", "opts", "send", `${adapter}\nreturn server;`)(
    (callback: unknown) => callback, handle, { log: { warn: vi.fn() } }, response) as (req: EventEmitter, res: EventEmitter) => void;
  listener(req, res); await vi.advanceTimersByTimeAsync(8_000);
  expect(response).toHaveBeenCalledWith(res, 500, { error: "agent-bridge broker is unavailable" });
  expect(f.nodes).toHaveLength(0);
  await f.sender.close(); f.identity.resolve(undefined);
});

it("refuses success after synchronous construction overruns the budget without claiming preemption", async () => {
  const f = fixture(async () => {}, () => vi.setSystemTime(Date.now() + 9_000));
  const request = f.request(); f.identity.resolve("known"); await request.done;
  expect(request.state.error).toBeInstanceOf(Error);
  expect(f.nodes[0]!.send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
