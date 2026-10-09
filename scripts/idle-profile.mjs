import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
const label=process.argv[2]??'before';const output=resolve('.agent-bridge-test','idle-'+label);mkdirSync(output,{recursive:true});
if(process.argv[3]!=="retained")await build({entryPoints:{fixture:'scripts/idle-fixture.ts','history-worker':'src/core/history-worker.ts','backup-worker':'src/core/backup-worker.ts','outcome-worker':'src/core/outcome-worker.ts'},outdir:output,outExtension:{'.js':'.mjs'},bundle:true,splitting:label!=='before',platform:'node',format:'esm',target:'node22',external:['node:*'],banner:{js:"import {createRequire as __abRequire} from 'node:module';const require=__abRequire(import.meta.url);"}});
const home=mkdtempSync(join(tmpdir(),'ab-idle-'));writeFileSync(join(home,'config.json'),JSON.stringify({history:{ingest:false},dashboard:false,jobCloseCleanup:false}));
const children=[];const inherited={...process.env};for(const k of Object.keys(inherited))if(k.startsWith('AGENT_BRIDGE_')||k==='CODEX_HOME'||k==='CLAUDE_CONFIG_DIR')delete inherited[k];
const env={...inherited,AGENT_BRIDGE_HOME:home,GIT_CEILING_DIRECTORIES:home,CLAUDE_CONFIG_DIR:join(home,'empty-claude'),CODEX_HOME:join(home,'empty-codex'),XDG_DATA_HOME:join(home,'empty-data'),ANTIGRAVITY_CLI_HOME:join(home,'empty-agy')};
try{
 for(const role of ['broker',...Array(16).fill('session'),...Array(7).fill('runner')]){
  const child=spawn(process.execPath,['--expose-gc',join(output,'fixture.mjs')],{cwd:home,env:{...env,AB_IDLE_ROLE:role,AB_IDLE_NAME:role+'-'+children.length},windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});children.push(child);let stderr='';child.stderr.on('data',x=>stderr+=x);await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw new Error(stderr)}),new Promise((_,reject)=>setTimeout(()=>reject(new Error('fixture startup deadline '+stderr)),20000).unref())]);
 }
 await new Promise(r=>setTimeout(r,2000));
 const samples=await Promise.all(children.map(child=>{const result=once(child,'message');child.send('sample');return result.then(x=>x[0]);}));
 const summary={label,node:process.version,home,method:'16 generated session nodes with server surface, 7 generated job peers with runner surface, 1 actual broker; settled 10s; explicit GC; no provider CLI',roles:Object.fromEntries(['broker','session','runner'].map(role=>{const s=samples.filter(x=>x.role===role);return[role,{count:s.length,cpuMs:s.reduce((a,x)=>a+x.cpuMs,0),rssMiB:s.reduce((a,x)=>a+x.rss,0)/s.length/1048576,heapMiB:s.reduce((a,x)=>a+x.heapUsed,0)/s.length/1048576}]})),samples};writeFileSync(join(output,'report-'+Date.now()+'.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary.roles));
}finally{for(const child of children)if(child.exitCode===null){const exit=once(child,'exit');child.send('stop');await exit;}}
