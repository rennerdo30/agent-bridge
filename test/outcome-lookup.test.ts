import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { readDashboard } from '../src/core/dashboard-read.js';
import { JOBS_FILE } from '../src/core/constants.js';
import { MessageStore } from '../src/core/store.js';
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
  for (const state of ['merged', 'unmerged']) {
    if (state === 'unmerged') {
      execFileSync('git', ['-C', repo, 'checkout', 'fixture'], {stdio:'ignore'});
      execFileSync('git', ['-C', repo, '-c', 'user.name=rennerdo30', '-c', 'user.email=9086097+rennerdo30@users.noreply.github.com', 'commit', '--allow-empty', '-m', 'Fixture work'], {stdio:'ignore'});
    }
    for(const query of [{job:'codex-job-699'},{run:'2026-10-07-10-00-00-codex-699'}]){
      const start=performance.now(),result=await readDashboard(ctx,{path:'/api/job-outcomes',query});
      expect(performance.now()-start, `${state} ${JSON.stringify(query)}`).toBeLessThan(1000);expect(result.status).toBe(200);
      const body=result.body as any;
      expect(body.contractVersion).toBe(1);expect(body.next).toBeNull();
      expect(Object.keys(body.jobs).length+Object.keys(body.runs).length).toBe(1);
      const outcome=body.jobs['codex-job-699']?.outcome??body.runs['2026-10-07-10-00-00-codex-699'];
      expect(outcome).toMatchObject({delivery:{status:'unknown'},merge:{state}});
    }
  }
  for(const query of [{job:'unknown'},{run:'unknown'},{job:'constructor'},{run:'toString'}])expect((await readDashboard(ctx,{path:'/api/job-outcomes',query})).status).toBe(404);
  expect((await readDashboard(ctx,{path:'/api/job-outcomes',query:{job:'a',run:'b'}})).status).toBe(400);
});

it('keeps next-turn receipt boundaries from independently archived metadata', async () => {
  const root = join(env.home, 'runs'), archive = join(root, 'archive');
  mkdirSync(archive, { recursive: true });
  const first = '2026-10-07-10-00-00-codex-first', next = '2026-10-07-11-00-00-codex-next';
  const oldMeta = JSON.stringify({ job: 'codex-job-deadbeef', jobStartedAt: 100, by: 'fixture', unknown: { retained: true } });
  writeFileSync(join(root, `${first}.log`), '10:00:00 codex\n10:00:01 finished after 1s · done\n');
  writeFileSync(join(root, `${first}.json`), oldMeta);
  writeFileSync(join(archive, `${next}.log-1-logcopy`), '11:00:00 codex\n11:00:01 finished after 1s · done\n');
  writeFileSync(join(archive, `${next}.json-2-metacopy`), JSON.stringify({ job: 'codex-job-deadbeef', jobStartedAt: 400, by: 'fixture' }));
  writeFileSync(join(env.home, JOBS_FILE), JSON.stringify({ jobs: [{ id: 'deadbeef', name: 'codex-job-deadbeef', agent: 'codex', owner: 'fixture', startedAt: 600, status: 'done', args: {} }] }));
  const store = new MessageStore(env.db, nullLogger);
  try {
    for (const at of [200, 500]) store.insert({ id: `result-${at}`, from: { id: 'job:deadbeef', name: 'codex-job-deadbeef', agent: 'codex' }, to: 'fixture', recipient: 'fixture', conversationId: 'job-deadbeef', replyTo: null, hop: 0, body: 'Subagent codex-job-deadbeef (codex) done after 1s.', createdAt: at, readAt: null });
    const ctx = { home: env.home, log: nullLogger, peers: () => [] };
    const selected = (await readDashboard(ctx, { path: '/api/job-outcomes', query: { run: first } })).body as any;
    const full = (await readDashboard(ctx, { path: '/api/job-outcomes' })).body as any;
    expect(selected.runs[first].delivery.messageId).toBe('result-200');
    expect(selected.runs[first].delivery).toEqual(full.runs[first].delivery);
    expect(readFileSync(join(root, `${first}.json`), 'utf8')).toBe(oldMeta);
  } finally { store.close(); }
});
