import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename,dirname,isAbsolute,join,relative,resolve } from "node:path";
import { z } from "zod";
import { JSON_STORE_VERSION, writeJsonStore } from "./json-store.js";
import { metadataFileLease } from "./metadata-file-lease.js";
import { sameFrontend, t3BindingSchema, type T3Binding } from "./t3-identity.js";
import type { T3Host } from "./t3-host.js";
import { existingMetadataDb, retainMetadataReader } from "./metadata-db.js";

export const T3_WAKE_MESSAGE_LIMIT = 2000;
const MAX_BYTES = 8 * 1024 * 1024;
const id = z.string().min(1).max(512);
const receipt = z.object({ threadId: id, delivery: z.enum(["started", "queued", "steered", "restarted"]),
  messageId: id, runId: id, status: id, taskId: id.nullable().optional() }).strict();
const operation = z.object({
  requestNamespace: id.optional(),
  clientRequestId: z.string().regex(/^bridge-wake-[a-f0-9]{64}$/),
  messageIds: z.array(id).min(1).max(100), message: z.string().min(1).max(64_000),
  mode: z.literal("queue"), createdAt: z.number().int().nonnegative(),
}).strict();
export type T3WakeOperation = z.infer<typeof operation>;
const retained = z.discriminatedUnion("state", [
  operation.extend({ state: z.literal("submitted") }),
  operation.extend({ state: z.literal("accepted"), receipt }),
  operation.extend({ state: z.literal("unknown"), failureStage: z.enum(["refused", "unavailable", "unknown"]) }),
]);
const document = z.object({ version: z.literal(JSON_STORE_VERSION), contractVersion: z.literal(1),
  binding: t3BindingSchema, operations: z.array(retained).max(T3_WAKE_MESSAGE_LIMIT) }).strict();
type Document = z.infer<typeof document>;
export type T3WakeOutcome = { state: "accepted"; receipt: Awaited<ReturnType<T3Host["send"]>>["receipt"] } |
  { state: "unknown"; failureStage: "refused" | "unavailable" | "unknown" };

export class T3WakeJournalError extends Error {
  constructor(readonly reason: "unavailable" | "invalid" | "full") {
    super(`T3 wake journal ${reason}; automatic dispatch refused. Retained operations are preserved; repair or review the journal before restarting wake delivery.`);
  }
}

function makeOperation(binding: T3Binding, ids: string[], createdAt: number, requestNamespace?:string): T3WakeOperation {
  const messageIds = [...new Set(ids)].sort();
  return operation.parse({ ...(requestNamespace?{requestNamespace}:{}),clientRequestId: `bridge-wake-${createHash("sha256").update(JSON.stringify(requestNamespace?[binding,requestNamespace,messageIds]:[binding, messageIds])).digest("hex")}`,
    messageIds, createdAt, mode: "queue", message:
      `agent-bridge: unread mail is waiting in your existing Bridge inbox. Call agent-bridge inbox to read it and use send to answer where needed. Bridge message IDs: ${messageIds.join(", ")}. This pointer is a wake request, not the message contents or a read receipt.` });
}

/** Immutable admission before any effect. Submitted (including a crash) is never automatically retried. */
export class T3WakeJournal {
  readonly file: string;
  private readonly binding: T3Binding;
  private readonly digest:string;
  constructor(private readonly home: string, binding: T3Binding, private readonly originalNamespace?:string|(()=>string|undefined)) {
    this.binding = t3BindingSchema.parse(binding);
    this.digest=createHash("sha256").update(JSON.stringify(this.binding)).digest("hex");
    this.file = join(home, `t3-wakes-${this.digest}.json`);
  }

  private namespace():string {
    const value=typeof this.originalNamespace==='function'?this.originalNamespace():this.originalNamespace;
    const parsed=id.safeParse(value);if(!parsed.success)throw new T3WakeJournalError('unavailable');return parsed.data;
  }

