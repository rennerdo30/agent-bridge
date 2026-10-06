import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DB_FILE_NAME } from "./constants.js";
import { isRecord, retentionLimit } from "./json-store.js";
import { ARCHIVE_DB_NAME, snapshotDatabase } from "./sqlite-maintenance.js";
import { maintenanceLock, storageLease } from "./storage-lock.js";

export const BACKUPS_DIR_NAME = "backups";
export const BACKUP_MANIFEST_VERSION = 1;
export const DEFAULT_BACKUP_RETENTION = 7;
export const DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const BACKUP_RETENTION_ENV = "AGENT_BRIDGE_BACKUP_RETENTION";
export const BACKUP_INTERVAL_ENV = "AGENT_BRIDGE_BACKUP_INTERVAL_MS";
const MANIFEST_NAME = "manifest.json";
const BACKUP_PREFIX = "snapshot-";

export interface BackupManifest {
  version: number;
  createdAt: number;
  files: { path: string; sha256: string; bytes: number }[];
}

function digest(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

function syncFile(path: string): void {
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Enumerate data only, never credentials, sockets or symlink targets. Active jobs precede archives. */
export function jsonStoreFiles(home: string): string[] {
  if (!existsSync(home)) return [];
  const files: string[] = [];
  const visit = (dir: string, recurse: boolean) => {
    if (!existsSync(dir)) return;
    const root = lstatSync(dir);
    if (root.isSymbolicLink() || !root.isDirectory()) return;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory() && recurse) visit(path, true);
      else if (st.isFile() && name !== "dashboard.json" && /\.jsonl?(?:-\d+-[\w-]+)?$/.test(name)) files.push(path);
    }
  };
  visit(home, false);
  for (const dir of ["jobs", "runs", "archive", "read-state", "job-outcomes", "local-result-receipts"]) visit(join(home, dir), true);
  return files;
}

export function listBackups(home: string): { path: string; createdAt: number }[] {
  const dir = join(home, BACKUPS_DIR_NAME);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(BACKUP_PREFIX)).flatMap((f) => {
    const path = join(dir, f);
    try {
      const manifest = JSON.parse(readFileSync(join(path, MANIFEST_NAME), "utf8")) as BackupManifest;
      return [{ path, createdAt: manifest.createdAt }];
    } catch { return []; }
  }).sort((a, b) => b.createdAt - a.createdAt || b.path.localeCompare(a.path));
}

/** Each SQLite file is a consistent snapshot; each JSON file is captured as an atomic byte sequence.
 * Active data is captured before monotonic archives, so an archive move cannot lose the only copy.
 */
export function createBackup(home: string, now = Date.now(), rotate = true): string {
  const release = storageLease(home);
  try { return createBackupUnlocked(home, now, rotate); } finally { release(); }
}

