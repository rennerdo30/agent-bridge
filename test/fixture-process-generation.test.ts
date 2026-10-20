import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fixtureProcessExists, fixtureProcessGeneration, signalFixtureProcess, stopFixtureChild } from "./fixture-process-generation.js";

// Every query/signal in this file is injected; accidentally using a real OS boundary must fail.
vi.mock("../src/core/process-identity.js", () => ({
  readProcessIdentities: () => { throw new Error("Real fixture identity query forbidden"); },
  readProcessIdentity: () => { throw new Error("Real fixture identity query forbidden"); },
}));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("Real fixture signal forbidden"); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const pid = 12345, expected = "fixture-start", refusal = "Fixture generation changed; no signal sent";

it("continues initial ownership verification only when the OS presence probe succeeds", () => {
  const exists = vi.fn();
  expect(fixtureProcessExists(pid, refusal, exists)).toBe(true);
  expect(exists).toHaveBeenCalledExactlyOnceWith(pid);
});

it("recognizes an initially exited fixture only from ESRCH", () => {
  const exists = vi.fn(() => { throw Object.assign(new Error("exited"), { code: "ESRCH" }); });
  expect(fixtureProcessExists(pid, refusal, exists)).toBe(false);
  expect(exists).toHaveBeenCalledExactlyOnceWith(pid);
});

it.each(["EPERM", "EIO"])("refuses %s during the initial presence check without claiming exit", code => {
  const error = Object.assign(new Error("presence unavailable"), { code });
  const exists = vi.fn(() => { throw error; });
  expect(() => fixtureProcessExists(pid, refusal, exists)).toThrow(expect.objectContaining({ message: refusal, cause: error }));
});

it("accepts the exact owned creation identity without a termination or fallback probe", async () => {
  const identities = vi.fn().mockResolvedValue(new Map([[pid, expected]])), exists = vi.fn();
  expect(await fixtureProcessGeneration(pid, expected, refusal, { identities, exists })).toBe(true);
  expect(identities).toHaveBeenCalledWith([pid]);
  expect(exists).not.toHaveBeenCalled();
});

it.each([undefined, "replacement-start"])("accepts exit after a %s identity mismatch only with fresh ESRCH proof", async identity => {
  const identities = vi.fn().mockResolvedValue(new Map(identity ? [[pid, identity]] : []));
  const exists = vi.fn(() => { throw Object.assign(new Error("exited"), { code: "ESRCH" }); });
  expect(await fixtureProcessGeneration(pid, expected, refusal, { identities, exists })).toBe(false);
  expect(exists).toHaveBeenCalledExactlyOnceWith(pid);
});

it.each([undefined, "replacement-start"])("refuses an unknown or reused live PID (%s) without authorizing a signal", async identity => {
  const identities = vi.fn().mockResolvedValue(new Map(identity ? [[pid, identity]] : [])), exists = vi.fn();
  await expect(fixtureProcessGeneration(pid, expected, refusal, { identities, exists })).rejects.toThrow(refusal);
  expect(exists).toHaveBeenCalledExactlyOnceWith(pid);
});

it.each(["EPERM", "EIO"])("does not confuse a %s presence-probe failure with a dead process", async code => {
  const error = Object.assign(new Error("inspection unavailable"), { code });
  const identities = vi.fn().mockResolvedValue(new Map()), exists = vi.fn(() => { throw error; });
  await expect(fixtureProcessGeneration(pid, expected, refusal, { identities, exists })).rejects.toMatchObject({ message: refusal, cause: error });
});

it("propagates a failed creation query without authorizing a signal or inventing exit", async () => {
  const error = new Error("creation query unavailable");
  const identities = vi.fn().mockRejectedValue(error), exists = vi.fn();
  await expect(fixtureProcessGeneration(pid, expected, refusal, { identities, exists })).rejects.toBe(error);
  expect(exists).not.toHaveBeenCalled();
});

const osError = (code: string) => Object.assign(new Error(code), { code });
function daemonFixture(identities = new Map([[pid, expected]])) {
  return { identities: vi.fn().mockResolvedValue(identities), exists: vi.fn(), signal: vi.fn() };
}

