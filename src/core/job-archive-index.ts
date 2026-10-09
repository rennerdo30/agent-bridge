import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cloneJson, estimatedJsonBytes, fileSignature } from "./file-cache.js";
import { migrateSqlite } from "./sqlite-migrations.js";
import type { Logger } from "./logger.js";

export const JOB_ARCHIVE_VERSION = 1;
export const JOB_ARCHIVE_FILE = "job-archive.db";
const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export const archivedRecordId = (job: unknown): string | undefined => record(job)
  ? typeof job.id === "string" ? job.id : typeof job.name === "string" ? `legacy-name:${job.name}` : undefined
  : undefined;
export const jobDigest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export const jobArchivePath = (jobsPath: string) => join(dirname(jobsPath), JOB_ARCHIVE_FILE);
export function archiveWriteError(error: unknown): unknown {
  const e = error as { errcode?: number; code?: string; message?: string };
  return e?.errcode === 5 || e?.errcode === 6 || e?.code === "EBUSY"
    ? Object.assign(new Error("Job archive is busy; retry later. Saved records remain retained.", { cause: error }), { code: "EJOBLOCKED" })
    : error;
}

/** Resolve drive aliases, but never traverse a linked storage entry or ancestor. */
export function physicalArchivePath(path: string): void {
  // A stable alias above the storage home (including Windows drive aliases) is
  // supported. The storage entry and its direct parent must remain physical.
  for (const at of [path, dirname(path)]) {
    if (existsSync(at)) {
      const st = lstatSync(at);
      if (st.isSymbolicLink()) throw new Error("job archive path must be physical; data kept unchanged");
    }
  }
  if (existsSync(path)) realpathSync.native(path);
}

const schema = `
CREATE TABLE job_versions (
  id TEXT NOT NULL, sha256 TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
  observed_at INTEGER NOT NULL, PRIMARY KEY(id,sha256)
);
CREATE TABLE job_records (
  id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT, status TEXT, started_at INTEGER, finished_at INTEGER, metadata TEXT NOT NULL, history_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL, live INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(id,sha256) REFERENCES job_versions(id,sha256)
);
CREATE INDEX job_records_name ON job_records(name);
CREATE TABLE archive_sources (path TEXT NOT NULL, sha256 TEXT NOT NULL, imported_at INTEGER NOT NULL,
  PRIMARY KEY(path,sha256));
CREATE TABLE archive_migrations (version INTEGER PRIMARY KEY, state TEXT NOT NULL);
CREATE TABLE archive_projection (version INTEGER PRIMARY KEY, signature TEXT NOT NULL);
CREATE VIEW v_jobs AS SELECT r.id,r.name,r.status,r.started_at,r.finished_at,r.archived,r.active,r.observed_at,r.sha256,v.payload AS job_json
  FROM job_records r JOIN job_versions v USING(id,sha256);
CREATE VIEW current_jobs AS SELECT * FROM v_jobs;
PRAGMA user_version=1;`;

export function openJobArchive(path: string, writable = false): DatabaseSync | undefined {
  const file = jobArchivePath(path);
  physicalArchivePath(file);
  physicalArchivePath(`${file}-wal`); physicalArchivePath(`${file}-shm`);
  // Preserve the archive containment contract even after its contents move cold.
  physicalArchivePath(join(dirname(path), "archive"));
  if (!writable && !existsSync(file)) return undefined;
  if (writable) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file, { readOnly: !writable, timeout: 100 });
  try {
    db.exec("PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON");
    const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    if (!writable && version === 0) { db.close(); return undefined; }
    if (writable && version < JOB_ARCHIVE_VERSION) {
      // Even a new empty store has a verified pre-DDL backup, using the shared
      // WAL-safe, versioned migration machinery. Never replace a live database.
      migrateSqlite(db, file, true, JOB_ARCHIVE_VERSION, [{ version: 1, sql: schema }], log);
      db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    } else if (version !== JOB_ARCHIVE_VERSION) throw new Error(`unsupported job archive version ${version}; retry later`);
    return db;
  } catch (error) { db.close(); throw archiveWriteError(error); }
}

function metadata(job: Record<string, unknown>): string {
  const out = { ...job };
  // Poll routing and lists need identity/evidence, never retained prompt bodies.
  for (const key of ["prompt", "result", "queuedMessages"]) delete out[key];
  if (typeof job.prompt === "string") out.prompt = job.prompt.slice(0, 300);
  return JSON.stringify(out);
}

