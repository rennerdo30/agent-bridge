import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { testFixtureRoot } from "./test-fixture-root.mjs";
import { fastSnapshot } from "../src/core/sqlite-fast-snapshot.js";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { resolvePipePath } from "../src/core/paths.js";
import { loadOrCreateToken } from "../src/core/token.js";

const home=testFixtureRoot(), brokerHome=join(home,"broker"), source=join(home,"snapshot-source.db");
process.env.GIT_CEILING_DIRECTORIES=home;
process.env.CLAUDE_CONFIG_DIR=join(home,"empty-cli","claude"); process.env.CODEX_HOME=join(home,"empty-cli","codex"); process.env.XDG_DATA_HOME=join(home,"empty-cli","data");
for (const key of Object.keys(process.env)) if (key.startsWith("AGENT_BRIDGE_PARENT_") || key.startsWith("AGENT_BRIDGE_ROOT_")) delete process.env[key];
mkdirSync(brokerHome,{recursive:true});
const db=new DatabaseSync(source);
db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE payload(id INTEGER PRIMARY KEY,bytes BLOB); CREATE TABLE concurrent(value INTEGER); INSERT INTO concurrent VALUES (0)");
const sizeMiB=Number(process.argv[2] ?? 1024), payload=randomBytes(1024*1024), insert=db.prepare("INSERT INTO payload(bytes) VALUES (?)");
db.exec("BEGIN"); for(let i=0;i<sizeMiB;i++) insert.run(payload); db.exec("COMMIT"); db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
const opts={pipePath:resolvePipePath(brokerHome,{}),token:loadOrCreateToken(brokerHome),dbPath:join(brokerHome,"bridge.db"),agent:"codex" as const,cwd:brokerHome,autoWake:false,log:nullLogger};
const sender=new BridgeNode({...opts,name:"snapshot-fixture-sender"}), receiver=new BridgeNode({...opts,name:"snapshot-fixture-receiver"});
await sender.start(); await receiver.start();
const results=[];
try {
 for(const {method,rate} of [{method:"copy",rate:16_384},{method:"backup",rate:16_384},{method:"backup",rate:262_144},{method:"backup",rate:1_048_576}] as const) {
  const destination=join(home,`${method}-${rate}.db`), peerMs: number[]=[], sendMs: number[]=[], writes: number[]=[];
  let running=true;
  const traffic=(async()=>{
   while(running) {
    let at=performance.now(); await sender.peers(); peerMs.push(performance.now()-at);
    at=performance.now(); await sender.send({to:receiver.name,body:"snapshot fixture message"}); sendMs.push(performance.now()-at);
    receiver.markRead(receiver.unread().map(message=>message.id)); await delay(10);
   }
  })();
  const writer=setInterval(()=>{
   const at=performance.now(); db.exec("UPDATE concurrent SET value=value+1"); writes.push(performance.now()-at);
  },25);
  let measurement;
  let pinnedValue: unknown;
  try { measurement=await fastSnapshot(source,destination,{method,allowCheckpoint:method==="copy",rate,onPinned:()=>{pinnedValue=db.prepare("SELECT value FROM concurrent").get()!.value;}}); }
  finally { clearInterval(writer); running=false; await traffic; }
  const p95=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*0.95))] ?? null;
  const snapshot=new DatabaseSync(destination,{readOnly:true});
  let copiedValue: unknown;
  try { copiedValue=snapshot.prepare("SELECT value FROM concurrent").get()!.value; if(copiedValue!==pinnedValue) throw new Error("Concurrent fixture snapshot differs from pinned state"); }
  finally {snapshot.close();}
  results.push({...measurement,rate,pinnedValue,copiedValue,peers:{count:peerMs.length,p95Ms:p95(peerMs)},send:{count:sendMs.length,p95Ms:p95(sendMs)},concurrentWrites:writes.length});
 }
} finally { await sender.stop(); await receiver.stop(); db.close(); }
const report={fixture:home,sizeMiB,results};writeFileSync(join(home,"snapshot-results.json"),JSON.stringify(report,null,2));
process.stdout.write(JSON.stringify(report)+"\n");