it("tolerates exit between generation verification and signalling, then requires fresh exit proof", async () => {
  const probes = daemonFixture();
  probes.signal.mockImplementation(() => { throw osError("ESRCH"); });
  probes.exists.mockImplementation(() => { throw osError("ESRCH"); });
  const remembered = new Map([[pid, expected]]);
  await signalFixtureProcess(pid, expected, refusal, "SIGTERM", probes);
  // Same ordering as stopFixtureDaemon: a signal result cannot remove the remembered owner.
  expect(remembered.has(pid)).toBe(true);
  expect(fixtureProcessExists(pid, refusal, probes.exists)).toBe(false);
  remembered.delete(pid);
  expect(remembered.size).toBe(0);
  expect(probes.signal).toHaveBeenCalledExactlyOnceWith(pid, "SIGTERM");
  expect(probes.exists.mock.invocationCallOrder[0]).toBeGreaterThan(probes.signal.mock.invocationCallOrder[0]!);
});

it.each([undefined, "replacement-start"])("does not signal an unverifiable or reused daemon (%s)", async current => {
  const probes = daemonFixture(new Map(current ? [[pid, current]] : []));
  await expect(signalFixtureProcess(pid, expected, refusal, "SIGTERM", probes)).rejects.toThrow(refusal);
  expect(probes.signal).not.toHaveBeenCalled();
});

it("does not swallow ESRCH from a failed generation query", async () => {
  const probes = daemonFixture(), error = osError("ESRCH");
  probes.identities.mockRejectedValue(error);
  await expect(signalFixtureProcess(pid, expected, refusal, "SIGTERM", probes)).rejects.toBe(error);
  expect(probes.signal).not.toHaveBeenCalled(); expect(probes.exists).not.toHaveBeenCalled();
});

it.each(["EPERM", "EIO"])("retains the daemon when the verified signal fails with %s", async code => {
  const probes = daemonFixture(), error = osError(code), remembered = new Map([[pid, expected]]);
  probes.signal.mockImplementation(() => { throw error; });
  const stop = async () => {
    await signalFixtureProcess(pid, expected, refusal, "SIGTERM", probes);
    remembered.delete(pid);
  };
  await expect(stop()).rejects.toBe(error);
  expect(remembered.has(pid)).toBe(true); expect(probes.exists).not.toHaveBeenCalled();
});

it("a post-verification ESRCH does not replace the independent presence probe", async () => {
  const probes = daemonFixture(), remembered = new Map([[pid, expected]]);
  probes.signal.mockImplementation(() => { throw osError("ESRCH"); });
  await signalFixtureProcess(pid, expected, refusal, "SIGTERM", probes);
  expect(fixtureProcessExists(pid, refusal, probes.exists)).toBe(true);
  expect(remembered.has(pid)).toBe(true);
  probes.exists.mockImplementation(() => { throw osError("EPERM"); });
  expect(() => fixtureProcessExists(pid, refusal, probes.exists)).toThrow(refusal);
  expect(remembered.has(pid)).toBe(true);
});

function childFixture() {
  return Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null });
}
function childExit(child: ReturnType<typeof childFixture>) { child.exitCode = 0; child.emit("exit", 0, null); }
function observeCleanup(cleanup: Promise<void>) {
  const remove = vi.fn();
  let state = "pending", error: unknown;
  const done = cleanup.then(() => { state = "done"; remove(); }, reason => { state = "failed"; error = reason; });
  return { remove, done, state: () => state, error: () => error };
}

