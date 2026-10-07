import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageStore } from '../src/core/store.js';
import { HistoryIndex } from '../src/core/history.js';
import { ConversationIngestor } from '../src/core/conversations.js';
import { nullLogger } from '../src/core/logger.js';
import { makeEnv, type TestEnv } from './helpers.js';
const hook=vi.hoisted(()=>({probe:null as null|(()=>void)}));
vi.mock('node:fs',async()=>{const actual=await vi.importActual<typeof import('node:fs')>('node:fs');return {...actual,readSync:(...args:Parameters<typeof actual.readSync>)=>{hook.probe?.();return actual.readSync(...args);}};});
let env: TestEnv;
beforeEach(()=>{env=makeEnv();});afterEach(async()=>{hook.probe=null;await env.cleanup();});
it('leaves the shared writer available during history and conversation source reads',()=>{
  const store=new MessageStore(env.db,nullLogger), db=store.history.database, contender=new DatabaseSync(env.db,{timeout:0});
  const claude=join(env.home,'claude'),project=join(env.home,'project');mkdirSync(project);
  const files=join(claude,'projects','fixture');mkdirSync(files,{recursive:true});
  writeFileSync(join(files,'fixture.jsonl'),JSON.stringify({type:'user',cwd:project,message:{content:'hot source'}})+'\n');
  mkdirSync(join(env.home,'runs'));writeFileSync(join(env.home,'runs','2026-10-07-10-00-00-claude-fixture.log'),'10:00:00 fixture\n10:00:01 finished after 1s · done\n');
  const paths={claude,codex:join(env.home,'codex'),opencode:join(env.home,'opencode')};
  const index=new HistoryIndex(db,env.home,paths),ingest=new ConversationIngestor(db,env.home,paths);let probes=0;
  hook.probe=()=>{contender.exec('BEGIN IMMEDIATE');contender.exec('COMMIT');probes++;};
  try {for(let i=0;i<12;i++){index.tick();ingest.tick();}expect(probes).toBeGreaterThan(0);expect(db.prepare('SELECT count(*) n FROM conversation_records').get()!.n).toBeGreaterThan(0);}
  finally {hook.probe=null;index.close();ingest.close();contender.close();store.close();}
});
