/** Opt-in native runner rehearsal. Uses public old source and a synthetic CLI only.
 * Every repository, worktree, marker, spec, log, state, and release file is retained.
 * No installed CLI, owner home, credential file, or unrelated process is accessed. */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { nullLogger } from "../src/core/logger.js";
import { jobEnvironment } from "../src/core/job-environment.js";
import { pidAlive } from "../src/core/delegate.js";
import type { BridgeNode } from "../src/core/node.js";
import type { Worktree } from "../src/core/worktree.js";
import { JobRunners, readRunnerState, type RunnerSpec } from "../src/mcp/job-host.js";
import { JobManager, type Run } from "../src/mcp/jobs.js";
import { resumeArgs, runDelegate, type DelegateArgs, type RunContext } from "../src/mcp/delegate-run.js";

const CONTEXT = "Synthetic native runner context preserved through supervisor reload and continuation.\n";
const CONTEXT_SHA256 = createHash("sha256").update(CONTEXT).digest("hex");
export interface NativeRunnerOptions { checkout: string; home: string; count?: number; owner?: string; rootSession?: string; supervisor?: string }
export interface NativeRunnerInfo {
  index: number; id: string; name: string; version: string; pid: number; cliPid: number;
  status: string; live: boolean; sessionId: string | null; workdir: string; worktree: Worktree;
  contextSha256: string; contextPreserved: boolean; cliMarker: string; releasePath: string; receivedLive: string[];
}
interface Descriptor { index: number; id: string; name: string; specFile: string; cliMarker: string; releasePath: string; worktree: Worktree; sessionId: string }
interface Manifest { schema: 1; oldVersion: string; oldSha: string; owner: string; rootSession: string; supervisor: string; descriptors: Descriptor[]; claudeBin: string; currentCli: string }
interface Marker { pid: number; sessionId: string; cwd: string; contextSha256: string; args: string[]; receivedLive: string[]; exited?: boolean }
export interface OldRunnerFixtures {
  count: number; home: string; manifestFile: string;
  inspect(): NativeRunnerInfo[];
  assertLive(): NativeRunnerInfo[];
  release(index?: number): Promise<NativeRunnerInfo[]>;
  stop(): Promise<void>;
}
const FAKE_CLAUDE = String.raw`
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { constants, setPriority } from "node:os";
try { setPriority(0,constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Own synthetic process only. */ }
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", part => { prompt += part; });
process.stdin.on("end", async () => {
  const value = flag => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
  const marker = /fixture_marker=(\S+)/.exec(prompt)?.[1];
  const release = /fixture_release=(\S+)/.exec(prompt)?.[1];
  if (!marker || !release) throw new Error("Synthetic CLI requires contained marker/release paths");
  const sessionId = value("--resume") || "synthetic-native-" + process.pid;
  const contextSha256 = createHash("sha256").update(readFileSync(join(process.cwd(),"context.txt"))).digest("hex");
  const state = { pid:process.pid, sessionId, cwd:process.cwd(), contextSha256, args:process.argv.slice(2), receivedLive:[] };
  const save = () => writeFileSync(marker,JSON.stringify(state));
  save(); appendFileSync(marker + ".calls.jsonl",JSON.stringify({...state,at:Date.now()}) + "\n");
  console.log(JSON.stringify({type:"system",subtype:"init",session_id:sessionId,model:"synthetic-native-cli"}));
  const parent = process.env.AGENT_BRIDGE_PARENT_URL, token = process.env.AGENT_BRIDGE_PARENT_TOKEN;
  const call = async (path,body) => {
    const response = await fetch(parent + path,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer " + token},body:JSON.stringify(body),signal:AbortSignal.timeout(2000)});
    if (!response.ok) throw new Error("Synthetic parent-link HTTP " + response.status);
    return response.json();
  };
  if (!parent || !token) throw new Error("Actual runner must supply its synthetic parent link");
  await call("/progress",{percent:1,note:"Synthetic native turn held for release rehearsal"});
  while (!existsSync(release)) {
    try {
      const result = await call("/inbox",{});
      for (const message of result.messages || []) {
        state.receivedLive.push(message.body); save();
        appendFileSync(marker + ".live.jsonl",JSON.stringify({body:message.body,sessionId,at:Date.now()}) + "\n");
        await call("/message",{body:"Synthetic native CLI consumed: " + message.body,reply_to:message.id});
      }
    } catch (error) { appendFileSync(marker + ".deferred.jsonl",JSON.stringify({error:String(error),at:Date.now()}) + "\n"); }
    await new Promise(resolve => setTimeout(resolve,250));
  }
  state.exited = true; save();
  console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"Synthetic native turn completed with retained context",session_id:sessionId}));
});
`;
function contained(root: string, file: string): string {
  const resolved = resolve(file), rel = relative(root, resolved);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Native runner fixture must be strictly below its synthetic root");
  for (let current = resolved; current !== root; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Native runner fixture paths cannot traverse links");
    if (dirname(current) === current) throw new Error("Native runner fixture containment failed");
  }
  return resolved;
}
function paths(options: NativeRunnerOptions): { checkout: string; home: string; lane: string } {
  const checkout = realpathSync.native(options.checkout), root = join(checkout,".agent-bridge-test");
  const home = realpathSync.native(contained(root,options.home));
  const lane = contained(home,join(home,"native-runner-fixture")); mkdirSync(lane,{recursive:true});
  return {checkout,home,lane};
}
function childEnvironment(home: string): NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv = {...jobEnvironment(),AGENT_BRIDGE_HOME:home,AGENT_BRIDGE_BACKUP_INTERVAL_MS:"0",AGENT_BRIDGE_DASHBOARD:"off",AGENT_BRIDGE_LOG_LEVEL:"silent"};
  for (const key of Object.keys(env)) if (key.startsWith("AGENT_BRIDGE_PARENT_") || key.startsWith("AGENT_BRIDGE_ROOT_") || key === "AGENT_BRIDGE_DELEGATE_DEPTH" || key === "AGENT_BRIDGE_PARENT_JOB") delete env[key];
  for (const [key,part] of Object.entries({CODEX_HOME:"codex",CLAUDE_CONFIG_DIR:"claude",XDG_DATA_HOME:"xdg",ANTIGRAVITY_CLI_HOME:"antigravity"})) { const folder=join(home,"empty-cli",part); mkdirSync(folder,{recursive:true}); env[key]=folder; }
  return env;
}
async function until(check: () => boolean | Promise<boolean>, milliseconds = 90_000): Promise<void> {
  const end = Date.now()+milliseconds;
  while (!await check()) { if (Date.now()>end) throw new Error("Native runner fixture condition timed out"); await delay(100); }
}
function installCli(lane: string): string {
  const bin=join(lane,"bin"); mkdirSync(bin,{recursive:true});
  const script=join(bin,"synthetic-claude.mjs"); writeFileSync(script,`#!/usr/bin/env node\n${FAKE_CLAUDE}`,{flag:"wx"});
  if (process.platform === "win32") { const shim=join(bin,"claude.cmd"); writeFileSync(shim,`@ECHO off\r\n"${process.execPath}" "%~dp0\\synthetic-claude.mjs" %*\r\n`,{flag:"wx"}); return shim; }
  chmodSync(script,0o755); return script;
}
async function bundleRunners(checkout: string, lane: string): Promise<{oldCli:string;currentCli:string;old:any;oldSha:string}> {
  const oldRoot=join(checkout,".agent-bridge-test","rehearsal-old"), oldCli=join(lane,"old-runner-runtime.mjs"), currentCli=join(lane,"current-runner-runtime.mjs");
  const entry = (root:string) => [
    `export { APP_VERSION } from ${JSON.stringify(join(root,"src/core/constants.ts"))};`,
    `export { DEFAULT_CONFIG } from ${JSON.stringify(join(root,"src/core/config.ts"))};`,
    `export { JSON_STORE_VERSION, readJsonStore, writeJsonStore } from ${JSON.stringify(join(root,"src/core/json-store.ts"))};`,
    `import { runJobRunner } from ${JSON.stringify(join(root,"src/mcp/job-runner.ts"))};`,
    "export { runJobRunner };",
    'import { constants, setPriority } from "node:os";',
    'import { writeFileSync } from "node:fs";',
    'try { setPriority(0,constants.priority.PRIORITY_BELOW_NORMAL); } catch {}',
    'if (process.argv[2] === "--native-fixture-runner" || process.argv[2] === "job-runner") { writeFileSync(new URL(`runner-start-${process.pid}.json`,import.meta.url),JSON.stringify({pid:process.pid,specFile:process.argv[3],startedAt:Date.now()})); try { process.exitCode = await runJobRunner(process.argv[3]); } catch (error) { writeFileSync(new URL(`runner-error-${process.pid}.json`,import.meta.url),JSON.stringify({error:String(error),stack:error?.stack})); process.exitCode=1; } }',
  ].join("\n");
  for (const [root,outfile] of [[oldRoot,oldCli],[checkout,currentCli]]) await build({stdin:{contents:entry(root!),resolveDir:checkout},outfile,bundle:true,platform:"node",format:"esm",target:"node22",nodePaths:[join(checkout,"node_modules")],packages:"external",logLevel:"silent"});
  const old=await import(pathToFileURL(oldCli).href);
  if (old.APP_VERSION !== "0.29.17") throw new Error("Native rehearsal requires genuine public 0.29.17 runner source");
  const oldSha=execFileSync("git",["-C",oldRoot,"rev-parse","HEAD"],{encoding:"utf8",windowsHide:true}).trim();
  return {oldCli,currentCli,old,oldSha};
}
function fixtureInfo(home:string,entry:Descriptor,version:string): NativeRunnerInfo {
  const state=readRunnerState(home,entry.id);
  let marker:Marker|undefined; try { marker=JSON.parse(readFileSync(entry.cliMarker,"utf8")); } catch { /* A marker is published during native CLI startup. */ }
  const context=readFileSync(join(entry.worktree.cwd,"context.txt"));
  return {index:entry.index,id:entry.id,name:entry.name,version,pid:state?.pid ?? 0,cliPid:marker?.pid ?? 0,status:state?.status ?? "starting",live:Boolean(state?.live),sessionId:state?.sessionId ?? null,workdir:state?.workdir ?? entry.worktree.cwd,worktree:entry.worktree,contextSha256:createHash("sha256").update(context).digest("hex"),contextPreserved:context.equals(Buffer.from(CONTEXT)) && marker?.contextSha256 === CONTEXT_SHA256,cliMarker:entry.cliMarker,releasePath:entry.releasePath,receivedLive:marker?.receivedLive ?? []};
}
function fixturePidAlive(pid:number):boolean { return Number.isSafeInteger(pid)&&pid>0&&pidAlive(pid); }
function launchedRunner(lane:string,specFile:string,startedAt:number):number {
  for(const file of readdirSync(lane).filter(file=>/^runner-start-\d+\.json$/.test(file))) {
    const witness=JSON.parse(readFileSync(join(lane,file),"utf8"));
    if(witness.specFile===specFile&&witness.startedAt>=startedAt&&Number.isSafeInteger(witness.pid)&&witness.pid>0) return witness.pid;
  }
  return 0;
}

