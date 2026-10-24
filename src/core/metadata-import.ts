import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { assertMetadataAdmission, metadataDb, physicalMetadataPath } from "./metadata-db.js";
import { storageLease } from "./storage-lock.js";
import { storageAdmissionRemaining } from "./storage-admission.js";

const LIMIT = 64 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
interface Entry { path: string; sha256: string; bytes: number; data: string }
export interface RetainedBundle { version: 1; entries: Entry[] }

/** Every source byte, including malformed JSON and unknown fields, survives independently of projection. */
/** project runs inside the bundle's commit, before any source moves, and receives the retained original's cold path. */
export function retainMetadataFiles(home: string, files: string[], project: (db: DatabaseSync, path: string, raw: Buffer, cold: string) => void): string[] {
 storageAdmissionRemaining();
 const release = storageLease(home);
 try { return retainFiles(home,files,project); } finally { release(); }
}

function retainFiles(home: string, files: string[], project: (db: DatabaseSync, path: string, raw: Buffer, cold: string) => void): string[] {
 storageAdmissionRemaining();
 assertMetadataAdmission(home);
 const db = metadataDb(home), bundles: string[] = [];
 const pending: { file: string; raw: Buffer; entry: Entry; signature: string }[] = [];
 const flush = () => {
  storageAdmissionRemaining();
  if (!pending.length) return;
  const id = randomUUID(), bundleDir = join(home,"cold","bundles"), originals = join(home,"cold","originals",id);
  physicalMetadataPath(bundleDir); physicalMetadataPath(originals);
  storageAdmissionRemaining();mkdirSync(bundleDir,{recursive:true,mode:0o700});storageAdmissionRemaining();
  const packed: RetainedBundle = {version:1,entries:pending.map(p=>p.entry)};
  const compressed = gzipSync(Buffer.from(JSON.stringify(packed)));
  storageAdmissionRemaining();db.exec("BEGIN IMMEDIATE");
  let bundle: string;
  let offset: number;
  let committing=false;
  try {
   storageAdmissionRemaining();const lookup=db.prepare("SELECT value FROM bridge_metadata WHERE domain='bundle-current' AND key='metadata'");storageAdmissionRemaining();const current=lookup.get();storageAdmissionRemaining();
   const saved = current ? JSON.parse(String(current.value)) as {path:string} : null;
   bundle = saved?.path ?? join(bundleDir,`metadata-v1-${id}.frames.gz`);
   physicalMetadataPath(bundle);
   offset = existsSync(bundle) ? lstatSync(bundle).size : 0;
   if (offset + compressed.length > LIMIT) { bundle = join(bundleDir,`metadata-v1-${id}.frames.gz`); offset = 0; }
   // Independent gzip members rotate into bounded files. A crash leaves an orphan
   // member retained in place; the next writer appends after the actual file size.
   storageAdmissionRemaining();appendFileSync(bundle,compressed,{mode:0o600,flush:true});storageAdmissionRemaining();
   const restored = readBundleFrame(bundle,offset,compressed.length);
  if (restored.version !== 1 || restored.entries.length !== pending.length) throw new Error("Bundle round trip failed; originals retained.");
  restored.entries.forEach((entry,i) => {
   storageAdmissionRemaining();
   const raw = Buffer.from(entry.data,"base64"), source = pending[i]!;
   if (entry.path !== source.entry.path || raw.length !== entry.bytes || hash(raw) !== entry.sha256 || !raw.equals(source.raw)) throw new Error("Bundle byte verification failed; originals retained.");
  });
   for (const source of pending) {
    storageAdmissionRemaining();
    project(db,source.entry.path,source.raw,join(originals,source.entry.path));
    storageAdmissionRemaining();const imported=db.prepare(`INSERT INTO bridge_imports VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO NOTHING`);storageAdmissionRemaining();
    imported.run(source.entry.path,source.entry.sha256,source.raw.length,bundle,join(originals,source.entry.path),Date.now());storageAdmissionRemaining();
    const entry=db.prepare("INSERT INTO bridge_metadata VALUES ('bundle-entry',?,?,?) ON CONFLICT(domain,key) DO NOTHING");storageAdmissionRemaining();
    entry.run(source.entry.path,JSON.stringify({bundle,offset,length:compressed.length}),Date.now());storageAdmissionRemaining();
   }
   storageAdmissionRemaining();const marker=db.prepare("INSERT INTO bridge_metadata VALUES ('bundle-current','metadata',?,?) ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at");storageAdmissionRemaining();
   marker.run(JSON.stringify({path:bundle}),Date.now());storageAdmissionRemaining();
   committing=true;db.exec("COMMIT");committing=false;storageAdmissionRemaining();
  } catch (error) { if(committing)throw Object.assign(new Error('Metadata import COMMIT outcome unknown; originals retained'),{code:'STORE_COMMIT_UNKNOWN',cause:error});if(db.isTransaction)db.exec("ROLLBACK");throw error; }
  for (const source of pending) {
   storageAdmissionRemaining();
   // Revalidate after the durable bundle and transaction, before any move.
   physicalMetadataPath(source.file);
   const stat = lstatSync(source.file);
   if (`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` !== source.signature || !readFileSync(source.file).equals(source.raw)) throw new Error(`Import source changed; retained at ${source.file}`);
   storageAdmissionRemaining();const read=db.prepare("SELECT cold_path FROM bridge_imports WHERE path=?");storageAdmissionRemaining();const cold=String(read.get(source.entry.path)!.cold_path);storageAdmissionRemaining();
   physicalMetadataPath(cold);storageAdmissionRemaining();mkdirSync(dirname(cold),{recursive:true,mode:0o700});storageAdmissionRemaining();
   renameSync(source.file,cold);storageAdmissionRemaining();
  }
  bundles.push(bundle); pending.length = 0;
 };
 let size = 0;
 for (const file of files) {
  storageAdmissionRemaining();
  physicalMetadataPath(file);
  const path = relative(home,file).replace(/\\/g,"/");
  if (path.startsWith("../") || path === "..") throw new Error("Import path escapes bridge home.");
  const stat = lstatSync(file);
  storageAdmissionRemaining();
  if (!stat.isFile() || stat.size > LIMIT) throw new Error(`Import source exceeds bounded bundle size; retained: ${file}`);
  const raw = readFileSync(file), sha256 = hash(raw);
  storageAdmissionRemaining();const read=db.prepare("SELECT sha256,cold_path FROM bridge_imports WHERE path=?");storageAdmissionRemaining();const prior=read.get(path);storageAdmissionRemaining();
  if (prior) {
   if (prior.sha256 !== sha256) throw new Error(`Imported source changed; retained: ${file}`);
   const cold = String(prior.cold_path);
   physicalMetadataPath(cold);
   if (existsSync(cold)) throw new Error(`Both original and cold source exist; retained: ${file}`);
   storageAdmissionRemaining();mkdirSync(dirname(cold),{recursive:true,mode:0o700});storageAdmissionRemaining();renameSync(file,cold);storageAdmissionRemaining();continue;
  }
  if (size + raw.length > LIMIT) { flush(); size = 0; }
  pending.push({file,raw,entry:{path,bytes:raw.length,sha256,data:raw.toString("base64")},signature:`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`});
  size += raw.length;
 }
 flush(); return bundles;
}

