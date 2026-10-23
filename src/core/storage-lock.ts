import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { identityStartedAfter, processStartMs, readProcessIdentity } from "./process-identity.js";
import { ownerGone as bootOwnerGone } from "./boot-time.js";
import { PROTOCOL_VERSION } from "./constants.js";
import { SQLITE_STORE_VERSION } from "./store-version.js";
import { withStorageAdmission } from "./storage-admission.js";

const LOCK_FILE = ".maintenance-lock";
const USERS_DIR = ".storage-users";
const SCOPED_STORE_DIRS = new Set(["runs", "jobs", "job-outcomes", "worktree-state", "permission-repairs"]);
const NESTED_STORE_DIRS = new Set(["local-result-receipts"]);
/** Clock and timestamp resolution slack (ps reports whole seconds, some filesystems 2 s mtimes). */
const START_SLACK_MS = 2_000;

/** Owner identity written into the maintenance lock and every storage lease. */
interface LockOwner { pid: number; nonce: string; createdAt: number; mailboxProtocol?: number; mailboxSchema?: number }

type LeaseFileIdentity = { dev: bigint; ino: bigint };
type LeaseCapture = {
  readonly identity: symbol; readonly path: string;
  owner?: LockOwner; file: LeaseFileIdentity | null; descriptor?: number;
  descriptorClose: "not_attempted" | "attempted" | "returned" | "unknown";
  acquisition: "attempted" | "returned" | "unknown";
  release: "not_attempted" | "attempted" | "returned" | "unknown";
  attempts: number;
};
const leaseCaptures = new WeakMap<() => void, LeaseCapture>();
const retainedLeaseCaptures = new Set<LeaseCapture>();
const maintenanceWitnesses = new WeakMap<() => void, { path: string; nonce: string }>();
let borrowedMaintenance: { path: string; release: () => void; check: () => void } | undefined;
/** One synchronous initializer may nest under its own actual common exclusion.
 * No caller string, PID equivalence or earlier/home-global proof qualifies. */
export function withMaintenanceExclusion<T>(release: () => void, check: () => void, effect: () => T): T {
  const witness = maintenanceWitnesses.get(release), identity = witness && leaseFileIdentity(witness.path);
  if (!witness || !identity) throw new Error("Owned maintenance exclusion is unproven");
  const assert = () => {
    check();
    if (readOwner(witness.path)?.nonce !== witness.nonce || !sameLeaseFile(identity, leaseFileIdentity(witness.path))) throw new Error("Owned maintenance exclusion changed");
  };
  assert(); const previous = borrowedMaintenance;
  const borrow = () => {}; // Owned cleanup neither removes the outer lock nor checks an expired operational deadline.
  maintenanceWitnesses.set(borrow, witness);
  borrowedMaintenance = { path: witness.path, release: borrow, check: assert };
  try { return effect(); } finally { maintenanceWitnesses.delete(borrow); borrowedMaintenance = previous; }
}

function leaseFileIdentity(path: string): LeaseFileIdentity | null {
  try {
    const file = lstatSync(path, { bigint: true });
    return file.isFile() && !file.isSymbolicLink() && file.dev >= 0n && file.ino > 0n ? { dev: file.dev, ino: file.ino } : null;
  } catch { return null; }
}
function sameLeaseFile(a: LeaseFileIdentity | null, b: LeaseFileIdentity | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}
function observedOwnLease(capture: LeaseCapture): boolean {
  const current = readOwner(capture.path), owner = capture.owner;
  return owner !== undefined && current !== null && current.pid === owner.pid && current.nonce === owner.nonce &&
    current.createdAt === owner.createdAt && sameLeaseFile(capture.file, leaseFileIdentity(capture.path));
}
function observedAbsentLease(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

/** Internal historical operation evidence only: no owner binding, process/boot
 * proof, complete consumer census or permission to remove a lifecycle lease.
 * Observation never deletes, recovers, probes SQL or exposes a native resource.
 */
export function storageLeaseObservation(release: () => void) {
  const capture = leaseCaptures.get(release);
  return Object.freeze({ captured: capture !== undefined, acquisition: capture?.acquisition ?? "unavailable",
    descriptorClose: capture?.descriptorClose ?? "not_attempted", release: capture?.release ?? "not_attempted",
    identityObserved: capture?.file !== null && capture?.file !== undefined,
    retained: capture !== undefined && retainedLeaseCaptures.has(capture), overflow: retainedLeaseCaptures.size > 128,
    ownerBound: false as const, ownershipReleased: false as const });
}

function writeOwner(path: string, capture?: LeaseCapture): LockOwner {
  const owner: LockOwner = { pid: process.pid, nonce: randomUUID(), createdAt: Date.now(), mailboxProtocol: PROTOCOL_VERSION, mailboxSchema: SQLITE_STORE_VERSION };
  if (capture) capture.owner = owner;
  const fd = openSync(path, "wx", 0o600);
  if (capture) capture.descriptor = fd;
  try { writeSync(fd, JSON.stringify(owner)); fsyncSync(fd); }
  finally {
    if (capture) capture.descriptorClose = "attempted";
    try { closeSync(fd); if (capture) capture.descriptorClose = "returned"; }
    catch (error) { if (capture) capture.descriptorClose = "unknown"; throw error; }
  }
  return owner;
}

function readOwner(path: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || typeof value.nonce !== "string" || !Number.isFinite(value.createdAt)) return null;
    return value as LockOwner;
  } catch { return null; }
}

