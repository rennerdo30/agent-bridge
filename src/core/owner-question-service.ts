import { createHash } from "node:crypto";
import type { Logger } from "./logger.js";
import type { BridgeMessage, PeerInfo } from "./protocol.js";
import { OwnerQuestionStore, questionAlertChannel, type DashboardPresence, type OwnerQuestion, type QuestionAlertSettings } from "./owner-questions.js";
import { loadConfig } from "./config.js";
import { notifyOwnerQuestion } from "./notifications.js";
import { loadDashboardKey } from "../cli/dashboard-key.js";
import { readDashboardInfo } from "../cli/dashboard.js";
import type { MessageStore } from "./store.js";
import { normalizeProject, type OwnerDecision } from "./decisions.js";

export const OWNER_ADDRESS = { id: "owner:dashboard", name: "you", agent: "other" as const };
export class OwnerQuestionService {
  readonly store: OwnerQuestionStore;
  private readonly tabs = new Map<string, DashboardPresence>();
  private readonly alerts = new Map<string, { id: string; at: number }[]>();
  private readonly mirrors = new Set<string>();
  private timer: NodeJS.Timeout;
  private closed = false;
  constructor(private readonly home: string, private readonly messages: MessageStore, private readonly log: Logger,
    private readonly peers: () => PeerInfo[], private readonly emit: (peer: PeerInfo, message: BridgeMessage) => void,
    private readonly publishDecision?: (decision: OwnerDecision) => void) {
    this.store = new OwnerQuestionStore(home, log);
    this.timer = setInterval(() => this.tick(), 2000); this.timer.unref();
  }
  close(): void { this.closed=true; clearInterval(this.timer); this.store.close(); }
  settings(): QuestionAlertSettings { return loadConfig(this.home, "other", this.log).questionAlerts; }
  heartbeat(tab: string, visible: boolean): { alerts: { id: string; at: number }[]; settings: QuestionAlertSettings } {
    this.tabs.set(tab, { tab, visible, at: Date.now() });
    const alerts = this.alerts.get(tab) ?? []; this.alerts.delete(tab);
    return { alerts, settings: this.settings() };
  }
  list(): OwnerQuestion[] {
    return this.store.list().map(q => ({ ...q, deliveries: q.deliveries.map(d => ({ ...d,
      readAt: d.messageId ? this.messages.receipts(d.messageId).find(r => r.recipient === d.recipient)?.readAt ?? d.readAt : d.readAt })) }));
  }
  complete(q: OwnerQuestion): OwnerQuestion {
    if (!q.answer) return q;
    if (q.answer.pin && !q.answer.decisionId) {
      // Recover a crash between recording the revision and recording its id on the question.
      const prior = this.messages.decisions.list({ history: true }).find(d => d.sourceMessageId === q.id);
      const decision = prior ?? this.messages.decisions.record({ ...q.answer.pin, text: q.answer.text, sourceMessageId: q.id }, q.answer.author, q.answer.at);
      this.publishDecision?.(decision);
      q.answer.decisionId = decision.id; this.store.save(q);
    }
    const peers = this.peers();
    const mains = peers.filter(p => !p.jobAgent && !p.subagent && !p.unavailable && normalizeProject(p.projectRoot ?? p.cwd) === normalizeProject(q.project));
    const main = mains.find(p => p.projectMain) ?? mains[0];
    const destinations=q.askers.flatMap(a => [{ name:a.session,sessionId:a.sessionId },{name:a.main,sessionId:a.mainSessionId},...(a.job ? [{name:a.job,sessionId:null}] : [])]);
    const resolveDestination=(name:string) => {
      const identity=destinations.find(d => d.name === name && d.sessionId)?.sessionId;
      return peers.find(p => !p.unavailable && normalizeProject(p.projectRoot ?? p.cwd) === normalizeProject(q.project) && (identity ? p.sessionId === identity : p.name === name));
    };
    const askerNames=new Set(q.askers.flatMap(a => [resolveDestination(a.session)?.name ?? a.session,...(a.job ? [a.job] : [])]));
    const mainRead=q.deliveries.some(d => (q.askers.some(a => (resolveDestination(a.main)?.name ?? a.main) === d.recipient) || !askerNames.has(d.recipient)) && d.messageId && this.messages.receipts(d.messageId).some(r => r.readAt !== null));
    const recipients = new Set(destinations.map(d => resolveDestination(d.name)?.name ?? d.name)); if (main && !mainRead) recipients.add(main.name);
    let changed = false;
    for (const recipient of recipients) {
      const live = resolveDestination(recipient);
      const before = q.deliveries.find(d => d.recipient === recipient);
      if (before?.messageId) {
        const readAt=this.messages.receipts(before.messageId).find(r => r.recipient === recipient)?.readAt;
        if (!readAt && before.state === "wake-requested" && Date.now()-q.answer.at >= 20000) {
          before.state="unconfirmed"; before.detail="Wake consumption unconfirmed after 20 s. Durable inbox retained; project-main fallback receives the same recorded answer."; changed=true;
        }
        continue;
      }
      if (!live && (destinations.some(d => d.name === recipient && d.sessionId) || peers.some(p => p.name === recipient))) {
        // Do not send a prior session's answer to a replacement which inherited its display name.
        const offline = {recipient,state:"offline" as const,detail:"Original session is absent or replaced. Answer retained on the question; current project-main fallback receives it.",readAt:null};
        if (JSON.stringify(before) !== JSON.stringify(offline)) {q.deliveries=[...q.deliveries.filter(d => d.recipient !== recipient),offline];changed=true;}
        continue;
      }
      const hash = createHash("sha256").update(`owner-question:${q.id}:${recipient}`).digest("hex");
      const messageId = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
      const message: BridgeMessage = { id: messageId, from: q.answer.author, to: recipient, recipient,
        conversationId: `owner-question-${q.id}`, replyTo: q.id, hop: 0, createdAt: q.answer.at, readAt: null,
        body: `Owner answer to question ${q.id}: ${q.title}\n\n${q.answer.text}\n\n${JSON.stringify({ questionId: q.id, option: q.answer.option, author: q.answer.author, at: q.answer.at, source: q.answer.source, decisionId: q.answer.decisionId })}\nAn answer does not bypass native approvals, expand authorization or accept implementation.` };
      // Durable inbox plus the ordinary direct event reaches every CLI's real wake endpoint.
      const inserted = this.messages.insertOnce(message);
      let failed=false;
      if (inserted && live) { try { this.emit(live, message); } catch { failed=true; } }
      const wake = Boolean(live?.wakeAvailable && (live.autoWake || live.wakeOnDirect));
      const delivery = { recipient, messageId, state: failed ? "failed" as const : !live ? "offline" as const : live.activity === "busy" ? "busy" as const : wake ? "wake-requested" as const : "wake-unavailable" as const,
        detail: failed ? "Direct delivery failed. Durable inbox retained; project-main fallback receives the same answer." : !live ? `Asker offline; retained for reconnection. ${main ? "Also sent to project main " + main.name : "No available project main; fallback pending."}` : live.activity === "busy" ? "Queued for next hook or idle turn; awaiting consumption." : wake ? "Direct wake requested; awaiting consumption." : `Wake unavailable or disabled; durable inbox retained. ${main && main.name !== recipient ? "Also sent to project main " + main.name : "No alternate project main available."}`,
        readAt: null };
      q.deliveries = [...q.deliveries.filter(d => d.recipient !== recipient), delivery]; changed = true;
    }
    if (changed) this.store.save(q);
    if (mainRead && !q.deliveryComplete) { q.deliveryComplete=true; this.store.save(q); }
    if (q.mirror?.state !== "saved" && (q.mirror?.nextAttempt ?? 0) <= Date.now() && q.links.some(l => l.kind === "issue") && !this.mirrors.has(q.id)) {
      this.mirrors.add(q.id);
      void this.mirror(q).finally(() => this.mirrors.delete(q.id));
    }
    return q;
  }
  private async mirror(q: OwnerQuestion): Promise<void> {
    try {
      for (const link of q.links.filter(l => l.kind === "issue")) {
        if (q.mirror?.issues?.includes(link.value)) continue;
        // An unconfirmed POST or restart must not repeat a comment already recorded on the issue.
        const issueUrl = `http://127.0.0.1:8765/api/issues/${encodeURIComponent(link.value)}`;
        const issue = await fetch(issueUrl,{signal:AbortSignal.timeout(3000)});
        if (!issue.ok) throw new Error(`Pair Desk lookup HTTP ${issue.status}`);
        const existing = await issue.json() as { comments?: {text:string}[] };
        if (!existing.comments?.some(c => c.text.includes(`Owner answer recorded (${q.id})`))) {
        const response = await fetch(`http://127.0.0.1:8765/api/issues/${encodeURIComponent(link.value)}/comments`, {
          method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(3000),
          body: JSON.stringify({ author: "owner via agent-bridge", text: `**Owner answer recorded (${q.id}).**\n\n${q.answer!.text}\n\n**Owner:** ${q.answer!.author.name}\n**Time:** ${new Date(q.answer!.at).toISOString()}\n**Source:** ${q.answer!.source}\n${q.answer!.decisionId ? "**Decision:** " + q.answer!.decisionId + "\n" : ""}Answered is not implementation acceptance; native approvals still apply.` }) });
        if (!response.ok) throw new Error(`Pair Desk mirror HTTP ${response.status}`);
        }
        if (this.closed) return;
        q = this.store.get(q.id)!; q.mirror = { state:"pending",issues:[...(q.mirror?.issues ?? []),link.value] }; this.store.save(q);
      }
      if (this.closed) return;
      q = this.store.get(q.id)!; q.mirror = { state: "saved" }; this.store.save(q);
    } catch (error) { if (this.closed) return; q = this.store.get(q.id)!; q.mirror = { ...q.mirror, state: "failed", detail: String(error), nextAttempt:Date.now()+60000 }; this.store.save(q); }
  }
  private tick(): void {
    try {
      const at = Date.now(), settings = this.settings();
      for (const [id,t] of this.tabs) if (at-t.at > 10_000) this.tabs.delete(id);
      for (const q of this.store.work()) {
        if (q.status === "answered") { this.complete(q); continue; }
        if (q.status !== "open") continue;
        if (q.default && at >= q.default.deadline) {
          this.complete(this.store.answer(q.id, { option: q.default.option }, { id: "declared-default", name: "Declared default (not the owner)", agent: "other" }, at, "declared-default")); continue;
        }
        const choice = questionAlertChannel([...this.tabs.values()], at);
        if (choice.channel === "desktop" && !settings.toast) continue;
        if (!this.store.claimAlert(q.id, choice.channel, at, q.blocking ? settings.reminderMinutes*60000 : 0)) continue;
        if (choice.tab) {
          const list = this.alerts.get(choice.tab) ?? []; list.push({ id: q.id, at }); this.alerts.set(choice.tab, list);
        } else {
          const port = readDashboardInfo(this.home)?.port ?? loadConfig(this.home,"other",this.log).dashboardPort;
          const url = `http://127.0.0.1:${port}/?t=${loadDashboardKey(this.home)}#/approvals?question=${q.id}`;
          notifyOwnerQuestion(url, this.log, settings.sound);
        }
      }
    } catch (error) { this.log.warn("owner question maintenance failed", { error: String(error) }); }
  }
}
