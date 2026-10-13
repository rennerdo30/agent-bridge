import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { DelegateError, type DelegateRequest, type DelegateResult } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import { ResourceSlots } from "../src/core/resource-slots.js";
import { STARTUP_CAPACITY, STARTUP_RESOURCE } from "../src/core/startup-admission.js";
import { runDelegate, type RunContext } from "../src/mcp/delegate-run.js";
import { DELEGATION_TARGETS } from "../src/mcp/targets.js";
import { until } from "./helpers.js";

const preparation = vi.hoisted(() => ({ calls: 0, wait: Promise.resolve() as Promise<void> }));
vi.mock("../src/core/runfeed.js", async original => {
  const actual = await original<typeof import("../src/core/runfeed.js")>();
  return { ...actual, startRunFeedReady: async (...args: Parameters<typeof actual.startRunFeedReady>) => {
    preparation.calls++;
    const signal = args[1];
    let abort: (() => void) | undefined;
    try {
      await Promise.race([preparation.wait, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
      return await actual.startRunFeedReady(...args);
    } finally { if (abort) signal.removeEventListener("abort", abort); }
  } };
});

let home: string, slots: ResourceSlots;
const controllers: AbortController[] = [], runs: Promise<unknown>[] = [];
beforeEach(() => {
  mkdirSync(tmpdir(), { recursive: true });
  home = mkdtempSync(join(tmpdir(), "delegate-native-startup-"));
  slots = new ResourceSlots(home);
  preparation.calls = 0;
  preparation.wait = Promise.resolve();
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort(new Error("Synthetic fixture teardown"));
  await Promise.allSettled(runs.splice(0));
  slots.close();
  vi.restoreAllMocks();
  // Retain generated context and failed-test evidence; no source or live data is removed.
});
function start(index = 0, controller = new AbortController()) {
  controllers.push(controller);
  const context: RunContext = { agent: "claude", cfg: { ...DEFAULT_CONFIG }, home, log: nullLogger,
    me: () => "synthetic-supervisor", cwd: () => home };
  const result = runDelegate(context, "codex", { title: `Synthetic ${index}`, prompt: `Exact context ${index}`, access: "read" }, controller.signal, undefined, true);
  void result.catch(() => {}); runs.push(result);
  return { controller, result };
}
function startupSlots() { return slots.list().filter(slot => slot.resource === STARTUP_RESOURCE); }
function leases() { const dir = join(home, ".storage-users"); return existsSync(dir) ? readdirSync(dir) : []; }
function logs() { return readdirSync(join(home, "runs")).filter(name => name.endsWith(".log")).map(name => readFileSync(join(home, "runs", name), "utf8")); }
const completed = (sessionId: string): DelegateResult => ({ sessionId, text: "Synthetic complete", isError: false, details: {} });

it("prepares delayed context without occupying native startup admission", async () => {
  preparation.wait = new Promise<void>(() => {});
  const native = vi.spyOn(DELEGATION_TARGETS.codex, "run");
  for (let index = 0; index < 6; index++) start(index);
  await until(() => preparation.calls >= 2);
  expect(startupSlots()).toEqual([]);
  expect(preparation.calls).toBe(6);
  expect(native).not.toHaveBeenCalled();
  expect(leases()).toEqual([]);
});

it("rejects an already cancelled turn before preparing or publishing any context", async () => {
  const native = vi.spyOn(DELEGATION_TARGETS.codex, "run");
  const controller = new AbortController();
  controller.abort(new Error("Synthetic early cancellation"));
  await expect(start(8, controller).result).rejects.toThrow("Synthetic early cancellation");
  expect(preparation.calls).toBe(0);
  expect(native).not.toHaveBeenCalled();
  expect(startupSlots()).toEqual([]);
  expect(existsSync(join(home, "runs"))).toBe(false);
  expect(leases()).toEqual([]);
});

it("bounds native handshakes and releases admission on session readiness before turn completion", async () => {
  const requests: DelegateRequest[] = [], finish: (() => void)[] = [];
  vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, request) => {
    requests.push(request);
    return await new Promise<DelegateResult>((resolve, reject) => {
      const abort = () => reject(request.signal?.reason);
      request.signal?.addEventListener("abort", abort, { once: true });
      finish.push(() => { request.signal?.removeEventListener("abort", abort); resolve(completed(`session-${requests.indexOf(request)}`)); });
    });
  });
  const results = Array.from({ length: 6 }, (_, index) => start(index).result);
  await until(() => requests.length === STARTUP_CAPACITY);
  expect(startupSlots().filter(slot => slot.held)).toHaveLength(STARTUP_CAPACITY);
  expect(preparation.calls).toBe(6);
  let settled = 0; for (const result of results) void result.then(() => settled++, () => {});
  for (let index = 0; index < 6; index++) {
    await until(() => requests.length > index);
    expect(startupSlots().filter(slot => slot.held).length).toBeLessThanOrEqual(STARTUP_CAPACITY);
    requests[index]!.onSession?.(`session-${index}`);
    if (index < 4) await until(() => requests.length >= index + 3);
    expect(settled).toBe(0);
  }
  expect(startupSlots()).toEqual([]);
  for (const complete of finish) complete();
  await Promise.all(results);
  expect(leases()).toEqual([]);
  expect(logs()).toHaveLength(6);
  expect(logs().every(log => log.includes("Exact context") && log.includes("Synthetic complete"))).toBe(true);
});

