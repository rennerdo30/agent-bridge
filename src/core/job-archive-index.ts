import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cloneJson, estimatedJsonBytes, fileSignature } from "./file-cache.js";
import { migrateSqlite } from "./sqlite-migrations.js";
import { SQLITE_BUSY_TIMEOUT_MS } from "./sqlite-policy.js";
import type { Logger } from "./logger.js";
import { openPreservedReader } from "./storage-preservation.js";
import { drainScan, SCAN_SLICE_MS, SCAN_STEPS_PER_SLICE } from "./responsive-scan.js";

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
      let st: ReturnType<typeof lstatSync>;
      try { st = lstatSync(at); } catch (error) {
        // A SQLite -shm/-wal sidecar can vanish between the existence check
        // and the lstat when another connection checkpoints or closes.
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        throw error;
      }
      if (st.isSymbolicLink()) throw new Error("job archive path must be physical; data kept unchanged");
    }
  }
  try {
    if (existsSync(path)) realpathSync.native(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
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

export function openJobArchive(path: string, writable = false, options: { preserveInputs?: boolean } = {}): DatabaseSync | undefined {
  const file = jobArchivePath(path);
  physicalArchivePath(file);
  physicalArchivePath(`${file}-wal`); physicalArchivePath(`${file}-shm`);
  // Preserve the archive containment contract even after its contents move cold.
  physicalArchivePath(join(dirname(path), "archive"));
  if (!writable && !existsSync(file)) return undefined;
  if (writable) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Wait out transient writer locks like every other store (AB-255): 100 ms is
  // routinely exceeded by a concurrent archive migration on a loaded runner.
  if (writable && options.preserveInputs) throw new Error("Preserved job archive inputs are readonly.");
  const db = options.preserveInputs ? openPreservedReader(file, SQLITE_BUSY_TIMEOUT_MS)
    : new DatabaseSync(file, { readOnly: !writable, timeout: SQLITE_BUSY_TIMEOUT_MS });
  try {
    db.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}; PRAGMA foreign_keys=ON`);
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

/**
 * `previous` is the active projection about to be replaced. When this index
 * published it, its records are already retained and may since have been
 * superseded (a continued job archived on completion): keep their versions but
 * never let them overwrite a newer row. A projection written by another
 * (older) writer is authoritative and indexed as live data.
 */
export function storeJobRecords(path: string, jobs: readonly unknown[], archived = false, previous: readonly unknown[] = []): string {
  const db = openJobArchive(path, true)!;
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      if (previous.length) {
        const published = existsSync(path) && db.prepare("SELECT signature FROM archive_projection WHERE version=1").get()?.signature === fileSignature(statSync(path, { bigint: true }));
        putJobRecords(db, previous, now, !published);
      }
      putJobRecords(db, jobs, now, true, archived);
      db.exec("COMMIT");
    }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw archiveWriteError(error); }
  } catch (error) { throw archiveWriteError(error); }
  finally { db.close(); }
  return jobArchivePath(path);
}

export interface ArchiveSelection { ids?: ReadonlySet<string>; names?: ReadonlySet<string>; metadata?: boolean; active?: boolean; history?: boolean }
export interface IndexedJobSnapshot { signature: string; jobs: Record<string, unknown>[] }
const cache = new Map<string, IndexedJobSnapshot & { bytes: number }>();
/** Decoded rows of the last full read per selection, keyed by id with the row's sha256. A row's metadata and
 * history are written only together with a new sha256 (putJobRecords), so an unchanged sha256 means unchanged JSON.
 * Any archive write changes the WAL signature; without this, every broker request re-decoded all records (AB-300). */
type DecodedRows = Map<string, { sha: string; job: Record<string, unknown> }>;
const decodedRows = new Map<string, { rows: DecodedRows; bytes: number }>();
const DECODED_CACHE_KEYS = 16;
let decodedBytes = 0;
let cacheBytes = 0;
// The dashboard's full metadata listing must fit: at 8 MB a home with ~1,700 jobs (one with a 6 MB delivery
// history) was never cached, so every refresh decoded every job again (about a quarter of a core).
const CACHE_BUDGET = 32 * 1024 * 1024;
export const archiveIndexCounters = { reads: 0, decoded: 0 };
/** Separate from snapshot validity: WAL changes invalidate snapshots, not unchanged decoded rows. */
export function archiveDecodedCacheUsage(): { entries: number; bytes: number; maxEntries: number; maxBytes: number } {
  return { entries: decodedRows.size, bytes: decodedBytes, maxEntries: DECODED_CACHE_KEYS, maxBytes: CACHE_BUDGET };
}
function touchDecodedRows(key: string): DecodedRows | undefined {
  const saved = decodedRows.get(key);
  if (saved) { decodedRows.delete(key); decodedRows.set(key, saved); }
  return saved?.rows;
}
function retainDecodedRows(key: string, rows: DecodedRows): void {
  const prior = decodedRows.get(key);
  if (prior) { decodedBytes -= prior.bytes; decodedRows.delete(key); }
  const bytes = estimatedJsonBytes([key, [...rows]], CACHE_BUDGET);
  if (bytes > CACHE_BUDGET) return;
  decodedRows.set(key, { rows, bytes }); decodedBytes += bytes;
  while (decodedRows.size > DECODED_CACHE_KEYS || decodedBytes > CACHE_BUDGET) {
    const first = decodedRows.keys().next().value!;
    decodedBytes -= decodedRows.get(first)!.bytes; decodedRows.delete(first);
  }
}
export function readIndexedJobs(path: string, selection: ArchiveSelection = {}): IndexedJobSnapshot {
  return drainScan(readIndexedJobSteps(path, false, selection));
}

/** Indexed reads must yield between bounded row batches too: one decode loop can exhaust
 * the responsive traversal's entire budget before its next suspension. */
export function* readIndexedJobSteps(path: string, responsive = false, selection: ArchiveSelection = {}): Generator<void, IndexedJobSnapshot> {
  const file = jobArchivePath(path);
  physicalArchivePath(file); physicalArchivePath(join(dirname(path), "archive"));
  const signature = [file, `${file}-wal`].map(p => existsSync(p) ? fileSignature(statSync(p, { bigint: true })) : "missing").join("|");
  const key = `${file}:${Number(Boolean(selection.metadata))}:${Number(Boolean(selection.active))}:${Number(Boolean(selection.history))}:${JSON.stringify([selection.ids ? [...selection.ids].sort() : null, selection.names ? [...selection.names].sort() : null])}`;
  const previousDecoded = touchDecodedRows(key);
  const saved = cache.get(key);
  if (saved?.signature === signature) { cache.delete(key); cache.set(key, saved); return saved; }
  if (saved) { cacheBytes -= saved.bytes; cache.delete(key); }
  const db = openJobArchive(path);
  if (!db) return { signature, jobs: [] };
  const jobs: Record<string, unknown>[] = [];
  let currentDecoded: DecodedRows | undefined;
  try {
    const home = dirname(file), archive = join(home, "archive");
    const bound = responsive ? [home, file, archive].filter(at => existsSync(at)).map(at => {
      const st = lstatSync(at, { bigint: true });
      return { at, dev: st.dev, ino: st.ino };
    }) : [];
    const unchanged = () => {
      if (!responsive) return;
      if (bound.some(({ at, dev, ino }) => {
        const st = lstatSync(at, { bigint: true });
        return st.isSymbolicLink() || st.dev !== dev || st.ino !== ino;
      })) throw new Error("job archive ancestor changed during traversal; data kept unchanged");
      for (const at of [archive, `${file}-wal`, `${file}-shm`]) {
        try { if (lstatSync(at).isSymbolicLink()) throw new Error("job archive path must be physical; data kept unchanged"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    };
    // Validate once per bounded batch, not once per row. Native path queries on
    // Windows otherwise dominate the scan while the opened handles stay pinned.
    let batchStarted = performance.now(), batchSteps = SCAN_STEPS_PER_SLICE;
    function* beforeStep(): Generator<void> {
      if (responsive && (batchSteps >= SCAN_STEPS_PER_SLICE || performance.now() - batchStarted >= SCAN_SLICE_MS)) {
        yield;
        unchanged();
        batchSteps = 0; batchStarted = performance.now();
      }
      batchSteps++;
    }
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
        for (const value of values) {
          yield* beforeStep(); // Missing IDs still consume a bounded native query step.
          for (const row of query.iterate(value)) {
            yield* beforeStep();
            if (!seen.has(String(row.id))) { seen.add(String(row.id)); decode(row); }
          }
        }
      }
    } else {
      // Only rows whose sha256 changed since the last full read of this selection are decoded again.
      const current: DecodedRows = new Map();
      let one: ReturnType<DatabaseSync["prepare"]> | undefined;
      for (const row of db.prepare(`SELECT r.id,r.sha256 FROM ${from}${selection.active ? " WHERE r.active=1" : ""} ORDER BY r.observed_at,r.id`).iterate()) {
        yield* beforeStep();
        const id = String(row.id), sha = String(row.sha256), known = previousDecoded?.get(id);
        if (known?.sha === sha) { jobs.push(known.job); current.set(id, known); continue; }
        const full = (one ??= db.prepare(`SELECT ${columns} FROM ${from} WHERE r.id=? AND r.sha256=?`)).get(id, sha);
        if (!full) continue;
        decode(full);
        current.set(id, { sha, job: jobs[jobs.length - 1]! });
      }
      currentDecoded = current;
    }
    unchanged();
  } catch (error) { throw archiveWriteError(error); }
  finally { db.close(); }
  if (currentDecoded) retainDecodedRows(key, currentDecoded);
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
  const signature = fileSignature(statSync(path, { bigint: true })), db = openJobArchive(path, true)!;
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
export function indexedJobProjectionCurrent(path: string, expectedIndexSignature?: string): boolean {
  if (!existsSync(path)) return false;
  physicalArchivePath(path);
  const file = jobArchivePath(path);
  const stat = (p: string) => existsSync(p) ? fileSignature(statSync(p, { bigint: true })) : "missing";
  const indexSignature = () => [stat(file), stat(`${file}-wal`)].join("|");
  const observedIndex = indexSignature();
  // A newer projection witness cannot authorize rows read from an older index.
  if (expectedIndexSignature !== undefined && expectedIndexSignature !== observedIndex) return false;
  const active = fileSignature(statSync(path, { bigint: true })), signature = [active, observedIndex].join("|");
  const saved = projectionChecks.get(path);
  if (saved?.signature === signature) return saved.current &&
    (expectedIndexSignature === undefined || indexSignature() === expectedIndexSignature);
  const db = openJobArchive(path);
  if (!db) return false;
  let current: boolean;
  try { current = db.prepare("SELECT signature FROM archive_projection WHERE version=1").get()?.signature === active; }
  finally { db.close(); }
  // A worker may publish while the witness query runs. Fall back to the active
  // JSON rather than using metadata from a different committed generation.
  if (expectedIndexSignature !== undefined && indexSignature() !== expectedIndexSignature) return false;
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