  /** Refusal-only retained-effect index. A row/phase never proves execution,
   * consumption or absence. Slice4 must install the full original union before
   * publishing/restoring authority; until then exact IDs or the binding stay held. */
  private restoreHold():{blocked:Set<string>|'binding';covered:Set<string>} {
    const release=retainMetadataReader(this.home);
    try {
      const db=existingMetadataDb(this.home);if(!db)throw new T3WakeJournalError('unavailable');
      const row=db.prepare("SELECT value FROM bridge_metadata WHERE domain='t3-wake-restore' AND key=?").get(this.digest);
      if(!row)return {blocked:new Set(),covered:new Set()};
      const raw=String(row.value);if(Buffer.byteLength(raw)>MAX_BYTES)throw new T3WakeJournalError('invalid');
      const schema=z.object({version:z.literal(1),binding:t3BindingSchema,scope:z.enum(['binding','messages']),phase:z.enum(['held','reconciled']),
        messageIds:z.array(id).max(T3_WAKE_MESSAGE_LIMIT),retained:z.array(z.object({path:id,sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(T3_WAKE_MESSAGE_LIMIT)}).strict();
      const fence=schema.parse(JSON.parse(raw));
      if(!sameFrontend({frontend:fence.binding},{frontend:this.binding})||fence.scope==='messages'&&!fence.messageIds.length)throw new T3WakeJournalError('invalid');
      const unknown=()=>({blocked:'binding' as const,covered:new Set<string>()});
      if(fence.scope==='binding')return unknown();
      const held=new Set(fence.messageIds),covered=new Set<string>();let bytes=0;
      for(const original of fence.retained){
        const file=resolve(this.home,original.path),rel=relative(resolve(this.home),file),base=`t3-wakes-${this.digest}.json`;
        if(isAbsolute(original.path)||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||!([base].includes(basename(file))||basename(file).startsWith(base+'.backup-')||basename(file).startsWith(base+'.corrupt-')))return unknown();
        try {
          for(let dir=dirname(file);dir!==resolve(this.home);dir=dirname(dir)){
            const parent=lstatSync(dir);if(!parent.isDirectory()||parent.isSymbolicLink()||dirname(dir)===dir)return unknown();
          }
          const raw=this.readOriginal(file);bytes+=Buffer.byteLength(raw);
          if(bytes>MAX_BYTES||createHash('sha256').update(raw).digest('hex')!==original.sha256)return unknown();
          for(const record of this.decode(raw).operations)for(const messageId of record.messageIds)held.add(messageId);
          if(held.size>T3_WAKE_MESSAGE_LIMIT)return unknown();covered.add(file);
        } catch{return unknown();} // Unreadable/corrupt originals are NEVER absence.
      }
      return {blocked:held,covered};
    } finally {release();}
  }

  private readOriginal(file:string):string {
    const before=lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>MAX_BYTES)throw new T3WakeJournalError('invalid');
    const fd=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try {
      const opened=fstatSync(fd);if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)throw new T3WakeJournalError('invalid');
      const data=Buffer.alloc(before.size),tail=Buffer.alloc(1);
      for(let at=0;at<data.length;){const n=readSync(fd,data,at,data.length-at,at);if(!n)throw new T3WakeJournalError('invalid');at+=n;}
      if(readSync(fd,tail,0,1,data.length))throw new T3WakeJournalError('invalid');
      const raw=data.toString('utf8'),after=fstatSync(fd),current=lstatSync(file);
      if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||current.isSymbolicLink()||current.nlink!==1||current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size||current.mtimeMs!==before.mtimeMs)throw new T3WakeJournalError('invalid');
      return raw;
    } finally{closeSync(fd);}
  }

  private decode(raw:string):Document {
    const parsed=document.parse(JSON.parse(raw));
    if(!sameFrontend({frontend:parsed.binding},{frontend:this.binding}))throw new T3WakeJournalError('invalid');
    const members=new Set<string>();
    for(const record of parsed.operations){
      const expected=makeOperation(this.binding,record.messageIds,record.createdAt,record.requestNamespace);
      if(record.clientRequestId!==expected.clientRequestId||record.message!==expected.message||JSON.stringify(record.messageIds)!==JSON.stringify(expected.messageIds)||record.state==='accepted'&&record.receipt.threadId!==this.binding.threadId)throw new T3WakeJournalError('invalid');
      for(const id of record.messageIds){if(members.has(id))throw new T3WakeJournalError('invalid');members.add(id);}
    }
    if(members.size>T3_WAKE_MESSAGE_LIMIT)throw new T3WakeJournalError('invalid');return parsed;
  }

