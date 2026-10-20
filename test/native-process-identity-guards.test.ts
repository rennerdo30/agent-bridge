import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Every OS boundary is fake: no worker, PowerShell, native host, pipe or PID starts here.
type Message = { type?: string; id?: number; pids?: number[]; sync?: boolean; results?: string[] };
type Port = { queue: Message[]; close: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };
type FakeWorker = import("node:events").EventEmitter & {
  state: Int32Array; messages: Message[]; terminate: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn>;
};
type FakeHost = import("node:events").EventEmitter & {
  stdout: import("node:events").EventEmitter; kill: ReturnType<typeof vi.fn<() => boolean>>;
};
const thread = vi.hoisted(() => ({
  main: true, workers: [] as FakeWorker[], ports: [] as Port[],
  post: undefined as ((message: Message, worker: FakeWorker) => void) | undefined,
  afterEmpty: undefined as (() => void) | undefined,
}));
vi.mock("node:worker_threads", async original => {
  const actual = await original<typeof import("node:worker_threads")>();
  const { EventEmitter } = await import("node:events");
  class Worker extends EventEmitter {
    state: Int32Array;
    messages: Message[] = [];
    unref = vi.fn(); ref = vi.fn();
    terminate = vi.fn(async () => { this.emit("exit", 0); return 0; });
    constructor(_script: string, options: { workerData: { state: SharedArrayBuffer } }) {
      super(); this.state = new Int32Array(options.workerData.state); thread.workers.push(this);
    }
    postMessage(message: Message) { this.messages.push(message); thread.post?.(message, this); }
  }
  class MessageChannel {
    port1 = { queue: [] as Message[], close: vi.fn(), unref: vi.fn() };
    port2 = { close: vi.fn(), unref: vi.fn() };
    constructor() { thread.ports.push(this.port1); }
  }
  return { ...actual, Worker, MessageChannel, get isMainThread() { return thread.main; },
    receiveMessageOnPort: (port: Port) => {
      const message = port.queue.shift();
      if (message) return { message };
      const action = thread.afterEmpty; thread.afterEmpty = undefined; action?.();
      return undefined;
    },
  };
});
const spawned = vi.hoisted(() => ({ succeed: false, failStdin: false, calls: [] as string[], hosts: [] as FakeHost[] }));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  return { ...actual, spawn: (file: string) => {
    spawned.calls.push(file);
    if (!spawned.succeed) throw new Error("SIMULATED host spawn failure");
    const stdout = Object.assign(new EventEmitter(), { setEncoding() { return this; }, unref: vi.fn(), destroy: vi.fn() });
    const host = Object.assign(new EventEmitter(), { pid: 900_427 + spawned.hosts.length,
      exitCode: null as number | null, signalCode: null, stdout,
      stdin: Object.assign(new EventEmitter(), { end: vi.fn(() => { if (spawned.failStdin) throw new Error("SIMULATED stdin setup failure"); }), destroy: vi.fn() }), unref: vi.fn(),
      kill: vi.fn(() => { host.exitCode = 0; host.emit("exit", 0); return true; }),
    });
    spawned.hosts.push(host); return host;
  } };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let native: typeof import("../src/core/windows-process-identity.js");
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] }); vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
  thread.main = true; thread.workers = []; thread.ports = []; thread.post = undefined; thread.afterEmpty = undefined;
  spawned.succeed = false; spawned.failStdin = false; spawned.calls = []; spawned.hosts = [];
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  native = await import("../src/core/windows-process-identity.js");
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  await native.stopNativeIdentityHost();
  vi.useRealTimers(); vi.restoreAllMocks();
});
async function ready() {
  spawned.succeed = true;
  const started = native.nativeIdentityHostStarted();
  const worker = thread.workers.at(-1)!, host = spawned.hosts.at(-1)!;
  host.stdout.emit("data", "ready\n");
  Atomics.store(worker.state, 1, 1); worker.emit("message", { type: "connected" });
  expect(await started).toBe(true);
  return { worker, host, port: thread.ports.at(-1)! };
}

