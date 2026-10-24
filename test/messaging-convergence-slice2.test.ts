import {EventEmitter} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach,beforeAll,expect,it,vi} from 'vitest';

// Real in-process synthetic SQLite only. Any accidental external/native effect
// fails before launching it; fixtures never use owner homes or sockets.
const fake=vi.hoisted(()=>({writes:[] as unknown[]}));
vi.mock('node:child_process',async original=>{const fail=()=>{throw Error('slice2 subprocess forbidden');};return {...await original<object>(),spawn:fail,spawnSync:fail,exec:fail,execSync:fail,execFile:fail,execFileSync:fail,fork:fail};});
vi.mock('node:worker_threads',async original=>({...await original<object>(),Worker:class{constructor(){throw Error('slice2 production Worker forbidden');}}}));
vi.mock('node:tls',async original=>({...await original<object>(),createServer:()=>{throw Error('slice2 TLS forbidden');},connect:()=>{throw Error('slice2 TLS forbidden');}}));
vi.mock('node:dgram',async original=>({...await original<object>(),createSocket:()=>{throw Error('slice2 UDP forbidden');}}));
vi.mock('node:net',async original=>({...await original<object>(),createServer:()=>{throw Error('slice2 native listener forbidden');},connect:()=>{throw Error('slice2 native socket forbidden');}}));
vi.mock('../src/core/process-identity.js',async original=>({...await original<object>(),processIdentity:(pid:number)=>pid===process.pid?'638968000000000000':undefined,ownProcessIdentity:async()=> '638968000000000000',parentProcessIdentity:async()=>null,isProcessIdentityAlive:(pid:number)=>pid===process.pid?true:undefined,readProcessIdentity:async()=>null,readProcessIdentities:async()=>new Map(),readProcessIdentitiesSync:()=>undefined,readProcessNamesSync:()=>undefined,processStartMs:()=>undefined}));

import {MessageStore} from '../src/core/store.js';
import {Broker} from '../src/core/broker.js';
import {BridgeNode} from '../src/core/node.js';
import {T3WakeJournal} from '../src/core/t3-wake-journal.js';
import {closeMetadataDbs} from '../src/core/metadata-db.js';
import {nullLogger} from '../src/core/logger.js';
import type {BridgeMessage,PeerInfo} from '../src/core/protocol.js';
import type {T3Binding} from '../src/core/t3-identity.js';

const closers:(()=>unknown|Promise<unknown>)[]=[];
const binding=(threadId='thread-A'):T3Binding=>({kind:'t3',scope:'a'.repeat(64),threadId,providerInstanceId:'provider-A'});
const home=()=>{const root=resolve('.agent-bridge-test/slice2-fixtures');mkdirSync(root,{recursive:true});return mkdtempSync(join(root,'run-'));};
const peer=(name:string,frontend=binding()):PeerInfo=>({id:randomUUID(),name,agent:'codex',cwd:resolve('.'),pid:process.pid,agentPid:process.pid,agentStartedAt:'638968000000000000',sessionId:null,frontend,startedAt:1,autoWake:false});
function fixture(){const path=home(),store=new MessageStore(join(path,'bridge.db'),nullLogger);closers.push(()=>store.close());const namespace=String((store as any).db.prepare('SELECT namespace FROM mailbox_store WHERE id=1').get().namespace);return {path,store,namespace,mailbox:{kind:'local' as const,namespace}};}
function message(f:ReturnType<typeof fixture>,extra:Partial<BridgeMessage>={}):BridgeMessage{return {id:randomUUID(),from:{id:'sender-id',name:'sender',agent:'codex'},to:'receiver',recipient:'receiver',conversationId:'conversation',replyTo:null,hop:0,body:'original body',createdAt:123,readAt:null,recipientFrontend:binding(),recipientMailbox:f.mailbox,senderMailbox:f.mailbox,senderOwner:'hosted:'+JSON.stringify(binding('sender-thread')),...extra} as BridgeMessage;}
const unread=(store:MessageStore,name:string,frontend?:T3Binding,native?:string)=>(store.unread as (...a:any[])=>BridgeMessage[])(name,100,frontend,native);
beforeAll(()=>{const db=new DatabaseSync(':memory:');try{const row=db.prepare('SELECT sqlite_version() version,sqlite_source_id() source').get()!;console.log('SLICE2_SQLITE_RUNTIME '+JSON.stringify({node:process.version,pid:process.pid,sqlite:row.version,sqliteSourceId:row.source}));}finally{db.close();}});
afterEach(async()=>{for(const close of closers.splice(0).reverse())await close();closeMetadataDbs();vi.restoreAllMocks();vi.useRealTimers();fake.writes.length=0;});

