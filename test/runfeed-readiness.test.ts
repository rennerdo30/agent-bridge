import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as stores from "../src/core/json-store.js";
import { APP_VERSION } from "../src/core/constants.js";
import { liveStorePeers, recordStorePeer, refreshStorePeerIdentities } from "../src/core/store-compatibility.js";
import { runMetaPath, startRunFeed, startRunFeedReady } from "../src/core/runfeed.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
let env: TestEnv;
const children: ChildProcess[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  await env.cleanup();
});
function names() { return existsSync(join(env.home,"runs")) ? readdirSync(join(env.home,"runs")) : []; }
function leases() { return existsSync(join(env.home,".storage-users")) ? readdirSync(join(env.home,".storage-users")) : []; }
function reader(version: string, json=4) {
  const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true});children.push(child);
  recordStorePeer(env.home,{pid:child.pid!,name:"synthetic-supervisor",version,storeCapabilities:{json,sqlite:json===3?7:9}});
  return child;
}
it("admits a fast second turn after a supervisor publishes a new cold PID without losing its metadata",async()=>{
  const first=await startRunFeedReady({home:env.home,name:"first",header:"first exact task",meta:{job:"claude-job-fixture",model:"fake",permission:"default",session:"same-native"}},new AbortController().signal);
  first.end("done");const before=readFileSync(runMetaPath(first.logPath),"utf8");
  const next=reader(APP_VERSION);
  expect(liveStorePeers(env.home).find(peer=>peer.pid===next.pid)?.json).toBe(0);
  expect(()=>startRunFeed({home:env.home,name:"cold-strict",header:"must not be lost",requireMetadata:true})).toThrow("Waiting to upgrade");
  expect(names().some(name=>name.includes("cold-strict"))).toBe(false);expect(leases()).toEqual([]);
  const second=await startRunFeedReady({home:env.home,name:"second",header:"new exact task",meta:{job:"claude-job-fixture",model:"new-model",permission:"bypassPermissions",continues:"same-native",session:"same-native"}},new AbortController().signal);
  second.end("done");
  expect(JSON.parse(readFileSync(runMetaPath(second.logPath),"utf8"))).toMatchObject({version:4,model:"new-model",permission:"bypassPermissions",continues:"same-native",session:"same-native"});
  expect(readFileSync(runMetaPath(first.logPath),"utf8")).toBe(before);expect(leases()).toEqual([]);
});
it("retries a deferred initial write racing after readiness, without a log-only feed or leaked lease",async()=>{
  const original=stores.writeJsonStore, progress:string[]=[];
  const writing=vi.spyOn(stores,"writeJsonStore").mockImplementationOnce(()=>{
    expect(names()).toEqual([]);throw Object.assign(new Error("Synthetic new reader arrived after readiness"),{code:"STORE_UPGRADE_DEFERRED"});
  }).mockImplementation(original);
  const feed=await startRunFeedReady({home:env.home,name:"raced",header:"exact task",meta:{model:"kept"},forward:message=>{progress.push(message);if(message.startsWith("queued:")){expect(names()).toEqual([]);expect(leases()).toEqual([]);}}},new AbortController().signal);
  expect(progress.filter(message=>message.startsWith("queued:"))).toHaveLength(1);expect(writing).toHaveBeenCalledTimes(2);
  feed.end("done");expect(JSON.parse(readFileSync(runMetaPath(feed.logPath),"utf8"))).toMatchObject({model:"kept",version:4});expect(leases()).toEqual([]);
});
it("keeps genuine older readers protected and cancels admission before any feed is published",async()=>{
  const old=reader("0.29.12",3), capability=join(env.home,"storage-capabilities",`${old.pid}.json`), bytes=readFileSync(capability);
  await refreshStorePeerIdentities(env.home);expect(liveStorePeers(env.home).find(peer=>peer.pid===old.pid)?.json).toBe(3);
  const controller=new AbortController(), progress:string[]=[];
  const pending=startRunFeedReady({home:env.home,name:"blocked",header:"exact task",meta:{model:"new-model"},forward:message=>progress.push(message)},controller.signal);void pending.catch(()=>{});
  await until(()=>progress.some(message=>message.startsWith("queued:")));
  expect(names()).toEqual([]);expect(leases()).toEqual([]);
  controller.abort(new Error("Synthetic queued turn cancelled"));await expect(pending).rejects.toThrow("Synthetic queued turn cancelled");
  expect(names()).toEqual([]);expect(leases()).toEqual([]);expect(readFileSync(capability)).toEqual(bytes);
});
it("does not retry unrelated metadata IO failures and releases the strict initial lease",async()=>{
  const writing=vi.spyOn(stores,"writeJsonStore").mockImplementation(()=>{throw Object.assign(new Error("Synthetic metadata IO failure"),{code:"EIO"});});
  await expect(startRunFeedReady({home:env.home,name:"io-failed",header:"exact task"},new AbortController().signal)).rejects.toThrow("Synthetic metadata IO failure");
  expect(writing).toHaveBeenCalledTimes(1);expect(names()).toEqual([]);expect(leases()).toEqual([]);
});
