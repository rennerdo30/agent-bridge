import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Logger } from "./logger.js";
import { storageLease, storeHome } from "./storage-lock.js";
import { assertStoreUpgrade } from "./store-compatibility.js";
import { markJobProjection, storeJobRecords } from "./job-archive-index.js";

export const JSON_STORE_VERSION = 4;
export const KEEP_STORE_BACKUPS = 3;
const RENAME_ATTEMPTS = 50;
const RENAME_RETRY_MS = 20;

function warn(log: Logger | undefined, message: string, data: Record<string, unknown>): void {
  if (log) log.warn(message, data);
  else process.stderr.write(`${message}: ${JSON.stringify(data)}\n`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Archives are never pruned automatically. A unique name prevents overwriting an earlier copy. */
export function archiveFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const dir = join(dirname(path), "archive");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `${basename(path)}-${Date.now()}-${randomUUID()}`);
  renameSync(path, target);
  return target;
}

export function backupPath(path: string): string {
  return `${path}.backup-${Date.now()}-${randomUUID()}`;
}

export function retainBackups(path: string): void {
  const prefix = `${basename(path)}.backup-`;
  const files = readdirSync(dirname(path)).filter((f) => f.startsWith(prefix)).sort().reverse();
  for (const file of files.slice(KEEP_STORE_BACKUPS)) {
    try { archiveFile(join(dirname(path), file)); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Parallel readers/migration candidates may still hold this snapshot on Windows.
      // Rotation is optional; keeping its original location is safer than failing startup.
      if (["EBUSY", "EPERM", "EACCES", "ENOENT"].includes(code ?? "")) continue;
      throw error;
    }
  }
}

/** How long a store that does not parse gets to finish a write by another process before it counts as corrupt. */
const PARTIAL_WRITE_WAIT_MS = 100;

function parseJsonStore(raw: string, valid: (value: unknown) => boolean): unknown {
  const value: unknown = JSON.parse(raw);
  if (isRecord(value) && typeof value.version === "number" && value.version > JSON_STORE_VERSION) return value;
  if (!valid(value)) throw new Error("invalid store structure");
  return value;
}

export function readJsonStore(path: string, log?: Logger, valid: (value: unknown) => boolean = isRecord): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return parseJsonStore(raw, valid);
  } catch (err) {
    // A file another process is writing in place (an editor, or a plain writeFileSync) can be read empty or half
    // written: read it again before moving it aside as corrupt.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PARTIAL_WRITE_WAIT_MS);
    try {
      const again = readFileSync(path, "utf8");
      if (again !== raw) return parseJsonStore(again, valid);
    } catch (retry) {
      if ((retry as NodeJS.ErrnoException).code === "ENOENT") return null;
    }
    const preserved = `${path}.corrupt-${Date.now()}-${randomUUID()}`;
    const release = storageLease(storeHome(path));
    try { renameSync(path, preserved); } finally { release(); }
    warn(log, "preserved corrupt JSON store", { path, preserved, err: (err as Error).message });
    return null;
  }
}

export function assertWritableStore(value: unknown): void {
  if (!isRecord(value) || value.version === undefined) return;
  if (!Number.isInteger(value.version) || (value.version as number) < 0 || (value.version as number) > JSON_STORE_VERSION) {
    throw new Error(`unsupported JSON store version: ${String(value.version)}`);
  }
}

/** Keep fields introduced by another reader, including nested object fields. */
export function mergeStoreFields(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...previous, ...next };
  for (const [key, value] of Object.entries(next)) {
    if (isRecord(previous[key]) && isRecord(value)) merged[key] = mergeStoreFields(previous[key], value);
  }
  return merged;
}

/** Back up legacy data before its first versioned write, then replace atomically. */
export function writeJsonStore(path: string, value: Record<string, unknown>, previous: unknown): void {
  const release = storageLease(storeHome(path));
  try { writeJsonStoreUnlocked(path, value, previous); } finally { release(); }
}

function writeJsonStoreUnlocked(path: string, value: Record<string, unknown>, previous: unknown): void {
  assertWritableStore(previous);
  assertStoreUpgrade(storeHome(path), "json", isRecord(previous) && typeof previous.version === "number" ? previous.version : 0, JSON_STORE_VERSION);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (basename(path) === "jobs.json" && Array.isArray(value.jobs)) {
    // Preserve changed full records before publishing the compatibility projection.
    storeJobRecords(path, value.jobs, false, Array.isArray(previous) ? previous : isRecord(previous) && Array.isArray(previous.jobs) ? previous.jobs : []);
  }
  if (previous !== null && (!isRecord(previous) || previous.version !== JSON_STORE_VERSION) && existsSync(path)) {
    copyFileSync(path, backupPath(path));
    retainBackups(path);
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...value, version: JSON_STORE_VERSION }, null, 2)}\n`, { mode: 0o600 });
  const fd = openSync(tmp, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  const pause = new Int32Array(new SharedArrayBuffer(4));
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(tmp, path);
        if (basename(path) === "jobs.json" && Array.isArray(value.jobs)) markJobProjection(path, value.jobs);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (!["EPERM", "EBUSY", "EACCES"].includes(code ?? "") || attempt >= RENAME_ATTEMPTS) throw err;
        Atomics.wait(pause, 0, 0, RENAME_RETRY_MS);
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Zero disables pruning; invalid values use the documented default. */
export function retentionLimit(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}
