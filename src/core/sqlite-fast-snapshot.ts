import { backup, DatabaseSync } from "node:sqlite";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface FastSnapshotOptions {
 method?: "backup" | "copy";
 /** Only the copy method changes checkpoint state. Live-source rehearsals use backup. */
 allowCheckpoint?: boolean;
 rate?: number;
 onPinned?: (db: DatabaseSync) => void | Promise<void>;
 progress?: (value: {remainingPages:number;totalPages:number}) => void;
}
export interface SnapshotMeasurement { method: string; bytes: number; copyMs: number; verifyMs: number; mibPerSecond: number }

function physical(path: string): void {
 let current = resolve(path);
 for (;;) {
  try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Linked snapshot path retained: ${current}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const parent = dirname(current); if(parent===current) return; current=parent;
 }
}

/** Header bounds plus quick_check. Full integrity_check belongs to an explicit doctor run. */
export function verifyFastSnapshot(file: string): number {
 physical(file);
 const fd = openSync(file,"r");
 let bytes: number;
 try {
  const header = Buffer.alloc(100); bytes = fstatSync(fd).size;
  if (readSync(fd,header,0,100,0)!==100 || header.subarray(0,16).toString("binary")!=="SQLite format 3\0") throw new Error("Invalid snapshot header; retained for investigation.");
  const encoded = header.readUInt16BE(16), pageSize = encoded===1 ? 65536 : encoded, pages = header.readUInt32BE(28);
  if (!pageSize || !pages || pages*pageSize!==bytes) throw new Error("Snapshot page count does not match its file size; retained.");
 } finally { closeSync(fd); }
 const db = new DatabaseSync(file,{readOnly:true});
 try { if (db.prepare("PRAGMA quick_check").all().some(row=>row.quick_check!=="ok")) throw new Error("Snapshot quick_check failed; retained."); }
 finally { db.close(); }
 return bytes;
}

/** Dedicated snapshot connection and async IO keep the caller's broker event loop available. */
export async function fastSnapshot(source: string, destination: string, options: FastSnapshotOptions = {}): Promise<SnapshotMeasurement> {
 physical(source); physical(destination);
 if (resolve(source)===resolve(destination) || existsSync(destination)) throw new Error("Snapshot destination must be new; existing data retained.");
 const method = options.method ?? "backup";
 if (method==="copy" && !options.allowCheckpoint) throw new Error("OS-copy snapshots require explicit checkpoint authorization.");
 const db = new DatabaseSync(source,{readOnly:method==="backup",timeout:0});
 let pinned = false;
 const start = performance.now();
 try {
  if (method==="copy") {
   if (db.prepare("PRAGMA journal_mode").get()!.journal_mode!=="wal") throw new Error("OS-copy fast path requires existing WAL mode; source mode unchanged.");
   let ready = false;
   for (let attempt=0;attempt<50;attempt++) {
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!;
    if (checkpoint.busy===0 && checkpoint.log===0 && checkpoint.checkpointed===0) {
     db.exec("BEGIN"); pinned=true; db.prepare("SELECT count(*) FROM sqlite_schema").get();
     // Close the checkpoint→read-lock race. A nonempty WAL means this reader
     // might require WAL pages absent from the main file, so retry without copying.
     if (!existsSync(`${source}-wal`) || lstatSync(`${source}-wal`).size===0) { ready=true; break; }
     db.exec("ROLLBACK"); pinned=false;
    }
    await delay(20);
   }
   if (!ready) throw Object.assign(new Error("Snapshot checkpoint/read pin is busy; source retained for retry."),{code:"EBUSY"});
   await options.onPinned?.(db);
   await copyFile(source,destination,constants.COPYFILE_EXCL);
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
 const copyMs = performance.now()-start, verifyStart = performance.now(), bytes = verifyFastSnapshot(destination), verifyMs = performance.now()-verifyStart;
 return {method,bytes,copyMs,verifyMs,mibPerSecond:bytes/1024/1024/(copyMs/1000)};
}