export function readBundleFrame(file: string, offset: number, length: number): RetainedBundle {
 storageAdmissionRemaining();
 if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || length > LIMIT * 2) throw new Error("Invalid bundle frame bounds");
 physicalMetadataPath(file);
 const fd = openSync(file,"r"), compressed = Buffer.alloc(length);
 try {
  let at = 0;
  while (at < length) {storageAdmissionRemaining();const n = readSync(fd,compressed,at,length-at,offset+at);storageAdmissionRemaining();if (!n) throw new Error("Incomplete retained bundle frame"); at += n; }
 } finally { closeSync(fd); }
 storageAdmissionRemaining();const raw=gunzipSync(compressed,{maxOutputLength:LIMIT * 2});storageAdmissionRemaining();return JSON.parse(raw.toString("utf8")) as RetainedBundle;
}

/** Explicit content reads verify the indexed member and source manifest again. */
export function readRetainedMetadataFile(home: string, path: string): Buffer | null {
 const db = metadataDb(home), row = db.prepare("SELECT value FROM bridge_metadata WHERE domain='bundle-entry' AND key=?").get(path);
 if (!row) return null;
 const frame = JSON.parse(String(row.value)) as {bundle:string;offset:number;length:number};
 const bundle = readBundleFrame(frame.bundle,frame.offset,frame.length), entry = bundle.entries.find(item=>item.path===path);
 if (bundle.version !== 1 || !entry) throw new Error("Retained bundle manifest lacks its indexed source");
 const raw = Buffer.from(entry.data,"base64");
 if (raw.length !== entry.bytes || hash(raw) !== entry.sha256) throw new Error("Retained bundle source checksum failed");
 return raw;
}

/**
 * 0.30.4 stamped imported presence rows with the import time, so stale legacy readers looked current and blocked
 * upgrades (AB-256). Once, restore each row that was not rewritten since its import to its retained original's
 * time. Only the timestamp changes; values, originals and bundles stay as they are.
 */
