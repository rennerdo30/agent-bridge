/** Copy-only release audit. Never starts a broker or accesses paths named inside copied records. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateMessageSchema } from "../src/core/store.js";
import { openArchive, checkDatabase } from "../src/core/sqlite-maintenance.js";
import { isRecord, JSON_STORE_VERSION, writeJsonStore } from "../src/core/json-store.js";
import { nullLogger } from "../src/core/logger.js";

const home = resolve(process.argv[2] ?? "");
const owner = resolve(process.env.USERPROFILE ?? "", ".agent-bridge");
if (!process.argv[2] || home.toLowerCase() === owner.toLowerCase() || !home.includes("owner-copy-")) throw new Error("Requires an explicit owner-copy-* directory, never the live home");
const reportPath = resolve(process.argv[3] ?? join(home,"upgrade-audit.json"));
const sha = (raw: Buffer | string) => createHash("sha256").update(raw).digest("hex");
const canon = (value: unknown): string => JSON.stringify(value, (_key, v) => typeof v === "bigint" ? { bigint: String(v) } : v instanceof Uint8Array ? { blob: Buffer.from(v).toString("hex") } : v);
const quote = (value: string) => `"${value.replaceAll('"','""')}"`;
type Table = { columns: string[]; count: number; sha256: string };
function tables(db: DatabaseSync, baseline?: Record<string, Table>): Record<string, Table> {
  const out: Record<string, Table> = {};
  const names = baseline ? Object.keys(baseline) : db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => String(row.name));
  for (const name of names) {
    const columns = baseline?.[name]?.columns ?? db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all().filter(row => row.hidden === 0).map(row => String(row.name));
    const statement = db.prepare(`SELECT ${columns.map(quote).join(",")} FROM ${quote(name)}`); statement.setReadBigInts(true);
    const hashes: string[] = []; for (const row of statement.iterate()) hashes.push(sha(canon(row)));
    out[name] = {columns,count:hashes.length,sha256:sha(hashes.sort().join("\n"))};
  }
  return out;
}
const dataDirs = ["archive","jobs","runs","logs","network","approvals","read-state","message-waits","sessions","local-result-receipts","job-outcomes","worktree-state","permission-repairs",".agent-bridge"];
function files(dir: string, recurse = true): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => { const path=join(dir,name),st=lstatSync(path); if(st.isSymbolicLink())throw new Error(`Link in bridge-data copy: ${relative(home,path)}`); return st.isDirectory() ? recurse ? files(path) : [] : [path]; });
}
const all = [...files(home,false), ...dataDirs.flatMap(dir => files(join(home,dir)))].filter(path => !/\.(db|sqlite)(?:-|\.backup-)/.test(path) && !/\.(db|sqlite)$/.test(path));
const before = new Map(all.map(path => [path,{bytes:readFileSync(path),sha256:sha(readFileSync(path))}]));
const database: Record<string, unknown> = {};
for (const name of ["bridge.db","archive.db","resource-slots.sqlite","root-limits.sqlite"]) {
  const file=join(home,name); if(!existsSync(file))continue;
  const db=new DatabaseSync(file); const oldVersion=Number(db.prepare("PRAGMA user_version").get()!.user_version);
  const old=tables(db); const initialIntegrity=checkDatabase(db); if(initialIntegrity.length)throw new Error(`${name} before: ${initialIntegrity.join(",")}`);
  try { if(name==="bridge.db")migrateMessageSchema(db,file,true,nullLogger); } finally { db.close(); }
  if(name==="archive.db"){const archive=openArchive(file);archive.close();}
  const after=new DatabaseSync(file,{readOnly:true});
  try {
    const next=tables(after,old); if(canon(old)!==canon(next))throw new Error(`${name}: original record counts/hashes changed`);
    const findings=checkDatabase(after);if(findings.length)throw new Error(`${name} after: ${findings.join(",")}`);
    database[name]={beforeVersion:oldVersion,afterVersion:Number(after.prepare("PRAGMA user_version").get()!.user_version),tables:next,integrity:"ok",foreignKeys:"ok"};
  } finally {after.close();}
}
const upgraded = new Set<string>();
// Format changes are additive. Pure audit preserves ownership fields exactly, without resolving
// copied workdir/repoRoot strings against the owner's live checkout or creating project mirrors.
for (const [path, capture] of before) {
  const rel=relative(home,path).replaceAll("\\","/");
  if(!rel.endsWith(".json") || /(^archive\/|^network\/|^approvals\/|^sessions\/|^message-waits\/|\.backup-|\.corrupt-|^dashboard\.json$)/.test(rel))continue;
  let old: unknown;try{old=JSON.parse(capture.bytes.toString());}catch{continue;}
  if(!isRecord(old) || (typeof old.version === "number" && old.version>JSON_STORE_VERSION))continue;
  writeJsonStore(path,{...old,version:JSON_STORE_VERSION},old);upgraded.add(path);
}
const groups: Record<string,{files:number;records:number;preserved:number}> = {};
function count(value: unknown): number {if(Array.isArray(value))return value.length;if(isRecord(value)){for(const key of ["jobs","pairs","peers","models","ids","history","invitations"])if(Array.isArray(value[key]))return value[key].length;return 1;}return 1;}
function originalProjection(old: unknown, next: unknown, root=true): unknown {
  if(Array.isArray(old)){if(!Array.isArray(next)||old.length!==next.length)throw new Error("Array records changed");return old.map((value,i)=>originalProjection(value,next[i],false));}
  if(isRecord(old)){if(!isRecord(next))throw new Error("Object records changed");return Object.fromEntries(Object.entries(old).filter(([key])=>!(root&&key==="version")).map(([key,value])=>[key,originalProjection(value,next[key],false)]));}return next;
}
for(const [path,capture] of before){
  const rel=relative(home,path).replaceAll("\\","/"),group=rel.includes("/")?rel.split("/")[0]!:rel;
  const actual=readFileSync(path);let records=1;
  try { const old=JSON.parse(capture.bytes.toString()); records=count(old); if(upgraded.has(path)){
    const next=JSON.parse(actual.toString());if(sha(canon(originalProjection(old,next)))!==sha(canon(originalProjection(old,old))))throw new Error(`${rel}: original content changed`);
    const previous=actual;writeJsonStore(path,next,next);if(!readFileSync(path).equals(previous))throw new Error(`${rel}: replay not byte-idempotent`);
  }else if(sha(actual)!==capture.sha256)throw new Error(`${rel}: retained bytes changed`);
  }catch(error){if(upgraded.has(path)||sha(actual)!==capture.sha256)throw error;}
  const g=groups[group]??={files:0,records:0,preserved:0};g.files++;g.records+=records;g.preserved++;
}
// Re-running the real schema operation must neither rewrite source records nor create snapshots.
const snapshotDir=join(home,".migration-snapshots"),snapshots=existsSync(snapshotDir)?readdirSync(snapshotDir).length:0;
const db=new DatabaseSync(join(home,"bridge.db"));try{migrateMessageSchema(db,join(home,"bridge.db"),true,nullLogger);}finally{db.close();}
if((existsSync(snapshotDir)?readdirSync(snapshotDir).length:0)!==snapshots)throw new Error("Replay created a second schema snapshot");
const report={schema:1,home,originalHomeAccessed:false,databases:database,stores:groups,retainedFiles:before.size,upgradedFiles:upgraded.size,idempotent:true,integrity:"ok",at:new Date().toISOString()};
writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({reportPath,retainedFiles:before.size,upgradedFiles:upgraded.size,stores:groups,integrity:"ok"}));