it("does not finish cleanup or remove data before the exact saved child exits", async () => {
  const child = childFixture(), other = childFixture();
  const probes = { identity: vi.fn().mockResolvedValue(expected), signal: vi.fn() };
  const observed = observeCleanup(stopFixtureChild(child, expected, refusal, probes));
  await vi.advanceTimersByTimeAsync(0);
  expect(probes.signal).toHaveBeenCalledExactlyOnceWith(pid, "SIGKILL");
  expect(observed.state()).toBe("pending"); expect(observed.remove).not.toHaveBeenCalled();
  child.emit("close", 0); childExit(other);
  await vi.advanceTimersByTimeAsync(0);
  expect(observed.remove).not.toHaveBeenCalled();
  childExit(child); await observed.done;
  expect(observed.remove).toHaveBeenCalledTimes(1);
  expect(child.listenerCount("exit")).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it("attaches the exit observer before a permitted signal can synchronously trigger exit", async () => {
  const child = childFixture(); let listenersAtSignal = 0;
  const probes = { identity: vi.fn().mockResolvedValue(expected), signal: vi.fn(() => {
    listenersAtSignal = child.listenerCount("exit"); childExit(child);
  }) };
  await stopFixtureChild(child, expected, refusal, probes);
  expect(listenersAtSignal).toBe(1); expect(child.listenerCount("exit")).toBe(0);
});

it("recognizes an already observed child exit without a new query or signal", async () => {
  const child = childFixture(); childExit(child);
  const probes = { identity: vi.fn().mockResolvedValue(expected), signal: vi.fn() };
  await stopFixtureChild(child, expected, refusal, probes);
  expect(probes.identity).not.toHaveBeenCalled(); expect(probes.signal).not.toHaveBeenCalled();
  expect(child.listenerCount("exit")).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it.each([null, "replacement-start"])("only waits passively for an unknown or changed child identity (%s)", async current => {
  const child = childFixture(), probes = { identity: vi.fn().mockResolvedValue(current), signal: vi.fn() };
  const observed = observeCleanup(stopFixtureChild(child, expected, refusal, probes));
  await vi.advanceTimersByTimeAsync(0);
  expect(probes.signal).not.toHaveBeenCalled(); expect(observed.remove).not.toHaveBeenCalled();
  childExit(child); await observed.done;
  expect(observed.remove).toHaveBeenCalledTimes(1);
});

it("a missing captured identity never signals and a cleanup deadline retains data", async () => {
  const child = childFixture(), probes = { identity: vi.fn(), signal: vi.fn() };
  const observed = observeCleanup(stopFixtureChild(child, null, refusal, probes));
  await vi.advanceTimersByTimeAsync(2_999);
  expect(observed.state()).toBe("pending"); expect(observed.remove).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await observed.done;
  expect(observed.state()).toBe("failed"); expect(observed.error()).toMatchObject({ message: expect.stringContaining(refusal) });
  expect(probes.signal).not.toHaveBeenCalled(); expect(probes.identity).not.toHaveBeenCalled();
  expect(observed.remove).not.toHaveBeenCalled(); expect(child.listenerCount("exit")).toBe(0);
});

it("a cleanup deadline cannot authorize a late verified signal", async () => {
  const child = childFixture(); let verified!: (value: string) => void;
  const probes = { identity: vi.fn(() => new Promise<string>(resolve => { verified = resolve; })), signal: vi.fn() };
  const observed = observeCleanup(stopFixtureChild(child, expected, refusal, probes));
  await vi.advanceTimersByTimeAsync(3_000);
  expect(observed.state()).toBe("failed"); expect(observed.remove).not.toHaveBeenCalled();
  verified(expected); await vi.advanceTimersByTimeAsync(0);
  expect(probes.signal).not.toHaveBeenCalled(); expect(child.listenerCount("exit")).toBe(0);
});

it("a child signal ESRCH still waits for the saved ChildProcess exit event", async () => {
  const child = childFixture(), probes = { identity: vi.fn().mockResolvedValue(expected), signal: vi.fn(() => { throw osError("ESRCH"); }) };
  const observed = observeCleanup(stopFixtureChild(child, expected, refusal, probes));
  await vi.advanceTimersByTimeAsync(0);
  expect(observed.state()).toBe("pending"); expect(observed.remove).not.toHaveBeenCalled();
  childExit(child); await observed.done;
  expect(observed.remove).toHaveBeenCalledTimes(1);
});

it.each(["EPERM", "EIO"])("a child signal %s failure retains data and propagates", async code => {
  const child = childFixture(), error = osError(code);
  const probes = { identity: vi.fn().mockResolvedValue(expected), signal: vi.fn(() => { throw error; }) };
  const observed = observeCleanup(stopFixtureChild(child, expected, refusal, probes));
  await observed.done;
  expect(observed.error()).toBe(error); expect(observed.remove).not.toHaveBeenCalled();
  expect(child.listenerCount("exit")).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it("a child exit during a failed identity query does not turn that query error into success", async () => {
  const child = childFixture(), error = osError("ESRCH"); let failed!: (error: Error) => void;
  const probes = { identity: vi.fn(() => new Promise<string>((_, reject) => { failed = reject; })), signal: vi.fn() };
  const observed = observeCleanup(stopFixtureChild(child, expected, refusal, probes));
  childExit(child); failed(error); await observed.done;
  expect(observed.error()).toBe(error); expect(observed.remove).not.toHaveBeenCalled(); expect(probes.signal).not.toHaveBeenCalled();
  expect(child.listenerCount("exit")).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
