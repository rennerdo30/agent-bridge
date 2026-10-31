import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { makeEnv, type TestEnv } from "./helpers.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { OwnerQuestionService, OWNER_ADDRESS } from "../src/core/owner-question-service.js";
import { QUESTION_PARENT_TIMEOUT_MS } from "../src/core/question-delegation.js";
import { ownerQuestionVersion } from "../src/core/owner-questions.js";
import type { PeerInfo, BridgeMessage } from "../src/core/protocol.js";

let env: TestEnv, messages: MessageStore, service: OwnerQuestionService;
let recipient: string | undefined, peers: PeerInfo[], emit: ReturnType<typeof vi.fn<(peer: PeerInfo, message: BridgeMessage) => void>>;
const input = { topic:"scope",title:"Choose scope",context:"Review before proceeding",blocking:true,blocks:"Release",meanwhile:"Independent checks",
  options:[{id:"small",label:"Small",consequence:"Less",recommended:true},{id:"large",label:"Large",consequence:"More",recommended:false}] };
const asker = { session:"main",sessionId:"main-id",agent:"codex" as const,main:"main",job:"codex-job-one" };
function start() { return new OwnerQuestionService(env.home,messages,nullLogger,() => peers,emit,undefined,
  name => name === "codex-job-one" && recipient ? {recipient,owner:"parent"} : undefined); }
beforeEach(() => {
  env=makeEnv(); messages=new MessageStore(env.db,nullLogger); recipient="parent"; peers=[]; emit=vi.fn();
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-31T11:00:00Z")); service=start();
});
afterEach(async () => { service.close(); messages.close(); vi.useRealTimers(); await env.cleanup(); });
function ask(extra={}) { return service.store.ask({...input,...extra},env.home,asker).question; }
function copies(qid:string) {
  const db=new DatabaseSync(env.db,{readOnly:true});
  try { return db.prepare("SELECT id,recipient,body FROM messages WHERE conversation_id=?").all(`question-delegation-${qid}`) as unknown as Pick<BridgeMessage,"id"|"recipient"|"body">[]; }
  finally { db.close(); }
}

describe("question parent delegation (AB-463)", () => {
  it("escalates an elapsed authorization question once, preserves it and recovers across restarts", () => {
    const q=ask({authorization:true,links:[{kind:"artifact",value:"review.zip"}]});
    vi.advanceTimersByTime(QUESTION_PARENT_TIMEOUT_MS-2000);
    expect(copies(q.id)).toHaveLength(0);
    vi.advanceTimersByTime(2000);
    expect(copies(q.id)).toHaveLength(1);
    expect(copies(q.id)[0]?.recipient).toBe("parent");
    expect(copies(q.id)[0]?.body).toContain("Owner authorization required: true");
    expect(copies(q.id)[0]?.body).toContain("artifact: review.zip");
    expect(copies(q.id)[0]?.body).not.toContain("Answer with message_subagent");
    expect(service.dashboardQuestions()[0]?.delegation.state).toBe("queued");
    expect(service.store.get(q.id)).toMatchObject({status:"open",deliveries:[]});
    expect(service.store.get(q.id)?.answer).toBeUndefined();
    service.close(); service=start(); vi.advanceTimersByTime(4000);
    expect(copies(q.id)).toHaveLength(1);
    service.delegate(q.id,"question"); expect(copies(q.id)).toHaveLength(1);
  });
  it("manually notifies the current routed parent without answering and exposes actual consumption", () => {
    const q=ask(); recipient="current-main"; peers=[{name:recipient,unavailable:false} as PeerInfo];
    const d=service.delegate(q.id,"question");
    expect(d).toMatchObject({state:"notified",recipients:["current-main"]});
    expect(emit).toHaveBeenCalledTimes(1);
    const m=copies(q.id)[0]!; messages.markRead(recipient,[m.id]);
    expect(service.dashboardQuestions()[0]?.delegation.state).toBe("read");
    expect(ownerQuestionVersion(service.list()[0]!)).toBe(ownerQuestionVersion(service.store.get(q.id)!));
    expect(service.store.get(q.id)?.status).toBe("open");
    service.store.answer(q.id,{option:"small"},OWNER_ADDRESS);
    expect(() => service.delegate(q.id,"question")).toThrow("no longer open");
    expect(messages.decisions.list({})).toHaveLength(0);
  });
  it("keeps questions without a known parent visibly open after timeout", () => {
    recipient=undefined; const q=ask();
    vi.advanceTimersByTime(QUESTION_PARENT_TIMEOUT_MS);
    expect(service.dashboardQuestions()[0]?.delegation).toMatchObject({state:"unavailable",eligible:false});
    expect(service.delegate(q.id,"question").state).toBe("unavailable");
    expect(copies(q.id)).toHaveLength(0); expect(service.store.get(q.id)?.status).toBe("open");
    recipient="parent";
    const unlinked=service.store.ask({...input,topic:"unlinked"},env.home,{...asker,job:undefined}).question;
    expect(service.delegate(unlinked.id,"question").eligible).toBe(false);
    expect(copies(unlinked.id)).toHaveLength(0);
  });
  it("retains failed notifications in the inbox without claiming delivery or retrying the question", () => {
    const q=ask(); peers=[{name:"parent"} as PeerInfo]; emit.mockImplementation(() => { throw new Error("disconnected"); });
    expect(service.delegate(q.id,"question").state).toBe("queued");
    expect(copies(q.id)).toHaveLength(1);
    vi.advanceTimersByTime(QUESTION_PARENT_TIMEOUT_MS);
    expect(emit).toHaveBeenCalledTimes(1); expect(copies(q.id)).toHaveLength(1);
    expect(service.store.get(q.id)?.status).toBe("open");
  });
  it("escalates unanswered job questions and never treats the reminder as their answer", () => {
    const id="11111111-1111-4111-a111-111111111111";
    messages.insertOnce({id,from:{id:"job:one",name:"codex-job-one",agent:"codex"},to:"parent",recipient:"parent",body:"Which scope?",
      conversationId:"job-one:question",replyTo:null,hop:0,createdAt:Date.now(),readAt:null});
    vi.advanceTimersByTime(QUESTION_PARENT_TIMEOUT_MS);
    expect(copies(id)).toHaveLength(1); expect(service.jobQuestions()).toHaveLength(1);
    expect(service.jobQuestions()[0]?.delegation.state).toBe("queued");
    messages.insertOnce({id:"22222222-2222-4222-a222-222222222222",from:OWNER_ADDRESS,to:"codex-job-one",recipient:"codex-job-one",
      body:JSON.stringify({type:"message",body:"Small"}),conversationId:"jobctl-one",replyTo:null,hop:0,createdAt:Date.now()+1,readAt:null});
    expect(service.jobQuestions()).toHaveLength(0);
    expect(() => service.delegate(id,"job-question")).toThrow("no longer open");
    vi.advanceTimersByTime(2000); expect(copies(id)).toHaveLength(1);
  });
});
