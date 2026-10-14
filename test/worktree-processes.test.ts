import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect,it } from 'vitest';
import { worktreeProcesses,worktreeProcessReport } from '../src/core/worktree-processes.js';
it('reports surviving processes with creation identity without claiming ownership or stopping them',()=>{
 const report=worktreeProcessReport({complete:true,processes:[{pid:123,identity:'start-ticks',name:'python.exe'}]});expect(report).toContain('PID 123, python.exe, creation identity start-ticks');expect(report).toContain('no termination attempted');expect(report).toContain('Supervisor review required');
 expect(worktreeProcessReport({complete:false,processes:[]})).toContain('Probe incomplete');
});
it.skipIf(!['win32','linux'].includes(process.platform))('observes a real generated worktree tool and leaves it alive',async()=>{
 const home=mkdtempSync(join(tmpdir(),'associated-tool-'));const child=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)",home],{cwd:home,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});try{await once(child,'message');const evidence=await worktreeProcesses(home);expect(evidence.processes.find(p=>p.pid===child.pid)).toMatchObject({identity:expect.any(String)});expect(child.exitCode).toBe(null);}finally{const exited=once(child,'exit');child.kill();await exited;}
});
