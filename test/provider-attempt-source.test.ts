import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProcess } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import { jobEnvironment } from "../src/core/job-environment.js";
import { createProviderAttemptSource, lookupProviderAttempt, MAX_PROVIDER_ATTEMPT_OBSERVATIONS,
  type ProviderAttemptKey, type ProviderAttemptObservation } from "../src/core/provider-attempt-source.js";

// Future hosted fixtures ONLY: real local Node children are separate from explicitly mocked faults.
// No model/provider/account calls, timing sleeps, process identity probes or descendant proof.
const base = () => ({ bin: process.execPath, args: ["-e", "process.stdin.resume();"], stdin: "accepted input",
  cwd: process.cwd(), timeoutMs: 10_000, env: process.env, log: nullLogger });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const simulatedChildren: ChildProcess[] = [];
afterEach(() => {
  // Mock children have no PID; emitting exit only releases runProcess's existing local membership.
  for (const child of simulatedChildren.splice(0)) child.emit("exit", 0, null);
  vi.useRealTimers(); vi.doUnmock("node:child_process"); vi.resetModules(); vi.restoreAllMocks();
});

describe("real source-owned child capture (hosted Node fixture, never a provider)", () => {
  it("keeps default-off outcome, stdio and line behavior, and captures an opt-in child without settlement authority", async () => {
    const args = ["-e", "process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('one\\ntwo\\n'); process.stderr.write('retained error tail'); process.exitCode=3; });"];
    const originalLines: string[] = [], observedLines: string[] = [];
    const original = await runProcess({ ...base(), args, onLine: line => originalLines.push(line) });
    expect(original).toEqual({ code: 3, signal: null, stdout: "one\ntwo\n", stderr: "retained error tail" });
    expect(original).not.toHaveProperty("providerAttemptKey");
    const observations: ProviderAttemptObservation[] = [];
    const observed = await runProcess({ ...base(), args, onLine: line => observedLines.push(line),
      onAttemptObservation: snapshot => observations.push(snapshot) });
    await flush();
    const { providerAttemptKey, ...outcome } = observed;
    expect(outcome).toEqual(original);
    expect(observedLines).toEqual(originalLines);
    expect(originalLines).toEqual(["one", "two"]);
    expect(observations[0]).toMatchObject({ phase: "attempt_recorded", childMembership: "unknown", listenerMembership: "unknown", pid: null });
    expect(observations.some(view => view.phase === "child_returned" && view.childMembership === "source_returned" && view.listenerMembership === "source_recorded")).toBe(true);
    expect(observations.some(view => view.spawnObserved && view.pid !== null)).toBe(true);
    expect(observations.at(-1)).toMatchObject({ phase: "close_observed", directCloseObserved: true, closeCode: 3 });
    expect(lookupProviderAttempt(providerAttemptKey)).toMatchObject({ type: "held", reason: "source_facts_unsupported",
      observation: { creationIdentity: null, sessionId: null, nativeTurnId: null, effectiveModel: null, descendants: "unknown", ownership: "unsupported" } });
    // No child, key, argument, output content, raw receipt or authority escapes through a callback.
    for (const view of observations) {
      expect(Object.isFrozen(view)).toBe(true);
      expect(Object.values(view).every(value => value === null || ["string", "number", "boolean"].includes(typeof value))).toBe(true);
      expect(JSON.stringify(view)).not.toMatch(/accepted input|retained error tail|providerAttemptKey|permit|token/);
      expect(lookupProviderAttempt(view)).toEqual({ type: "held", reason: "unregistered_key", observation: null });
    }
    expect(lookupProviderAttempt({ ...providerAttemptKey })).toEqual({ type: "held", reason: "unregistered_key", observation: null });
    expect(lookupProviderAttempt(structuredClone(providerAttemptKey))).toEqual({ type: "held", reason: "unregistered_key", observation: null });
  });

  it("swallows synchronous and asynchronous observer faults without changing the original child outcome", async () => {
    const observer = vi.fn((snapshot: ProviderAttemptObservation) => {
      if (snapshot.phase === "child_returned") return Promise.reject(new Error("explicit observer rejection"));
      throw new Error("explicit observer throw");
    });
    const result = await runProcess({ ...base(), args: ["-e", "process.stdin.resume();"], onAttemptObservation: observer });
    await flush();
    expect(result).toMatchObject({ code: 0, signal: null, stdout: "", stderr: "" });
    expect(observer).toHaveBeenCalled();
    expect(lookupProviderAttempt(result.providerAttemptKey)).toMatchObject({ type: "held", observation: { directCloseObserved: true, descendants: "unknown" } });
  });

  it("refuses DTO/cast/clone/proxy keys without reading their alleged evidence", () => {
    const refused = { type: "held", reason: "unregistered_key", observation: null };
    for (const fake of [null, 12, "key", {}, { settled: true, pid: process.pid, creationIdentity: "forged", descendantsSettled: true } as unknown as ProviderAttemptKey]) {
      expect(lookupProviderAttempt(fake)).toEqual(refused);
    }
    const hostile = new Proxy({}, { get() { throw new Error("caller property must not be read"); } });
    expect(lookupProviderAttempt(hostile)).toEqual(refused);
  });

  it("records an actual Node synchronous spawn rejection as unreturned, never as a returned child", async () => {
    const observations: ProviderAttemptObservation[] = [];
    const source = createProviderAttemptSource(view => observations.push(view));
    expect(lookupProviderAttempt(source.key)).toMatchObject({ type: "held", reason: "child_unreturned" });
    // Node rejects the empty command synchronously; no process is launched by this fixture.
    expect(() => source.spawn("", [], { stdio: ["pipe", "pipe", "pipe"] })).toThrow();
    await flush();
    expect(observations.map(view => view.phase)).toEqual(["attempt_recorded", "spawn_unreturned"]);
    expect(lookupProviderAttempt(source.key)).toMatchObject({ type: "held", reason: "spawn_unreturned", observation: { childMembership: "unknown", listenerMembership: "unknown", pid: null, directCloseObserved: false } });
  });

  it("preserves resolution failure before spawn and does not invent a child record", async () => {
    const observations: ProviderAttemptObservation[] = [];
    await expect(runProcess({ ...base(), bin: "agent-bridge-intentionally-missing-capture-fixture-74f3", env: { PATH: "", PATHEXT: ".EXE" },
      onAttemptObservation: view => observations.push(view) })).rejects.toMatchObject({ kind: "not_found" });
    await flush();
    expect(observations.map(view => view.phase)).toEqual(["attempt_recorded", "spawn_unreturned"]);
    expect(observations.every(view => view.childMembership === "unknown" && view.pid === null && !view.directCloseObserved)).toBe(true);
  });
});

