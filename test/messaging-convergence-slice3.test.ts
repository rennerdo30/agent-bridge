import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach,beforeAll,expect,it,vi} from 'vitest';

// Guarded offline lane: actual SQL uses only owned synthetic homes. No native
// provider, process, worker, socket, listener, TLS or discovery can be launched.
vi.mock('node:child_process',async original=>{const fail=()=>{throw Error('slice3 subprocess forbidden');};return {...await original<object>(),spawn:fail,spawnSync:fail,exec:fail,execSync:fail,execFile:fail,execFileSync:fail,fork:fail};});
vi.mock('node:worker_threads',async original=>({...await original<object>(),Worker:class{constructor(){throw Error('slice3 production Worker forbidden');}}}));
vi.mock('node:tls',async original=>({...await original<object>(),createServer:()=>{throw Error('slice3 TLS forbidden');},connect:()=>{throw Error('slice3 TLS forbidden');}}));
vi.mock('node:dgram',async original=>({...await original<object>(),createSocket:()=>{throw Error('slice3 UDP forbidden');}}));
vi.mock('node:net',async original=>({...await original<object>(),createServer:()=>{throw Error('slice3 native listener forbidden');},connect:()=>{throw Error('slice3 native socket forbidden');}}));
vi.mock('../src/core/process-identity.js',async original=>({...await original<object>(),processIdentity:(pid:number)=>pid===process.pid?'638968000000000000':undefined,ownProcessIdentity:async()=> '638968000000000000',parentProcessIdentity:async()=>null,isProcessIdentityAlive:(pid:number)=>pid===process.pid?true:undefined,readProcessIdentity:async()=>null,readProcessIdentities:async()=>new Map(),readProcessIdentitiesSync:()=>undefined,readProcessNamesSync:()=>undefined,processStartMs:()=>undefined}));

import {MessageStore} from '../src/core/store.js';
import {metadataDb,closeMetadataDbs} from '../src/core/metadata-db.js';
import {writeRunnerStateRecord,readRunnerStateRecord,publishRunnerSpec} from '../src/core/runner-store.js';
import {RemoteJobHost} from '../src/mcp/remote-job-host.js';
import {nullLogger} from '../src/core/logger.js';
import type {Job} from '../src/mcp/jobs.js';

const homes:string[]=[],stores:MessageStore[]=[];
function fixture(){
 const root=process.env.AGENT_BRIDGE_TEST_ROOT;if(!root)throw Error('Missing isolated test root');
 const home=mkdtempSync(join(root,'ab458-slice3-'));homes.push(home);
 const store=new MessageStore(join(home,'bridge.db'));stores.push(store);
 return {home,store,db:metadataDb(home),namespace:store.namespace};
}
beforeAll(()=>{const db=new DatabaseSync(':memory:');try{console.log('SLICE3_SQLITE_RUNTIME '+JSON.stringify({node:process.version,sqlite:db.prepare('SELECT sqlite_version() AS version').get()!.version,pid:process.pid,kind:'guarded-inprocess-synthetic'}));}finally{db.close();}});
afterEach(()=>{vi.restoreAllMocks();for(const store of stores.splice(0))store.close();closeMetadataDbs();for(const home of homes.splice(0)){const root=resolve(process.env.AGENT_BRIDGE_TEST_ROOT!);if(!resolve(home).startsWith(root+sep))throw Error('Unsafe fixture cleanup');rmSync(home,{recursive:true,force:true});}});
function original(f:ReturnType<typeof fixture>,record='full original body'){
 const generation=randomUUID(),messageId=randomUUID(),item={messageId,record};
 return {pid:process.pid,peer:'codex-job-12345678',status:'running',updatedAt:1,
  deliveryLedger:{version:1,namespace:f.namespace,generation,job:'12345678',principal:'original exact principal',entries:[item]}};
}
function job(f:ReturnType<typeof fixture>):Job{return {id:'12345678',name:'codex-job-12345678',agent:'codex',model:null,prompt:'first body',startedAt:1,owner:'owner',supervisor:'supervisor',controller:new AbortController(),queue:[],status:'running',progress:null,sessionId:null,workdir:f.home,worktree:null,args:{prompt:'first body',title:'fixture'}} as Job;}
function remoteFixture(){const f=fixture(),requests:any[]=[],settlements:((value:any)=>void)[]=[];const node={remoteJob:(host:string,request:any)=>{requests.push({host,request:structuredClone(request)});return new Promise(resolve=>settlements.push(resolve));}};return {...f,requests,settlements,remote:new RemoteJobHost(node as any,f.home,nullLogger)};}
const snapshot=()=>({state:null,alive:true,approvals:[]});

