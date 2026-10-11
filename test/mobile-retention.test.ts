import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileSource } from "../src/mobile/adapter.js";
import type { Credentials, PairingClaim, Question } from "../src/mobile/contract.js";
import { MobileDesktopAdmin } from "../src/mobile/desktop.js";
import { MobileGateway, type MobileRequest } from "../src/mobile/gateway.js";
import { MobilePush, type PushProvider, type PushRegistration } from "../src/mobile/push.js";
import { MobileStore, type Device, type PushRevocationReason } from "../src/mobile/store.js";

const pcId = "retention-pc", origin = "https://pc.example.test";
let file: string, at: number, store: MobileStore, inspect: DatabaseSync, credentials: Credentials;
let push: MobilePush, gateway: MobileGateway, source: MobileSource, registration: PushRegistration;
let submit: ReturnType<typeof vi.fn<PushProvider["submit"]>>;
const question: Question = {
  id: "q1", kind: "question", pcId, projectId: "project-a", title: "Fixture question", context: "Fixture",
  topic: "fixture", options: [], links: [], blocking: false, blocks: "", meanwhile: "", destructive: false,
  authorization: false, urgency: "normal", declaredDefault: null, status: "open", askedAt: 1, version: "v1",
  answer: null, deliveries: [], dismissal: null,
};

beforeEach(() => {
  const root = resolve(".agent-bridge-test/mobile-retention"); mkdirSync(root, { recursive: true });
  file = join(mkdtempSync(join(root, "run-")), "mobile.db"); at = Date.now();
  store = new MobileStore(file, pcId, origin, () => at); inspect = new DatabaseSync(file);
  const qr = store.invite(), claim = store.claim(qr.invitationId, qr.nonce, "Fixture phone", "android", randomUUID()) as PairingClaim;
  store.confirm(claim.claimId, claim.comparisonCode, true, [{ pcId, projectIds: [question.projectId], sessionIds: [], jobIds: [], capabilities: ["questions.read"] }]);
  credentials = (store.pollClaim(claim.claimId, claim.claimToken, randomUUID()) as { credentials: Credentials }).credentials;
  source = {
    snapshot: async () => ({ sessions: [], jobs: [], questions: [question], sampledAt: at, sourceState: "ready" }),
    chat: async () => ({ items: [], next: null, generation: "g", reset: false }),
    steps: async () => ({ items: [], next: null, generation: "g", reset: false }),
    answer: async () => question,
  };
  submit = vi.fn(async () => ({ state: "submitted" as const }));
  registration = { expoPushToken: "ExpoPushToken[retained-fixture-token]", platform: "android", projectId: randomUUID(), environment: "development" };
  push = new MobilePush(store, { submit }, new Uint8Array(32).fill(7), registration.projectId, registration.environment);
  gateway = new MobileGateway(store, source, push);
  push.register(store.get<Device>("device", credentials.deviceId)!, registration);
});
afterEach(() => { inspect.close(); store.close(); vi.restoreAllMocks(); }); // Retain fixtures; never remove user data.

function request(path: string): MobileRequest {
  return { method: "DELETE", path: "/mobile/v1" + path, authority: new URL(origin).host, tls: true, remoteAddress: "fixture",
    headers: { authorization: "Bearer " + credentials.accessToken, "x-mobile-csrf": credentials.csrfToken, "idempotency-key": randomUUID() } };
}
function row() { return inspect.prepare("SELECT * FROM mobile_records WHERE kind='push' AND id=?").get(credentials.deviceId)!; }
async function expectArchived(original: string, reason: PushRevocationReason) {
  expect(row()).toMatchObject({ status: "revoked", revokedAt: at, reason, record: original });
  expect(store.get("push", credentials.deviceId)).toBeUndefined(); expect(store.list("push")).toEqual([]);
  submit.mockClear();
  const fresh = { ...question, id: randomUUID(), askedAt: at };
  expect(await push.notify(fresh, async () => fresh)).toEqual([]); expect(submit).not.toHaveBeenCalled();
  expect(readFileSync(file).toString("utf8")).not.toContain(registration.expoPushToken);
}

