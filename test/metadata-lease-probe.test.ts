import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// AB-220: waiting on a live owner must not run a (synchronous, PowerShell on Windows) identity probe per retry.
const probes = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/core/process-identity.js", async (original) => {
  const actual = await original<typeof import("../src/core/process-identity.js")>();
  return { ...actual, isProcessIdentityAlive: (pid: number, identity: string) => { probes.count++; return actual.isProcessIdentityAlive(pid, identity); } };
});
const { metadataFileLease } = await import("../src/core/metadata-file-lease.js");

it("probes a live owner's identity once while waiting, not on every 20 ms retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-lease-probe-"));
  const path = join(dir, "jobs.json");
  const release = metadataFileLease(path);
  try {
    probes.count = 0;
    expect(() => metadataFileLease(path, 600)).toThrow(/live or unknown owner/);
    expect(probes.count).toBeLessThanOrEqual(1);
  } finally { release(); rmSync(dir, { recursive: true, force: true }); }
});
