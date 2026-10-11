import type { DashboardReadContext } from "../core/dashboard-read.js";
import type { OwnerQuestionStore, OwnerQuestion } from "../core/owner-questions.js";
import { LocalMobileSource } from "./adapter.js";
import { MobileDesktopAdmin } from "./desktop.js";
import { MobileGateway } from "./gateway.js";
import { MobilePush, type PushProvider } from "./push.js";
import { MobileStore } from "./store.js";

/** Explicit owner-provisioning seam. No certificates, secrets, listeners, environment or live stores are read here. */
export function provisionMobile(options: {
  registryFile: string; pcId: string; origins: string[]; desktopOrigin: string; local: DashboardReadContext;
  questions: OwnerQuestionStore; ready: () => boolean; completeAnswer?: (question: OwnerQuestion) => void;
  push?: { provider: PushProvider; encryptionKey: Uint8Array; projectId: string; environment: "development" | "production" };
}): { gateway: MobileGateway; desktopAdmin: MobileDesktopAdmin; pollQuestionHints: () => Promise<void>; close: () => void } {
  if (!options.origins.length) throw new Error("Owner must provision LAN/Tailscale trusted HTTPS origins");
  const store = new MobileStore(options.registryFile, options.pcId, options.origins[0]!, Date.now, options.origins.slice(1));
  const source = new LocalMobileSource(options.local, options.questions, options.pcId, options.ready, options.completeAnswer);
  const push = options.push ? new MobilePush(store, options.push.provider, options.push.encryptionKey, options.push.projectId, options.push.environment) : new MobilePush(store);
  const gateway = new MobileGateway(store, source), desktopAdmin = new MobileDesktopAdmin(store, source, options.desktopOrigin);
  let hintPoll: Promise<void> | undefined;
  return { gateway, desktopAdmin, close: () => store.close(), pollQuestionHints: () => {
    if (hintPoll) return hintPoll;
    hintPoll = (async () => {
      if (!push.configured || !options.ready()) return;
      const view = await source.snapshot();
      for (const question of view.questions.filter(q => q.status === "open")) {
        await push.notify(question, async () => {
          if (!options.ready()) return undefined;
          return (await source.snapshot()).questions.find(q => q.id === question.id);
        });
      }
    })().finally(() => { hintPoll = undefined; }); return hintPoll;
  } };
}
