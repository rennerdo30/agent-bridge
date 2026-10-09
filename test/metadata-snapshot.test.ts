import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect,it } from "vitest";
import { snapshotMetadataTables } from "../src/core/metadata-snapshot.js";

it("backs up only affected metadata tables with verified row hashes and absent-table evidence",()=>{
 const home=mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!,"metadata-snapshot-")),file=join(home,"before.db");
 const source=new DatabaseSync(join(home,"source.db"));
 source.exec("CREATE TABLE unrelated(bytes BLOB); INSERT INTO unrelated VALUES (zeroblob(8388608)); CREATE TABLE metadata(key TEXT PRIMARY KEY,value BLOB,n INTEGER); PRAGMA user_version=9");
 source.prepare("INSERT INTO metadata VALUES (?,?,?)").run('retained',Buffer.from([0,255,2]),9223372036854775807n);
 try {
  snapshotMetadataTables(source,file,['metadata','absent'],'fixture',1);
  expect(statSync(file).size).toBeLessThan(100_000);
  const copy=new DatabaseSync(file,{readOnly:true});
  try {
   expect(copy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{name:'metadata'}]);
   const read=copy.prepare("SELECT * FROM metadata");read.setReadBigInts(true);
   expect(read.get()).toEqual({key:'retained',value:new Uint8Array([0,255,2]),n:9223372036854775807n});
  } finally {copy.close();}
  const manifest=JSON.parse(readFileSync(`${file}.manifest.json`,'utf8'));
  expect(manifest.sourceVersion).toBe(9);expect(manifest.tables[1].existed).toBe(false);
  expect(manifest.tables[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(source.prepare("SELECT length(bytes) AS n FROM unrelated").get()!.n).toBe(8388608);
  expect(()=>snapshotMetadataTables(source,file,['metadata'],'fixture',1)).toThrow('retained');
 } finally {source.close();}
});
