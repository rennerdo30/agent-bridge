import { mkdirSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { testFixtureRoot } from "./test-fixture-root.mjs";
import type { SnapshotMeasurement } from "../src/core/sqlite-fast-snapshot.js";
import { BridgeNode } from "../src/core/node.js";
import { nullLogger } from "../src/core/logger.js";
import { resolvePipePath } from "../src/core/paths.js";
import { loadOrCreateToken } from "../src/core/token.js";

const sourceHome=process.env.AGENT_BRIDGE_SNAPSHOT_SOURCE_HOME;
if(!sourceHome) throw new Error("Select a source home explicitly; no default live-store access.");
const method=process.argv.includes('--checkpoint-authorized') ? 'copy' : 'backup';
const home=testFixtureRoot(), brokerHome=join(home,"synthetic-broker"), copyHome=join(home,"real-store-copy");
mkdirSync(brokerHome,{recursive:true}); mkdirSync(copyHome);
const source=join(sourceHome,'bridge.db'),disk=statfsSync(home,{bigint:true}),sourceBytes=BigInt(statSync(source).size);
if(disk.bavail*disk.bsize < sourceBytes*2n) throw new Error('Snapshot preflight: insufficient free space for copy and retained recovery.');
process.env.GIT_CEILING_DIRECTORIES=home;
process.env.CLAUDE_CONFIG_DIR=join(home,"empty-cli","claude"); process.env.CODEX_HOME=join(home,"empty-cli","codex"); process.env.XDG_DATA_HOME=join(home,"empty-cli","data");
for(const key of Object.keys(process.env)) if(key.startsWith("AGENT_BRIDGE_PARENT_") || key.startsWith("AGENT_BRIDGE_ROOT_")) delete process.env[key];
const options={pipePath:resolvePipePath(brokerHome,{}),token:loadOrCreateToken(brokerHome),dbPath:join(brokerHome,"bridge.db"),agent:"codex" as const,cwd:brokerHome,autoWake:false,log:nullLogger};
const sender=new BridgeNode({...options,name:"snapshot-fixture-sender"}),receiver=new BridgeNode({...options,name:"snapshot-fixture-receiver"});
await sender.start(); await receiver.start();
const peerMs:number[]=[],sendMs:number[]=[],counts:Record<string,unknown>={};
const startedAt=new Date().toISOString();
const p95=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*0.95))] ?? null;
let running=true,child:ReturnType<typeof spawn>|undefined;
const abort=(reason:string)=>{
 child?.kill();
 const report={source:'~/.agent-bridge/bridge.db',startedAt,abortedAt:new Date().toISOString(),reason,fixture:home,peers:{count:peerMs.length,p95Ms:p95(peerMs)},send:{count:sendMs.length,p95Ms:p95(sendMs)}};
 writeFileSync(join(home,'real-snapshot-aborted.json'),JSON.stringify(report,null,2));
 process.stderr.write(JSON.stringify(report)+'\n');process.exit(2);
};
const timed=async<T>(operation:()=>Promise<T>,samples:number[])=>{
 const at=performance.now(),watchdog=setTimeout(()=>abort('Broker request exceeded 1 s; snapshot child stopped and files retained.'),1_000);
 try {return await operation();} finally {
  clearTimeout(watchdog);samples.push(performance.now()-at);
  if((p95(samples.slice(-50)) ?? 0)>1_000) abort('Rolling broker p95 exceeded 1 s; snapshot stopped.');
 }
};
const traffic=(async()=>{
 while(running) {
  await timed(()=>sender.peers(),peerMs);
  await timed(()=>sender.send({to:receiver.name,body:"isolated snapshot fixture traffic"}),sendMs);
  receiver.markRead(receiver.unread().map(message=>message.id)); await delay(50);
 }
})();
let measurement:SnapshotMeasurement;
try {
 measurement=await new Promise<SnapshotMeasurement>((resolve,reject)=>{
  let output='';
  child=spawn(process.execPath,[join(dirname(fileURLToPath(import.meta.url)),'sqlite-snapshot-worker.mjs'),source,join(copyHome,'bridge.db'),method,...(method==='copy'?['--checkpoint-authorized']:[])],{windowsHide:true,stdio:['ignore','pipe','inherit'],env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH}});
  child.stdout!.on('data',data=>{output+=data;});child.once('error',reject);
  child.once('exit',code=>{
   if(code!==0) reject(new Error(`Snapshot worker exited ${code}; retained.`));
   else {try{resolve(JSON.parse(output));}catch(error){reject(error);}}
  });
 });
 running=false;await traffic;
 const copied=new DatabaseSync(join(copyHome,"bridge.db"),{readOnly:true});
 try {for(const table of ['messages','archived_messages','conversation_records','history_documents']) if(copied.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) counts[table]=copied.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;}
 finally { copied.close(); }
} finally {running=false;await traffic;await sender.stop();await receiver.stop();}
const report={source:"~/.agent-bridge/bridge.db",fixture:home,copyHome,measurement,counts,peers:{count:peerMs.length,p95Ms:p95(peerMs),maxMs:Math.max(...peerMs)},send:{count:sendMs.length,p95Ms:p95(sendMs),maxMs:Math.max(...sendMs)},sourceCheckpointed:measurement.checkpointAttempts>0};
writeFileSync(join(home,"real-snapshot-results.json"),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify(report)+"\n");
