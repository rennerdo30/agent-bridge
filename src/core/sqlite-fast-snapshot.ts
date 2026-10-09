import { backup, DatabaseSync } from "node:sqlite";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";

export interface FastSnapshotOptions {
 method?: "backup" | "copy";
 /** Only the copy method changes checkpoint state; it requires explicit authorization. */
 allowCheckpoint?: boolean;
 rate?: number;
 onPinned?: (db: DatabaseSync) => void | Promise<void>;
 progress?: (value: {remainingPages:number;totalPages:number}) => void;
}
export interface SnapshotMeasurement { method: string; bytes: number; copyMs: number; verifyMs: number; mibPerSecond: number; startedAt: string; copiedAt: string; verifiedAt: string; checkpointAttempts: number }

function physical(path: string): void {
 let current = resolve(path);
 for (;;) {
  try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Linked snapshot path retained: ${current}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const parent = dirname(current); if(parent===current) return; current=parent;
 }
}

/** Header bounds plus quick_check. Full integrity_check belongs to an explicit doctor run. */
function snapshotHeader(file: string): number {
 physical(file);
 const fd = openSync(file,"r");
 let bytes: number;
 try {
  const header = Buffer.alloc(100); bytes = fstatSync(fd).size;
  if (readSync(fd,header,0,100,0)!==100 || header.subarray(0,16).toString("binary")!=="SQLite format 3\0") throw new Error("Invalid snapshot header; retained for investigation.");
  const encoded = header.readUInt16BE(16), pageSize = encoded===1 ? 65536 : encoded, pages = header.readUInt32BE(28);
  if (!pageSize || !pages || pages*pageSize!==bytes) throw new Error("Snapshot page count does not match its file size; retained.");
 } finally { closeSync(fd); }
 return bytes;
}

export function verifyFastSnapshot(file: string): number {
 const bytes = snapshotHeader(file);
 const db = new DatabaseSync(file,{readOnly:true});
 try { if (db.prepare("PRAGMA quick_check").all().some(row=>row.quick_check!=="ok")) throw new Error("Snapshot quick_check failed; retained."); }
 finally { db.close(); }
 return bytes;
}

/** Large quick_check scans run away from the broker's event loop. */
async function verifyInWorker(file: string): Promise<number> {
 const bytes = snapshotHeader(file);
 await new Promise<void>((resolvePromise,reject) => {
  const worker = new Worker(`
   const { workerData, parentPort } = require('node:worker_threads');
   const { DatabaseSync } = require('node:sqlite');
   const db = new DatabaseSync(workerData,{readOnly:true});
   try {
    if (db.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok')) throw new Error('Snapshot quick_check failed; retained.');
    parentPort.postMessage('ok');
   } finally { db.close(); }
  `,{eval:true,workerData:file});
  worker.once('error',reject);
  worker.once('exit',code => code===0 ? resolvePromise() : reject(new Error(`Snapshot verification worker exited ${code}; retained.`)));
 });
 return bytes;
}

/** Dedicated snapshot connection and async IO keep the caller's broker event loop available. */
export async function fastSnapshot(source: string, destination: string, options: FastSnapshotOptions = {}): Promise<SnapshotMeasurement> {
 physical(source); physical(destination);
 if (resolve(source)===resolve(destination) || existsSync(destination)) throw new Error("Snapshot destination must be new; existing data retained.");
 const method = options.method ?? "backup";
 if (method==="copy" && !options.allowCheckpoint) throw new Error("OS-copy snapshots require explicit checkpoint authorization.");
 const db = new DatabaseSync(source,{readOnly:method==="backup",timeout:method==="copy" ? 2_000 : 0});
 let pinned = false;
 let fallback = false, checkpointAttempts = 0;
 const startedAt = new Date().toISOString();
 const start = performance.now();
 try {
  if (method==="copy") {
   if (db.prepare("PRAGMA journal_mode").get()!.journal_mode!=="wal") throw new Error("OS-copy fast path requires existing WAL mode; source mode unchanged.");
   let ready = false;
   for (let attempt=0;attempt<3;attempt++) {
    checkpointAttempts++;
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!;
    if (checkpoint.busy===0 && checkpoint.log===0 && checkpoint.checkpointed===0) {
     db.exec("BEGIN"); pinned=true; db.prepare("SELECT count(*) FROM sqlite_schema").get();
     // Close the checkpoint→read-lock race. A nonempty WAL means this reader
     // might require WAL pages absent from the main file, so retry without copying.
     if (!existsSync(`${source}-wal`) || lstatSync(`${source}-wal`).size===0) { ready=true; break; }
     db.exec("ROLLBACK"); pinned=false;
    }
    if (attempt<2) await delay(5_000);
   }
   if (!ready) fallback=true;
   else {
    await options.onPinned?.(db);
    await copyFile(source,destination,constants.COPYFILE_EXCL);
   }
  } else {
   db.exec("BEGIN"); pinned=true; db.prepare("SELECT count(*) FROM sqlite_schema").get();
   await options.onPinned?.(db);
   // backup() overwrites its destination. Reserve a new empty file exclusively;
   // this operation is allowed to initialize only the file just created here.
   const fd = openSync(destination,"wx",0o600); closeSync(fd);
   await backup(db,destination,{rate:options.rate ?? 16_384,...(options.progress ? {progress:options.progress} : {})});
  }
 } finally {
 if(pinned) db.exec("ROLLBACK"); db.close();
 }
 if (fallback) {
  const result = await fastSnapshot(source,destination,{...options,method:"backup",allowCheckpoint:false});
  return {...result,startedAt,checkpointAttempts};
 }
 const copiedAt = new Date().toISOString(), copyMs = performance.now()-start, verifyStart = performance.now(), bytes = await verifyInWorker(destination), verifyMs = performance.now()-verifyStart;
 return {method,bytes,copyMs,verifyMs,mibPerSecond:bytes/1024/1024/(copyMs/1000),startedAt,copiedAt,verifiedAt:new Date().toISOString(),checkpointAttempts};
}
