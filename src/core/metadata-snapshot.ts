import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const quote = (name: string) => `"${name.replaceAll('"','""')}"`;
const encode = (row: unknown) => JSON.stringify(row,(_,value) => typeof value === 'bigint' ? {bigint:String(value)} : value);

/** Scope is explicit: this is an additive-component recovery snapshot, never a full DB restore. */
export function snapshotMetadataTables(source: DatabaseSync, file: string, tables: readonly string[], component: string, targetVersion: number): void {
 if (existsSync(file) || existsSync(`${file}.manifest.json`)) throw new Error("Metadata snapshot destination exists; retained.");
 const snapshot = new DatabaseSync(file);
 const manifest = {version:1,kind:"metadata-component-snapshot",component,targetVersion,
  sourceVersion:Number(source.prepare("PRAGMA user_version").get()!.user_version),
  schema:[] as Record<string,unknown>[],tables:[] as {name:string;rows:number;sha256:string;existed:boolean}[]};
 source.exec("BEGIN");
 try {
  manifest.schema = source.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  snapshot.exec("BEGIN");
  for (const name of tables) {
   const schema=source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
   if (!schema) {manifest.tables.push({name,rows:0,sha256:createHash('sha256').digest('hex'),existed:false});continue;}
   if (typeof schema.sql !== 'string') throw new Error(`Metadata table has no schema: ${name}`);
   snapshot.exec(schema.sql);
   const columns=source.prepare(`PRAGMA table_info(${quote(name)})`).all().map(row=>String(row.name));
   const insert=snapshot.prepare(`INSERT INTO ${quote(name)} (${columns.map(quote).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
   const expected=createHash('sha256'), actual=createHash('sha256'); let rows=0, verified=0;
   const query=`SELECT ${columns.map(quote).join(',')} FROM ${quote(name)} ORDER BY ${columns.map(quote).join(',')}`;
   const read=source.prepare(query);read.setReadBigInts(true);
   for (const row of read.iterate()) {insert.run(...columns.map(column=>row[column]!));expected.update(encode(row));rows++;}
   const check=snapshot.prepare(query);check.setReadBigInts(true);
   for (const row of check.iterate()) {actual.update(encode(row));verified++;}
   const sha256=expected.digest('hex');
   if (verified!==rows || actual.digest('hex')!==sha256) throw new Error(`Metadata snapshot round-trip mismatch: ${name}`);
   manifest.tables.push({name,rows,sha256,existed:true});
  }
  snapshot.exec("COMMIT");
  if (snapshot.prepare("PRAGMA quick_check").all().some(row=>row.quick_check!=='ok')) throw new Error("Metadata snapshot quick_check failed; retained.");
  writeFileSync(`${file}.manifest.json`,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  const descriptor=openSync(`${file}.manifest.json`,'r+');
  try {fsyncSync(descriptor);} finally {closeSync(descriptor);}
 } finally {source.exec("ROLLBACK");snapshot.close();}
}