export async function startOldRunnerFixtures(options: NativeRunnerOptions): Promise<OldRunnerFixtures> {
  const {checkout,home,lane}=paths(options), count=options.count ?? 11;
  if (!Number.isInteger(count) || count<1 || count>24) throw new Error("Native rehearsal runner count must be1..24");
  const owner=options.owner ?? "old-session-0", rootSession=options.rootSession ?? "synthetic-root", supervisor=options.supervisor ?? "synthetic-session-0";
  const claudeBin=installCli(lane), runtime=await bundleRunners(checkout,lane), repository=join(lane,"repository"); mkdirSync(repository);
  const git=(args:string[])=>execFileSync("git",args,{cwd:repository,windowsHide:true,stdio:"pipe",encoding:"utf8"}).trim();
  git(["init","--quiet"]); writeFileSync(join(repository,"context.txt"),CONTEXT,{flag:"wx"}); git(["add","context.txt"]);
  git(["-c","user.name=rennerdo30","-c","user.email=9086097+rennerdo30@users.noreply.github.com","commit","--quiet","-m","Seed synthetic native runner fixture"]);
  const base=git(["rev-parse","HEAD"]), baseBranch=git(["branch","--show-current"]);
  mkdirSync(join(home,"worktrees"),{recursive:true}); mkdirSync(join(home,"jobs"),{recursive:true});
  const controls=join(lane,"controls"); mkdirSync(controls);
  const descriptors:Descriptor[]=[], processes:ChildProcess[]=[];
  const cfg={...runtime.old.DEFAULT_CONFIG,claudeBin,maxJobs:count+2,dashboard:false,jobCloseCleanup:false,notifications:{approvals:false,finish:false,fail:false}};
  try { for (let index=0;index<count;index++) {
    const id=randomUUID().replaceAll("-","").slice(0,8), name=`claude-job-${id}`, workdir=contained(home,join(home,"worktrees",`native-release-${id}`)), branch=`native-release-${id}`;
    git(["worktree","add","--quiet","-b",branch,workdir,base]);
    const worktree:Worktree={repoRoot:repository,path:workdir,cwd:workdir,branch,base,baseBranch};
    const cliMarker=join(lane,`runner-${index}.marker.json`), releasePath=join(controls,`runner-${index}.release`), specFile=join(home,"jobs",`${id}.spec.json`);
    const prompt=`fixture_marker=${cliMarker} fixture_release=${releasePath} Hold this synthetic native turn with its retained context.`;
    const args:DelegateArgs={prompt,title:`Native release fixture${index}`,cwd:workdir,access:"read",worktree:false,_worktree:worktree,_job:name,timeout_sec:3600};
    const job={id,name,agent:"claude",model:null,prompt,startedAt:Date.now(),args,sessionId:null,workdir,worktree,owner,supervisor,metadataVersion:2,rootSession,rootName:owner,allowedServers:[],status:"running",host:{pid:null,peer:name,startedAt:Date.now()}};
    const spec:RunnerSpec={home,target:"claude",args,base:args,job:job as unknown as RunnerSpec["job"],owner,byAgent:"codex",cwd:workdir,cfg};
    runtime.old.writeJsonStore(specFile,{...spec},null);
    const stored=runtime.old.readJsonStore(join(home,"jobs.json")), records=Array.isArray(stored?.jobs)?stored.jobs:[];
    runtime.old.writeJsonStore(join(home,"jobs.json"),{jobs:[...records,job]},stored);
    const child=spawn(process.execPath,[runtime.oldCli,"--native-fixture-runner",specFile],{cwd:workdir,env:childEnvironment(home),windowsHide:true,stdio:["ignore","pipe","pipe"]}); processes.push(child);
    let stdout="",stderr=""; child.stdout?.on("data",value=>{stdout=(stdout+String(value)).slice(-65536);}); child.stderr?.on("data",value=>{stderr=(stderr+String(value)).slice(-65536);});
    child.once("exit",(code,signal)=>writeFileSync(join(lane,`runner-${index}.exit.json`),JSON.stringify({pid:child.pid,code,signal,stdout,stderr})));
    const entry:Descriptor={index,id,name,specFile,cliMarker,releasePath,worktree,sessionId:""}; descriptors.push(entry);
    await until(()=>{if(child.exitCode!==null || child.signalCode!==null) throw new Error(`Genuine old runner${index} exited during startup:${stdout}${stderr}`); const info=fixtureInfo(home,entry,"0.29.17"); return info.status==="running" && info.live && info.sessionId?.startsWith("synthetic-native-")===true && info.cliPid>0 && info.contextPreserved;});
    entry.sessionId=readRunnerState(home,id)!.sessionId!;
    const latest=runtime.old.readJsonStore(join(home,"jobs.json"));
    runtime.old.writeJsonStore(join(home,"jobs.json"),{jobs:latest.jobs.map((saved:any)=>saved.id===id?{...saved,sessionId:entry.sessionId,host:{...saved.host,pid:child.pid}}:saved)},latest);
    writeFileSync(join(controls,`turn-${index}-initial.json`),JSON.stringify({index,releasePath}),{flag:"wx"});
  } } catch (error) {
    for(const entry of descriptors) writeFileSync(entry.releasePath,"Synthetic startup failure release.\n");
    try { await until(()=>processes.every(child=>child.exitCode!==null || child.signalCode!==null),15000); }
    catch { for(const child of processes) if(child.exitCode===null && child.signalCode===null) child.kill("SIGTERM"); await until(()=>processes.every(child=>child.exitCode!==null || child.signalCode!==null),20000); }
    throw error;
  }
  const manifest:Manifest={schema:1,oldVersion:"0.29.17",oldSha:runtime.oldSha,owner,rootSession,supervisor,descriptors,claudeBin,currentCli:runtime.currentCli};
  const manifestFile=join(lane,"manifest.json"); writeFileSync(manifestFile,JSON.stringify(manifest,null,2),{flag:"wx"});
  const inspect=()=>descriptors.map(entry=>fixtureInfo(home,entry,manifest.oldVersion));
  const turnControls=()=>readdirSync(controls).filter(file=>file.startsWith("turn-")&&file.endsWith(".json")).map(file=>JSON.parse(readFileSync(join(controls,file),"utf8")));
  const releaseFiles=(index?:number)=>{for(const control of turnControls()) if(index===undefined || control.index===index) writeFileSync(contained(controls,control.releasePath),"Synthetic turn released.\n");};
  const release=async(index?:number)=>{releaseFiles(index);await until(()=>inspect().filter(info=>index===undefined || info.index===index).every(info=>info.status!=="running"),30000);return inspect();};
  const result:OldRunnerFixtures={count,home,manifestFile,inspect,assertLive:()=>{const infos=inspect();if(infos.length!==count || infos.some(info=>info.status!=="running" || !info.live || !info.contextPreserved || !pidAlive(info.pid) || !pidAlive(info.cliPid))) throw new Error("Genuine old runner live/session/context assertion failed");return infos;},release,stop:async()=>{
    releaseFiles();
    const stopped=()=>processes.every(child=>child.exitCode!==null || child.signalCode!==null) && inspect().every(info=>!fixturePidAlive(info.pid)&&!fixturePidAlive(info.cliPid)) && turnControls().filter(control=>control.continued).every(control=>{const pid=launchedRunner(lane,control.specFile,control.startedAt);return pid>0&&!fixturePidAlive(pid);});
    try { await until(stopped,30000); }
    catch { for(const child of processes) if(child.exitCode===null && child.signalCode===null) child.kill("SIGTERM"); await until(stopped,20000); }
  }};
  result.assertLive(); return result;
}

