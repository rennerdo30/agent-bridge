import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { killTree, trackChild } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: mocks.spawn,
}));
afterEach(() => vi.restoreAllMocks());

it("waits for the delegate to close after its termination command completes", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null, kill: vi.fn() });
  const taskkill = new EventEmitter();
  mocks.spawn.mockReturnValue(taskkill);
  vi.spyOn(process, "kill").mockReturnValue(true);
  let finished = false;
  const stopped = killTree(child as unknown as ChildProcess).then(() => { finished = true; });

  if (process.platform === "win32") taskkill.emit("close", 0);
  else child.emit("exit", 0);
  await Promise.resolve();
  await Promise.resolve();
  expect(finished).toBe(false);

  child.emit("close", 0);
  await stopped;
  expect(finished).toBe(true);
});

it("records the owned root and reason and targets only that process tree", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 23456, exitCode: null, signalCode: null, kill: vi.fn() });
  const sibling = Object.assign(new EventEmitter(), { pid: 34567, exitCode: null, signalCode: null, kill: vi.fn() });
  const info = vi.fn();
  const taskkill = new EventEmitter();
  mocks.spawn.mockReturnValue(taskkill);
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  trackChild(child as unknown as ChildProcess, { ...nullLogger, info });
  trackChild(sibling as unknown as ChildProcess, { ...nullLogger, info });
  const stopped = killTree(child as unknown as ChildProcess, "delegate time limit");
  expect(info).toHaveBeenCalledWith("stopping delegate process tree", expect.objectContaining({ pid: 23456, reason: "delegate time limit" }));
  expect(info).not.toHaveBeenCalledWith("stopping delegate process tree", expect.objectContaining({ pid: 34567 }));
  if (process.platform === "win32") {
    expect(mocks.spawn).toHaveBeenLastCalledWith("taskkill", ["/PID", "23456", "/T", "/F"], expect.any(Object));
    taskkill.emit("close", 0);
  } else {
    expect(signal).toHaveBeenCalledWith(-23456, "SIGTERM");
    expect(signal).not.toHaveBeenCalledWith(-34567, expect.anything());
  }
  child.emit("exit", 0);
  child.emit("close", 0);
  sibling.emit("exit", 0);
  await stopped;
  expect(sibling.kill).not.toHaveBeenCalled();
});

it.each([{ exitCode: 0, signalCode: null }, { exitCode: null, signalCode: "SIGTERM" }])("does not target a finished child PID again (%j)", async (state) => {
  const child = Object.assign(new EventEmitter(), { pid: 23456, ...state, kill: vi.fn() });
  mocks.spawn.mockClear();
  const signal = vi.spyOn(process, "kill").mockReturnValue(true);
  await killTree(child as unknown as ChildProcess);
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(signal).not.toHaveBeenCalled();
  expect(child.kill).not.toHaveBeenCalled();
});
