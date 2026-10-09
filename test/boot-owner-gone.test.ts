import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// AB-256: owners whose liveness is unknown (EPERM, an unreadable start time) are gone only when their record or
// heartbeat predates the current boot. A recent unknown owner is still refused everywhere.
const ghosts = vi.hoisted(() => ({ eperm: 2_000_001, zombie: 2_000_003, up: 600 }));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, uptime: () => ghosts.up };
});
vi.mock("../src/core/process-identity.js", async (original) => {
  const actual = await original<typeof import("../src/core/process-identity.js")>();
  const ghost = (pid: number) => pid === ghosts.eperm || pid === ghosts.zombie;
  return {
    ...actual,
    processIdentity: (pid: number) => ghost(pid) ? undefined : actual.processIdentity(pid),
    processStartMs: (pid: number) => ghost(pid) ? undefined : actual.processStartMs(pid),
    isProcessIdentityAlive: (pid: number, identity: string) => ghost(pid) ? undefined : actual.isProcessIdentityAlive(pid, identity),
    recordedOwnerLiveness: (pid: number, identity: string | undefined, at: number) => ghost(pid) ? undefined : actual.recordedOwnerLiveness(pid, identity, at),
  };
});

const { ownerGone, writtenBeforeBoot } = await import("../src/core/boot-time.js");
const { runnerProcessAlive, JobRunners } = await import("../src/mcp/job-host.js");
const { legacyStorePeers, liveStorePeers, refreshStorePeerIdentities } = await import("../src/core/store-compatibility.js");
const { metadataDb, saveMetadataValue } = await import("../src/core/metadata-db.js");
const { importMetadataDomain } = await import("../src/core/metadata-import.js");
const { migrationLock } = await import("../src/core/migration-lock.js");
const { maintenanceLock, storageLease } = await import("../src/core/storage-lock.js");
const { metadataFileLease } = await import("../src/core/metadata-file-lease.js");
const { ResourceSlots, SLOT_LEASE_MS } = await import("../src/core/resource-slots.js");
const { processStartMs } = await import("../src/core/process-identity.js");
const { makeEnv } = await import("./helpers.js");

let env: Awaited<ReturnType<typeof makeEnv>>;
const realKill = process.kill.bind(process);
beforeEach(() => {
  ghosts.up = 600;
  env = makeEnv();
  vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
    if (pid === ghosts.eperm) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    if (pid === ghosts.zombie) return true;
    return realKill(pid, signal);
  }) as typeof process.kill);
});
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

/** Mocked boot: 10 minutes ago. */
const beforeBoot = () => Date.now() - 3_600_000;
const recent = () => Date.now() - 60_000;

it("decides unknown owners by the boot rule only, never overriding a known answer", () => {
  expect(writtenBeforeBoot(beforeBoot())).toBe(true);
  expect(writtenBeforeBoot(recent())).toBe(false);
  expect(ownerGone({ alive: undefined, recordedAt: beforeBoot() })).toBe(true);
  expect(ownerGone({ alive: undefined, recordedAt: recent() })).toBe(false);
  expect(ownerGone({ alive: undefined })).toBe(false);
  expect(ownerGone({ alive: true, recordedAt: beforeBoot() })).toBe(false);
  expect(ownerGone({ alive: false, recordedAt: recent() })).toBe(true);
});

it("treats an unverifiable runner whose last heartbeat predates the boot as gone, so its job is resumable", () => {
  for (const pid of [ghosts.eperm, ghosts.zombie]) {
    expect(runnerProcessAlive({ pid, updatedAt: recent() })).toBe(true);
    expect(runnerProcessAlive({ pid, updatedAt: beforeBoot() })).toBe(false);
    // Kill decisions stay conservative: never kill an unverifiable process.
    expect(runnerProcessAlive({ pid, updatedAt: recent() }, true)).toBe(false);
  }
  // A runner that never reported in: a launch from before the boot is not running any more.
  const alive = (startedAt: number) => JobRunners.prototype.alive.call({} as never, { host: { pid: ghosts.eperm, peer: "job:x", startedAt } } as never, null);
  expect(alive(recent())).toBe(true);
  expect(alive(beforeBoot())).toBe(false);
});
