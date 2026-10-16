import { z } from "zod";
import { shortPin, type Grant } from "./contract.js";
import type { MobileSource, SourceView } from "./adapter.js";
import { digest, equal, MobileFault, MobileStore, secret, type Device } from "./store.js";
import qrcode from "./vendor/qrcode.js";

const grantsSchema = z.array(z.object({ pcId: z.string().min(1).max(128), scope: z.enum(["all", "project"]).optional(), projectIds: z.array(z.string().max(128)).max(100), sessionIds: z.array(z.string().max(128)).max(100), jobIds: z.array(z.string().max(128)).max(100), capabilities: z.array(z.enum(["overview.read", "chat.read", "questions.read", "questions.answer"])).max(4) }).strict()).max(10);
/** What the claim review offers: projects with their local folder and sizes, and individual sessions. Jobs are covered by project or whole-PC grants only. */
function catalog(pcId: string, view: SourceView, folders: ReadonlyMap<string, string> = new Map()) {
  const ids = [...new Set([...view.sessions.flatMap(s => s.projectId ? [s.projectId] : []), ...view.jobs.flatMap(j => j.projectId ? [j.projectId] : []), ...view.questions.map(q => q.projectId)])];
  const projects = ids.map(id => {
    const folder = folders.get(id) ?? null;
    return { id, name: folder ? folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder : null, folder,
      sessions: view.sessions.filter(s => s.projectId === id).length, jobs: view.jobs.filter(j => j.projectId === id).length, questions: view.questions.filter(q => q.projectId === id && q.status === "open").length };
  }).sort((a, b) => b.sessions - a.sessions || (a.name ?? "\uffff").localeCompare(b.name ?? "\uffff") || a.id.localeCompare(b.id));
  return { pcId, projects, sessions: view.sessions.map(s => ({ id: s.id, name: s.name, agent: s.agent, projectId: s.projectId })) };
}
/** A display summary of a paired phone's grants; ids stay on the server. */
function access(grants: Grant[]) {
  const scope = grants.some(g => g.scope === "all") ? "all" : grants.some(g => g.scope === "project") ? "project" : "selected";
  return { scope, projects: new Set(grants.flatMap(g => g.projectIds)).size, sessions: new Set(grants.flatMap(g => g.sessionIds)).size,
    jobs: new Set(grants.flatMap(g => g.jobIds)).size, answers: grants.some(g => g.capabilities.includes("questions.answer")) };
}
export async function readMobileDesktopBody(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of stream) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > 32 * 1024) throw new MobileFault(413, "body_too_large"); chunks.push(buffer); }
  return Buffer.concat(chunks).toString("utf8");
}
/** Mounted only AFTER the existing desktop cookie/Host owner gate; never the mobile listener. */
export class MobileDesktopAdmin {
  isReady(): boolean { return this.ready(); }
  private readonly csrf = secret();
  /** Last source view for the claim review catalog. Pairing state itself is read from the registry on every request (AB-434). */
  private catalogView?: { at: number; view: SourceView; folders?: ReadonlyMap<string, string> };
  private refreshing?: Promise<NonNullable<MobileDesktopAdmin["catalogView"]>>;
  /** Includes timed-out traversals: timeout refuses callers, but cannot cancel MobileSource.snapshot(). */
  private catalogTraversals = 0;
  static readonly CATALOG_MS = 10_000;
  /** One hung traversal permits a replacement; two occupied slots refuse further work until one actually settles. */
  static readonly REFRESH_TIMEOUT_MS = 15_000;
  constructor(private readonly store: MobileStore, private readonly source: MobileSource, readonly localOrigin: string, private readonly ready: () => boolean = () => true) {
    const origin = new URL(localOrigin);
    if (origin.origin !== localOrigin || !["localhost", "127.0.0.1"].includes(origin.hostname) || origin.protocol !== "http:") throw new Error("Exact loopback desktop origin required");
  }
  /** Callers share one live refresh; at most one additional timed-out traversal may remain quarantined. */
  private refreshCatalog(): Promise<NonNullable<MobileDesktopAdmin["catalogView"]>> {
    if (this.refreshing) return this.refreshing;
    if (this.catalogTraversals >= 2) return Promise.reject(new MobileFault(503, "catalog_refresh_busy"));
    this.catalogTraversals++;
    let expired = false;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(new MobileFault(503, "source_unavailable")); }, MobileDesktopAdmin.REFRESH_TIMEOUT_MS); timer.unref?.();
    });
    const snapshot = (async () => {
      try {
        const view = await this.source.snapshot();
        // A quarantined result can never publish or become fresh authorization evidence, even after a replacement succeeds.
        if (expired) throw new MobileFault(503, "source_unavailable");
        return this.catalogView = { at: startedAt, view, folders: this.source.projectFolders?.() };
      } finally { this.catalogTraversals--; }
    })();
    snapshot.catch(() => { /* A late failure after the timeout is already reported. */ });
    const work = Promise.race([snapshot, timeout]);
    this.refreshing = work;
    const settle = () => { clearTimeout(timer); if (this.refreshing === work) this.refreshing = undefined; };
    work.then(settle, settle);
    return work;
  }
  /** The cached catalog, refreshed in the background once stale; only the first request waits for a snapshot. */
  private async catalogFor(): Promise<NonNullable<MobileDesktopAdmin["catalogView"]>> {
    const cached = this.catalogView;
    if (!cached) return this.refreshCatalog();
    if (Date.now() - cached.at >= MobileDesktopAdmin.CATALOG_MS) this.refreshCatalog().catch(() => { /* Keep serving the last catalog. */ });
    return cached;
  }
  async handle(method: string, path: string, headers: Record<string, string | undefined>, body?: string): Promise<{ status: number; body?: unknown }> {
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    if (headers["sec-fetch-site"] === "cross-site" || headers.origin && headers.origin !== this.localOrigin) throw new MobileFault(403, "desktop_origin");
    if (method === "GET" && path === "/api/mobile/phones") {
      const { at, view, folders } = await this.catalogFor();
      if (!this.ready()) throw new MobileFault(503, "source_unavailable");
      const devices = this.store.list<Device>("device").map(({ grants, revision, ...device }) => ({ ...device, access: access(grants) }));
      return { status: 200, body: { csrfToken: this.csrf, devices, pending: this.store.pending(),
        catalog: { ...catalog(this.store.pcId, view, folders), stale: Date.now() - at >= MobileDesktopAdmin.CATALOG_MS }, gatewayOrigins: this.store.origins, fingerprints: this.store.pins?.map(shortPin) ?? [] } };
    }
    if (headers.origin !== this.localOrigin || !equal(headers["x-mobile-admin-csrf"] ?? "", this.csrf)) throw new MobileFault(403, "desktop_csrf");
    const key = z.string().uuid().parse(headers["idempotency-key"]);
    if (body && Buffer.byteLength(body) > 32 * 1024) throw new MobileFault(413, "body_too_large");
    if (body && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(headers["content-type"] ?? "")) throw new MobileFault(400, "json_required");
    const args: unknown = body ? JSON.parse(body) : {};
    if (method === "POST" && path === "/api/mobile/invitations") {
      z.object({}).strict().parse(args);
      const qr = this.store.mutate("desktop-owner", method + path, key, digest("admin", "invite"), () => {
        const invitation = this.store.invite(), payload = JSON.stringify(invitation), qr = qrcode(0, "M"); qr.addData(payload); qr.make();
        return { response: { qr: invitation, qrPayload: payload, qrSvg: qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true }) }, replay: { state: "invited" } };
      });
      return { status: 201, body: qr };
    }
    const confirm = /^\/api\/mobile\/claims\/([\w-]+)$/.exec(path);
    if (method === "POST" && confirm) {
      const parsed = z.object({ comparisonCode: z.string().regex(/^\d{6}$/), allow: z.boolean(), grants: grantsSchema }).strict().parse(args);
      // Remote reads remain unsupported: this local adapter cannot prove existing paired-PC trust.
      for (const grant of parsed.grants) {
        if (grant.scope === "all" && (grant.projectIds.length || grant.sessionIds.length || grant.jobIds.length) || grant.scope === "project" && !grant.projectIds.length || grant.pcId !== this.store.pcId) throw new MobileFault(403, "unsupported_grant");
      }
      const known = (view: SourceView) => parsed.grants.every(grant => grant.sessionIds.every(id => view.sessions.some(s => s.id === id)) && grant.jobIds.every(id => view.jobs.some(j => j.id === id)) &&
        grant.projectIds.every(id => [...view.questions, ...view.sessions, ...view.jobs].some(q => q.projectId === id)));
      // A fresh catalog (the one the owner just reviewed) needs no new snapshot; anything it does not know is checked against a new one.
      const cached = this.catalogView, recent = cached && Date.now() - cached.at < MobileDesktopAdmin.CATALOG_MS ? cached.view : undefined;
      if (!recent || !known(recent)) {
        const { view } = await this.refreshCatalog();
        if (!this.ready()) throw new MobileFault(503, "source_unavailable");
        if (!known(view)) throw new MobileFault(403, "unsupported_grant");
      }
      if (!this.ready()) throw new MobileFault(503, "source_unavailable");
      this.store.mutate("desktop-owner", method + path, key, digest("admin", JSON.stringify(parsed)), () => {
        this.store.confirm(confirm[1]!, parsed.comparisonCode, parsed.allow, parsed.grants as Grant[]); return { response: { state: "recorded" }, replay: { state: "recorded" } };
      });
      return { status: 200, body: { state: "recorded" } };
    }
    const revoke = /^\/api\/mobile\/devices\/([\w-]+)$/.exec(path);
    if (method === "DELETE" && revoke) {
      z.object({}).strict().parse(args);
      this.store.mutate("desktop-owner", method + path, key, digest("admin", "revoke"), () => { this.store.revoke(revoke[1]!); return { response: null, replay: null }; });
      return { status: 204 };
    }
    throw new MobileFault(404, "unsupported");
  }
}
