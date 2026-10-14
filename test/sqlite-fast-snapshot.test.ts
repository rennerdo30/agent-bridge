import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fastSnapshot } from "../src/core/sqlite-fast-snapshot.js";

it.each(["backup","copy"] as const)("%s snapshot equals pinned state while a second writer commits and attempts checkpoint", async method => {
 const home=mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!,"fast-snapshot-")), file=join(home,"source.db"), destination=join(home,"copy.db");
 const writer=new DatabaseSync(file);
 writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO fixture VALUES (1,'before'); CREATE TABLE payload(bytes BLOB); INSERT INTO payload VALUES (zeroblob(8388608));");
 try {
  const result=await fastSnapshot(file,destination,{method,allowCheckpoint:method==="copy",onPinned:async()=>{
   writer.exec("UPDATE fixture SET value='after'; INSERT INTO fixture VALUES (2,'new concurrent row');");
   writer.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
   expect(writer.prepare("SELECT COUNT(*) AS n FROM fixture").get()!.n).toBe(2);
  }});
  expect(result.bytes).toBe(statSync(destination).size); expect(result.copyMs).toBeGreaterThan(0);
  const snapshot=new DatabaseSync(destination,{readOnly:true});
  try { expect(snapshot.prepare("SELECT * FROM fixture").all()).toEqual([{id:1,value:"before"}]); }
  finally { snapshot.close(); }
 } finally { writer.close(); }
});
it("refuses overwriting an existing destination and refuses unauthorized checkpoint copies", async()=>{
 const home=mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!,"snapshot-retention-")), file=join(home,"source.db");
 const db=new DatabaseSync(file); db.exec("CREATE TABLE retained(value); INSERT INTO retained VALUES ('owner bytes')"); db.close();
 const before=readFileSync(file);
 await expect(fastSnapshot(file,file)).rejects.toThrow("must be new"); expect(readFileSync(file)).toEqual(before);
 await expect(fastSnapshot(file,join(home,"refused.db"),{method:"copy"})).rejects.toThrow("authorization");
 expect(existsSync(join(home,"refused.db"))).toBe(false);
});

it("caps checkpoint attempts at three and falls back to a read-only native snapshot", async()=>{
 const home=mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!,"snapshot-busy-")), file=join(home,"source.db"), destination=join(home,"copy.db");
 const writer=new DatabaseSync(file);
 writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('before'); PRAGMA wal_checkpoint(TRUNCATE)");
 const oldReader=new DatabaseSync(file,{readOnly:true});
 oldReader.exec("BEGIN"); oldReader.prepare("SELECT * FROM fixture").all();
 writer.exec("INSERT INTO fixture VALUES ('after')");
 try {
  const result=await fastSnapshot(file,destination,{method:"copy",allowCheckpoint:true});
  expect(result.method).toBe("backup"); expect(result.checkpointAttempts).toBe(3);
  const copied=new DatabaseSync(destination,{readOnly:true});
  try {expect(copied.prepare("SELECT value FROM fixture ORDER BY rowid").all()).toEqual([{value:"before"},{value:"after"}]);}
  finally {copied.close();}
 } finally {oldReader.exec("ROLLBACK");oldReader.close();writer.close();}
});
