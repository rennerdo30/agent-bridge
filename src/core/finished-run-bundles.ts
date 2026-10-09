import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE_NAME } from "./constants.js";
import { metadataDb, physicalMetadataPath } from "./metadata-db.js";
import { retainMetadataFiles } from "./metadata-import.js";
import { finishedRunLine } from "./run-archive.js";
import { readRunLogPreview } from "./run-log-preview.js";

const RUN_LOG = /\.log(?:-\d+-[\w-]+)?$/;
/** Bumped in every transaction that writes finished-runs rows; readers use it as a cheap cache signature. */
const REVISION = ["finished-runs-revision", "revision"] as const;
/** Runs that could not be packed: retained in place, skipped until their bytes change (AB-219). */
const FAILURES = "finished-run-pack-failures";

type PackedRun = { name: string; file: string; updatedAt: number; size: number; signature: string; archived: true; meta: Record<string, unknown> };
const runName = (log: string) => basename(log).replace(RUN_LOG, "");

function bumpRevision(db: DatabaseSync): void {
 db.prepare(`INSERT INTO bridge_metadata VALUES (?,?,'1',?) ON CONFLICT(domain,key)
  DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT),updated_at=excluded.updated_at`).run(REVISION[0], REVISION[1], Date.now());
}
function upsertRun(db: DatabaseSync, key: string, value: Record<string, unknown>): void {
 generation++;
 db.prepare("INSERT INTO bridge_metadata VALUES ('finished-runs',?,?,?) ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
  .run(key, JSON.stringify(value), Date.now());
 bumpRevision(db);
}

/** Pack completed runs only. Active logs and unknown completion evidence stay physical.
 * The finished-runs row commits in the same transaction as the retained bundle, before any source moves (AB-227):
 * a crash leaves the run either in place or packed and indexed, never moved and unlisted. */
export function packFinishedRuns(home: string, logs: string[]): number {
 let packed = 0;
 for (const log of logs) {
  physicalMetadataPath(log);
  if (!finishedRunLine(readRunLogPreview(log))) continue;
  const stat = lstatSync(log), metaPath = log.replace(RUN_LOG, ".json"), files: string[] = [];
  let meta: unknown = {};
  if (existsSync(metaPath)) {
   physicalMetadataPath(metaPath);
   try { meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { /* Raw malformed metadata still joins the retained bundle. */ }
   files.push(metaPath);
  }
  files.push(log);
  const source = relative(home, log).replace(/\\/g, "/"), key = runName(log);
  const value = { name: key, updatedAt: stat.mtimeMs, size: stat.size, signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`, archived: true, meta };
  retainMetadataFiles(home, files, (db, path, _raw, cold) => {
   if (path === source) upsertRun(db, key, { ...value, file: cold, bundleSource: source });
  });
  // A source imported before this version (bundle committed, move pending) has no project call; index it now.
  const db = metadataDb(home);
  if (!db.prepare("SELECT 1 FROM bridge_metadata WHERE domain='finished-runs' AND key=?").get(key)) {
   const imported = db.prepare("SELECT cold_path FROM bridge_imports WHERE path=?").get(source);
   if (!imported) throw new Error("Completed run lacks verified retention evidence");
   db.exec("BEGIN IMMEDIATE");
   try { upsertRun(db, key, { ...value, file: String(imported.cold_path), bundleSource: source }); db.exec("COMMIT"); }
   catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  packed++;
 }
 return packed;
}

/** Content-free indexed polling never opens the cold originals or compressed members. */
export function indexedFinishedRuns(home: string): Record<string,unknown>[] {
 return metadataDb(home).prepare("SELECT value FROM bridge_metadata WHERE domain='finished-runs'").all().map(row=>JSON.parse(String(row.value)) as Record<string,unknown>);
}

type CacheEntry = { signature: string; files: string; checkedAt: number; generation: number; records: Map<string, PackedRun> };
const cache = new Map<string, CacheEntry>();
/** Packing in this process invalidates at once; other processes' packing is seen within RECHECK_MS. */
let generation = 0;
export const RECHECK_MS = 2_000;
function toRecord(key: string, value: string): PackedRun | null {
 try {
  const v = JSON.parse(value) as Record<string, unknown>;
  return { name: key, file: String(v.file), updatedAt: Number(v.updatedAt), size: Number(v.size), signature: String(v.signature), archived: true, meta: (v.meta && typeof v.meta === "object" ? v.meta : {}) as Record<string, unknown> };
 } catch { return null; }
}
const copy = (record: PackedRun): PackedRun => ({ ...record, meta: structuredClone(record.meta) });
function fileIdentity(file: string): string {
 return [file, `${file}-wal`].map(path => { try { const s = statSync(path); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return "-"; } }).join("/");
}

/** Packed finished runs as run records for the list readers: one indexed query, no directory scan.
 * file points at the retained original in cold storage (moved, never deleted).
 * Polls stat bridge.db and reuse parsed records; the database is opened only when the file changed, at most
 * once per RECHECK_MS, and rows are parsed only when the finished-runs revision changed (AB-233, AB-245).
 * A busy store serves the last result. */
export function packedRunRecords(home: string, names?: Set<string>): PackedRun[] {
 const file = join(home, DB_FILE_NAME), saved = cache.get(file);
 const pick = (records: Map<string, PackedRun>) => names ? [...names].flatMap(name => { const r = records.get(name); return r ? [copy(r)] : []; }) : [...records.values()].map(copy);
 if (!existsSync(file)) return [];
 const files = fileIdentity(file);
 if (saved && saved.generation === generation && (saved.files === files || Date.now() - saved.checkedAt < RECHECK_MS)) return pick(saved.records);
 // A short-lived read-only connection: polling readers must not keep bridge.db open (Windows file locks).
 let db: DatabaseSync | undefined;
 try {
  db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_metadata'").get()) return [];
  const revision = db.prepare("SELECT value FROM bridge_metadata WHERE domain=? AND key=?").get(REVISION[0], REVISION[1]);
  // Rows written before the revision counter existed fall back to count and last write.
  const signature = revision ? `r:${String(revision.value)}` : (() => {
   const row = db.prepare("SELECT count(*) n,coalesce(max(updated_at),0) m FROM bridge_metadata WHERE domain='finished-runs'").get()!;
   return `c:${row.n}:${row.m}`;
  })();
  if (saved?.signature === signature) {
   Object.assign(saved, { files, checkedAt: Date.now(), generation });
   return pick(saved.records);
  }
  if (names && names.size <= 64) {
   const keys = [...names];
   const rows = db.prepare(`SELECT key,value FROM bridge_metadata WHERE domain='finished-runs' AND key IN (${keys.map(() => "?").join(",")})`).all(...keys);
   return rows.flatMap(row => { const r = toRecord(String(row.key), String(row.value)); return r ? [r] : []; });
  }
  const records = new Map<string, PackedRun>();
  for (const row of db.prepare("SELECT key,value FROM bridge_metadata WHERE domain='finished-runs'").iterate()) {
   const record = toRecord(String(row.key), String(row.value));
   if (record) records.set(record.name, record);
  }
  cache.delete(file); cache.set(file, { signature, files, checkedAt: Date.now(), generation, records });
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return pick(records);
 } catch (error) {
  if (saved) return pick(saved.records);
  throw error;
 } finally { db?.close(); }
}

function archivedLogs(home: string): string[] {
 const dir = join(home, "runs", "archive");
 return existsSync(dir) ? readdirSync(dir).filter(name => RUN_LOG.test(name)).map(name => join(dir, name)) : [];
}

/** Index runs whose originals an earlier version moved to cold storage without committing their finished-runs row. */
export function recoverPackedRuns(home: string, limit = 100): number {
 if (!existsSync(join(home, DB_FILE_NAME))) return 0;
 const db = metadataDb(home);
 let recovered = 0;
 for (const row of db.prepare("SELECT path,cold_path FROM bridge_imports WHERE path LIKE 'runs/%'").all()) {
  const source = String(row.path);
  if (!RUN_LOG.test(source)) continue;
  const key = runName(source), cold = String(row.cold_path);
  if (db.prepare("SELECT 1 FROM bridge_metadata WHERE domain='finished-runs' AND key=?").get(key)) continue;
  // Still in place (bundle committed, move pending): the next pack pass finishes it.
  if (!existsSync(cold) || existsSync(join(home, source))) continue;
  physicalMetadataPath(cold);
  const stat = lstatSync(cold), metaCold = cold.replace(RUN_LOG, ".json");
  let meta: unknown = {};
  if (existsSync(metaCold)) { try { meta = JSON.parse(readFileSync(metaCold, "utf8")); } catch { /* Raw bytes stay retained. */ } }
  db.exec("BEGIN IMMEDIATE");
  try {
   upsertRun(db, key, { name: key, file: cold, bundleSource: source, updatedAt: stat.mtimeMs, size: stat.size, signature: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`, archived: true, meta, recovered: true });
   db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  if (++recovered >= limit) break;
 }
 return recovered;
}

export interface PackFailure { source: string; error: string }

/** Pack already archived, finished runs in bounded batches so Windows never scans thousands of small files (AB-208).
 * Each run packs on its own: a run that cannot be packed stays where it is, is recorded once and is skipped
 * until its bytes change, so it never blocks the others (AB-219). Runs only in maintenance (broker worker, doctor --archive). */
export function packArchivedRuns(home: string, logs?: string[], batch = 100, onFailure?: (failure: PackFailure) => void): number {
 const candidates = logs ?? archivedLogs(home);
 if (!candidates.length && !existsSync(join(home, DB_FILE_NAME))) return 0;
 recoverPackedRuns(home);
 if (!candidates.length) return 0;
 const db = metadataDb(home);
 const failed = new Map(db.prepare("SELECT key,value FROM bridge_metadata WHERE domain=?").all(FAILURES).map(row => [String(row.key), String(row.value)]));
 let packed = 0, attempted = 0;
 for (const log of candidates) {
  if (attempted >= batch) break;
  const source = relative(home, log).replace(/\\/g, "/");
  let signature: string;
  try { const stat = lstatSync(log); signature = `${stat.size}:${stat.mtimeMs}`; } catch { continue; }
  const prior = failed.get(source);
  if (prior) { try { if ((JSON.parse(prior) as { signature?: string }).signature === signature) continue; } catch { /* Retry an unreadable record. */ } }
  try { if (!finishedRunLine(readRunLogPreview(log))) continue; } catch { continue; }
  attempted++;
  try {
   packed += packFinishedRuns(home, [log]);
   if (prior) db.prepare("DELETE FROM bridge_metadata WHERE domain=? AND key=?").run(FAILURES, source);
  } catch (error) {
   if ((error as { code?: string }).code === "STORE_UPGRADE_DEFERRED") throw error;
   const failure = { source, error: String((error as Error).message ?? error) };
   db.prepare("INSERT INTO bridge_metadata VALUES (?,?,?,?) ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(FAILURES, source, JSON.stringify({ ...failure, signature, at: Date.now() }), Date.now());
   onFailure?.(failure);
  }
 }
 return packed;
}