/** Explicit simulation, NOT a real native child or process-generation witness. */
function simulatedChild() {
  const child = new ChildProcess();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: 0 });
  expect(child.pid).toBeUndefined();
  simulatedChildren.push(child);
  return child;
}

async function faultModules(spawn: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn }));
  const delegate = await import("../src/core/delegate.js");
  const source = await import("../src/core/provider-attempt-source.js");
  return { delegate, source };
}

describe("explicit simulated faults/order, not native settlement evidence", () => {
  it("retains original spawn options, stdin/onLine/error/close ordering and nonzero exit behavior", async () => {
    const child = simulatedChild(), order: string[] = [];
    const spawn = vi.fn(() => { order.push("spawn-return"); return child; });
    const { delegate, source } = await faultModules(spawn);
    Object.defineProperty(child.stdin!, "end", { value: (input: string) => {
      order.push("stdin-end");
      expect(child.listenerCount("error")).toBe(2);
      expect(child.listenerCount("close")).toBe(2);
      child.stdin!.write(input);
      return child.stdin;
    } });
    const env = { PATH: "", CAPTURE_TEST_INPUT: "unchanged" };
    const result = delegate.runProcess({ ...base(), env, onLine: line => { order.push(`line:${line}`); throw new Error("progress throw stays swallowed"); },
      onAttemptObservation: view => { order.push(`observer:${view.phase}`); } });
    expect(order).toEqual(["spawn-return", "stdin-end"]);
    expect(spawn).toHaveBeenCalledWith(process.execPath, base().args, { cwd: process.cwd(), env: { ...jobEnvironment(env), PWD: process.cwd() },
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    expect(child.stdin!.read()?.toString()).toBe("accepted input");
    child.stdout!.emit("data", "one\ntwo\n"); child.stderr!.emit("data", "old stderr");
    child.stdin!.emit("error", new Error("old ignored stdin error"));
    child.emit("close", 7, null);
    expect(order.slice(0, 4)).toEqual(["spawn-return", "stdin-end", "line:one", "line:two"]);
    expect(order.some(value => value.startsWith("observer:"))).toBe(false);
    expect(await result).toMatchObject({ code: 7, signal: null, stdout: "one\ntwo\n", stderr: "old stderr" });
    expect(source.lookupProviderAttempt((await result).providerAttemptKey)).toMatchObject({ type: "held", observation: { directCloseObserved: true, descendants: "unknown" } });
  });

  it.each(["timeout", "abort"] as const)("observes delayed close AFTER original %s rejection despite fulfilled killTree", async failure => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const child = simulatedChild(), spawn = vi.fn(() => child), controller = new AbortController();
    const { delegate } = await faultModules(spawn);
    const observations: ProviderAttemptObservation[] = [];
    let rejected = false;
    const result = delegate.runProcess({ ...base(), timeoutMs: 50, signal: controller.signal,
      onAttemptObservation: view => observations.push(view) }).catch(error => { rejected = true; return error; });
    if (failure === "abort") controller.abort(); else {
      await vi.advanceTimersByTimeAsync(49);
      expect(rejected).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(await result).toMatchObject({ kind: failure === "abort" ? "aborted" : "timeout", name: "DelegateError" });
    expect(vi.getTimerCount()).toBe(0);
    await flush();
    expect(observations.some(view => view.directCloseObserved)).toBe(false);
    // Mock has no PID and exitCode0: existing killTree fulfills WITHOUT proving close/descendants.
    await delegate.killTree(child, "explicit simulated fulfilled cleanup");
    expect(observations.some(view => view.directCloseObserved)).toBe(false);
    child.emit("close", 0, null);
    await flush();
    expect(observations.at(-1)).toMatchObject({ phase: "close_observed", directCloseObserved: true, descendants: "unknown", creationIdentity: null });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(await result).toMatchObject({ kind: failure === "abort" ? "aborted" : "timeout" });
  });

  it("preserves the original async error and captures later close independently of finish", async () => {
    const child = simulatedChild(), spawn = vi.fn(() => child);
    const { delegate } = await faultModules(spawn);
    const observations: ProviderAttemptObservation[] = [];
    const result = delegate.runProcess({ ...base(), onAttemptObservation: view => observations.push(view) }).catch(error => error);
    child.emit("error", new Error("original launch failure"));
    expect(await result).toMatchObject({ kind: "failed", message: `failed to start ${process.execPath}: original launch failure` });
    child.emit("close", null, null); await flush();
    expect(observations.at(-1)).toMatchObject({ directCloseObserved: true, errorObserved: true, descendants: "unknown" });
  });

  it("rethrows an explicit simulated synchronous spawn fault without changing the error object", async () => {
    const failure = new Error("explicit simulated spawn throw"), spawn = vi.fn(() => { throw failure; });
    const { delegate } = await faultModules(spawn);
    const observations: ProviderAttemptObservation[] = [];
    const result = await delegate.runProcess({ ...base(), onAttemptObservation: view => observations.push(view) }).catch(error => error);
    expect(result).toBe(failure); await flush();
    expect(observations.at(-1)).toMatchObject({ phase: "spawn_unreturned", pid: null, childMembership: "unknown", descendants: "unknown" });
  });

  it("bounds notifications while retaining overflow child membership and later close evidence", async () => {
    const child = simulatedChild(), spawn = vi.fn(() => child);
    const { source } = await faultModules(spawn);
    const observations: ProviderAttemptObservation[] = [];
    const attempt = source.createProviderAttemptSource(view => observations.push(view));
    expect(attempt.spawn(process.execPath, [], { stdio: ["pipe", "pipe", "pipe"] })).toBe(child);
    for (let i = 0; i < 40; i++) child.emit("error", new Error("explicit repeated simulated fault"));
    child.emit("close", 0, null); await flush();
    expect(observations).toHaveLength(MAX_PROVIDER_ATTEMPT_OBSERVATIONS);
    expect(observations.at(-1)?.observationOverflow).toBe(true);
    expect(source.lookupProviderAttempt(attempt.key)).toMatchObject({ type: "held", reason: "source_facts_unsupported",
      observation: { childMembership: "source_returned", directCloseObserved: true, observationOverflow: true, descendants: "unknown" } });
    attempt.noteUnreturned();
    expect(source.lookupProviderAttempt(attempt.key)).toMatchObject({ observation: { childMembership: "source_returned", directCloseObserved: true } });
    expect(() => attempt.spawn(process.execPath, [], { stdio: ["pipe", "pipe", "pipe"] })).toThrow("already invoked");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does not register capture listeners or expose a key for an unrelated default-off call", async () => {
    const child = simulatedChild(), spawn = vi.fn(() => child);
    const { delegate } = await faultModules(spawn);
    const result = delegate.runProcess(base());
    expect(child.listenerCount("spawn")).toBe(0);
    expect(child.listenerCount("error")).toBe(1);
    expect(child.listenerCount("close")).toBe(1);
    child.emit("close", 0, null);
    expect(await result).toEqual({ code: 0, signal: null, stdout: "", stderr: "" });
  });

  it("does not turn caller-requested identity/session/turn/model fields into source facts", async () => {
    const child = simulatedChild(), spawn = vi.fn(() => child);
    const { delegate, source } = await faultModules(spawn);
    const requested = { sessionId: "requested-session", model: "requested-model", nativeTurnId: "requested-turn",
      creationIdentity: "forged-pid-time", descendantsSettled: true, settled: true };
    const observations: ProviderAttemptObservation[] = [];
    const result = delegate.runProcess({ ...base(), ...requested, onAttemptObservation: view => observations.push(view) });
    child.emit("close", 0, null);
    const outcome = await result; await flush();
    expect(source.lookupProviderAttempt(outcome.providerAttemptKey)).toMatchObject({ type: "held", observation: {
      creationIdentity: null, sessionId: null, nativeTurnId: null, effectiveModel: null, descendants: "unknown", ownership: "unsupported" } });
    expect(JSON.stringify(observations)).not.toMatch(/requested-session|requested-model|requested-turn|forged-pid-time|descendantsSettled/);
  });
});
