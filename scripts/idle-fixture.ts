import { BridgeNode } from '../src/core/node.js';
import { nullLogger } from '../src/core/logger.js';
import { resolveDbPath, resolvePipePath } from '../src/core/paths.js';
import { loadOrCreateToken } from '../src/core/token.js';
// Load the same role's source surface; no paid CLI/provider is invoked.
if(process.env.AB_IDLE_ROLE==='runner')await import('../src/mcp/job-runner.js');
else if(process.env.AB_IDLE_ROLE==='session')await import('../src/mcp/server.js');
const home=process.env.AGENT_BRIDGE_HOME!;
const role=process.env.AB_IDLE_ROLE!;
const node=new BridgeNode({home:undefined,pipePath:resolvePipePath(home,{}),dbPath:resolveDbPath(home),token:loadOrCreateToken(home),name:process.env.AB_IDLE_NAME!,agent:'codex',cwd:home,autoWake:false,log:nullLogger,canHostBroker:role==='broker',...(role==='runner'?{id:'job:'+process.env.AB_IDLE_NAME,jobAgent:'codex',jobOwner:'fixture-supervisor'}:{})} as any);
await node.start();process.send?.({ready:true});
process.on('message',async(message:any)=>{
 if(message==='sample'){global.gc?.();const start=process.cpuUsage();const at=performance.now();setTimeout(()=>process.send?.({role,name:process.env.AB_IDLE_NAME,cpuMs:(process.cpuUsage(start).user+process.cpuUsage(start).system)/1000,elapsedMs:performance.now()-at,...process.memoryUsage()}),10000);}
 if(message==='stop'){await node.stop();process.exit(0);}
});
