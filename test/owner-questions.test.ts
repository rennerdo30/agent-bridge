import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/core/client.js";
import { PROTOCOL_VERSION } from "../src/core/constants.js";
import { nullLogger } from "../src/core/logger.js";
import { OwnerQuestionStore, QUESTIONS_FILE, askOwnerSchema, readOwnerQuestions, questionAlertChannel, type AskOwnerArgs } from "../src/core/owner-questions.js";
import { OwnerQuestionService, OWNER_ADDRESS } from "../src/core/owner-question-service.js";
import { MessageStore, SQLITE_STORE_VERSION } from "../src/core/store.js";
import { recordStorePeer } from "../src/core/store-compatibility.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { startUi } from "../src/cli/ui.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { notifyOwnerQuestion } from "../src/core/notifications.js";
import { loadConfig } from "../src/core/config.js";

let env: TestEnv;
const closers: (() => void | Promise<void>)[]=[];
beforeEach(() => { env=makeEnv(); });
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await env.cleanup(); });
export function question(topic="release"): AskOwnerArgs { return { topic,title:"Which release scope?",context:"Owner chooses scope.",options:[{id:"small",label:"Small scope",consequence:"Ships sooner",recommended:true},{id:"large",label:"Large scope",consequence:"Ships later",recommended:false}],blocking:true,blocks:"Release scope",meanwhile:"Run independent checks" }; }
const asker={session:"codex-app",sessionId:"thread",agent:"codex" as const,main:"claude-main"};
function store() { const s=new OwnerQuestionStore(env.home,nullLogger); closers.push(() => s.close()); return s; }

