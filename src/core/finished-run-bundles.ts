import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { metadataDb, physicalMetadataPath } from "./metadata-db.js";
import { DatabaseSync } from "node:sqlite";
import { retainMetadataFiles } from "./metadata-import.js";
import { finishedRunLine } from "./run-archive.js";
import { readRunLogPreview } from "./run-log-preview.js";

/** Pack a completed run only. Active logs and unknown completion evidence stay physical. */
export function packFinishedRuns(home: string, logs: string[]): number {
 const db = metadataDb(home), files: string[] = [], records: {key:string;value:Record<string,unknown>;source:string}[] = [];
 for (const log of logs) {
  physicalMetadataPath(log);
  if (!finishedRunLine(readRunLogPreview(log))) continue;
  const stat = lstatSync(log), metaPath = log.replace(/\.log(?:-\d+-[\w-]+)?$/, ".json");
  let meta: unknown = {};
  if (existsSync(metaPath)) {
   physicalMetadataPath(metaPath);
   try { meta = JSON.parse(readFileSync(metaPath,"utf8")); } catch { /* Raw malformed metadata still joins the retained bundle. */ }
   files.push(metaPath);
  }
  files.push(log);
  const source = relative(home,log).replace(/\\/g,"/");
  const key = basename(log).replace(/\.log(?:-\d+-[\w-]+)?$/, "");
  records.push({key,source,value:{name:key,file:log,updatedAt:stat.mtimeMs,size:stat.size,signature:`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,archived:true,meta}});
 }
 retainMetadataFiles(home,files,()=>{});
 db.exec("BEGIN IMMEDIATE");
 try {
  for (const record of records) {
   const imported = db.prepare("SELECT cold_path FROM bridge_imports WHERE path=?").get(record.source);
   if (!imported) throw new Error("Completed run lacks verified retention evidence");
   db.prepare("INSERT INTO bridge_metadata VALUES ('finished-runs',?,?,?) ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(record.key,JSON.stringify({...record.value,file:String(imported.cold_path),bundleSource:record.source}),Date.now());
  }
  db.exec("COMMIT");
 } catch (error) { db.exec("ROLLBACK"); throw error; }
 return records.length;
}

/** Content-free indexed polling never opens the cold originals or compressed members. */
export function indexedFinishedRuns(home: string): Record<string,unknown>[] {
 return metadataDb(home).prepare("SELECT value FROM bridge_metadata WHERE domain='finished-runs'").all().map(row=>JSON.parse(String(row.value)) as Record<string,unknown>);
}

/** Packed finished runs as run records for the list readers: one indexed query, no directory scan.
 * file points at the retained original in cold storage (moved, never deleted). */
export function packedRunRecords(home: string, names?: Set<string>): { name: string; file: string; updatedAt: number; size: number; signature: string; archived: true; meta: Record<string, unknown> }[] {
 // A short-lived read-only connection: polling readers must not keep bridge.db open (Windows file locks).
 const file = join(home, "bridge.db");
 if (!existsSync(file)) return [];
 let rows: Record<string, unknown>[];
 const db = new DatabaseSync(file, { readOnly: true, timeout: 1000 });
 try {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_metadata'").get()) return [];
  rows = db.prepare("SELECT key,value FROM bridge_metadata WHERE domain='finished-runs'").all();
 } finally { db.close(); }
 return rows.flatMap(row => {
  if (names && !names.has(String(row.key))) return [];
  try {
   const v = JSON.parse(String(row.value)) as Record<string, unknown>;
   return [{ name: String(row.key), file: String(v.file), updatedAt: Number(v.updatedAt), size: Number(v.size), signature: String(v.signature), archived: true as const, meta: (v.meta && typeof v.meta === "object" ? v.meta : {}) as Record<string, unknown> }];
  } catch { return []; }
 });
}

/** Pack already archived, finished runs in bounded batches so Windows never scans thousands of small files (AB-208). */
export function packArchivedRuns(home: string, logs: string[], batch = 100): number {
 return logs.length ? packFinishedRuns(home, logs.slice(0, batch)) : 0;
}