function createBackupUnlocked(home: string, now: number, rotate: boolean): string {
  const root = join(home, BACKUPS_DIR_NAME);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const name = `${BACKUP_PREFIX}${String(now).padStart(13, "0")}-${randomUUID()}`;
  const staging = join(root, `.pending-${name}`);
  mkdirSync(staging, { mode: 0o700 });
  const manifest: BackupManifest = { version: BACKUP_MANIFEST_VERSION, createdAt: now, files: [] };
  const capture = (source: string, sqlite: boolean) => {
    const path = relative(home, source).split(sep).join("/");
    const target = join(staging, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (sqlite) snapshotDatabase(source, target);
    else copyFileSync(source, target);
    syncFile(target);
    const raw = readFileSync(target);
    manifest.files.push({ path, sha256: createHash("sha256").update(raw).digest("hex"), bytes: raw.length });
  };
  // The archive only grows. Capture it after the primary, even while the broker is archiving.
  for (const name of [DB_FILE_NAME, ARCHIVE_DB_NAME]) if (existsSync(join(home, name))) capture(join(home, name), true);
  for (const file of jsonStoreFiles(home)) capture(file, false);
  writeFileSync(join(staging, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  syncFile(join(staging, MANIFEST_NAME));
  const published = join(root, name);
  renameSync(staging, published);
  if (rotate) {
    const retention = retentionLimit(BACKUP_RETENTION_ENV, DEFAULT_BACKUP_RETENTION);
    if (retention) for (const backup of listBackups(home).slice(retention)) {
      const cold = join(root, "archive");
      mkdirSync(cold, { recursive: true, mode: 0o700 });
      renameSync(backup.path, join(cold, backup.path.split(/[\\/]/).at(-1)!));
    }
  }
  return published;
}

export function backupIfDue(home: string, now = Date.now()): string | null {
  const interval = retentionLimit(BACKUP_INTERVAL_ENV, DEFAULT_BACKUP_INTERVAL_MS);
  if (!interval || now - (listBackups(home)[0]?.createdAt ?? 0) < interval) return null;
  return createBackup(home, now);
}

function allowedPath(path: string): boolean {
  return path === DB_FILE_NAME || path === ARCHIVE_DB_NAME ||
    (/^[\w.-]+\.json$/.test(path) && !["dashboard.json"].includes(path)) ||
    /^(jobs|runs|archive|read-state|job-outcomes|local-result-receipts)\/[\w./-]+$/.test(path) && !path.split("/").some((s) => s === ".." || s === ".") &&
      /\.jsonl?(?:-\d+-[\w-]+)?$/.test(path);
}

/** Preserve damaged databases as raw bytes and sidecars. Recovery sets are never rotated. */
function createRecovery(home: string): string {
  const root = join(home, BACKUPS_DIR_NAME, `recovery-${Date.now()}-${randomUUID()}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const files = jsonStoreFiles(home);
  for (const name of [DB_FILE_NAME, ARCHIVE_DB_NAME]) for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = join(home, name + suffix);
    if (existsSync(file)) files.push(file);
  }
  for (const source of files) {
    const target = join(root, relative(home, source));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    syncFile(target);
  }
  return root;
}

export function readBackup(path: string): BackupManifest {
  const value: unknown = JSON.parse(readFileSync(join(path, MANIFEST_NAME), "utf8"));
  if (!isRecord(value) || value.version !== BACKUP_MANIFEST_VERSION || !Number.isFinite(value.createdAt) || !Array.isArray(value.files)) throw new Error("unsupported backup manifest");
  const seen = new Set<string>();
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.path !== "string" || !allowedPath(file.path) || seen.has(file.path)) throw new Error("unsafe or duplicate backup path");
    seen.add(file.path);
    const source = resolve(path, file.path);
    if (!source.startsWith(resolve(path) + sep) || lstatSync(source).isSymbolicLink() || digest(source) !== file.sha256) throw new Error(`backup checksum mismatch: ${file.path}`);
    for (let dir = dirname(source); dir !== resolve(path); dir = dirname(dir)) {
      if (lstatSync(dir).isSymbolicLink()) throw new Error("unsafe backup directory");
    }
  }
  return value as unknown as BackupManifest;
}

/** Confirmation is checked in core too. Every displaced byte remains in the recovery directory. */
export function restoreBackup(home: string, backup: string, confirmed: boolean): string {
  if (!confirmed) throw new Error("restore requires confirmation");
  const manifest = readBackup(backup);
  const unlock = maintenanceLock(home);
  try {
    const recovery = createRecovery(home);
    const displaced = join(recovery, "displaced");
    mkdirSync(displaced, { mode: 0o700 });
    const restored: string[] = [];
    const moved: { source: string; target: string }[] = [];
    try {
      for (const file of manifest.files) {
        const target = resolve(home, file.path);
        // Reject symlinked ancestors, including links installed after manifest validation.
        for (let dir = dirname(target); dir !== resolve(home); dir = dirname(dir)) {
          if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error("unsafe restore directory");
        }
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        const paths = target.endsWith(".db") ? [target, `${target}-wal`, `${target}-shm`, `${target}-journal`] : [target];
        for (const source of paths) if (existsSync(source)) {
          const preserved = join(displaced, relative(home, source));
          mkdirSync(dirname(preserved), { recursive: true, mode: 0o700 });
          renameSync(source, preserved);
          moved.push({ source, target: preserved });
        }
        const tmp = `${target}.${randomUUID()}.restore`;
        copyFileSync(join(backup, file.path), tmp);
        syncFile(tmp);
        if (digest(tmp) !== file.sha256) throw new Error("backup changed during restore");
        renameSync(tmp, target);
        restored.push(target);
      }
    } catch (err) {
      // Preserve partially restored data too, then return every original file to its place.
      for (const target of restored) renameSync(target, `${target}.failed-restore-${randomUUID()}`);
      for (const entry of moved.reverse()) renameSync(entry.target, entry.source);
      throw err;
    }
    return recovery;
  } finally { unlock(); }
}
