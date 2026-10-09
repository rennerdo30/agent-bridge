import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDb, metadataDb, metadataValue } from "../src/core/metadata-db.js";
import { importMetadataDomain, retainMetadataFiles, type RetainedBundle } from "../src/core/metadata-import.js";
import { ReadJournal } from "../src/core/read-journal.js";
import { localResultReceipt, recordLocalResult } from "../src/core/local-result-receipts.js";
import { readOutcomeDecision, setJobOutcome } from "../src/core/job-outcomes.js";
import { processIdentity } from "../src/core/process-identity.js";
vi.mock("node:fs", async original => ({...await original<typeof import("node:fs")>(),readFileSync:vi.fn((await original<typeof import("node:fs")>()).readFileSync),readdirSync:vi.fn((await original<typeof import("node:fs")>()).readdirSync)}));
let home: string;
beforeEach(() => { home = fs.mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!,"metadata-db-")); });
afterEach(() => { closeMetadataDb(home); vi.restoreAllMocks(); });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
it("backs up an existing database before additive DDL and leaves its global version and rows intact", () => {
 const file = join(home,"bridge.db"), original = new DatabaseSync(file);
 original.exec("CREATE TABLE owner_data(value TEXT); INSERT INTO owner_data VALUES ('unique bytes'); PRAGMA user_version=9"); original.close();
 const db = metadataDb(home);
 expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(9);
 expect(db.prepare("SELECT value FROM owner_data").get()!.value).toBe("unique bytes");
 const backups = fs.readdirSync(join(home,".migration-snapshots")).filter(path=>path.endsWith('.db')); expect(backups).toHaveLength(1);
 const backup = new DatabaseSync(join(home,".migration-snapshots",backups[0]!),{readOnly:true});
 try {
  expect(backup.prepare("SELECT 1 FROM sqlite_master WHERE name='owner_data'").get()).toBeUndefined();
  expect(backup.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get()).toBeUndefined();
  const manifest=JSON.parse(fs.readFileSync(join(home,".migration-snapshots",`${backups[0]}.manifest.json`),'utf8'));
  expect(manifest.kind).toBe('metadata-component-snapshot');
  expect(manifest.schema.some((row:{name:string})=>row.name==='owner_data')).toBe(true);
  expect(manifest.tables.every((table:{existed:boolean})=>!table.existed)).toBe(true);
 } finally { backup.close(); }
});
it("defers while a provably live old reader protects its file-backed domains", () => {
 const dir = join(home,"storage-capabilities"); fs.mkdirSync(dir);
 const raw = JSON.stringify({schemaVersion:1,pid:process.pid,processIdentity:processIdentity(process.pid),name:"old-reader",version:"0.30.3",json:4,sqlite:9,explicit:true});
 const path = join(dir,`${process.pid}.json`); fs.writeFileSync(path,raw);
 expect(() => metadataDb(home)).toThrow("old-reader"); expect(fs.readFileSync(path,"utf8")).toBe(raw);
});
it("retains malformed bytes and unknown fields with a verified SHA256 bundle and cold originals", () => {
 const dir = join(home,"sample"); fs.mkdirSync(dir);
 const good = Buffer.from(' {"future":{"kept":true},"value":123} \r\n'), bad = Buffer.from([0,255,10,123]);
 fs.writeFileSync(join(dir,"good.json"),good); fs.writeFileSync(join(dir,"bad.json"),bad);
 importMetadataDomain(home,"sample");
 expect(metadataValue(home,"sample","good")).toEqual({future:{kept:true},value:123});
 const rows = metadataDb(home).prepare("SELECT * FROM bridge_imports ORDER BY path").all(); expect(rows).toHaveLength(2);
 const bundle = JSON.parse(gunzipSync(fs.readFileSync(String(rows[0]!.bundle))).toString()) as RetainedBundle;
 for (const row of rows) {
  const raw = fs.readFileSync(String(row.cold_path));
  expect(createHash("sha256").update(raw).digest("hex")).toBe(row.sha256);
  expect(Buffer.from(bundle.entries.find(e=>e.path===row.path)!.data,"base64")).toEqual(raw);
 }
 expect(fs.readdirSync(dir)).toEqual([]);
});
it("rolls back projections and retains source bytes if import projection fails", () => {
 const path = join(home,"legacy.json"), raw = '{"future":"keep"}'; fs.writeFileSync(path,raw);
 expect(() => retainMetadataFiles(home,[path],db => {
  db.prepare("INSERT INTO bridge_metadata VALUES ('fixture','failed','{}',0)").run(); throw new Error("injected failure");
 })).toThrow("injected failure");
 expect(fs.readFileSync(path,"utf8")).toBe(raw); expect(metadataValue(home,"fixture","failed")).toBeNull();
 expect(metadataDb(home).prepare("SELECT * FROM bridge_imports").all()).toEqual([]);
 expect(fs.readdirSync(join(home,"cold","bundles"))).toHaveLength(1);
});
it("refuses source changes after durable projection and leaves changed original bytes in place", () => {
 const path = join(home,"raced.json"); fs.writeFileSync(path,"old bytes");
 expect(() => retainMetadataFiles(home,[path],() => fs.writeFileSync(path,"changed owner bytes"))).toThrow("source changed");
 expect(fs.readFileSync(path,"utf8")).toBe("changed owner bytes");
});
it("imports interrupted read journals and then serves consumption and outcomes without file reads or scans", () => {
 const dir = join(home,"read-state"); fs.mkdirSync(dir);
 const identity = "name:supervisor";
 fs.writeFileSync(join(dir,`${hash(identity)}.jsonl`),'["legacy"]\n{"ids":["timed"],"at":12}\n{"interrupted":');
 const journal = new ReadJournal(home);
 expect(journal.receipt(identity,"legacy")).toEqual({read:true,at:null});
 expect(journal.receipt(identity,"timed")).toEqual({read:true,at:12}); journal.append(identity,["new"]);
 const job = {id:"job",name:"codex-job-fixture",owner:"supervisor",startedAt:1,status:"done"};
 setJobOutcome(home,job,"supervisor","held","retain");
 recordLocalResult(home,{id:"result",recipient:"supervisor",to:"supervisor",from:{id:"job:job",name:job.name,agent:"codex"},conversationId:"job-job",body:"Subagent fixture done after 1s.",createdAt:10,readAt:null,replyTo:null,hop:0});
 localResultReceipt(home,job.name,"supervisor",0,100);
 const reads = vi.mocked(fs.readFileSync).mockClear(), scans = vi.mocked(fs.readdirSync).mockClear();
 for (let i=0;i<10;i++) {
  expect(journal.receipt(identity,"timed").at).toBe(12);
  expect(readOutcomeDecision(home,job)?.reason).toBe("retain");
  expect(localResultReceipt(home,job.name,"supervisor",0,100)?.messageId).toBe("result");
 }
 expect(reads).not.toHaveBeenCalled(); expect(scans).not.toHaveBeenCalled();
 expect(fs.existsSync(join(home,"local-result-receipts"))).toBe(false);
});
