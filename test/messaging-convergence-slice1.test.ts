import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';

// This selection cannot launch a provider, process, native helper, socket server
// or production Worker, including through a newly introduced indirect call.
const transport = vi.hoisted(()=>({active:'',protocol:0,writes:[] as string[]}));
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
import { assertCurrentMailboxEnvelope, preflightMessagingHome } from '../src/core/mailbox-layout.js';
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
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();for(const close of closes.splice(0).reverse())close();closeMetadataDbs();transport.active='';transport.protocol=0;transport.writes=[];});
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
 db.close();const before=tree(path).map(file=>[file,sha(file)]);
 expect(()=>metadataDb(path)).toThrow();expect(()=>new MessageStore(join(path,'bridge.db'),nullLogger)).toThrow();
 expect(tree(path).map(file=>[file,sha(file)])).toEqual(before);
});
it.each([2,3,4,5,6,10,11,12,13,14])('never automatically reinterprets draft version %s',version=> {
 const {path,store}=candidate();store.close();closeMetadataDbs();
 const db=database(join(path,'bridge.db'));
 if(version<=6)db.prepare("UPDATE bridge_components SET version=? WHERE name='metadata'").run(version);
 else db.exec(`PRAGMA user_version=${version}`);
 db.close();const before=tree(path).map(file=>[file,sha(file)]);
 expect(()=>new MessageStore(join(path,'bridge.db'),nullLogger)).toThrow();
 expect(tree(path).map(file=>[file,sha(file)])).toEqual(before);
});
it('provides a read-only exact-home plan and a finite m1/s9 isolated migration',async()=> {
 const f=shipping(),before=tree(f.source).map(path=>[path,sha(path)]);
 const plan=await migrateMessagingHome({source:f.source,destination:f.destination});
 expect(plan.applied).toBe(false);expect(existsSync(f.destination)).toBe(false);expect(tree(f.source).map(path=>[path,sha(path)])).toEqual(before);
 await expect(migrateMessagingHome({source:f.source,destination:f.destination,apply:true})).rejects.toThrow('attestation');
 await migrateMessagingHome({source:f.source,destination:f.destination,apply:true,offlineIsolated:true});
 const db=database(join(f.destination,'bridge.db'));expect(db.prepare('SELECT * FROM messages ORDER BY id,recipient').all()).toEqual(f.messages);
 expect(db.prepare("SELECT count(*) AS n FROM message_frontends WHERE state='ambiguous' AND owner='' AND source='' AND mailbox=''").get()!.n).toBe(f.messages.length);
 expect(db.prepare("SELECT value FROM bridge_metadata WHERE domain='synthetic-retained'").get()!.value).toBe('{"unknown":true}');
 assertCurrentMailboxEnvelope(db);expect(sha(join(f.source,'bridge.db'))).toBe(f.original);
 expect(tree(f.destination).some(path=>path.includes('.migration-snapshots'))).toBe(true);
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
