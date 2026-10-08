import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isRecord, JSON_STORE_VERSION } from "./json-store.js";
import { readJsonSnapshot } from "./file-cache.js";
import { assertStoreUpgrade } from "./store-compatibility.js";

interface ArchivedJobSnapshot { signature: string; jobs: Record<string, unknown>[] }
const snapshots = new Map<string, ArchivedJobSnapshot>();
const EMPTY_SNAPSHOT: ArchivedJobSnapshot = { signature: "", jobs: [] };

export function readArchivedJobs(path: string): Record<string, unknown>[] {
  return structuredClone(readArchivedJobSnapshot(path).jobs);
}

/** Stable internal read-only projection; validate every archive before reusing the merged result. */
export function readArchivedJobSnapshot(path: string): ArchivedJobSnapshot {
  const dir = join(dirname(path), "archive");
  if (!existsSync(dir)) return EMPTY_SNAPSHOT;
  const sources: { value: unknown }[] = [];
  const signatures: string[] = [];
  let bytes = 0;
  for (const file of readdirSync(dir).sort()) {
    if (!file.startsWith(`${basename(path)}.overflow.json-`) && !/^jobs-.*\.json$/.test(file)) continue;
    // A damaged archive must be reported, never silently forgotten or renamed by a read.
    const snapshot = readJsonSnapshot(join(dir, file));
    const value = snapshot.value;
    if (!isRecord(value) || (value.version !== undefined && (!Number.isInteger(value.version) || (value.version as number) < 0 || (value.version as number) > JSON_STORE_VERSION)) || !Array.isArray(value.jobs)) throw new Error(`invalid job archive: ${file}`);
    signatures.push(`${file}:${snapshot.signature}`); sources.push({ value }); bytes += snapshot.bytes;
  }
  const signature = signatures.join("\n"), saved = snapshots.get(path);
  if (saved?.signature === signature) return saved;
  const jobs = new Map<string, Record<string, unknown>>();
  for (const source of sources) for (const job of (source.value as { jobs: unknown[] }).jobs) {
    if (isRecord(job) && typeof job.id === "string") jobs.set(job.id, job);
  }
  const next = { signature, jobs: [...jobs.values()] };
  snapshots.delete(path);
  if (bytes <= 256 * 1024 * 1024) snapshots.set(path, next);
  if (snapshots.size > 4) snapshots.delete(snapshots.keys().next().value!);
  return next;
}

/** Full raw records, including unknown fields. Publish before replacing the active jobs store. */
export function archiveJobs(path: string, jobs: unknown[]): string {
  assertStoreUpgrade(dirname(path), "json", 0, JSON_STORE_VERSION);
  const dir = join(dirname(path), "archive");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `jobs-${Date.now()}-${randomUUID()}.json`);
  writeFileSync(target, JSON.stringify({ version: JSON_STORE_VERSION, jobs }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  const fd = openSync(target, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return target;
}
