import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const home=resolve('.research/probe-home'); mkdirSync(home,{recursive:true});
for (const n of [0,6]) {
 await new Promise((resolve,reject)=>{
 const config={'features.multi_agent':n>0,'features.multi_agent_v2':false,'agents.enabled':n>0,'agents.max_threads':Math.max(1,n)};
 const args=['app-server','--strict-config',...Object.entries(config).flatMap(([k,v])=>['-c',`${k}=${v}`])];
 const child=spawn('C:/Users/renne/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe',args,{env:{...process.env,CODEX_HOME:home},windowsHide:true});
 const timer=setTimeout(()=>{child.kill();reject(new Error('timeout'));},30000);
 child.stderr.on('data',d=>process.stderr.write(d));
 createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);if(m.id===1){child.stdin.write(JSON.stringify({id:2,method:'config/read',params:{includeLayers:false}})+'\n');}if(m.id===2){console.log(JSON.stringify({count:n,agents:m.result?.config?.agents,features:m.result?.config?.features?.multi_agent,v2:m.result?.config?.features?.multi_agent_v2,error:m.error}));child.stdin.end();}});
 child.on('error',reject);child.on('close',()=>{clearTimeout(timer);resolve();});
 child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'native-limit-probe',version:'1'}}})+'\n');
 });
}
