import { expect, it, vi } from "vitest";
import { fixtureProcessExists, fixtureProcessGeneration } from "./fixture-process-generation.js";

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
