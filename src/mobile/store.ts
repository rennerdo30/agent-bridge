import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Capability, ClaimResult, Credentials, Grant, PairingClaim, PairingQr, Platform } from "./contract.js";

export const secret = (): string => randomBytes(32).toString("base64url");
export const digest = (domain: string, value: string): string => createHash("sha256").update(domain + "\0" + value).digest("hex");
export function equal(a: string, b: string): boolean { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
export class MobileFault extends Error {
  constructor(readonly status: number, readonly code: string, readonly currentVersion?: string) { super(code); }
}
export interface Device { id: string; name: string; platform: Platform; pairedAt: number; revoked: boolean; revision: string; grants: Grant[] }
interface SessionRecord { id: string; deviceId: string; accessHash: string; refreshHash: string; csrfHash: string; retired: string[]; accessExpiresAt: number; refreshExpiresAt: number; revoked: boolean }
interface Invitation { id: string; nonceHash: string; expiresAt: number; claimed: boolean }
interface ClaimRecord { id: string; tokenHash: string; code: string; name: string; platform: Platform; expiresAt: number; state: "pending" | "approved" | "denied" | "issued"; deviceId?: string }
export interface Principal { device: Device; session: SessionRecord }
const ACCESS_MS = 5 * 60_000, REFRESH_MS = 30 * 24 * 60 * 60_000;

/** Dedicated registry. Caller supplies a private writable path; never opens the desktop store. */
export class MobileStore {
  private readonly db: DatabaseSync;
  private transactionDepth = 0;
  readonly origins: string[];
  constructor(file: string, readonly pcId: string, readonly origin: string, readonly now: () => number = Date.now, alternateOrigins: string[] = []) {
    this.origins = [...new Set([origin, ...alternateOrigins])];
    if (this.origins.length > 8) throw new Error("At most eight private HTTPS addresses");
    for (const configured of this.origins) {
      const url = new URL(configured);
      if (url.protocol !== "https:" || url.origin !== configured || url.username || url.password) throw new Error("Provision an exact trusted HTTPS origin");
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS mobile_records(kind TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS mobile_replays(principal TEXT NOT NULL,route TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,
        state TEXT NOT NULL,result TEXT,expires_at INTEGER NOT NULL,PRIMARY KEY(principal,route,key));`);
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    if (this.transactionDepth) return fn();
    this.db.exec("BEGIN IMMEDIATE"); this.transactionDepth++;
    try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (err) { this.db.exec("ROLLBACK"); throw err; } finally { this.transactionDepth--; }
  }
  get<T>(kind: string, id: string): T | undefined { const row = this.db.prepare("SELECT record FROM mobile_records WHERE kind=? AND id=?").get(kind, id); return row ? JSON.parse(String(row.record)) as T : undefined; }
  put(kind: string, id: string, record: unknown): void { this.db.prepare("INSERT INTO mobile_records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET record=excluded.record").run(kind, id, JSON.stringify(record)); }
  list<T>(kind: string): T[] { return this.db.prepare("SELECT record FROM mobile_records WHERE kind=?").all(kind).map(row => JSON.parse(String(row.record)) as T); }
  remove(kind: string, id: string): void { this.db.prepare("DELETE FROM mobile_records WHERE kind=? AND id=?").run(kind, id); }
  replay(principal: string, route: string, key: string, hash: string): { state: string; result: unknown; expiresAt: number } | undefined {
    const prior = this.db.prepare("SELECT * FROM mobile_replays WHERE principal=? AND route=? AND key=?").get(principal, route, key);
    if (!prior) return undefined;
    if (prior.hash !== hash || Number(prior.expires_at) <= this.now()) throw new MobileFault(409, "idempotency_conflict");
    return { state: String(prior.state), result: prior.result ? JSON.parse(String(prior.result)) : null, expiresAt: Number(prior.expires_at) };
  }
  reserve(principal: string, route: string, key: string, hash: string): void {
    this.db.prepare("INSERT INTO mobile_replays VALUES(?,?,?,?,?,?,?)").run(principal, route, key, hash, "unconfirmed", null, this.now() + 24 * 60 * 60_000);
  }
  finish(principal: string, route: string, key: string, result: unknown): void {
    this.db.prepare("UPDATE mobile_replays SET state='recorded',result=? WHERE principal=? AND route=? AND key=?").run(JSON.stringify(result), principal, route, key);
  }
  mutate<T>(principal: string, route: string, key: string, hash: string, fn: () => { response: T; replay: unknown }): T | unknown {
    return this.transaction(() => {
      const prior = this.replay(principal, route, key, hash); if (prior) return prior.result ?? { state: "unconfirmed" };
      this.reserve(principal, route, key, hash);
      const result = fn(); this.finish(principal, route, key, result.replay); return result.response;
    });
  }
  invite(): PairingQr {
    const pending = this.list<Invitation>("invite").filter(i => i.expiresAt > this.now());
    if (pending.length >= 10) throw new MobileFault(429, "pairing_limit");
    const id = randomUUID(), nonce = secret(), expiresAt = this.now() + 120_000;
    this.put("invite", id, { id, nonceHash: digest("qr", nonce), expiresAt, claimed: false } satisfies Invitation);
    return { v: 1, origin: this.origin, origins: [...this.origins], pcId: this.pcId, invitationId: id, nonce, expiresAt };
  }
  claim(invitationId: string, nonce: string, name: string, platform: Platform, key: string): PairingClaim | unknown {
    return this.mutate("invite:" + invitationId, "claim", key, digest("claim-body", JSON.stringify([nonce, name, platform])), () => {
      const invite = this.get<Invitation>("invite", invitationId);
      if (!invite || !equal(invite.nonceHash, digest("qr", nonce)) || invite.expiresAt <= this.now() || invite.claimed) throw new MobileFault(409, "pairing_expired_or_consumed");
      invite.claimed = true; this.put("invite", invitationId, invite);
      const id = randomUUID(), token = secret(), code = String(randomBytes(4).readUInt32BE() % 1_000_000).padStart(6, "0");
      this.put("claim", id, { id, tokenHash: digest("claim", token), code, name, platform, expiresAt: invite.expiresAt, state: "pending" } satisfies ClaimRecord);
      return { response: { claimId: id, claimToken: token, comparisonCode: code, expiresAt: invite.expiresAt }, replay: { state: "claimed", claimId: id } };
    });
  }
  pending(): { claimId: string; name: string; platform: Platform; comparisonCode: string; expiresAt: number }[] {
    return this.list<ClaimRecord>("claim").filter(c => c.state === "pending" && c.expiresAt > this.now()).map(c => ({ claimId: c.id, name: c.name, platform: c.platform, comparisonCode: c.code, expiresAt: c.expiresAt }));
  }
  confirm(claimId: string, comparisonCode: string, allow: boolean, grants: Grant[]): void {
    this.transaction(() => {
      const claim = this.get<ClaimRecord>("claim", claimId);
      if (!claim || claim.expiresAt <= this.now() || claim.state !== "pending" || !equal(claim.code, comparisonCode)) throw new MobileFault(409, "pairing_conflict");
      if (grants.some(g => g.pcId !== this.pcId && g.capabilities.includes("questions.answer"))) throw new MobileFault(403, "remote_write_unsupported");
      claim.state = allow ? "approved" : "denied";
      if (allow) {
        const device: Device = { id: randomUUID(), name: claim.name, platform: claim.platform, pairedAt: this.now(), revoked: false, revision: randomUUID(), grants };
        this.put("device", device.id, device); claim.deviceId = device.id;
      }
      this.put("claim", claimId, claim);
    });
  }
  pollClaim(id: string, token: string, key: string): ClaimResult | unknown {
    return this.mutate<ClaimResult>("claim:" + id, "issue", key, digest("claim-issue", token), () => {
      const claim = this.get<ClaimRecord>("claim", id);
      if (!claim || !equal(claim.tokenHash, digest("claim", token))) throw new MobileFault(401, "unauthorized");
      // Pending polling must not consume an issuance idempotency key.
      if (claim.state === "pending") throw new MobileFault(claim.expiresAt <= this.now() ? 410 : 202, claim.expiresAt <= this.now() ? "pairing_expired" : "pairing_pending");
      if (claim.expiresAt <= this.now()) return { response: { state: "expired" }, replay: { state: "expired" } };
      if (claim.state !== "approved") return { response: { state: claim.state }, replay: { state: claim.state } };
      const device = this.get<Device>("device", claim.deviceId!)!;
      if (device.revoked) throw new MobileFault(401, "device_revoked");
      const credentials = this.issue(device);
      claim.state = "issued"; this.put("claim", id, claim);
      return { response: { state: "approved", credentials }, replay: { state: "issued" } };
    });
  }
  private issue(device: Device, existing?: SessionRecord): Credentials {
    const accessToken = secret(), refreshToken = secret(), csrfToken = secret(), at = this.now();
    const session: SessionRecord = { id: existing?.id ?? randomUUID(), deviceId: device.id, accessHash: digest("access", accessToken), refreshHash: digest("refresh", refreshToken), csrfHash: digest("csrf", csrfToken),
      retired: existing ? [...existing.retired, existing.refreshHash] : [], accessExpiresAt: at + ACCESS_MS, refreshExpiresAt: existing?.refreshExpiresAt ?? at + REFRESH_MS, revoked: false };
    this.put("session", session.id, session);
    const capabilities = [...new Set(device.grants.flatMap(g => g.capabilities))];
    return { deviceId: device.id, sessionId: session.id, pcId: this.pcId, accessToken, refreshToken, csrfToken, accessExpiresAt: session.accessExpiresAt, refreshExpiresAt: session.refreshExpiresAt, capabilities, scopes: device.grants };
  }
  refresh(token: string, csrf: string, key: string): unknown {
    const hash = digest("refresh", token), session = this.list<SessionRecord>("session").find(s => s.refreshHash === hash || s.retired.includes(hash));
    if (!session) throw new MobileFault(401, "unauthorized");
    const device = this.get<Device>("device", session.deviceId)!;
    if (session.revoked || device.revoked) throw new MobileFault(401, "device_revoked");
    const requestHash = digest("refresh-body", JSON.stringify([token, csrf]));
    const prior = this.replay(session.id, "refresh", key, requestHash); if (prior) return prior.result;
    if (session.refreshHash !== hash) { this.revoke(device.id); throw new MobileFault(401, "refresh_reuse"); }
    if (session.refreshExpiresAt <= this.now()) throw new MobileFault(401, "credential_expired");
    if (!equal(session.csrfHash, digest("csrf", csrf))) throw new MobileFault(403, "csrf");
    return this.mutate(session.id, "refresh", key, requestHash, () => {
      const current = this.get<SessionRecord>("session", session.id)!, currentDevice = this.get<Device>("device", device.id)!;
      if (current.revoked || currentDevice.revoked || current.refreshHash !== hash || !equal(current.csrfHash, digest("csrf", csrf))) throw new MobileFault(401, "credential_changed");
      return { response: this.issue(currentDevice, current), replay: { state: "issued" } };
    });
  }
  authenticate(token: string): Principal {
    const hash = digest("access", token), session = this.list<SessionRecord>("session").find(s => equal(s.accessHash, hash));
    if (!session) throw new MobileFault(401, "unauthorized");
    const device = this.get<Device>("device", session.deviceId)!;
    if (device.revoked || session.revoked) throw new MobileFault(401, "device_revoked");
    if (session.accessExpiresAt <= this.now()) throw new MobileFault(401, "credential_expired");
    return { device, session };
  }
  checkCsrf(principal: Principal, csrf: string): void { if (!equal(principal.session.csrfHash, digest("csrf", csrf))) throw new MobileFault(403, "csrf"); }
  devices(): Omit<Device, "grants" | "revision">[] { return this.list<Device>("device").map(({ grants, revision, ...device }) => device); }
  revoke(id: string): void { const device = this.get<Device>("device", id); if (!device) throw new MobileFault(404, "not_found"); device.revoked = true; device.revision = randomUUID(); this.put("device", id, device); this.remove("push", id); }
  can(device: Device, capability: Capability, pcId: string, entity?: { kind: "session" | "job" | "question"; id: string; projectId: string | null }): boolean {
    return device.grants.some(g => g.pcId === pcId && g.capabilities.includes(capability) && (!entity || (entity.kind === "session" ? g.sessionIds.includes(entity.id) : entity.kind === "job" ? g.jobIds.includes(entity.id) : !!entity.projectId && g.projectIds.includes(entity.projectId))));
  }
}
