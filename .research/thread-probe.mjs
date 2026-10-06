import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
const child=spawn('C:/Users/renne/AppData/Local/Programs/OpenAI/Codex/bin/codex.exe',['app-server','--strict-config','-c','features.multi_agent_v2.enabled=true','-c','features.multi_agent_v2.max_concurrent_threads_per_session=11','-c','agents.max_concurrent_threads_per_session=2'],{env:{...process.env,CODEX_HOME:resolve('.research/probe-home')},windowsHide:true});
const timer=setTimeout(()=>child.kill(),30000);
child.stderr.on('data',d=>process.stderr.write(d));
createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);if(m.id===1){child.stdin.write(JSON.stringify({id:2,method:'thread/start',params:{cwd:process.cwd(),ephemeral:true,config:{'features.multi_agent':false,'features.multi_agent_v2':false,'agents.enabled':false,'agents.max_threads':1}}})+'\n');}if(m.id===2){console.log(JSON.stringify({id:m.id,error:m.error,threadId:m.result?.thread?.id}));child.stdin.end();}});
child.on('close',()=>clearTimeout(timer));
child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'native-limit-probe',version:'1'}}})+'\n');
