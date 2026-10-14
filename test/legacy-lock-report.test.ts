import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { reportLegacyLocks, main, lockHolders } from '../scripts/legacy-lock-report.mjs';
it('joins legacy lease evidence to its matching worktree state and job without reconciling',async()=>{
 const home=mkdtempSync(join(tmpdir(),'legacy-matching-')), worktree=join(home,'fixture-worktree');
 const key=createHash('sha256').update(resolve(worktree).toLowerCase()).digest('hex');
 const lease=join(home,'worktree-leases',key);mkdirSync(lease,{recursive:true});mkdirSync(join(home,'worktree-state'));
 const state={path:worktree,contractVersion:1,lastContinuation:123,processesStopped:false};
 writeFileSync(join(home,'worktree-state',key+'.json'),JSON.stringify(state));
 writeFileSync(join(home,'jobs.json'),JSON.stringify({version:4,jobs:[{name:'matching-job',status:'running',worktree:{path:worktree}},{name:'foreign-job',status:'done',worktree:{path:join(home,'other')}}]}));
 const result=await reportLegacyLocks(home,{holders:async()=>({status:'unknown',pids:[],reason:'directory ownership unknown'})});
 expect(result.locks).toHaveLength(1);expect(result.locks[0]!.path).toBe(lease);expect(result.locks[0]!.ageMs).toBeGreaterThanOrEqual(0);
 expect(result.locks[0]!.worktreeState).toEqual(state);expect(result.locks[0]!.matchingJobs.map(j=>j.name)).toEqual(['matching-job']);
 expect(result.locks[0]!.recommendedAction).toContain('Keep unchanged');expect(readdirSync(lease)).toEqual([]);
});
it.skipIf(process.platform !== 'win32')('identifies an actual generated open file handle without modifying the lock', async () => {
 const home=mkdtempSync(join(tmpdir(),'legacy-handle-')), path=join(home,'jobs.json.lock');writeFileSync(path,'');
 const child=spawn(process.execPath,['-e',"const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'r+');process.send('ready');setInterval(()=>{},1000);",path],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
 try {await once(child,'message');const evidence=await lockHolders(path);expect(evidence.status).toBe('held');expect(evidence.pids).toContain(child.pid);expect(child.exitCode).toBe(null);expect(readFileSync(path,'utf8')).toBe('');}
 finally {const exit=once(child,'exit');child.kill();await exit;}
});
it('reports empty legacy locks without changing bytes or authorizing unknown ownership',async()=>{
 const home=mkdtempSync(join(tmpdir(),'legacy-evidence-'));const lease=join(home,'worktree-leases','a'.repeat(64));mkdirSync(lease,{recursive:true});writeFileSync(join(home,'jobs.json.lock'),'');const jobs=JSON.stringify({version:4,jobs:[{name:'fixture-job',status:'interrupted'}]});writeFileSync(join(home,'jobs.json'),jobs);
 const result=await reportLegacyLocks(home,{holders:async()=>({status:"unknown",pids:[],reason:"fixture unknown"})});
 expect(result.locks).toHaveLength(2);expect(result.locks.every(x=>x.processHolders.status==='unknown'&&x.recommendedAction.startsWith('Keep unchanged'))).toBe(true);
 expect(readFileSync(join(home,'jobs.json'),'utf8')).toBe(jobs);expect(readFileSync(join(home,'jobs.json.lock'),'utf8')).toBe('');expect(readdirSync(lease)).toEqual([]);
 await expect(main(['--home',home,'--confirm-owner-archive'])).rejects.toThrow('read-only');
});
it('retains evidence of a live holder and excludes versioned or nonempty leases',async()=>{
 const home=mkdtempSync(join(tmpdir(),'legacy-evidence-'));mkdirSync(join(home,'worktree-leases','b'.repeat(64)),{recursive:true});writeFileSync(join(home,'worktree-leases','b'.repeat(64),'keep.txt'),'unique data');writeFileSync(join(home,'jobs.json.lock'),'');
 const result=await reportLegacyLocks(home,{holders:async()=>({status:'held',pids:[123],reason:'fixture handle'})});expect(result.locks).toHaveLength(1);expect(result.locks[0]!.processHolders.pids).toEqual([123]);expect(result.locks[0]!.recommendedAction).toContain('Keep unchanged');expect(readFileSync(join(home,'worktree-leases','b'.repeat(64),'keep.txt'),'utf8')).toBe('unique data');
});
