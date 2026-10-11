import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientFault, exactOrigins, MobileClient, parseQr, type SecureCredentials, type StoredDevice, type WireFetch, type WireResponse } from "../apps/mobile/src/client.js";
import type { Credentials, PairingQr, Question, Snapshot } from "../src/mobile/contract.js";

const lan = "https://lan.example.test:4443", vpn = "https://pc.tailnet.ts.net", pcId = "fixture-pc";
let at: number, credentials: Credentials, saved: StoredDevice, snapshot: Snapshot, secure: SecureCredentials, client: MobileClient;
let calls: { url: string; init: Parameters<WireFetch>[1] }[], offlineLan: boolean, blocked: ((url: string, init: Parameters<WireFetch>[1]) => Promise<WireResponse | undefined>) | undefined;
let q: Question;
function response(url: string, value: unknown, status = 200): WireResponse { return { url, status, ok: status < 300, redirected: false, text: async () => JSON.stringify(value) }; }
beforeEach(() => {
  at = Date.now(); offlineLan = false; calls = []; blocked = undefined;
  credentials = { deviceId: "device", sessionId: "session", pcId, accessToken: "a".repeat(43), refreshToken: "r".repeat(43), csrfToken: "c".repeat(43), accessExpiresAt: at + 300_000, refreshExpiresAt: at + 86_400_000, capabilities: ["questions.read", "questions.answer"], scopes: [] };
  saved = { origins: [lan, vpn], preferredOrigin: lan, credentials };
  q = { id: randomUUID(), kind: "question", pcId, projectId: "project", title: "Fixture terms", context: "Fixture content", topic: "fixture", options: [{ id: "keep", label: "Keep", consequence: "Retain", recommended: true }, { id: "wait", label: "Wait", consequence: "Delay", recommended: false }], links: [], blocking: true, blocks: "Action", meanwhile: "Read", destructive: false, authorization: false, urgency: "normal", declaredDefault: null, status: "open", askedAt: at, version: "v".repeat(43), answer: null, deliveries: [], dismissal: null };
  snapshot = { apiVersion: 1, pcId, epoch: "epoch", cursor: "cursor", sampledAt: at, stale: false, sourceState: "ready", capabilities: ["questions.read", "questions.answer"], sessions: [], jobs: [], questions: [q], pages: { sessions: null, jobs: null, questions: null } };
  secure = { load: vi.fn(async () => saved), save: vi.fn(async value => { saved = value; }), clear: vi.fn(async () => {}) };
  const wire: WireFetch = async (url, init) => {
    calls.push({ url, init });
    if (blocked) { const result = await blocked(url, init); if (result) return result; }
    if (offlineLan && url.startsWith(lan)) throw new Error("fixture unreachable");
    const path = new URL(url).pathname;
    if (path.endsWith("/hello")) return response(url, { apiVersion: 1, transport: "private-https", pinning: false });
    if (path.endsWith("/auth/refresh")) return response(url, { ...credentials, accessToken: "n".repeat(43), refreshToken: "s".repeat(43), csrfToken: "d".repeat(43) });
    if (path.endsWith("/me")) return response(url, { pcId, deviceId: credentials.deviceId, sessionId: credentials.sessionId });
    if (path.endsWith("/snapshot")) return response(url, snapshot);
    if (path.endsWith("/events")) return response(url, { events: [], next: snapshot.cursor, reset: false });
    if (path.endsWith("/answer")) return response(url, { question: { ...q, status: "answered" } });
    return response(url, { code: "unsupported" }, 404);
  };
  client = new MobileClient(wire, secure, randomUUID, () => at);
});
async function initialized(): Promise<void> { await client.initialize(); calls.length = 0; }
function qr(): PairingQr { return { v: 1, origin: lan, origins: [lan, vpn], pcId, invitationId: randomUUID(), nonce: "q".repeat(43), expiresAt: at + 120_000 }; }
describe("mobile memory, freshness and write intent", () => {
  it("keeps content in memory and stores only approved origins and credentials", async () => {
    await client.initialize(); expect(client.writesEnabled).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(q.context); expect(JSON.stringify(saved)).not.toContain(q.title);
    expect(saved.origins).toEqual([lan, vpn]); expect(saved.preferredOrigin).toBe(lan);
    expect((secure.save as ReturnType<typeof vi.fn>).mock.calls[0]![0]).not.toHaveProperty("snapshot");
  });
  it("disables stale/offline writes without sending or replaying them", async () => {
    await initialized(); at += 15_001;
    await expect(client.answer(q, { option: "keep" })).rejects.toThrow("fresh snapshot required"); expect(calls).toHaveLength(0);
    snapshot.sampledAt = at; await client.reconnect(false); calls.length = 0;
    blocked = async () => { throw new Error("fixture loss"); }; await client.sync();
    expect(client.state.connection).toBe("offline"); const before = calls.length;
    await expect(client.answer(q, { option: "keep" })).rejects.toThrow("fresh snapshot required"); expect(calls.length).toBe(before);
    blocked = undefined; await client.reconnect(); expect(calls.filter(c => c.init.method === "POST" && c.url.endsWith("/answer"))).toHaveLength(0);
  });
  it("unlocks writes only after a fresh authenticated snapshot on reconnect", async () => {
    await initialized(); let release!: () => void;
    blocked = async url => { if (url.endsWith("/snapshot")) { await new Promise<void>(resolve => { release = resolve; }); } return undefined; };
    const pending = client.reconnect(); while (!release) await Promise.resolve();
    expect(client.state.connection).toBe("reconnecting"); expect(client.writesEnabled).toBe(false);
    await expect(client.answer(q, { option: "keep" })).rejects.toThrow("fresh snapshot required"); release(); await pending;
    expect(client.writesEnabled).toBe(true);
  });
  it("does not apply a delayed snapshot after background suspension", async () => {
    await initialized(); let release!: () => void;
    blocked = async url => { if (url.endsWith("/snapshot")) await new Promise<void>(resolve => { release = resolve; }); return undefined; };
    const pending = client.reconnect(false); while (!release) await Promise.resolve(); client.setForeground(false); release(); await pending;
    expect(client.state.connection).toBe("background"); expect(client.writesEnabled).toBe(false);
  });
  it("submits one exact CAS intent and blocks double tap while in-flight", async () => {
    await initialized(); let release!: () => void;
    blocked = async url => { if (url.endsWith("/answer")) await new Promise<void>(resolve => { release = resolve; }); return undefined; };
    const pending = client.answer(q, { text: "Exact\nowner intent" }); while (!release) await Promise.resolve();
    await expect(client.answer(q, { option: "wait" })).rejects.toThrow("fresh snapshot required"); release(); await pending;
    const writes = calls.filter(c => c.url.endsWith("/answer")); expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.init.body!)).toEqual({ expectedVersion: q.version, text: "Exact\nowner intent" });
    expect(writes[0]!.init.headers["x-mobile-view"]).toBe("cursor"); expect(writes[0]!.init.headers["idempotency-key"]).toMatch(/^[\da-f-]{36}$/i);
  });
  it("leaves an ambiguous answer unconfirmed with no automatic write retry/failover", async () => {
    await initialized(); blocked = async (url, init) => { if (url.endsWith("/answer")) throw new Error("fixture timeout after dispatch"); return undefined; };
    await expect(client.answer(q, { option: "keep" })).rejects.toBeInstanceOf(ClientFault);
    expect(client.state.notice).toContain("Outcome unconfirmed"); expect(client.writesEnabled).toBe(false);
    blocked = undefined; await client.reconnect(); await client.sync();
    const writes = calls.filter(c => c.url.endsWith("/answer")); expect(writes).toHaveLength(1); expect(writes[0]!.url.startsWith(lan)).toBe(true);
  });
  it("clears prior content on revocation and rejects mismatched page watermarks", async () => {
    await initialized(); blocked = async url => url.includes("/events?") ? response(url, { code: "device_revoked" }, 401) : undefined;
    await client.sync(); expect(client.state.snapshot).toBeNull(); expect(client.state.connection).toBe("revoked"); expect(secure.clear).toHaveBeenCalled();
    blocked = undefined; await client.initialize();
    blocked = async url => url.includes("/chats/") ? response(url, { items: [], next: null, generation: "g", reset: false, sampledAt: at, viewCursor: "old" }) : undefined;
    await expect(client.page("/chats/chat1")).rejects.toThrow("snapshot required");
  });
  it("resets events on 410 and gets a new authoritative snapshot", async () => {
    await initialized(); blocked = async url => url.includes("/events?") ? response(url, { code: "snapshot_required" }, 410) : undefined;
    snapshot = { ...snapshot, epoch: "new", cursor: "new-cursor" }; await client.sync();
    expect(client.state.snapshot?.epoch).toBe("new"); expect(client.writesEnabled).toBe(true);
    expect(calls.some(c => c.url.endsWith("/me"))).toBe(true);
  });
});
describe("LAN/Tailscale identity, redirects and refresh rotation", () => {
  it("matches exact approved HTTPS origins including ports and refuses arbitrary URLs", async () => {
    expect(() => exactOrigins(["http://lan.example.test"])).toThrow("trusted https required");
    expect(() => exactOrigins([lan + "/path"])).toThrow("trusted https required");
    await initialized(); await expect(client.page("//evil.test/mobile/v1/snapshot")).rejects.toThrow();
    expect(calls.every(c => saved.origins.includes(new URL(c.url).origin))).toBe(true);
    expect(parseQr(JSON.stringify(qr()), at).origins).toEqual([lan, vpn]);
    expect(() => parseQr(JSON.stringify({ ...qr(), origin: "https://lan.example.test:4444" }), at)).toThrow("invalid pairing");
  });
  it("probes without credentials and switches reads only to a provisioned reachable origin", async () => {
    offlineLan = true; await client.initialize(); expect(client.preferredOrigin).toBe(vpn);
    const probes = calls.filter(c => c.url.endsWith("/hello")); expect(probes.map(c => c.url)).toEqual([lan + "/mobile/v1/hello", vpn + "/mobile/v1/hello"]);
    for (const probe of probes) expect(probe.init.headers.authorization).toBeUndefined();
    for (const call of calls) { expect(call.init.redirect).toBe("error"); expect(call.init.credentials).toBe("omit"); }
    expect(calls.filter(c => c.init.headers.authorization).every(c => c.url.startsWith(vpn))).toBe(true);
  });
  it("checks authenticated PC/device/session identity before accepting any snapshot", async () => {
    blocked = async url => url.endsWith("/me") ? response(url, { pcId: "wrong-pc", deviceId: credentials.deviceId, sessionId: credentials.sessionId }) : undefined;
    await expect(client.initialize()).rejects.toThrow("pc identity mismatch"); expect(client.state.snapshot).toBeNull(); expect(secure.clear).toHaveBeenCalled();
    expect(calls.some(c => c.url.endsWith("/snapshot"))).toBe(false);
  });
  it("rejects wrong snapshot identity even after authenticated hello/me", async () => {
    snapshot.pcId = "wrong-pc";
    await expect(client.initialize()).rejects.toThrow("pc identity mismatch"); expect(client.state.snapshot).toBeNull();
  });
  it("rejects redirects without following them or sending credentials to redirect targets", async () => {
    blocked = async url => url.endsWith("/auth/refresh") ? { ...response(url, null, 307), redirected: false } : undefined;
    await expect(client.initialize()).rejects.toThrow("refresh unconfirmed");
    expect(calls.filter(c => c.url.endsWith("/auth/refresh"))).toHaveLength(1);
    expect(calls.some(c => c.url.startsWith("https://evil.test"))).toBe(false); expect(client.state.snapshot).toBeNull();
  });
  it("permits just one in-flight refresh rotation for concurrent reconnects", async () => {
    await initialized(); let release!: () => void;
    blocked = async url => { if (url.endsWith("/auth/refresh")) await new Promise<void>(resolve => { release = resolve; }); return undefined; };
    const first = client.reconnect(), second = client.reconnect(); while (!release) await Promise.resolve(); release(); await Promise.all([first, second]);
    expect(calls.filter(c => c.url.endsWith("/auth/refresh"))).toHaveLength(1);
  });
  it("clears unusable credentials after ambiguous refresh and never retries/fails over rotation", async () => {
    blocked = async url => { if (url.endsWith("/auth/refresh")) throw new Error("fixture lost issuance"); return undefined; };
    await expect(client.initialize()).rejects.toThrow("refresh unconfirmed"); await client.sync(); await client.reconnect();
    expect(calls.filter(c => c.url.endsWith("/auth/refresh"))).toHaveLength(1); expect(secure.clear).toHaveBeenCalled(); expect(client.approvedOrigins).toEqual([]);
  });
});
describe("pairing and push tap", () => {
  it("never silently upgrades a pending pairing and treats lost issuance as unconfirmed", async () => {
    secure.load = async () => null;
    blocked = async url => url.endsWith("/pairing/claims") ? response(url, { claimId: "claim", claimToken: "t".repeat(43), comparisonCode: "123456", expiresAt: at + 120_000 }, 202) : url.includes("/pairing/claims/") ? response(url, { state: "pending" }, 202) : undefined;
    await client.beginPairing(qr(), "Fixture", "android"); expect((await client.pollPairing()).state).toBe("pending"); expect(secure.save).not.toHaveBeenCalled(); expect(client.writesEnabled).toBe(false);
    blocked = async url => { if (url.includes("/pairing/claims/")) throw new Error("fixture lost issuance"); return undefined; };
    await expect(client.pollPairing()).rejects.toThrow("pairing unconfirmed"); await expect(client.pollPairing()).rejects.toThrow("pairing unconfirmed");
    expect(calls.filter(c => c.url.includes("/pairing/claims/")).length).toBe(2); expect(secure.save).not.toHaveBeenCalled();
  });
  it("authenticates again on opaque push tap and never accepts a URL from notification data", async () => {
    await initialized(); const hint = randomUUID();
    blocked = async url => url.endsWith("/notifications/" + hint) ? response(url, { questionId: q.id }) : undefined;
    expect(await client.resolveNotification(hint)).toBe(q.id); expect(calls.some(c => c.url.endsWith("/auth/refresh"))).toBe(true); expect(calls.some(c => c.url.endsWith("/snapshot"))).toBe(true);
    const count = calls.length; await expect(client.resolveNotification("https://evil.test")).rejects.toThrow("notification gone"); expect(calls).toHaveLength(count);
  });
});
