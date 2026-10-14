import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { pageRuns, readRunLogs, readRunLogsResponsive, readRunLogsSteps } from "../src/core/run-history.js";
import { listRuns, listRunsResponsive } from "../src/core/dashboard-read.js";
import { drainScan } from "../src/core/responsive-scan.js";
import * as fileCache from "../src/core/file-cache.js";
const calls=vi.hoisted(()=>({count:false,lstats:0}));
vi.mock("node:fs",async original=>{
  const actual=await original<typeof import("node:fs")>();
  return {...actual,lstatSync:(...args:Parameters<typeof actual.lstatSync>)=>{if(calls.count)calls.lstats++;return actual.lstatSync(...args);}};
});

afterEach(() => {vi.restoreAllMocks();calls.count=false;calls.lstats=0;});
function corpus(count: number): string {
  const root = join(process.cwd(), ".agent-bridge-test", "tmp"); fs.mkdirSync(root, { recursive: true });
  const home = fs.mkdtempSync(join(root, "warm-run-witness-")), runs = join(home, "runs"); fs.mkdirSync(runs);
  for (let i = 0; i < count; i++) {
    const path = join(runs, `2026-10-08-00-00-00-codex-${String(i).padStart(5, "0")}`);
    fs.writeFileSync(`${path}.log`, "00:00:00 header\n00:00:01 finished · done\n");
    fs.writeFileSync(`${path}.json`, JSON.stringify({ job: `codex-job-${i}`, future: { retained: [i] } }));
  }
  return home;
}
it("validates every warm file identity with bounded directory resolution instead of per-file realpath", async () => {
  const home = corpus(1000), original = await readRunLogsResponsive(home);
  const native = vi.spyOn(fs.realpathSync, "native"), reads = vi.spyOn(fileCache, "readJsonSnapshot");
  // Deterministic operation-count proof; actual wall-clock gates use the real clock.
  const realNow = performance.now.bind(performance);vi.spyOn(performance,"now").mockReturnValue(100);
  const begin = realNow(), warm = await readRunLogsResponsive(home);
  const count = native.mock.calls.length;
  console.info(JSON.stringify({ gate: "warm-run-native-resolution", records: warm.length, nativeRealpathCalls: count, milliseconds: realNow() - begin }));
  expect(warm).toEqual(original); expect(reads).not.toHaveBeenCalled();
  expect(count).toBeLessThan(300);
},30000);
it("bounds parent identity checks linearly for many distinct contained link targets",async()=>{
  const home=corpus(1000),root=join(home,"runs");
  for(let i=0;i<1000;i++){
    const parent=join(root,`target-${i}`);fs.mkdirSync(parent);
    const name=`2026-10-08-00-00-00-codex-${String(i).padStart(5,"0")}.json`,target=join(parent,name);
    fs.renameSync(join(root,name),target);fs.symlinkSync(target,join(root,name),"file");
  }
  const original=await readRunLogsResponsive(home);vi.spyOn(performance,"now").mockReturnValue(100);
  calls.lstats=0;calls.count=true;const warm=await readRunLogsResponsive(home);calls.count=false;
  console.info(JSON.stringify({gate:"warm-many-parent-stat-count",records:warm.length,physicalParents:1000,lstatCalls:calls.lstats}));
  expect(warm).toEqual(original);expect(calls.lstats).toBeLessThan(10000);
},30000);

