import type { ChatItem, ClaimResult, Credentials, GatewayError, Hello, Job, Page, PairingClaim, PairingQr, Platform, Question, Session, Snapshot } from "../../../src/mobile/contract";

export interface StoredDevice { origins: string[]; preferredOrigin: string; credentials: Credentials; pins?: string[]; pinning?: true }
export interface SecureCredentials { load(): Promise<StoredDevice | null>; save(device: StoredDevice): Promise<void>; clear(): Promise<void> }
export interface WireResponse { status: number; ok: boolean; redirected: boolean; url: string; text(): Promise<string> }
/** Native transport must enforce redirect:error before a follow; Expo's native fetch is used. */
export type WireFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: "error"; credentials: "omit"; cache: "no-store"; signal: AbortSignal }, pins?: readonly string[]) => Promise<WireResponse>;
export type Connection = "unpaired" | "reconnecting" | "ready" | "stale" | "offline" | "background" | "revoked";
export class ClientFault extends Error { constructor(readonly code: string, readonly status = 0, readonly unconfirmed = false) { super(code.replaceAll("_", " ")); } }
export interface ClientState { connection: Connection; snapshot: Snapshot | null; writePending: boolean; notice: string | null }
export function exactOrigins(origins: unknown): string[] {
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > 8 || origins.some(o => typeof o !== "string")) throw new ClientFault("invalid_pairing");
  for (const origin of origins as string[]) { const url = new URL(origin); if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new ClientFault("trusted_https_required"); }
  return [...new Set(origins as string[])];
}
/** Nonempty canonical SHA-256 SPKI digest set. Missing/empty pins never mean unpinned. */
export function exactPins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 || value.some(pin => typeof pin !== "string" || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(pin)) || new Set(value).size !== value.length) throw new ClientFault("invalid_pins");
  return [...value];
}
export function parseQr(payload: string, now = Date.now()): PairingQr {
  if (payload.length > 4096) throw new ClientFault("invalid_pairing");
  const q = JSON.parse(payload) as PairingQr;
  if (!q || (q.v !== 1 && q.v !== 2) || typeof q.pcId !== "string" || q.pcId.length > 128 || !/^[\w-]{1,128}$/.test(q.invitationId) || !/^[\w-]{43}$/.test(q.nonce) || q.expiresAt <= now || q.expiresAt > now + 120_000 || Object.keys(q).some(k => !["v", "origin", "origins", "pcId", "invitationId", "nonce", "expiresAt", ...(q.v === 2 ? ["pins"] : [])].includes(k))) throw new ClientFault("invalid_pairing");
  if (q.v === 2) q.pins = exactPins(q.pins);
  q.origins = exactOrigins(q.origins); if (!q.origins.includes(q.origin)) throw new ClientFault("invalid_pairing"); return q;
}