it("cancels a prepared turn waiting for native admission without launching or losing context", async () => {
  const owners = Array.from({ length: STARTUP_CAPACITY }, (_, index) => ({ id: `synthetic-held-${index}`, pid: process.pid }));
  for (const owner of owners) expect(slots.tryAcquire(STARTUP_RESOURCE, STARTUP_CAPACITY, owner)).toBe(true);
  const native = vi.spyOn(DELEGATION_TARGETS.codex, "run");
  const run = start(7);
  await until(() => startupSlots().length === STARTUP_CAPACITY + 1);
  expect(leases()).toHaveLength(1);
  const reason = new Error("Synthetic admission cancellation");
  run.controller.abort(reason);
  await expect(run.result).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR", cause: reason });
  expect(native).not.toHaveBeenCalled();
  expect(startupSlots()).toHaveLength(STARTUP_CAPACITY);
  expect(leases()).toEqual([]);
  expect(logs()[0]).toContain("Exact context 7");
  // A turn cancelled through its job controller is recorded as cancelled, never as a failure.
  expect(logs()[0]).toMatch(/finished after \d+s · cancelled\n$/);
  expect(logs()[0]).not.toContain("failed");
  for (const owner of owners) slots.release(owner, STARTUP_RESOURCE);
});

it("releases native admission and the prepared feed if the handshake fails before a session", async () => {
  vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async () => {
    expect(startupSlots().filter(slot => slot.held)).toHaveLength(1);
    throw new DelegateError("Synthetic handshake failure", "failed");
  });
  await expect(start(9).result).rejects.toThrow("Synthetic handshake failure");
  expect(startupSlots()).toEqual([]);
  expect(leases()).toEqual([]);
  expect(logs()[0]).toContain("Exact context 9");
  expect(logs()[0]).toContain("failed: Synthetic handshake failure");
});

it("admits a post-session retry with a fresh permit that an old callback cannot release", async () => {
  const permits: string[] = [];
  let oldSession: DelegateRequest["onSession"], attempts = 0;
  vi.spyOn(DELEGATION_TARGETS.codex, "run").mockImplementation(async (_cfg, request) => {
    const held = startupSlots().filter(slot => slot.held);
    expect(held).toHaveLength(1);
    permits.push(held[0]!.id);
    if (++attempts === 1) {
      oldSession = request.onSession;
      request.onSession?.("same-native-session");
      expect(startupSlots()).toEqual([]);
      throw new DelegateError("connection reset", "failed");
    }
    expect(request.sessionId).toBe("same-native-session");
    oldSession?.("same-native-session");
    expect(startupSlots().filter(slot => slot.held).map(slot => slot.id)).toEqual([held[0]!.id]);
    request.onSession?.("same-native-session");
    return completed("same-native-session");
  });
  expect((await start(10).result).sessionId).toBe("same-native-session");
  expect(attempts).toBe(2);
  expect(new Set(permits).size).toBe(2);
  expect(preparation.calls).toBe(1);
  expect(startupSlots()).toEqual([]);
  expect(leases()).toEqual([]);
  expect(logs()[0]).toContain("Exact context 10");
});
