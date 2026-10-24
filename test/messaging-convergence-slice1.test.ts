import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

// This selection cannot launch a provider, process, native helper, socket server
// or production Worker, including through a newly introduced indirect call.
const transport = vi.hoisted(()=>({active:'',protocol:0,writes:[] as string[],nativeOpens:[] as {file:string;readOnly:boolean}[],hooks:{} as Record<string,any>}));
vi.mock('node:fs',async original=>{
 const fs=await original<Record<string,any>>(),wrapped={...fs};
 for(const name of ['openSync','readFileSync','writeFileSync','appendFileSync','copyFileSync','renameSync','mkdirSync','statSync'])wrapped[name]=(...args:any[])=>{const value=fs[name](...args);transport.hooks.fs?.(name,args[0]);return value;};
 return wrapped;
});
vi.mock('node:tls',async original=>({...await original<object>(),createServer:(...args:any[])=>{if(!transport.hooks.tls)throw Error('native TLS forbidden');return transport.hooks.tls(...args);},connect:()=>{throw Error('native TLS connection forbidden');}}));
vi.mock('node:dgram',async original=>({...await original<object>(),createSocket:()=>{if(!transport.hooks.udp)throw Error('native UDP forbidden');return transport.hooks.udp();}}));
vi.mock('node:os',async original=>({...await original<object>(),networkInterfaces:()=>({})}));
vi.mock('node:sqlite',async original=> {
 const sqlite=await original<typeof import('node:sqlite')>();
 return {...sqlite,DatabaseSync:new Proxy(sqlite.DatabaseSync,{construct(target,args,newTarget){
  transport.nativeOpens.push({file:String(args[0]),readOnly:args[1]?.readOnly===true});
  transport.hooks.sqliteOpen?.(String(args[0]),args[1]); // Trap unsafe synthetic inputs BEFORE the real SQLite pager.
  return Reflect.construct(target,args,newTarget);
 }})};
});
vi.mock('node:child_process',async original=>{
 const forbidden=()=>{throw Error('subprocess forbidden in slice1 selection');};
 return {...await original<object>(),spawn:forbidden,spawnSync:forbidden,exec:forbidden,execSync:forbidden,execFile:(...args:any[])=>transport.hooks.execFile?transport.hooks.execFile(...args):forbidden(),execFileSync:(...args:any[])=>transport.hooks.execFileSync?transport.hooks.execFileSync(...args):forbidden(),fork:forbidden};
});
vi.mock('../src/core/history-background.js',async original=>({...await original<object>(),HistoryBackground:class {
 constructor(){if(!transport.hooks.maintenance)throw Error('production history worker forbidden');transport.hooks.maintenance('history');}
 reconcileAsks(){return Promise.resolve();} close(){transport.hooks.maintenance?.('history-close');return Promise.resolve();}
}}));
vi.mock('../src/core/job-archive-background.js',async original=>({...await original<object>(),JobArchiveBackground:class {
 constructor(){if(!transport.hooks.maintenance)throw Error('production archive worker forbidden');transport.hooks.maintenance('archive');}
 repack(){} close(){transport.hooks.maintenance?.('archive-close');return Promise.resolve();}
}}));
vi.mock('../src/core/job-run-index.js',async original=>{const actual=await original<Record<string,any>>();return {...actual,
 startBrokerJobRunIndex:(...args:any[])=>transport.hooks.maintenance?(transport.hooks.maintenance('index'),Promise.resolve()):actual.startBrokerJobRunIndex(...args),
 stopJobRunBackfill:(...args:any[])=>transport.hooks.maintenance?(transport.hooks.maintenance('index-close'),Promise.resolve()):actual.stopJobRunBackfill(...args)};});
vi.mock('node:worker_threads',async original=>({...await original<object>(),Worker:class {constructor(){throw Error('production Worker forbidden in slice1 selection');}}}));
vi.mock('../src/core/process-identity.js',async original=>({...await original<object>(),
 processIdentity:(pid:number)=>pid===process.pid ? '638968000000000000' : undefined,
 ownProcessIdentity:async()=> '638968000000000000', parentProcessIdentity:async()=>null,
 isProcessIdentityAlive:(pid:number)=>pid===process.pid ? true : undefined,
 readProcessIdentity:async()=>null,readProcessIdentities:async()=>new Map(),readProcessIdentitiesSync:()=>undefined,readProcessNamesSync:()=>undefined,
 processStartMs:()=>undefined,
}));
vi.mock('node:net',async original=> {
 const {EventEmitter} = await import('node:events');
  return {...await original<object>(),createServer:(...args:any[])=>{if(!transport.hooks.net)throw Error('native server forbidden in slice1 selection');return transport.hooks.net(...args);},connect:(path:string)=> {
  const socket = new class extends EventEmitter {
   destroyed=false; setEncoding(){return this;} end(){return this;} destroy(){this.destroyed=true;return this;}
   write(raw:string){const frame=JSON.parse(raw.trim());transport.writes.push(frame.op);queueMicrotask(()=>this.emit('data',JSON.stringify({t:'res',id:frame.id,ok:true,result:{protocol:transport.protocol,brokerPid:1}})+'\n'));return true;}
  };
  queueMicrotask(()=>transport.protocol || path===transport.active ? socket.emit('connect') : socket.emit('error',Object.assign(Error('synthetic absent'),{code:'ENOENT'})));
  return socket;
 }};
});

import { MessageStore, openMessageStore } from '../src/core/store.js';
import { metadataDb, closeMetadataDbs, migrateMessagingHome, retainMetadataReader, metadataDbOpen, metadataReaderRetained } from '../src/core/metadata-db.js';
import { openArchive, snapshotDatabase } from '../src/core/sqlite-maintenance.js';
import { attachStoreCompatibility } from '../src/core/store-compatibility-overlay.js';
import { ResourceSlots } from '../src/core/resource-slots.js';
import { BridgeError } from '../src/core/protocol.js';
import { assertCurrentMailboxEnvelope, preflightMessagingHome, inspectMailbox } from '../src/core/mailbox-layout.js';
import { configureSqlite, assertSqliteAuthority } from '../src/core/sqlite-policy.js';
import { admissionSqliteBusy, storageAdmissionTimeout, withStorageAdmission } from '../src/core/storage-admission.js';
import { StartupBudget } from '../src/core/startup-budget.js';
import { guardPriorEndpoints, priorEndpoints } from '../src/core/prior-endpoints.js';
import { BridgeClient } from '../src/core/client.js';
import { Broker } from '../src/core/broker.js';
import { BridgeNode } from '../src/core/node.js';
import { runBrokerDaemon } from '../src/cli/broker-daemon.js';
import { NativeChildren } from '../src/core/native-children.js';
import { EndpointReservation } from '../src/core/endpoint-reservation.js';
import { NetworkService } from '../src/network/link.js';
import { NetworkDiscovery } from '../src/network/discovery.js';
import { writeMusePrivateJsonAsync } from '../src/core/muse-context.js';
import { JobRunners } from '../src/mcp/job-host.js';
import { RootConcurrency } from '../src/core/root-concurrency.js';
import { openHistoryStore } from '../src/core/history-store.js';
import { nullLogger } from '../src/core/logger.js';
import { PROTOCOL_VERSION, APP_VERSION } from '../src/core/constants.js';
import { SQLITE_STORE_VERSION, METADATA_COMPONENT_VERSION } from '../src/core/store-version.js';
import { CONVERSATION_MIGRATION } from '../src/core/conversation-schema.js';

