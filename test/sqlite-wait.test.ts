import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeEnv, until, type TestEnv } from './helpers.js';
let env: TestEnv;
beforeEach(()=>{env=makeEnv();});afterEach(async()=>{vi.restoreAllMocks();await env.cleanup();});
it('keeps an atomic send pending beyond the former busy deadline and commits it once after unlock',async()=>{
  const sender=env.node('sender'),recipient=env.node('recipient','opencode');await sender.start();await recipient.start();
  const worker=new Worker(`const {workerData,parentPort}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync(workerData,{timeout:3000});db.exec('BEGIN IMMEDIATE');parentPort.postMessage('locked');
parentPort.once('message',()=>{db.exec('COMMIT');db.close();parentPort.postMessage('released');});`,{eval:true,workerData:env.db});
  let locked=false;worker.on('message',m=>{if(m==='locked')locked=true;});await until(()=>locked);
  const now=Date.now.bind(Date);let offset=0;vi.spyOn(Date,'now').mockImplementation(()=>now()+offset);
  let settled=false;const sent=sender.send({to:'recipient',body:'busy fixture',dedupeKey:'one-busy-step'}).then(value=>{settled=true;return value;});
  try {
    await new Promise(resolve=>setTimeout(resolve,80));offset=40_000;
    await new Promise(resolve=>setTimeout(resolve,600));expect(settled).toBe(false);
    expect((await sender.peers()).some(peer=>peer.name==='recipient')).toBe(true);
    worker.postMessage('release');const result=await sent;
    expect(result.messages).toHaveLength(1);await until(()=>recipient.unread().length===1);
    expect((await sender.send({to:'recipient',body:'busy fixture',dedupeKey:'one-busy-step'})).messages[0]?.id).toBe(result.messages[0]?.id);
    expect(recipient.unread()).toHaveLength(1);
  } finally {worker.postMessage('release');await Promise.allSettled([sent]);await worker.terminate();}
});
