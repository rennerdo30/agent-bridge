import type { Logger } from "../core/logger.js";
import type { DashboardReadContext } from "../core/dashboard-read.js";
import { provisionMobile, type MobileQuestionService } from "./bootstrap.js";
import { createMobileHttpsListeners, type MobileListenerConfig } from "./https.js";
import { MobileFault } from "./store.js";

/** Host-only in-process borrowing. There is no broker protocol or remote owner authority. */
export interface MobileHostContext {
  home: string; pipe: string; log: Logger; local: DashboardReadContext; ownerQuestions: MobileQuestionService;
  ready(): boolean;
  onDispose(dispose: () => Promise<void>): () => void;
}
export interface MobileHostNode { mobileHostContext(): MobileHostContext | undefined }
export type MobileHostConfig = Omit<Parameters<typeof provisionMobile>[0], "local" | "ownerQuestions" | "ready"> & { listeners?: MobileListenerConfig[] };
export interface PreparedMobileDesktopHost {
  gateway: ReturnType<typeof provisionMobile>["gateway"];
  desktopAdmin: ReturnType<typeof provisionMobile>["desktopAdmin"];
  listeners: ReturnType<typeof createMobileHttpsListeners>;
  pollQuestionHints(): Promise<void>;
  ready(): boolean;
  close(): Promise<void>;
}

/** Explicit programmatic entry. Caller supplies already-provisioned material; every HTTPS server remains UNBOUND. */
export async function prepareMobileDesktopHost(node: MobileHostNode, config: MobileHostConfig): Promise<PreparedMobileDesktopHost> {
  const context = node.mobileHostContext();
  if (!context?.ready()) throw new MobileFault(503, "source_unavailable");
  let closed = false, closing: Promise<void> | undefined, unregister = () => {};
  const ready = () => !closed && context.ready();
  const mobile = provisionMobile({ ...config, local: context.local, ownerQuestions: context.ownerQuestions, ready });
  let listeners: ReturnType<typeof createMobileHttpsListeners> = [];
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true; mobile.gateway.deactivate();
    closing = (async () => {
      const failures: unknown[] = [];
      try {
        const settled = await Promise.allSettled(listeners.map(({ server }) => new Promise<void>((resolve, reject) => {
          // Only these owned listeners: end keep-alive/in-flight connections before service retirement.
          server.closeAllConnections();
          if (!server.listening) { resolve(); return; }
          server.close(error => error ? reject(error) : resolve());
        })));
        for (const result of settled) if (result.status === "rejected") failures.push(result.reason);
      } finally {
        // Keep the broker disposer registered while node shutdown drains pending work.
        // Broker.close must await this same promise before retiring its borrowed service.
        try { await mobile.close(); } catch (error) { failures.push(error); } finally { unregister(); }
      }
      if (failures.length) throw new AggregateError(failures, "mobile_host_disposal_failed");
    })(); return closing;
  };
  try {
    if (config.listeners?.length) listeners = createMobileHttpsListeners(mobile.gateway, config.listeners);
    for (const { server } of listeners) server.on("listening", () => {
      // A retained prepared handle must not be activated after ownership loss.
      if (!ready()) { server.closeAllConnections(); server.close(); }
    });
    unregister = context.onDispose(close);
    if (!ready()) throw new MobileFault(503, "source_unavailable");
    return { gateway: mobile.gateway, desktopAdmin: mobile.desktopAdmin, listeners, pollQuestionHints: mobile.pollQuestionHints, ready, close };
  } catch (error) { await close(); throw error; }
}