it("never starts a host or worker off the main thread; the PowerShell probe decides there", async () => {
  thread.main = false;
  expect(native.readNativeIdentitiesSync([process.pid], 1_000)).toBeUndefined();
  expect(native.readNativeIdentities([process.pid], 1_000)).toBeUndefined();
  expect(await native.nativeIdentityHostStarted(1_000)).toBe(false);
  expect(spawned.calls).toEqual([]); expect(thread.workers).toHaveLength(0);
  thread.main = true;
  expect(native.readNativeIdentitiesSync([process.pid], 1_000)).toBeUndefined();
  expect(spawned.calls).toHaveLength(1); expect(thread.workers).toHaveLength(1);
});
it("stops trying after three failed host starts, even once the cooldown has passed", async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    native.resetNativeIdentityCooldown();
    expect(await native.nativeIdentityHostStarted(1_000)).toBe(false);
  }
  expect(spawned.calls).toHaveLength(3);
  native.resetNativeIdentityCooldown();
  expect(native.readNativeIdentitiesSync([process.pid], 1_000)).toBeUndefined();
  expect(spawned.calls).toHaveLength(3);
});
it("does not trust a batch in which every PID is unreadable", () => {
  expect(native.parseNativeAnswer([4], ["4=?"])).toBeUndefined();
  expect(native.parseNativeAnswer([4, 8], ["4=?", "8=?"])).toBeUndefined();
  expect(native.parseNativeAnswer([4, 8, 12], ["4=?", "8=638950000000000001", "12=-"]))
    .toEqual(new Map([[4, ""], [8, "638950000000000001"]]));
  expect(native.parseNativeAnswer([12], ["12=-"])).toEqual(new Map());
  expect(native.parseNativeAnswer([4, 8], ["4=?"])).toBeUndefined();
});
it("rejects contradictory or malformed pipe answers instead of proving absence", () => {
  expect(native.parseNativeAnswer([4], ["4=?", "4=-"])).toBeUndefined();
  expect(native.parseNativeAnswer([4], ["garbage", "4=-"])).toBeUndefined();
  expect(native.parseNativeAnswer([4], ["4=-", "8=-"])).toBeUndefined();
});
it("does not lose a wake that arrives just after draining a stale sync answer", async () => {
  const { port } = await ready();
  thread.post = (message, worker) => {
    if (message.type !== "query") return;
    port.queue.push({ id: message.id! - 1, results: ["4=-"] });
    thread.afterEmpty = () => { port.queue.push({ id: message.id, results: ["4=638950000000000001"] }); Atomics.add(worker.state, 0, 1); };
  };
  const wait = vi.spyOn(Atomics, "wait").mockImplementation((state, index, seen) =>
    Atomics.load(state, index) !== seen ? "not-equal" : "timed-out");
  expect(native.readNativeIdentitiesSync([4], 1_000)).toEqual(new Map([[4, "638950000000000001"]]));
  expect(wait.mock.results.some(result => result.value === "timed-out")).toBe(false);
});
it("counts sync dispatch time and rejects a response delivered after the deadline", async () => {
  const { port } = await ready();
  thread.post = message => {
    if (message.type !== "query") return;
    vi.advanceTimersByTime(1_001); port.queue.push({ id: message.id, results: ["4=-"] });
  };
  vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
  expect(native.readNativeIdentitiesSync([4], 1_000)).toBeUndefined();
});
it("retires a timed-out or aborted request so outstanding work cannot block idle exit", async () => {
  for (const abort of [false, true]) {
    const { worker, host, port } = await ready();
    const controller = new AbortController();
    const result = native.readNativeIdentities([4], 1_000, controller.signal);
    if (abort) controller.abort(); else await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBeUndefined();
    expect(worker.terminate).toHaveBeenCalledTimes(1); expect(host.kill).toHaveBeenCalledTimes(1);
    expect(port.close).toHaveBeenCalledTimes(1); expect(native.nativeIdentityHostReady()).toBe(false);
  }
});
it("ignores a late async response after its deadline even before the timer callback", async () => {
  const { worker } = await ready();
  const result = native.readNativeIdentities([4], 1_000), id = worker.messages.at(-1)!.id;
  const now = performance.now(); vi.spyOn(performance, "now").mockReturnValue(now + 1_001);
  worker.emit("message", { id, results: ["4=-"] });
  expect(await result).toBeUndefined();
});
it("worker failure closes its port and tracked host and ignores retired stdout and exit callbacks", async () => {
  spawned.succeed = true;
  const started = native.nativeIdentityHostStarted();
  const worker = thread.workers[0]!, host = spawned.hosts[0]!, port = thread.ports[0]!;
  worker.emit("error", new Error("SIMULATED worker failure"));
  expect(await started).toBe(false);
  expect(host.kill).toHaveBeenCalledTimes(1); expect(port.close).toHaveBeenCalledTimes(1);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  const before = worker.messages.length;
  host.stdout.emit("data", "ready\n"); host.emit("exit", 0);
  expect(worker.messages).toHaveLength(before); expect(native.nativeIdentityHostPid()).toBeUndefined();
  // No real child exists; clean the fake resources even on the broken baseline.
  if (!host.kill.mock.calls.length) host.kill();
});
it("returns fallback and releases owned resources on a startup I/O exception", () => {
  spawned.succeed = true; spawned.failStdin = true;
  expect(native.readNativeIdentitiesSync([4], 1_000)).toBeUndefined();
  expect(spawned.hosts[0]!.kill).toHaveBeenCalledTimes(1);
  expect(thread.workers[0]!.terminate).toHaveBeenCalledTimes(1);
  expect(thread.ports[0]!.close).toHaveBeenCalledTimes(1);
});