describe("owner question registry",() => {
  it("merges project + issue + topic with several askers and enforces the per-session cap",() => {
    const s=store(),first=s.ask(question(),env.home,asker,100);
    const merged=s.ask({...question(),affectedProjects:["second project"]},env.home,{...asker,session:"claude-other",sessionId:"thread-other"},101);
    expect(merged.merged).toBe(true); expect(merged.question.id).toBe(first.question.id); expect(merged.question.askers).toHaveLength(2);
    expect(merged.question.affectedProjects).toContain("second project");
    expect(s.ask({...question(),links:[{kind:"issue",value:"AB-159"}]},env.home,asker,102).similar).toContain(first.question.id);
    for (const topic of ["a","b","c"]) s.ask(question(topic),env.home,asker,100);
    expect(() => s.ask(question("d"),env.home,asker,100)).toThrow("At most 5");
    expect(() => s.ask(question("renamed"),env.home,{...asker,session:"renamed-session"},100)).toThrow("At most 5");
    expect(() => s.ask({...question(),options:[{id:"x",label:"X",consequence:"X",recommended:true},{id:"y",label:"Y",consequence:"Y",recommended:false}]},env.home,asker)).toThrow("different terms");
  });
  it("never expires a question and stores exact owner text durably with one answer",() => {
    const s=store(),q=s.ask(question(),env.home,asker,1).question;
    expect(s.get(q.id)?.status).toBe("open");
    const text="  Keep this exact text.\n猫 🐈  ";
    expect(s.answer(q.id,{text},OWNER_ADDRESS,200).answer).toMatchObject({text,author:OWNER_ADDRESS,at:200,source:"owner"});
    expect(() => s.answer(q.id,{option:"large"},OWNER_ADDRESS)).toThrow("no longer open");
    expect(readOwnerQuestions(env.home)[0]?.answer?.text).toBe(text);
  });
  it("caps a renamed session before its native session id is known",() => {
    const s=store(),identity={...asker,sessionId:null,peerId:"original-peer"};
    for (let i=0;i<5;i++) s.ask(question("unknown-"+i),env.home,identity);
    expect(() => s.ask(question("overflow"),env.home,{...identity,session:"renamed-main"})).toThrow("At most 5");
  });
  it("retains every linked job when the same main merges a question",() => {
    const s=store();
    const first=s.ask({...question(),job:"codex-job-first"},env.home,{...asker,job:"codex-job-first"});
    const merged=s.ask({...question(),job:"codex-job-second"},env.home,{...asker,job:"codex-job-second"});
    expect(merged.question.id).toBe(first.question.id);
    expect(merged.question.askers.map(a => a.job)).toEqual(["codex-job-first","codex-job-second"]);
  });
  it("requires concrete evidence and forbids destructive blocking and authorization defaults",() => {
    expect(askOwnerSchema.safeParse({...question(),destructive:true,default:{option:"small",deadline:100}}).success).toBe(false);
    expect(askOwnerSchema.safeParse({...question(),authorization:true}).success).toBe(false);
    expect(askOwnerSchema.safeParse({...question(),authorization:true,links:[{kind:"diff",value:"review.patch"}],default:{option:"small",deadline:100}}).success).toBe(false);
    expect(askOwnerSchema.safeParse({...question(),authorization:true,links:[{kind:"artifact",value:"candidate.zip"}]}).success).toBe(true);
  });
  it("closes only with an explicit reason or real replacement and applies declared safe defaults",() => {
    const s=store(),q=s.ask({...question(),default:{option:"small",deadline:200}},env.home,asker,100).question;
    expect(() => s.answer(q.id,{option:"small"},OWNER_ADDRESS,199,"declared-default")).toThrow("Default cannot apply");
    expect(s.answer(q.id,{option:"small"},OWNER_ADDRESS,200,"declared-default").answer?.source).toBe("declared-default");
    const old=s.ask(question("old"),env.home,asker).question,newer=s.ask(question("new"),env.home,asker).question;
    expect(() => s.dismiss(old.id,"cancelled","")).toThrow("reason");
    expect(s.dismiss(old.id,"superseded","Revised scope",newer.id)).toMatchObject({status:"superseded",dismissal:{supersededBy:newer.id}});
    expect(s.dismiss(newer.id,"cancelled","No longer needed").status).toBe("cancelled");
  });
  it("backs up an earlier question extension before versioned migration",() => {
    const file=join(env.home,QUESTIONS_FILE),old=new DatabaseSync(file);
    old.exec("CREATE TABLE unknown_owner_data(body TEXT); INSERT INTO unknown_owner_data VALUES('keep me'); PRAGMA user_version=0"); old.close();
    store();
    const backup=readdirSync(env.home).find(f => f.startsWith(QUESTIONS_FILE+".backup-"))!;
    expect(backup).toBeTruthy();
    const db=new DatabaseSync(join(env.home,backup),{readOnly:true});
    expect(db.prepare("SELECT body FROM unknown_owner_data").get()?.body).toBe("keep me"); expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(0); db.close();
  });
  it("upgrades a real 0.29.17 witness without touching legacy approval data or its live reader",() => {
    const root=join(import.meta.dirname,"fixtures","owner-questions-upgrade","v0.29.17");
    for (const file of ["bridge.db","archive.db"]) copyFileSync(join(root,file),join(env.home,file));
    const legacy=new DatabaseSync(env.db); let legacyClosed=false; closers.push(() => {if (!legacyClosed) legacy.close();});
    const before=readFileSync(env.db);
    recordStorePeer(env.home,{pid:process.pid,name:"legacy-0.29.17",version:"0.29.17",storeCapabilities:{json:4,sqlite:8}});
    const s=store(); s.ask(question(),env.home,asker);
    expect(readFileSync(env.db)).toEqual(before); expect(legacy.prepare("PRAGMA user_version").get()?.user_version).toBe(8);
    expect(legacy.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBeGreaterThan(0);
    expect(s.list()).toHaveLength(1);
    const originals=legacy.prepare("SELECT * FROM messages ORDER BY id").all();
    legacy.close(); legacyClosed=true;
    if (SQLITE_STORE_VERSION > 8) expect(() => new MessageStore(env.db,nullLogger)).toThrow("Waiting to upgrade");
    recordStorePeer(env.home,{pid:process.pid,name:"current-reader",version:"current",storeCapabilities:{json:4,sqlite:SQLITE_STORE_VERSION}});
    const upgraded=new MessageStore(env.db,nullLogger); closers.push(() => upgraded.close());
    const current=new DatabaseSync(env.db,{readOnly:true});
    expect(current.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(originals); current.close();
    expect(readOwnerQuestions(env.home)[0]?.status).toBe("open");
  });
});

describe("presence alerts and waking delivery",() => {
  it("honors individual sound and toast config overrides",() => {
    writeFileSync(join(env.home,"config.json"),JSON.stringify({questionAlerts:{sound:false}}));
    expect(loadConfig(env.home,"other",nullLogger).questionAlerts).toEqual({sound:false,toast:true,reminderMinutes:15});
    writeFileSync(join(env.home,"config.json"),JSON.stringify({questionAlerts:{toast:false,reminderMinutes:0}}));
    expect(loadConfig(env.home,"other",nullLogger).questionAlerts).toEqual({sound:true,toast:false,reminderMinutes:0});
  });
  it("prefers a visible tab, retains hidden-tab presence and falls back after ten seconds",() => {
    expect(questionAlertChannel([{tab:"hidden",visible:false,at:100},{tab:"visible",visible:true,at:90}],200)).toEqual({channel:"browser",tab:"visible"});
    expect(questionAlertChannel([{tab:"hidden",visible:false,at:100}],200)).toEqual({channel:"browser",tab:"hidden"});
    expect(questionAlertChannel([{tab:"old",visible:true,at:100}],10101)).toEqual({channel:"desktop"});
    const s=store(); expect(s.claimAlert("q","browser",100,900000)).toBe(true);
    expect(s.claimAlert("q","desktop",101,900000)).toBe(false); expect(s.claimAlert("q","desktop",900100,900000)).toBe(true);
  });
  it("notifies exactly one channel, records wake/fallback/read state and indexes Q&A",async () => {
    const messages=new MessageStore(env.db,nullLogger); closers.push(() => messages.close());
    const peers:any[]=[{name:asker.session,agent:"codex",cwd:env.home,sessionId:"thread",wakeAvailable:false}, {name:asker.main,agent:"claude",cwd:env.home,projectMain:true,wakeAvailable:true,wakeOnDirect:true}];
    const emit=vi.fn(),service=new OwnerQuestionService(env.home,messages,nullLogger,() => peers,emit); closers.push(() => service.close());
    const q=service.store.ask(question(),env.home,asker).question;
    service.heartbeat("tab",true); (service as any).tick();
    expect(service.heartbeat("tab",true).alerts).toHaveLength(1); (service as any).tick(); expect(service.heartbeat("tab",true).alerts).toHaveLength(0);
    expect(notifyOwnerQuestion).not.toHaveBeenCalled();
    const answered=service.complete(service.store.answer(q.id,{text:"Choose compact shipping",pin:{topic:"release",scope:{project:env.home}}},OWNER_ADDRESS));
    expect(emit).toHaveBeenCalledTimes(2); expect(emit.mock.calls[0]?.[1]).toMatchObject({replyTo:q.id,hop:0});
    expect(answered.deliveries.map(d => d.state)).toEqual(["wake-unavailable","wake-requested"]);
    expect(messages.decisions.list()[0]?.sourceMessageId).toBe(q.id);
    service.complete(service.store.get(q.id)!); expect(emit).toHaveBeenCalledTimes(2); expect(messages.decisions.list({history:true})).toHaveLength(1);
    const d=answered.deliveries[1]!; messages.markRead(d.recipient,[d.messageId!],1234); expect(service.list()[0]?.deliveries[1]?.readAt).toBe(1234);
    peers.push({...peers[1],name:"new-main"}); peers[1].projectMain=false;
    service.complete(service.store.get(q.id)!); expect(emit).toHaveBeenCalledTimes(2);
    expect(service.store.get(q.id)?.deliveryComplete).toBe(true);
    const closedBeforeHeartbeat=service.store.ask(question("stale-alert"),env.home,asker).question;
    (service as any).tick(); service.store.dismiss(closedBeforeHeartbeat.id,"cancelled","No longer needed");
    expect(service.heartbeat("tab",true).alerts).toEqual([]);
    messages.history.tick(); expect(messages.history.search({query:"compact shipping",filters:{kind:"question"}}).hits[0]?.link).toContain(q.id);
  });
  it("mirrors exact answers once and recovers an unconfirmed prior comment without duplicates",async () => {
    const messages=new MessageStore(env.db,nullLogger); closers.push(() => messages.close());
    const service=new OwnerQuestionService(env.home,messages,nullLogger,() => [],vi.fn()); closers.push(() => service.close());
    const q=service.store.ask({...question(),links:[{kind:"issue",value:"AB-159"}]},env.home,asker).question;
    const fetch=vi.fn().mockResolvedValueOnce({ok:true,json:async () => ({comments:[]})}).mockResolvedValueOnce({ok:true}); vi.stubGlobal("fetch",fetch);
    service.complete(service.store.answer(q.id,{text:"Exact owner rule\n猫"},OWNER_ADDRESS));
    await until(() => service.store.get(q.id)?.mirror?.state === "saved");
    expect(fetch).toHaveBeenCalledTimes(2); expect(JSON.parse(fetch.mock.calls[1]![1].body).text).toContain("Exact owner rule\n猫");
    service.complete(service.store.get(q.id)!); expect(fetch).toHaveBeenCalledTimes(2);
    const recovered=service.store.get(q.id)!; recovered.mirror={state:"pending"}; service.store.save(recovered);
    fetch.mockResolvedValueOnce({ok:true,json:async () => ({comments:[{text:`**Owner answer recorded (${q.id}).**`}]})});
    service.complete(recovered); await until(() => service.store.get(q.id)?.mirror?.state === "saved"); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each([asker,{...asker,sessionId:null,peerId:"original-peer"}])("does not wake a replacement which inherited the asker name, and routes renamed sessions by identity (%j)",identity => {
    const messages=new MessageStore(env.db,nullLogger); closers.push(() => messages.close());
    const peers:any[]=[{id:"replacement-peer",name:asker.session,sessionId:identity.sessionId ? "replacement" : null,cwd:env.home,agent:"codex"},{name:asker.main,cwd:env.home,agent:"claude",projectMain:true,wakeAvailable:true,wakeOnDirect:true}];
    const emit=vi.fn(),service=new OwnerQuestionService(env.home,messages,nullLogger,() => peers,emit); closers.push(() => service.close());
    const q=service.store.ask(question(),env.home,identity).question;
    service.complete(service.store.answer(q.id,{text:"Keep the original scope"},OWNER_ADDRESS));
    expect(emit).toHaveBeenCalledTimes(1); expect(emit.mock.calls[0]?.[0].name).toBe(asker.main); expect(messages.unread(asker.session,50)).toEqual([]);
    peers.push({...peers[0],id:"original-peer",name:"renamed-asker",sessionId:identity.sessionId});
    service.complete(service.store.get(q.id)!); expect(emit).toHaveBeenCalledTimes(2); expect(emit.mock.calls[1]?.[0].name).toBe("renamed-asker");
  });
  it("explicitly falls back to the new responsible main even when it reuses the old main's name",() => {
    const messages=new MessageStore(env.db,nullLogger); closers.push(() => messages.close());
    const replacement:any={id:"new-main",name:asker.session,sessionId:"new-thread",cwd:env.home,agent:"codex",projectMain:true,wakeAvailable:true,wakeOnDirect:true};
    const emit=vi.fn(),service=new OwnerQuestionService(env.home,messages,nullLogger,() => [replacement],emit); closers.push(() => service.close());
    const q=service.store.ask(question(),env.home,{...asker,peerId:"old-main",main:asker.session,mainSessionId:asker.sessionId,mainPeerId:"old-main"}).question;
    const answered=service.complete(service.store.answer(q.id,{text:"Keep this scope"},OWNER_ADDRESS));
    expect(emit).toHaveBeenCalledTimes(1); expect(emit.mock.calls[0]?.[0]).toBe(replacement);
    expect(answered.deliveries[0]).toMatchObject({state:"wake-requested",detail:expect.stringContaining("current project main as fallback")});
  });
});

describe("owner dashboard API",() => {
  it("rejects delegated filers and questions for another project",async () => {
    const node=env.node("codex-main","codex"); await node.start();
    await expect(node.askOwner({...question(),project:join(env.home,"foreign-project")})).rejects.toThrow("own project");
    for (const delegated of [{jobAgent:"codex" as const},{subagent:true}]) {
      const client=await BridgeClient.connect(env.pipe,nullLogger); closers.push(() => client.close());
      await client.request("hello",{protocol:PROTOCOL_VERSION,token:loadOrCreateToken(env.home),peer:{id:JSON.stringify(delegated),name:delegated.subagent ? "native-child" : "job-child",agent:"codex",cwd:env.home,pid:process.pid,agentPid:null,sessionId:null,startedAt:Date.now(),autoWake:false,...delegated}});
      await expect(client.request("askOwner",question())).rejects.toThrow("Delegated jobs ask their main");
    }
    expect(readOwnerQuestions(env.home)).toEqual([]);
  });
  it("answers from the authenticated dashboard, rejects permission-shaped answers and model answers",async () => {
    const node=env.node("codex-app","codex"); await node.start();
    const q=(await node.askOwner(question())).question;
    const ui=await startUi({home:env.home,pipe:env.pipe,port:0,log:nullLogger}); closers.push(ui.close);
    const base=ui.url.split("/?")[0]!,first=await fetch(ui.url,{redirect:"manual"});
    const cookie=first.headers.get("set-cookie")!.split(";")[0]!,headers={cookie,"content-type":"application/json","x-agent-bridge":"1"};
    const pending=await (await fetch(base+"/api/approvals",{headers})).json() as any;
    expect(pending.approvals[0]).toMatchObject({kind:"question",id:q.id});
    expect((await fetch(base+"/api/questions/"+q.id,{method:"POST",headers,body:JSON.stringify({decision:"allow"})})).status).toBe(400);
    const client=await BridgeClient.connect(env.pipe,nullLogger); closers.push(() => client.close());
    await client.request("hello",{protocol:PROTOCOL_VERSION,token:loadOrCreateToken(env.home),peer:{id:"model",name:"model",agent:"codex",cwd:env.home,pid:process.pid,agentPid:null,sessionId:null,startedAt:Date.now(),autoWake:false}});
    await expect(client.request("answerOwner",{id:q.id,answer:{text:"spoof"}})).rejects.toThrow("Only the local owner");
    const response=await fetch(base+"/api/questions/"+q.id,{method:"POST",headers,body:JSON.stringify({option:"small"})}); expect(response.status).toBe(200);
    await until(() => node.unread().some(m => m.replyTo === q.id));
    expect((await response.json() as any).answer.text).toBe("Small scope");
    expect((await fetch(base+"/api/approvals/"+q.id,{method:"POST",headers,body:JSON.stringify({decision:"allow"})})).status).toBe(409);
  });
});
