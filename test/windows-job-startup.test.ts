import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { establishWindowsJobScope, startWindowsJobScope, type WindowsJobScope } from "../src/core/windows-job-scope.js";
import { isCurrentRunnerCancel } from "../src/mcp/job-runner.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("retries setup once then starts with logged degraded ownership", async () => {
  const start = vi.fn().mockRejectedValue(new Error("Windows job ownership setup timed out"));
  const warn = vi.fn();
  expect(await establishWindowsJobScope({ ...nullLogger, warn }, start)).toBeNull();
  expect(start).toHaveBeenCalledTimes(2);
  expect(warn.mock.calls.at(-1)?.[0]).toContain("degraded");
});

it("retains a successful retry", async () => {
  const scope = {} as WindowsJobScope;
  const start = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(scope);
  expect(await establishWindowsJobScope(nullLogger, start)).toBe(scope);
  expect(start).toHaveBeenCalledTimes(2);
});

it("ignores cancellation mail from 0.29.10 before the continuation began", () => {
  expect(isCurrentRunnerCancel(100, 101)).toBe(false);
  expect(isCurrentRunnerCancel(101, 101)).toBe(true);
  expect(isCurrentRunnerCancel(102, 101)).toBe(true);
});

function guardian() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: vi.fn(), pid: 123 });
  spawn.mockReturnValue(child);
  return child;
}

it.skipIf(process.platform !== "win32")("bounds setup and never accepts late readiness", async () => {
  vi.useFakeTimers();
  const child = guardian();
  const outcome = startWindowsJobScope(nullLogger, 456);
  const failed = expect(outcome).rejects.toThrow("setup timed out");
  await vi.advanceTimersByTimeAsync(8_000);
  await failed;
  expect(child.kill).toHaveBeenCalledOnce();
  child.stdout.write('{"type":"ready"}\n');
  expect(child.stdin.read()).toBeNull();
});

it.skipIf(process.platform !== "win32")("keeps an accepted guardian alive when its confirmation is delayed", async () => {
  vi.useFakeTimers();
  const child = guardian();
  const outcome = startWindowsJobScope(nullLogger, 456);
  child.stdout.write('{"type":"ready"}\n');
  expect(String(child.stdin.read())).toBe("retain\n");
  const failed = expect(outcome).rejects.toThrow("setup timed out");
  await vi.advanceTimersByTimeAsync(8_000);
  await failed;
  expect(child.kill).not.toHaveBeenCalled();
  expect(child.stdout.destroyed).toBe(false);
  expect(child.unref).toHaveBeenCalledOnce();
});
