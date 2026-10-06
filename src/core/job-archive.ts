import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isRecord, JSON_STORE_VERSION } from "./json-store.js";

export function readArchivedJobs(path: string): Record<string, unknown>[] {
  const dir = join(dirname(path), "archive");
  if (!existsSync(dir)) return [];
  const jobs = new Map<string, Record<string, unknown>>();
  for (const file of readdirSync(dir).sort()) {
    if (!file.startsWith(`${basename(path)}.overflow.json-`) && !/^jobs-.*\.json$/.test(file)) continue;
    // A damaged archive must be reported, never silently forgotten or renamed by a read.
    const value: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
    if (!isRecord(value) || (value.version !== undefined && (!Number.isInteger(value.version) || (value.version as number) < 0 || (value.version as number) > JSON_STORE_VERSION)) || !Array.isArray(value.jobs)) throw new Error(`invalid job archive: ${file}`);
    for (const job of value.jobs) if (isRecord(job) && typeof job.id === "string") jobs.set(job.id, job);
  }
  return [...jobs.values()];
}

/** Full raw records, including unknown fields. Publish before replacing the active jobs store. */
export function archiveJobs(path: string, jobs: unknown[]): string {
  const dir = join(dirname(path), "archive");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `jobs-${Date.now()}-${randomUUID()}.json`);
  writeFileSync(target, JSON.stringify({ version: JSON_STORE_VERSION, jobs }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  const fd = openSync(target, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return target;
}