/** "dead" only with proof: the PID does not exist, or the process now holding it started after the lock was
 * written (PID reuse). Our own PID counts as alive. Access errors and unreadable start times count as alive unless
 * the lock was written before the current boot: no process survives a reboot (AB-256). */
function ownerGone(pid: number, createdAt: number, path?: string, nonblocking = false): boolean {
  if (readerAdmission) {
    readerAdmission.check();
    if (path && readerAdmission.gone(path, pid, createdAt)) return true;
    nonblocking = true;
  }
  if (pid === process.pid) return false;
  let alive: boolean | undefined;
  try {
    process.kill(pid, 0);
    const started = nonblocking ? undefined : processStartMs(pid);
    alive = started === undefined ? undefined : started <= createdAt + START_SLACK_MS;
  } catch (err) { alive = (err as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
  return bootOwnerGone({ alive, recordedAt: createdAt });
}

/** Removes a maintenance lock whose recorded owner is provably gone. A lock without an owner record
 * (written by an older version) is never removed: its owner cannot be identified. */
function recoverStaleLock(path: string, nonblocking = false): boolean {
  const owner = readOwner(path);
  if (!owner || !ownerGone(owner.pid, owner.createdAt, path, nonblocking)) return false;
  const moved = `${path}.stale-${randomUUID()}`;
  try { renameSync(path, moved); }
  catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT"; }
  if (readOwner(moved)?.nonce !== owner.nonce) {
    // Another process replaced the lock between our check and the rename: put its lock back.
    try { linkSync(moved, path); rmSync(moved, { force: true }); }
    catch { /* A newer lock exists; keep the moved file for inspection rather than guessing. */ }
    return false;
  }
  rmSync(moved, { force: true });
  return true;
}

function maintenanceBusy(path: string): Error {
  const owner = readOwner(path);
  const who = owner ? `held by pid ${owner.pid} since ${new Date(owner.createdAt).toISOString()}` : "owner unknown (written by an older version)";
  return new Error(`storage maintenance is in progress (${who}); if no agent-bridge maintenance command is running, delete ${path}`);
}

/** Writers register before opening data. The second check closes the restore/open race. */
export function storageLease(home: string, maintenance?: () => void): () => void {
  readerAdmission?.check();
  const lock = join(home, LOCK_FILE);
  if (!maintenance && borrowedMaintenance?.path === lock) { borrowedMaintenance.check(); maintenance = borrowedMaintenance.release; }
  const ownsMaintenance = () => {
    const witness = maintenance && maintenanceWitnesses.get(maintenance);
    return !!witness && witness.path === lock && readOwner(lock)?.nonce === witness.nonce;
  };
  if (existsSync(lock) && !ownsMaintenance() && !recoverStaleLock(lock, true) && existsSync(lock)) throw maintenanceBusy(lock);
  const dir = join(home, USERS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${process.pid}-${randomUUID()}`);
  const capture: LeaseCapture = { identity: Symbol("storage lease acquisition"), path, file: null,
    descriptorClose: "not_attempted", acquisition: "attempted", release: "not_attempted", attempts: 0 };
  retainedLeaseCaptures.add(capture);
  try { writeOwner(path, capture); capture.acquisition = "returned"; capture.file = leaseFileIdentity(path); }
  catch (error) { capture.acquisition = "unknown"; throw error; }
  const remove = (force: boolean) => {
    const own = capture.acquisition === "returned" && capture.descriptorClose === "returned" && observedOwnLease(capture);
    const priorUnknown = capture.release === "unknown";
    capture.attempts = Math.min(2, capture.attempts + 1); capture.release = "attempted";
    try {
      // Preserve the ordinary callback's existing removal policy. This historical
      // evidence is NOT the later guarded lifecycle release adapter or its ACK.
      if (force) rmSync(path, { force: true }); else rmSync(path);
      capture.release = own && !priorUnknown && capture.attempts === 1 && observedAbsentLease(path) ? "returned" : "unknown";
      if (capture.release === "returned") retainedLeaseCaptures.delete(capture);
      else retainedLeaseCaptures.add(capture);
    } catch (error) { capture.release = "unknown"; retainedLeaseCaptures.add(capture); throw error; }
  };
  const release = () => remove(true);
  leaseCaptures.set(release, capture);
  if (existsSync(lock) && !ownsMaintenance()) {
    remove(false);
    throw maintenanceBusy(lock);
  }
  return release;
}

export function storeHome(path: string): string {
  const dir = dirname(path);
  if (NESTED_STORE_DIRS.has(dirname(dir).split(/[\\/]/).at(-1) ?? "")) return dirname(dirname(dir));
  return SCOPED_STORE_DIRS.has(dir.split(/[\\/]/).at(-1) ?? "") ? dirname(dir) : dir;
}

/** Read-only census, including readers which opened SQLite before binding a
 * transport. An absent compatibility declaration never proves a safe reader.
 * Declarations concern this local executable's storage contract, not mail ownership. */
type Reader = { path: string; signature: string; pid: number; owner: LockOwner | null; createdAt: number; compatible: boolean };
const unprovenReader = () => Object.assign(new Error("Mailbox reader compatibility is unproven; owner-coordinated shutdown is required before sharing this data home. Original evidence is retained."), { code: "STORE_READER_ACTIVE", readerCompatibility: "unproven" });
function readerSnapshot(home: string, check: () => number): Reader[] {
    check(); const dir = join(home, USERS_DIR), files = existsSync(dir) ? readdirSync(dir).sort() : []; check();
    if (files.length > 256) throw unprovenReader();
    return files.map(file => {
      check(); const path = join(dir, file), before = lstatSync(path, { bigint: true }); check();
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4_096n) throw unprovenReader();
      const identity = (s: typeof before) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let raw: string, evidence: string;
      try {
        check(); if (identity(fstatSync(fd, { bigint: true })) !== identity(before)) throw unprovenReader();
        const bytes = Buffer.alloc(Number(before.size) + 1), length = readSync(fd, bytes, 0, bytes.length, 0); check();
        if (length !== Number(before.size) || identity(fstatSync(fd, { bigint: true })) !== identity(before) || identity(lstatSync(path, { bigint: true })) !== identity(before)) throw unprovenReader();
        raw = bytes.subarray(0, length).toString("utf8");
        evidence = bytes.subarray(0, length).toString("hex");
      } finally { closeSync(fd); }
      check(); let owner: LockOwner | null = null;
      try {
        const value = JSON.parse(raw) as LockOwner;
        if (value && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.nonce === "string" && Number.isFinite(value.createdAt)) owner = value;
      } catch { /* Incomplete is unproven, never compatible. */ }
      const pid = Number(file.split("-")[0]);
      return { path, signature: `${file}:${identity(before)}:${evidence}`, pid, owner, createdAt: owner?.createdAt ?? Number(before.mtimeMs),
        compatible: owner?.pid === pid && owner.mailboxProtocol === PROTOCOL_VERSION && owner.mailboxSchema === SQLITE_STORE_VERSION };
    });
  }
// A proof is scoped to one synchronous construction callback. No home-global
// approval survives the guard or its deadline. Every use checks exact file evidence.
type ReaderAdmission = { check: () => number; assert: (home: string) => void; gone: (path: string, pid: number, createdAt: number) => boolean };
const verifiedReaderAdmissions = new WeakSet<ReaderAdmission>();
let readerAdmission: ReaderAdmission | undefined;
export function withMailboxReaderAdmission<T>(proof: ReaderAdmission, effect: () => T): T {
  if (!verifiedReaderAdmissions.has(proof)) throw unprovenReader();
  const previous = readerAdmission; readerAdmission = proof;
  try { return withStorageAdmission(proof.check, effect); } finally { readerAdmission = previous; }
}
export function assertCompatibleMailboxReaders(home: string): void {
  if (readerAdmission) { readerAdmission.assert(home); return; }
  // Direct synchronous consumers cannot create an OS-query subprocess or borrow
  // an earlier async observation. Unknown/PID-reuse evidence requires async admission.
  for (const reader of readerSnapshot(home, () => 1)) {
    if (reader.compatible || ownerGone(reader.pid, reader.createdAt, reader.path, true)) continue;
    throw Object.assign(unprovenReader(), { readerCompatibility: reader.owner?.pid === reader.pid && Number.isSafeInteger(reader.owner.mailboxProtocol) && Number.isSafeInteger(reader.owner.mailboxSchema) ? "incompatible" : "unproven" });
  }
}

/** Deadline-bound census. The returned proof must be freshly checked at effect. */
export async function assertCompatibleMailboxReadersAsync(home: string, signal: AbortSignal, check: () => number): Promise<ReaderAdmission> {
  const snapshot = () => readerSnapshot(home, check);
  const before = snapshot();
  let blocked: Reader | undefined;
  for (const reader of before) {
    check(); if (reader.compatible) continue;
    let alive: boolean | undefined = reader.pid === process.pid ? true : undefined;
    if (alive === undefined && Number.isSafeInteger(reader.pid) && reader.pid > 0) {
      try {
        process.kill(reader.pid, 0); check();
        const identity = await readProcessIdentity(reader.pid, signal, check); check();
        if (identity) alive = process.platform === "darwin" ? !(Number.isFinite(Date.parse(identity)) && Date.parse(identity) > reader.createdAt + START_SLACK_MS)
          : !identityStartedAfter(identity, reader.createdAt + START_SLACK_MS);
        check();
      } catch (error) { check(); alive = (error as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
    }
    if (!Number.isSafeInteger(reader.pid) || reader.pid <= 0 || !bootOwnerGone({ alive, recordedAt: reader.createdAt })) { blocked = reader; break; }
  }
  const after = snapshot(); check();
  if (before.length !== after.length || before.some((reader, i) => reader.signature !== after[i]!.signature)) throw unprovenReader();
  if (blocked) throw Object.assign(unprovenReader(), { readerCompatibility: blocked.owner?.pid === blocked.pid && Number.isSafeInteger(blocked.owner.mailboxProtocol) && Number.isSafeInteger(blocked.owner.mailboxSchema) ? "incompatible" : "unproven" });
  check();
  const approvedSnapshot = (target: string) => {
    check(); if (target !== home) throw unprovenReader();
    const current = snapshot();
    for (const reader of current) if (!reader.compatible && !before.some(old => old.signature === reader.signature)) throw unprovenReader();
    check(); return current;
  };
  const proof: ReaderAdmission = { check, assert: target => { approvedSnapshot(target); }, gone: (path, pid, createdAt) => {
    const current = approvedSnapshot(home);
    return before.some(reader => !reader.compatible && reader.path === path && reader.pid === pid && reader.createdAt === createdAt &&
      current.some(observed => observed.signature === reader.signature));
  } };
  verifiedReaderAdmissions.add(proof); return proof;
}

/** Never expires a live process's lease by age. A lease is stale only when its process is gone or its PID
 * now belongs to a process that started after the lease was written. */
export function maintenanceLock(home: string, allowOwnCompatibleLease = false, nonblocking = false): () => void {
  readerAdmission?.check();
  if (borrowedMaintenance?.path === join(home, LOCK_FILE)) { borrowedMaintenance.check(); return borrowedMaintenance.release; }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, LOCK_FILE);
  let owner: LockOwner;
  try { owner = writeOwner(path); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST" || !recoverStaleLock(path, nonblocking)) throw (err as NodeJS.ErrnoException).code === "EEXIST" ? maintenanceBusy(path) : err;
    owner = writeOwner(path);
  }
  const release = () => { if (readOwner(path)?.nonce === owner.nonce) rmSync(path, { force: true }); };
  maintenanceWitnesses.set(release, { path, nonce: owner.nonce });
  try {
    const dir = join(home, USERS_DIR);
    for (const file of existsSync(dir) ? readdirSync(dir) : []) {
      readerAdmission?.check();
      const lease = join(dir, file);
      const pid = Number(file.split("-")[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`unknown storage lease ${lease}; stop all bridge processes first`);
      // Metadata admission is synchronous and cannot overlap another JS effect
      // in this process. Never exempt a foreign process or an older own lease.
      const declaration = readOwner(lease);
      if (allowOwnCompatibleLease && pid === process.pid && declaration?.pid === pid &&
          declaration.mailboxProtocol === PROTOCOL_VERSION && declaration.mailboxSchema === SQLITE_STORE_VERSION) continue;
      // Leases from older versions are empty; the file is never modified after creation, so its mtime is its creation time.
      let createdAt = readOwner(lease)?.createdAt;
      if (createdAt === undefined) {
        try { createdAt = statSync(lease).mtimeMs; } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; throw err; }
      }
      if (ownerGone(pid, createdAt, lease, nonblocking)) { rmSync(lease, { force: true }); continue; }
      throw new Error(`storage is in use by pid ${pid} (lease ${lease}); stop all bridge processes before restore or repair`);
    }
    return release;
  } catch (err) {
    release();
    throw err;
  }
}
