import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { controlDashboardJob, JobControlError } from "../src/core/job-control.js";
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

// These are the production functions/statements, with only types erased. No
// replacement control callback or route implementation can hide a missed guard.
const section = (start: string, end: string) => {
  const from = ui.indexOf(start), to = ui.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error(`Missing production boundary: ${start}`);
  return ui.slice(from, to);
};
const ownerSource = section("async function jobOwner(", "interface MessageRow");
const transportSource = section("  const networkRequest =", "  const remoteRead =");
const handoffSource = section('    if (req.method === "POST" && url.pathname === "/api/subagents/handoff")', "    const jobCommand =");
const jobSource = section("    const jobCommand =", '    return send(res, 404, { error: "not found" });');
const childSource = section("          const sender = await getSender();", "          return send(res, result.isError");

async function controlFixture(route: "handoff" | "job" | "child", hold: "owner" | "control" | "connect" | "auth" | "submitted") {
  const f = fixture(); f.identity.resolve("known");
  const node = await f.sender.get(), events = new EventEmitter(), pending = deferred<void>();
  Object.assign(node, { id: "fixture-sender", on: events.on.bind(events), off: events.off.bind(events) });
  let lookups = 0;
  const peers = vi.fn(async () => {
    const ordinal = ++lookups;
    if (hold === "owner" && ordinal === 1 || hold === "control" && ordinal === (route === "handoff" ? 1 : 2)) await pending.promise;
    return [{ name: "owner" }];
  });
  Object.assign(node, { peers });
  const commit = vi.fn(async (_op: string, args: { body: string }) => {
    if (hold === "submitted") await pending.promise;
    const { requestId } = JSON.parse(args.body);
    events.emit("job_control", { from: { name: "owner" }, body: JSON.stringify({ type: "result", requestId, outcome: "queued", text: "confirmed", isError: false }) });
    return { messages: [], deliveredTo: ["owner"], queuedFor: [] };
  });
  const client = {
    close: vi.fn(),
    request: vi.fn(async (op: string, args: { body: string }) => {
      if (op === "auth") { if (hold === "auth") await pending.promise; return {}; }
      return commit(op, args);
    }),
  };
  const connect = vi.fn(async () => { if (hold === "connect") await pending.promise; return client; });
  const response = vi.fn(), opts = { home: "fixture-home", pipe: "fixture-pipe", log: { warn: vi.fn() } };
  const pathname = route === "handoff" ? "/api/subagents/handoff" : "/api/jobs/settings";
  const source = `${ownerSource}\n${transportSource}\nreturn async (req, res, signal) => {
    const getSender = () => sender.get(signal);
    const url = { pathname: ${JSON.stringify(pathname)} };
    const name = "fixture-job", run = { by: "owner" }, child = { id: "child", title: "child" };
    const body = { body: "owner message" };
    ${route === "handoff" ? handoffSource : route === "job" ? jobSource : `{ ${childSource} }`}
  };`;
  const dependencies = {
    controlDashboardJob, JobControlError, BridgeClient: { connect }, opts, token: "fixture-token", PROTOCOL_VERSION: 1, DASHBOARD_TIMEOUT_MS: 10_000,
    sender: f.sender, send: response, readJson: async () => ({ from: "owner", to: "new-owner", run: "fixture-run" }),
    handoffSchema: { safeParse: () => ({ success: true, data: { to: "new-owner", jobs: "all" } }) },
    JOB_COMMANDS: { [pathname]: () => ({ type: "settings", settings: { model: "fixture" } }) }, RUN_NAME: /^[\w.-]+\.log$/,
    listRunsResponsive: async () => [{ name: "fixture-run", by: "owner", job: "fixture-job" }], recoverJobRecord: () => ({}),
    chooseJobRecipient: () => "owner", ProjectGroups: class { members() { return []; } }, childNote: (_id: string, _title: string, body: string) => body,
  };
  const handle = new Function(...Object.keys(dependencies),
    stripTypeScriptTypes(`function wireControl() { ${source} }`) + "\nreturn wireControl();")(...Object.values(dependencies));
  const listener = new Function("createServer", "handle", "opts", "send", `${adapter}\nreturn server;`)(
    (callback: unknown) => callback, handle, opts, response) as (req: EventEmitter, res: EventEmitter) => void;
  const req = Object.assign(new EventEmitter(), { method: "POST", headers: { "x-agent-bridge": "1" } });
  const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false });
  listener(req, res); await vi.advanceTimersByTimeAsync(0);
  return { pending, peers, connect, client, commit, response, req, res, events };
}

it.each([
  ["handoff", "control"], ["job", "owner"], ["job", "control"], ["child", "owner"], ["child", "control"],
] as const)("cancels actual %s control after readiness while %s peer lookup is pending", async (route, hold) => {
  const f = await controlFixture(route, hold);
  expect(f.peers).toHaveBeenCalledTimes(hold === "control" && route !== "handoff" ? 2 : 1);
  f.res.destroyed = true; f.res.emit("close"); f.pending.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.commit).not.toHaveBeenCalled();
  expect(f.response).not.toHaveBeenCalled();
  expect(f.events.listenerCount("job_control")).toBe(0);
  expect(f.req.listenerCount("aborted")).toBe(0); expect(f.res.listenerCount("close")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["connect", "auth"] as const)("cancels actual control before submission when transport %s is pending", async hold => {
  const f = await controlFixture("handoff", hold);
  expect(f.connect).toHaveBeenCalledOnce();
  f.res.destroyed = true; f.res.emit("close"); f.pending.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.commit).not.toHaveBeenCalled(); expect(f.client.close).toHaveBeenCalledOnce();
  expect(f.response).not.toHaveBeenCalled(); expect(f.events.listenerCount("job_control")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not retry or report success when a submitted control becomes uncertain after disconnect", async () => {
  const f = await controlFixture("handoff", "submitted");
  expect(f.commit).toHaveBeenCalledOnce();
  f.res.destroyed = true; f.res.emit("close"); f.pending.reject(new Error("submission uncertain"));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.commit).toHaveBeenCalledOnce(); expect(f.client.close).toHaveBeenCalledOnce();
  expect(f.response).not.toHaveBeenCalled(); expect(f.events.listenerCount("job_control")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