function repairImportedTimes(db: ReturnType<typeof metadataDb>, domain: string): void {
 storageAdmissionRemaining();
 const marker = `repair:import-times:${domain}`;
 const markerRead=db.prepare("SELECT 1 FROM bridge_components WHERE name=?");storageAdmissionRemaining();const present=markerRead.get(marker);storageAdmissionRemaining();if(present)return;
 const read=db.prepare("SELECT m.key AS key, m.updated_at AS updated, i.imported_at AS imported, i.cold_path AS cold FROM bridge_metadata m JOIN bridge_imports i ON i.path = ? || '/' || m.key || '.json' WHERE m.domain = ?");storageAdmissionRemaining();const rows=read.all(domain,domain);
 storageAdmissionRemaining();
 const update = db.prepare("UPDATE bridge_metadata SET updated_at=? WHERE domain=? AND key=? AND updated_at=?");
 storageAdmissionRemaining();db.exec("BEGIN IMMEDIATE");let committing=false;
 try {
  for (const row of rows) {
   storageAdmissionRemaining();
   const updated = Number(row.updated), imported = Number(row.imported);
   // A row rewritten by a live reader after the import already carries its own current time.
   if (!Number.isFinite(updated) || !Number.isFinite(imported) || Math.abs(updated - imported) > 60_000) continue;
   let at: number;
   try { at = statSync(String(row.cold)).mtimeMs; } catch {storageAdmissionRemaining();continue;}
   storageAdmissionRemaining();if (at < updated) update.run(Math.round(at), domain, String(row.key), row.updated as number);storageAdmissionRemaining();
  }
  storageAdmissionRemaining();const insert=db.prepare("INSERT INTO bridge_components VALUES (?,1) ON CONFLICT(name) DO NOTHING");storageAdmissionRemaining();insert.run(marker);storageAdmissionRemaining();
  committing=true;db.exec("COMMIT");committing=false;storageAdmissionRemaining();
 } catch (error) {if(committing)throw Object.assign(new Error('Imported timestamp repair COMMIT outcome unknown'),{code:'STORE_COMMIT_UNKNOWN',cause:error});if(db.isTransaction)db.exec("ROLLBACK");throw error;}
}

/** One initial import scan. The committed component marker prevents steady-state scans. */
export function importMetadataDomain(home: string, domain: string, extension = ".json", nested = false): void {
 storageAdmissionRemaining();
 const db = metadataDb(home), component = `import:${domain}`;
 const read=db.prepare("SELECT 1 FROM bridge_components WHERE name=?");storageAdmissionRemaining();const present=read.get(component);storageAdmissionRemaining();if(present) {
  storageAdmissionRemaining();
  if (domain === "storage-capabilities") repairImportedTimes(db, domain);
  return;
 }
 const root = join(home,domain), files: string[] = [];
 physicalMetadataPath(root);
 if (existsSync(root)) for (const name of readdirSync(root)) {
  storageAdmissionRemaining();
  const path = join(root,name); physicalMetadataPath(path);
  if (lstatSync(path).isFile() && name.endsWith(extension)) files.push(path);
  else if (nested && /^[a-f0-9]{64}$/.test(name) && lstatSync(path).isDirectory()) {
   for (const file of readdirSync(path)) {storageAdmissionRemaining();if (file.endsWith(extension)) files.push(join(path,file));}
  }
 }
 // A row keeps the time its source file was last written: presence records judge staleness by it (AB-256).
 const writtenAt = new Map(files.map(file => {storageAdmissionRemaining();const at=statSync(file).mtimeMs;storageAdmissionRemaining();return [resolve(file).toLowerCase(),at] as const;}));
 storageAdmissionRemaining();
 retainMetadataFiles(home,files,(store,path,raw) => {
  const key = path.slice(domain.length+1).slice(0,-extension.length);
  const at = Math.round(writtenAt.get(resolve(home,path).toLowerCase()) ?? Date.now());
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")); } catch { return; }
  storageAdmissionRemaining();const insert=store.prepare("INSERT INTO bridge_metadata VALUES (?,?,?,?) ON CONFLICT(domain,key) DO NOTHING");storageAdmissionRemaining();insert.run(domain,key,JSON.stringify(value),at);storageAdmissionRemaining();
 });
 storageAdmissionRemaining();const marker=db.prepare("INSERT INTO bridge_components VALUES (?,1) ON CONFLICT(name) DO NOTHING");storageAdmissionRemaining();marker.run(component);storageAdmissionRemaining();
}
