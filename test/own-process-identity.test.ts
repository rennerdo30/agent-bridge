import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Replace only the OS query this module issues; everything else stays the real implementation.
const query = vi.hoisted(() => ({ results: [] as Array<string | Error>, calls: 0, hold: false, syncMs: 0, releases: [] as Array<() => void> }));
const thread = vi.hoisted(() => ({ main: true, data: {} as Record<string, unknown> }));
vi.mock("node:worker_threads", async original => ({
  ...await original<typeof import("node:worker_threads")>(),
  get isMainThread() { return thread.main; }, get workerData() { return thread.data; },
}));
const next = () => { query.calls++; const result = query.results.shift() ?? new Error("fixture: no result queued"); return result; };
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  // promisify(execFile) resolves with the callback's value, as the real custom promisify does: { stdout, stderr }.
  const execFile = vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, value?: { stdout: string; stderr: string }) => void;
    const result = next();
    const finish = () => result instanceof Error ? callback(result) : callback(null, { stdout: result, stderr: "" });
    if (query.hold) query.releases.push(finish); else setImmediate(finish);
  });
  return { ...actual, execFile, execFileSync: vi.fn(() => {
    const result = next();
    vi.advanceTimersByTime(query.syncMs);
    if (result instanceof Error) throw result;
    return result;
  }) };
});
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn((path: unknown, options: unknown) => {
    if (path === "/proc/sys/kernel/random/boot_id") return "00000000-0000-0000-0000-000000000001\n";
    if (path === `/proc/${process.pid}/stat`) {
      const result = next(); vi.advanceTimersByTime(query.syncMs);
      if (result instanceof Error) throw result;
      return `1 (node) ${Array.from({ length: 19 }, () => "0").join(" ")} ${result} 0`;
    }
    return actual.readFileSync(path as string, options as never);
  }) };
});
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(async (path: unknown, options: unknown) => {
    if (path === "/proc/sys/kernel/random/boot_id") return "fixture-boot\n";
    if (typeof path === "string" && path.startsWith("/proc/")) {
      const result = next();
      if (query.hold) await new Promise<void>(resolve => query.releases.push(resolve));
      if (result instanceof Error) throw result;
      return `1 (node) ${Array.from({ length: 19 }, () => "0").join(" ")} ${result} 0`;
    }
    return actual.readFile(path as string, options as never);
  }) };
});

afterEach(() => { for (const release of query.releases.splice(0)) release(); query.hold = false; query.syncMs = 0; vi.useRealTimers(); query.results = []; query.calls = 0; thread.main = true; thread.data = {}; vi.resetModules(); });

const seededIdentity = process.platform === "win32" ? "638950000000000001" : process.platform === "linux"
  ? "00000000-0000-0000-0000-000000000001:123" : "Thu Oct 15 12:00:00 2026";
it("attributes a 3.5 second migration-lock stall to the cold own-PID probe and removes it with the worker seed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-lock-"));
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  thread.main = false; query.syncMs = 3_500;
  query.results.push(process.platform === "linux" ? "123" : seededIdentity);
  try {
    const cold = await import("../src/core/migration-lock.js");
    const started = performance.now();
    const release = cold.migrationLock(join(dir, "history.db"));
    expect(performance.now() - started).toBe(3_500);
    expect(query.calls).toBe(1); release();
    vi.resetModules();
    thread.data = { ownProcessIdentity: { pid: process.pid, identity: seededIdentity } };
    const warm = await import("../src/core/migration-lock.js");
    const seededAt = performance.now();
    const releaseSeeded = warm.migrationLock(join(dir, "history.db"));
    expect(performance.now() - seededAt).toBe(0);
    expect(query.calls).toBe(1); releaseSeeded();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("uses a verified same-PID worker seed without an OS query, even when that dependency would fail", async () => {
  thread.main = false; thread.data = { ownProcessIdentity: { pid: process.pid, identity: seededIdentity } };
  query.results.push(new Error("SIMULATED cold OS query"));
  const { ownProcessIdentity, processIdentity } = await import("../src/core/process-identity.js");
  expect(await ownProcessIdentity()).toBe(seededIdentity);
  expect(processIdentity(process.pid)).toBe(seededIdentity); expect(query.calls).toBe(0);
});
it("reproduces a cold worker's idle-wait overrun with a held OS identity probe and controlled timers", async () => {
  thread.main = false; query.hold = true; query.results.push("638950000000000001");
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const { ownProcessIdentity } = await import("../src/core/process-identity.js");
  let settled = false;
  const ready = ownProcessIdentity().then(value => { settled = true; return value; });
  await vi.advanceTimersByTimeAsync(5_001);
  expect(settled).toBe(false); expect(query.calls).toBe(1);
  for (const release of query.releases.splice(0)) release();
  expect(await ready).toBeTruthy();
});
it.each([undefined, { pid: process.pid, identity: "" }, { pid: process.pid, identity: " " },
  { pid: process.pid, identity: "invalid" }, { pid: process.pid + 1, identity: seededIdentity },
])("ignores an absent/invalid worker seed and retains the OS probe: %j", async seed => {
  thread.main = false; thread.data = { ownProcessIdentity: seed };
  query.results.push(new Error("SIMULATED cold OS query"));
  const { ownProcessIdentity } = await import("../src/core/process-identity.js");
  expect(await ownProcessIdentity()).toBeUndefined(); expect(query.calls).toBe(1);
});

it("does not cache a failed own-identity read, then caches the first success", async () => {
  const { ownProcessIdentity, processIdentity } = await import("../src/core/process-identity.js");
  query.results.push(new Error("fixture: identity query failed"));
  expect(await ownProcessIdentity()).toBeUndefined();
  expect(query.calls).toBe(1);
  // A failure leaves no shared promise or value behind: the next caller queries again.
  query.results.push("638950000000000001");
  const [first, second] = await Promise.all([ownProcessIdentity(), ownProcessIdentity()]);
  expect(query.calls).toBe(2); // Concurrent callers share one read.
  const expected = process.platform === "linux" ? "fixture-boot:638950000000000001" : "638950000000000001";
  expect(first).toBe(expected); expect(second).toBe(expected);
  expect(await ownProcessIdentity()).toBe(expected);
  expect(processIdentity(process.pid)).toBe(expected); // The synchronous path reads the same cache.
  expect(query.calls).toBe(2);
});