const closes: (()=>void)[] = [];
const home = () => {const path=resolve('.agent-bridge-test/slice1-fixtures',randomUUID());mkdirSync(path,{recursive:true});return path;};
const sha = (path:string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const tree = (path:string):string[]=>existsSync(path) ? readdirSync(path,{withFileTypes:true}).flatMap(item=>item.isDirectory()?tree(join(path,item.name)):[join(path,item.name)]).sort() : [];
const database = (path:string)=>{const db=new DatabaseSync(path);closes.push(()=>{if(db.isOpen)db.close();});return db;};
beforeAll(()=>{const db=new DatabaseSync(':memory:');try {console.log('SLICE1_SQLITE_RUNTIME '+JSON.stringify({node:process.version,pid:process.pid,...db.prepare('SELECT sqlite_version() AS sqlite,sqlite_source_id() AS sqliteSourceId').get()}));}finally{db.close();}});
afterEach(async()=>{vi.restoreAllMocks();vi.useRealTimers();for(const close of closes.splice(0).reverse())await close();closeMetadataDbs();vi.unstubAllEnvs();transport.active='';transport.protocol=0;transport.writes=[];transport.nativeOpens=[];transport.hooks={};});
const fileState = (path:string) => tree(path).map(file=>[file,sha(file)] as const);
/** Approved quiescent inspection allowance only. Every original file survives;
 * only exact inspected SHM is volatile. New exact WAL must be empty, and this
 * small synthetic fixture's SHM fits the documented first 32768-byte hash unit.
 * This is not a production WAL/SHM size limit or concurrent-writer hash claim. */
function expectInspectionPreserved(path:string,file:string,before:readonly (readonly [string,string])[]) {
 const after=new Map(fileState(path));
 for (const [original,hash] of before) {
  expect(after.has(original),original+' retained').toBe(true);
  if(original!==file+'-shm')expect(after.get(original),original+' original bytes').toBe(hash);
 }
 for(const [created] of after) if(!before.some(([original])=>original===created)) {
  expect([file+'-wal',file+'-shm'],created+' exact coordination only').toContain(created);
  if(created===file+'-wal')expect(lstatSync(created).size).toBe(0);
 }
 for(const suffix of ['-wal','-shm']) if(after.has(file+suffix)) {
  const stat=lstatSync(file+suffix);expect(stat.isFile() && !stat.isSymbolicLink() && stat.nlink===1).toBe(true);
  if(suffix==='-shm')expect(stat.size).toBeLessThanOrEqual(32768);
 }
}
function logicalState(db:DatabaseSync) {
 const schema=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
 const rows=db.prepare('PRAGMA table_list').all().filter(row=>row.schema==='main' && row.type==='table').map(row=>String(row.name)).sort().map(name=> {
  const quoted='"'+name.replaceAll('"','""')+'"';
  return [name,db.prepare(`SELECT * FROM ${quoted}`).all().map(row=>JSON.stringify(row)).sort()];
 });
 return {version:db.prepare('PRAGMA user_version').get(),schema,rows};
}
function shipping() {
 const source=home(),destination=join(home(),'isolated');
 // Existing committed fixture: generated from tagged source, seeded ONLY with
 // synthetic records. Upgrade its s7 to shipping s9 using main's additive SQL.
 copyFileSync('test/fixtures/sqlite-upgrade/v0.29.14/bridge.db',join(source,'bridge.db'));
 const db=database(join(source,'bridge.db'));
 db.exec(CONVERSATION_MIGRATION);
 db.exec(`CREATE TABLE peer_last_seen(name TEXT PRIMARY KEY,seen_at INTEGER NOT NULL);
 INSERT INTO peer_last_seen SELECT name,MAX(learned_at) FROM peer_names GROUP BY name;
 PRAGMA user_version=9;
 CREATE TABLE bridge_components(name TEXT PRIMARY KEY,version INTEGER NOT NULL);
 INSERT INTO bridge_components VALUES ('metadata',1);
 CREATE TABLE bridge_metadata(domain TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(domain,key));
 CREATE TABLE bridge_read_receipts(identity TEXT NOT NULL,message_id TEXT NOT NULL,read_at INTEGER,PRIMARY KEY(identity,message_id));
 INSERT INTO bridge_metadata VALUES ('synthetic-retained','original','{"unknown":true}',1);`);
 const messages=db.prepare('SELECT * FROM messages ORDER BY id,recipient').all();db.close();
 return {source,destination,messages,original:sha(join(source,'bridge.db'))};
}
function candidate() {const path=home(),store=new MessageStore(join(path,'bridge.db'),nullLogger);closes.push(()=>store.close());return {path,store};}

it('keeps one p12/m7/s15 contract without another pairing/JSON/runner bump',()=> {
 expect([PROTOCOL_VERSION,METADATA_COMPONENT_VERSION,SQLITE_STORE_VERSION]).toEqual([12,7,15]);
});
it('admits token-first fresh storage and verifies each actual authority writer',()=> {
 const path=home();writeFileSync(join(path,'token'),'synthetic-only');
 const store=new MessageStore(join(path,'bridge.db'),nullLogger);closes.push(()=>store.close());
 const metadata=metadataDb(path);assertSqliteAuthority(metadata);
 const own=store as unknown as {db:DatabaseSync;archiveDb:DatabaseSync;historyDb:DatabaseSync};
 for(const db of [own.db,own.archiveDb,own.historyDb]) {assertSqliteAuthority(db);expect(db.prepare('PRAGMA busy_timeout').get()!.timeout).toBe(3000);}
 expect(metadata.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()!.version).toBe(7);
 assertCurrentMailboxEnvelope(own.db);expect(readFileSync(join(path,'token'),'utf8')).toBe('synthetic-only');
});
it('detects the broken main WAL/NORMAL policy rather than relying on SQLite defaults',()=> {
 const db=database(join(home(),'authority.db'));
 db.exec('PRAGMA synchronous=NORMAL; PRAGMA journal_mode=WAL;');
 expect(()=>assertSqliteAuthority(db)).toThrow('WAL/FULL');configureSqlite(db);assertSqliteAuthority(db);
});
it('allows a mocked native phase longer than two seconds within the original ten',async()=> {
 vi.useFakeTimers();const budget=new StartupBudget();closes.push(()=>budget.close());
 await vi.advanceTimersByTimeAsync(3500);
 const store=openMessageStore(':memory:',nullLogger,()=>budget.remaining());closes.push(()=>store.close());
 expect(budget.remaining()).toBe(6500);
});
it.each(['expiry','abort'])('denies a late returned native handle and closes only owned handles: %s',(kind)=> {
 vi.useFakeTimers();const path=home(),budget=new StartupBudget();closes.push(()=>budget.close());
 const exec=DatabaseSync.prototype.exec;let late=false,entered=0;
 vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){
  const result=exec.call(this,sql);
  if(!late && sql.includes('PRAGMA user_version = 14')) {late=true;entered++;if(kind==='expiry')vi.setSystemTime(Date.now()+11_000);else budget.abort(Error('synthetic abort'));}
  return result;
 });
 expect(()=>openMessageStore(join(path,'bridge.db'),nullLogger,()=>budget.remaining())).toThrow();
 expect(entered).toBe(1);expect(existsSync(join(path,'archive.db'))).toBe(false);expect(existsSync(join(path,'history.db'))).toBe(false);
 expect(readdirSync(join(path,'.storage-users'))).toEqual([]);
 // No second constructor/callback is invoked to make this attempt green.
});
it('caps both approved history timeout sites and restores the ordinary policy',()=> {
 const db=database(join(home(),'history.db'));db.close();
 let now=0;
 withStorageAdmission(()=>240-now,()=> {
  expect(storageAdmissionTimeout(3000)).toBe(240);
  const history=openHistoryStore(join(home(),'history.db'));closes.push(()=>history.close());
  expect(history.prepare('PRAGMA busy_timeout').get()!.timeout).toBeLessThanOrEqual(240);
 });
 const raw=database(join(home(),'policy.db'));raw.exec('PRAGMA busy_timeout=3000');
 withStorageAdmission(()=>120,()=>{admissionSqliteBusy(raw,3000,true);expect(raw.prepare('PRAGMA busy_timeout').get()!.timeout).toBe(120);});
 expect(raw.prepare('PRAGMA busy_timeout').get()!.timeout).toBe(3000);
});
it.each([2,3,4,5,6,7,8,9,10,11])('refuses p%s before disclosing a token or writing registration',async protocol=> {
 transport.protocol=protocol;const client=await BridgeClient.connect('synthetic-current',nullLogger);closes.push(()=>client.close());
 await expect(client.request('auth',{protocol:12,token:'synthetic-only'})).rejects.toMatchObject({code:'protocol_mismatch'});
 expect(transport.writes).toEqual(['ping']);
});
it('checks every historical endpoint including p11 and refuses active old ownership',async()=> {
 const path=home(),names=priorEndpoints(path);expect(names.some(name=>name.includes('-p11'))).toBe(true);
 transport.active=names[0]!;const budget=new StartupBudget();closes.push(()=>budget.close());
 await expect(guardPriorEndpoints(path,'synthetic-current',budget)).rejects.toMatchObject({code:'protocol_mismatch'});
 expect(transport.writes).toEqual([]);
});
it('refuses a shipping home despite endpoint absence and a still cached old handle',()=> {
 const fixture=shipping(),old=database(join(fixture.source,'bridge.db'));
 expect(()=>new MessageStore(join(fixture.source,'bridge.db'),nullLogger)).toThrow(/offline|Shipping/);
 expect(old.prepare('SELECT * FROM messages ORDER BY id,recipient').all()).toEqual(fixture.messages);
 expect(sha(join(fixture.source,'bridge.db'))).toBe(fixture.original);expect(existsSync(fixture.destination)).toBe(false);
});
it.each(['namespace','envelope','future','draft'])('refuses %s before metadata, snapshots or schema repair',kind=> {
 const {path,store}=candidate();store.close();closeMetadataDbs();
 const db=database(join(path,'bridge.db'));
 if(kind==='namespace')db.exec('DELETE FROM mailbox_store');
 if(kind==='envelope')db.exec('DROP TABLE message_frontends');
 if(kind==='future')db.exec('PRAGMA user_version=16');
 if(kind==='draft')db.exec("UPDATE bridge_components SET version=6 WHERE name='metadata'");
 const logicalBefore=logicalState(db);db.close();const before=fileState(path);
 expect(()=>metadataDb(path)).toThrow();expect(()=>new MessageStore(join(path,'bridge.db'),nullLogger)).toThrow();
 expect(inspectMailbox(join(path,'bridge.db'),logicalState)).toEqual(logicalBefore);
 expectInspectionPreserved(path,join(path,'bridge.db'),before);
});
it.each([2,3,4,5,6,10,11,12,13,14])('never automatically reinterprets draft version %s',version=> {
 const {path,store}=candidate();store.close();closeMetadataDbs();
 const db=database(join(path,'bridge.db'));
 if(version<=6)db.prepare("UPDATE bridge_components SET version=? WHERE name='metadata'").run(version);
 else db.exec(`PRAGMA user_version=${version}`);
 const logicalBefore=logicalState(db);db.close();const before=fileState(path);
 expect(()=>new MessageStore(join(path,'bridge.db'),nullLogger)).toThrow();
 expect(inspectMailbox(join(path,'bridge.db'),logicalState)).toEqual(logicalBefore);
 expectInspectionPreserved(path,join(path,'bridge.db'),before);
});
it.each(['empty-main','truncated-main','orphan-sidecars'])('retains %s before any native SQLite open',kind=> {
 const path=home(),file=join(path,'bridge.db');
 if(kind==='empty-main')writeFileSync(file,Buffer.alloc(0));
 if(kind==='truncated-main') {
  const header=Buffer.alloc(100);header.write('SQLite format 3\0');header.writeUInt16BE(4096,16);writeFileSync(file,header);
 }
 writeFileSync(file+'-wal','synthetic retained WAL original');
 writeFileSync(file+'-shm','synthetic retained coordination');
 writeFileSync(file+'-journal','synthetic retained rollback original');
 const before=fileState(path),opens=transport.nativeOpens.length;
 expect(()=>preflightMessagingHome(path)).toThrow();
 expect(transport.nativeOpens.slice(opens)).toEqual([]);expect(fileState(path)).toEqual(before);
});
it('retains hardlinked exact-family inputs before native inspection',()=> {
 const path=home(),file=join(path,'bridge.db');copyFileSync('test/fixtures/sqlite-upgrade/v0.29.14/bridge.db',file);
 linkSync(file,file+'-wal');const before=fileState(path),opens=transport.nativeOpens.length;
 expect(()=>preflightMessagingHome(path)).toThrow();expect(transport.nativeOpens.slice(opens)).toEqual([]);expect(fileState(path)).toEqual(before);
});
it('does not reject a rollback journal solely because it exists',()=> {
 const path=home(),file=join(path,'bridge.db');copyFileSync('test/fixtures/sqlite-upgrade/v0.29.14/bridge.db',file);
 // A zeroed journal header represents a committed/nonhot PERSIST journal.
 // Arbitrary nonzero bytes do not prove that condition (retained separately).
 const journal=Buffer.alloc(1024);writeFileSync(file+'-journal',journal);
 expect(readFileSync(file+'-journal').subarray(0,28)).toEqual(Buffer.alloc(28));
 const before=fileState(path);
 expect(inspectMailbox(file,db=>db.prepare('PRAGMA user_version').get()!.user_version)).toBe(7);
 expectInspectionPreserved(path,file,before);
});
it('retains arbitrary nonzero journal as ambiguous readonly refusal',()=> {
 const path=home(),file=join(path,'bridge.db');copyFileSync('test/fixtures/sqlite-upgrade/v0.29.14/bridge.db',file);
 const journal=Buffer.from('synthetic nonhot original');expect(journal.length).toBe(25);
 expect(createHash('sha256').update(journal).digest('hex')).toBe('c1f7df91d40a823d391c20bdcfa2f3378dbe74a5b20f59d4aa5a72131cfcff66');
 writeFileSync(file+'-journal',journal);const before=fileState(path),opens=transport.nativeOpens.length;
 // Preserve the observed ambiguous refusal, without claiming a hot-journal
 // proof or a particular extended SQLite error code from arbitrary bytes.
 expect(()=>inspectMailbox(file,db=>db.prepare('PRAGMA user_version').get())).toThrow(/readonly database/);
 expect(transport.nativeOpens.slice(opens)).toEqual([{file,readOnly:true}]);
 expectInspectionPreserved(path,file,before);
});
it('propagates mocked READONLY_ROLLBACK without repair, checkpoint or writable retry',()=> {
 const path=home(),file=join(path,'bridge.db');copyFileSync('test/fixtures/sqlite-upgrade/v0.29.14/bridge.db',file);
 writeFileSync(file+'-journal','synthetic retained hot-boundary evidence');const before=fileState(path),opens=transport.nativeOpens.length;
 const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec,statements:string[]=[];
 vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,sql:string){
  if(this.location('main')===file && sql==='PRAGMA user_version')throw Object.assign(Error('SQLITE_READONLY_ROLLBACK: recovery requires a writer'),{code:'ERR_SQLITE_ERROR',errcode:776});
  return prepare.call(this,sql);
 });
 vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){if(this.location('main')===file)statements.push(sql);return exec.call(this,sql);});
 expect(()=>metadataDb(path)).toThrow(/READONLY_ROLLBACK/);
 expect(transport.nativeOpens.slice(opens)).toEqual([{file,readOnly:true}]);expect(statements).toEqual(['BEGIN','ROLLBACK']);
 expect(fileState(path)).toEqual(before);
});
it('reads committed WAL evidence and retains all original WAL bytes on quiescent refusal',()=> {
 const {path,store}=candidate(),file=join(path,'bridge.db');store.close();closeMetadataDbs();
 const writer=database(file);writer.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO bridge_metadata VALUES ('synthetic-wal','proof','committed in WAL',1); DELETE FROM mailbox_store;");
 const retainedReader=new DatabaseSync(file,{readOnly:true,timeout:0});
 try {retainedReader.exec('BEGIN');retainedReader.prepare('SELECT * FROM mailbox_store').all();writer.close();}
 finally {if(retainedReader.isTransaction)retainedReader.exec('ROLLBACK');retainedReader.close();}
 expect(lstatSync(file+'-wal').size).toBeGreaterThan(0);
 writeFileSync(join(path,'unrelated-evidence.bin'),'unrelated original');const before=fileState(path);
 expect(()=>preflightMessagingHome(path)).toThrow(/envelope/);
 expect(inspectMailbox(file,db=>db.prepare("SELECT value FROM bridge_metadata WHERE domain='synthetic-wal' AND key='proof'").get()!.value)).toBe('committed in WAL');
 expectInspectionPreserved(path,file,before);
});
it('classifies one SQL read view while another synthetic connection commits a component change',()=> {
 const {path,store}=candidate(),file=join(path,'bridge.db');store.close();closeMetadataDbs();
 const writer=database(file);writer.exec('PRAGMA wal_autocheckpoint=0');
 const observed=inspectMailbox(file,db=> {
  expect(db.isTransaction).toBe(true);const version=db.prepare('PRAGMA user_version').get()!.user_version;
  writer.exec("UPDATE bridge_components SET version=6 WHERE name='metadata'");
  expect(db.isTransaction).toBe(true);return {version,metadata:db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()!.version};
 });
 expect(observed).toEqual({version:15,metadata:7});
 expect(()=>preflightMessagingHome(path)).toThrow(/metadata component 6/);
 // Concurrent writer effects are intentionally not attributed by a whole-tree hash.
});
it('provides a read-only exact-home plan and a finite m1/s9 isolated migration',async()=> {
 const f=shipping(),before=fileState(f.source);
 // Bounded metadata-only diagnosis of the previous importer failure, inside
 // this admitted run. Never log row values or open a separate probe process.
 const prepare=DatabaseSync.prototype.prepare;let examined=0;
 let projectionEvidence:{table:string;requestedKey:string;returnedKeys:string[]}|undefined;
 const projectionSpy=vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,sql:string){
  const match=/^SELECT "(rowid|_rowid_|oid)" AS "__migration_column_0",/.exec(sql);
  if(!projectionEvidence && match && examined<32 && this.location('main')?.includes('.migration-snapshots')) {
   examined++;const legacy=prepare.call(this,sql.replace(/ AS "__migration_column_\d+"/g,''));legacy.setReadBigInts(true);
   const row=legacy.get();
   if(row && !Object.hasOwn(row,match[1]!)) {
    projectionEvidence={table:String(legacy.columns()[0]!.table),requestedKey:match[1]!,returnedKeys:Object.keys(row)};
    console.log('SLICE1_LEGACY_ROWID_PROJECTION '+JSON.stringify(projectionEvidence));
   }
  }
  return prepare.call(this,sql);
 });
 const plan=await migrateMessagingHome({source:f.source,destination:f.destination});
 expect(plan.applied).toBe(false);expect(existsSync(f.destination)).toBe(false);expectInspectionPreserved(f.source,join(f.source,'bridge.db'),before);
 await expect(migrateMessagingHome({source:f.source,destination:f.destination,apply:true})).rejects.toThrow('attestation');
 await migrateMessagingHome({source:f.source,destination:f.destination,apply:true,offlineIsolated:true});
 projectionSpy.mockRestore();expect(projectionEvidence).toBeDefined();
 const db=database(join(f.destination,'bridge.db'));expect(db.prepare('SELECT * FROM messages ORDER BY id,recipient').all()).toEqual(f.messages);
 expect(db.prepare("SELECT count(*) AS n FROM message_frontends WHERE state='ambiguous' AND owner='' AND source='' AND mailbox=''").get()!.n).toBe(f.messages.length);
 expect(db.prepare("SELECT value FROM bridge_metadata WHERE domain='synthetic-retained'").get()!.value).toBe('{"unknown":true}');
 assertCurrentMailboxEnvelope(db);expect(sha(join(f.source,'bridge.db'))).toBe(f.original);
 expect(tree(f.destination).some(path=>path.includes('.migration-snapshots'))).toBe(true);
});
it('preserves INTEGER PRIMARY KEY aliases, shadowed rowids and WITHOUT ROWID value fidelity',async()=> {
 const f=shipping(),source=database(join(f.source,'bridge.db')),blob=new Uint8Array([0,255,128,1]);
 source.exec(`CREATE TABLE binding_integer_pk(id INTEGER PRIMARY KEY,"__migration_column_0" TEXT,payload BLOB,nullable TEXT,wide INTEGER);
 CREATE TABLE binding_shadow(rowid TEXT,value INTEGER,payload BLOB,nullable TEXT);
 CREATE TABLE binding_without(a TEXT,b INTEGER,payload BLOB,nullable TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID;`);
 source.prepare('INSERT INTO binding_integer_pk VALUES (?,?,?,?,?)').run(9007199254740993n,'synthetic alias column',blob,null,-9007199254740993n);
 source.prepare('INSERT INTO binding_shadow(_rowid_,rowid,value,payload,nullable) VALUES (?,?,?,?,?)').run(9007199254740995n,'synthetic shadow',-9007199254740995n,blob,null);
 source.prepare('INSERT INTO binding_without VALUES (?,?,?,?)').run('synthetic key',9007199254740997n,blob,null);
 const queries=['SELECT rowid AS implicit_id,* FROM binding_integer_pk','SELECT _rowid_ AS implicit_id,* FROM binding_shadow','SELECT * FROM binding_without'];
 const read=(db:DatabaseSync)=>queries.map(sql=>{const statement=db.prepare(sql);statement.setReadBigInts(true);return statement.all();});
 const expected=read(source),schema=source.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'binding_%' ORDER BY name").all();
 expect(expected).toEqual([
  [{implicit_id:9007199254740993n,id:9007199254740993n,__migration_column_0:'synthetic alias column',payload:blob,nullable:null,wide:-9007199254740993n}],
  [{implicit_id:9007199254740995n,rowid:'synthetic shadow',value:-9007199254740995n,payload:blob,nullable:null}],
  [{a:'synthetic key',b:9007199254740997n,payload:blob,nullable:null}],
 ]);
 source.close();const original=sha(join(f.source,'bridge.db'));
 await migrateMessagingHome({source:f.source,destination:f.destination,apply:true,offlineIsolated:true});
 const migrated=database(join(f.destination,'bridge.db'));
 expect(read(migrated)).toEqual(expected);
 expect(migrated.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'binding_%' ORDER BY name").all()).toEqual(schema);
 expect(sha(join(f.source,'bridge.db'))).toBe(original);assertCurrentMailboxEnvelope(migrated);
});
it('refuses a real committed WAL change after planning and retains its durable input identity',async()=> {
 const f=shipping(),file=join(f.source,'bridge.db'),writer=database(file);
 writer.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO bridge_metadata VALUES ('synthetic-wal-change','before','retained',1)");
 const holder=new DatabaseSync(file,{readOnly:true,timeout:0});closes.push(()=>{if(holder.isOpen)holder.close();});
 holder.exec('BEGIN');holder.prepare('SELECT * FROM bridge_metadata').all();writer.close();
 const plan=await migrateMessagingHome({source:f.source,destination:f.destination}),wal=file+'-wal',originalWal=readFileSync(wal);
 const stat=lstatSync(wal,{bigint:true});expect(stat.size).toBeGreaterThan(0n);
 expect(plan.inputs.find(input=>input.path==='bridge.db-wal')).toEqual({path:'bridge.db-wal',role:'wal',bytes:Number(stat.size),
  identity:`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,sha256:sha(wal)});
 const originalMain=sha(file),identity=await import('../src/core/process-identity.js');let changed=false;
 vi.spyOn(identity,'ownProcessIdentity').mockImplementation(async()=>{
  const external=database(file);external.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO bridge_metadata VALUES ('synthetic-wal-change','after','not admitted',2)");external.close();
  changed=true;return '638968000000000000';
 });
 await expect(migrateMessagingHome({source:f.source,destination:f.destination,apply:true,offlineIsolated:true})).rejects.toThrow('Source changed after planning');
 expect(changed).toBe(true);expect(existsSync(f.destination)).toBe(false);expect(sha(file)).toBe(originalMain);
 expect(sha(wal)).not.toBe(plan.inputs.find(input=>input.path==='bridge.db-wal')!.sha256);
 expect(readFileSync(wal).subarray(0,originalWal.length)).toEqual(originalWal);
});
it.each(['snapshot','committed-ddl'])('resumes one immutable interrupted attempt after %s, retaining all originals',async boundary=> {
 const f=shipping(),exec=DatabaseSync.prototype.exec,prepare=DatabaseSync.prototype.prepare;let injected=false;
 const prepareSpy=vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,sql:string){
  if(boundary==='snapshot' && !injected && sql==='VACUUM INTO ?'){injected=true;throw Error('synthetic snapshot interruption');}
  return prepare.call(this,sql);
 });
 const execSpy=vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){
  const result=exec.call(this,sql);
  if(boundary==='committed-ddl' && !injected && sql==='COMMIT' && this.location('main')===join(f.destination,'bridge.db') && Number(prepare.call(this,'PRAGMA user_version').get()!.user_version)===15){injected=true;throw Error('synthetic unknown COMMIT');}
  return result;
 });
 const options={source:f.source,destination:f.destination,apply:true,offlineIsolated:true};
 await expect(migrateMessagingHome(options)).rejects.toThrow();expect(injected).toBe(true);prepareSpy.mockRestore();execSpy.mockRestore();
 const db=database(join(f.destination,'bridge.db'));
 const before=JSON.parse(String(db.prepare("SELECT value FROM bridge_metadata WHERE domain='messaging-migration'").get()!.value));db.close();
 expect(()=>preflightMessagingHome(f.destination)).toThrow();
 await migrateMessagingHome(options);
 const finished=database(join(f.destination,'bridge.db'));
 const after=JSON.parse(String(finished.prepare("SELECT value FROM bridge_metadata WHERE domain='messaging-migration'").get()!.value));
 expect(after.id).toBe(before.id);expect(after.inputId).toBe(before.inputId);expect(after.phase).toBe('ready');
 expect(finished.prepare('SELECT * FROM messages ORDER BY id,recipient').all()).toEqual(f.messages);expect(sha(join(f.source,'bridge.db'))).toBe(f.original);
});
it('holds candidate-ready CAS failure even with complete tables and a metadata fence row',async()=> {
 const f=shipping(),exec=DatabaseSync.prototype.exec;let installed=false;
 const spy=vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){
  const result=exec.call(this,sql);
  if(!installed && sql==='COMMIT' && this.location('main')===join(f.destination,'bridge.db') && Number(this.prepare('PRAGMA user_version').get()!.user_version)===15){installed=true;exec.call(this,"CREATE TRIGGER synthetic_ready_failure BEFORE UPDATE OF state ON messaging_candidate WHEN new.state='ready' BEGIN SELECT RAISE(IGNORE); END");}
  return result;
 });
 await expect(migrateMessagingHome({source:f.source,destination:f.destination,apply:true,offlineIsolated:true})).rejects.toThrow('CAS failed');spy.mockRestore();
 const db=database(join(f.destination,'bridge.db'));
 expect(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()!.version).toBe(7);
 expect(JSON.parse(String(db.prepare("SELECT value FROM bridge_metadata WHERE domain='messaging-migration'").get()!.value)).phase).toBe('imported');
 expect(()=>preflightMessagingHome(f.destination)).toThrow();expect(sha(join(f.source,'bridge.db'))).toBe(f.original);
});
it('keeps a late mocked recovery from activating or starting a subsequent phase',async()=> {
 vi.useFakeTimers();const store=new MessageStore(':memory:',nullLogger);closes.push(()=>store.close());
 const broker=new Broker('synthetic-current',store,nullLogger,'synthetic-only');
 const server=Object.assign(new EventEmitter(),{listening:true,close:(done:()=>void)=>done()});
 const reservation={ownedServer:()=>server,activate:vi.fn(),close:vi.fn(async()=>{})};
 let finish!:()=>void;const phase=new Promise<void>(resolve=>{finish=resolve;});
 vi.spyOn(broker as unknown as {startServices():Promise<void>},'startServices').mockImplementation(()=>phase);
 vi.spyOn(broker as unknown as {abortStartup():Promise<void>},'abortStartup').mockResolvedValue();
 const budget=new StartupBudget();closes.push(()=>budget.close());
 const result=broker.listen(reservation as never,budget);const rejection=expect(result).rejects.toThrow();
 await vi.advanceTimersByTimeAsync(10_001);finish();await rejection;
 expect(reservation.activate).not.toHaveBeenCalled();expect(reservation.close).toHaveBeenCalledOnce();
});

it('review7: real recovery joins bounded busy retries at the original startup expiry',async()=> {
 vi.useFakeTimers();const store=new MessageStore(':memory:',nullLogger);closes.push(()=>store.close());store.retainNativeChild('synthetic/sub:a','synthetic');
 const broker=new Broker('synthetic',store,nullLogger,'synthetic-only'),server=Object.assign(new EventEmitter(),{listening:true,close:(done:()=>void)=>done()});
 const reservation={ownedServer:()=>server,activate:vi.fn(),close:vi.fn(async()=>{})},budget=new StartupBudget();closes.push(()=>budget.close());
 const exec=DatabaseSync.prototype.exec;let attempts=0,state='pending';
 vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){if(sql==='BEGIN IMMEDIATE'){attempts++;throw Object.assign(Error('database is locked'),{errcode:5});}return exec.call(this,sql);});
 const result=broker.listen(reservation as never,budget).then(()=>{state='resolved';},()=>{state='rejected';});
 try {await vi.advanceTimersByTimeAsync(10_001);for(let n=0;n<20;n++)await Promise.resolve();const atExpiry=attempts;
  expect(state).toBe('rejected');await vi.advanceTimersByTimeAsync(500);expect(attempts).toBe(atExpiry);expect(reservation.activate).not.toHaveBeenCalled();expect(reservation.close).toHaveBeenCalledOnce();
 } finally {store.close();await result;}
});
it('review7: real route recovery rolls back if a synchronous route step crosses startup expiry',async()=> {
 vi.useFakeTimers();const f=candidate(),store=f.store;store.retainNativeChild('synthetic/sub:a','synthetic');
 const db=(store as unknown as {db:DatabaseSync}).db;
 db.exec("INSERT INTO messages VALUES ('recovery-original','synthetic/sub:a','synthetic-id','synthetic-sender','other','synthetic/sub:a','synthetic-conversation',NULL,0,'synthetic retained message',1,NULL)");
 const originalRoutes=db.prepare('SELECT * FROM native_child_routes ORDER BY address').all(),originalMessages=db.prepare('SELECT rowid,* FROM messages ORDER BY rowid').all(),normal=db.prepare('PRAGMA busy_timeout').get()!.timeout;
 const budget=new StartupBudget();closes.push(()=>budget.close());
 // Store statements are frozen; move the fake clock in the actual SQL driver instead.
 const prepare=DatabaseSync.prototype.prepare;
 vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,sql:string){const statement=prepare.call(this,sql);if(sql==='UPDATE native_child_routes SET active=0 WHERE address=?'){vi.setSystemTime(Date.now()+10_001);}return statement;});
 await expect(new NativeChildren(store).recover(budget)).rejects.toThrow();expect(db.isTransaction).toBe(false);
 expect(db.prepare('SELECT * FROM native_child_routes ORDER BY address').all()).toEqual(originalRoutes);expect(db.prepare('SELECT rowid,* FROM messages ORDER BY rowid').all()).toEqual(originalMessages);
 expect(db.prepare('PRAGMA busy_timeout').get()!.timeout).toBe(normal);
 const other=database(join(f.path,'bridge.db'));other.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');expect(other.isTransaction).toBe(true);other.exec('ROLLBACK');expect(store.nativeChildRoutes()).toHaveLength(1);
});
it.each(['history.db','archive.db','store-compatibility.db','owner-questions.db'])('review7: guards selected auxiliary %s before native snapshot or destination effects',async name=> {
 const f=shipping(),file=join(f.source,name);if(name==='history.db')writeFileSync(file,Buffer.alloc(0));else if(name==='archive.db')writeFileSync(file,Buffer.alloc(100));
 writeFileSync(file+(name==='owner-questions.db'?'-journal':'-wal'),'synthetic retained sidecar');const before=fileState(f.source),opens=transport.nativeOpens.length;
 await expect(migrateMessagingHome({source:f.source,destination:f.destination,apply:true,offlineIsolated:true})).rejects.toThrow();
 expect(existsSync(f.destination)).toBe(false);expect(transport.nativeOpens.slice(opens).some(open=>open.file===file)).toBe(false);
 for(const [path,hash] of before)expect(sha(path)).toBe(hash);
});
it.each(['data','cancel'])('review7: final endpoint await cannot publish ready after %s changes',async kind=> {
 const f=shipping(),controller=new AbortController(),endpoints=await import('../src/core/prior-endpoints.js');let checks=0,changed=false;
 vi.spyOn(endpoints,'guardPriorEndpoints').mockImplementation(async()=>{if(++checks===4){changed=true;if(kind==='cancel')controller.abort(Error('synthetic final cancellation'));else{const db=database(join(f.source,'bridge.db'));db.exec("UPDATE bridge_metadata SET value='changed after await' WHERE domain='synthetic-retained'");db.close();}}});
 await expect(migrateMessagingHome({source:f.source,destination:f.destination,apply:true,offlineIsolated:true,signal:controller.signal})).rejects.toThrow();expect(changed).toBe(true);
 const db=database(join(f.destination,'bridge.db'));if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='messaging_candidate'").get())expect(db.prepare('SELECT state FROM messaging_candidate').get()!.state).not.toBe('ready');
 expect(JSON.parse(String(db.prepare("SELECT value FROM bridge_metadata WHERE domain='messaging-migration'").get()!.value)).phase).not.toBe('ready');
});
it.each([false,true])('review7: resumes two alternates only with same-attempt completion proof tamper=%s',async tamper=> {
 const f=shipping(),names=['alpha.db','beta.db'];for(const name of names)copyFileSync(join(f.source,'bridge.db'),join(f.source,name));
 const overlay=database(join(f.source,'store-compatibility.db'));overlay.exec(`CREATE TABLE session_bindings(identity TEXT NOT NULL,session_id TEXT NOT NULL,learned_at INTEGER NOT NULL,PRIMARY KEY(identity,session_id));CREATE TABLE peer_names(identity TEXT NOT NULL,name TEXT NOT NULL,session_id TEXT,agent TEXT NOT NULL,learned_at INTEGER NOT NULL,PRIMARY KEY(identity,name));CREATE TABLE peer_name_owners(name TEXT PRIMARY KEY,identity TEXT NOT NULL);CREATE TABLE job_delivery_routes(id TEXT PRIMARY KEY,recipient TEXT NOT NULL,consumed_at INTEGER);CREATE TABLE peer_last_seen(name TEXT PRIMARY KEY,seen_at INTEGER NOT NULL);PRAGMA user_version=1;INSERT INTO peer_last_seen VALUES('synthetic-overlay-peer',77);INSERT INTO session_bindings VALUES('synthetic-overlay-identity','synthetic-session',12);`);overlay.close();const overlayHash=sha(join(f.source,'store-compatibility.db'));
 const originals=names.map(name=>sha(join(f.source,name))),exec=DatabaseSync.prototype.exec,migrationTransactions=new WeakSet<DatabaseSync>();let interrupted=false,alphaCommits=0,alphaMigrations=0,ordinaryOpening=false;
 const storeModule=await import('../src/core/store.js'),migrate=storeModule.migrateMessageSchema;vi.spyOn(storeModule,'migrateMessageSchema').mockImplementation((db,file,...rest)=>{if(!ordinaryOpening&&file===join(f.destination,'alpha.db'))alphaMigrations++;return migrate(db,file,...rest);});
 const spy=vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){if(sql==='BEGIN IMMEDIATE'&&this.location('main')===join(f.destination,'alpha.db')&&Number(this.prepare('PRAGMA user_version').get()!.user_version)<15)migrationTransactions.add(this);const result=exec.call(this,sql);if(sql==='COMMIT'&&migrationTransactions.has(this)&&Number(this.prepare('PRAGMA user_version').get()!.user_version)===15){migrationTransactions.delete(this);alphaCommits++;if(!interrupted){interrupted=true;throw Error('synthetic first alternate unknown COMMIT');}}return result;});
 const options={source:f.source,destination:f.destination,mailboxes:names,apply:true,offlineIsolated:true};await expect(migrateMessagingHome(options)).rejects.toThrow();expect(interrupted).toBe(true);
 const coordinator=database(join(f.destination,'bridge.db')),attempt=JSON.parse(String(coordinator.prepare("SELECT value FROM bridge_metadata WHERE domain='messaging-migration'").get()!.value));coordinator.close();
 if(tamper){const changed=database(join(f.destination,'alpha.db'));changed.exec("UPDATE bridge_metadata SET value='tampered' WHERE domain='synthetic-retained'");changed.close();await expect(migrateMessagingHome(options)).rejects.toThrow();}
 else {await migrateMessagingHome(options);ordinaryOpening=true;for(const name of names){const file=join(f.destination,name),db=database(file);expect(db.prepare('SELECT state,attempt FROM messaging_candidate').get()).toMatchObject({state:'ready',attempt:attempt.id});assertCurrentMailboxEnvelope(db);db.close();
  const opened=new MessageStore(file,nullLogger);opened.close();const reopened=new MessageStore(file,nullLogger);expect((reopened as any).db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()!.version).toBe(7);expect((reopened as any).db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_imports'").get()).toBeTruthy();expect((reopened as any).db.prepare("SELECT seen_at FROM peer_last_seen WHERE name='synthetic-overlay-peer'").get()!.seen_at).toBe(77);reopened.close();}
  ordinaryOpening=false;await migrateMessagingHome(options);expect(alphaCommits).toBe(1);expect(alphaMigrations).toBe(1);
  ordinaryOpening=true;const accepted=new MessageStore(join(f.destination,'alpha.db'),nullLogger);accepted.markPeerSeen('synthetic-newer-destination-work',123);accepted.close();ordinaryOpening=false;const changed=sha(join(f.destination,'alpha.db'));
  await expect(migrateMessagingHome(options)).rejects.toThrow('completion proof');expect(sha(join(f.destination,'alpha.db'))).toBe(changed);const retained=database(join(f.destination,'alpha.db'));expect(retained.prepare("SELECT seen_at FROM peer_last_seen WHERE name='synthetic-newer-destination-work'").get()!.seen_at).toBe(123);expect(alphaCommits).toBe(1);
 }
 expect(names.map(name=>sha(join(f.source,name)))).toEqual(originals);expect(sha(join(f.source,'bridge.db'))).toBe(f.original);expect(sha(join(f.source,'store-compatibility.db'))).toBe(overlayHash);
});
it('review7: Windows mailbox aliases resolve one physical role and missing names refuse',async()=> {
 const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;Object.defineProperty(process,'platform',{value:'win32',configurable:true});closes.push(()=>Object.defineProperty(process,'platform',descriptor));
 const f=shipping();copyFileSync(join(f.source,'bridge.db'),join(f.source,'mail.db'));
 const plan=await migrateMessagingHome({source:f.source,destination:f.destination,mailboxes:['MAIL.DB']});expect(plan.inputs.some(input=>input.path==='mail.db'&&input.role==='sqlite')).toBe(true);
 await expect(migrateMessagingHome({source:f.source,destination:f.destination,mailboxes:['missing.db'],apply:true,offlineIsolated:true})).rejects.toThrow();
 await migrateMessagingHome({source:f.source,destination:f.destination,mailboxes:['MAIL.DB'],apply:true,offlineIsolated:true});const db=database(join(f.destination,'mail.db'));expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(15);
});
it('review7: infrastructure case variants refuse before inspecting their bytes',async()=> {
 const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;Object.defineProperty(process,'platform',{value:'win32',configurable:true});closes.push(()=>Object.defineProperty(process,'platform',descriptor));
 const f=shipping(),file=join(f.source,'CONFIG.JSON');copyFileSync(join(f.source,'bridge.db'),file);const opens=transport.nativeOpens.length;
 await expect(migrateMessagingHome({source:f.source,destination:f.destination,mailboxes:['CONFIG.JSON'],apply:true,offlineIsolated:true})).rejects.toThrow();expect(existsSync(f.destination)).toBe(false);expect(transport.nativeOpens.slice(opens).some(open=>open.file.toLowerCase()===file.toLowerCase())).toBe(false);
});
it('review7: missing explicit mailbox cannot be silently omitted',async()=> {
 const f=shipping();await expect(migrateMessagingHome({source:f.source,destination:f.destination,mailboxes:['missing.db'],apply:true,offlineIsolated:true})).rejects.toThrow();expect(existsSync(f.destination)).toBe(false);
});
it('review7: preserves deleted high AUTOINCREMENT sequence and exact next BigInt id',async()=> {
 const f=shipping(),db=database(join(f.source,'bridge.db'));db.exec('CREATE TABLE sequence_fidelity(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT)');
 const insert=db.prepare('INSERT INTO sequence_fidelity(id,value) VALUES (?,?)');insert.setReadBigInts(true);insert.run(9007199254740995n,'synthetic');db.exec('DELETE FROM sequence_fidelity');db.close();const original=sha(join(f.source,'bridge.db'));
 await migrateMessagingHome({source:f.source,destination:f.destination,apply:true,offlineIsolated:true});const target=database(join(f.destination,'bridge.db')),seq=target.prepare("SELECT seq FROM sqlite_sequence WHERE name='sequence_fidelity'");seq.setReadBigInts(true);expect(seq.get()!.seq).toBe(9007199254740995n);
 const next=target.prepare("INSERT INTO sequence_fidelity(value) VALUES ('synthetic next')");next.setReadBigInts(true);next.run();const row=target.prepare('SELECT id FROM sequence_fidelity');row.setReadBigInts(true);expect(row.get()!.id).toBe(9007199254740996n);expect(sha(join(f.source,'bridge.db'))).toBe(original);
});
it('review7: sparse metadata rowids survive collision-safe owned-attempt relocation and resume',async()=> {
 const f=shipping(),db=database(join(f.source,'bridge.db'));db.exec("UPDATE bridge_metadata SET rowid=-7 WHERE domain='synthetic-retained'; INSERT INTO bridge_metadata(rowid,domain,key,value,updated_at) VALUES(1,'sparse','one','retained',1),(42,'sparse','fortytwo','retained',2)");
 const read=(source:DatabaseSync)=>{const statement=source.prepare("SELECT rowid AS saved_rowid,domain,key,value,updated_at FROM bridge_metadata WHERE domain<>'messaging-migration' ORDER BY rowid");statement.setReadBigInts(true);return statement.all();};const expected=read(db);db.close();const original=sha(join(f.source,'bridge.db')),prepare=DatabaseSync.prototype.prepare;let interrupted=false;
 const spy=vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,sql:string){if(!interrupted&&sql==='VACUUM INTO ?'){interrupted=true;throw Error('synthetic snapshot interruption');}return prepare.call(this,sql);});
 const options={source:f.source,destination:f.destination,apply:true,offlineIsolated:true};await expect(migrateMessagingHome(options)).rejects.toThrow();expect(interrupted).toBe(true);spy.mockRestore();const held=database(join(f.destination,'bridge.db')),before=JSON.parse(String(held.prepare("SELECT value FROM bridge_metadata WHERE domain='messaging-migration'").get()!.value));held.close();
 await migrateMessagingHome(options);const target=database(join(f.destination,'bridge.db'));expect(read(target)).toEqual(expected);const own=target.prepare("SELECT rowid AS saved_rowid,value FROM bridge_metadata WHERE domain='messaging-migration'");own.setReadBigInts(true);const row=own.get()!;expect(expected.some(input=>input.saved_rowid===row.saved_rowid)).toBe(false);expect(JSON.parse(String(row.value))).toMatchObject({id:before.id,inputId:before.inputId,phase:'ready'});expect(sha(join(f.source,'bridge.db'))).toBe(original);
});

class StartupServer extends EventEmitter {
 listening=false;closed=0;pending:(()=>void)|undefined;maxConnections=0;
 constructor(readonly hold=false){super();}
 listen(...args:any[]){const options=args[0],done=args.at(-1);this.pending=()=>{this.listening=true;if(typeof done==='function')done();this.emit('listening');};
  options?.signal?.addEventListener('abort',()=>this.close(),{once:true});if(!this.hold)queueMicrotask(()=>this.complete());return this;}
 complete(){const done=this.pending;this.pending=undefined;done?.();}
 address(){return {address:'127.0.0.1',port:4242};}
 close(done?:()=>void){this.closed++;this.listening=false;queueMicrotask(()=>{this.emit('close');done?.();});return this;}
}
class StartupDatagram extends StartupServer {
 sends=0;effects=0;
 bind(...args:any[]){return this.listen(...args);}
 setBroadcast(){this.effects++;}setMulticastTTL(){this.effects++;}setMulticastInterface(){this.effects++;}addMembership(){this.effects++;}dropMembership(){this.effects++;}
 send(...args:any[]){this.sends++;const done=args.at(-1);if(typeof done==='function')done();}
}
function startupPlatform(platform:NodeJS.Platform){const descriptor=Object.getOwnPropertyDescriptor(process,'platform')!;Object.defineProperty(process,'platform',{value:platform,configurable:true});closes.push(()=>Object.defineProperty(process,'platform',descriptor));}
function startupNetwork(path=home(),budget?:StartupBudget,discovery=false){
 mkdirSync(join(path,'network'),{recursive:true});writeFileSync(join(path,'network','keys.json'),JSON.stringify({identity:{id:'11111111-1111-4111-8111-111111111111',key:'a'.repeat(64)},invitations:[],pairs:[]}));
 const service=new NetworkService(path,{enabled:true,name:'synthetic',port:4242,bind:'127.0.0.1',discovery,remoteJobs:{enabled:false,allowRoots:[],agents:[],allowPeers:[]}}, {peers:()=>[],receive:()=>({delivered:0,queued:0})} as never,nullLogger,{},budget);return service;
}
function fakeProtection(holdClose=false){
 let callback:((error:Error|null,value:string)=>void)|undefined,child:any,options:any;
 transport.hooks.execFile=(_file:string,_args:string[],opts:any,done:any)=>{
  options=opts;callback=done;child=Object.assign(new EventEmitter(),{pid:700001,stdin:Object.assign(new EventEmitter(),{end:()=>{}}),exitCode:null,signalCode:null,kill:vi.fn(()=>true)});
  opts.signal?.addEventListener('abort',()=>{done(Error('synthetic abort'),'');if(!holdClose){child.exitCode=1;child.emit('close',1,null);}},{once:true});return child;
 };
 return {get options(){return options;},get child(){return child;},finish:(text='synthetic protected')=>{callback?.(null,text);if(!holdClose){child.exitCode=0;child.emit('close',0,null);}},close:()=>{child.exitCode=1;child.emit('close',1,null);}};
}
it('round2: history admission refuses a busy legacy lock without an independent wait',()=>{
 vi.useFakeTimers();const file=join(home(),'history.db'),budget=new StartupBudget();closes.push(()=>budget.close());writeFileSync(file+'.migration-lock',JSON.stringify({pid:process.pid,nonce:'synthetic held'}));
 const wait=vi.spyOn(Atomics,'wait').mockImplementation(()=>{vi.setSystemTime(Date.now()+10_001);return 'timed-out';});
 expect(()=>withStorageAdmission(()=>budget.remaining(),()=>openHistoryStore(file))).toThrow();expect(wait).not.toHaveBeenCalled();
});
it.each(['schema','commit'])('round2: actual history initializer stops after late %s with exact settlement',phase=>{
 vi.useFakeTimers();const file=join(home(),'history.db'),budget=new StartupBudget(),exec=DatabaseSync.prototype.exec;let held:DatabaseSync|undefined,late=false;const following:string[]=[];closes.push(()=>budget.close());closes.push(()=>{if(held?.isOpen)held.close();});
 vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){if(late&&/^(?:CREATE|DROP|ALTER|PRAGMA user_version|COMMIT)/.test(sql))following.push(sql);const result=exec.call(this,sql);if(!late&&this.location('main')===file&&(phase==='schema'?sql.includes('CREATE TABLE history_migration'):sql==='COMMIT')){held=this;late=true;vi.setSystemTime(Date.now()+10_001);}return result;});
 expect(()=>withStorageAdmission(()=>budget.remaining(),()=>openHistoryStore(file))).toThrow();expect(late).toBe(true);expect(following).toEqual([]);expect(held!.isOpen).toBe(false);
 if(phase==='commit'){const retained=database(file);expect(retained.prepare('PRAGMA user_version').get()!.user_version).toBe(2);}
});
it('round2: pending exact endpoint bind cancels and closes its late completion',async()=>{
 vi.useFakeTimers();const server=new StartupServer(true);transport.hooks.net=()=>server;const budget=new StartupBudget();closes.push(()=>budget.close());let reservation:EndpointReservation|undefined,state='pending';
 const result=EndpointReservation.bind('synthetic-endpoint',budget).then(value=>{reservation=value;state='resolved';},()=>{state='rejected';});
 try{await vi.advanceTimersByTimeAsync(10_001);for(let i=0;i<12;i++)await Promise.resolve();expect(state).toBe('rejected');server.complete();await Promise.resolve();expect(server.listening).toBe(false);}
 finally{server.complete();await result;await reservation?.close();}
});
it('round2: actual TLS start cancels pending listen and never enters late discovery',async()=>{
 vi.useFakeTimers();startupPlatform('linux');const tls=new StartupServer(true);transport.hooks.tls=()=>tls;const udp=vi.fn(()=>new StartupDatagram());transport.hooks.udp=udp;const budget=new StartupBudget();closes.push(()=>budget.close());const service=startupNetwork(home(),budget,true);let state='pending';const result=service.start(true,budget).then(()=>{state='resolved';},()=>{state='rejected';});
 try{await vi.advanceTimersByTimeAsync(10_001);for(let i=0;i<12;i++)await Promise.resolve();expect(state).toBe('rejected');tls.complete();for(let i=0;i<6;i++)await Promise.resolve();expect(udp).not.toHaveBeenCalled();expect(service.status().ready).toBe(false);expect(tls.listening).toBe(false);}
 finally{tls.complete();await result;await service.close();}
});
it('round2: discovery bind expiry creates no announcement timer or send',async()=>{
 vi.useFakeTimers();const socket=new StartupDatagram(true),budget=new StartupBudget();closes.push(()=>budget.close());const discovery=new NetworkDiscovery({identity:{id:'synthetic',name:'synthetic',fingerprint:'a'.repeat(64)},port:4242,destination:'127.0.0.1',createSocket:()=>socket as never});let state='pending';const result=discovery.start(budget).then(()=>{state='resolved';},()=>{state='rejected';});
 try{await vi.advanceTimersByTimeAsync(10_001);for(let i=0;i<12;i++)await Promise.resolve();expect(state).toBe('rejected');socket.complete();for(let i=0;i<6;i++)await Promise.resolve();expect(socket.sends).toBe(0);expect(socket.effects).toBe(0);}
 finally{socket.complete();await result;await discovery.close();}
});
it('round2: late discovery interface bind cannot announce or start the next effect',async()=>{
 vi.useFakeTimers();const listener=new StartupDatagram(),sender=new StartupDatagram(true),budget=new StartupBudget();closes.push(()=>budget.close());let created=0,state='pending';
 const discovery=new NetworkDiscovery({identity:{id:'synthetic',name:'synthetic',fingerprint:'a'.repeat(64)},port:4242,createSocket:()=> (++created===1?listener:sender) as never,
  interfaces:()=>({synthetic:[{family:'IPv4',internal:false,address:'192.0.2.1',netmask:'255.255.255.0',cidr:'192.0.2.1/24',mac:'00:00:00:00:00:01'}]})});
 const result=discovery.start(budget).then(()=>{state='resolved';},()=>{state='rejected';});
 try{for(let i=0;i<12;i++)await Promise.resolve();expect(created).toBe(2);await vi.advanceTimersByTimeAsync(10_001);for(let i=0;i<16;i++)await Promise.resolve();expect(state).toBe('rejected');sender.complete();for(let i=0;i<6;i++)await Promise.resolve();expect(sender.effects).toBe(0);expect(listener.sends+sender.sends).toBe(0);}
 finally{sender.complete();await result;await discovery.close();}
});
it('round2: late protection completion cannot start the actual staging write',async()=>{
 vi.useFakeTimers();startupPlatform('win32');const budget=new StartupBudget();closes.push(()=>budget.close());const helper=fakeProtection(),file=join(home(),'synthetic-stage.json');const result=writeMusePrivateJsonAsync(file,{synthetic:true},'wx',budget);const assertion=expect(result).rejects.toThrow();await vi.advanceTimersByTimeAsync(10_001);helper.finish();await assertion;expect(existsSync(file)).toBe(false);expect(helper.options.timeout).toBeLessThanOrEqual(10_000);expect(helper.options.signal).toBe(budget.signal);
});
it('round2: protection cancellation joins the exact helper close before settling',async()=>{
 vi.useFakeTimers();startupPlatform('win32');const budget=new StartupBudget();closes.push(()=>budget.close());const helper=fakeProtection(true),file=join(home(),'synthetic-stage.json');let state='pending';const result=writeMusePrivateJsonAsync(file,{synthetic:true},'wx',budget).then(()=>{state='resolved';},()=>{state='rejected';});
 try{budget.abort();for(let i=0;i<8;i++)await Promise.resolve();expect(helper.options.signal).toBe(budget.signal);expect(state).toBe('pending');helper.close();await result;expect(state).toBe('rejected');expect(existsSync(file)).toBe(false);}
 finally{helper.close();helper.finish();await result;}
});
it('round2: network ACL preparation cannot start the next command after a late helper',async()=>{
 vi.useFakeTimers();startupPlatform('win32');const budget=new StartupBudget();closes.push(()=>budget.close());const calls:string[]=[];const output=(file:string)=>file.toLowerCase().endsWith('whoami.exe')?'"fake-user","S-1-5-21-123"':'fake-user:(F)';
 transport.hooks.execFileSync=(file:string)=>{calls.push('sync');if(calls.length===1)vi.setSystemTime(Date.now()+10_001);return output(file);};
 transport.hooks.execFile=(file:string,_args:string[],options:any,done:any)=>{calls.push('async');const child=Object.assign(new EventEmitter(),{pid:700002,stdin:new EventEmitter(),exitCode:null,signalCode:null});queueMicrotask(()=>{vi.setSystemTime(Date.now()+10_001);done(null,output(file));child.emit('close',0,null);});return child;};
 transport.hooks.tls=()=>new StartupServer();const service=startupNetwork(home(),budget);
 try{await expect(service.start(true,budget)).rejects.toThrow();expect(calls).toEqual(['async']);expect(service.status().ready).toBe(false);}finally{await service.close();}
});
it('round2: transfer recovery retains partial files and starts no maintenance after revocation',async()=>{
 vi.useFakeTimers();startupPlatform('linux');const path=home(),root=join(path,'network','transfers'),id='22222222-2222-4222-8222-222222222222';mkdirSync(root,{recursive:true});const file=join(root,id+'.json');writeFileSync(file,JSON.stringify({version:1,id,status:'sending',entries:[],direction:'send',remote:'synthetic',peer:'synthetic'}));const original=sha(file),budget=new StartupBudget();closes.push(()=>budget.close());let late=false;
 transport.hooks.fs=(operation:string,target:unknown)=>{if(!late&&operation==='readFileSync'&&target===file){late=true;vi.setSystemTime(Date.now()+10_001);}};transport.hooks.tls=()=>new StartupServer();const service=startupNetwork(path,budget);
 try{await expect(service.start(true,budget)).rejects.toThrow();expect(late).toBe(true);expect(sha(file)).toBe(original);}finally{transport.hooks.fs=undefined;await service.close();}expect(sha(file)).toBe(original);
});
it('round2: terminal runner constructor propagates expiry before either archive rename',()=>{
 vi.useFakeTimers();const path=home(),dir=join(path,'jobs');mkdirSync(dir);const file=join(dir,'synthetic.json');writeFileSync(file,JSON.stringify({pid:process.pid,status:'done'}));writeFileSync(join(dir,'synthetic.spec.json'),'synthetic spec retained');utimesSync(file,new Date(0),new Date(0));const budget=new StartupBudget();closes.push(()=>budget.close());
 transport.hooks.fs=(operation:string,target:unknown)=>{if(operation==='statSync'&&target===file)vi.setSystemTime(Date.now()+10_001);};expect(()=>new JobRunners({} as never,path,'synthetic-cli',nullLogger,()=>budget.remaining())).toThrow();expect(existsSync(file)).toBe(true);expect(existsSync(join(dir,'synthetic.spec.json'))).toBe(true);
});
it('round2: mandatory slot constructors close owned handles before next late schema effect',()=>{
 vi.useFakeTimers();const budget=new StartupBudget();closes.push(()=>budget.close());const exec=DatabaseSync.prototype.exec,handles=new Set<DatabaseSync>(),after:string[]=[];let late=false;
 vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){handles.add(this);if(late&&/CREATE|ALTER|UPDATE|COMMIT/.test(sql))after.push(sql);const result=exec.call(this,sql);if(!late&&sql.includes('CREATE TABLE IF NOT EXISTS slots')){late=true;vi.setSystemTime(Date.now()+10_001);}return result;});closes.push(()=>{for(const db of handles)if(db.isOpen)db.close();});
 expect(()=>withStorageAdmission(()=>budget.remaining(),()=>new RootConcurrency(home(),'synthetic-root'))).toThrow();expect(late).toBe(true);expect(after).toEqual([]);for(const db of handles)expect(db.isOpen).toBe(false);
});
it('round2: mandatory moveJobs rolls back when its actual SQL preparation finishes late',()=>{
 vi.useFakeTimers();const root=new RootConcurrency(home(),'synthetic-root');closes.push(()=>root.close());const db=(root as unknown as {slots:{db:DatabaseSync}}).slots.db;
 db.prepare("INSERT INTO slots(resource,id,pid,held,expiresAt,identity) VALUES ('root-old','synthetic-1',?,1,?,NULL)").run(process.pid,Date.now()+60_000);
 const prepare=DatabaseSync.prototype.prepare,budget=new StartupBudget();closes.push(()=>budget.close());let late=false;
 vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,sql:string){const result=prepare.call(this,sql);if(sql==='UPDATE slots SET resource=? WHERE ticket=?'){late=true;vi.setSystemTime(Date.now()+10_001);}return result;});
 expect(()=>withStorageAdmission(()=>budget.remaining(),()=>root.moveJobs(['synthetic']))).toThrow();expect(late).toBe(true);expect(db.prepare("SELECT resource FROM slots WHERE id='synthetic-1'").get()!.resource).toBe('root-old');
});
it.each([false,true])('round2: actual broker starts optional services only after valid activation expire=%s',async expire=>{
 vi.useFakeTimers();startupPlatform('linux');const f=candidate(),events:string[]=[];transport.hooks.maintenance=(name:string)=>events.push(name);writeFileSync(join(f.path,'jobs.json'),JSON.stringify({version:4,jobs:[],handoffs:[]}));const tls=new StartupServer(expire);transport.hooks.tls=()=>tls;
 const broker=new Broker('synthetic',f.store,nullLogger,'synthetic-only',Date.now,join(f.path,'jobs.json'),{home:f.path,config:{enabled:true,name:'synthetic',port:4242,bind:'127.0.0.1',discovery:false,remoteJobs:{enabled:false,allowRoots:[],agents:[],allowPeers:[]}}});
 const server=new StartupServer(),reservation={ownedServer:()=>server,activate:vi.fn(()=>events.push('activate')),close:vi.fn(async()=>{})};server.listening=true;const budget=new StartupBudget();closes.push(()=>budget.close());const backups=vi.spyOn(f.store,'startBackups');const result=broker.listen(reservation as never,budget);const failure=expire?expect(result).rejects.toThrow():undefined;
 try{if(expire){await vi.advanceTimersByTimeAsync(10_001);tls.complete();await failure;expect(reservation.activate).not.toHaveBeenCalled();expect(events.filter(name=>!name.endsWith('-close'))).toEqual([]);expect(backups).not.toHaveBeenCalled();}else{await result;await vi.advanceTimersByTimeAsync(0);expect(events.indexOf('activate')).toBeLessThan(events.indexOf('history'));for(const name of ['index','archive','history'])expect(events.filter(event=>event===name)).toHaveLength(1);expect(backups).toHaveBeenCalledOnce();budget.abort();}}
 finally{tls.complete();await result.catch(()=>{});await broker.close();}if(!expire)for(const name of ['index-close','archive-close','history-close'])expect(events.filter(event=>event===name)).toHaveLength(1);
});
it('round2: delayed TCP startup cancels without creating maintenance or publishing a descriptor',async()=>{
 vi.useFakeTimers();startupPlatform('win32');const f=candidate(),events:string[]=[];transport.hooks.maintenance=(name:string)=>events.push(name);const tcp=new StartupServer(true),create=vi.fn(()=>tcp);transport.hooks.net=create;writeFileSync(join(f.path,'jobs.json'),JSON.stringify({version:4,jobs:[],handoffs:[]}));
 const broker=new Broker('synthetic',f.store,nullLogger,'synthetic-only',Date.now,join(f.path,'jobs.json')),server=new StartupServer();server.listening=true;
 const reservation={ownedServer:()=>server,activate:vi.fn(),close:vi.fn(async()=>{})},budget=new StartupBudget();closes.push(()=>budget.close());const result=broker.listen(reservation as never,budget),rejected=expect(result).rejects.toThrow();
 try{await vi.advanceTimersByTimeAsync(10_001);tcp.complete();await rejected;expect(create).toHaveBeenCalledOnce();expect(reservation.activate).not.toHaveBeenCalled();expect(events.filter(name=>!name.endsWith('-close'))).toEqual([]);expect(tree(f.path).some(file=>file.includes('broker-tcp.json'))).toBe(false);}
 finally{tcp.complete();await result.catch(()=>{});await broker.close();}
});
it('round2: mandatory ownership failure cannot be downgraded to optional maintenance',async()=>{
 const store=new MessageStore(':memory:',nullLogger);closes.push(()=>store.close());const broker=new Broker('synthetic',store,nullLogger,'synthetic-only'),budget=new StartupBudget();closes.push(()=>budget.close());const server=new StartupServer();server.listening=true;
 vi.spyOn(broker as unknown as {applyHandoffs():void},'applyHandoffs').mockImplementation(()=>{throw Error('synthetic mandatory ownership failure');});
 const reservation={ownedServer:()=>server,activate:vi.fn(),close:vi.fn(async()=>{})};await expect(broker.listen(reservation as never,budget)).rejects.toThrow('mandatory ownership');expect(reservation.activate).not.toHaveBeenCalled();expect(reservation.close).toHaveBeenCalledOnce();
});

it.each([['node','linux'],['daemon','linux'],['node','win32'],['daemon','win32']] as const)('round3: actual %s caller owns teardown after activated %s startup expires',async(caller,platform)=>{
 vi.useFakeTimers();startupPlatform(platform);vi.stubEnv('AGENT_BRIDGE_DAEMON_CONFIG',undefined);vi.stubEnv('AGENT_BRIDGE_DAEMON_DASHBOARD','0');vi.stubEnv('AGENT_BRIDGE_STARTUP_DEADLINE',undefined);
 const f=candidate();f.store.close();closeMetadataDbs();const events:string[]=[],servers:StartupServer[]=[];
 const config={enabled:platform==='linux',name:'synthetic',port:4242,bind:'127.0.0.1',discovery:false,remoteJobs:{enabled:false,allowRoots:[],agents:[],allowPeers:[]}};
 writeFileSync(join(f.path,'token'),'synthetic-only');writeFileSync(join(f.path,'config.json'),JSON.stringify({version:4,dashboard:false,network:config}));writeFileSync(join(f.path,'jobs.json'),JSON.stringify({version:4,jobs:[],handoffs:[]}));
 if(config.enabled){mkdirSync(join(f.path,'network'));writeFileSync(join(f.path,'network','keys.json'),JSON.stringify({identity:{id:'11111111-1111-4111-8111-111111111111',key:'a'.repeat(64)},invitations:[],pairs:[]}));}
 transport.hooks.maintenance=(name:string)=>events.push(name);transport.hooks.net=()=>{const server=new StartupServer();servers.push(server);return server;};transport.hooks.tls=()=>{const server=new StartupServer();servers.push(server);return server;};
 // In-process protection adapter only: native helper APIs remain guarded.
 transport.hooks.execFile=(_file:string,args:string[],_options:unknown,done:(error:null,value:string)=>void)=>{const child=Object.assign(new EventEmitter(),{pid:700003,exitCode:null as number|null,signalCode:null,kill:vi.fn(()=>true),stdin:Object.assign(new EventEmitter(),{end:(value:string)=>queueMicrotask(()=>{done(null,args.join(' ').includes('::Unprotect')?Buffer.from(value,'base64').toString():Buffer.from(value).toString('base64'));child.exitCode=0;child.emit('close',0,null);})})});return child;};
 transport.hooks.execFileSync=(_file:string,_args:string[],options:{input:string})=>Buffer.from(options.input,'base64').toString();
 const listen=Broker.prototype.listen,close=Broker.prototype.close;let owned:Broker|undefined,activeNetwork:any,actualStore:MessageStore|undefined,storeCloses=0,brokerCloses=0,activated=false;
 vi.spyOn(Broker.prototype,'close').mockImplementation(function(this:Broker){brokerCloses++;return close.call(this);});
 vi.spyOn(Broker.prototype,'listen').mockImplementation(async function(this:Broker,...args:Parameters<Broker['listen']>){owned=this;actualStore=(this as any).store;const closeStore=actualStore!.close.bind(actualStore);vi.spyOn(actualStore!,'close').mockImplementation(()=>{storeCloses++;return closeStore();});await listen.apply(this,args);activeNetwork=(this as any).network;activated=!!(this as any).maintenanceStart&&servers.every(server=>server.listening);if(activeNetwork)expect(activeNetwork.status().ready).toBe(true);vi.setSystemTime(Date.now()+10_001);});
 const budget=new StartupBudget();closes.push(()=>budget.close());let node:BridgeNode|undefined;
 try{
  const operation=caller==='node'?(()=>{node=new BridgeNode({pipePath:'synthetic-round3',token:'synthetic-only',dbPath:join(f.path,'bridge.db'),agent:'other',name:'synthetic',cwd:f.path,autoWake:false,log:nullLogger,network:{home:f.path,config}});(node as any).startupBudget=budget;return(node as any).tryBecomeBroker() as Promise<boolean>;})():runBrokerDaemon(f.path,'synthetic-round3',nullLogger);
  await expect(operation).rejects.toThrow();expect(activated).toBe(true);expect(brokerCloses).toBe(1);expect(storeCloses).toBe(1);
  expect((owned as any).startupAuthorityRevoked).toBe(true);expect((owned as any).maintenanceStart).toBeNull();expect((owned as any).server).toBeNull();expect((owned as any).tcpServer).toBeNull();expect((owned as any).network).toBeNull();
  if(activeNetwork)expect(activeNetwork.status().ready).toBe(false);expect(servers).toHaveLength(2);for(const server of servers){expect(server.listening).toBe(false);expect(server.closed).toBeGreaterThan(0);}
  const socket={destroy:vi.fn()};(owned as any).accept(socket);expect(socket.destroy).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(0);expect(events.filter(name=>!name.endsWith('-close'))).toEqual([]);expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
 }finally{if(owned&&!(owned as any).closing)await close.call(owned);await node?.stop();}
});

it('round3: recovery owns rollback when BEGIN itself returns after expiry',async()=>{
 vi.useFakeTimers();const f=candidate(),db=(f.store as any).db as DatabaseSync;f.store.retainNativeChild('synthetic/sub:a','synthetic');const budget=new StartupBudget();closes.push(()=>budget.close());const exec=DatabaseSync.prototype.exec;let late=false;
 vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){const result=exec.call(this,sql);if(this===db&&sql==='BEGIN IMMEDIATE'&&!late){late=true;vi.setSystemTime(Date.now()+10_001);}return result;});
 await expect(new NativeChildren(f.store).recover(budget)).rejects.toThrow();expect(late).toBe(true);expect(db.isTransaction).toBe(false);expect(db.prepare('SELECT active FROM native_child_routes').get()!.active).toBe(1);expect(db.prepare('PRAGMA busy_timeout').get()!.timeout).toBe(3000);
});

it.each([false,true])('round3: unknown native recovery COMMIT is retained without rollback or replay late=%s',async late=>{
 vi.useFakeTimers();
 const f=candidate(),db=(f.store as any).db as DatabaseSync;f.store.retainNativeChild('synthetic/sub:a','synthetic');const budget=new StartupBudget();closes.push(()=>budget.close());const exec=DatabaseSync.prototype.exec;let commits=0,rollbacks=0;
 vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){if(this===db&&sql==='ROLLBACK')rollbacks++;const result=exec.call(this,sql);if(this===db&&sql==='COMMIT'){commits++;if(late)vi.setSystemTime(Date.now()+10_001);throw Error('synthetic unknown native settlement');}return result;});
 await expect(new NativeChildren(f.store).recover(budget)).rejects.toMatchObject({code:'STORE_COMMIT_UNKNOWN'});expect(commits).toBe(1);expect(rollbacks).toBe(0);expect(db.isTransaction).toBe(false);expect(db.prepare('SELECT active FROM native_child_routes').get()!.active).toBe(0);expect(db.prepare('PRAGMA busy_timeout').get()!.timeout).toBe(3000);
});

it('round3: unchanged alternate main cannot bypass committed WAL completion proof',async()=>{
 const f=shipping(),name='alpha.db';copyFileSync(join(f.source,'bridge.db'),join(f.source,name));const originals=fileState(f.source),maintenance=await import('../src/core/sqlite-maintenance.js'),snapshot=maintenance.snapshotDatabase;
 // Choose WAL format while each new synthetic snapshot is still being created,
 // before immutable hash capture. Logical source/snapshot contents stay exact.
 vi.spyOn(maintenance,'snapshotDatabase').mockImplementation((source,target)=>{snapshot(source,target);if(target.endsWith(name)){const db=database(target);db.exec('PRAGMA journal_mode=WAL');db.close();}});
 const exec=DatabaseSync.prototype.exec,target=join(f.destination,name);let held:DatabaseSync|undefined,interrupted=false,commits=0;
 vi.spyOn(DatabaseSync.prototype,'exec').mockImplementation(function(this:DatabaseSync,sql:string){if(this.location('main')===target&&sql==='BEGIN IMMEDIATE'&&!held){held=database(target);held.exec('BEGIN');expect(held.prepare('PRAGMA user_version').get()!.user_version).toBe(9);}const result=exec.call(this,sql);if(this.location('main')===target&&sql==='COMMIT'&&Number(this.prepare('PRAGMA user_version').get()!.user_version)===15){commits++;if(!interrupted){interrupted=true;throw Error('synthetic alternate committed before unknown settlement');}}return result;});
 const options={source:f.source,destination:f.destination,mailboxes:[name],apply:true,offlineIsolated:true};await expect(migrateMessagingHome(options)).rejects.toThrow();expect(interrupted).toBe(true);
 const coordinator=database(join(f.destination,'bridge.db')),attempt=JSON.parse(String(coordinator.prepare("SELECT value FROM bridge_metadata WHERE domain='messaging-migration'").get()!.value));coordinator.close();expect(sha(target)).toBe(attempt.snapshots[name]);
 const writer=database(target),marker=writer.prepare('SELECT state,attempt FROM messaging_candidate').get(),namespace=writer.prepare('SELECT namespace FROM mailbox_store').get();expect(marker).toMatchObject({state:'ready',attempt:attempt.id});
 writer.exec("UPDATE bridge_metadata SET value='synthetic WAL-only changed content' WHERE domain='synthetic-retained'");expect(writer.prepare("SELECT value FROM bridge_metadata WHERE domain='synthetic-retained'").get()!.value).toBe('synthetic WAL-only changed content');expect(writer.prepare('SELECT state,attempt FROM messaging_candidate').get()).toEqual(marker);expect(writer.prepare('SELECT namespace FROM mailbox_store').get()).toEqual(namespace);writer.close();
 expect(sha(target)).toBe(attempt.snapshots[name]);expect(lstatSync(target+'-wal').size).toBeGreaterThan(0);const before=fileState(f.source),mainHash=sha(target),walHash=sha(target+'-wal'),snapshots=tree(join(f.destination,'.migration-snapshots')).map(file=>[file,sha(file)]);
 await expect(migrateMessagingHome(options)).rejects.toThrow('completion proof');expect(commits).toBe(1);expect(sha(target)).toBe(mainHash);expect(sha(target+'-wal')).toBe(walHash);expect(fileState(f.source)).toEqual(before);for(const [file,hash]of originals)expect(sha(file)).toBe(hash);expect(tree(join(f.destination,'.migration-snapshots')).map(file=>[file,sha(file)])).toEqual(snapshots);
 held!.exec('ROLLBACK');held!.close();
});

it.each(['peers','presence','own-presence','read-state','import','legacy-backup','success'] as const)('round4: actual adoption bounds every next effect after late %s',async phase=>{
 vi.useFakeTimers();const f=candidate(),meta=metadataDb(f.path),release=retainMetadataReader(f.path);closes.push(release);const normal=meta.prepare('PRAGMA busy_timeout').get()!.timeout;
 if(phase!=='legacy-backup')meta.exec("INSERT INTO bridge_components VALUES ('import:storage-capabilities',1),('repair:import-times:storage-capabilities',1)");
 if(phase!=='import')meta.exec("INSERT INTO bridge_components VALUES ('import:read-state',1)");
 const journal=join(f.path,'read-state',createHash('sha256').update('name:synthetic').digest('hex')+'.jsonl');if(phase==='import'){mkdirSync(join(f.path,'read-state'));writeFileSync(journal,JSON.stringify({ids:['synthetic-read'],at:1})+'\n');}
 const legacy=join(f.path,'storage-capabilities',process.pid+'.json');if(phase==='legacy-backup'){mkdirSync(join(f.path,'storage-capabilities'));writeFileSync(legacy,JSON.stringify({schemaVersion:1,pid:process.pid,name:'old-synthetic',version:'0.29.13',explicit:false,json:4,sqlite:7}));}
 const originalJournal=phase==='import'?sha(journal):undefined,originalLegacy=phase==='legacy-backup'?sha(legacy):undefined,prepare=DatabaseSync.prototype.prepare,after:string[]=[],requests:string[]=[];let late=false,reads=0;
 const expire=()=>{late=true;vi.setSystemTime(Date.now()+10_001);};
 vi.spyOn(DatabaseSync.prototype,'prepare').mockImplementation(function(this:DatabaseSync,sql:string){const statement=prepare.call(this,sql);return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return(...args:unknown[])=>{if(late&&(key==='run'||/\b(?:INSERT|UPDATE|DELETE|CREATE)\b/i.test(sql)))after.push(sql);const result=value.apply(target,args);
  if(!late&&key==='run'&&sql.startsWith('INSERT INTO bridge_metadata VALUES')&&args[0]==='storage-capabilities'&&((phase==='presence')||(phase==='own-presence'&&requests.includes('hello'))))expire();
  if(!late&&phase==='read-state'&&key==='all'&&sql.startsWith('SELECT message_id FROM bridge_read_receipts')&&++reads===1)expire();return result;};}}) as never;});
 transport.hooks.fs=(operation:string,path:unknown)=>{if(!late&&phase==='import'&&operation==='appendFileSync'&&String(path).includes('bundles'))expire();if(!late&&phase==='legacy-backup'&&operation==='copyFileSync'&&path===legacy)expire();};
 const client=Object.assign(new EventEmitter(),{isClosed:false,close:vi.fn(function(this:{isClosed:boolean}){this.isClosed=true;}),request:vi.fn(async(op:string)=>{requests.push(op);if(op==='peers'){if(phase==='peers')expire();return phase==='own-presence'||phase==='read-state'||phase==='import'||phase==='success'?[]:[{pid:process.pid,name:'synthetic-first',version:phase==='legacy-backup'?'0.29.13':APP_VERSION},{pid:process.pid+1,name:'synthetic-next',version:APP_VERSION}];}if(op==='ping')return{brokerVersion:APP_VERSION};if(op==='hello')return{name:'synthetic-adopted',brokerPid:process.pid,sessionId:'synthetic-session',nativeOwner:JSON.stringify({kind:'session',agent:'other',sessionId:'synthetic-session'}),mailboxNamespace:f.store.namespace};return{};})});
 const node=new BridgeNode({pipePath:'synthetic-round4',token:'synthetic-only',dbPath:join(f.path,'bridge.db'),agent:'other',name:'synthetic',cwd:f.path,autoWake:false,log:nullLogger}),budget=new StartupBudget();(node as any).startupBudget=budget;closes.push(()=>budget.close());const connected=vi.fn();node.on('connected',connected);
 let owned:Broker|undefined;
 if(phase==='peers'){owned=new Broker('synthetic-round4',f.store,nullLogger,'synthetic-only');const server=new StartupServer();server.listening=true;await owned.listen({ownedServer:()=>server,activate:()=>{},close:async()=>{server.close();}} as never,budget);(node as any).broker=owned;}
 try{const result=(node as any).adopt(client) as Promise<void>;
  if(phase==='success'){await result;expect(connected).toHaveBeenCalledOnce();budget.abort();client.emit('event','peer_joined',{pid:process.pid,name:'synthetic-serving',version:APP_VERSION});expect(node.isConnected).toBe(true);expect(meta.prepare('PRAGMA busy_timeout').get()!.timeout).toBe(normal);}
  else{await expect(result).rejects.toThrow();expect(late).toBe(true);expect(client.isClosed).toBe(true);expect(node.isConnected).toBe(false);expect(connected).not.toHaveBeenCalled();expect(after).toEqual([]);expect(meta.isTransaction).toBe(false);expect(meta.prepare('PRAGMA busy_timeout').get()!.timeout).toBe(normal);
   if(phase==='import'){expect(sha(journal)).toBe(originalJournal);expect(meta.prepare('SELECT * FROM bridge_imports').all()).toEqual([]);}
   if(phase==='legacy-backup'){expect(sha(legacy)).toBe(originalLegacy);expect(tree(f.path).some(path=>path.startsWith(legacy+'.backup-'))).toBe(true);expect(tree(f.path).some(path=>path.startsWith(legacy+'.')&&path.endsWith('.tmp'))).toBe(false);}
   if(owned){expect((owned as any).server).toBeNull();expect((owned as any).startupAuthorityRevoked).toBe(true);expect((owned as any).maintenanceStart).toBeNull();}
   await vi.advanceTimersByTimeAsync(0);expect(connected).not.toHaveBeenCalled();expect((node as any).pendingRefreshTimer).toBeNull();}
 }finally{await node.stop();}
});

function ordinaryAuxiliaryFixture(name:string){
 const f=candidate();f.store.close();closeMetadataDbs();const file=join(f.path,name);
 if(name==='store-compatibility.db'){const db=database(file);db.exec(`CREATE TABLE session_bindings(identity TEXT NOT NULL,session_id TEXT NOT NULL,learned_at INTEGER NOT NULL,PRIMARY KEY(identity,session_id));CREATE TABLE peer_names(identity TEXT NOT NULL,name TEXT NOT NULL,session_id TEXT,agent TEXT NOT NULL,learned_at INTEGER NOT NULL,PRIMARY KEY(identity,name));CREATE TABLE peer_name_owners(name TEXT PRIMARY KEY,identity TEXT NOT NULL);CREATE TABLE job_delivery_routes(id TEXT PRIMARY KEY,recipient TEXT NOT NULL,consumed_at INTEGER);CREATE TABLE peer_last_seen(name TEXT PRIMARY KEY,seen_at INTEGER NOT NULL);PRAGMA user_version=1;`);db.close();}
 return {...f,file};
}
function directAuxiliary(f:ReturnType<typeof ordinaryAuxiliaryFixture>,name:string){
 if(name==='archive.db'){openArchive(f.file).close();return;}
 if(name==='history.db'){openHistoryStore(f.file).close();return;}
 const db=database(join(f.path,'bridge.db'));try{attachStoreCompatibility(db,join(f.path,'bridge.db'),nullLogger,true);}finally{db.close();}
}
const unsafeAuxiliaryCases=['archive.db','history.db','store-compatibility.db'].flatMap(name=>[
 ...['orphan-wal','empty-wal','truncated-wal','orphan-shm','orphan-journal','hard-main','hard-wal','simulated-main-link'].map(kind=>[name,kind,'store']),
 ...['orphan-wal','hard-main','simulated-sidecar-link'].map(kind=>[name,kind,'direct'])]);
it.each(unsafeAuxiliaryCases)('round5: exact %s %s refuses before unsafe native open via %s',async(name,kind,entry)=>{
 const f=ordinaryAuxiliaryFixture(name);renameSync(f.file,f.file+'.fixture-valid');let simulated:string|undefined;
 if(kind==='empty-wal'||kind==='truncated-wal')writeFileSync(f.file,Buffer.alloc(kind==='empty-wal'?0:100));
 else if(kind==='hard-main'||kind==='simulated-main-link'||kind==='hard-wal'||kind==='simulated-sidecar-link')copyFileSync(f.file+'.fixture-valid',f.file);
 if(kind==='hard-main')linkSync(f.file,f.file+'.fixture-linked');
 else if(kind==='orphan-shm')writeFileSync(f.file+'-shm','synthetic retained coordination');
 else if(kind==='orphan-journal')writeFileSync(f.file+'-journal',Buffer.alloc(1024));
 else if(kind!=='hard-main'&&kind!=='simulated-main-link')writeFileSync(f.file+'-wal','synthetic retained WAL bytes; never passed to native SQLite');
 if(kind==='hard-wal')linkSync(f.file+'-wal',f.file+'.fixture-wal-linked');
 if(kind==='simulated-main-link')simulated=f.file;if(kind==='simulated-sidecar-link')simulated=f.file+'-wal';
 const retained=tree(f.path).filter(path=>path.startsWith(f.file)).map(path=>[path,sha(path)] as const),opened=transport.nativeOpens.length;
 if(simulated){const fs=await import('node:fs'),original=fs.lstatSync;vi.spyOn(fs,'lstatSync').mockImplementation(((...args:any[])=>{const value=(original as any)(...args);if(String(args[0])===simulated)Object.defineProperty(value,'isSymbolicLink',{value:()=>true});return value;}) as never);}
 transport.hooks.sqliteOpen=(path:string)=>{if(path===f.file)throw Error('guarded unsafe native constructor attempted; simulated only');};
 let returned:MessageStore|undefined;
 try{expect(()=>{if(entry==='store')returned=new MessageStore(join(f.path,'bridge.db'),nullLogger);else directAuxiliary(f,name);}).toThrow(/partial|substitut|family/i);
  expect(transport.nativeOpens.slice(opened).filter(open=>open.file===f.file)).toEqual([]);for(const [path,hash]of retained)expect(sha(path)).toBe(hash);
 }finally{returned?.close();}
});
it.each(['archive.db','history.db','store-compatibility.db'])('round5: valid and truly absent %s families retain ordinary and direct behavior',name=>{
 const f=ordinaryAuxiliaryFixture(name);let opened=new MessageStore(join(f.path,'bridge.db'),nullLogger);opened.close();directAuxiliary(f,name);renameSync(f.file,f.file+'.fixture-fresh-control');
 opened=new MessageStore(join(f.path,'bridge.db'),nullLogger);opened.close();directAuxiliary(f,name);expect(existsSync(f.file)).toBe(true);opened=new MessageStore(join(f.path,'bridge.db'),nullLogger);opened.close();
});
it.each(['root-limits.sqlite','resource-slots.sqlite','snapshot-source.db'])('round5: selected direct %s rejects orphan WAL before native open',name=>{
 const path=home(),file=join(path,name);writeFileSync(file+'-wal','synthetic retained direct WAL');const before=sha(file+'-wal'),opened=transport.nativeOpens.length;
 transport.hooks.sqliteOpen=(target:string)=>{if(target===file)throw Error('guarded unsafe direct constructor attempted; simulated only');};
 expect(()=>{if(name==='root-limits.sqlite')new RootConcurrency(path,'synthetic').close();else if(name==='resource-slots.sqlite')new ResourceSlots(path).close();else snapshotDatabase(file,join(path,'snapshot-output.db'));}).toThrow(/partial|substitut|family/i);
 expect(transport.nativeOpens.slice(opened).some(open=>open.file===file)).toBe(false);expect(existsSync(file)).toBe(false);expect(sha(file+'-wal')).toBe(before);
});
function retryClient(namespace:string,handover=false){return Object.assign(new EventEmitter(),{isClosed:false,close:vi.fn(function(this:{isClosed:boolean}){this.isClosed=true;}),request:vi.fn(async(op:string)=>{if(op==='auth'&&handover)throw new BridgeError('protocol_mismatch','synthetic handover',{handover:true});if(op==='ping')return{brokerVersion:APP_VERSION};if(op==='peers'||op==='pending')return[];if(op==='hello')return{name:'synthetic-retry',brokerPid:process.pid,sessionId:'synthetic-retry-session',nativeOwner:JSON.stringify({kind:'session',agent:'other',sessionId:'synthetic-retry-session'}),mailboxNamespace:namespace};return{};})});}
it.each([false,true])('round5: actual handover retry owns metadata through sibling stop=%s and final own stop',async siblingPresent=>{
 vi.useFakeTimers();const f=candidate(),namespace=f.store.namespace;f.store.close();closeMetadataDbs();const options={pipePath:'synthetic-round5',token:'synthetic-only',dbPath:join(f.path,'bridge.db'),agent:'other' as const,name:'synthetic',cwd:f.path,autoWake:false,log:nullLogger},node=new BridgeNode(options),sibling=siblingPresent?new BridgeNode(options):undefined,first=retryClient(namespace,true),second=retryClient(namespace);
 vi.spyOn(BridgeClient,'connect').mockResolvedValueOnce(first as never).mockResolvedValue(second as never);const initial=metadataDb(f.path),connected=vi.fn();node.on('connected',connected);
 try{const started=node.start();await vi.advanceTimersByTimeAsync(1000);await started;expect(first.isClosed).toBe(true);expect(connected).toHaveBeenCalledOnce();expect(node.isConnected).toBe(true);
  const serving=metadataDb(f.path);expect(metadataReaderRetained(f.path)).toBe(true);if(sibling){await sibling.stop();expect(serving.isOpen).toBe(true);expect(metadataReaderRetained(f.path)).toBe(true);}else expect(initial.isOpen).toBe(false);
  await vi.advanceTimersByTimeAsync(11_000);second.emit('event','peer_joined',{pid:process.pid,name:'synthetic-after-budget',version:APP_VERSION});expect(node.isConnected).toBe(true);expect(serving.isOpen).toBe(true);await node.start();await node.start();
  await node.stop();await node.stop();expect(serving.isOpen).toBe(false);expect(metadataDbOpen(f.path)).toBe(false);expect(metadataReaderRetained(f.path)).toBe(false);
 }finally{await sibling?.stop();await node.stop();}
});
it.each(['handover-cancel','protocol-failure'])('round5: continuing reader acquisition has exact %s cleanup',async kind=>{
 vi.useFakeTimers();const f=candidate(),namespace=f.store.namespace;f.store.close();closeMetadataDbs();const node=new BridgeNode({pipePath:'synthetic-round5',token:'synthetic-only',dbPath:join(f.path,'bridge.db'),agent:'other',name:'synthetic',cwd:f.path,autoWake:false,log:nullLogger}),client=retryClient(namespace,true),db=metadataDb(f.path);
 if(kind==='protocol-failure')vi.spyOn(BridgeClient,'connect').mockRejectedValue(new BridgeError('protocol_mismatch','synthetic incompatible protocol'));else vi.spyOn(BridgeClient,'connect').mockResolvedValue(client as never);
 const started=node.start(),rejected=expect(started).rejects.toThrow();
 try{if(kind==='handover-cancel'){await vi.advanceTimersByTimeAsync(0);const stop=node.stop();await vi.advanceTimersByTimeAsync(1000);await stop;}await rejected;expect(metadataReaderRetained(f.path)).toBe(false);expect(metadataDbOpen(f.path)).toBe(false);expect(db.isOpen).toBe(false);if(kind==='protocol-failure'){await expect(node.start()).rejects.toThrow();expect(metadataReaderRetained(f.path)).toBe(false);}await node.stop();await node.stop();}finally{await node.stop();}
});
it('round5: simulated absent cached family refuses without closing a sibling-owned handle',async()=>{
 const f=candidate(),db=metadataDb(f.path),reader=retainMetadataReader(f.path);closes.push(reader);const file=join(f.path,'bridge.db'),fs=await import('node:fs'),original=fs.lstatSync;
 vi.spyOn(fs,'lstatSync').mockImplementation(((...args:any[])=>{if([file,file+'-wal',file+'-shm',file+'-journal'].includes(String(args[0])))throw Object.assign(Error('synthetic absent family'),{code:'ENOENT'});return(original as any)(...args);}) as never);
 expect(()=>metadataDb(f.path)).toThrow('Cached metadata family');expect(db.isOpen).toBe(true);expect(metadataDbOpen(f.path)).toBe(true);
});
