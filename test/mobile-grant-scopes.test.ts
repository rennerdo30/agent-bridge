import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { OwnerQuestionStore } from "../src/core/owner-questions.js";
import { projectQuestion, type MobileSource, type SourceView } from "../src/mobile/adapter.js";
import type { Capability, Credentials, Grant, Job, PairingClaim, Question, Session, Snapshot } from "../src/mobile/contract.js";
import { MobileDesktopAdmin } from "../src/mobile/desktop.js";
import { MobileGateway, type MobileRequest } from "../src/mobile/gateway.js";
import { MobileStore } from "../src/mobile/store.js";

const origin = "https://pc.example.test:4433", pcId = "fixture-pc";
const reads: Capability[] = ["overview.read", "chat.read", "questions.read"];
const ask = { title: "Which option?", topic: "scope", context: "Review", options: [{ id: "keep", label: "Keep", consequence: "Keeps it", recommended: true }, { id: "wait", label: "Wait", consequence: "Waits", recommended: false }], blocking: false, blocks: "Nothing", meanwhile: "Read source" };
let home: string, at: number, store: MobileStore, questions: OwnerQuestionStore, view: SourceView, gateway: MobileGateway, source: MobileSource;
const close: (() => void)[] = [];

const session = (id: string, projectId: string): Session => ({ id, pcId, projectId, generation: "g-" + id, name: "Session " + id, agent: "codex", activity: "idle", connection: "connected", parentId: null, chatId: "chat-" + id, sendSupported: false, sampledAt: at, version: "v-" + id });
const job = (id: string, projectId: string | null): Job => ({ id, pcId, projectId, parentId: null, title: "Job " + id, status: "running", progress: { percent: null, note: null, at: null, etaAt: null, etaReportedAt: null }, chatId: "chat-" + id, hasSteps: true, archived: false, recovered: false, sampledAt: at, version: "v-" + id });
function question(project: string): Question { return projectQuestion(questions.ask({ ...ask, topic: project }, project, { session: "local", sessionId: "s1", main: "main", agent: "codex" }, at).question, pcId); }

beforeEach(() => {
  const root = resolve(".agent-bridge-test/mobile-grant-scopes"); mkdirSync(root, { recursive: true }); home = mkdtempSync(join(root, "run-")); at = Date.now();
  store = new MobileStore(join(home, "mobile.db"), pcId, origin, () => at); questions = new OwnerQuestionStore(home, nullLogger); close.push(() => store.close(), () => questions.close());
  view = { sessions: [], jobs: [], questions: [], sampledAt: at, sourceState: "ready" };
  source = { snapshot: vi.fn(async () => ({ ...view, sampledAt: at })), chat: vi.fn(), steps: vi.fn(), answer: vi.fn() } as unknown as MobileSource;
  gateway = new MobileGateway(store, source);
});
afterEach(() => { for (const fn of close.splice(0).reverse()) fn(); vi.restoreAllMocks(); });

function pair(grants: Grant[]): Credentials {
  const qr = store.invite(), claim = store.claim(qr.invitationId, qr.nonce, "Fixture phone", "android", randomUUID()) as PairingClaim;
  store.confirm(claim.claimId, claim.comparisonCode, true, grants);
  return (store.pollClaim(claim.claimId, claim.claimToken, randomUUID()) as { credentials: Credentials }).credentials;
}
function req(path: string, c: Credentials): MobileRequest {
  return { method: "GET", path: "/mobile/v1" + path, authority: new URL(origin).host, tls: true, remoteAddress: "fixture", headers: { authorization: "Bearer " + c.accessToken, "x-mobile-csrf": c.csrfToken } };
}
async function visible(c: Credentials): Promise<{ sessions: string[]; jobs: string[]; questions: string[] }> {
  at += 1; const result = await gateway.handle(req("/snapshot", c)); expect(result.status).toBe(200);
  const snap = result.body as Snapshot;
  return { sessions: snap.sessions.map(s => s.id).sort(), jobs: snap.jobs.map(j => j.id).sort(), questions: snap.questions.map(q => q.id).sort() };
}

