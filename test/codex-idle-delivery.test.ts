import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { makeEnv, until, type TestEnv } from "./helpers.js";
let env: TestEnv, native: ChildProcess | undefined, client: Client | undefined;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await client?.close(); if (native) { native.kill(); await new Promise<void>(resolve => native!.exitCode !== null ? resolve() : native!.once("exit", () => resolve())); } await env.cleanup(); client = undefined; native = undefined; });
it.each(["main", "secondary"])("idle Codex %s consumes broadcast and subsequent direct mail through native queue without owner input", async role => {
  const project = join(env.home, "project"); mkdirSync(project);
  execFileSync("git", ["init", project], { windowsHide: true, stdio: "ignore" });
  const nativePath = join(env.home, "native-tui.cjs");
  writeFileSync(nativePath, `const net=require('net'); let state='idle'; const server=net.createServer(socket=>{let input='';socket.on('data',data=>{input+=data; if(!input.includes('\\n'))return; const queued=JSON.parse(input); socket.end('accepted\\n'); state='busy';process.send({event:'turn/started',...queued});});});process.on('message',m=>{if(m.event==='turn/completed'){state='idle';process.send({event:'thread/status',state});}});server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port,state}));`);
  native = fork(nativePath, [], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  const address = await new Promise<{port:number}>(resolve => native!.once("message", resolve as any));
  writeFileSync(join(project, "queue"), `const net=require('net'),args=process.argv.slice(2); const thread=args[args.indexOf('--thread')+1],message=args[args.indexOf('--message')+1]; const socket=net.connect(${address.port},'127.0.0.1',()=>socket.write(JSON.stringify({thread,message})+'\\n'));socket.on('data',()=>socket.end());socket.on('end',()=>process.exit(0));socket.on('error',()=>process.exit(1));`);
  const sender = env.node("sender", "other"); await sender.start();
  if (role === "secondary") { const primary = env.node("primary", "claude"); await primary.relocate(project); await primary.start(); }
  client = new Client({name:"native-idle-codex-fixture",version:"1"});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(import.meta.dirname,"..","plugins","codex","dist","server.mjs"),"--agent=codex"],env:{...process.env,AGENT_BRIDGE_HOME:env.home,AGENT_BRIDGE_NAME:"idle-codex",CLAUDE_PROJECT_DIR:project,AGENT_BRIDGE_CODEX_BIN:process.execPath,AGENT_BRIDGE_AUTO_WAKE:"off",AGENT_BRIDGE_WAKE_ON_DIRECT:"on",AGENT_BRIDGE_DASHBOARD:"off",AGENT_BRIDGE_LINGER_SEC:"0"} as Record<string,string>,stderr:"ignore"}));
  const call = (name:string,args={}) => client!.callTool({name,arguments:args,_meta:{threadId:"native-thread","codex/sandbox-state-meta":{sandboxCwd:project}}});
  await call("peers");
  await sender.send({to:"idle-codex",body:"RETAINED_QUIET_COPY",conversationId:"siblings-finished:note"});
  const consumed: string[] = [], errors: unknown[] = [];
  let idleReports = 0;
  native.on("message", async (event:any) => {
    if(event.event === "thread/status") { idleReports++; return; }
    if(event.event !== "turn/started") return;
    try { expect(event.thread).toBe("native-thread"); expect(event.message).toContain("new message(s)"); const result:any=await call("inbox"); consumed.push(result.content[0].text); native!.send({event:"turn/completed"}); } catch(error) { errors.push(error); }
  });
  await sender.send({to:"*",body:"BROADCAST_NATIVE_PROOF"});
  await until(()=>idleReports===1 || errors.length>0);
  expect(errors).toEqual([]); expect(consumed[0]).toContain("BROADCAST_NATIVE_PROOF");
  expect(consumed[0]).not.toContain("RETAINED_QUIET_COPY");
  // This host completed its queued native turn without bridge activity hooks, as in the live incident.
  await sender.send({to:"idle-codex",body:"DIRECT_NATIVE_PROOF"});
  await until(()=>idleReports===2 || errors.length>0);
  expect(errors).toEqual([]); expect(consumed[1]).toContain("DIRECT_NATIVE_PROOF");
  expect(consumed[1]).not.toContain("BROADCAST_NATIVE_PROOF");
  const retained:any = await call("inbox", {include_quiet:true,mark_read:false});
  expect(retained.content[0].text).toContain("0 actionable message(s), 1 retained quiet");
  expect(retained.content[0].text).toContain("RETAINED_QUIET_COPY");
  expect(retained.content[0].text).not.toContain("new message(s)");
});
