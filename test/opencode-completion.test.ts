import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { delegateToOpencode, parseOpencodeJsonl, pidAlive } from "../src/core/delegate.js";
import { delegateToOpencodeServed } from "../src/core/opencode-served.js";
import { nullLogger } from "../src/core/logger.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    const pids = readFileSync(join(dir, "pids"), "utf8").trim().split("\n").map(Number);
    for (const pid of pids) expect(pidAlive(pid)).toBe(false);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function fixture(version: 1 | 2, scenario: string) {
  mkdirSync(process.env.AGENT_BRIDGE_TEST_ROOT!, { recursive: true });
  const cwd = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "opencode-completion-"));
  dirs.push(cwd);
  writeFileSync(join(cwd, "pids"), "");
  const script = join(cwd, "fake.mjs");
  writeFileSync(script, `#!/usr/bin/env node
import {appendFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
appendFileSync(new URL('pids', import.meta.url), process.pid+'\\n');
const scenario=${JSON.stringify(scenario)}, version=${version};
const timer=setTimeout(()=>process.exit(2), 8000);
if(process.argv[2]==='--version'){console.log('opencode v'+(version===1?'1.19.3':'2.0.26'));process.exit(0)}
writeFileSync(new URL('config.json', import.meta.url), process.env.OPENCODE_CONFIG_CONTENT || 'null');
writeFileSync(new URL('args.json', import.meta.url), JSON.stringify(process.argv.slice(2)));
const rejected='The user rejected permission to use this specific tool call.';
const text={type:'text',messageID:'current',text:'I will inspect the files.'};
const tool={type:'tool',messageID:'current',state:{status:'error',error:rejected}};
const parts=scenario==='empty'?[]:scenario==='rejected'?[text,tool]:[{...text,text:'Final answer'}];
const finish=scenario==='rejected'?'tool-calls':scenario==='length'?'length':'stop';
if(process.argv[2]==='run'){
 process.stdin.resume();process.stdin.on('end',()=>{
  for(const part of parts) console.log(JSON.stringify({type:part.type==='tool'?'tool_use':'text',sessionID:'session',part}));
  if(scenario!=='truncated')console.log(JSON.stringify({type:'step_finish',sessionID:'session',part:{messageID:'current',reason:finish}}));
  clearTimeout(timer);
 });
}else{
 let stream, prompted=false;
 const emit=(type,p)=>stream.write('data: '+JSON.stringify(version===1?{type,properties:p}:{type,data:p})+'\\n\\n');
 const old={info:{id:'old',role:'assistant',finish:'stop'},parts:[{type:'text',text:'Old answer'}]};
 const server=createServer(async(req,res)=>{
  const path=req.url.split('?')[0].replace(/^\\/api/,'');
  if(path==='/event'){stream=res;res.writeHead(200,{'content-type':'text/event-stream'});res.write(': connected\\n\\n');return}
  let body='';for await(const chunk of req)body+=chunk;
  let result={};
  if(path==='/session')result={id:'session'};
  if(path==='/mcp')result=[];
  if(path==='/session/session/message') result=!prompted||scenario==='stale'?[old]:[old,{info:{id:'current',role:'assistant',finish},parts}];
  if(path.endsWith('/prompt')||path.endsWith('/prompt_async')){
   prompted=true;
   setTimeout(()=>{
    if(version===1){
     if(scenario==='truncated')stream.end();else emit('session.idle',{sessionID:'session'});
    }else{
     if(scenario!=='empty'&&scenario!=='stale')emit('session.text.ended',{sessionID:'session',assistantMessageID:'current',ordinal:0,text:scenario==='rejected'?'I will inspect the files.':'Final answer'});
     if(scenario==='rejected'||scenario==='recovered')emit('permission.asked',{sessionID:'session',id:'permission',action:'bash',resources:['ls']});
     else if(scenario==='truncated')stream.end();
     else {emit('session.step.ended',{sessionID:'session',assistantMessageID:'current',reason:finish});emit('session.execution.succeeded',{sessionID:'session'});}
    }
   },5);
  }
  if(path.endsWith('/reply')){
   writeFileSync(new URL('reply.json',import.meta.url),body);
   setTimeout(()=>{
    if(scenario==='recovered')emit('session.text.ended',{sessionID:'session',assistantMessageID:'final',ordinal:0,text:'Read-only fallback answer'});
    emit('session.execution.succeeded',{sessionID:'session'});
   },5);
  }
  res.end(JSON.stringify(version===1?result:{data:result}));
 });
 server.listen(0,'127.0.0.1',()=>console.log('listening on http://127.0.0.1:'+server.address().port));
}
`);
  const bin = process.platform === "win32" ? join(cwd, "opencode.cmd") : script;
  if (process.platform === "win32") writeFileSync(bin, '@ECHO off\r\n"%dp0%\\fake.mjs" %*\r\n');
  else chmodSync(script, 0o755);
  return { bin, cwd, prompt: "task", timeoutSec: 5, log: nullLogger };
}

