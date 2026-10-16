import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * AB-427: how native host answers map onto the existing identity contract, on every platform (Windows is
 * simulated). "" = running but its start time is unreadable (access denied): unknown, never a mismatch or gone.
 * No entry = not running. undefined = the host did not answer: the PowerShell probe decides, as before.
 */
const nativeAnswer = vi.hoisted(() => ({ value: undefined as Map<number, string> | undefined, calls: 0 }));
vi.mock("../src/core/windows-process-identity.js", () => ({
  readNativeIdentitiesSync: () => { nativeAnswer.calls++; return nativeAnswer.value; },
  readNativeIdentities: () => { nativeAnswer.calls++; return nativeAnswer.value && Promise.resolve(nativeAnswer.value); },
}));
const probes = vi.hoisted(() => ({ sync: vi.fn(), async: vi.fn() }));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...actual, execFileSync: probes.sync, execFile: Object.assign(vi.fn(), { [promisify.custom]: probes.async }) };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const PID = 2_000_427, OTHER = 2_000_428, TICKS = "638950000000000001";
let identity: typeof import("../src/core/process-identity.js");
beforeEach(async () => {
  vi.resetModules(); probes.sync.mockReset(); probes.async.mockReset();
  nativeAnswer.value = undefined; nativeAnswer.calls = 0;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
  identity = await import("../src/core/process-identity.js");
});
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); });

it("treats an access-denied native answer as unknown (alive), never as gone or a mismatch", async () => {
  nativeAnswer.value = new Map([[PID, ""]]);
  expect(identity.processIdentity(PID)).toBeUndefined();
  expect(identity.isProcessIdentityAlive(PID, TICKS)).toBeUndefined();
  expect(identity.recordedOwnerLiveness(PID, TICKS, Date.now())).toBeUndefined();
  expect(identity.recordedOwnerAlive(PID, TICKS, Date.now())).toBe(true);
  expect(identity.processStartMs(PID)).toBeUndefined();
  expect(await identity.readProcessIdentity(PID)).toBeNull();
  expect(identity.readProcessIdentitiesSync([PID])).toEqual(new Map([[PID, ""]]));
  expect(await identity.readProcessIdentities([PID])).toEqual(new Map());
  expect(probes.sync).not.toHaveBeenCalled(); expect(probes.async).not.toHaveBeenCalled();
});

it("maps a native batch: identity, absent and unreadable, in one request", async () => {
  nativeAnswer.value = new Map([[PID, TICKS], [OTHER, ""]]);
  expect(identity.readProcessIdentitiesSync([PID, OTHER, 2_000_429])).toEqual(new Map([[PID, TICKS], [OTHER, ""]]));
  expect(await identity.readProcessIdentities([PID, OTHER, 2_000_429])).toEqual(new Map([[PID, TICKS]]));
  expect(nativeAnswer.calls).toBe(2);
  expect(identity.isProcessIdentityAlive(PID, TICKS)).toBe(true);
  expect(identity.isProcessIdentityAlive(PID, "638950000000000002")).toBe(false);
  expect(probes.sync).not.toHaveBeenCalled(); expect(probes.async).not.toHaveBeenCalled();
});

it("falls back to the PowerShell probe when the host does not answer, and keeps its unknowns", async () => {
  probes.sync.mockImplementation(() => TICKS);
  probes.async.mockResolvedValue({ stdout: TICKS });
  expect(identity.processIdentity(PID)).toBe(TICKS);
  expect(await identity.readProcessIdentity(PID)).toBe(TICKS);
  expect(probes.sync).toHaveBeenCalledTimes(1); expect(probes.async).toHaveBeenCalledTimes(1);
  // The fallback keeps its full budget when the host was not tried (no time was spent on it).
  expect(probes.sync.mock.calls[0]![2]).toMatchObject({ timeout: 5_000 });
  probes.sync.mockImplementation(() => { throw new Error("SIMULATED probe timeout"); });
  expect(identity.processIdentity(OTHER)).toBeUndefined();
  expect(identity.readProcessIdentitiesSync([PID, OTHER])).toBeUndefined();
  probes.async.mockRejectedValue(new Error("SIMULATED batch timeout"));
  await expect(identity.readProcessIdentities([PID])).rejects.toMatchObject({ code: identity.IDENTITY_QUERY_FAILED });
});
