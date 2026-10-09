import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { metadataDb, physicalMetadataPath } from "./metadata-db.js";
import { retainMetadataFiles } from "./metadata-import.js";
import { storageLease } from "./storage-lock.js";
import { DatabaseSync } from "node:sqlite";

/** Consumption is durable before returning context, even when a broker ACK is lost. */
export class ReadJournal {
 private memory: DatabaseSync | undefined;
 constructor(private readonly home: string) {}
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
 read(identity: string): string[] {
  return this.database().prepare("SELECT message_id FROM bridge_read_receipts WHERE identity=? ORDER BY rowid").all(this.key(identity)).map(r=>String(r.message_id));
 }
 receipt(identity: string, id: string): {read:boolean;at:number|null} {
  const row = this.database().prepare("SELECT read_at FROM bridge_read_receipts WHERE identity=? AND message_id=?").get(this.key(identity),id);
  return {read:!!row,at:row && row.read_at !== null ? Number(row.read_at) : null};
 }
 append(identity: string, ids: string[]): void {
  const release = this.home === ":memory:" ? () => {} : storageLease(this.home);
  try { this.appendRows(identity,ids); } finally { release(); }
 }
 private appendRows(identity: string, ids: string[]): void {
  const db = this.database(), key = this.key(identity), now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
   for (const id of ids) this.insert(db,key,id,now);
   db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
 }
}
