import { afterEach, expect, it, vi } from "vitest";

// Replace only the OS query this module issues; everything else stays the real implementation.
const query = vi.hoisted(() => ({ results: [] as Array<string | Error>, calls: 0 }));
const next = () => { query.calls++; const result = query.results.shift() ?? new Error("fixture: no result queued"); return result; };
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  // promisify(execFile) resolves with the callback's value, as the real custom promisify does: { stdout, stderr }.
  const execFile = vi.fn((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, value?: { stdout: string; stderr: string }) => void;
    const result = next();
    setImmediate(() => result instanceof Error ? callback(result) : callback(null, { stdout: result, stderr: "" }));
  });
  return { ...actual, execFile };
});
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(async (path: unknown, options: unknown) => {
    if (path === "/proc/sys/kernel/random/boot_id") return "fixture-boot\n";
    if (typeof path === "string" && path.startsWith("/proc/")) {
      const result = next();
      if (result instanceof Error) throw result;
      return `1 (node) ${Array.from({ length: 19 }, () => "0").join(" ")} ${result} 0`;
    }
    return actual.readFile(path as string, options as never);
  }) };
});

afterEach(() => { query.results = []; query.calls = 0; });

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