/** Run in the replacement session process, with its real BridgeNode. Takes over
 * actual held runners, sends a live message to their synthetic native CLI, then
 * continues one released turn through current JobManager/JobRunners with --resume. */
export async function continueNativeRunnerFixture(options: NativeRunnerOptions & {node:BridgeNode;index?:number}): Promise<Record<string,unknown>> {
  const {home,lane}=paths(options), manifest=JSON.parse(readFileSync(join(lane,"manifest.json"),"utf8")) as Manifest;
  const entry=manifest.descriptors[options.index ?? 0]; if(!entry) throw new Error("Native continuation fixture index unavailable");
  const cfg={...DEFAULT_CONFIG,claudeBin:manifest.claudeBin,maxJobs:manifest.descriptors.length+2,dashboard:false,jobCloseCleanup:false,notifications:{approvals:false,finish:false,fail:false}};
  const node=options.node, manager=new JobManager(node,nullLogger,join(home,"jobs.json"),cfg.maxJobs);
  const runners=new JobRunners(node,home,manifest.currentCli,nullLogger); manager.runners=runners;
  const rc:RunContext={agent:"codex",cfg,home,log:nullLogger,me:()=>node.name,cwd:()=>entry.worktree.cwd,jobs:manager};
  manager.restore((agent,base)=>(message,sessionId,workdir,worktree)=>{
    const args=resumeArgs(base as unknown as DelegateArgs,entry.name,message,sessionId,workdir,worktree,base);
    const run:Run=(signal,onProgress,job)=>runDelegate(rc,agent as "claude",args,signal,onProgress,true,job);
    run.hosted=job=>runners.start(job,{target:"claude",args,base:base as unknown as DelegateArgs,owner:node.name,byAgent:"codex",cwd:workdir ?? entry.worktree.cwd,cfg}); return run;
  });
  let continuedRelease:string|undefined;
  let continuationLaunched=false, continuationStartedAt=0;
  try {
    const initial=fixtureInfo(home,entry,manifest.oldVersion), liveBody=`Synthetic native live continuity${randomUUID()}`;
    if(initial.status!=="running" || !initial.live || !initial.contextPreserved) throw new Error("Native held turn was not preserved across supervisor reload");
    const delivered=manager.followUp(entry.name,liveBody);
    if(delivered.outcome!=="delivered") throw new Error(`Current JobManager did not take over real old runner:${delivered.outcome}`);
    await until(()=>fixtureInfo(home,entry,manifest.oldVersion).receivedLive.includes(liveBody),15000);
    writeFileSync(entry.releasePath,"Synthetic first turn released.\n");
    await until(()=>readRunnerState(home,entry.id)?.status==="done" && !pidAlive(initial.pid),30000);
    const releasePath=join(lane,"controls",`runner-${entry.index}-continued-${randomUUID()}.release`);
    continuedRelease=releasePath;
    continuationStartedAt=Date.now();
    const controlFile=join(lane,"controls",`turn-${entry.index}-${randomUUID()}.json`);
    writeFileSync(controlFile,JSON.stringify({index:entry.index,releasePath}),{flag:"wx"});
    const prompt=`fixture_marker=${entry.cliMarker} fixture_release=${releasePath} Continue this synthetic native turn in its exact retained session and worktree.`;
    const continued=manager.followUp(entry.name,prompt);
    if(continued.outcome!=="started") throw new Error(`Current native continuation did not start:${continued.outcome}`);
    continuationLaunched=true;
    writeFileSync(controlFile,JSON.stringify({index:entry.index,releasePath,continued:true,specFile:entry.specFile,startedAt:continuationStartedAt}));
    await until(()=>{for(const file of readdirSync(lane).filter(file=>/^runner-error-\d+\.json$/.test(file))) {const failure=JSON.parse(readFileSync(join(lane,file),"utf8"));throw new Error(`Current native runner startup failed:${failure.error}`);} const info=fixtureInfo(home,entry,"current");return info.status==="running"&&info.live&&info.sessionId===entry.sessionId&&info.pid!==initial.pid&&info.contextPreserved;},30000);
    const marker=JSON.parse(readFileSync(entry.cliMarker,"utf8")) as Marker;
    if(!marker.args.includes("--resume") || marker.sessionId!==entry.sessionId || marker.cwd!==entry.worktree.cwd) throw new Error("Current native CLI did not resume exact old session/worktree context");
    const snapshot=fixtureInfo(home,entry,"current");
    writeFileSync(releasePath,"Synthetic continuation released.\n");
    await until(()=>readRunnerState(home,entry.id)?.status==="done" && !pidAlive(snapshot.pid),30000);
    return {genuineOldRunJobRunner:true,genuineCurrentRunJobRunner:true,currentJobManagerTakeover:true,nativeLiveMessageConsumed:true,oldVersion:manifest.oldVersion,oldSha:manifest.oldSha,oldPid:initial.pid,newPid:snapshot.pid,job:entry.name,sessionId:entry.sessionId,worktree:entry.worktree.path,contextSha256:CONTEXT_SHA256,contextPreserved:true,continuedViaResume:true};
  } finally {
    try {
      if(continuedRelease) {
        if(!existsSync(continuedRelease)) writeFileSync(continuedRelease,"Synthetic continuation released during cleanup.\n");
        if(continuationLaunched) await until(()=>{const pid=launchedRunner(lane,entry.specFile,continuationStartedAt),info=fixtureInfo(home,entry,"current");return pid>0&&!fixturePidAlive(pid)&&!fixturePidAlive(info.pid)&&!fixturePidAlive(info.cliPid);},30000);
      }
    } finally { manager.cancelAll(); }
  }
}
