import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function lockHolders(path) {
  if (process.platform !== 'win32' || lstatSync(path).isDirectory()) return {status:'unknown',pids:[],reason:'Open-handle probe is unsupported for this platform or directory; retain lock'};
  try {
    const script=fileURLToPath(new URL('./lock-handle-evidence.ps1',import.meta.url));
    const source=readFileSync(script,'utf8');
    const command=`& { ${source}\n } -LockPath '${path.replaceAll("'","''")}'`;
    const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:15000});
    const value=JSON.parse(stdout||'[]'),pids=(Array.isArray(value)?value:[value]).filter(x=>Number.isSafeInteger(x)&&x>0);
    return {status:pids.length?'held':'none',pids,reason:'Read-only Windows Restart Manager snapshot; requires fresh owner review before archive'};
  } catch { return {status:'unknown',pids:[],reason:'Open-handle probe failed; retain lock'}; }
}

function physical(path) {
  for(let p=resolve(path);;p=dirname(p)) {
    const st=lstatSync(p); if(st.isSymbolicLink())throw new Error('Linked evidence path is refused');
    if(dirname(p)===p)break;
  }
}
function json(path) { try {physical(path);if(lstatSync(path).size>16*1024*1024)throw new Error('Evidence file exceeds bound');return JSON.parse(readFileSync(path,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;} }
const key=path=>createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');
/** Read only. No token/config/credentials, migration, store constructors or reconciliation. */
export async function reportLegacyLocks(home,{now=Date.now(), holders=lockHolders}={}) {
  physical(home);
  const value=json(join(home,'jobs.json'));
  const jobs=Array.isArray(value)?value:Array.isArray(value?.jobs)?value.jobs:[];
  const stateDir=join(home,'worktree-state');let states=[];
  try {physical(stateDir);states=readdirSync(stateDir).filter(x=>x.endsWith('.json')).map(x=>json(join(stateDir,x))).filter(Boolean);}catch(e){if(e.code!=='ENOENT')throw e;}
  const candidates=[join(home,'jobs.json.lock')];
  const leases=join(home,'worktree-leases');
  try {physical(leases);candidates.push(...readdirSync(leases).filter(x=>/^[a-f0-9]{64}$/.test(x)).map(x=>join(leases,x)));}catch(e){if(e.code!=='ENOENT')throw e;}
  const locks=[];
  for(const path of candidates){let st;try{physical(path);st=lstatSync(path);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    const empty=st.isDirectory()?readdirSync(path).length===0:st.isFile()&&st.size===0;
    if(!empty)continue;
    const worktree=states.find(s=>typeof s.path==='string'&&key(s.path)===path.split(/[\\/]/).at(-1))??null;
    const matchingJobs=jobs.filter(j=>path.endsWith('jobs.json.lock')||(j.worktree?.path&&key(j.worktree.path)===path.split(/[\\/]/).at(-1))).map(j=>({name:j.name,status:j.status,worktree:j.worktree??null}));
    const processHolders=await holders(path);
    locks.push({path,kind:st.isDirectory()?'empty-worktree-lease':'empty-job-lock',ageMs:Math.max(0,now-st.mtimeMs),matchingJobs,worktreeState:worktree,processHolders,recommendedAction:processHolders.status==='none'&&!matchingJobs.some(j=>['running','waiting'].includes(j.status))?'Owner review required: archive only after explicit confirmation and fresh handle/state evidence':'Keep unchanged: live or unknown ownership; inspect before any archive'});
  }
  return {version:1,mode:'read-only',home,generatedAt:now,locks,limitations:['Absence of PID metadata or age never proves an empty lock is abandoned.','Unknown open-handle ownership blocks any archive recommendation.','This report implements no reconciliation or archive action.']};
}
export async function main(args){
  if(args.length!==2||args[0]!=='--home')throw new Error('Usage: node scripts/legacy-lock-report.mjs --home <bridge-home> (read-only; action flags refused)');
  console.log(JSON.stringify(await reportLegacyLocks(resolve(args[1])),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=2;});
