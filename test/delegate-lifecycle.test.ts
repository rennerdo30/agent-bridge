import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { killTree } from "../src/core/delegate.js";

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