describe("retained push registration lifecycle", () => {
  it("archives unsubscribe through the authenticated gateway and permits a retained re-registration", async () => {
    const original = String(row().record);
    expect((await gateway.handle(request("/me/push"))).status).toBe(204);
    await expectArchived(original, "unsubscribe");
    expect(store.authenticate(credentials.accessToken).device.revoked).toBe(false);
    at++;
    push.register(store.get<Device>("device", credentials.deviceId)!, registration);
    expect(inspect.prepare("SELECT * FROM mobile_push_history WHERE deviceId=?").all(credentials.deviceId)).toMatchObject([
      { record: original, status: "revoked", revokedAt: at - 1, reason: "unsubscribe", retainedAt: at },
    ]);
    expect(row()).toMatchObject({ status: "active", revokedAt: null, reason: null });
    expect(await push.notify(question, async () => question)).toEqual([{ state: "submitted" }]);
  });
  it("archives device revocation through the owner desktop route and rejects stale registration", async () => {
    const original = String(row().record), device = store.get<Device>("device", credentials.deviceId)!;
    const admin = new MobileDesktopAdmin(store, source, "http://127.0.0.1:4321");
    const state = await admin.handle("GET", "/api/mobile/phones", {});
    expect((await admin.handle("DELETE", "/api/mobile/devices/" + device.id, {
      origin: admin.localOrigin, "x-mobile-admin-csrf": (state.body as { csrfToken: string }).csrfToken, "idempotency-key": randomUUID(),
    })).status).toBe(204);
    await expectArchived(original, "device-revoke");
    expect(() => store.authenticate(credentials.accessToken)).toThrow("device_revoked");
    expect(() => push.register(device, registration)).toThrow("device_revoked");
  });
  it("archives logout through the authenticated session route", async () => {
    const original = String(row().record);
    expect((await gateway.handle(request("/me/session"))).status).toBe(204);
    await expectArchived(original, "logout");
    expect(() => store.authenticate(credentials.accessToken)).toThrow("device_revoked");
  });
  it("archives refresh-token reuse while retaining the session and its retired hash", async () => {
    const original = String(row().record);
    const next = store.refresh(credentials.refreshToken, credentials.csrfToken, randomUUID()) as Credentials;
    expect(() => store.refresh(credentials.refreshToken, credentials.csrfToken, randomUUID())).toThrow("refresh_reuse");
    await expectArchived(original, "refresh-reuse");
    expect(() => store.authenticate(next.accessToken)).toThrow("device_revoked");
    expect(store.get<{ retired: string[] }>("session", credentials.sessionId)?.retired).toHaveLength(1);
  });
  it("archives provider-invalid registration after the rejection and never sends it again", async () => {
    // Preserve old/noncanonical JSON bytes too; invalidation compares ciphertext, not JSON formatting.
    const original = JSON.stringify(JSON.parse(String(row().record)), null, 2);
    inspect.prepare("UPDATE mobile_records SET record=? WHERE kind='push' AND id=?").run(original, credentials.deviceId);
    submit.mockResolvedValue({ state: "device-not-registered" });
    expect(await push.notify(question, async () => question)).toEqual([{ state: "device-not-registered" }]);
    expect(submit).toHaveBeenCalledTimes(1);
    await expectArchived(original, "provider-invalid");
    at++; push.remove(credentials.deviceId);
    expect(row()).toMatchObject({ revokedAt: at - 1, reason: "provider-invalid", record: original });
  });
  it("retains replaced active ciphertext and ignores late invalidation of the previous registration", async () => {
    const original = String(row().record);
    let release!: (result: { state: "device-not-registered" }) => void;
    submit.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = push.notify(question, async () => question);
    while (!release) await Promise.resolve();
    push.register(store.get<Device>("device", credentials.deviceId)!, { ...registration, expoPushToken: "ExpoPushToken[new-fixture-token]" });
    const replacement = String(row().record);
    release({ state: "device-not-registered" }); await pending;
    expect(row()).toMatchObject({ status: "active", record: replacement, reason: null });
    expect(inspect.prepare("SELECT record,status FROM mobile_push_history WHERE deviceId=?").all(credentials.deviceId)).toEqual([{ record: original, status: "active" }]);
    const fresh = { ...question, id: randomUUID() };
    await push.notify(fresh, async () => fresh);
    expect(submit).toHaveBeenLastCalledWith(expect.objectContaining({ expoPushToken: "ExpoPushToken[new-fixture-token]" }), expect.anything());
  });
  it("rolls back device revocation if writing the tombstone fails", () => {
    const original = String(row().record), device = store.get("device", credentials.deviceId);
    inspect.exec("CREATE TRIGGER fail_archive BEFORE UPDATE OF status ON mobile_records WHEN NEW.status='revoked' BEGIN SELECT RAISE(ABORT, 'archive_fixture_failure'); END;");
    expect(() => store.revoke(credentials.deviceId)).toThrow("archive_fixture_failure");
    expect(row()).toMatchObject({ status: "active", record: original });
    expect(store.get("device", credentials.deviceId)).toEqual(device);
    expect(store.authenticate(credentials.accessToken).device.revoked).toBe(false);
  });
  it("rolls back replacement if retaining the old ciphertext fails", () => {
    const original = String(row().record);
    inspect.exec("CREATE TRIGGER fail_history BEFORE INSERT ON mobile_push_history BEGIN SELECT RAISE(ABORT, 'history_fixture_failure'); END;");
    expect(() => push.register(store.get<Device>("device", credentials.deviceId)!, registration)).toThrow("history_fixture_failure");
    expect(row()).toMatchObject({ status: "active", record: original });
  });
  it("filters every non-active status and keeps archived registration inactive after restart", async () => {
    inspect.prepare("UPDATE mobile_records SET status='unknown' WHERE kind='push' AND id=?").run(credentials.deviceId);
    expect(store.get("push", credentials.deviceId)).toBeUndefined(); expect(store.list("push")).toEqual([]);
    expect(await push.notify(question, async () => question)).toEqual([]); expect(submit).not.toHaveBeenCalled();
    inspect.prepare("UPDATE mobile_records SET status='active' WHERE kind='push' AND id=?").run(credentials.deviceId);
    const original = String(row().record); push.remove(credentials.deviceId);
    store.close(); store = new MobileStore(file, pcId, origin, () => at);
    push = new MobilePush(store, { submit }, new Uint8Array(32).fill(7), registration.projectId, registration.environment);
    await expectArchived(original, "unsubscribe");
  });
  it("migrates the original schema additively without changing existing record bytes", () => {
    const legacyFile = join(file + "-legacy.db"), legacy = new DatabaseSync(legacyFile);
    const encrypted = String(row().record);
    legacy.exec("CREATE TABLE mobile_records(kind TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(kind,id));");
    legacy.prepare("INSERT INTO mobile_records VALUES('push',?,?)").run(credentials.deviceId, encrypted); legacy.close();
    for (let i = 0; i < 2; i++) {
      const migrated = new MobileStore(legacyFile, pcId, origin, () => at), db = new DatabaseSync(legacyFile);
      try {
        expect(db.prepare("SELECT * FROM mobile_records WHERE kind='push'").get()).toMatchObject({ record: encrypted, status: "active", revokedAt: null, reason: null });
        expect(migrated.get("push", credentials.deviceId)).toEqual(JSON.parse(encrypted));
        expect(db.prepare("PRAGMA table_info(mobile_records)").all().map(r => r.name)).toEqual(["kind", "id", "record", "status", "revokedAt", "reason"]);
      } finally { db.close(); migrated.close(); }
    }
  });
});
