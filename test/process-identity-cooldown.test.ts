import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// This file drives the PowerShell probe (the fallback path); the native host (AB-427) must not answer instead.
vi.mock("../src/core/windows-process-identity.js", () => ({ readNativeIdentities: () => undefined, readNativeIdentitiesSync: () => undefined }));
const probes = vi.hoisted(() => ({ sync: vi.fn(), async: vi.fn() }));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return { ...actual, execFileSync: probes.sync,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: probes.async }) };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let home: string | undefined;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.useRealTimers(); vi.restoreAllMocks();
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

async function fixture() {
  vi.resetModules(); probes.sync.mockReset(); probes.async.mockReset();
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(0);
  home = mkdtempSync(join(tmpdir(), "ab-identity-cooldown-"));
  const identity = await import("../src/core/process-identity.js");
  const lease = await import("../src/core/metadata-file-lease.js");
  const peers = await import("../src/core/store-compatibility.js");
  return { ...identity, ...lease, ...peers };
}

it("does not repeat a slow failed own-PID probe for metadata leases and peer writes", async () => {
  const { metadataFileLease, recordStorePeer, processIdentity } = await fixture();
  probes.sync.mockImplementation(() => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
    throw new Error("simulated slow native identity probe failure");
  });
  probes.async.mockResolvedValue({ stdout: "" });
  const leasePath = join(home!, "migration.lock");
  const first = performance.now();
  expect(() => metadataFileLease(leasePath)).toThrowError(expect.objectContaining({ code: "ELEASEBUSY" }));
  const coldMs = performance.now() - first, began = performance.now();
  for (let i = 0; i < 10; i++) {
    expect(() => metadataFileLease(leasePath)).toThrowError(expect.objectContaining({ code: "ELEASEBUSY" }));
    recordStorePeer(home!, { pid: process.pid, name: "fixture", version: "0.30.21",
      storeCapabilities: { json: 4, sqlite: 9, jobArchive: 1 } }, { authoritative: true });
    expect(processIdentity(process.pid)).toBeUndefined();
  }
  console.info("failed own identity lease/peer probe", { coldMs, repeatedMs: performance.now() - began });
  expect(probes.sync).toHaveBeenCalledTimes(1);
  expect(probes.async).toHaveBeenCalledTimes(1);
  await new Promise<void>(resolve => setImmediate(resolve));
});

it("coalesces immediate refresh, retains unknown on failure, and picks up a later verified success", async () => {
  const { processIdentity, metadataFileLease } = await fixture();
  probes.sync.mockImplementation(() => { throw new Error("native query timed out"); });
  let complete!: (result: { stdout: string }) => void;
  probes.async.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  expect(processIdentity(process.pid)).toBeUndefined();
  expect(probes.async).toHaveBeenCalledTimes(1);
  vi.setSystemTime(1_000);
  for (let i = 0; i < 10; i++) expect(processIdentity(process.pid)).toBeUndefined();
  expect(probes.async).toHaveBeenCalledTimes(1);
  complete({ stdout: "" });
  // Drain the read/refresh promise chain without advancing the cooldown.
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(() => metadataFileLease(join(home!, "still-unknown.lock"))).toThrowError(expect.objectContaining({ code: "ELEASEBUSY" }));
  vi.setSystemTime(2_000);
  expect(processIdentity(process.pid)).toBeUndefined();
  expect(probes.async).toHaveBeenCalledTimes(2);
  complete({ stdout: "verified-own-birth" });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(processIdentity(process.pid)).toBe("verified-own-birth");
  expect(probes.sync).toHaveBeenCalledTimes(1);
  const release = metadataFileLease(join(home!, "verified.lock")); release();
});

it("refreshes after a failed sync probe without another caller initiating recovery", async () => {
  const { processIdentity, metadataFileLease } = await fixture();
  probes.sync.mockImplementation(() => { throw new Error("native query timed out"); });
  let complete!: (result: { stdout: string }) => void;
  probes.async.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  expect(processIdentity(process.pid)).toBeUndefined();
  expect(probes.async).toHaveBeenCalledTimes(1);
  complete({ stdout: "verified-own-birth" });
  await new Promise<void>(resolve => setImmediate(resolve));
  // No caller ran after the failure to trigger a refresh, and the cooldown
  // has not elapsed. The next one-shot acquisition already has its identity.
  expect(processIdentity(process.pid)).toBe("verified-own-birth");
  const release = metadataFileLease(join(home!, "one-shot.lock")); release();
  expect(probes.sync).toHaveBeenCalledTimes(1);
  expect(probes.async).toHaveBeenCalledTimes(1);
});