/** No AsyncStorage, disk content cache, offline writes, write retries or write failover. */
export class MobileClient {
  state: ClientState = { connection: "unpaired", snapshot: null, writePending: false, notice: null };
  private device: StoredDevice | null = null;
  private listeners = new Set<() => void>();
  private foreground = true;
  private generation = 0;
  private controllers = new Set<AbortController>();
  private reconnecting?: Promise<void>;
  private refreshing?: Promise<void>;
  private syncing?: Promise<void>;
  private initializing?: Promise<void>;
  private claim?: { qr: PairingQr; origin: string; claim: PairingClaim; issueKey: string };
  constructor(private readonly wire: WireFetch, private readonly secure: SecureCredentials, private readonly uuid: () => string, private readonly now: () => number = Date.now) {}
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private update(patch: Partial<ClientState>): void { this.state = { ...this.state, ...patch }; for (const fn of this.listeners) fn(); }
  get writesEnabled(): boolean { return this.foreground && this.state.connection === "ready" && !this.state.writePending && !!this.device && this.device.credentials.accessExpiresAt > this.now() && !!this.state.snapshot && !this.state.snapshot.stale && this.now() - this.state.snapshot.sampledAt < 15_000; }
  canAnswer(question: Question): boolean {
    return this.writesEnabled && question.pcId === this.device?.credentials.pcId && question.status === "open" && !!this.device?.credentials.scopes.some(g => g.pcId === question.pcId && g.projectIds.includes(question.projectId) && g.capabilities.includes("questions.answer"));
  }
  get approvedOrigins(): readonly string[] { return this.device?.origins ?? []; }
  get preferredOrigin(): string | null { return this.device?.preferredOrigin ?? null; }
  async initialize(): Promise<void> {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const saved = await this.secure.load(); if (!saved) return;
      saved.origins = exactOrigins(saved.origins);
      if (saved.pinning && saved.pins === undefined) throw new ClientFault("invalid_pins");
      if (saved.pins !== undefined) { saved.pins = exactPins(saved.pins); saved.pinning = true; }
      if (!saved.origins.includes(saved.preferredOrigin)) throw new ClientFault("invalid_credentials");
      this.device = saved; await this.reconnect();
    })().finally(() => { this.initializing = undefined; });
    return this.initializing;
  }
  setForeground(active: boolean): void {
    this.foreground = active; this.generation++;
    if (!active) { for (const controller of this.controllers) controller.abort(); this.update({ connection: "background" }); }
    else if (this.device) { this.update({ connection: "reconnecting" }); void this.reconnect().catch(() => {}); }
  }
  private async request<T>(origin: string, origins: readonly string[], path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown, pins: readonly string[] | undefined = this.device?.pins ?? this.claim?.qr.pins): Promise<T> {
    if (!origins.includes(origin) || !path.startsWith("/mobile/v1/") || path.includes("\\")) throw new ClientFault("unapproved_origin");
    if (pins !== undefined) exactPins(pins);
    const requestUrl = origin + path, url = new URL(requestUrl); if (url.origin !== origin) throw new ClientFault("unapproved_origin");
    const controller = new AbortController(); this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.wire(requestUrl, { method, headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: "error", credentials: "omit", cache: "no-store", signal: controller.signal }, pins);
      if (response.redirected || response.url && response.url !== requestUrl || response.status >= 300 && response.status < 400) throw new ClientFault("redirect_rejected", response.status, method !== "GET");
      const text = await response.text(); if (text.length > 512 * 1024) throw new ClientFault("response_too_large");
      const value = text ? JSON.parse(text) : null;
      if (!response.ok) throw new ClientFault((value as GatewayError)?.code ?? "request_failed", response.status, method !== "GET" && response.status >= 500);
      return value as T;
    } catch (error) { if (error instanceof ClientFault) throw error; throw new ClientFault(method === "GET" ? "unreachable" : "outcome_unconfirmed", 0, method !== "GET"); }
    finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
  private auth(): Record<string, string> { if (!this.device) throw new ClientFault("unpaired"); return { authorization: "Bearer " + this.device.credentials.accessToken }; }
  private async chooseOrigin(origins: string[], preferred: string, pins?: readonly string[]): Promise<string> {
    for (const origin of [preferred, ...origins.filter(o => o !== preferred)]) {
      try { const hello = await this.request<Hello>(origin, origins, "/mobile/v1/hello", "GET", {}, undefined, pins); if (hello.apiVersion === 1 && hello.transport === "private-https" && hello.pinning === (pins !== undefined)) return origin; } catch (error) { if (error instanceof ClientFault && error.code === "unapproved_origin") throw error; }
    }
    throw new ClientFault("unreachable");
  }
  async beginPairing(qr: PairingQr, deviceName: string, platform: Platform): Promise<PairingClaim> {
    if (this.device) throw new ClientFault("already_paired");
    qr = parseQr(JSON.stringify(qr), this.now());
    const origin = await this.chooseOrigin(qr.origins, qr.origin, qr.pins);
    const claim = await this.request<PairingClaim>(origin, qr.origins, "/mobile/v1/pairing/claims", "POST", { "idempotency-key": this.uuid() }, { invitationId: qr.invitationId, nonce: qr.nonce, deviceName, platform }, qr.pins);
    if (!claim.claimToken || !claim.claimId || !/^\d{6}$/.test(claim.comparisonCode) || claim.expiresAt > qr.expiresAt) throw new ClientFault("pairing_unconfirmed");
    this.claim = { qr, origin, claim, issueKey: this.uuid() }; return claim;
  }
  async pollPairing(): Promise<ClaimResult> {
    const pending = this.claim; if (!pending) throw new ClientFault("pairing_unconfirmed");
    if (this.now() >= pending.claim.expiresAt) { this.claim = undefined; throw new ClientFault("pairing_expired"); }
    let result: ClaimResult;
    try { result = await this.request<ClaimResult>(pending.origin, pending.qr.origins, `/mobile/v1/pairing/claims/${pending.claim.claimId}`, "GET", { authorization: "Bearer " + pending.claim.claimToken, "idempotency-key": pending.issueKey }); }
    catch (error) { this.claim = undefined; throw new ClientFault("pairing_unconfirmed", error instanceof ClientFault ? error.status : 0, true); }
    if (result.state === "approved") {
      if (result.credentials.pcId !== pending.qr.pcId) throw new ClientFault("pc_identity_mismatch");
      this.device = { origins: pending.qr.origins, preferredOrigin: pending.origin, credentials: result.credentials, ...(pending.qr.pins ? { pins: [...pending.qr.pins], pinning: true as const } : {}) };
      try { await this.secure.save(this.device); } catch { this.device = null; this.claim = undefined; throw new ClientFault("pairing_unconfirmed", 0, true); }
      this.claim = undefined; await this.reconnect(false);
    } else if (result.state !== "pending") this.claim = undefined;
    return result;
  }
  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const device = this.device!;
      const next = await this.request<Credentials | { state: "issued" }>(device.preferredOrigin, device.origins, "/mobile/v1/auth/refresh", "POST", { authorization: "Bearer " + device.credentials.refreshToken, "x-mobile-csrf": device.credentials.csrfToken, "idempotency-key": this.uuid() });
      if (!("accessToken" in next) || next.pcId !== device.credentials.pcId || next.deviceId !== device.credentials.deviceId || next.sessionId !== device.credentials.sessionId) throw new ClientFault("refresh_unconfirmed", 0, true);
      const updated = { ...device, credentials: next };
      // Keychain/Keystore durability precedes accepting the rotation in memory.
      await this.secure.save(updated); this.device = updated;
    })().catch(error => {
      if (error instanceof ClientFault && error.status >= 400 && !error.unconfirmed) throw error;
      throw new ClientFault("refresh_unconfirmed", 0, true);
    }).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  async reconnect(rotate = true): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    if (!this.device || !this.foreground) return;
    const generation = this.generation; this.update({ connection: "reconnecting", notice: null });
    this.reconnecting = (async () => {
      const device = this.device!;
      const selected = await this.chooseOrigin(device.origins, device.preferredOrigin, device.pins);
      this.device = { ...device, preferredOrigin: selected };
      if (rotate) await this.refresh();
      const me = await this.request<{ pcId: string; deviceId: string; sessionId: string }>(selected, device.origins, "/mobile/v1/me", "GET", this.auth());
      if (me.pcId !== device.credentials.pcId || me.deviceId !== device.credentials.deviceId || me.sessionId !== device.credentials.sessionId) throw new ClientFault("pc_identity_mismatch");
      const snapshot = await this.request<Snapshot>(selected, device.origins, "/mobile/v1/snapshot", "GET", this.auth());
      if (snapshot.apiVersion !== 1 || snapshot.pcId !== device.credentials.pcId || !snapshot.epoch || !snapshot.cursor) throw new ClientFault("pc_identity_mismatch");
      if (generation !== this.generation || !this.foreground) return;
      this.update({ snapshot, connection: snapshot.stale || snapshot.sourceState !== "ready" || this.now() - snapshot.sampledAt >= 15_000 ? "stale" : "ready" });
    })().catch(async error => {
      if (generation === this.generation) await this.fail(error);
      throw error;
    }).finally(() => { this.reconnecting = undefined; });
    return this.reconnecting;
  }
  private async fail(error: unknown): Promise<void> {
    const fault = error instanceof ClientFault ? error : new ClientFault("outcome_unconfirmed", 0, true);
    if (["device_revoked", "refresh_reuse", "pc_identity_mismatch", "refresh_unconfirmed"].includes(fault.code)) {
      this.device = null; await this.secure.clear(); this.update({ snapshot: null, connection: "revoked", notice: fault.message });
    } else this.update({ connection: "offline", notice: fault.unconfirmed ? "Outcome unconfirmed. Check the PC before pairing or submitting again." : fault.message });
  }
  async sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    if (!this.device || !this.foreground || this.reconnecting) return;
    if (this.device.credentials.accessExpiresAt <= this.now() + 30_000 || this.state.connection !== "ready") return this.reconnect();
    const generation = this.generation;
    this.syncing = (async () => {
      const device = this.device!, current = this.state.snapshot!;
      await this.request(device.preferredOrigin, device.origins, `/mobile/v1/events?after=${encodeURIComponent(current.cursor)}`, "GET", this.auth());
      const snapshot = await this.request<Snapshot>(device.preferredOrigin, device.origins, "/mobile/v1/snapshot", "GET", this.auth());
      if (snapshot.pcId !== device.credentials.pcId || snapshot.apiVersion !== 1) throw new ClientFault("pc_identity_mismatch");
      if (generation !== this.generation || !this.foreground) return;
      this.update({ snapshot, connection: snapshot.stale || snapshot.sourceState !== "ready" || this.now() - snapshot.sampledAt >= 15_000 ? "stale" : "ready", notice: null });
    })().catch(async error => {
      if (error instanceof ClientFault && error.status === 410) { this.update({ snapshot: null, connection: "reconnecting" }); await this.reconnect(false); }
      else if (generation === this.generation) await this.fail(error);
    }).finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  async page<T>(path: string): Promise<Page<T>> {
    if (!this.device || !this.foreground) throw new ClientFault("reconnecting");
    const device = this.device, generation = this.generation;
    const page = await this.request<Page<T>>(device.preferredOrigin, device.origins, "/mobile/v1" + path, "GET", this.auth());
    if (generation !== this.generation || page.viewCursor !== this.state.snapshot?.cursor) throw new ClientFault("snapshot_required", 410);
    return page;
  }
  async answer(question: Question, choice: { option: string } | { text: string }): Promise<Question> {
    if (!this.canAnswer(question) || !this.device || !this.state.snapshot) throw new ClientFault("fresh_snapshot_required");
    const device = this.device, snapshot = this.state.snapshot;
    this.update({ writePending: true, notice: null });
    try {
      const response = await this.request<{ question: Question }>(device.preferredOrigin, device.origins, `/mobile/v1/questions/${encodeURIComponent(question.id)}/answer`, "POST",
        { ...this.auth(), "x-mobile-csrf": device.credentials.csrfToken, "x-mobile-view": snapshot.cursor, "idempotency-key": this.uuid() }, { expectedVersion: question.version, ...choice });
      this.update({ notice: "Answer saved. Delivery and consumption are separate." });
      await this.sync(); return response.question;
    } catch (error) { await this.fail(error); throw error; }
    finally { this.update({ writePending: false }); }
  }
  async resolveNotification(opaqueId: string): Promise<string | null> {
    if (!/^[\w-]{1,128}$/.test(opaqueId)) throw new ClientFault("notification_gone");
    if (this.initializing) await this.initializing;
    await this.reconnect(); if (!this.device || this.state.connection !== "ready") return null;
    const result = await this.request<{ questionId: string }>(this.device.preferredOrigin, this.device.origins, `/mobile/v1/notifications/${opaqueId}`, "GET", this.auth()); return result.questionId;
  }
  async registerPush(registration: { expoPushToken: string; platform: Platform; projectId: string; environment: "development" | "production" }): Promise<void> {
    if (!this.writesEnabled || !this.device) throw new ClientFault("fresh_snapshot_required");
    const d = this.device;
    await this.request(d.preferredOrigin, d.origins, "/mobile/v1/me/push", "PUT", { ...this.auth(), "x-mobile-csrf": d.credentials.csrfToken, "idempotency-key": this.uuid() }, registration);
  }
  async forget(): Promise<void> { this.generation++; for (const controller of this.controllers) controller.abort(); this.device = null; this.claim = undefined; await this.secure.clear(); this.update({ snapshot: null, connection: "unpaired", notice: "Revoke this device on the PC to invalidate its credentials.", writePending: false }); }
}
export type { ChatItem, Job, Page, Question, Session };
