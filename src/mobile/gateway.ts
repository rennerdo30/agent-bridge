import { randomUUID } from "node:crypto";
import { z } from "zod";
import { QuestionVersionConflict } from "../core/owner-questions.js";
import type { MobileSource, SourceView } from "./adapter.js";
import type { Capability, ChatItem, Event, Hello, Job, Page, Question, Session, Snapshot } from "./contract.js";
import { MobilePush } from "./push.js";
import { digest, MobileFault, MobileStore, secret, type Device, type Principal } from "./store.js";

export interface MobileRequest { method: string; path: string; headers: Record<string, string | undefined>; body?: string; authority: string; tls: boolean; pinning?: boolean; remoteAddress: string }
export interface MobileResponse { status: number; headers: Record<string, string>; body?: unknown }
export interface GatewayDiagnostic { requestId: string; errorCategory: "unexpected_gateway_exception" | "gateway_shutdown_timeout" }
export type GatewayDiagnosticSink = (diagnostic: GatewayDiagnostic) => void;
const uuid = z.string().uuid(), id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), token = z.string().min(40).max(256);
const answerSchema = z.object({ expectedVersion: token, option: z.string().min(1).max(40).optional(), text: z.string().min(1).max(8000).optional() }).strict().refine(a => !!a.option !== !!a.text);
const pushSchema = z.object({ expoPushToken: z.string().regex(/^(Expo|Exponent)PushToken\[[\w-]+\]$/).max(256), platform: z.enum(["android", "ios"]), projectId: uuid, environment: z.enum(["development", "production"]) }).strict();
const CAPS: Capability[] = ["overview.read", "chat.read", "questions.read", "questions.answer"];
interface View { snapshot: Snapshot; all: SourceView; signature: string; deviceRevision: string }
interface WriteProof { epoch: string; sessionId: string; accessHash: string; grantHash: string; sampledAt: number }
interface CursorRecord { deviceId: string; revision: string; kind: string; expiresAt: number; viewCursor: string; payload?: unknown; writeProof?: WriteProof }
interface CollectionCursor { items: unknown[]; offset: number; generation: string }
interface ContentCursor { remaining: unknown[]; nativeNext: string | null; generation: string; entityId: string }