/** All distinct serialized records are retained; only the latest row is updated. */
export function putJobRecords(db: DatabaseSync, jobs: readonly unknown[], observedAt = Date.now(), live = true, archived = false): void {
  const prior = db.prepare("SELECT id,sha256,archived,live,observed_at FROM job_records WHERE id=?");
  const retained = db.prepare("SELECT metadata,history_json FROM job_records WHERE id=?");
  const insert = db.prepare("INSERT OR IGNORE INTO job_versions(id,sha256,payload,observed_at) VALUES(?,?,?,?)");
  const update = db.prepare(`INSERT INTO job_records(id,sha256,name,status,started_at,finished_at,metadata,history_json,observed_at,live,archived) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET sha256=excluded.sha256,name=excluded.name,status=excluded.status,
      started_at=excluded.started_at,finished_at=excluded.finished_at,metadata=excluded.metadata,history_json=excluded.history_json,
      observed_at=excluded.observed_at,live=excluded.live,archived=MAX(job_records.archived,excluded.archived)`);
  for (const job of jobs) {
    const id = archivedRecordId(job);
    if (!record(job) || id === undefined) continue;
    const json = JSON.stringify(job), sha = jobDigest(json), old = prior.get(id);
    if (old?.sha256 === sha) {
      if (archived && !old.archived) db.prepare("UPDATE job_records SET archived=1 WHERE id=?").run(id);
      continue;
    }
    insert.run(id, sha, json, observedAt);
    const oldRecord = old ? retained.get(id)! : undefined;
    if (old) {
      const oldJob = JSON.parse(String(oldRecord!.metadata));
      if (job.status === "running" && oldJob.startedAt === job.startedAt && record(oldJob.completionReceipt) &&
          oldJob.completionReceipt.version === 1 && ["done", "failed", "cancelled"].includes(oldJob.status)) continue;
      if (!live && (old.live === 1 || Number(old.observed_at) > observedAt)) continue;
      if (live && old.live === 1 && Number(old.observed_at) > observedAt) continue;
    }
    // Legacy history merged omitted fields across snapshots. Keep that projection
    // separately; the version table and v_jobs retain the exact latest record.
    const merged = { ...(oldRecord ? JSON.parse(String(oldRecord.history_json)) : {}), ...job };
    update.run(id, sha, typeof job.name === "string" ? job.name : null, typeof job.status === "string" ? job.status : null,
      typeof job.startedAt === "number" ? job.startedAt : null, typeof job.finishedAt === "number" ? job.finishedAt : null,
      metadata(merged), JSON.stringify(merged), observedAt, Number(live), Number(archived));
  }
}

export function storeJobRecords(path: string, jobs: readonly unknown[], archived = false): string {
  const db = openJobArchive(path, true)!;
  try {
    db.exec("BEGIN IMMEDIATE");
    try { putJobRecords(db, jobs, Date.now(), true, archived); db.exec("COMMIT"); }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw archiveWriteError(error); }
  } catch (error) { throw archiveWriteError(error); }
  finally { db.close(); }
  return jobArchivePath(path);
}

