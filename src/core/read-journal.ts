import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { closeMetadataDb, metadataDb, metadataDbOpen, metadataReaderRetained, physicalMetadataPath } from "./metadata-db.js";
import { retainMetadataFiles } from "./metadata-import.js";
import { storageLease } from "./storage-lock.js";
import { DatabaseSync } from "node:sqlite";
import type { Logger } from "./logger.js";

/** The metadata store cannot open yet: its fail-closed migration lease needs this process's
 * verified identity (ELEASEBUSY) or an older reader still uses the files (STORE_UPGRADE_DEFERRED). */
const DEFERRED_CODES = new Set(["ELEASEBUSY", "STORE_UPGRADE_DEFERRED"]);
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
/** Per home: when the next attempt to open the metadata store is due, and its retry timer. */
const deferrals = new Map<string, { until: number; delay: number; timer: NodeJS.Timeout | null }>();

/** Consumption is durable before returning context, even when a broker ACK is lost. */
export class ReadJournal {
 private memory: DatabaseSync | undefined;
 constructor(private readonly home: string, private readonly log?: Logger) {}
 private key(identity: string) { return createHash("sha256").update(identity).digest("hex"); }
 private insert(db: ReturnType<typeof metadataDb>, identity: string, id: string, at: number | null) {
  db.prepare(`INSERT INTO bridge_read_receipts VALUES (?,?,?) ON CONFLICT(identity,message_id)
   DO UPDATE SET read_at=CASE WHEN read_at IS NULL THEN excluded.read_at
   WHEN excluded.read_at IS NULL THEN read_at ELSE MIN(read_at,excluded.read_at) END`).run(identity,id,at);
 }
 private database() {
  if (this.home === ":memory:") {
   if (!this.memory) { this.memory = new DatabaseSync(":memory:"); this.memory.exec("CREATE TABLE bridge_read_receipts(identity TEXT NOT NULL,message_id TEXT NOT NULL,read_at INTEGER,PRIMARY KEY(identity,message_id))"); }
   return this.memory;
  }
  const db = metadataDb(this.home);
  if (db.prepare("SELECT 1 FROM bridge_components WHERE name='import:read-state'").get()) return db;
  const dir = join(this.home,"read-state"); physicalMetadataPath(dir);
  const files = existsSync(dir) ? readdirSync(dir).filter(f => /^[a-f0-9]{64}\.jsonl$/.test(f)).map(f=>join(dir,f)) : [];
  retainMetadataFiles(this.home,files,(store,path,raw) => {
   const identity = path.slice("read-state/".length,-".jsonl".length);
   for (const line of raw.toString("utf8").split("\n")) {
    try {
     const value: unknown = JSON.parse(line);
     const timed = value && typeof value === "object" && !Array.isArray(value) ? value as {ids?:unknown;at?:unknown} : null;
     const ids = timed?.ids ?? value;
     if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") this.insert(store,identity,id,typeof timed?.at === "number" ? timed.at : null);
    } catch { /* Interrupted/malformed bytes remain in the verified bundle and cold original. */ }
   }
  });
  db.prepare("INSERT INTO bridge_components VALUES ('import:read-state',1) ON CONFLICT(name) DO NOTHING").run();
  return db;
 }
 /**
  * The metadata store, or undefined while it is deferred. Until then read marks use the
  * pre-AB-208 journal files, which the store imports verbatim as soon as it opens: a deferral
  * only happens before the read-state import, so nothing written meanwhile is missed.
  */
 private available(): DatabaseSync | undefined {
  if (this.home === ":memory:") return this.database();
  const deferred = deferrals.get(this.home);
  if (deferred && Date.now() < deferred.until) return undefined;
  try {
   const db = this.database();
   if (deferred) {
    if (deferred.timer) clearTimeout(deferred.timer);
    deferrals.delete(this.home);
    this.log?.info("metadata store available: read marks from the journal files were imported");
   }
   return db;
  } catch (error) {
   if (!DEFERRED_CODES.has(String((error as { code?: unknown }).code))) throw error;
   const delay = deferred ? Math.min(MAX_RETRY_MS, deferred.delay * 2) : FIRST_RETRY_MS;
   if (!deferred) this.log?.warn("metadata store deferred; read marks are kept in the read-state journal files until it opens", { err: String((error as Error).message ?? error) });
   if (deferred?.timer) clearTimeout(deferred.timer);
   // Retry in the background, so the journal files are imported even without further reads.
   // The retry may fire after every node of this home stopped and released the shared handle.
   // A handle it opens then would stay cached with no owner left to close it, keeping bridge.db
   // locked on Windows, so it closes what it opened unless a live node still shares the handle.
   const timer = setTimeout(() => {
    // A timer can fire a little before Date.now() reaches `until`; the retry is due now, or it would never run again.
    const due = deferrals.get(this.home);
    if (due?.timer === timer) due.until = 0;
    const opened = !metadataDbOpen(this.home);
    try { this.available(); } catch { /* Retried on the next read or mark. */ }
    finally { if (opened && !metadataReaderRetained(this.home)) closeMetadataDb(this.home); }
   }, delay);
   timer.unref();
   deferrals.set(this.home, { until: Date.now() + delay, delay, timer });
   return undefined;
  }
 }
 private legacyPath(identity: string) { return join(this.home,"read-state",`${this.key(identity)}.jsonl`); }
 private legacyEntries(identity: string): { ids: string[]; at: number | null }[] {
  let raw: string;
  try { raw = readFileSync(this.legacyPath(identity),"utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return raw.split("\n").flatMap(line => {
   if (!line) return [];
   try {
    const value: unknown = JSON.parse(line);
    const timed = value && typeof value === "object" && !Array.isArray(value) ? value as {ids?:unknown;at?:unknown} : null;
    const ids = timed?.ids ?? value;
    return Array.isArray(ids) ? [{ ids: ids.filter((id): id is string => typeof id === "string"), at: typeof timed?.at === "number" ? timed.at : null }] : [];
   } catch { return []; } // An interrupted final append does not invalidate earlier records.
  });
 }
 read(identity: string): string[] {
  const db = this.available();
  if (!db) return [...new Set(this.legacyEntries(identity).flatMap(entry => entry.ids))];
  return db.prepare("SELECT message_id FROM bridge_read_receipts WHERE identity=? ORDER BY rowid").all(this.key(identity)).map(r=>String(r.message_id));
 }
 receipt(identity: string, id: string): {read:boolean;at:number|null} {
  const db = this.available();
  if (!db) {
   const entries = this.legacyEntries(identity).filter(entry => entry.ids.includes(id));
   const times = entries.flatMap(entry => entry.at === null ? [] : [entry.at]);
   return {read:entries.length > 0,at:times.length ? Math.min(...times) : null};
  }
  const row = db.prepare("SELECT read_at FROM bridge_read_receipts WHERE identity=? AND message_id=?").get(this.key(identity),id);
  return {read:!!row,at:row && row.read_at !== null ? Number(row.read_at) : null};
 }
 append(identity: string, ids: string[]): void {
  const release = this.home === ":memory:" ? () => {} : storageLease(this.home);
  try {
   const db = this.available();
   if (db) this.appendRows(db,identity,ids);
   else {
    const dir = join(this.home,"read-state"); physicalMetadataPath(dir);
    mkdirSync(dir,{recursive:true,mode:0o700});
    appendFileSync(this.legacyPath(identity),`\n${JSON.stringify({ids,at:Date.now()})}\n`,{mode:0o600,flush:true});
   }
  } finally { release(); }
 }
 private appendRows(db: DatabaseSync, identity: string, ids: string[]): void {
  const key = this.key(identity), now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
   for (const id of ids) this.insert(db,key,id,now);
   db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
 }
}
