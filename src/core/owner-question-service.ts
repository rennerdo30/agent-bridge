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
import { nativeOwner, ownershipFromKey, recipientKey } from "./recipient-ownership.js";

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
    const alerts = (this.alerts.get(tab) ?? []).filter(a => this.store.get(a.id)?.status === "open"); this.alerts.delete(tab);
    return { alerts, settings: this.settings() };
  }
  list(): OwnerQuestion[] {
    return this.store.list().map(q => ({ ...q, deliveries: q.deliveries.map(d => ({ ...d,
      readAt: this.readAt(d) })) }));
  }
  private readAt(delivery: OwnerQuestion["deliveries"][number]): number | null {
    if (!delivery.messageId || !delivery.owner) return null;
    const copies = this.messages.messagesById(delivery.messageId).filter(m => this.messages.localCopy(m) && recipientKey(m.recipientFrontend, m.recipientNative) === delivery.owner);
    return this.messages.receipts(delivery.messageId).find(r => copies.some(m => m.recipient === r.recipient) && r.readAt !== null)?.readAt ?? null;
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
    const destinations: { name: string; owner?: string; main: boolean }[] = q.askers.flatMap(a => [
      { name: a.session, owner: a.owner, main: false }, { name: a.main, owner: a.mainOwner, main: true },
      ...(a.job ? [{ name: a.job, owner: a.jobOwner, main: false }] : [])]);
    const mainRead = q.deliveries.some(d => d.main && this.readAt(d) !== null);
    let changed = false;
    // A fallback is an authorized project role, not permission for a later name
    // claimant. Capture its actual owner once before the first delivery attempt.
    if (main && !mainRead && !q.fallbackTargets?.length) {
      const owner = recipientKey(main.frontend, nativeOwner(main));
      if (owner && !destinations.some(d => d.owner === owner)) { q.fallbackTargets = [{ name: main.name, owner }]; changed = true; }
    }
    destinations.push(...(q.fallbackTargets ?? []).map(d => ({ ...d, main: true })));
    const targets = new Map<string, { name: string; owner?: string; main: boolean }>();
    for (const d of destinations) {
      const key = d.owner ?? `unproven:${d.name}`, previous = targets.get(key);
      targets.set(key, { ...d, main: d.main || Boolean(previous?.main) });
    }
    for (const target of targets.values()) {
      const evidence = target.owner ? ownershipFromKey(target.owner) : { recipientAmbiguous: true as const };
      const live = target.owner ? peers.find(p => !p.unavailable && normalizeProject(p.projectRoot ?? p.cwd) === normalizeProject(q.project) && recipientKey(p.frontend, nativeOwner(p)) === target.owner) : undefined;
      const recipient = live?.name ?? target.name;
      const before = q.deliveries.find(d => target.owner ? d.owner === target.owner : !d.owner && d.recipient === recipient);
      if (before?.messageId) {
        const copy = this.messages.messagesById(before.messageId).find(m => this.messages.localCopy(m) && target.owner && recipientKey(m.recipientFrontend, m.recipientNative) === target.owner);
        if (!copy) {
          before.state = "pending"; before.detail = "Retained delivery has no proven matching mailbox copy; original evidence and answer retained for reviewed recovery.";
          changed = true; continue;
        }
        const readAt = this.readAt(before);
        if (!readAt && before.state === "wake-requested" && Date.now()-q.answer.at >= 20000) {
          before.state="unconfirmed"; before.detail="Wake consumption unconfirmed after 20 s. Durable inbox retained; project-main fallback receives the same recorded answer."; changed=true;
        }
        continue;
      }
      if (evidence.recipientAmbiguous || !target.owner) {
        const pending = { recipient, owner: target.owner, main: target.main, state: "pending" as const, detail: "Original recipient binding is unavailable. Answer retained; no mailbox delivery or consumption was attributed.", readAt: null };
        if (JSON.stringify(before) !== JSON.stringify(pending)) { q.deliveries = [...q.deliveries.filter(d => d !== before), pending]; changed = true; }
        continue;
      }
      const hash = createHash("sha256").update(`owner-question:v2:${q.id}:${target.owner}`).digest("hex");
      const messageId = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
      const message: BridgeMessage = { id: messageId, from: q.answer.author, to: recipient, recipient, ...evidence,
        conversationId: `owner-question-${q.id}`, replyTo: q.id, hop: 0, createdAt: q.answer.at, readAt: null,
        body: `Owner answer to question ${q.id}: ${q.title}\n\n${q.answer.text}\n\n${JSON.stringify({ questionId: q.id, option: q.answer.option, author: q.answer.author, at: q.answer.at, source: q.answer.source, decisionId: q.answer.decisionId })}\nAn answer does not bypass native approvals, expand authorization or accept implementation.` };
      // Durable inbox plus the ordinary direct event reaches every CLI's real wake endpoint.
      const inserted = this.messages.insertOnce(message);
      const durable = this.messages.messagesById(messageId).find(m => this.messages.localCopy(m) && recipientKey(m.recipientFrontend, m.recipientNative) === target.owner);
      if (!durable) {
        q.deliveries = [...q.deliveries.filter(d => d !== before), { recipient, owner: target.owner, main: target.main, state: "pending", detail: "A conflicting historical mailbox copy is retained; delivery requires reviewed recovery.", readAt: null }];
        changed = true; continue;
      }
      let failed=false;
      if (inserted && live) { try { this.emit(live, message); } catch { failed=true; } }
      const wake = Boolean(live?.wakeAvailable && (live.autoWake || live.wakeOnDirect));
      const delivery = { recipient, owner: target.owner, main: target.main, messageId, state: failed ? "failed" as const : !live ? "offline" as const : live.activity === "busy" ? "busy" as const : wake ? "wake-requested" as const : "wake-unavailable" as const,
        detail: failed ? "Direct delivery failed. Durable inbox retained; project-main fallback receives the same answer." : !live ? `Asker offline; retained for reconnection. ${main ? "Also sent to project main " + main.name : "No available project main; fallback pending."}` : live.activity === "busy" ? "Queued for next hook or idle turn; awaiting consumption." : wake ? "Direct wake requested; awaiting consumption." : `Wake unavailable or disabled; durable inbox retained. ${main && main.name !== recipient ? "Also sent to project main " + main.name : "No alternate project main available."}`,
        readAt: null };
      if (q.fallbackTargets?.some(d => d.owner === target.owner)) delivery.detail = "Original session is absent; this answer goes to the captured project-main owner as fallback. " + delivery.detail;
      q.deliveries = [...q.deliveries.filter(d => d !== before), delivery]; changed = true;
    }
    const complete = mainRead && [...targets.values()].every(t => t.owner && q.deliveries.some(d => d.owner === t.owner && d.messageId && this.messages.messagesById(d.messageId).some(m => this.messages.localCopy(m) && recipientKey(m.recipientFrontend, m.recipientNative) === t.owner)));
    if (q.deliveryComplete && !complete) { q.deliveryComplete = false; changed = true; }
    if (complete && !q.deliveryComplete) { q.deliveryComplete = true; changed = true; }
    if (changed) this.store.save(q);
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
      for (const [id,t] of this.tabs) if (at-t.at > 10_000) { this.tabs.delete(id); this.alerts.delete(id); }
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
