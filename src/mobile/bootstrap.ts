import type { DashboardReadContext } from "../core/dashboard-read.js";
import type { OwnerQuestion } from "../core/owner-questions.js";
import { LocalMobileSource, type MobileQuestionStore } from "./adapter.js";
import { MobileDesktopAdmin } from "./desktop.js";
import { MobileGateway } from "./gateway.js";
import { MobilePush, type PushProvider } from "./push.js";
import { MobileStore } from "./store.js";

/** Borrowed from the broker; mobile never owns its store, timer or close lifecycle. */
export interface MobileQuestionService {
  store: MobileQuestionStore;
  list(): OwnerQuestion[];
  complete(question: OwnerQuestion): OwnerQuestion;
}

/** Explicit owner-provisioning seam. No certificates, secrets, listeners, environment or live stores are read here. */
export function provisionMobile(options: {
  registryFile: string; pcId: string; origins: string[]; desktopOrigin: string; local: DashboardReadContext;
  ownerQuestions: MobileQuestionService; ready: () => boolean;
  pins?: readonly string[];
  push?: { provider: PushProvider; encryptionKey: Uint8Array; projectId: string; environment: "development" | "production" };
}): { gateway: MobileGateway; desktopAdmin: MobileDesktopAdmin; pollQuestionHints: () => Promise<void>; close: () => Promise<void> } {
  if (!options.origins.length) throw new Error("Owner must provision LAN/Tailscale trusted HTTPS origins");
  const store = new MobileStore(options.registryFile, options.pcId, options.origins[0]!, Date.now, options.origins.slice(1), options.pins);
  let closed = false, closing: Promise<void> | undefined;
  const ready = () => !closed && options.ready();
  const source = new LocalMobileSource(options.local, options.ownerQuestions.store, options.pcId, ready,
    q => options.ownerQuestions.complete(q), () => options.ownerQuestions.list());
  const push = options.push ? new MobilePush(store, options.push.provider, options.push.encryptionKey, options.push.projectId, options.push.environment) : new MobilePush(store);
  const gateway = new MobileGateway(store, source, push, undefined, ready), desktopAdmin = new MobileDesktopAdmin(store, source, options.desktopOrigin, ready);
  let hintPoll: Promise<void> | undefined;
  // Incremental hint poll (AB-434): a question is offered to push again only when it was asked anew or the subscribed
  // devices changed. The persisted per-device dedupe in MobilePush stays the authority; this only skips repeat work.
  const hinted = new Map<string, string>();
  const questions = async () => source.questionView ? source.questionView() : (await source.snapshot()).questions;
  return { gateway, desktopAdmin, close: () => {
    if (closing) return closing;
    closed = true; gateway.deactivate();
    closing = (async () => {
      try {
        const settled = await Promise.allSettled([gateway.close(), hintPoll ?? Promise.resolve()]);
        const failed = settled[0]!;
        if (failed.status === "rejected") throw failed.reason;
      } finally { store.close(); }
    })(); return closing;
  }, pollQuestionHints: () => {
    if (hintPoll) return hintPoll;
    hintPoll = (async () => {
      if (!push.configured || !ready()) return;
      // No subscribed device: nothing can be hinted, so read no source at all.
      const subscribers = push.subscriptionState();
      if (!subscribers) { hinted.clear(); return; }
      const open = (await questions()).filter(q => q.status === "open");
      for (const id of hinted.keys()) if (!open.some(q => q.id === id)) hinted.delete(id);
      for (const question of open) {
        const state = JSON.stringify([question.askedAt, subscribers]);
        if (hinted.get(question.id) === state) continue;
        await push.notify(question, async () => {
          if (!ready()) return undefined;
          return (await questions()).find(q => q.id === question.id);
        });
        hinted.set(question.id, state);
      }
    })().finally(() => { hintPoll = undefined; }); return hintPoll;
  } };
}
