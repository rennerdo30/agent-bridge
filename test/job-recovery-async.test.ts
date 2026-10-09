import * as feeds from "../src/core/job-recovery-feed.js";
import { indexFixtureFile } from "./archive-fixture.js";
import { archiveJobs } from "../src/core/job-archive.js";
import * as io from "node:fs/promises";
import * as history from "../src/core/run-history.js";
import * as cache from "../src/core/file-cache.js";
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { makeEnv, type TestEnv } from "./helpers.js";
import { recoverJobRecord, recoverJobRecordAsync } from "../src/core/job-recovery.js";
const ioMocks=vi.hoisted(()=>({open:vi.fn(),original:undefined as typeof import("node:fs/promises").open|undefined}));
vi.mock("node:fs/promises",async(importOriginal)=>{const actual=await importOriginal<typeof import("node:fs/promises")>();ioMocks.original=actual.open;return {...actual,open:ioMocks.open};});
let env: TestEnv;
beforeEach(() => { ioMocks.open.mockReset().mockImplementation(ioMocks.original!);env = makeEnv(); vi.stubEnv("AGENT_BRIDGE_HISTORY_INGEST", "false"); vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0"); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); vi.unstubAllEnvs(); });
function fixture(prompt:string, owner:string, id="asynclegacy") {
  mkdirSync(join(env.home,"runs"),{recursive:true});
  const run=join(env.home,"runs",`2026-10-08-01-02-03-codex-${id}`), name=`codex-job-${id}`;
  const text=`01:02:03 running by ${owner}\n${prompt.split("\n").map(line=>`         ${line}`).join("\n")}\n         ---\n${"body must remain unread\n".repeat(1_500_000)}`;
  writeFileSync(`${run}.log`,text); writeFileSync(`${run}.json`,JSON.stringify({job:name,session:"retained-native",workdir:env.home,byCwd:env.home}));
  return {name,file:`${run}.log`,text};
}
it("yields throughout a cold archive/run catalog, matches offline recovery and clones only selected jobs",async()=>{
  mkdirSync(join(env.home,"archive"));mkdirSync(join(env.home,"runs"));mkdirSync(join(env.home,"jobs"));
  const id="responsivecold",name=`codex-job-${id}`, selected={id,name,agent:"codex",owner:"current-owner",rootName:"current-owner",status:"interrupted",startedAt:5,sessionId:"retained-native",prompt:"Exact cold retained context",args:{title:"Retained title",future:{keep:true}},future:{context:["keep"]}};
  const corpus:Record<string,unknown>[]=[];
  for(let i=0;i<307;i++){
    const jobs=Array.from({length:5},(_,j)=>({id:`foreign-${i}-${j}`,name:`codex-job-foreign-${i}-${j}`,agent:"codex",owner:"foreign-owner",prompt:"retained".repeat(64),future:{keep:true}}));
    writeFileSync(join(env.home,"archive",`jobs-${String(i).padStart(4,"0")}.json`),JSON.stringify({version:4,jobs:i===306?[...jobs,selected]:jobs}));
    corpus.push(...(i===306?[...jobs,selected]:jobs));
  }
  for(let i=0;i<1024;i++){
    const own=i===1023, run=join(env.home,"runs",`2026-10-08-01-02-03-codex-${own?id:`foreign-${i}`}`);
    writeFileSync(`${run}.json`,JSON.stringify({job:own?name:`codex-job-foreign-${i}`,jobStartedAt:5,session:own?"retained-native":"foreign-native",by:"launch-owner",access:"read",effort:"high",byCwd:env.home}));
    writeFileSync(`${run}.log`,"01:02:03 header by launch-owner\n         launch context\n         ---\n");
  }
  writeFileSync(join(env.home,"jobs",`${id}.spec.json`),JSON.stringify({cwd:env.home,job:{id,name,agent:"codex",owner:"launch-owner",startedAt:1,prompt:"Old launch context"},base:{access:"ask",futureSpec:"retained"}}));
  // Index the same 1536 records in one transaction: per-file imports cost one durable commit each,
  // which on a loaded Windows disk exceeded the test budget before recovery even started.
  archiveJobs(join(env.home,"jobs.json"),corpus);
  const synchronousHistory=vi.spyOn(history,"findHistoryJob"),synchronousRuns=vi.spyOn(history,"readRunLogs"),clones=vi.spyOn(cache,"cloneJson");
  let settled=false,beats=0,scheduled=true;
  const tick=()=>{if(!scheduled)return;beats++;setImmediate(tick);};setImmediate(tick);
  let recovered:Awaited<ReturnType<typeof recoverJobRecordAsync>>;
  try{
    const recovering=recoverJobRecordAsync(env.home,name).then(value=>{settled=true;return value;});
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(beats).toBeGreaterThan(0);expect(settled).toBe(false);
    recovered=await recovering;
  }finally{scheduled=false;}
  expect(beats).toBeGreaterThan(2);expect(synchronousHistory).not.toHaveBeenCalled();expect(synchronousRuns).not.toHaveBeenCalled();
  expect(clones.mock.calls.map(([value])=>(value as {id?:string})?.id).filter(Boolean)).toEqual([id,id]);
  expect(recovered).toEqual(recoverJobRecord(env.home,name));
  expect(recovered).toMatchObject({owner:"current-owner",prompt:selected.prompt,sessionId:"retained-native",future:{context:["keep"]},args:{access:"ask",effort:"high",futureSpec:"retained",future:{keep:true}}});
  (recovered as any).future.context.push("caller mutation");(recovered as any).args.future.keep=false;
  expect(await recoverJobRecordAsync(env.home,name)).toMatchObject({future:{context:["keep"]},args:{future:{keep:true}}});
},15000);
it("preserves multi-MB UTF8 prompts exactly, reads only the header and invalidates same-size/mtime replacements",async()=>{
  const prompt=`${"x".repeat(2*1024*1024)}🌍\r\n  exact spacing\nlast line`, f=fixture(prompt,"owner");
  const original=ioMocks.original!, reads:number[]=[];
  const opening=ioMocks.open.mockImplementation(async(...args:any[])=>{
    const handle=await (original as any)(...args), read=handle.read.bind(handle);
    vi.spyOn(handle,"read").mockImplementation(async(...params:any[])=>{const result=await read(...params); reads.push(result.bytesRead);return result;});
    return handle;
  });
  expect(await feeds.readRecoveryHeader(f.file)).toEqual({header:"01:02:03 running by owner",prompt});
  expect(Math.max(...reads)).toBeLessThanOrEqual(65536); expect(reads.reduce((a,b)=>a+b,0)).toBeLessThan(Buffer.byteLength(prompt)+131072);
  const cached=await feeds.readRecoveryHeader(f.file);expect(cached).toEqual({header:"01:02:03 running by owner",prompt});cached!.prompt="caller mutation";
  expect((await feeds.readRecoveryHeader(f.file))?.prompt).toBe(prompt);expect(opening).toHaveBeenCalledTimes(1);
  const old=statSync(f.file), changed=f.text.replace("exact spacing","fresh spacing"); writeFileSync(f.file,changed);utimesSync(f.file,old.atime,old.mtime);
  expect((await feeds.readRecoveryHeader(f.file))?.prompt).toBe(prompt.replace("exact spacing","fresh spacing"));expect(opening).toHaveBeenCalledTimes(2);
  expect(readFileSync(f.file,"utf8")).toBe(changed);
});
it("retries failed reads without caching an empty prompt",async()=>{
  const f=fixture("retained exact task","owner","retryread"), original=ioMocks.original!;
  const opening=ioMocks.open.mockRejectedValueOnce(Object.assign(new Error("temporarily inaccessible"),{code:"EACCES"})).mockImplementation(original);
  expect(await feeds.readRecoveryHeader(f.file)).toBeUndefined();
  expect((await feeds.readRecoveryHeader(f.file))?.prompt).toBe("retained exact task");expect(opening).toHaveBeenCalledTimes(2);
});
it("keeps pending and ack below 1s while authority recovers an exact multi-MB legacy prompt",async()=>{
  const owner=env.node("owner","codex");await owner.start();
  const prompt="original exact context ".repeat(100_000), f=fixture(prompt,owner.name), observer=await BridgeClient.connect(env.pipe,nullLogger);
  try {
    await observer.request("hello",{protocol:PROTOCOL_VERSION,token:loadOrCreateToken(env.home),peer:{id:"observer",name:"observer",agent:"codex",cwd:env.home,pid:process.pid,agentPid:null,sessionId:null,startedAt:Date.now(),autoWake:false}});
    let recovered=false;const authorityStarted=performance.now();let authorityMs=0;
    const authority=owner.jobAuthority(f.name).then(job=>{authorityMs=performance.now()-authorityStarted;recovered=true;return job;});
    const times:number[]=[];
    do {const start=performance.now();await observer.request("pending",{});await observer.request("ack",{ids:[]});times.push(performance.now()-start);} while(!recovered);
    expect((await authority)?.prompt).toBe(prompt);expect(authorityMs).toBeLessThan(1000);expect(times.length).toBeGreaterThan(1);expect(Math.max(...times)).toBeLessThan(1000);
    expect(readFileSync(f.file,"utf8")).toBe(f.text);
  } finally {observer.close();}
},15000);
it("uses current handoff authority/context after a header read yields",async()=>{
  const old=env.node("old-owner","other"), next=env.node("new-owner","other");await old.start();await next.start();
  const f=fixture("old exact prompt",old.name,"handoffread");
  let entered!:()=>void, release!:(value:feeds.RecoveryHeader)=>void;
  const reading=new Promise<void>(resolve=>{entered=resolve;}), held=new Promise<feeds.RecoveryHeader>(resolve=>{release=resolve;});
  vi.spyOn(feeds,"readRecoveryHeader").mockImplementationOnce(()=>{entered();return held;});
  const authority=old.jobAuthority(f.name);await reading;
  writeFileSync(join(env.home,"jobs.json"),JSON.stringify({version:4,jobs:[{id:"handoffread",name:f.name,agent:"codex",owner:next.name,rootName:next.name,masters:[next.name],status:"interrupted",sessionId:"new-native",startedAt:Date.now(),prompt:"new exact context",args:{}}]}));
  release({header:`01:02:03 running by ${old.name}`,prompt:"old exact prompt"});
  expect(await authority).toBeNull();
  expect(await next.jobAuthority(f.name)).toMatchObject({owner:next.name,prompt:"new exact context",sessionId:"new-native"});
});
it("does not substitute or cache empty context when the legacy prompt separator is missing",async()=>{
  const file=join(env.home,"unfinished.log");writeFileSync(file,"header by owner\n         complete task without separator\n");
  expect(await feeds.readRecoveryHeader(file)).toBeUndefined();
  writeFileSync(file,"header by owner\n         complete task without separator\n         ---\nbody");
  expect((await feeds.readRecoveryHeader(file))?.prompt).toBe("complete task without separator");
});
it("retains an exact header through an owner-only handoff and rejects metadata-only session changes during IO",async()=>{
  const f=fixture("full exact task","old-owner","generationread"), registry=join(env.home,"jobs.json");
  const base={id:"generationread",name:f.name,agent:"codex",owner:"old-owner",sessionId:"retained-native",startedAt:1,status:"interrupted",args:{}};
  writeFileSync(registry,JSON.stringify({version:4,jobs:[base]}));
  let entered!:()=>void, release!:(value:feeds.RecoveryHeader)=>void;
  const hold=()=>{const ready=new Promise<void>(resolve=>{entered=resolve;});const result=new Promise<feeds.RecoveryHeader>(resolve=>{release=resolve;});vi.spyOn(feeds,"readRecoveryHeader").mockImplementationOnce(()=>{entered();return result;});return ready;};
  let ready=hold(), recovery=recoverJobRecordAsync(env.home,f.name);await ready;
  writeFileSync(registry,JSON.stringify({version:4,jobs:[{...base,owner:"new-owner",masters:["new-owner"]}]}));
  release({header:"header by old-owner",prompt:"full exact task"});
  expect(await recovery).toMatchObject({owner:"new-owner",prompt:"full exact task",sessionId:"retained-native"});
  ready=hold();recovery=recoverJobRecordAsync(env.home,f.name);await ready;
  writeFileSync(f.file.replace(/\.log$/,".json"),JSON.stringify({job:f.name,session:"new-session",jobStartedAt:2,workdir:env.home,byCwd:env.home}));
  release({header:"header by old-owner",prompt:"full exact task"});
  expect(await recovery).toBeUndefined();
});
it("rechecks durable authority after the handler's final promise boundary in a parsed request batch",async()=>{
  const old=env.node("batch-old","other"),next=env.node("batch-new","other");await old.start();await next.start();
  const job={id:"batchauthority",name:"codex-job-batchauthority",agent:"codex",owner:old.name,startedAt:1,sessionId:"same-native",prompt:"exact context",status:"interrupted",args:{}};
  const registry=join(env.home,"jobs.json");writeFileSync(registry,JSON.stringify({version:4,jobs:[job]}));
  const broker=(old as unknown as {broker:{jobForControl:(...args:any[])=>Promise<Record<string,unknown>>}}).broker;
  vi.spyOn(broker,"jobForControl").mockImplementation(async()=>{queueMicrotask(()=>writeFileSync(registry,JSON.stringify({version:4,jobs:[{...job,owner:next.name,masters:[next.name]}]})));return job;});
  expect(await old.jobAuthority(job.name)).toBeNull();
  expect(await next.jobAuthority(job.name)).toMatchObject({owner:next.name,prompt:"exact context",sessionId:"same-native"});
});
it("preserves run context/access omitted by an archive-only legacy record",async()=>{
  const owner=env.node("archive-owner","other");await owner.start();const f=fixture("full archived task",owner.name,"archivecontext");
  mkdirSync(join(env.home,"archive"));
  writeFileSync(join(env.home,"jobs.json"),JSON.stringify({version:4,jobs:[]}));
  writeFileSync(join(env.home,"archive","jobs-context.json"),JSON.stringify({version:4,jobs:[{id:"archivecontext",name:f.name,agent:"codex",owner:owner.name,status:"interrupted",sessionId:"retained-native",startedAt:1}]}));
  indexFixtureFile(join(env.home,"archive","jobs-context.json"));
  writeFileSync(f.file.replace(/\.log$/,".json"),JSON.stringify({job:f.name,session:"retained-native",workdir:env.home,rootSession:"retained-root",parentJob:"claude-job-parent",access:"read"}));
  expect(await owner.jobAuthority(f.name)).toMatchObject({prompt:"full archived task",parentJob:"claude-job-parent",rootSession:"retained-root",args:{access:"read"}});
});
it("uses newer retained backup authority/context over an older archive when the active registry is empty",async()=>{
  const old=env.node("retained-old","other"),next=env.node("retained-new","other");await old.start();await next.start();
  const name="codex-job-backupauthority",base={id:"backupauthority",name,agent:"codex",startedAt:1,status:"interrupted",args:{access:"read"},rootSession:"preserved-root",parentJob:"claude-job-parent"};
  mkdirSync(join(env.home,"archive"));writeFileSync(join(env.home,"jobs.json"),JSON.stringify({version:4,jobs:[]}));
  writeFileSync(join(env.home,"archive","jobs-1-original.json"),JSON.stringify({version:4,jobs:[{...base,owner:old.name,rootName:old.name,sessionId:"old-session",prompt:"old exact context",status:"running",host:{pid:process.pid,peer:name,startedAt:Date.now()}}]}));
  writeFileSync(join(env.home,"jobs.json.backup-2"),JSON.stringify({version:4,jobs:[{id:base.id,name,agent:"codex",owner:next.name,rootName:next.name,masters:[next.name],startedAt:2,sessionId:"new-session",prompt:"new exact context",status:"interrupted"}]}));
  indexFixtureFile(join(env.home,"archive","jobs-1-original.json"));
  indexFixtureFile(join(env.home,"jobs.json.backup-2"));
  expect(await old.jobAuthority(name)).toBeNull();
  expect(await next.jobAuthority(name)).toMatchObject({owner:next.name,sessionId:"new-session",prompt:"new exact context",rootSession:"preserved-root",parentJob:"claude-job-parent",args:{access:"read"}});
  expect((await old.projectJobs()).some(job=>job.name===name)).toBe(false);
  expect((await next.projectJobs()).find(job=>job.name===name)).toMatchObject({owner:next.name,sessionId:"new-session",prompt:"new exact context"});
});
it("uses the final duplicate active row and fails closed when incomplete legacy context cannot be read",async()=>{
  const old=env.node("duplicate-old","other"),next=env.node("duplicate-new","other");await old.start();await next.start();
  const base={id:"duplicateauthority",name:"codex-job-duplicateauthority",agent:"codex",startedAt:1,sessionId:"same-native",status:"running",args:{}};
  writeFileSync(join(env.home,"jobs.json"),JSON.stringify({version:4,jobs:[{...base,owner:old.name,prompt:"old context"},{...base,owner:next.name,prompt:"latest context"}]}));
  expect(await old.jobAuthority(base.name)).toBeNull();expect(await next.jobAuthority(base.name)).toMatchObject({owner:next.name,prompt:"latest context"});
  writeFileSync(join(env.home,"jobs.json"),JSON.stringify({version:4,jobs:[{id:"unreadablelegacy",name:"codex-job-unreadablelegacy",agent:"codex",owner:next.name,status:"interrupted",startedAt:1,args:{}}]}));
  const f=fixture("exact context required",next.name,"unreadablelegacy");
  ioMocks.open.mockRejectedValueOnce(Object.assign(new Error("temporarily inaccessible"),{code:"EACCES"}));
  expect(await next.jobAuthority(f.name)).toBeNull();
  expect(await next.jobAuthority(f.name)).toMatchObject({prompt:"exact context required",owner:next.name});
});
