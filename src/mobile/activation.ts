import { createPrivateKey, randomUUID, X509Certificate } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import type { Logger } from "../core/logger.js";
import type { DashboardInfo, DashboardHostOptions } from "../cli/dashboard.js";
import { ExpoPushProvider } from "./expo-push.js";
import { MobileActivationFault, privateAddress, readPrivateMaterial, type MobileConfig } from "./config.js";
import { prepareMobileDesktopHost, type MobileHostNode, type PreparedMobileDesktopHost, type MobileHostConfig } from "./host.js";
import type { PushProvider } from "./push.js";
import { loadMobileIdentity } from "./identity.js";

export type ActivationStatus = "preparing" | "ready" | "source_unavailable" | MobileActivationFault["category"];
export interface ActivationNode extends MobileHostNode { readonly isBroker: boolean; initializeMobileOwnerQuestions(): boolean }
interface Desktop { ensure(): Promise<DashboardInfo>; close(): Promise<void> }
export interface ActivationDependencies {
  material?(file: string): Promise<Buffer>;
  addresses?(hostname: string): Promise<string[]>;
  validateTls?(cert: Buffer, key: Buffer, hostname: string): void;
  prepare?: typeof prepareMobileDesktopHost;
  desktop?(options: DashboardHostOptions): Desktop;
  provider?(token: string): PushProvider;
  identity?: typeof loadMobileIdentity;
}
export function validateMobileTls(cert: Buffer, key: Buffer, hostname: string): void {
  try {
    const x509 = new X509Certificate(cert), now = Date.now(), from = Date.parse(x509.validFrom), to = Date.parse(x509.validTo);
    hostname = hostname.replace(/^\[|\]$/g, "");
    if (!Number.isFinite(from) || !Number.isFinite(to) || now < from || now >= to || !x509.checkPrivateKey(createPrivateKey(key)) ||
      !(isIP(hostname) ? x509.checkIP(hostname) : x509.checkHost(hostname, { wildcards: false }))) throw new Error();
  } catch { throw new MobileActivationFault("tls_invalid"); }
}
/** One configured host. No material, service, timer or listener work for an absent configuration. */
export class MobileActivation {
  private starting?: Promise<DashboardInfo | undefined>;
  private closing?: Promise<void>;
  private retiring?: Promise<void>;
  private disposal?: { prepared?: PreparedMobileDesktopHost; desktop?: Desktop; closeDesktop: boolean; work: Promise<void> };
  private prepared?: PreparedMobileDesktopHost;
  private desktop?: Desktop;
  private unregister?: () => void;
  private poll?: ReturnType<typeof setInterval>;
  private retired = false;
  private state: ActivationStatus = "preparing";
  constructor(private readonly node: ActivationNode, private readonly config: MobileConfig,
    private readonly options: { home: string; pipe: string; port: number; log: Logger }, private readonly deps: ActivationDependencies = {}) {}
  status = (): ActivationStatus => this.state === "ready" && !this.prepared?.ready() ? "source_unavailable" : this.state;
  start(): Promise<DashboardInfo | undefined> { return this.starting ??= this.open(); }
  private diagnostic(errorCategory: ActivationStatus): void {
    try { this.options.log.warn("mobile unavailable", { requestId: randomUUID(), errorCategory }); } catch { /* Optional only. */ }
  }
  private async open(): Promise<DashboardInfo | undefined> {
    try {
      if ("invalid" in this.config) throw new MobileActivationFault("config_invalid");
      if (!Number.isInteger(this.options.port) || this.options.port < 1 || this.options.port > 65535) throw new MobileActivationFault("config_invalid");
      if (!this.node.isBroker || this.retired) throw new MobileActivationFault("source_unavailable");
      const material = this.deps.material ?? readPrivateMaterial;
      const listeners: NonNullable<MobileHostConfig["listeners"]> = [];
      let identity: Awaited<ReturnType<typeof loadMobileIdentity>> | undefined;
      for (const listener of this.config.listeners) {
        const addresses = isIP(listener.bindAddress) ? [listener.bindAddress] : await (this.deps.addresses ?? (async name => (await lookup(name, { all: true })).map(r => r.address)))(listener.bindAddress);
        if (!addresses.length || addresses.some(address => !privateAddress(address))) throw new MobileActivationFault("bind_invalid");
        // Bind a validated literal address: do not resolve again between validation and listen.
        const pinned = "tls" in listener;
        if (pinned) identity ??= await (this.deps.identity ?? loadMobileIdentity)(this.options.home, this.config.origins);
        const cert = pinned ? identity!.cert : await material(listener.certFile), key = pinned ? identity!.key : await material(listener.keyFile);
        (this.deps.validateTls ?? validateMobileTls)(cert, key, new URL(listener.origin).hostname);
        listeners.push({ origin: listener.origin, bindAddress: addresses[0]!, port: listener.port, tls: { cert, key }, ...(pinned ? { pinning: true } : {}) });
      }
      let push: MobileHostConfig["push"];
      if (this.config.push) {
        try {
          const raw = await material(this.config.push.materialRef), parsed: unknown = JSON.parse(raw.toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          const value = parsed as Record<string, unknown>;
          if (Object.keys(value).sort().join(",") !== "accessToken,encryptionKey" || typeof value.accessToken !== "string" || !value.accessToken || value.accessToken.length > 4096 || /[\r\n]/.test(value.accessToken) || typeof value.encryptionKey !== "string") throw new Error();
          const encryptionKey = Buffer.from(value.encryptionKey, "base64");
          if (encryptionKey.length !== 32 || encryptionKey.toString("base64") !== value.encryptionKey) throw new Error();
          push = { provider: (this.deps.provider ?? (token => new ExpoPushProvider(token)))(value.accessToken), encryptionKey,
            projectId: this.config.push.projectId, environment: this.config.push.environment };
          raw.fill(0);
        } catch { throw new MobileActivationFault("material_unavailable"); }
      }
      if (this.retired || !this.node.initializeMobileOwnerQuestions()) throw new MobileActivationFault("source_unavailable");
      this.prepared = await (this.deps.prepare ?? prepareMobileDesktopHost)(this.node, { registryFile: join(this.options.home, "mobile.db"), pcId: this.config.pcId,
        origins: this.config.origins, desktopOrigin: `http://127.0.0.1:${this.options.port}`, listeners, ...(identity ? { pins: identity.pins } : {}), ...(push ? { push } : {}) });
      if (this.retired || !this.prepared.ready()) throw new MobileActivationFault("source_unavailable");
      const context = this.node.mobileHostContext(); if (!context?.ready()) throw new MobileActivationFault("source_unavailable");
      this.unregister = context.onDispose(() => this.retireMobile());
      const factory = this.deps.desktop ?? (options => { throw new Error("desktop_factory_required"); });
      this.desktop = factory({ ...this.options, mobileAdmin: this.prepared.desktopAdmin, mobileStatus: this.status });
      const info = await this.desktop.ensure();
      for (const { config, server } of this.prepared.listeners) {
        if (this.retired || !this.prepared.ready()) throw new MobileActivationFault("source_unavailable");
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); server.off("error", failed); server.off("listening", done); };
          const done = () => { cleanup(); resolve(); }, failed = () => { cleanup(); reject(new MobileActivationFault("restart_required")); };
          const timer = setTimeout(failed, 5000);
          server.once("error", failed); server.once("listening", done);
          try { server.listen(config.port, config.bindAddress); } catch { failed(); }
        });
        server.on("error", () => { this.state = "restart_required"; this.diagnostic(this.state); void this.retireMobile(); });
      }
      if (this.retired || !this.prepared.ready()) throw new MobileActivationFault("source_unavailable");
      this.state = "ready";
      if (push) { this.poll = setInterval(() => { if (this.status() === "ready") void this.prepared?.pollQuestionHints().catch(() => this.diagnostic("source_unavailable")); }, 2000); this.poll.unref(); }
      return info;
    } catch (error) {
      this.state = error instanceof MobileActivationFault ? error.category : "restart_required";
      this.diagnostic(this.state); this.retired = true; await this.disposeOwned(); return undefined;
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    void this.retireMobile();
    this.closing = this.disposeOwned(); return this.closing;
  }
  private retireMobile(): Promise<void> {
    if (this.retiring) return this.retiring;
    this.retired = true; if (this.state === "ready" || this.state === "preparing") this.state = "source_unavailable";
    if (this.poll) clearInterval(this.poll); this.poll = undefined;
    this.prepared?.gateway.deactivate();
    this.retiring = this.disposeOwned(false); return this.retiring;
  }
  private disposeOwned(closeDesktop = true): Promise<void> {
    const prepared = this.prepared, desktop = this.desktop;
    if (this.disposal && this.disposal.prepared === prepared && this.disposal.desktop === desktop && this.disposal.closeDesktop === closeDesktop) return this.disposal.work;
    const work = this.settleOwned(prepared, closeDesktop ? desktop : undefined, this.unregister); this.disposal = { prepared, desktop, closeDesktop, work }; return work;
  }
  private async settleOwned(prepared: PreparedMobileDesktopHost | undefined, desktop: Desktop | undefined, unregister: (() => void) | undefined): Promise<void> {
      prepared?.gateway.deactivate();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const settled = await Promise.race([Promise.allSettled([prepared?.close() ?? Promise.resolve(), desktop?.close() ?? Promise.resolve()]),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 5000); })]);
        if (!settled || settled.some(r => r.status === "rejected")) { this.state = "restart_required"; this.diagnostic(this.state); }
      } finally { if (timer) clearTimeout(timer); unregister?.(); if (this.unregister === unregister) this.unregister = undefined; }
  }
}

export async function configuredMobileDashboard(node: ActivationNode, config: MobileConfig | undefined,
  options: { home: string; pipe: string; port: number; log: Logger }, deps: ActivationDependencies = {}): Promise<MobileActivation | undefined> {
  if (!config) return undefined;
  const desktop = deps.desktop ?? (await import("../cli/dashboard.js")).createConfiguredMobileDashboard;
  return new MobileActivation(node, config, options, { ...deps, desktop });
}
