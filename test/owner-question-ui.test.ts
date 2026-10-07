import { describe, expect, it, vi } from "vitest";
import { UI_PAGE } from "../src/cli/ui-page.js";
import { questionNotificationCommands } from "../src/core/notifications.js";

const script=UI_PAGE.split("<script>").pop()!.split("</script>")[0]!;
const q={id:"12345678-1234-4123-a123-123456789012",kind:"question",status:"open",project:"/project",title:"<Choose scope>",context:"Two approaches",topic:"scope",blocking:true,blocks:"Publish",meanwhile:"Run tests",options:[{id:"small",label:"Small",consequence:"Ships early",recommended:true},{id:"large",label:"Large",consequence:"Ships later",recommended:false}],links:[],askers:[{session:"asker"}],affectedProjects:["/project"],deliveries:[]};
function page() {
  const elements=new Map<string,any>();
  const el=(id:string):any => { if (!elements.has(id)) elements.set(id,{dataset:{},value:"",checked:false,innerHTML:"",textContent:"",focus:vi.fn(),scrollIntoView:vi.fn(),querySelectorAll:() => [],querySelector:() => null,
    classList:{toggle:vi.fn(),add:vi.fn(),remove:vi.fn(),contains:() => false},setAttribute:vi.fn(),parentElement:{addEventListener:vi.fn()},addEventListener:vi.fn()}); return elements.get(id); };
  const listeners=new Map<string,Function>(),document={hidden:false,title:"",documentElement:{dataset:{}},getElementById:el,addEventListener:(name:string,fn:Function) => listeners.set(name,fn),querySelectorAll:() => []};
  const fetch=vi.fn(() => new Promise(() => {}));
  const starts=vi.fn(),gain={gain:{setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn(),exponentialRampToValueAtTime:vi.fn()},connect:vi.fn()};
  const audio={state:"running",currentTime:1,resume:vi.fn(async () => {}),createOscillator:() => ({type:"",frequency:{value:0},connect:vi.fn(),start:starts,stop:vi.fn()}),createGain:() => gain};
  const notification=Object.assign(vi.fn(function(this:any) { this.close=vi.fn(); }),{permission:"granted"});
  const api=new Function("document","window","location","localStorage","setInterval","fetch","Notification",script+"\nreturn { questionCard,answerQuestion,questionChime,questionHeartbeat,resetHeartbeat:() => qHeartbeatBusy=false,setQuestions:qs => { approvals=qs; },setDraft:(k,v) => apDrafts.set(k,v),setAudio:(a) => qAudio=a,setSettings:s => qSettings=s,setModel:() => model={groups:new Map(),sessions:[],byName:new Map()} };")
    (document,{addEventListener:vi.fn()},{hash:""},{getItem:() => null,setItem:vi.fn(),removeItem:vi.fn()},() => 0,fetch,notification);
  return {...api,fetch,el,document,audio,starts,notification};
}
describe("owner question presentation",() => {
  it("parses all page scripts and labels one-click options distinctly from permissions",() => {
    for (const source of UI_PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Function(source[1]!)).not.toThrow();
    const p=page(),html=p.questionCard(q);
    expect(html).toContain("OWNER QUESTION"); expect(html).toContain("&lt;Choose scope&gt;"); expect(html).toContain('data-q-option="small"'); expect(html).toContain("Recommended");
    expect(html).not.toContain("data-ap-act"); expect(html).toContain("This is a lasting rule");
  });
  it("sends a recommended option in one call, with pinning only when selected",async () => {
    const p=page(); p.setQuestions([q]);
    p.fetch.mockResolvedValueOnce({ok:true,json:async () => ({answer:{text:"Small"}})}).mockResolvedValueOnce({ok:true,json:async () => ({approvals:[],questions:[{...q,status:"answered"}]})});
    await p.answerQuestion(q.id,"small",false);
    const call=p.fetch.mock.calls.find((c:any) => c[0] === "/api/questions/"+q.id) as any;
    expect(JSON.parse(call[1].body)).toEqual({option:"small"});
  });
  it("plays a short generated chime only when sound is enabled and audio unlocked",() => {
    const p=page(); p.setAudio(p.audio); p.questionChime(); expect(p.starts).toHaveBeenCalledTimes(2);
    p.setSettings({sound:false}); p.questionChime(); expect(p.starts).toHaveBeenCalledTimes(2);
  });
  it("respects hidden-tab toast settings and consumes each alert only once",async () => {
    const p=page(); p.document.hidden=true; p.setQuestions([q]); p.setAudio(p.audio); p.resetHeartbeat();
    const heartbeat=(at:number,toast:boolean) => ({ok:true,json:async () => ({settings:{sound:true,toast,reminderMinutes:15},alerts:[{id:q.id,at}]})});
    p.fetch.mockResolvedValueOnce(heartbeat(1,false)); await p.questionHeartbeat();
    expect(p.notification).not.toHaveBeenCalled(); expect(p.document.title).toBe("(1) agent-bridge");
    p.fetch.mockResolvedValueOnce(heartbeat(2,true)); await p.questionHeartbeat();
    expect(p.notification).toHaveBeenCalledTimes(1); expect(p.notification.mock.calls[0]?.[1]).toMatchObject({silent:true});
    p.fetch.mockResolvedValueOnce(heartbeat(2,true)); await p.questionHeartbeat(); expect(p.notification).toHaveBeenCalledTimes(1);
    expect(p.starts).toHaveBeenCalledTimes(4);
  });
  it("builds a hidden actionable native toast using only a validated stable local link",() => {
    const url="http://127.0.0.1:4319/?t="+"a".repeat(48)+"#/approvals?question="+q.id;
    const command=questionNotificationCommands("win32",url)[0]!;
    const decoded=Buffer.from(command.args.at(-1)!,"base64").toString("utf16le");
    expect(decoded).toContain('activationType="protocol"'); expect(decoded).toContain(url); expect(command.args).toContain("Hidden");
    expect(decoded).toContain('ms-winsoundevent:Notification.Default');
    expect(Buffer.from(questionNotificationCommands("win32",url,false)[0]!.args.at(-1)!,"base64").toString("utf16le")).toContain('<audio silent="true"/>');
    expect(questionNotificationCommands("darwin",url,false)[0]?.args).not.toContain("-sound");
    expect(questionNotificationCommands("linux",url,false)[0]?.args).toContain("boolean:suppress-sound:true");
    expect(questionNotificationCommands("darwin",url)[0]?.args).toContain("-open"); expect(questionNotificationCommands("linux",url)[0]?.args).toContain("--action=answer=Answer");
    expect(() => questionNotificationCommands("win32",url.replace("127.0.0.1","example.com"))).toThrow("Invalid");
    expect(() => questionNotificationCommands("win32",url.replace("#/","&payload=';oops#/"))).toThrow("Invalid");
  });
});
