import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { readDashboard } from '../src/core/dashboard-read.js';
import { JOBS_FILE } from '../src/core/constants.js';
import { nullLogger } from '../src/core/logger.js';
import { makeEnv, type TestEnv } from './helpers.js';
let env: TestEnv;
beforeEach(()=>{env=makeEnv();}); afterEach(()=>env.cleanup());
it('derives only the selected job or run from a 700-run corpus in under one second', async()=>{
  const root=join(env.home,'runs');mkdirSync(root);
  const jobs=Array.from({length:700},(_,i)=>({id:String(i),name:`codex-job-${i}`,agent:'codex',owner:'fixture',status:'done',startedAt:1,args:{}}));
  const repo=join(env.home,'repo');mkdirSync(repo);execFileSync('git',['init','-b','main',repo],{stdio:'ignore'});
  execFileSync('git',['-C',repo,'-c','user.name=rennerdo30','-c','user.email=9086097+rennerdo30@users.noreply.github.com','commit','--allow-empty','-m','Fixture base'],{stdio:'ignore'});
  execFileSync('git',['-C',repo,'branch','fixture'],{stdio:'ignore'});
  (jobs[699] as any).worktree={repoRoot:repo,cwd:repo,branch:'fixture',baseBranch:'main'};
  writeFileSync(join(env.home,JOBS_FILE),JSON.stringify({jobs}));
  for(let i=0;i<700;i++){
    const name=`2026-10-07-10-00-00-codex-${i}`;
    writeFileSync(join(root,`${name}.log`),`10:00:00 codex\n${'fixture line\n'.repeat(5000)}10:00:01 finished after 1s · done\n`);
    writeFileSync(join(root,`${name}.json`),JSON.stringify({job:jobs[i]!.name,jobStartedAt:1,by:'fixture',...(i===699?{repoRoot:repo,branch:'fixture',baseBranch:'main'}:{})}));
  }
  const ctx={home:env.home,log:nullLogger,peers:()=>[]};
  for(const query of [{job:'codex-job-699'},{run:'2026-10-07-10-00-00-codex-699'}]){
    const start=performance.now(),result=await readDashboard(ctx,{path:'/api/job-outcomes',query});
    expect(performance.now()-start).toBeLessThan(1000);expect(result.status).toBe(200);
    const body=result.body as any;
    expect(body.contractVersion).toBe(1);expect(body.next).toBeNull();
    expect(Object.keys(body.jobs).length+Object.keys(body.runs).length).toBe(1);
    const outcome=body.jobs['codex-job-699']?.outcome??body.runs['2026-10-07-10-00-00-codex-699'];
    expect(outcome).toMatchObject({delivery:{status:'unknown'},merge:{state:'merged'}});
  }
  for(const query of [{job:'unknown'},{run:'unknown'}])expect((await readDashboard(ctx,{path:'/api/job-outcomes',query})).status).toBe(404);
  expect((await readDashboard(ctx,{path:'/api/job-outcomes',query:{job:'a',run:'b'}})).status).toBe(400);
});
