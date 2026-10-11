import { z } from "zod";
import type { Grant } from "./contract.js";
import type { MobileSource } from "./adapter.js";
import { digest, equal, MobileFault, MobileStore, secret } from "./store.js";
import qrcode from "./vendor/qrcode.js";

const grantsSchema = z.array(z.object({ pcId: z.string().min(1).max(128), projectIds: z.array(z.string().max(128)).max(100), sessionIds: z.array(z.string().max(128)).max(100), jobIds: z.array(z.string().max(128)).max(100), capabilities: z.array(z.enum(["overview.read", "chat.read", "questions.read", "questions.answer"])).max(4) }).strict()).max(10);
export async function readMobileDesktopBody(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of stream) { const buffer = Buffer.from(chunk); size += buffer.length; if (size > 32 * 1024) throw new MobileFault(413, "body_too_large"); chunks.push(buffer); }
  return Buffer.concat(chunks).toString("utf8");
}
/** Mounted only AFTER the existing desktop cookie/Host owner gate; never the mobile listener. */
export class MobileDesktopAdmin {
  isReady(): boolean { return this.ready(); }
  private readonly csrf = secret();
  constructor(private readonly store: MobileStore, private readonly source: MobileSource, readonly localOrigin: string, private readonly ready: () => boolean = () => true) {
    const origin = new URL(localOrigin);
    if (origin.origin !== localOrigin || !["localhost", "127.0.0.1"].includes(origin.hostname) || origin.protocol !== "http:") throw new Error("Exact loopback desktop origin required");
  }
  async handle(method: string, path: string, headers: Record<string, string | undefined>, body?: string): Promise<{ status: number; body?: unknown }> {
    if (!this.ready()) throw new MobileFault(503, "source_unavailable");
    if (headers["sec-fetch-site"] === "cross-site" || headers.origin && headers.origin !== this.localOrigin) throw new MobileFault(403, "desktop_origin");
    if (method === "GET" && path === "/api/mobile/phones") {
      const view = await this.source.snapshot();
      if (!this.ready()) throw new MobileFault(503, "source_unavailable");
      return { status: 200, body: { csrfToken: this.csrf, devices: this.store.devices(), pending: this.store.pending(),
        catalog: { pcId: this.store.pcId, sessions: view.sessions.map(s => ({ id: s.id, name: s.name })), jobs: view.jobs.map(j => ({ id: j.id, title: j.title })), projects: [...new Set([...view.questions.map(q => q.projectId), ...view.sessions.flatMap(s => s.projectId ? [s.projectId] : []), ...view.jobs.flatMap(j => j.projectId ? [j.projectId] : [])])] }, gatewayOrigins: this.store.origins } };
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
      const view = await this.source.snapshot();
      if (!this.ready()) throw new MobileFault(503, "source_unavailable");
      // Remote reads remain unsupported: this local adapter cannot prove existing paired-PC trust.
      for (const grant of parsed.grants) {
        if (grant.pcId !== this.store.pcId || grant.sessionIds.some(id => !view.sessions.some(s => s.id === id)) || grant.jobIds.some(id => !view.jobs.some(j => j.id === id)) || grant.projectIds.some(id => ![...view.questions, ...view.sessions, ...view.jobs].some(q => q.projectId === id))) throw new MobileFault(403, "unsupported_grant");
      }
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