/** Inert dispatcher. Only https.ts can adapt it to an explicitly provisioned TLS listener. */
export class MobileGateway {
  readonly epoch = randomUUID();
  private readonly views = new Map<string, View>();
  private readonly cursors = new Map<string, CursorRecord>();
  private readonly rates = new Map<string, { at: number; count: number }>();
  private sampling?: Promise<SourceView>;
  private available = true;
  private readonly inFlight = new Set<Promise<MobileResponse>>();
  private closing?: Promise<void>;
  constructor(readonly store: MobileStore, private readonly source: MobileSource, readonly push = new MobilePush(store),
    private readonly diagnostics: GatewayDiagnosticSink = diagnostic => console.error(diagnostic), private readonly ready: () => boolean = () => true) {}
  hello(pinning = false): Hello { return { apiVersion: 1, capabilities: CAPS, transport: "private-https", pinning, send: "unsupported", pairedPcWrites: "unsupported", push: this.push.configured ? "configured" : "unsupported" }; }
  /** Owned host retirement; no registry reads or writes after it is closed. */
  deactivate(): void { this.available = false; this.views.clear(); this.cursors.clear(); }
  /** Stop admission immediately; settle owned handlers before the host retires its stores. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.deactivate();
    this.closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const drained = await Promise.race([
          Promise.allSettled([...this.inFlight]).then(() => true),
          new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000); }),
        ]);
        if (!drained) {
          try { this.diagnostics({ requestId: randomUUID(), errorCategory: "gateway_shutdown_timeout" }); } catch { /* Content-free diagnostics cannot break disposal. */ }
          throw new MobileFault(503, "gateway_shutdown_timeout");
        }
      } finally { if (timer) clearTimeout(timer); }
    })(); return this.closing;
  }
  private rate(principal: string, max: number): void {
    const now = this.store.now(), prior = this.rates.get(principal);
    if (!prior || now - prior.at >= 60_000) { if (this.rates.size >= 10_000) this.rates.clear(); this.rates.set(principal, { at: now, count: 1 }); return; }
    if (++prior.count > max) throw new MobileFault(429, "rate_limited");
  }
  private cursor(device: Device, kind: string, viewCursor: string, payload?: unknown): string {
    const key = secret();
    if (this.cursors.size >= 10_000) this.cursors.delete(this.cursors.keys().next().value!);
    this.cursors.set(key, { deviceId: device.id, revision: device.revision, kind, expiresAt: this.store.now() + 24 * 60 * 60_000, viewCursor, payload }); return key;
  }
  private fromCursor(device: Device, key: string, kind: string): CursorRecord {
    const c = this.cursors.get(key);
    if (!c || c.deviceId !== device.id || c.revision !== device.revision || c.kind !== kind || c.expiresAt <= this.store.now()) throw new MobileFault(410, "snapshot_required");
    return c;
  }
  private recordWriteProof(principal: Principal, snapshot: Snapshot): void {
    if (snapshot.stale) return;
    const record = this.fromCursor(principal.device, snapshot.cursor, "events");
    record.writeProof = { epoch: this.epoch, sessionId: principal.session.id, accessHash: principal.session.accessHash,
      grantHash: digest("grants", JSON.stringify(principal.device.grants)), sampledAt: snapshot.sampledAt };
  }
  private requireWriteProof(principal: Principal, cursor: string | undefined, snapshot: Snapshot): void {
    const proof = cursor ? this.fromCursor(principal.device, cursor, "events").writeProof : undefined;
    const age = proof ? this.store.now() - proof.sampledAt : Infinity;
    if (!proof || snapshot.stale || proof.epoch !== this.epoch || proof.sessionId !== principal.session.id || proof.accessHash !== principal.session.accessHash ||
      proof.grantHash !== digest("grants", JSON.stringify(principal.device.grants)) || !Number.isFinite(age) || age < 0 || age >= 15_000)
      throw new MobileFault(409, "fresh_snapshot_required");
  }
  private async sample(): Promise<SourceView> {
    if (!this.sampling) this.sampling = this.source.snapshot().finally(() => { this.sampling = undefined; });
    return this.deadline(this.sampling);
  }
  private async deadline<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MobileFault(503, "source_unavailable")), 5000); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  private authorized<T extends Session | Job | Question>(device: Device, kind: "session" | "job" | "question", capability: Capability, entities: T[]): T[] {
    return entities.filter(e => (kind !== "question" || e.pcId === this.store.pcId) && this.store.can(device, capability, e.pcId, { kind, id: e.id, projectId: e.projectId }));
  }
  private collection<T>(device: Device, kind: string, items: T[], count: number, viewCursor: string, offset = 0, generation: string = this.epoch): Page<T> {
    const page = items.slice(offset, offset + count);
    while (page.length > 1 && Buffer.byteLength(JSON.stringify(page)) > 480 * 1024) page.pop();
    const nextOffset = offset + page.length;
    return { items: page, next: nextOffset < items.length ? this.cursor(device, kind, viewCursor, { items, offset: nextOffset, generation } satisfies CollectionCursor) : null, generation, reset: false, sampledAt: this.store.now(), viewCursor };
  }
  private async view(principal: Principal): Promise<View> {
    const raw = await this.sample();
    if (!this.available) throw new MobileFault(503, "source_unavailable");
    // Refresh live device grant/revocation state after every awaited upstream call.
    const device = this.store.get<Device>("device", principal.device.id);
    if (!device || device.revoked) throw new MobileFault(401, "device_revoked");
    if (device.revision !== principal.device.revision) throw new MobileFault(410, "authorization_changed");
    const all: SourceView = { sessions: this.authorized(device, "session", "overview.read", raw.sessions), jobs: this.authorized(device, "job", "overview.read", raw.jobs),
      questions: this.authorized(device, "question", "questions.read", raw.questions), sampledAt: raw.sampledAt, sourceState: raw.sourceState };
    const stale = raw.sourceState !== "ready" || this.store.now() - raw.sampledAt > 15_000;
    if (stale) for (const cursor of this.cursors.values()) if (cursor.deviceId === device.id) cursor.writeProof = undefined;
    const signature = digest("view", JSON.stringify([all.sessions.map(s => [s.id, s.version]), all.jobs.map(j => [j.id, j.version]), all.questions.map(q => [q.id, q.version, q.deliveries]), stale, all.sourceState, device.revision]));
    const old = this.views.get(device.id);
    const oldCursor = old && this.cursors.get(old.snapshot.cursor);
    const cursor = old?.signature === signature && oldCursor && oldCursor.expiresAt > this.store.now() ? old.snapshot.cursor : this.cursor(device, "events", "");
    const capabilities = [...new Set(device.grants.flatMap(g => g.capabilities))];
    const sessions = this.collection(device, "sessions", all.sessions, 20, cursor), jobs = this.collection(device, "jobs", all.jobs, 20, cursor), questions = this.collection(device, "questions", all.questions, 20, cursor);
    const snapshot: Snapshot = { apiVersion: 1, pcId: this.store.pcId, epoch: this.epoch, cursor, sampledAt: raw.sampledAt, stale, capabilities,
      sessions: sessions.items, jobs: jobs.items, questions: questions.items, pages: { sessions: sessions.next, jobs: jobs.next, questions: questions.next }, sourceState: raw.sourceState };
    const result = { snapshot, all, signature, deviceRevision: device.revision }; this.views.set(device.id, result); return result;
  }
  private require(device: Device, capability: Capability): void {
    if (!device.grants.some(g => g.capabilities.includes(capability))) throw new MobileFault(403, "capability_required");
  }
  private async content<T>(principal: Principal, view: View, entityId: string, kind: "chat" | "steps", cursor: string | null, limit: number): Promise<Page<T>> {
    const device = principal.device;
    const parent = kind === "steps" ? view.all.jobs.find(j => j.id === entityId) : view.all.sessions.find(s => s.chatId === entityId) ?? view.all.jobs.find(j => j.chatId === entityId);
    if (!parent) throw new MobileFault(404, "not_found");
    const parentKind = "generation" in parent ? "session" : "job";
    if (!this.store.can(device, kind === "chat" ? "chat.read" : "overview.read", parent.pcId, { kind: parentKind, id: parent.id, projectId: parent.projectId })) throw new MobileFault(404, "not_found");
    let remaining: T[] = [], nativeNext: string | null = null, generation = "", existing = false;
    if (cursor) {
      const c = this.fromCursor(device, cursor, `${kind}:${entityId}`);
      if (c.viewCursor !== view.snapshot.cursor) throw new MobileFault(410, "snapshot_required");
      const payload = c.payload as ContentCursor;
      remaining = payload.remaining as T[]; nativeNext = payload.nativeNext; generation = payload.generation; existing = true;
    }
    if (!existing || remaining.length === 0 && nativeNext) {
      const page = kind === "chat" ? await this.deadline(this.source.chat(entityId, nativeNext ?? undefined, limit)) : await this.deadline(this.source.steps(entityId, nativeNext ?? undefined, limit));
      if (existing && generation !== page.generation || page.reset) throw new MobileFault(410, "snapshot_required");
      remaining = page.items as T[]; generation = page.generation; nativeNext = page.next;
    }
    // Check grants again before content serialization; cannot leak a response after revocation.
    if (!this.available) throw new MobileFault(503, "source_unavailable");
    const active = this.store.get<Device>("device", device.id);
    if (!active || active.revoked) throw new MobileFault(401, "device_revoked");
    if (active.revision !== device.revision) throw new MobileFault(410, "authorization_changed");
    const items = remaining.slice(0, limit);
    while (items.length > 1 && Buffer.byteLength(JSON.stringify(items)) > 480 * 1024) items.pop();
    const rest = remaining.slice(items.length);
    return { items, next: rest.length || nativeNext ? this.cursor(device, `${kind}:${entityId}`, view.snapshot.cursor, { remaining: rest, nativeNext, generation, entityId } satisfies ContentCursor) : null,
      generation, reset: false, sampledAt: this.store.now(), viewCursor: view.snapshot.cursor };
  }
  handle(req: MobileRequest): Promise<MobileResponse> {
    if (!this.available || !this.ready()) return this.dispatch(req);
    // Every admitted request is tracked. A response completing after retirement is
    // discarded in favor of the normal content-free 503, including committed answers.
    const work = this.dispatch(req).then(response => this.available && this.ready() ? response : this.dispatch(req));
    this.inFlight.add(work);
    void work.then(() => this.inFlight.delete(work), () => this.inFlight.delete(work));
    return work;
  }
  private async dispatch(req: MobileRequest): Promise<MobileResponse> {
    const requestId = randomUUID(), headers = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
    try {
      if (!this.available || !this.ready()) throw new MobileFault(503, "source_unavailable");
      const configuredOrigin = this.store.origins.find(o => new URL(o).host === req.authority);
      if (!req.tls || !configuredOrigin) throw new MobileFault(403, "authority");
      if (req.headers.cookie || req.headers.origin && req.headers.origin !== configuredOrigin || req.headers["sec-fetch-site"] === "cross-site") throw new MobileFault(403, "origin");
      const url = new URL(req.path, configuredOrigin);
      if (url.origin !== configuredOrigin || !url.pathname.startsWith("/mobile/v1/")) throw new MobileFault(404, "not_found");
      const route = url.pathname.slice("/mobile/v1".length);
      for (const [key] of url.searchParams) if (url.searchParams.getAll(key).length !== 1) throw new MobileFault(400, "invalid_query");
      if (req.body && Buffer.byteLength(req.body) > 32 * 1024) throw new MobileFault(413, "body_too_large");
      if (req.method === "GET" && req.body) throw new MobileFault(400, "unexpected_body");
      const write = req.method !== "GET";
      const key = write || route.startsWith("/pairing/claims/") ? uuid.parse(req.headers["idempotency-key"]) : "";
      let body: unknown;
      if (req.body !== undefined && req.body.length) {
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) throw new MobileFault(400, "json_required");
        try { body = JSON.parse(req.body); } catch { throw new MobileFault(400, "invalid_json"); }
      }
      const reply = (status: number, result?: unknown): MobileResponse => ({ status, headers, ...(result === undefined ? {} : { body: result }) });
      const allowedQuery = (keys: string[]): void => { for (const [key] of url.searchParams) if (!keys.includes(key)) throw new MobileFault(400, "invalid_query"); };
      if (req.method === "GET" && route === "/hello") { allowedQuery([]); this.rate("hello:" + req.remoteAddress, 30); return reply(200, this.hello(req.pinning === true)); }
      if (req.method === "POST" && route === "/pairing/claims") {
        allowedQuery([]); this.rate("pair:" + req.remoteAddress, 10);
        const args = z.object({ invitationId: uuid, nonce: token, platform: z.enum(["android", "ios"]), deviceName: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/) }).strict().parse(body);
        return reply(202, this.store.claim(args.invitationId, args.nonce, args.deviceName, args.platform, key));
      }
      const claim = /^\/pairing\/claims\/([\w-]+)$/.exec(route);
      if (req.method === "GET" && claim) {
        allowedQuery([]); this.rate("poll:" + req.remoteAddress, 60);
        return reply(200, this.store.pollClaim(uuid.parse(claim[1]), this.bearer(req), key));
      }
      if (req.method === "POST" && route === "/auth/refresh") {
        allowedQuery([]); this.rate("refresh:" + req.remoteAddress, 30);
        if (body !== undefined) z.object({}).strict().parse(body);
        return reply(200, this.store.refresh(this.bearer(req), req.headers["x-mobile-csrf"] ?? "", key));
      }
      const principal = this.store.authenticate(this.bearer(req)), device = principal.device;
      this.rate("device:" + device.id, 120);
      if (write) { this.store.checkCsrf(principal, req.headers["x-mobile-csrf"] ?? ""); this.rate("write:" + device.id, 30); }
      if (req.method === "GET" && route === "/me") {
        allowedQuery([]); return reply(200, { deviceId: device.id, sessionId: principal.session.id, pcId: this.store.pcId, capabilities: [...new Set(device.grants.flatMap(g => g.capabilities))], scopes: device.grants, accessExpiresAt: principal.session.accessExpiresAt, push: this.push.configured ? "configured" : "unsupported", pairedPcReads: "unsupported" });
      }
      if (req.method === "DELETE" && ["/me/session", "/me/push"].includes(route) || req.method === "PUT" && route === "/me/push") {
        allowedQuery([]);
        const args = req.method === "PUT" ? pushSchema.parse(body) : body === undefined ? null : z.object({}).strict().parse(body);
        const result = this.store.mutate(device.id, req.method + route, key, digest("body", JSON.stringify(args)), () => {
          if (route === "/me/session") this.store.revoke(device.id, "logout");
          else if (req.method === "DELETE") this.push.remove(device.id);
          const response = req.method === "PUT" ? this.push.register(device, args as z.infer<typeof pushSchema>) : { state: "removed" };
          return { response, replay: response };
        });
        return reply(req.method === "PUT" ? 200 : 204, req.method === "PUT" ? result : undefined);
      }
      const view = await this.view(principal);
      if (req.method === "GET" && route === "/snapshot") { allowedQuery([]); this.recordWriteProof(principal, view.snapshot); return reply(200, view.snapshot); }
      if (req.method === "GET" && route === "/events") {
        allowedQuery(["after"]); const after = url.searchParams.get("after");
        if (!after) throw new MobileFault(400, "cursor_required");
        this.fromCursor(device, after, "events");
        const events: Event[] = after === view.snapshot.cursor ? [] : [{ apiVersion: 1, epoch: this.epoch, cursor: view.snapshot.cursor, type: "snapshot.required", resource: { kind: "snapshot", id: this.store.pcId }, version: view.signature, at: view.snapshot.sampledAt }];
        return reply(200, { events, next: view.snapshot.cursor, sampledAt: view.snapshot.sampledAt, reset: events.length > 0 });
      }
      const list = route.slice(1);
      if (req.method === "GET" && ["sessions", "jobs", "questions"].includes(list)) {
        allowedQuery(list === "questions" ? ["cursor", "limit", "status"] : ["cursor", "limit"]);
        this.require(device, list === "questions" ? "questions.read" : "overview.read");
        const limit = this.limit(url), cursor = url.searchParams.get("cursor"), status = url.searchParams.get("status");
        if (status && !["open", "answered", "cancelled", "superseded"].includes(status)) throw new MobileFault(400, "invalid_status");
        const kind = `${list}${status ? ":" + status : ""}`;
        if (cursor) {
          const c = this.fromCursor(device, cursor, kind); if (c.viewCursor !== view.snapshot.cursor) throw new MobileFault(410, "snapshot_required");
          const payload = c.payload as CollectionCursor;
          return reply(200, this.collection(device, kind, payload.items, limit, view.snapshot.cursor, payload.offset, payload.generation));
        }
        const items = list === "sessions" ? view.all.sessions : list === "jobs" ? view.all.jobs : view.all.questions.filter(q => !status || q.status === status);
        return reply(200, this.collection<Session | Job | Question>(device, kind, items, limit, view.snapshot.cursor));
      }
      const question = /^\/questions\/([\w-]+)(\/answer)?$/.exec(route);
      if (question) {
        allowedQuery([]); const q = view.all.questions.find(q => q.id === question[1]); if (!q) throw new MobileFault(404, "not_found");
        if (req.method === "GET" && !question[2]) return reply(200, q);
        if (req.method === "POST" && question[2]) {
          const args = answerSchema.parse(body);
          if (q.status === "open" && q.version === args.expectedVersion && args.option && !q.options.some(o => o.id === args.option)) throw new MobileFault(400, "unknown_option");
          // Recheck credentials after sampling; refresh/revocation may have happened while awaiting it.
          const active = this.store.authenticate(this.bearer(req)); this.store.checkCsrf(active, req.headers["x-mobile-csrf"] ?? "");
          if (active.device.revision !== device.revision) throw new MobileFault(410, "authorization_changed");
          if (!this.store.can(active.device, "questions.answer", q.pcId, { kind: "question", id: q.id, projectId: q.projectId }) || q.pcId !== this.store.pcId) throw new MobileFault(404, "not_found");
          // Only a delivered authoritative snapshot mints/renews this <=15-second proof.
          // Events/read/answer sampling cannot renew it; question terms/outcome remain protected by CAS.
          this.requireWriteProof(active, req.headers["x-mobile-view"], view.snapshot);
          // This adapter delegates CAS + durable idempotency atomically to the owner-question store.
          const result = await this.deadline(this.source.answer(q.id, args, device.id, key));
          return reply(200, { question: result, replayExpiresAt: this.store.now() + 24 * 60 * 60_000 });
        }
      }
      const chat = /^\/chats\/([\w-]+)$/.exec(route), steps = /^\/jobs\/([\w-]+)\/steps$/.exec(route);
      if (req.method === "GET" && (chat || steps)) {
        allowedQuery(["cursor", "limit"]); const entity = id.parse(chat?.[1] ?? steps?.[1]);
        return reply(200, await this.content<ChatItem>(principal, view, entity, chat ? "chat" : "steps", url.searchParams.get("cursor"), this.limit(url)));
      }
      const hint = /^\/notifications\/([\w-]+)$/.exec(route);
      if (req.method === "GET" && hint) { allowedQuery([]); return reply(200, this.push.resolve(device, uuid.parse(hint[1]), view.all.questions)); }
      throw new MobileFault(404, "unsupported");
    } catch (error) {
      if (!(error instanceof MobileFault) && !(error instanceof QuestionVersionConflict) && !(error instanceof z.ZodError)) {
        try { this.diagnostics({ requestId, errorCategory: "unexpected_gateway_exception" }); } catch { /* Diagnostics cannot change the response or leak the exception. */ }
      }
      const fault = error instanceof MobileFault ? error : error instanceof QuestionVersionConflict ? new MobileFault(409, "version_conflict", error.currentVersion) : error instanceof z.ZodError ? new MobileFault(400, "invalid_request") : new MobileFault(503, "source_unavailable");
      if (fault.status === 202) return { status: 202, headers, body: { state: "pending" } };
      return { status: fault.status, headers: { ...headers, ...(fault.status === 429 ? { "retry-after": "60" } : {}) }, body: { code: fault.code, message: fault.code.replaceAll("_", " "), requestId, retryable: fault.status === 503 || fault.status === 429, ...(fault.currentVersion ? { currentVersion: fault.currentVersion } : {}) } };
    }
  }
  private bearer(req: MobileRequest): string { const match = /^Bearer ([A-Za-z0-9_-]{40,256})$/.exec(req.headers.authorization ?? ""); if (!match) throw new MobileFault(401, "unauthorized"); return match[1]!; }
  private limit(url: URL): number { const raw = url.searchParams.get("limit") ?? "20"; if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 100) throw new MobileFault(400, "invalid_limit"); return Number(raw); }
}
