import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { OwnerQuestionStore, ownerQuestionVersion, QUESTIONS_FILE, QuestionVersionConflict } from "../src/core/owner-questions.js";
import { LocalMobileSource, projectQuestion, type MobileSource, type SourceView } from "../src/mobile/adapter.js";
import type { Credentials, Grant, PairingClaim, Question } from "../src/mobile/contract.js";
import { MobileDesktopAdmin } from "../src/mobile/desktop.js";
import { MobileGateway, type MobileRequest } from "../src/mobile/gateway.js";
import { MobilePush } from "../src/mobile/push.js";
import { MobileStore, type Device } from "../src/mobile/store.js";

const origin = "https://pc.example.test:4433", pcId = "fixture-pc", author = { id: "owner:fixture", name: "Owner", agent: "other" as const };
const ask = { title: "Which option?", topic: "scope", context: "Review the candidate", options: [{ id: "keep", label: "Keep", consequence: "Preserves candidate", recommended: true }, { id: "wait", label: "Wait", consequence: "Pauses candidate", recommended: false }], blocking: true, blocks: "Candidate action", meanwhile: "Read source" };
let home: string, at: number, store: MobileStore, questions: OwnerQuestionStore, source: MobileSource, gateway: MobileGateway, view: SourceView, question: Question;
const close: (() => void)[] = [];
beforeEach(() => {
  const fixtureRoot = resolve(".agent-bridge-test/mobile-fixtures"); mkdirSync(fixtureRoot, { recursive: true }); home = mkdtempSync(join(fixtureRoot, "run-")); at = Date.now();
  store = new MobileStore(join(home, "mobile.db"), pcId, origin, () => at); questions = new OwnerQuestionStore(home, nullLogger); close.push(() => store.close(), () => questions.close());
  question = projectQuestion(questions.ask(ask, "fixture-project", { session: "local", sessionId: "s1", main: "main", agent: "codex" }, at).question, pcId);
  view = { sessions: [{ id: "session1", pcId, projectId: question.projectId, generation: "generation1", name: "Local", agent: "codex", activity: "busy", connection: "connected", parentId: null, chatId: "chat1", sendSupported: false, sampledAt: at, version: "s1" }],
    jobs: [{ id: "job1", pcId, projectId: question.projectId, parentId: null, title: "Fixture job", status: "running", progress: { percent: null, note: null, at: null, etaAt: null, etaReportedAt: null }, chatId: "chat-job1", hasSteps: true, archived: false, recovered: false, sampledAt: at, version: "j1" }], questions: [question], sampledAt: at, sourceState: "ready" };
  source = { snapshot: vi.fn(async () => ({ ...view, questions: questions.list().map(q => projectQuestion(q, pcId)) })),
    chat: vi.fn(async () => ({ items: [{ id: "i1", kind: "assistant" as const, at, text: "Hello", version: "v1", truncated: false }], next: null, generation: "g1", reset: false })),
    steps: vi.fn(async () => ({ items: [{ id: "step1", text: "Fixture step", at }], next: null, generation: "g1", reset: false })),
    answer: vi.fn(async (id, body, deviceId, key) => projectQuestion(questions.answerMobile(id, body, deviceId, key, author, at), pcId)) };
  gateway = new MobileGateway(store, source);
});
afterEach(() => { for (const fn of close.splice(0).reverse()) fn(); vi.restoreAllMocks(); });
function grant(): Grant { return { pcId, projectIds: [question.projectId], sessionIds: ["session1"], jobIds: ["job1"], capabilities: ["overview.read", "chat.read", "questions.read", "questions.answer"] }; }
function pair(grants = [grant()]): Credentials {
  const qr = store.invite(), claim = store.claim(qr.invitationId, qr.nonce, "Fixture phone", "android", randomUUID()) as PairingClaim;
  store.confirm(claim.claimId, claim.comparisonCode, true, grants);
  return (store.pollClaim(claim.claimId, claim.claimToken, randomUUID()) as { credentials: Credentials }).credentials;
}
function req(method: string, path: string, credentials?: Credentials, body?: unknown, extra: Record<string, string> = {}): MobileRequest {
  return { method, path: "/mobile/v1" + path, authority: new URL(origin).host, tls: true, remoteAddress: "fixture",
    headers: { ...(credentials ? { authorization: "Bearer " + credentials.accessToken, "x-mobile-csrf": credentials.csrfToken } : {}), ...(method !== "GET" ? { "idempotency-key": randomUUID() } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) };
}
async function snapshot(credentials: Credentials): Promise<{ cursor: string }> { const result = await gateway.handle(req("GET", "/snapshot", credentials)); expect(result.status).toBe(200); return result.body as { cursor: string }; }

describe("mobile pairing/credentials", () => {
  it("shares credentials/revocation across LAN and VPN exact authorities including port", async () => {
    const multiStore = new MobileStore(join(home, "multi-mobile.db"), pcId, origin, () => at, ["https://pc.tailnet.ts.net"]); close.push(() => multiStore.close());
    const qr = multiStore.invite(); expect(qr.origins).toEqual([origin, "https://pc.tailnet.ts.net"]);
    const claim = multiStore.claim(qr.invitationId, qr.nonce, "Fixture", "android", randomUUID()) as PairingClaim;
    multiStore.confirm(claim.claimId, claim.comparisonCode, true, [grant()]);
    const c = (multiStore.pollClaim(claim.claimId, claim.claimToken, randomUUID()) as { credentials: Credentials }).credentials;
    const multi = new MobileGateway(multiStore, source), lanRead = req("GET", "/me", c), vpnRead = { ...lanRead, authority: "pc.tailnet.ts.net" };
    expect((await multi.handle(lanRead)).status).toBe(200); expect((await multi.handle(vpnRead)).status).toBe(200);
    expect((await multi.handle({ ...lanRead, authority: "pc.example.test:4434" })).status).toBe(403);
    expect((await multi.handle({ ...vpnRead, headers: { ...vpnRead.headers, origin } })).status).toBe(403);
    multiStore.revoke(c.deviceId); expect((await multi.handle(lanRead)).status).toBe(401); expect((await multi.handle(vpnRead)).status).toBe(401);
  });
  it("uses 120-second single-use QR and matching desktop confirmation", () => {
    const qr = store.invite(); expect(qr.expiresAt - at).toBe(120_000); expect(qr.nonce.length).toBeGreaterThanOrEqual(43);
    const claim = store.claim(qr.invitationId, qr.nonce, "Fixture", "android", randomUUID()) as PairingClaim;
    expect(() => store.claim(qr.invitationId, qr.nonce, "Thief", "ios", randomUUID())).toThrow("pairing_expired_or_consumed");
    expect(() => store.confirm(claim.claimId, "wrong!", true, [grant()])).toThrow("pairing_conflict");
    expect(() => store.pollClaim(claim.claimId, claim.claimToken, randomUUID())).toThrow("pairing_pending");
    store.confirm(claim.claimId, claim.comparisonCode, true, [grant()]);
    expect(store.pollClaim(claim.claimId, claim.claimToken, randomUUID())).toHaveProperty("credentials");
    expect(store.pollClaim(claim.claimId, claim.claimToken, randomUUID())).toEqual({ state: "issued" });
  });
  it("rejects expired QR and expired confirmation", () => {
    const qr = store.invite(); at += 120_000;
    expect(() => store.claim(qr.invitationId, qr.nonce, "Fixture", "ios", randomUUID())).toThrow("pairing_expired_or_consumed");
    const second = store.invite(), claim = store.claim(second.invitationId, second.nonce, "Fixture", "ios", randomUUID()) as PairingClaim;
    at += 120_000; expect(() => store.confirm(claim.claimId, claim.comparisonCode, true, [grant()])).toThrow("pairing_conflict");
  });
  it("stores hashes only and rotates credentials without replaying plaintext issuance", () => {
    const c = pair(), key = randomUUID(), next = store.refresh(c.refreshToken, c.csrfToken, key) as Credentials;
    expect(next.accessToken).not.toBe(c.accessToken); expect(next.refreshToken).not.toBe(c.refreshToken);
    expect(() => store.authenticate(c.accessToken)).toThrow("unauthorized");
    expect(store.refresh(c.refreshToken, c.csrfToken, key)).toEqual({ state: "issued" });
    const bytes = readFileSync(join(home, "mobile.db")).toString("utf8");
    for (const credential of [c.accessToken, c.refreshToken, c.csrfToken, next.accessToken, next.refreshToken, next.csrfToken]) expect(bytes).not.toContain(credential);
    expect(() => store.refresh(c.refreshToken, c.csrfToken, randomUUID())).toThrow("refresh_reuse");
    expect(() => store.authenticate(next.accessToken)).toThrow("device_revoked");
  });
  it("makes revoked/expired credentials fail and denies remote write grants", async () => {
    const c = pair(); store.revoke(c.deviceId); expect((await gateway.handle(req("GET", "/snapshot", c))).status).toBe(401);
    const newer = pair(); at += 300_000; expect((await gateway.handle(req("GET", "/me", newer))).status).toBe(401);
    const qr = store.invite(), claim = store.claim(qr.invitationId, qr.nonce, "Fixture", "android", randomUUID()) as PairingClaim;
    expect(() => store.confirm(claim.claimId, claim.comparisonCode, true, [{ ...grant(), pcId: "remote" }])).toThrow("remote_write_unsupported");
  });
});
describe("mobile allowlist, grants and cursor boundary", () => {
  it("requires trusted TLS, exact authority/origin, bearer auth and no cookie fallback", async () => {
    const c = pair(), valid = req("GET", "/snapshot", c);
    for (const bad of [{ ...valid, tls: false }, { ...valid, authority: "evil.test" }, { ...valid, headers: { ...valid.headers, origin: "null" } }, { ...valid, headers: { ...valid.headers, cookie: "ab_ui=secret" } }]) expect((await gateway.handle(bad)).status).toBe(403);
    expect((await gateway.handle(req("GET", "/snapshot"))).status).toBe(401);
    expect((await gateway.handle(req("GET", "/hello"))).body).toMatchObject({ pinning: false, send: "unsupported", pairedPcWrites: "unsupported" });
  });
  it("rejects forbidden desktop routes, unknown fields, duplicate query keys and excessive limits", async () => {
    const c = pair(); for (const path of ["/approvals", "/decisions", "/settings", "/network", "/sessions/session1/messages"]) expect((await gateway.handle(req("POST", path, c, {}))).status).toBe(404);
    for (const path of ["/sessions?limit=101", "/jobs?limit=1&limit=2", "/questions?path=anything", "/snapshot?token=x"]) expect((await gateway.handle(req("GET", path, c))).status).toBe(400);
    const s = await snapshot(c);
    expect((await gateway.handle(req("POST", `/questions/${question.id}/answer`, c, { expectedVersion: question.version, option: "keep", pin: {} }, { "x-mobile-view": s.cursor }))).status).toBe(400);
  });
  it("filters exact entities and checks parent grant before reading job run chat", async () => {
    const c = pair([{ ...grant(), jobIds: [], projectIds: [] }]);
    const result = await gateway.handle(req("GET", "/snapshot", c)); expect(result.body).toMatchObject({ jobs: [], questions: [] });
    expect((await gateway.handle(req("GET", "/chats/chat-job1", c))).status).toBe(404); expect(source.chat).not.toHaveBeenCalled();
    expect((await gateway.handle(req("GET", "/chats/chat1", c))).status).toBe(200);
  });
  it("bounds pages and resets cursors on device, scope, epoch and source change", async () => {
    view.sessions = Array.from({ length: 25 }, (_, n) => ({ ...view.sessions[0]!, id: "session" + n }));
    const c = pair([{ ...grant(), sessionIds: view.sessions.map(s => s.id) }]), another = pair();
    const first = await gateway.handle(req("GET", "/sessions?limit=10", c)), page = first.body as { next: string; items: unknown[] };
    expect(page.items.length).toBe(10);
    expect((await gateway.handle(req("GET", "/sessions?cursor=" + page.next, another))).status).toBe(410);
    const valid = await gateway.handle(req("GET", "/sessions?cursor=" + page.next, c)); expect(valid.status).toBe(200);
    view.sessions[0]!.version = "changed"; expect((await gateway.handle(req("GET", "/sessions?cursor=" + page.next, c))).status).toBe(410);
    const snap = await snapshot(c);
    const restarted = new MobileGateway(store, source); expect((await restarted.handle(req("GET", "/events?after=" + snap.cursor, c))).status).toBe(410);
    const d = store.get<Device>("device", c.deviceId)!; d.revision = randomUUID(); store.put("device", d.id, d);
    expect((await gateway.handle(req("GET", "/events?after=" + snap.cursor, c))).status).toBe(410);
  });
  it("publishes sampled reset events after changes with no chat/question content", async () => {
    const c = pair(), snap = await snapshot(c);
    expect((await gateway.handle(req("GET", "/events?after=" + snap.cursor, c))).body).toMatchObject({ events: [], reset: false });
    view.jobs = []; const result = await gateway.handle(req("GET", "/events?after=" + snap.cursor, c));
    expect(result.body).toMatchObject({ reset: true, events: [{ type: "snapshot.required" }] });
    expect(JSON.stringify(result.body)).not.toContain(question.context);
  });
  it("rechecks revocation while an upstream content fetch is suspended", async () => {
    const c = pair(); let release!: () => void;
    source.chat = vi.fn(async () => { await new Promise<void>(r => { release = r; }); return { items: [], next: null, generation: "g", reset: false }; });
    const pending = gateway.handle(req("GET", "/chats/chat1", c));
    while (!release) await Promise.resolve(); store.revoke(c.deviceId); release();
    expect((await pending).status).toBe(401);
  });
});
describe("atomic answer CAS/replay", () => {
  it("commits answer and durable replay together and rejects a concurrent stale writer", async () => {
    const c = pair(), snap = await snapshot(c), key = randomUUID();
    const body = { expectedVersion: question.version, option: "keep" };
    const results = await Promise.all([gateway.handle(req("POST", `/questions/${question.id}/answer`, c, body, { "x-mobile-view": snap.cursor, "idempotency-key": key })), gateway.handle(req("POST", `/questions/${question.id}/answer`, c, { ...body, option: "wait" }, { "x-mobile-view": snap.cursor }))]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const replay = await gateway.handle(req("POST", `/questions/${question.id}/answer`, c, body, { "x-mobile-view": snap.cursor, "idempotency-key": key }));
    expect(replay.status).toBe(200); expect(replay.body).toMatchObject({ question: { status: "answered", answer: { option: "keep" } } });
    questions.close(); close.pop(); questions = new OwnerQuestionStore(home, nullLogger); close.push(() => questions.close());
    expect(questions.answerMobile(question.id, body, c.deviceId, key, author).answer?.option).toBe("keep");
    expect(() => questions.answerMobile(question.id, { ...body, option: "wait" }, c.deviceId, key, author)).toThrow(QuestionVersionConflict);
  });
  it("rolls back the answer if durable replay insertion crashes", () => {
    const fixtureDb = new DatabaseSync(join(home, QUESTIONS_FILE));
    fixtureDb.exec("CREATE TRIGGER mobile_crash BEFORE INSERT ON mobile_question_answers BEGIN SELECT RAISE(ABORT,'fixture crash'); END;");
    expect(() => questions.answerMobile(question.id, { expectedVersion: question.version, option: "keep" }, "device", randomUUID(), author)).toThrow("fixture crash");
    expect(questions.get(question.id)?.status).toBe("open");
    expect(fixtureDb.prepare("SELECT count(*) AS n FROM mobile_question_answers").get()?.n).toBe(0);
    expect(fixtureDb.prepare("SELECT count(*) AS n FROM question_events").get()?.n).toBe(1);
    fixtureDb.exec("DROP TRIGGER mobile_crash"); fixtureDb.close();
    expect(questions.answerMobile(question.id, { expectedVersion: question.version, option: "keep" }, "device", randomUUID(), author).status).toBe("answered");
  });
  it("compares current terms inside the store even across independent handles/defaults", () => {
    const other = new OwnerQuestionStore(home, nullLogger); close.push(() => other.close());
    const q = questions.get(question.id)!; q.context = "Revised terms"; other.save(q);
    expect(() => questions.answerMobile(q.id, { expectedVersion: question.version, option: "keep" }, "device", randomUUID(), author)).toThrow(QuestionVersionConflict);
    const current = questions.get(q.id)!;
    other.answer(q.id, { option: "wait" }, author);
    expect(() => questions.answerMobile(q.id, { expectedVersion: ownerQuestionVersion(current), option: "keep" }, "device", randomUUID(), author)).toThrow(QuestionVersionConflict);
  });
  it("requires CSRF, fresh authoritative proof, ready source and UUID replay keys", async () => {
    const c = pair(), snap = await snapshot(c), body = { expectedVersion: question.version, option: "keep" }, path = `/questions/${question.id}/answer`;
    expect((await gateway.handle(req("POST", path, c, body))).status).toBe(409);
    expect((await gateway.handle(req("POST", path, c, body, { "x-mobile-view": snap.cursor, "x-mobile-csrf": "wrong" }))).status).toBe(403);
    expect((await gateway.handle(req("POST", path, c, body, { "x-mobile-view": snap.cursor, "idempotency-key": "invalid" }))).status).toBe(400);
    view.sourceState = "offline"; expect((await gateway.handle(req("POST", path, c, body, { "x-mobile-view": snap.cursor }))).status).toBe(409);
    expect(source.answer).not.toHaveBeenCalled();
  });
  it("bounds JSON bodies and keeps native read cursors hidden behind the entity-bound cursor", async () => {
    const c = pair(), snapshot = await gateway.handle(req("GET", "/snapshot", c));
    const path = `/questions/${question.id}/answer`;
    expect((await gateway.handle(req("POST", path, c, { expectedVersion: question.version, text: "x".repeat(40_000) }, { "x-mobile-view": (snapshot.body as { cursor: string }).cursor }))).status).toBe(413);
    source.chat = vi.fn(async () => ({ items: Array.from({ length: 35 }, (_, n) => ({ id: String(n), kind: "assistant" as const, at, text: "item" + n, version: "v", truncated: false })), next: "private-native-cursor", generation: "g", reset: false }));
    const first = await gateway.handle(req("GET", "/chats/chat1?limit=20", c));
    const page = first.body as { items: unknown[]; next: string }; expect(page.items).toHaveLength(20); expect(JSON.stringify(page)).not.toContain("private-native-cursor");
    const second = await gateway.handle(req("GET", "/chats/chat1?cursor=" + page.next, c)); expect((second.body as { items: unknown[] }).items).toHaveLength(15); expect(source.chat).toHaveBeenCalledTimes(1);
    expect((await gateway.handle(req("GET", "/chats/chat-job1?cursor=" + page.next, c))).status).toBe(410);
  });
});
describe("local phone administration and opaque push seams", () => {
  it("requires desktop origin/CSRF and rejects unsupported grants", async () => {
    const admin = new MobileDesktopAdmin(store, source, "http://127.0.0.1:4321"), state = await admin.handle("GET", "/api/mobile/phones", {});
    const csrfToken = (state.body as { csrfToken: string }).csrfToken;
    await expect(admin.handle("POST", "/api/mobile/invitations", { "idempotency-key": randomUUID() }, "{}")).rejects.toThrow("desktop_csrf");
    const headers = { origin: admin.localOrigin, "x-mobile-admin-csrf": csrfToken, "idempotency-key": randomUUID(), "content-type": "application/json" };
    const invite = await admin.handle("POST", "/api/mobile/invitations", headers, "{}"); expect(invite.status).toBe(201);
    expect((await admin.handle("POST", "/api/mobile/invitations", headers, "{}")).body).toEqual({ state: "invited" });
  });
  it("encrypts push tokens, sends only generic hints and binds hint lookup to the device", async () => {
    const c = pair(), d = store.get<Device>("device", c.deviceId)!, projectId = randomUUID(), submit = vi.fn(async (_registration: unknown, _hint: unknown) => ({ state: "submitted" as const }));
    const push = new MobilePush(store, { submit }, new Uint8Array(32).fill(7), projectId, "development");
    push.register(d, { expoPushToken: "ExpoPushToken[fixture-token]", platform: "android", projectId, environment: "development" });
    expect(readFileSync(join(home, "mobile.db")).toString("utf8")).not.toContain("fixture-token");
    expect(await push.notify(question, async () => question)).toEqual([{ state: "submitted" }]);
    const hint = submit.mock.calls[0]![1] as unknown as { data: { notificationId: string } };
    expect(JSON.stringify(hint)).not.toContain(question.title); expect(JSON.stringify(hint)).not.toContain(question.projectId);
    expect(push.resolve(d, hint.data.notificationId, [question])).toEqual({ questionId: question.id });
    const other = pair(); expect(() => push.resolve(store.get<Device>("device", other.deviceId)!, hint.data.notificationId, [question])).toThrow("notification_gone");
    await push.notify(question, async () => question); expect(submit).toHaveBeenCalledTimes(1);
    store.revoke(c.deviceId); expect(store.get("push", c.deviceId)).toBeUndefined();
  });
  it("leaves unconfigured providers unsupported and filters revoked/closed questions at dispatch", async () => {
    const c = pair(), push = new MobilePush(store); expect(() => push.register(store.get<Device>("device", c.deviceId)!, { expoPushToken: "ExpoPushToken[fixture]", platform: "android", projectId: randomUUID(), environment: "development" })).toThrow("push_unsupported");
    expect(await push.notify(question, async () => question)).toEqual([]);
    const submit = vi.fn(async () => ({ state: "submitted" as const })), projectId = randomUUID();
    const configured = new MobilePush(store, { submit }, new Uint8Array(32).fill(7), projectId, "development");
    configured.register(store.get<Device>("device", c.deviceId)!, { expoPushToken: "ExpoPushToken[fixture]", platform: "android", projectId, environment: "development" });
    await configured.notify(question, async () => ({ ...question, status: "answered" })); expect(submit).not.toHaveBeenCalled();
  });
});