it('slice2 red: another exact frontend cannot read a colliding recipient name',()=>{const f=fixture(),m=message(f);f.store.insert(m);expect(unread(f.store,m.recipient,binding('thread-B'))).toEqual([]);expect(unread(f.store,m.recipient,binding()).map(m=>m.body)).toEqual(['original body']);});
it('slice2 red: outbound remote copy is never local inbox even with colliding owner IDs',()=>{const f=fixture(),m=message(f,{recipientMailbox:{kind:'remote',hostId:randomUUID(),hostFingerprint:'b'.repeat(64)}} as Partial<BridgeMessage>);f.store.insert(m);expect(unread(f.store,m.recipient,binding())).toEqual([]);expect(f.store.byId(m.id)?.body).toBe('original body');});
it('slice2 red: native child incarnation is part of read authority',()=>{const f=fixture(),owner=JSON.stringify({kind:'child',owner:'parent-registration',session:'native-session',parent:'parent',agentId:'child',incarnation:randomUUID(),parentOwner:'hosted:'+JSON.stringify(binding())}),replacement=JSON.stringify({...JSON.parse(owner),incarnation:randomUUID()}),m=message(f,{recipientFrontend:undefined,recipientNative:owner} as Partial<BridgeMessage>);f.store.insert(m);expect(unread(f.store,m.recipient,undefined,replacement)).toEqual([]);expect(unread(f.store,m.recipient,undefined,owner).map(m=>m.id)).toEqual([m.id]);});
it('slice2 red: a changed local namespace cannot admit an envelope',()=>{const f=fixture(),m=message(f,{recipientMailbox:{kind:'local',namespace:'c'.repeat(64)}} as Partial<BridgeMessage>);expect(()=>f.store.insert(m)).toThrow();expect(f.store.byId(m.id)).toBeNull();});
it('slice2 red: ACK by another frontend retains original unread state',()=>{const f=fixture(),m=message(f);f.store.insert(m);expect((f.store.markRead as (...a:any[])=>number)(m.recipient,[m.id],456,binding('thread-B'))).toBe(0);expect(f.store.byId(m.id)?.readAt).toBeNull();});
it('slice2 red: legacy ownership absence retains bytes without an inbox grant',()=>{const f=fixture(),m=message(f,{recipientFrontend:undefined} as Partial<BridgeMessage>);f.store.insert(m);expect(unread(f.store,m.recipient,binding())).toEqual([]);expect(f.store.byId(m.id)?.body).toBe('original body');});
it('slice2 red: sender name reuse cannot inspect original send state',()=>{const f=fixture(),m=message(f),broker=new Broker('fixture-unused-pipe',f.store,nullLogger,'fixture-token');f.store.insert(m);const replacement={peer:peer('sender',binding('replacement')),authed:true};expect(()=>(broker as any).sendState(replacement,m.id)).toThrow();});
it('slice2 red: a restored wake fence is consulted before absent journal admits output',()=>{const f=fixture(),b=binding(),digest=createHash('sha256').update(JSON.stringify(b)).digest('hex');(f.store as any).db.prepare('INSERT INTO bridge_metadata(domain,key,value,updated_at) VALUES (?,?,?,?)').run('t3-wake-restore',digest,JSON.stringify({version:1,binding:b,state:'unproven',messageIds:[randomUUID()]}),1);const journal=new (T3WakeJournal as any)(f.path,b,'request-namespace-A');expect(()=>journal.admit(['retained-message'])).toThrow();});
it('slice2 red: node refuses an event for a different exact frontend',async()=>{const f=fixture(),node=new BridgeNode({pipePath:'fixture-unused-pipe',dbPath:join(f.path,'bridge.db'),token:'fixture-token',name:'receiver',cwd:f.path,agent:'codex',autoWake:false,canHostBroker:false,log:nullLogger,frontend:binding()});closers.push(()=>node.stop());node.deliverLocal(message(f,{recipientFrontend:binding('other-thread')} as Partial<BridgeMessage>));expect(node.unread()).toEqual([]);});
it('slice2 control: accepted bytes remain available as history',()=>{const f=fixture(),m=message(f);f.store.insert(m);expect(f.store.byId(m.id)?.body).toBe('original body');expect(()=>f.store.insert({...m,body:'replacement'})).toThrow();expect(f.store.byId(m.id)?.body).toBe('original body');});
