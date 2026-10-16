import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * AB-427 review guards for the native identity host, on every platform (Windows is simulated and the host spawn is
 * a recorded fake that fails, so no PowerShell starts here):
 * - only the main thread may start a host (a worker-spawned host can inherit a concurrent child's stdio handles);
 * - repeated start failures turn native reads off for the rest of the process;
 * - a batch in which every PID is unreadable is not trusted.
 */
const thread = vi.hoisted(() => ({ main: true, workers: 0 }));
vi.mock("node:worker_threads", async original => {
  const actual = await original<typeof import("node:worker_threads")>();
  class CountingWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) { super(...args); thread.workers++; }
  }
  return { ...actual, Worker: CountingWorker, get isMainThread() { return thread.main; } };
});
const spawned = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: (file: string) => { spawned.calls.push(file); throw new Error("SIMULATED host spawn failure"); } };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let native: typeof import("../src/core/windows-process-identity.js");
beforeEach(async () => {
  vi.resetModules();
  thread.main = true; thread.workers = 0; spawned.calls = [];
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  native = await import("../src/core/windows-process-identity.js");
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  await native.stopNativeIdentityHost();
});

it("never starts a host or worker off the main thread; the PowerShell probe decides there", async () => {
  thread.main = false;
  expect(native.readNativeIdentitiesSync([process.pid], 1_000)).toBeUndefined();
  expect(native.readNativeIdentities([process.pid], 1_000)).toBeUndefined();
  expect(await native.nativeIdentityHostStarted(1_000)).toBe(false);
  expect(spawned.calls).toEqual([]);
  expect(thread.workers).toBe(0);
  // Control: the same calls on the main thread do try to start a host.
  thread.main = true;
  expect(native.readNativeIdentitiesSync([process.pid], 1_000)).toBeUndefined();
  expect(spawned.calls).toHaveLength(1);
  expect(thread.workers).toBe(1);
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
  // One protected process among readable ones stays "running, unknown".
  expect(native.parseNativeAnswer([4, 8, 12], ["4=?", "8=638950000000000001", "12=-"]))
    .toEqual(new Map([[4, ""], [8, "638950000000000001"]]));
  // Absent PIDs are a real answer, not a suspect one.
  expect(native.parseNativeAnswer([12], ["12=-"])).toEqual(new Map());
  expect(native.parseNativeAnswer([4, 8], ["4=?"])).toBeUndefined();
});
