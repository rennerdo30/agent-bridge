import { execFile } from 'node:child_process';
import { readdir, readlink } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { readProcessIdentity } from './process-identity.js';
const exec=promisify(execFile);
export interface WorktreeProcessEvidence { pid: number; identity: string | null; name: string }
/** Read-only association evidence. A cwd/command-line match grants no authority to terminate. */
export async function worktreeProcesses(path: string, exclude: number[] = [process.pid]): Promise<{ processes: WorktreeProcessEvidence[]; complete: boolean }> {
 const root=resolve(path);
 try {
  if(process.platform==='win32'){
   const literal=root.replaceAll("'","''");
   const script=`$root='${literal}'; @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {$_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0} | ForEach-Object { $identity=$null;try{$identity=[string](Get-Process -Id $_.ProcessId -ErrorAction Stop).StartTime.ToUniversalTime().Ticks}catch{}; @{pid=[int]$_.ProcessId;identity=$identity;name=$_.Name} }) | ConvertTo-Json -Compress`;
   const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,maxBuffer:1024*1024});
   const value=JSON.parse(stdout||'[]'); const rows=Array.isArray(value)?value:[value];
   return {processes:rows.filter(p=>Number.isSafeInteger(p.pid)&&p.pid>0&&!exclude.includes(p.pid)&&p.name!=='powershell.exe'),complete:true};
  }
  if(process.platform==='linux'){
   const processes:WorktreeProcessEvidence[]=[];
   for(const name of await readdir('/proc')){const pid=Number(name);if(!pid||exclude.includes(pid))continue;try{const cwd=await readlink('/proc/'+pid+'/cwd');if(cwd===root||cwd.startsWith(root+sep))processes.push({pid,identity:await readProcessIdentity(pid),name:'process with matching cwd'});}catch{/* exited or inaccessible; no stopping authority */}}
   return {processes,complete:false};
  }
 }catch{/* probe failure retains unknown ownership */}
 return {processes:[],complete:false};
}
export function worktreeProcessReport(evidence:{processes:WorktreeProcessEvidence[];complete:boolean}):string {
 return 'Worktree process evidence (association only; no termination attempted): '+(evidence.processes.length?evidence.processes.map(p=>`PID ${p.pid}, ${p.name}, creation identity ${p.identity??'unknown'}`).join('; '):'no associated process observed')+'. '+(evidence.complete?'Command-line association checked; open handles and unmentioned cwd remain unknown.':'Probe incomplete; surviving background processes may remain.')+' Supervisor review required before cleanup.';
}
