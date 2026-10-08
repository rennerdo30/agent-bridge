import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { assertNativeRunnerFixtureLive, CONTEXT, fixtureInfo, installNativeFixtureCli } from "../scripts/release-runner-fixture.js";

function fixture() {
  const root=join(process.cwd(),".agent-bridge-test"); mkdirSync(root,{recursive:true});
  const home=mkdtempSync(join(root,"native-marker-")), lane=join(home,"lane"), cwd=join(home,"worktree");
  mkdirSync(lane); mkdirSync(cwd); mkdirSync(join(home,"jobs")); writeFileSync(join(cwd,"context.txt"),CONTEXT);
  installNativeFixtureCli(lane);
  const entry={index:0,id:"marker-fixture",name:"claude-job-marker-fixture",specFile:join(home,"unused.spec.json"),cliMarker:join(lane,"marker.json"),releasePath:join(lane,"release"),sessionId:"synthetic-native-session",
    worktree:{repoRoot:cwd,path:cwd,cwd,branch:"synthetic",base:"synthetic"}};
  writeFileSync(join(home,"jobs",`${entry.id}.json`),JSON.stringify({version:4,pid:process.pid,status:"running",live:true,sessionId:entry.sessionId,workdir:cwd}));
  return {home,lane,cwd,entry,script:join(lane,"bin","synthetic-claude.mjs")};
}
function waitExit(child:ChildProcess):Promise<{code:number|null;signal:NodeJS.Signals|null}> {
  return new Promise((resolve,reject)=>{child.once("error",reject); child.once("exit",(code,signal)=>resolve({code,signal}));});
}

it("publishes the actual synthetic CLI marker atomically while public readers observe large live updates", async()=>{
  const f=fixture(), messages=Array.from({length:12},(_,index)=>({id:`live-${index}`,body:`message-${index}:`+"x".repeat(96*1024)}));
  let delivered=false;
  const server=createServer((request,response)=>{
    request.resume(); response.setHeader("content-type","application/json");
    const inbox=request.url==="/inbox"&&!delivered;
    if(inbox) delivered=true;
    response.end(JSON.stringify(inbox?{messages}:{}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address(); if(!address||typeof address==="string") throw new Error("fixture server address unavailable");
  const child=spawn(process.execPath,[f.script,"--resume",f.entry.sessionId],{cwd:f.cwd,env:{...process.env,AGENT_BRIDGE_PARENT_URL:`http://127.0.0.1:${address.port}`,AGENT_BRIDGE_PARENT_TOKEN:"synthetic-only"},windowsHide:true,stdio:["pipe","pipe","pipe"]});
  child.stdout!.resume(); child.stderr!.resume(); const exited=waitExit(child);
  child.stdin!.end(`fixture_marker=${f.entry.cliMarker} fixture_release=${f.entry.releasePath}`);
  let snapshots=0;
  const observedCounts=new Set<number>(), failures:string[]=[];
  const reader=setInterval(()=>{
    try {
      const info=fixtureInfo(f.home,f.entry,"synthetic");
      if(info.markerReadError&&!info.markerReadError.includes("ENOENT")) failures.push(info.markerReadError);
      if(info.markerPublished) {
        snapshots++; observedCounts.add(info.receivedLive.length);
        if(!info.contextPreserved||info.markerSessionId!==f.entry.sessionId||info.markerCwd!==f.cwd||!info.cliPid) failures.push("incomplete public marker observation");
      }
    } catch(error) { failures.push(String(error)); }
  },1);
  try {
    await vi.waitFor(()=>expect(fixtureInfo(f.home,f.entry,"synthetic").receivedLive).toHaveLength(messages.length),{timeout:10_000,interval:10});
    await new Promise(resolve=>setTimeout(resolve,100));
    writeFileSync(f.entry.releasePath,"synthetic release");
    expect(await exited).toEqual({code:0,signal:null});
    expect(snapshots).toBeGreaterThan(10);
    expect(observedCounts.size).toBeGreaterThan(1);
    expect(failures).toEqual([]);
    expect(fixtureInfo(f.home,f.entry,"synthetic")).toMatchObject({markerExited:true,contextPreserved:true,markerReadError:null});
    expect(readdirSync(f.lane).filter(file=>file.includes(".stage-"))).toEqual([]);
  } finally {
    clearInterval(reader); writeFileSync(f.entry.releasePath,"synthetic cleanup release");
    await exited;
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
},15_000);

it("retains staging and previous marker on actual CLI rename failure, with original assertion observations", async()=>{
  const f=fixture(), previous=JSON.stringify({pid:process.pid,sessionId:"previous-native-session",cwd:f.cwd,contextSha256:"previous-hash",receivedLive:[]});
  writeFileSync(f.entry.cliMarker,previous);
  const seam=join(f.lane,"deny-rename.mjs");
  writeFileSync(seam,'import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module"; fs.renameSync=()=>{throw new Error("synthetic rename denied")}; syncBuiltinESMExports();');
  const child=spawn(process.execPath,["--import",pathToFileURL(seam).href,f.script,"--resume",f.entry.sessionId],{cwd:f.cwd,env:{...process.env},windowsHide:true,stdio:["pipe","pipe","pipe"]});
  child.stdout!.resume(); child.stderr!.resume(); const exited=waitExit(child);
  child.stdin!.end(`fixture_marker=${f.entry.cliMarker} fixture_release=${f.entry.releasePath}`);
  expect(await exited).toEqual({code:1,signal:null});
  expect(readFileSync(f.entry.cliMarker,"utf8")).toBe(previous);
  const staging=readdirSync(f.lane).filter(file=>file.includes(".stage-")); expect(staging).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(f.lane,staging[0]!),"utf8"))).toMatchObject({pid:child.pid,sessionId:f.entry.sessionId,cwd:f.cwd,receivedLive:[]});
  const original=fixtureInfo(f.home,f.entry,"synthetic");
  let failure:any;
  try { assertNativeRunnerFixtureLive([original],1,[child]); } catch(error) { failure=error; }
  expect(failure.message).toContain("Genuine old runner live/session/context assertion failed");
  expect(failure.details).toMatchObject({expectedCount:1,actualCount:1,children:[{pid:child.pid,exitCode:1,signalCode:null}],runners:[{status:"running",live:true,sessionId:f.entry.sessionId,markerSessionId:"previous-native-session",contextPreserved:false,runnerAlive:true,cliAlive:true,statePublished:true,markerReadError:null}]});
  const unavailableDiagnostics={...original};
  Object.defineProperty(unavailableDiagnostics,"receivedLive",{get:()=>{throw new Error("synthetic diagnostic unavailable");}});
  expect(()=>assertNativeRunnerFixtureLive([unavailableDiagnostics],1,[child])).toThrow("Genuine old runner live/session/context assertion failed");
  // Later disk changes cannot revise the predicate observations already attached to the error.
  writeFileSync(f.entry.cliMarker,"{"); writeFileSync(join(f.home,"jobs",`${f.entry.id}.json`),"{");
  expect(failure.details.runners[0].markerSessionId).toBe("previous-native-session");
  const malformed=fixtureInfo(f.home,f.entry,"synthetic");
  expect(malformed).toMatchObject({statePublished:false,markerPublished:false,contextPreserved:false});
  expect(malformed.stateReadError).toMatch(/JSON|position|property/i); expect(malformed.markerReadError).toBeTruthy();
},10_000);
