import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

// This selection cannot launch a provider, process, native helper, socket server
// or production Worker, including through a newly introduced indirect call.
const transport = vi.hoisted(()=>({active:'',protocol:0,writes:[] as string[],nativeOpens:[] as {file:string;readOnly:boolean}[]}));
vi.mock('node:sqlite',async original=> {
 const sqlite=await original<typeof import('node:sqlite')>();
 return {...sqlite,DatabaseSync:new Proxy(sqlite.DatabaseSync,{construct(target,args,newTarget){
  transport.nativeOpens.push({file:String(args[0]),readOnly:args[1]?.readOnly===true});
  return Reflect.construct(target,args,newTarget);
 }})};
});
vi.mock('node:child_process',async original=>({...await original<object>(),spawn:()=>{throw Error('subprocess forbidden in slice1 selection');},execFile:()=>{throw Error('subprocess forbidden');},execFileSync:()=>{throw Error('subprocess forbidden');}}));
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
 return {...await original<object>(),createServer:()=>{throw Error('native server forbidden in slice1 selection');},connect:(path:string)=> {
  const socket = new class extends EventEmitter {
   destroyed=false; setEncoding(){return this;} end(){return this;} destroy(){this.destroyed=true;return this;}
   write(raw:string){const frame=JSON.parse(raw.trim());transport.writes.push(frame.op);queueMicrotask(()=>this.emit('data',JSON.stringify({t:'res',id:frame.id,ok:true,result:{protocol:transport.protocol,brokerPid:1}})+'\n'));return true;}
  };
  queueMicrotask(()=>transport.protocol || path===transport.active ? socket.emit('connect') : socket.emit('error',Object.assign(Error('synthetic absent'),{code:'ENOENT'})));
  return socket;
 }};
});

import { MessageStore, openMessageStore } from '../src/core/store.js';
import { metadataDb, closeMetadataDbs, migrateMessagingHome } from '../src/core/metadata-db.js';
import { assertCurrentMailboxEnvelope, preflightMessagingHome, inspectMailbox } from '../src/core/mailbox-layout.js';
import { configureSqlite, assertSqliteAuthority } from '../src/core/sqlite-policy.js';
import { admissionSqliteBusy, storageAdmissionTimeout, withStorageAdmission } from '../src/core/storage-admission.js';
import { StartupBudget } from '../src/core/startup-budget.js';
import { guardPriorEndpoints, priorEndpoints } from '../src/core/prior-endpoints.js';
import { BridgeClient } from '../src/core/client.js';
import { Broker } from '../src/core/broker.js';
import { openHistoryStore } from '../src/core/history-store.js';
import { nullLogger } from '../src/core/logger.js';
import { PROTOCOL_VERSION } from '../src/core/constants.js';
import { SQLITE_STORE_VERSION, METADATA_COMPONENT_VERSION } from '../src/core/store-version.js';
import { CONVERSATION_MIGRATION } from '../src/core/conversation-schema.js';

const closes: (()=>void)[] = [];
const home = () => {const path=resolve('.agent-bridge-test/slice1-fixtures',randomUUID());mkdirSync(path,{recursive:true});return path;};
const sha = (path:string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const tree = (path:string):string[]=>existsSync(path) ? readdirSync(path,{withFileTypes:true}).flatMap(item=>item.isDirectory()?tree(join(path,item.name)):[join(path,item.name)]).sort() : [];
const database = (path:string)=>{const db=new DatabaseSync(path);closes.push(()=>{if(db.isOpen)db.close();});return db;};
beforeAll(()=>{const db=new DatabaseSync(':memory:');try {console.log('SLICE1_SQLITE_RUNTIME '+JSON.stringify({node:process.version,pid:process.pid,...db.prepare('SELECT sqlite_version() AS sqlite,sqlite_source_id() AS sqliteSourceId').get()}));}finally{db.close();}});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();for(const close of closes.splice(0).reverse())close();closeMetadataDbs();transport.active='';transport.protocol=0;transport.writes=[];transport.nativeOpens=[];});
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
 const diagnostic=process.env.AB458_SLICE1_INVENTORY_DIAGNOSTIC==='1';
 const inventoryState=()=>readdirSync(f.source).sort().map(path=>{
  const file=join(f.source,path),stat=lstatSync(file,{bigint:true});
  const role=path==='bridge.db'?'sqlite':path==='bridge.db-wal'?'wal':path==='bridge.db-shm'?'excluded-coordination':'retainedUnknown';
  return {path,role,bytes:Number(stat.size),identity:`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
   sha256:['bridge.db','bridge.db-wal','bridge.db-shm'].includes(path)&&stat.isFile()?sha(file):undefined};
 });
 const before=diagnostic?inventoryState():undefined;
 try {await migrateMessagingHome({source:f.source,destination:f.destination,apply:true,offlineIsolated:true});}
 catch(error) {
  if(before)console.log('SLICE1_INVENTORY_DIAGNOSTIC '+JSON.stringify({before,after:inventoryState()}));
  throw error; // Diagnostic preserves the original failure; no retry/repair.
 }
 const migrated=database(join(f.destination,'bridge.db'));
 expect(read(migrated)).toEqual(expected);
 expect(migrated.prepare("SELECT name,sql FROM sqlite_master WHERE name LIKE 'binding_%' ORDER BY name").all()).toEqual(schema);
 expect(sha(join(f.source,'bridge.db'))).toBe(original);assertCurrentMailboxEnvelope(migrated);
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
