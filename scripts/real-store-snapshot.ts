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

const sourceHome=process.env.AGENT_BRIDGE_SNAPSHOT_SOURCE_HOME;
if(!sourceHome) throw new Error("Select a source home explicitly; no default live-store access.");
const home=testFixtureRoot(), brokerHome=join(home,"synthetic-broker"), copyHome=join(home,"real-store-copy");
mkdirSync(brokerHome,{recursive:true}); mkdirSync(copyHome);
process.env.GIT_CEILING_DIRECTORIES=home;
process.env.CLAUDE_CONFIG_DIR=join(home,"empty-cli","claude"); process.env.CODEX_HOME=join(home,"empty-cli","codex"); process.env.XDG_DATA_HOME=join(home,"empty-cli","data");
for(const key of Object.keys(process.env)) if(key.startsWith("AGENT_BRIDGE_PARENT_") || key.startsWith("AGENT_BRIDGE_ROOT_")) delete process.env[key];
const options={pipePath:resolvePipePath(brokerHome,{}),token:loadOrCreateToken(brokerHome),dbPath:join(brokerHome,"bridge.db"),agent:"codex" as const,cwd:brokerHome,autoWake:false,log:nullLogger};
const sender=new BridgeNode({...options,name:"snapshot-fixture-sender"}),receiver=new BridgeNode({...options,name:"snapshot-fixture-receiver"});
await sender.start(); await receiver.start();
const peerMs:number[]=[],sendMs:number[]=[],counts:Record<string,unknown>={};
let running=true;
const traffic=(async()=>{
 while(running) {
  let at=performance.now(); await sender.peers(); peerMs.push(performance.now()-at);
  at=performance.now(); await sender.send({to:receiver.name,body:"isolated snapshot fixture traffic"}); sendMs.push(performance.now()-at);
  receiver.markRead(receiver.unread().map(message=>message.id)); await delay(50);
 }
})();
let measurement;
try {
 measurement=await fastSnapshot(join(sourceHome,"bridge.db"),join(copyHome,"bridge.db"),{method:"backup",rate:1_048_576,onPinned:db=>{
  for(const table of ["messages","archived_messages","conversation_records","history_documents"]) {
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) counts[table]=db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
  }
 },progress:value=>process.stderr.write(`Snapshot pages: ${value.totalPages-value.remainingPages}/${value.totalPages}\n`)});
 const copied=new DatabaseSync(join(copyHome,"bridge.db"),{readOnly:true});
 try { for(const [table,count] of Object.entries(counts)) if(copied.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n!==count) throw new Error(`Snapshot count mismatch: ${table}`); }
 finally { copied.close(); }
} finally {running=false;await traffic;await sender.stop();await receiver.stop();}
const p95=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*0.95))] ?? null;
const report={source:"~/.agent-bridge/bridge.db",fixture:home,copyHome,measurement,counts,peers:{count:peerMs.length,p95Ms:p95(peerMs)},send:{count:sendMs.length,p95Ms:p95(sendMs)},sourceCheckpointed:false};
writeFileSync(join(home,"real-snapshot-results.json"),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify(report)+"\n");