/** Pause after the first stat-only warm batch, before its next root guard. */
function pausedWarm(home: string) {
  const root = join(home,"runs"), original=fs.realpathSync.native;
  let rootChecks=0;
  const native=vi.spyOn(fs.realpathSync,"native").mockImplementation((...args:Parameters<typeof fs.realpathSync.native>)=>{
    if(String(args[0])===root)rootChecks++;
    return original(...args);
  });
  const scan=readRunLogsSteps(home,undefined,true);
  for(let steps=0;steps<10000;steps++){
    const step=scan.next();
    if(step.done)throw new Error("Warm scan ended before guarded batch suspension");
    if(rootChecks>=5)return {scan,native};
  }
  throw new Error("Warm scan did not reach guarded batch suspension");
}
function moveIntoLink(path:string,target:string,retained:string):void{
  fs.renameSync(path,retained);
  fs.symlinkSync(target,path,process.platform==="win32"?"junction":"dir");
}
it.each(["runs-root","archive","nested-target"])("rejects a warm %s ancestor replaced by an outside link between batches",async which=>{
  const home=corpus(80),root=join(home,"runs"),outside=corpus(1), external=join(outside,"runs");
  let parent=root;
  if(which==="archive"){
    parent=join(root,"archive");fs.mkdirSync(parent);
    for(const name of fs.readdirSync(root).filter(name=>name.endsWith(".json")||name.endsWith(".log")))fs.renameSync(join(root,name),join(parent,name));
  }else if(which==="nested-target"){
    parent=join(root,"nested");fs.mkdirSync(parent);
    for(let i=0;i<80;i++){
      const name=`2026-10-08-00-00-00-codex-${String(i).padStart(5,"0")}.json`, target=join(parent,name);
      fs.renameSync(join(root,name),target);fs.symlinkSync(target,join(root,name),"file");
    }
  }
  await readRunLogsResponsive(home);
  const {scan}=pausedWarm(home),retained=join(home,`retained-${which}`);
  const reads=vi.spyOn(fileCache,"readJsonSnapshot");
  moveIntoLink(parent,external,retained);
  expect(drainScan(scan)).toEqual([]);
  expect(reads).not.toHaveBeenCalled();
  expect(fs.readFileSync(join(retained,"2026-10-08-00-00-00-codex-00000.json"),"utf8")).toContain("codex-job-0");
});
it("rejects a same-path physical parent replacement with new inode identity",async()=>{
  const home=corpus(80),root=join(home,"runs");await readRunLogsResponsive(home);
  const {scan}=pausedWarm(home),retained=join(home,"retained-original-runs");
  fs.renameSync(root,retained);fs.mkdirSync(root);
  const reads=vi.spyOn(fileCache,"readJsonSnapshot");
  expect(drainScan(scan)).toEqual([]);expect(reads).not.toHaveBeenCalled();
  expect(fs.readdirSync(retained)).toHaveLength(160);
});
it("rejects a changed file identity between warm batches and retries fresh metadata",async()=>{
  const home=corpus(80);await readRunLogsResponsive(home);const {scan,native}=pausedWarm(home);
  const path=join(home,"runs","2026-10-08-00-00-00-codex-00079.json");
  fs.writeFileSync(path,JSON.stringify({job:"changed-job",future:{retained:["changed"]}}));
  expect(drainScan(scan)).toEqual([]);native.mockRestore();
  expect((await readRunLogsResponsive(home)).find(run=>run.name.endsWith("00079"))?.meta.job).toBe("changed-job");
});
it("rejects same-size/restored-mtime file replacement by fresh inode identity",async()=>{
  const home=corpus(80);await readRunLogsResponsive(home);const {scan,native}=pausedWarm(home);
  const path=join(home,"runs","2026-10-08-00-00-00-codex-00079.json"), before=fs.statSync(path),original=fs.readFileSync(path,"utf8");
  const replacement=original.replace("codex-job-79","codex-job-XX");expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
  fs.renameSync(path,`${path}.retained-original`);fs.writeFileSync(path,replacement);fs.utimesSync(path,before.atime,before.mtime);
  expect(drainScan(scan)).toEqual([]);native.mockRestore();
  expect((await readRunLogsResponsive(home)).find(run=>run.name.endsWith("00079"))?.meta.job).toBe("codex-job-XX");
  expect(fs.readFileSync(`${path}.retained-original`,"utf8")).toBe(original);
});
it("rejects an original caller-root alias redirected between warm batches",async()=>{
  const home=corpus(80),outside=corpus(1),alias=join(home,"caller-home-alias");
  fs.symlinkSync(home,alias,process.platform==="win32"?"junction":"dir");await readRunLogsResponsive(alias);
  const {scan}=pausedWarm(alias),reads=vi.spyOn(fileCache,"readJsonSnapshot");
  fs.renameSync(alias,join(home,"retained-caller-alias"));fs.symlinkSync(outside,alias,process.platform==="win32"?"junction":"dir");
  expect(drainScan(scan)).toEqual([]);expect(reads).not.toHaveBeenCalled();
});
it("keeps stable aliases and resolved internal targets with exact projection, cursor and clone parity",async()=>{
  const home=corpus(80),root=join(home,"runs"),nested=join(root,"nested");fs.mkdirSync(nested);
  const name="2026-10-08-00-00-00-codex-00000.json", target=join(nested,name);
  fs.renameSync(join(root,name),target);fs.symlinkSync(target,join(root,name),"file");
  const alias=join(home,"stable-home-alias");fs.symlinkSync(home,alias,process.platform==="win32"?"junction":"dir");
  const original=await readRunLogsResponsive(alias),warm=await readRunLogsResponsive(alias);
  expect(warm).toEqual(original);expect(readRunLogs(alias)).toEqual(original);
  (warm[0]!.meta as any).future.retained.push("caller mutation");
  expect(await readRunLogsResponsive(alias)).toEqual(original);
  const now=Date.now(),sync=listRuns(alias,now),responsive=await listRunsResponsive(alias,now);
  expect(responsive).toEqual(sync);const page=pageRuns(responsive,null,20);
  expect(page).toEqual(pageRuns(sync,null,20));expect(pageRuns(responsive,page.next,20)).toEqual(pageRuns(sync,page.next,20));
});