it('slice3 red: accepted original cannot be overwritten under its UUID',()=>{
 const f=fixture(),state=original(f);writeRunnerStateRecord(f.home,'12345678',state);
 expect(()=>writeRunnerStateRecord(f.home,'12345678',{...state,deliveryLedger:{...state.deliveryLedger,entries:[{...state.deliveryLedger.entries[0]!,record:'changed body'}]}})).toThrow();
 expect(readRunnerStateRecord(f.home,'12345678')?.deliveryLedger).toEqual(state.deliveryLedger);
});
it('slice3 red: active removal retains full original and exact proof in metadata',()=>{
 const f=fixture(),state=original(f);writeRunnerStateRecord(f.home,'12345678',state);
 writeRunnerStateRecord(f.home,'12345678',{...state,deliveryLedger:{...state.deliveryLedger,entries:[]}});
 const archived=f.db.prepare("SELECT value FROM bridge_metadata WHERE domain='job-state-archive' AND key>=? AND key<?").all('12345678/','12345678/~');
 expect(archived.some(row=>JSON.parse(String(row.value)).deliveryLedger?.entries?.[0]?.record==='full original body')).toBe(true);
 const proofs=f.db.prepare("SELECT value FROM bridge_metadata WHERE domain='runner-retention-proof'").all();
 expect(proofs).toHaveLength(1);expect(String(proofs[0]!.value)).toContain(state.deliveryLedger.entries[0]!.messageId);
});
it('slice3 red: actual spec reset refuses unsettled accepted generation before effects',()=>{
 const f=fixture(),state=original(f);writeRunnerStateRecord(f.home,'12345678',state);
 const before=f.db.prepare('SELECT domain,key,value,updated_at FROM bridge_metadata ORDER BY domain,key').all();
 expect(()=>publishRunnerSpec(f.home,'12345678',{job:{id:'12345678'},args:{prompt:'replacement'}})).toThrow();
 expect(f.db.prepare('SELECT domain,key,value,updated_at FROM bridge_metadata ORDER BY domain,key').all()).toEqual(before);
});
it('slice3 red: remote spawn captures exact pending request before dispatch',async()=>{
 const f=remoteFixture(),j=job(f);f.remote.start(j,'remote-host','codex',{prompt:'first body',title:'fixture',cwd:f.home});
 try{const raw=JSON.parse(readFileSync(join(f.home,'remote-job-states',j.id+'.json'),'utf8'));
  expect(raw.operations).toHaveLength(1);expect(raw.operations[0]).toMatchObject({state:'pending',turn:j.startedAt,request:{op:'spawn',job:j.id,args:{prompt:'first body'}}});
  expect(f.requests).toHaveLength(1);
 }finally{f.settlements.splice(0).forEach(done=>done(snapshot()));await Promise.resolve();await Promise.resolve();}
});
it('slice3 red: restart pending remote evidence fences start even without registry remote projection',async()=>{
 const f=remoteFixture(),j=job(f);f.remote.start(j,'remote-host','codex',{prompt:'first body',title:'fixture',cwd:f.home});
 const path=join(f.home,'remote-job-states',j.id+'.json'),before=readFileSync(path);
 try{const restored={...j,controller:new AbortController(),remote:undefined};const fresh=new RemoteJobHost({remoteJob:()=>{throw Error('forbidden replacement dispatch');}} as any,f.home,nullLogger);
  expect(()=>fresh.start(restored,'remote-host','codex',{prompt:'replacement',title:'fixture',cwd:f.home})).toThrow();
  expect(readFileSync(path)).toEqual(before);
 }finally{f.settlements.splice(0).forEach(done=>done(snapshot()));await Promise.resolve();await Promise.resolve();}
});
it('slice3 control: ordinary synthetic runner fields survive a state merge',()=>{
 const f=fixture();writeRunnerStateRecord(f.home,'12345678',{pid:process.pid,peer:'fixture',status:'running',updatedAt:1,progress:'kept'});
 writeRunnerStateRecord(f.home,'12345678',{pid:process.pid,peer:'fixture',status:'running',updatedAt:2,report:'result'});
 expect(readRunnerStateRecord(f.home,'12345678')).toMatchObject({progress:'kept',report:'result'});
 expect(existsSync(join(f.home,'bridge.db'))).toBe(true);
});
