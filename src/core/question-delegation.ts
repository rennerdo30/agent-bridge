import { createHash } from "node:crypto";
import type { BridgeMessage, PeerInfo } from "./protocol.js";
import type { MessageStore } from "./store.js";
import type { OwnerQuestion } from "./owner-questions.js";
import type { JobQuestion } from "./job-questions.js";

/** A reminder deadline, never an answer/approval deadline or silent expiry. */
export const QUESTION_PARENT_TIMEOUT_MS = 15 * 60_000;
export type QuestionKind = "question" | "job-question";
export interface QuestionDelegation {
  deadline: number;
  eligible: boolean;
  state: "waiting" | "unavailable" | "queued" | "notified" | "read";
  recipients: string[];
  at?: number;
  detail: string;
}
export type DelegatedOwnerQuestion = OwnerQuestion & { delegation: QuestionDelegation };
export type DelegatedJobQuestion = JobQuestion & { kind: "job-question"; delegation: QuestionDelegation };
export interface QuestionJobRoute { recipient: string; owner: string | null }

/** Uses the ordinary durable inbox as the reminder ledger; no question or permission is resolved. */
export class QuestionDelegator {
  private readonly notified = new Set<string>();
  constructor(private readonly messages: MessageStore, private readonly peers: () => PeerInfo[],
    private readonly routeJob: (name: string) => QuestionJobRoute | undefined,
    private readonly emit: (peer: PeerInfo, message: BridgeMessage) => void) {}

  private id(kind: QuestionKind, id: string): string {
    const hash = createHash("sha256").update(`question-delegation:${kind}:${id}`).digest("hex");
    return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
  }
  private recipients(q: OwnerQuestion | JobQuestion): string[] {
    if (!("askers" in q)) {
      const route = this.routeJob(q.job);
      return route?.recipient ? [route.recipient] : [];
    }
    // ask_owner currently admits project sessions, with optional linked jobs. Never loosen that gate.
    return [...new Set(q.askers.flatMap(a => a.job ? [this.routeJob(a.job)?.recipient].filter((n): n is string => Boolean(n)) : []))];
  }
  describe(kind: QuestionKind, q: OwnerQuestion | JobQuestion, at = Date.now()): QuestionDelegation {
    const deadline = ("askedAt" in q ? q.askedAt : q.createdAt) + QUESTION_PARENT_TIMEOUT_MS;
    const recipients = this.recipients(q), copies = this.messages.messagesById(this.id(kind, q.id));
    const names = [...new Set([...copies.map(m => m.recipient), ...recipients])];
    if (!copies.length) return { deadline, eligible: recipients.length > 0, recipients: names,
      state: at < deadline ? "waiting" : "unavailable",
      detail: recipients.length ? "Delegates to the responsible parent after 15 minutes; the question stays open." : "No responsible parent is available. The question stays open for the owner; no decision is assumed." };
    const read = copies.every(m => m.readAt !== null), notified = copies.every(m => this.notified.has(`${m.id}:${m.recipient}`));
    return { deadline, eligible: recipients.length > 0, recipients: names, at: Math.min(...copies.map(m => m.createdAt)),
      state: read ? "read" : notified ? "notified" : "queued",
      detail: read ? "Parent read the escalation; the question is still unanswered." : "Escalation retained in the parent inbox; awaiting an answer. Notification is not proof of consumption." };
  }
  delegate(kind: QuestionKind, q: OwnerQuestion | JobQuestion, reason: "manual" | "timeout", at = Date.now()): QuestionDelegation {
    if ("status" in q && q.status !== "open") throw new Error("Question is no longer open");
    const recipients = this.recipients(q);
    const body = "askers" in q
      ? `${q.title}\n\n${q.context}\n\n${q.options.map(o => `${o.id}: ${o.label} — ${o.consequence}`).join("\n")}\n\n${q.links.map(l => `${l.kind}: ${l.value}`).join("\n")}\nBlocked: ${q.blocks}\nMeanwhile: ${q.meanwhile}\nOwner authorization required: ${q.authorization || q.blocking && q.destructive}`
      : q.body;
    for (const recipient of recipients) {
      if (this.messages.messagesById(this.id(kind, q.id)).some(m => m.recipient === recipient)) continue;
      const message: BridgeMessage = { id: this.id(kind, q.id), from: { id: "bridge:question-delegation", name: "Question escalation", agent: "other" },
        to: recipient, recipient, conversationId: `question-delegation-${q.id}`, replyTo: q.id, hop: 0, createdAt: at, readAt: null,
        body: `Unanswered ${kind} delegated to parent (${reason}). Asked: ${new Date("askedAt" in q ? q.askedAt : q.createdAt).toISOString()}.\n\n${body}\n\nQuestion ID: ${q.id}. ${"askers" in q ? "Review the linked job and follow up with the owner through the existing question." : `Answer with message_subagent for ${q.job}.`}\nThis is an escalation, not an owner answer, authorization, tool permission or implementation acceptance. Keep owner-only decisions with the owner; the original question remains open.` };
      // One durable copy per question/recipient survives refreshes and broker restarts.
      if (this.messages.insertOnce(message)) {
        const peer = this.peers().find(p => p.name === recipient && !p.unavailable);
        if (peer) { try { this.emit(peer, message); this.notified.add(`${message.id}:${recipient}`); } catch { /* Durable inbox remains the delivery path. */ } }
      }
    }
    return this.describe(kind, q, at);
  }
}
