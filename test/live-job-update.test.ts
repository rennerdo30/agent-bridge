import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { activatePluginRuntime, updateCodex } from '../src/cli/live-update.js';
import { delegateToCodexAppServer, type Steering } from '../src/core/codex-appserver.js';
import { nullLogger } from '../src/core/logger.js';
import { publishPlugin } from '../src/core/plugin-runtime.js';
import { until } from './helpers.js';
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ab-running-update-')); });
afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
it('publishes an update while ten real mock app-servers keep their pinned code and finish normally', async () => {
  const source = join(root, 'source'), cache = join(root, 'client', 'plugins', 'cache', 'agent-bridge', 'agent-bridge');
  mkdirSync(join(source, 'dist'), { recursive: true });
  const script = `const {createInterface}=require('node:readline'); const {readFileSync}=require('node:fs');
const version=readFileSync('version.txt','utf8'); const out=v=>console.log(JSON.stringify(v));
createInterface({input:process.stdin}).on('line', line=>{ const q=JSON.parse(line); if(!q.id)return;
let result={}; if(q.method==='thread/start')result={thread:{id:'saved'}}; if(q.method==='turn/start')result={turn:{id:'live'}}; out({id:q.id,result});
if(q.method==='turn/steer'){ out({method:'item/completed',params:{turnId:'live',item:{type:'agentMessage',text:version+':'+readFileSync('version.txt','utf8')}}});out({method:'turn/completed',params:{turn:{id:'live',status:'completed'}}}); }
});`;
  writeFileSync(join(source, 'app-server'), script); writeFileSync(join(source, 'version.txt'), 'old');
  writeFileSync(join(source, 'dist', 'worker.mjs'), '// old');
  const old = publishPlugin(source, cache, '0.1.0');
  const controls: Steering[] = [], controllers = Array.from({length:10}, () => new AbortController());
  const jobs = controllers.map(controller => delegateToCodexAppServer({ bin: process.execPath, cwd: old, prompt: 'keep working', sandbox: 'read-only', timeoutSec: 15,
    signal: controller.signal, log: nullLogger, extraEnv: {AGENT_BRIDGE_HOME: join(root,'data'), CODEX_HOME: join(root,'client')},
    live: {from:'fixture-supervisor',onAnswer:()=>{},onSteering: value => {if(value) controls.push(value);}} }));
  const results = Promise.all(jobs); void results.catch(()=>{});
  try {
    await until(() => controls.length === 10);
    writeFileSync(join(source, 'version.txt'), 'new'); writeFileSync(join(source, 'dist', 'worker.mjs'), '// new');
    updateCodex(source, join(root, 'client'), '0.1.1');
    for (const client of ['claude','codex','opencode','antigravity'] as const) activatePluginRuntime(source, client, join(root,'data'), '0.1.1');
    expect(readFileSync(join(old,'version.txt'),'utf8')).toBe('old');
    await Promise.all(controls.map(control => control.send('finish')));
    expect((await results).map(result => [result.isError,result.text])).toEqual(Array.from({length:10},()=>[false,'old:old']));
  } finally { controllers.forEach(controller=>controller.abort()); await Promise.allSettled(jobs); }
});
it('names an externally signalled active app-server exit and keeps its resumable session', async () => {
  writeFileSync(join(root,'app-server'), `const {createInterface}=require('node:readline');const out=v=>console.log(JSON.stringify(v));
createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(!q.id)return;out({id:q.id,result:q.method==='thread/start'?{thread:{id:'saved'}}:q.method==='turn/start'?{turn:{id:'active'}}:{}});if(q.method==='turn/start')setTimeout(()=>process.kill(process.pid,'SIGTERM'),30);});`);
  const failure = await delegateToCodexAppServer({bin:process.execPath,cwd:root,prompt:'fixture',sandbox:'read-only',timeoutSec:5,log:nullLogger}).catch(e=>e);
  expect(failure.sessionId).toBe('saved'); expect(failure.message).toMatch(/terminated externally.*(?:code|signal)/);
});
