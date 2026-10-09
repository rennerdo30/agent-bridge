import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { processStartMs } from "./process-identity.js";
import { ownerGone as bootOwnerGone } from "./boot-time.js";

const LOCK_FILE = ".maintenance-lock";
const USERS_DIR = ".storage-users";
const SCOPED_STORE_DIRS = new Set(["runs", "jobs", "job-outcomes", "worktree-state", "permission-repairs"]);
const NESTED_STORE_DIRS = new Set(["local-result-receipts"]);
/** Clock and timestamp resolution slack (ps reports whole seconds, some filesystems 2 s mtimes). */
const START_SLACK_MS = 2_000;

/** Owner identity written into the maintenance lock and every storage lease. */
interface LockOwner { pid: number; nonce: string; createdAt: number }

function writeOwner(path: string): LockOwner {
  const owner: LockOwner = { pid: process.pid, nonce: randomUUID(), createdAt: Date.now() };
  const fd = openSync(path, "wx", 0o600);
  try { writeSync(fd, JSON.stringify(owner)); fsyncSync(fd); } finally { closeSync(fd); }
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
function ownerGone(pid: number, createdAt: number): boolean {
  if (pid === process.pid) return false;
  let alive: boolean | undefined;
  try {
    process.kill(pid, 0);
    const started = processStartMs(pid);
    alive = started === undefined ? undefined : started <= createdAt + START_SLACK_MS;
  } catch (err) { alive = (err as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined; }
  return bootOwnerGone({ alive, recordedAt: createdAt });
}

/** Removes a maintenance lock whose recorded owner is provably gone. A lock without an owner record
 * (written by an older version) is never removed: its owner cannot be identified. */
function recoverStaleLock(path: string): boolean {
  const owner = readOwner(path);
  if (!owner || !ownerGone(owner.pid, owner.createdAt)) return false;
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
export function storageLease(home: string): () => void {
  const lock = join(home, LOCK_FILE);
  if (existsSync(lock) && !recoverStaleLock(lock) && existsSync(lock)) throw maintenanceBusy(lock);
  const dir = join(home, USERS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${process.pid}-${randomUUID()}`);
  writeOwner(path);
  if (existsSync(lock)) {
    rmSync(path);
    throw maintenanceBusy(lock);
  }
  return () => rmSync(path, { force: true });
}

export function storeHome(path: string): string {
  const dir = dirname(path);
  if (NESTED_STORE_DIRS.has(dirname(dir).split(/[\\/]/).at(-1) ?? "")) return dirname(dirname(dir));
  return SCOPED_STORE_DIRS.has(dir.split(/[\\/]/).at(-1) ?? "") ? dirname(dir) : dir;
}

/** Never expires a live process's lease by age. A lease is stale only when its process is gone or its PID
 * now belongs to a process that started after the lease was written. */
export function maintenanceLock(home: string): () => void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, LOCK_FILE);
  let owner: LockOwner;
  try { owner = writeOwner(path); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST" || !recoverStaleLock(path)) throw (err as NodeJS.ErrnoException).code === "EEXIST" ? maintenanceBusy(path) : err;
    owner = writeOwner(path);
  }
  const release = () => { if (readOwner(path)?.nonce === owner.nonce) rmSync(path, { force: true }); };
  try {
    const dir = join(home, USERS_DIR);
    for (const file of existsSync(dir) ? readdirSync(dir) : []) {
      const lease = join(dir, file);
      const pid = Number(file.split("-")[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`unknown storage lease ${lease}; stop all bridge processes first`);
      // Leases from older versions are empty; the file is never modified after creation, so its mtime is its creation time.
      let createdAt = readOwner(lease)?.createdAt;
      if (createdAt === undefined) {
        try { createdAt = statSync(lease).mtimeMs; } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; throw err; }
      }
      if (ownerGone(pid, createdAt)) { rmSync(lease, { force: true }); continue; }
      throw new Error(`storage is in use by pid ${pid} (lease ${lease}); stop all bridge processes before restore or repair`);
    }
    return release;
  } catch (err) {
    release();
    throw err;
  }
}
