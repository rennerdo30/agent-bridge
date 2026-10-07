import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

const LOCK_FILE = ".maintenance-lock";
const USERS_DIR = ".storage-users";
const SCOPED_STORE_DIRS = new Set(["runs", "jobs", "job-outcomes", "worktree-state", "permission-repairs"]);
const NESTED_STORE_DIRS = new Set(["local-result-receipts"]);

/** Writers register before opening data. The second check closes the restore/open race. */
export function storageLease(home: string): () => void {
  const lock = join(home, LOCK_FILE);
  if (existsSync(lock)) throw new Error("storage maintenance is in progress");
  const dir = join(home, USERS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${process.pid}-${randomUUID()}`);
  closeSync(openSync(path, "wx", 0o600));
  if (existsSync(lock)) {
    rmSync(path);
    throw new Error("storage maintenance is in progress");
  }
  return () => rmSync(path, { force: true });
}

export function storeHome(path: string): string {
  const dir = dirname(path);
  if (NESTED_STORE_DIRS.has(dirname(dir).split(/[\\/]/).at(-1) ?? "")) return dirname(dirname(dir));
  return SCOPED_STORE_DIRS.has(dir.split(/[\\/]/).at(-1) ?? "") ? dirname(dir) : dir;
}

/** Never expires a live process's lease by age. Stale files are safe to remove after PID checks. */
export function maintenanceLock(home: string): () => void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, LOCK_FILE);
  closeSync(openSync(path, "wx", 0o600));
  try {
    const dir = join(home, USERS_DIR);
    for (const file of existsSync(dir) ? readdirSync(dir) : []) {
      const pid = Number(file.split("-")[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("unknown storage lease; stop all bridge processes first");
      try { process.kill(pid, 0); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
        rmSync(join(dir, file));
        continue;
      }
      throw new Error("storage is in use; stop all bridge processes before restore or repair");
    }
    return () => rmSync(path, { force: true });
  } catch (err) {
    rmSync(path, { force: true });
    throw err;
  }
}