export interface ArchiveSelection { ids?: ReadonlySet<string>; names?: ReadonlySet<string>; metadata?: boolean; active?: boolean; history?: boolean }
export interface IndexedJobSnapshot { signature: string; jobs: Record<string, unknown>[] }
const cache = new Map<string, IndexedJobSnapshot & { bytes: number }>();
let cacheBytes = 0;
const CACHE_BUDGET = 8 * 1024 * 1024;
export const archiveIndexCounters = { reads: 0, decoded: 0 };
export function readIndexedJobs(path: string, selection: ArchiveSelection = {}): IndexedJobSnapshot {
  const file = jobArchivePath(path);
  physicalArchivePath(file); physicalArchivePath(join(dirname(path), "archive"));
  const signature = [file, `${file}-wal`].map(p => existsSync(p) ? fileSignature(statSync(p)) : "missing").join("|");
  const key = `${file}:${Number(Boolean(selection.metadata))}:${Number(Boolean(selection.active))}:${Number(Boolean(selection.history))}:${JSON.stringify([selection.ids ? [...selection.ids].sort() : null, selection.names ? [...selection.names].sort() : null])}`;
  const saved = cache.get(key);
  if (saved?.signature === signature) { cache.delete(key); cache.set(key, saved); return saved; }
  if (saved) { cacheBytes -= saved.bytes; cache.delete(key); }
  const db = openJobArchive(path);
  if (!db) return { signature, jobs: [] };
  const jobs: Record<string, unknown>[] = [];
  try {
    archiveIndexCounters.reads++;
    const columns = selection.metadata ? "r.metadata" : selection.history ? "r.history_json AS payload" : "v.payload";
    const from = selection.metadata || selection.history ? "job_records r" : "job_records r JOIN job_versions v USING(id,sha256)";
    const decode = (row: Record<string, unknown>) => {
      archiveIndexCounters.decoded++;
      jobs.push(JSON.parse(String(selection.metadata ? row.metadata : row.payload)));
    };
    // Individual indexed probes avoid SQLite parameter limits on large tracked sets.
    if (selection.ids || selection.names) {
      const seen = new Set<string>();
      for (const [field, values] of [["id", selection.ids], ["name", selection.names]] as const) {
        if (!values) continue;
        const query = db.prepare(`SELECT r.id,${columns} FROM ${from} WHERE r.${field}=?${selection.active ? " AND r.active=1" : ""}`);
        for (const value of values) for (const row of query.all(value)) {
          if (!seen.has(String(row.id))) { seen.add(String(row.id)); decode(row); }
        }
      }
    } else for (const row of db.prepare(`SELECT ${columns} FROM ${from}${selection.active ? " WHERE r.active=1" : ""} ORDER BY r.observed_at,r.id`).iterate()) decode(row);
  } catch (error) { throw archiveWriteError(error); }
  finally { db.close(); }
  const next = { signature, jobs, bytes: estimatedJsonBytes(jobs, CACHE_BUDGET) };
  if (next.bytes <= CACHE_BUDGET) {
    cache.set(key, next); cacheBytes += next.bytes;
    while (cacheBytes > CACHE_BUDGET || cache.size > 256) { const first = cache.keys().next().value!; cacheBytes -= cache.get(first)!.bytes; cache.delete(first); }
  }
  return next;
}

/** Bind the compatibility file to an indexed active set only after its rename.
 * An older writer's replacement invalidates this witness immediately. */
export function markJobProjection(path: string, jobs: readonly unknown[], expectedSignature?: string): void {
  physicalArchivePath(path);
  const signature = fileSignature(statSync(path)), db = openJobArchive(path, true)!;
  try {
    if (expectedSignature && signature !== expectedSignature) throw new Error("active jobs changed during archive import; retry later");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("UPDATE job_records SET active=0 WHERE active=1");
      const set = db.prepare("UPDATE job_records SET active=1 WHERE id=?");
      for (const job of jobs) { const id = archivedRecordId(job); if (id !== undefined) set.run(id); }
      db.prepare("INSERT INTO archive_projection(version,signature) VALUES(1,?) ON CONFLICT(version) DO UPDATE SET signature=excluded.signature").run(signature);
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw archiveWriteError(error); }
  } finally { db.close(); }
}

/** Supervisors ask this on every job poll (AB-147): answer from memory while the active file, the
 * archive and its WAL are unchanged, instead of opening the archive database each time. */
const projectionChecks = new Map<string, { signature: string; current: boolean }>();
export function indexedJobProjectionCurrent(path: string): boolean {
  if (!existsSync(path)) return false;
  physicalArchivePath(path);
  const file = jobArchivePath(path);
  const stat = (p: string) => existsSync(p) ? fileSignature(statSync(p)) : "missing";
  const active = fileSignature(statSync(path)), signature = [active, stat(file), stat(`${file}-wal`)].join("|");
  const saved = projectionChecks.get(path);
  if (saved?.signature === signature) return saved.current;
  const db = openJobArchive(path);
  if (!db) return false;
  let current: boolean;
  try { current = db.prepare("SELECT signature FROM archive_projection WHERE version=1").get()?.signature === active; }
  finally { db.close(); }
  if (projectionChecks.size >= 64) projectionChecks.delete(projectionChecks.keys().next().value!);
  projectionChecks.set(path, { signature, current });
  return current;
}

export function readJobVersions(path: string, id: string): Record<string, unknown>[] {
  const db = openJobArchive(path);
  if (!db) return [];
  try { return db.prepare("SELECT payload FROM job_versions WHERE id=? ORDER BY observed_at,rowid").all(id)
    .map(row => cloneJson(JSON.parse(String(row.payload)))); }
  finally { db.close(); }
}