  private retainedFamily():string[] {
    const base=`t3-wakes-${this.digest}.json`;
    const retained:string[]=[];
    for(const directory of [this.home,join(this.home,'archive')]) {
      let files:string[];try{files=readdirSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      for(const file of files)if(file===base||file.startsWith(base+'.backup-')||file.startsWith(base+'.corrupt-')){if(directory!==this.home||file!==base)retained.push(resolve(directory,file));if(retained.length>T3_WAKE_MESSAGE_LIMIT)throw new T3WakeJournalError('full');}
    }
    return retained;
  }

  private read(): Document {
    const hold=this.restoreHold(); // BEFORE ENOENT can imply a fresh journal.
    if(hold.blocked==='binding')throw new T3WakeJournalError('unavailable');
    try {
      return this.decode(this.readOriginal(this.file));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if(this.retainedFamily().some(file=>!hold.covered.has(file)))throw new T3WakeJournalError('unavailable');
        return { version: JSON_STORE_VERSION, contractVersion: 1, binding: this.binding, operations: [] };
      }
      throw error;
    }
  }

  private locked<T>(fn: () => T): T {
    try {
      // Same protected file-lease/atomic JSON discipline as existing ownership journals.
      // Zero wait: a live writer blocks this admission without an unbounded retry or second effect.
      const release = metadataFileLease(`${this.file}.lock`, 0, true);
      try { return fn(); } finally { release(); }
    } catch (error) {
      throw error instanceof T3WakeJournalError ? error : new T3WakeJournalError(error instanceof z.ZodError || error instanceof SyntaxError ? "invalid" : "unavailable");
    }
  }

  admit(candidates: string[]): T3WakeOperation | undefined {
    return this.locked(() => {
      const previous = this.read(), members = new Set(previous.operations.flatMap(record => record.messageIds));
      const namespace=this.namespace(),hold=this.restoreHold().blocked;
      if(hold==='binding')throw new T3WakeJournalError('unavailable');
      const ids = [...new Set(candidates)].filter(messageId => !members.has(messageId)&&!hold.has(messageId)).slice(0, 100);
      if (!ids.length) return undefined;
      if (members.size + ids.length > T3_WAKE_MESSAGE_LIMIT) throw new T3WakeJournalError("full");
      const admitted = makeOperation(this.binding, ids, Date.now(),namespace);
      const next: Document = { ...previous, operations: [...previous.operations, { ...admitted, state: "submitted" }] };
      writeJsonStore(this.file, next, previous);
      return admitted;
    });
  }

  /** Last guard immediately before the one external callback, not a retry. */
  assertDispatch(admitted:T3WakeOperation):void {
    this.locked(()=>{
      if(!admitted.requestNamespace||admitted.requestNamespace!==this.namespace())throw new T3WakeJournalError('unavailable');
      const hold=this.restoreHold().blocked;if(hold==='binding'||admitted.messageIds.some(id=>hold.has(id)))throw new T3WakeJournalError('unavailable');
      const current=this.read().operations.find(record=>record.clientRequestId===admitted.clientRequestId);
      if(!current||current.state!=='submitted'||JSON.stringify(operation.strip().parse(current))!==JSON.stringify(admitted))throw new T3WakeJournalError('invalid');
    });
  }

  complete(admitted: T3WakeOperation, outcome: T3WakeOutcome): void {
    this.locked(() => {
      const previous = this.read(), index = previous.operations.findIndex(record => record.clientRequestId === admitted.clientRequestId);
      const current = previous.operations[index];
      if (!current || current.state !== "submitted" || JSON.stringify(operation.strip().parse(current)) !== JSON.stringify(admitted)) throw new T3WakeJournalError("invalid");
      const operations = [...previous.operations];
      operations[index] = retained.parse({ ...admitted, ...outcome });
      writeJsonStore(this.file, { ...previous, operations }, previous);
    });
  }
}