it("loads a standalone low-level lease bundle without external npm runtime imports", async () => {
  // Compile and load only: never acquire a lease or call any process/native-host function.
  vi.useRealTimers(); Object.defineProperty(process, "platform", platform);
  const { createRequire } = await import("node:module");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const require = createRequire(import.meta.url);
  // Keep the compiler synchronous and bounded, without starting an esbuild JS worker/service.
  vi.stubEnv("ESBUILD_WORKER_THREADS", "0");
  const esbuildPath = require.resolve("esbuild");
  delete require.cache[esbuildPath];
  const childProcess = require("node:child_process") as typeof import("node:child_process");
  const originalExec = childProcess.execFileSync;
  childProcess.execFileSync = ((file: string, args: readonly string[], options: import("node:child_process").SpawnSyncOptions) => {
    const result = childProcess.spawnSync(file, args, { ...options, timeout: 5_000 });
    console.info(`fixture compiler PID=${result.pid} status=${result.status} timeout=5000ms`);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`fixture compiler failed: ${result.stderr}`);
    return result.stdout;
  }) as typeof childProcess.execFileSync;
  try {
    const { buildSync } = require("esbuild") as typeof import("esbuild");
    const home = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "native-identity-bundle-"));
    const outfile = join(home, "lease-helper.mjs");
    const bundle = buildSync({ entryPoints: ["src/core/metadata-file-lease.ts"], outfile,
      bundle: true, packages: "external", platform: "node", format: "esm", metafile: true, write: false });
    writeFileSync(outfile, bundle.outputFiles![0]!.contents);
    writeFileSync(join(home, "metafile.json"), JSON.stringify(bundle.metafile, null, 2));
    console.info(`fixture bundle=${outfile}`);
    const npmImports = Object.values(bundle.metafile!.outputs).flatMap(output => output.imports)
      .filter(entry => entry.external && !entry.path.startsWith("node:")).map(entry => entry.path);
    expect(npmImports).toEqual([]);
    // Native Node import deliberately bypasses the test transform and checkout's package resolution.
    const load = new Function("url", "return import(url)") as (url: string) => Promise<Record<string, unknown>>;
    expect(typeof (await load(pathToFileURL(outfile).href)).metadataFileLease).toBe("function");
  } finally {
    childProcess.execFileSync = originalExec;
    vi.unstubAllEnvs();
  }
});
