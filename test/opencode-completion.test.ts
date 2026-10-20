import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { delegateToOpencode, parseOpencodeJsonl, pidAlive } from "../src/core/delegate.js";
import { delegateToOpencodeServed } from "../src/core/opencode-served.js";
import { nullLogger } from "../src/core/logger.js";

const dirs: string[] = [];
// Source-grounded v2.0.26 replay: noninteractive.ts reconcile() lines 544-650 writes
// projected text after session.wait() wins (732-735); it does not synthesize step_finish.
// https://github.com/anomalyco/opencode/blob/v2.0.26/packages/cli/src/run/noninteractive.ts
const reconciledV2Text = {
  type: "text", timestamp: 1792500000020, sessionID: "session",
  part: { id: "prt_current_text-0", sessionID: "session", messageID: "msg_current", type: "text",
    text: "Final answer", time: { start: 1792500000000, end: 1792500000020 } },
};
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
  if(version===2){console.log(JSON.stringify(${JSON.stringify(reconciledV2Text)}));clearTimeout(timer);return}
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
     else {
      if(scenario!=='reconciled')emit('session.step.ended',{sessionID:'session',assistantMessageID:'current',finish});
      emit('session.execution.succeeded',{sessionID:'session'});
     }
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

// V2 protocol replay: noninteractive.ts:141-233 handles descendant asks and nested forms
// before filtering root output. Cancellation is DELETE with query.message, not a JSON body:
// https://github.com/anomalyco/opencode/blob/v2.0.26/packages/protocol/src/groups/session.ts#L856
function controlFixture(kind: "form" | "permission", owner: string, outcome = "answer") {
  const req = fixture(2, "controls");
  writeFileSync(join(req.cwd, "calls.jsonl"), "");
  writeFileSync(join(req.cwd, "fake.mjs"), `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';import {createServer} from 'node:http';
appendFileSync(new URL('pids',import.meta.url),process.pid+'\\n');
if(process.argv[2]==='--version'){console.log('opencode v2.0.26');process.exit(0)}
const kind=${JSON.stringify(kind)},owner=${JSON.stringify(owner)},outcome=${JSON.stringify(outcome)};
let stream,watchdog;
const record=value=>appendFileSync(new URL('calls.jsonl',import.meta.url),JSON.stringify(value)+'\\n');
const emit=(type,data)=>stream.write('data: '+JSON.stringify({type,data})+'\\n\\n');
const finish=()=>{
 clearTimeout(watchdog);
 // Child terminal/text events never settle or contaminate the root result.
 emit('session.text.ended',{sessionID:'grandchild',assistantMessageID:'child-answer',ordinal:0,text:'WRONG CHILD ANSWER'});
 emit('session.execution.succeeded',{sessionID:'grandchild'});
 if(outcome!=='no-final')emit('session.text.ended',{sessionID:'session',assistantMessageID:'final',ordinal:0,text:'Root fallback answer'});
 emit('session.execution.succeeded',{sessionID:'session'});
};
const ask=(type,sessionID,id)=>emit(type==='form'?'form.created':'permission.asked',type==='form'
 ?{form:{id,sessionID,title:'Question',fields:[],metadata:{kind:outcome==='non-question'?'elicitation':'question'}}}
 :{id,sessionID,action:'bash',resources:['echo child']});
const server=createServer(async(request,response)=>{
 const url=new URL(request.url,'http://fixture'),path=url.pathname;
 let text='';for await(const chunk of request)text+=chunk;
 record({method:request.method,path,query:Object.fromEntries(url.searchParams),body:text?JSON.parse(text):null});
 if(path==='/api/event'){stream=response;response.writeHead(200,{'content-type':'text/event-stream'});response.write(': connected\\n\\n');return}
 let result={};
 if(path==='/api/session')result={id:'session'};
 if(request.method==='GET'&&/^\\/api\\/session\\/[^/]+$/.test(path)){
  const id=decodeURIComponent(path.split('/').pop());
  if(id==='unknown'){response.writeHead(404);response.end('{}');return}
  const parentID=id==='child'?'session':id==='grandchild'?'child':id==='unrelated'?'elsewhere':id==='cycle-a'?'cycle-b':id==='cycle-b'?'cycle-a':id.startsWith('deep')?(Number(id.slice(4))>=80?'session':'deep'+(Number(id.slice(4))+1)):undefined;
  result={id:id==='mismatch'?'child':id,...(parentID?{parentID}:{})};
 }
 if(path.endsWith('/prompt'))setTimeout(()=>{
  emit('session.text.ended',{sessionID:'session',assistantMessageID:'progress',ordinal:0,text:'Working on it'});
  for(const foreign of ['unrelated','unknown','mismatch','cycle-a','deep0','global']){
   ask('form',foreign,'foreign-form');ask('permission',foreign,'foreign-permission');
  }
  ask(kind,owner,'owned');
  watchdog=setTimeout(()=>emit('session.execution.failed',{sessionID:'session',error:{message:'fixture control request was not settled'}}),1500);
 },5);
 if(request.method==='DELETE'||path.endsWith('/reply')){
  const expected='/api/session/'+owner+(kind==='form'?'/form/owned':'/permission/owned/reply');
  if(path!==expected){response.writeHead(400);response.end('{}');return}
  if(kind==='form'&&outcome==='cancel-error'){response.writeHead(500);response.end('{}');return}
  if(kind==='form'&&outcome==='settled'){
   response.writeHead(409);response.end(JSON.stringify({_tag:'FormAlreadySettledError',id:'owned',message:'already answered'}));
  }else{response.writeHead(204);response.end()}
  setTimeout(finish,5);return;
 }
 response.end(JSON.stringify({data:result}));
});
server.listen(0,'127.0.0.1',()=>console.log('listening on http://127.0.0.1:'+server.address().port));
setTimeout(()=>process.exit(2),8000);
`);
  return { ...req, calls: () => readFileSync(join(req.cwd, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

for (const sessionId of [undefined, "session"]) {
  for (const owner of ["session", "grandchild"]) {
    it(`cancels owned ${owner} question forms with feedback (${sessionId ? "resumed" : "initial"})`, async () => {
      const req = controlFixture("form", owner);
      expect(await delegateToOpencode({ ...req, autoApprove: true, sessionId })).toMatchObject({ text: "Root fallback answer", isError: false });
      const controls = req.calls().filter(c => c.method === "DELETE" || c.path.endsWith("/reply"));
      expect(controls).toEqual([{ method: "DELETE", path: `/api/session/${owner}/form/owned`,
        query: { message: expect.stringMatching(/cannot.*question/i) }, body: null }]);
      const lookups = req.calls().filter(c => c.method === "GET" && c.path.startsWith("/api/session/"));
      expect(lookups.filter(c => /\/deep\d+$/.test(c.path)).length).toBeLessThan(80);
      expect(lookups.filter(c => c.path.endsWith("/cycle-a"))).toHaveLength(1);
    });
  }
  for (const autoApprove of [true, false]) {
    it(`binds native child permission ${autoApprove ? "allow" : "deny"} to its owner (${sessionId ? "resumed" : "initial"})`, async () => {
      const req = controlFixture("permission", "grandchild");
      expect(await delegateToOpencode({ ...req, autoApprove, sessionId })).toMatchObject({ text: "Root fallback answer", isError: false });
      expect(req.calls().filter(c => c.method === "DELETE" || c.path.endsWith("/reply"))).toEqual([
        { method: "POST", path: "/api/session/grandchild/permission/owned/reply", query: {},
          body: autoApprove ? { decision: "once" } : { decision: "reject", message: "This delegated run cannot request approval." } },
      ]);
    });
  }
}

it("relays owned child permissions through the existing approval callback only", async () => {
  const req = controlFixture("permission", "child");
  const questions: string[] = [];
  expect(await delegateToOpencodeServed({ ...req, onPermission: async r => {
    questions.push(r.tool);return { allow: false, message: "Supervisor declined child shell" };
  } })).toMatchObject({ text: "Root fallback answer", isError: false });
  expect(questions).toEqual(["bash"]);
  expect(req.calls().find(c => c.path.endsWith("/reply"))).toMatchObject({
    path: "/api/session/child/permission/owned/reply", body: { decision: "reject", message: "Supervisor declined child shell" },
  });
});

for (const outcome of ["settled", "non-question", "no-final", "cancel-error"]) {
  it(`settles owned form ${outcome} honestly`, async () => {
    const req = controlFixture("form", "child", outcome);
    const result = await delegateToOpencode({ ...req, autoApprove: true }).catch(error => error);
    if (outcome === "settled") expect(result).toMatchObject({ text: "Root fallback answer", isError: false });
    else expect(result.name === "DelegateError" ? result.kind === "failed" : result.isError).toBe(true);
    const controls = req.calls().filter(c => c.method === "DELETE" || c.path.endsWith("/reply"));
    expect(controls).toHaveLength(1);
    expect(controls[0].path).toBe("/api/session/child/form/owned");
    expect(controls[0].query).toEqual(outcome === "non-question" ? {} : { message: expect.any(String) });
  });
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

it("does not treat a V2 reconciliation-shaped CLI text event as terminal proof", () => {
  // Identical JSON is possible when output is truncated. Neither the projected id,
  // text end time nor exit code can prove the execution outcome on their own.
  expect(parseOpencodeJsonl(JSON.stringify(reconciledV2Text))).toMatchObject({
    sessionId: "session", text: "Final answer", error: expect.stringContaining("finish: missing"),
  });
});

for (const sessionId of [undefined, "session"]) {
  const turn = sessionId ? "resumed" : "initial";
  for (const scenario of ["reconciled", "empty", "rejected", "truncated", "stale", "length", "recovered"]) {
    it(`settles ${turn} V2 ${scenario} using execution evidence instead of reconciled CLI text`, async () => {
      const req = fixture(2, scenario);
      const result = await delegateToOpencode({ ...req, autoApprove: false, sessionId }).catch(error => error);
      if (scenario === "reconciled" || scenario === "recovered") expect(result).toMatchObject({ sessionId: "session", isError: false, text: expect.stringContaining("answer") });
      else expect(result.name === "DelegateError" ? result.kind === "failed" : result.isError).toBe(true);
      expect(JSON.parse(readFileSync(join(req.cwd, "args.json"), "utf8"))[0]).toBe("serve");
      expect(JSON.parse(readFileSync(join(req.cwd, "config.json"), "utf8"))).toMatchObject({
        permission: { bash: "deny", edit: "deny" }, tools: { "*_*": false, bridge_send: true },
      });
    });
  }
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