it("does not reuse progress text when a later tool-only message is rejected", () => {
  const out = [
    { type: "text", sessionID: "session", part: { messageID: "progress", text: "Working" } },
    { type: "tool_use", sessionID: "session", part: { type: "tool", messageID: "tool", state: { status: "error", error: "permission rejected" } } },
    { type: "step_finish", sessionID: "session", part: { messageID: "tool", reason: "tool-calls" } },
  ].map(e => JSON.stringify(e)).join("\n");
  expect(parseOpencodeJsonl(out)).toMatchObject({ text: "", error: "permission rejected" });
  const final = { type: "text", sessionID: "session", part: { messageID: "final", text: "Fallback answer" } };
  const stop = { type: "step_finish", sessionID: "session", part: { messageID: "final", reason: "stop" } };
  expect(parseOpencodeJsonl(out + "\n" + JSON.stringify(final) + "\n" + JSON.stringify(stop))).toMatchObject({ text: "Fallback answer", error: null });
});

it("preserves auto-approved CLI edits and served editable configuration", async () => {
  const cli = fixture(1, "success");
  expect(await delegateToOpencode({ ...cli, autoApprove: true })).toMatchObject({ isError: false });
  expect(JSON.parse(readFileSync(join(cli.cwd, "config.json"), "utf8"))).toBeNull();
  expect(JSON.parse(readFileSync(join(cli.cwd, "args.json"), "utf8"))).toContain("--auto");
  const served = fixture(2, "success");
  expect(await delegateToOpencodeServed({ ...served, permissions: null, onPermission: async () => ({ allow: true }) })).toMatchObject({ isError: false });
  expect(JSON.parse(readFileSync(join(served.cwd, "config.json"), "utf8"))).toBeNull();
});

for (const sessionId of [undefined, "session"]) {
  const turn = sessionId ? "resumed" : "initial";
  for (const scenario of ["empty", "rejected", "truncated", "length", "success"]) {
    it(`classifies ${turn} CLI ${scenario} replies and enforces deny`, async () => {
      const req = fixture(1, scenario);
      const result = await delegateToOpencode({ ...req, autoApprove: false, sessionId }).catch(error => error);
      if (scenario === "success") expect(result).toMatchObject({ text: "Final answer", isError: false });
      else if (scenario === "empty") expect(result).toMatchObject({ name: "DelegateError", kind: "failed", sessionId: "session" });
      else expect(result).toMatchObject({ isError: true, details: { error: expect.any(String) } });
      expect(JSON.parse(readFileSync(join(req.cwd, "config.json"), "utf8"))).toMatchObject({ permission: { bash: "deny", edit: "deny" } });
    });
  }
  for (const version of [1, 2] as const) {
    for (const scenario of ["empty", "rejected", "truncated", "stale", "length", "success", ...(version === 2 ? ["recovered"] : [])]) {
      it(`classifies ${turn} served V${version} ${scenario} replies`, async () => {
        const req = fixture(version, scenario);
        const result = await delegateToOpencodeServed({ ...req, sessionId,
          onPermission: async () => ({ allow: false, message: "Supervisor declined" }),
        }).catch(error => error);
        if (scenario === "success" || scenario === "recovered") expect(result).toMatchObject({ isError: false, text: expect.stringContaining("answer") });
        else expect(result.name === "DelegateError" ? result.kind === "failed" : result.isError).toBe(true);
        expect(JSON.parse(readFileSync(join(req.cwd, "config.json"), "utf8"))).toMatchObject({ permission: { bash: "ask", edit: "ask" } });
        if (scenario === "rejected" && version === 2) expect(JSON.parse(readFileSync(join(req.cwd, "reply.json"), "utf8"))).toEqual({ decision: "reject", message: "Supervisor declined" });
      });
    }
  }
}
