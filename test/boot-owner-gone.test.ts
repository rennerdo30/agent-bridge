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

function presenceRow(pid: number, at: number, extra: Record<string, unknown> = {}): void {
  metadataDb(env.home); importMetadataDomain(env.home, "storage-capabilities");
  saveMetadataValue(env.home, "storage-capabilities", String(pid), { schemaVersion: 1, json: 4, sqlite: 8, pid, name: "legacy-reader", version: "0.29.17", explicit: true, ...extra });
  metadataDb(env.home).prepare("UPDATE bridge_metadata SET updated_at=? WHERE domain='storage-capabilities' AND key=?").run(at, String(pid));
}

it("ignores a pre-boot legacy reader row whose PID answers EPERM, but keeps a recent one", () => {
  presenceRow(ghosts.eperm, recent());
  expect(legacyStorePeers(env.home).map(peer => peer.pid)).toContain(ghosts.eperm);
  presenceRow(ghosts.eperm, beforeBoot());
  expect(legacyStorePeers(env.home).map(peer => peer.pid)).not.toContain(ghosts.eperm);
});

it.skipIf(process.platform === "linux")("drops an imported legacy row whose PID now belongs to a process started after the row", async () => {
  const started = processStartMs(process.ppid);
  expect(started).toBeDefined();
  if (started === undefined) return;
  ghosts.up = (Date.now() - started) / 1000 + 600;
  // Neither processIdentity nor observedAt: an imported 0.29 file, whose row time is the file time.
  presenceRow(process.ppid, started - 5_000);
  await refreshStorePeerIdentities(env.home);
  expect(legacyStorePeers(env.home).map(peer => peer.pid)).not.toContain(process.ppid);
  expect(liveStorePeers(env.home).map(peer => peer.pid)).not.toContain(process.ppid);
  // The same row written after the process started still belongs to it.
  presenceRow(process.ppid, Date.now());
  await refreshStorePeerIdentities(env.home);
  expect(legacyStorePeers(env.home).map(peer => peer.pid)).toContain(process.ppid);
});

it("recovers a migration lock of an unknown owner only when it predates the boot", () => {
  const file = join(env.home, "store.db");
  for (const pid of [ghosts.eperm, ghosts.zombie]) {
    writeFileSync(`${file}.migration-lock`, JSON.stringify({ pid, nonce: randomUUID() }));
    utimesSync(`${file}.migration-lock`, beforeBoot() / 1000, beforeBoot() / 1000);
    migrationLock(file)();
  }
  writeFileSync(`${file}.migration-lock`, JSON.stringify({ pid: ghosts.eperm, nonce: randomUUID() }));
  expect(() => migrationLock(file)).toThrow(/another session is migrating/);
});

it("recovers a maintenance lock and storage leases of unknown owners only when they predate the boot", () => {
  const lock = join(env.home, ".maintenance-lock");
  writeFileSync(lock, JSON.stringify({ pid: ghosts.eperm, nonce: randomUUID(), createdAt: recent() }));
  expect(() => storageLease(env.home)).toThrow(/maintenance is in progress/);
  writeFileSync(lock, JSON.stringify({ pid: ghosts.eperm, nonce: randomUUID(), createdAt: beforeBoot() }));
  storageLease(env.home)();

  const users = join(env.home, ".storage-users");
  mkdirSync(users, { recursive: true });
  const lease = join(users, `${ghosts.zombie}-${randomUUID()}`);
  writeFileSync(lease, JSON.stringify({ pid: ghosts.zombie, nonce: randomUUID(), createdAt: recent() }));
  expect(() => maintenanceLock(env.home)).toThrow(/storage is in use/);
  writeFileSync(lease, JSON.stringify({ pid: ghosts.zombie, nonce: randomUUID(), createdAt: beforeBoot() }));
  maintenanceLock(env.home)();
});

function foreignLease(path: string, pid: number, createdAt: number): void {
  const registry = join(env.home, ".metadata-leases", createHash("sha256").update("jobs.json").digest("hex"));
  const ownerDirectory = randomUUID(), dir = join(registry, ownerDirectory);
  mkdirSync(dir, { recursive: true });
  const marker = `owner-v1.${pid}.${Buffer.from("ghost-start").toString("base64url")}.${randomUUID()}.json`;
  writeFileSync(join(dir, marker), JSON.stringify({ version: 2, pid, identity: "ghost-start", nonce: marker, ownerDirectory, createdAt }) + "\n");
  linkSync(join(dir, marker), path);
}

it("still refuses a recent metadata lease of an unknown owner", () => {
  const path = join(env.home, "jobs.json");
  foreignLease(path, ghosts.zombie, recent());
  expect(() => metadataFileLease(path)).toThrow(/live or unknown owner/);
  expect(() => metadataFileLease(path, 0, true)).toThrow(/live or unknown owner/);
});

it("takes over a metadata lease of an unknown owner from before the boot", () => {
  const path = join(env.home, "jobs.json");
  foreignLease(path, ghosts.eperm, beforeBoot());
  metadataFileLease(path)();
});

it("frees resource slots of unknown owners last renewed before the boot, keeps recent ones", () => {
  const slots = new ResourceSlots(env.home);
  const db = new DatabaseSync(join(env.home, "resource-slots.sqlite"));
  try {
    const hold = (pid: number, renewedAt: number) => {
      db.prepare("DELETE FROM slots").run();
      db.prepare("INSERT INTO slots(resource, id, pid, held, expiresAt, identity) VALUES ('gpu', ?, ?, 1, ?, NULL)").run(`old-${pid}`, pid, renewedAt + SLOT_LEASE_MS);
    };
    for (const pid of [ghosts.eperm, ghosts.zombie]) {
      hold(pid, recent());
      expect(slots.tryAcquire("gpu", 1, { id: "new", pid: process.pid })).toBe(false);
      slots.release({ id: "new", pid: process.pid }, "gpu");
      hold(pid, beforeBoot());
      expect(slots.tryAcquire("gpu", 1, { id: "new", pid: process.pid })).toBe(true);
      slots.release({ id: "new", pid: process.pid }, "gpu");
    }
  } finally { db.close(); slots.close(); }
});