describe("whole-PC and project grant scopes", () => {
  it("requires explicit answer capability and preserves project boundaries on the real answer route", async () => {
    const qa = question("project-a"), qb = question("project-b"); view.questions = [qa, qb];
    source.answer = vi.fn(async (id, body, deviceId, key) => projectQuestion(questions.answerMobile(id, body, deviceId, key, { id: "owner:fixture", name: "Owner fixture", agent: "other" }), pcId));
    const grant: Grant = { pcId, scope: "project", projectIds: [qa.projectId], sessionIds: [], jobIds: [], capabilities: reads };
    const readOnly = pair([grant]), optedIn = pair([{ ...grant, capabilities: [...reads, "questions.answer"] }]);
    const answer = async (c: Credentials, q: Question) => {
      const snapshot = await gateway.handle(req("/snapshot", c)); expect(snapshot.status).toBe(200);
      const request = req("/questions/" + q.id + "/answer", c);
      return gateway.handle({ ...request, method: "POST", headers: { ...request.headers, "content-type": "application/json", "idempotency-key": randomUUID(), "x-mobile-view": (snapshot.body as Snapshot).cursor }, body: JSON.stringify({ expectedVersion: q.version, option: "keep" }) });
    };
    expect((await answer(readOnly, qa)).status).toBe(404);
    expect((await answer(optedIn, qb)).status).toBe(404); expect(source.answer).not.toHaveBeenCalled();
    const result = await answer(optedIn, qa); expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ question: { id: qa.id, status: "answered", answer: { source: "owner", option: "keep" } } });
    expect(source.answer).toHaveBeenCalledTimes(1); expect(questions.get(qb.id)!.status).toBe("open");
  });

  it("revokes an all-scope phone during a suspended snapshot and retains its grants", async () => {
    view.sessions = [session("s1", "pa")];
    const c = pair([{ pcId, scope: "all", projectIds: [], sessionIds: [], jobIds: [], capabilities: reads }]);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
    source.snapshot = async () => { entered(); await blocked; return view; };
    const pending = gateway.handle(req("/snapshot", c)); await waiting; store.revoke(c.deviceId); release();
    expect((await pending).status).toBe(401);
    expect(store.get("device", c.deviceId)).toMatchObject({ revoked: true, grants: [{ scope: "all" }] });
    expect((await gateway.handle(req("/me", c))).status).toBe(401);
  });

  it("never projects desktop folders to phones or accepts phone-supplied grant or broadcast targets", async () => {
    view.sessions = [session("s1", "opaque-a")]; source.projectFolders = () => new Map([["opaque-a", "E:/Fixture/private-project"]]);
    const c = pair([{ pcId, scope: "project", projectIds: ["opaque-a"], sessionIds: [], jobIds: [], capabilities: reads }]);
    for (const path of ["/snapshot", "/me", "/sessions"]) {
      const result = await gateway.handle(req(path, c)); expect(result.status).toBe(200); expect(JSON.stringify(result.body)).not.toContain("E:/Fixture");
    }
    for (const path of ["/snapshot?folder=E%3A%2FFixture", "/sessions?projectScopes=all", "/jobs?targets=*"]) expect((await gateway.handle(req(path, c))).status).toBe(400);
    for (const path of ["/grants", "/send", "/broadcast"]) {
      const request = req(path, c);
      expect((await gateway.handle({ ...request, method: "POST", headers: { ...request.headers, "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify({ targets: ["*"], grants: [{ scope: "all" }], folder: "E:/Fixture" }) })).status).toBe(404);
    }
  });

  it("an all-grant sees sessions, jobs and owner questions created after pairing", async () => {
    const qa = question("project-a");
    view.sessions = [session("s1", qa.projectId)]; view.jobs = [job("j1", qa.projectId)]; view.questions = [qa];
    const c = pair([{ pcId, scope: "all", projectIds: [], sessionIds: [], jobIds: [], capabilities: reads }]);
    expect(await visible(c)).toEqual({ sessions: ["s1"], jobs: ["j1"], questions: [qa.id] });
    const qb = question("project-b");
    view.sessions = [...view.sessions, session("s2", qb.projectId)]; view.jobs = [...view.jobs, job("j2", qb.projectId), job("j3", null)]; view.questions = [qa, qb];
    expect(await visible(c)).toEqual({ sessions: ["s1", "s2"], jobs: ["j1", "j2", "j3"], questions: [qa.id, qb.id].sort() });
    expect(store.can(store.get("device", c.deviceId)!, "questions.answer", pcId, { kind: "question", id: qb.id, projectId: qb.projectId })).toBe(false);
    expect(store.can(store.get("device", c.deviceId)!, "overview.read", "other-pc", { kind: "session", id: "s1", projectId: qa.projectId })).toBe(false);
  });

  it("a project grant sees only its project, including members that join later", async () => {
    const qa = question("project-a"), qb = question("project-b"), a = qa.projectId, b = qb.projectId;
    view.sessions = [session("a1", a), session("b1", b)]; view.jobs = [job("ja1", a), job("jb1", b), job("jn", null)]; view.questions = [qa, qb];
    const c = pair([{ pcId, scope: "project", projectIds: [a], sessionIds: [], jobIds: [], capabilities: reads }]);
    expect(await visible(c)).toEqual({ sessions: ["a1"], jobs: ["ja1"], questions: [qa.id] });
    const qa2 = question("project-a");
    view.sessions = [...view.sessions, session("a2", a), session("b2", b)]; view.jobs = [...view.jobs, job("ja2", a), job("jb2", b)]; view.questions = [qa, qb, qa2];
    expect(await visible(c)).toEqual({ sessions: ["a1", "a2"], jobs: ["ja1", "ja2"], questions: [qa.id, qa2.id].sort() });
  });

  it("existing explicit grants keep their exact sessions, jobs and question projects", async () => {
    const qa = question("project-a"), a = qa.projectId;
    view.sessions = [session("s1", a)]; view.jobs = [job("j1", a)]; view.questions = [qa];
    const legacy = { pcId, projectIds: [a], sessionIds: ["s1"], jobIds: ["j1"], capabilities: reads } as Grant;
    expect(legacy.scope).toBeUndefined();
    const c = pair([legacy]);
    expect(await visible(c)).toEqual({ sessions: ["s1"], jobs: ["j1"], questions: [qa.id] });
    const qa2 = question("project-a");
    view.sessions = [...view.sessions, session("s2", a)]; view.jobs = [...view.jobs, job("j2", a)]; view.questions = [qa, qa2];
    // New sessions and jobs of the same project stay hidden; owner questions of the project remain covered as before.
    expect(await visible(c)).toEqual({ sessions: ["s1"], jobs: ["j1"], questions: [qa.id, qa2.id].sort() });
  });
});

describe("desktop claim review with scopes", () => {
  async function admin() {
    const desktop = new MobileDesktopAdmin(store, source, "http://127.0.0.1:4321"), state = await desktop.handle("GET", "/api/mobile/phones", {});
    const headers = () => ({ origin: desktop.localOrigin, "x-mobile-admin-csrf": (state.body as { csrfToken: string }).csrfToken, "idempotency-key": randomUUID(), "content-type": "application/json" });
    return { desktop, state, headers };
  }
  function claim() { const qr = store.invite(); return store.claim(qr.invitationId, qr.nonce, "Fixture phone", "ios", randomUUID()) as PairingClaim; }

  it("offers projects with folders and sessions, never a job list", async () => {
    view.sessions = [session("s1", "pa"), session("s2", "pa")]; view.jobs = [job("j1", "pa"), job("j2", "pb")];
    source.projectFolders = () => new Map([["pa", "E:/Development/alpha"], ["pb", "E:\\Development\\beta\\"]]);
    const { state } = await admin(), body = state.body as { catalog: Record<string, unknown> };
    expect(body.catalog).toEqual({ pcId, stale: false, sessions: [{ id: "s1", name: "Session s1", agent: "codex", projectId: "pa" }, { id: "s2", name: "Session s2", agent: "codex", projectId: "pa" }],
      projects: [{ id: "pa", name: "alpha", folder: "E:/Development/alpha", sessions: 2, jobs: 1, questions: 0 }, { id: "pb", name: "beta", folder: "E:\\Development\\beta\\", sessions: 0, jobs: 1, questions: 0 }] });
    expect(body.catalog).not.toHaveProperty("jobs");
  });

  it("records whole-PC and project grants and rejects ambiguous or unknown scopes", async () => {
    view.sessions = [session("s1", "pa")];
    const { desktop, headers } = await admin(), post = (id: string, body: unknown) => desktop.handle("POST", "/api/mobile/claims/" + id, headers(), JSON.stringify(body));
    const first = claim(), base = { pcId, projectIds: [] as string[], sessionIds: [] as string[], jobIds: [] as string[], capabilities: reads };
    await expect(post(first.claimId, { comparisonCode: first.comparisonCode, allow: true, grants: [{ ...base, scope: "all", projectIds: ["pa"] }] })).rejects.toThrow("unsupported_grant");
    await expect(post(first.claimId, { comparisonCode: first.comparisonCode, allow: true, grants: [{ ...base, scope: "project" }] })).rejects.toThrow("unsupported_grant");
    await expect(post(first.claimId, { comparisonCode: first.comparisonCode, allow: true, grants: [{ ...base, scope: "project", projectIds: ["unknown"] }] })).rejects.toThrow("unsupported_grant");
    await expect(post(first.claimId, { comparisonCode: first.comparisonCode, allow: true, grants: [{ ...base, scope: "everything" }] })).rejects.toThrow();
    expect((await post(first.claimId, { comparisonCode: first.comparisonCode, allow: true, grants: [{ ...base, scope: "all" }] })).body).toEqual({ state: "recorded" });
    const second = claim();
    expect((await post(second.claimId, { comparisonCode: second.comparisonCode, allow: true, grants: [{ ...base, scope: "project", projectIds: ["pa"], capabilities: [...reads, "questions.answer"] }] })).body).toEqual({ state: "recorded" });
    const devices = ((await desktop.handle("GET", "/api/mobile/phones", {})).body as { devices: { access: unknown; grants?: unknown }[] }).devices;
    expect(devices.map(d => d.access)).toEqual(expect.arrayContaining([
      { scope: "all", projects: 0, sessions: 0, jobs: 0, answers: false },
      { scope: "project", projects: 1, sessions: 0, jobs: 0, answers: true }]));
    expect(devices.every(d => !("grants" in d))).toBe(true);
  });

  it("rejects folders, stale IDs, remote PCs and caller-added authority fields without consuming the claim", async () => {
    view.sessions = [session("s1", "opaque-a")]; source.projectFolders = () => new Map([["opaque-a", "E:/Fixture/alpha"]]);
    const { desktop, headers } = await admin(), pending = claim();
    const base = { pcId, scope: "project", projectIds: ["opaque-a"], sessionIds: [], jobIds: [], capabilities: reads };
    for (const grant of [{ ...base, projectIds: ["E:/Fixture/alpha"] }, { ...base, projectIds: ["stale-id"] }, { ...base, pcId: "remote-pc" }, { ...base, folder: "E:/Fixture/alpha" }, { ...base, targets: ["*"] }, { ...base, capabilities: ["permissions.approve"] }]) {
      await expect(desktop.handle("POST", "/api/mobile/claims/" + pending.claimId, headers(), JSON.stringify({ comparisonCode: pending.comparisonCode, allow: true, grants: [grant] }))).rejects.toThrow();
      expect(store.pending().map(c => c.claimId)).toContain(pending.claimId);
    }
    await expect(desktop.handle("POST", "/api/mobile/claims/" + pending.claimId, headers(), JSON.stringify({ comparisonCode: pending.comparisonCode === "000000" ? "111111" : "000000", allow: true, grants: [base] }))).rejects.toThrow("pairing_conflict");
    const request = { comparisonCode: pending.comparisonCode, allow: true, grants: [base] };
    expect((await desktop.handle("POST", "/api/mobile/claims/" + pending.claimId, headers(), JSON.stringify(request))).status).toBe(200);
    at += 120_000;
    const expired = claim(); at += 120_000;
    await expect(desktop.handle("POST", "/api/mobile/claims/" + expired.claimId, headers(), JSON.stringify({ ...request, comparisonCode: expired.comparisonCode }))).rejects.toThrow("pairing_conflict");
  });
});
