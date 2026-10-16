import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalProjectRoot } from "../src/core/project-identity.js";
import { nullLogger } from "../src/core/logger.js";
import { OwnerQuestionService } from "../src/core/owner-question-service.js";
import { MessageStore } from "../src/core/store.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { provisionMobile } from "../src/mobile/bootstrap.js";
import { MobileDesktopAdmin } from "../src/mobile/desktop.js";
import { projectQuestion, type MobileSource, type SourceView } from "../src/mobile/adapter.js";
import { MobilePush } from "../src/mobile/push.js";
import { MobileStore, type Device } from "../src/mobile/store.js";
import type { MobileRequest } from "../src/mobile/gateway.js";
import type { Credentials, Grant, PairingClaim, PairingQr } from "../src/mobile/contract.js";
import { makeEnv, type TestEnv } from "./helpers.js";

// AB-434: count project-root discovery reads (pointer/HEAD/commondir/gitdir/config files) without changing behaviour.
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const reads = vi.mocked(readFileSync);
let env: TestEnv;
const closers: (() => void | Promise<void>)[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.useRealTimers(); await env.cleanup();
});
const discoveryReads = () => reads.mock.calls.filter(([path]) => String(path).startsWith(env.home)).length;

function repository(root: string): void {
  mkdirSync(join(root, ".git", "objects"), { recursive: true }); mkdirSync(join(root, ".git", "refs"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n"); writeFileSync(join(root, ".git", "config"), "[core]\n\tbare = false\n");
}
function linked(cwd: string, root: string, name: string): void {
  mkdirSync(cwd, { recursive: true });
  const gitDir = join(root, ".git", "worktrees", name); mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(cwd, ".git"), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${name}\n`);
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  writeFileSync(join(gitDir, "gitdir"), `${join(cwd, ".git")}\n`);
}
/** N job working folders spread over a few project roots, like the broker's run list. */
function jobs(count: number) {
  const roots = ["alpha", "beta", "gamma"].map(name => join(env.home, name)); roots.forEach(repository);
  const folders = Array.from({ length: count }, (_, i) => { const cwd = join(env.home, "worktrees", `job-${i}`); linked(cwd, roots[i % roots.length]!, `job-${i}`); return cwd; });
  return { roots, folders };
}

describe("project-root memo", () => {
  it("re-reads no Git metadata for unchanged jobs and re-discovers a changed root immediately", () => {
    const { roots, folders } = jobs(24);
    const first = folders.map(canonicalProjectRoot);
    expect(first).toEqual(folders.map((_, i) => realpathSync.native(roots[i % roots.length]!)));
    reads.mockClear();
    expect(folders.map(canonicalProjectRoot)).toEqual(first);
    expect(discoveryReads()).toBe(0);
    // Move one job to another project: its pointer files change, so only it is discovered again.
    linked(folders[0]!, roots[1]!, "job-0-moved"); reads.mockClear();
    expect(canonicalProjectRoot(folders[0]!)).toBe(realpathSync.native(roots[1]!));
    expect(discoveryReads()).toBeGreaterThan(0);
    reads.mockClear();
    expect(folders.slice(1).map(canonicalProjectRoot)).toEqual(first.slice(1));
    expect(discoveryReads()).toBe(0);
  });

  it("returns exactly what an uncached discovery returns, including null, plain folders and aliases", async () => {
    const { folders } = jobs(6), plain = join(env.home, "plain"); mkdirSync(plain);
    const alias = join(env.home, "alias"); symlinkSync(folders[2]!, alias, process.platform === "win32" ? "junction" : "dir");
    const damaged = join(env.home, "damaged"); mkdirSync(damaged); writeFileSync(join(damaged, ".git"), "not a pointer\n");
    const inputs = [...folders, plain, alias, damaged, join(env.home, "missing")];
    const cached = inputs.map(canonicalProjectRoot); expect(inputs.map(canonicalProjectRoot)).toEqual(cached);
    vi.resetModules();
    const uncached = await import("../src/core/project-identity.js");
    expect(inputs.map(uncached.canonicalProjectRoot)).toEqual(cached);
    expect(cached.slice(-2)).toEqual([null, null]);
    expect(cached[folders.length + 1]).toBe(cached[2]);
    // A Git repository appearing above a plain folder is seen at once, not after the memo lifetime.
    repository(env.home);
    expect(canonicalProjectRoot(plain)).toBe(realpathSync.native(env.home));
  });
});

const pcId = "fixture-pc", origin = "https://pc.fixture.test:4433";
function req(method: string, path: string, c?: Credentials, body?: unknown, extra: Record<string, string> = {}): MobileRequest {
  return { method, path: "/mobile/v1" + path, authority: new URL(origin).host, tls: true, remoteAddress: "fixture", headers: {
    ...(c ? { authorization: "Bearer " + c.accessToken, "x-mobile-csrf": c.csrfToken } : {}),
    ...(method !== "GET" ? { "idempotency-key": randomUUID() } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra,
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
}
function mobileFixture(questionProject = env.home) {
  const home = env.home, messages = new MessageStore(join(home, "bridge.db"), nullLogger);
  const peers: PeerInfo[] = [{ id: "main-peer", name: "main", agent: "codex", pid: 2, agentPid: null, cwd: home, sessionId: "main-session", activity: "idle", autoWake: false, startedAt: 1, projectMain: true, wakeAvailable: true, wakeOnDirect: true }];
  const service = new OwnerQuestionService(home, messages, nullLogger, () => peers, vi.fn());
  // Each title is its own topic: the store merges asks that share one.
  const ask = (title: string) => service.store.ask({ title, topic: title === "Fixture scope" ? "scope" : title, context: "Synthetic question", options: [
    { id: "keep", label: "Keep", consequence: "Preserves", recommended: true }, { id: "wait", label: "Wait", consequence: "Defers", recommended: false },
  ], blocking: true, blocks: "Synthetic action", meanwhile: "Read source" }, questionProject, { session: "main", sessionId: "main-session", main: "main", mainSessionId: "main-session", agent: "codex" }).question;
  const q = ask("Fixture scope");
  closers.push(() => { service.close(); messages.close(); });
  // Every source snapshot reads the peers first: counting them counts snapshot work.
  const snapshotPeers = vi.fn(() => peers), list = vi.spyOn(service, "list");
  const submit = vi.fn(async () => ({ state: "submitted" as const })), projectId = randomUUID();
  const mobile = provisionMobile({ registryFile: join(home, "mobile.db"), pcId, origins: [origin], desktopOrigin: "http://127.0.0.1:4321",
    local: { home, log: nullLogger, peers: snapshotPeers }, ownerQuestions: service, ready: () => true,
    push: { provider: { submit }, encryptionKey: new Uint8Array(32).fill(7), projectId, environment: "development" } });
  closers.push(mobile.close);
  return { mobile, q, ask, snapshotPeers, list, submit, projectId };
}
async function adminHeaders(admin: MobileDesktopAdmin) {
  const csrf = ((await admin.handle("GET", "/api/mobile/phones", {})).body as { csrfToken: string }).csrfToken;
  return () => ({ origin: admin.localOrigin, "x-mobile-admin-csrf": csrf, "idempotency-key": randomUUID(), "content-type": "application/json" });
}
async function claim(mobile: ReturnType<typeof provisionMobile>, headers: () => Record<string, string>): Promise<PairingClaim> {
  const qr = ((await mobile.desktopAdmin.handle("POST", "/api/mobile/invitations", headers(), "{}")).body as { qr: PairingQr }).qr;
  return (await mobile.gateway.handle(req("POST", "/pairing/claims", undefined, { invitationId: qr.invitationId, nonce: qr.nonce, deviceName: "Fixture phone", platform: "android" }))).body as PairingClaim;
}

/** Pairs one phone with the given grant and registers it for push; returns its credentials. */
async function subscribe(fx: ReturnType<typeof mobileFixture>, headers: () => Record<string, string>, grantedProjectId = projectQuestion(fx.q, pcId).projectId): Promise<Credentials> {
  const { mobile, projectId } = fx, pending = await claim(mobile, headers);
  const grant: Grant = { pcId, projectIds: [grantedProjectId], sessionIds: [], jobIds: [], capabilities: ["overview.read", "questions.read"] };
  expect((await mobile.desktopAdmin.handle("POST", "/api/mobile/claims/" + pending.claimId, headers(), JSON.stringify({ comparisonCode: pending.comparisonCode, allow: true, grants: [grant] }))).status).toBe(200);
  const issued = await mobile.gateway.handle(req("GET", "/pairing/claims/" + pending.claimId, undefined, undefined, { authorization: "Bearer " + pending.claimToken, "idempotency-key": randomUUID() }));
  const c = (issued.body as { credentials: Credentials }).credentials;
  expect((await mobile.gateway.handle(req("PUT", "/me/push", c, { expoPushToken: "ExpoPushToken[fixture-only]", platform: "android", projectId, environment: "development" }))).status).toBe(200);
  return c;
}

describe("mobile hint poll and pairing cost", () => {
  it("skips the poll without reading any source while no device has a push subscription", async () => {
    const { mobile, snapshotPeers, list, submit } = mobileFixture();
    await mobile.pollQuestionHints(); await mobile.pollQuestionHints();
    expect(snapshotPeers).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  });

  it("hints from questions only, never overlaps, and repeats no work for unchanged questions", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const { mobile, q, snapshotPeers, list, submit, projectId } = mobileFixture(), headers = await adminHeaders(mobile.desktopAdmin);
    const pending = await claim(mobile, headers);
    const grant: Grant = { pcId, projectIds: [projectQuestion(q, pcId).projectId], sessionIds: [], jobIds: [], capabilities: ["overview.read", "questions.read"] };
    expect((await mobile.desktopAdmin.handle("POST", "/api/mobile/claims/" + pending.claimId, headers(), JSON.stringify({ comparisonCode: pending.comparisonCode, allow: true, grants: [grant] }))).status).toBe(200);
    const issued = await mobile.gateway.handle(req("GET", "/pairing/claims/" + pending.claimId, undefined, undefined, { authorization: "Bearer " + pending.claimToken, "idempotency-key": randomUUID() }));
    const c = (issued.body as { credentials: Credentials }).credentials;
    expect((await mobile.gateway.handle(req("PUT", "/me/push", c, { expoPushToken: "ExpoPushToken[fixture-only]", platform: "android", projectId, environment: "development" }))).status).toBe(200);
    snapshotPeers.mockClear(); list.mockClear();
    const a = mobile.pollQuestionHints(), b = mobile.pollQuestionHints();
    expect(b).toBe(a); await a;
    expect(submit).toHaveBeenCalledTimes(1); expect(snapshotPeers).not.toHaveBeenCalled();
    list.mockClear();
    for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(2000); await mobile.pollQuestionHints(); }
    expect(submit).toHaveBeenCalledTimes(1); expect(snapshotPeers).not.toHaveBeenCalled();
    // One question listing per tick and no per-device re-reads for an already hinted question.
    expect(list).toHaveBeenCalledTimes(5);
  });

  it("shows a new pending claim on the desktop phones view without new snapshot work", async () => {
    let now = 1_000_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const { mobile, snapshotPeers } = mobileFixture(), headers = await adminHeaders(mobile.desktopAdmin);
    expect(snapshotPeers).toHaveBeenCalledTimes(1);
    const pending = await claim(mobile, headers);
    const view = (await mobile.desktopAdmin.handle("GET", "/api/mobile/phones", {})).body as { pending: { claimId: string; comparisonCode: string }[]; catalog: { projects: unknown[] } };
    expect(view.pending).toEqual([expect.objectContaining({ claimId: pending.claimId, comparisonCode: pending.comparisonCode })]);
    expect(view.catalog.projects.length).toBeGreaterThan(0);
    expect(snapshotPeers).toHaveBeenCalledTimes(1);
    // A stale catalog is still served at once; the refresh runs once in the background.
    now += MobileDesktopAdmin.CATALOG_MS;
    const again = await mobile.desktopAdmin.handle("GET", "/api/mobile/phones", {});
    expect((again.body as { pending: unknown[] }).pending).toHaveLength(1);
    await vi.waitFor(() => expect(snapshotPeers).toHaveBeenCalledTimes(2));
  });
});

describe("incremental hint poll re-offers on real changes only", () => {
  it("reconsiders the same question when root discovery changes its project eligibility", async () => {
    const child = join(env.home, "child"); mkdirSync(child);
    const notify = vi.spyOn(MobilePush.prototype, "notify"), subscriptionState = vi.spyOn(MobilePush.prototype, "subscriptionState");
    const fx = mobileFixture(child), headers = await adminHeaders(fx.mobile.desktopAdmin);
    const parentId = projectQuestion({ ...fx.q, project: env.home }, pcId).projectId;
    expect(projectQuestion(fx.q, pcId).projectId).not.toBe(parentId);
    const credentials = await subscribe(fx, headers, parentId);
    const store = fx.mobile.gateway.store, dedupe = `${credentials.deviceId}:${fx.q.id}:${fx.q.askedAt}`;
    fx.snapshotPeers.mockClear();
    await fx.mobile.pollQuestionHints();
    expect(notify).toHaveBeenCalledTimes(1); expect(fx.submit).not.toHaveBeenCalled();
    expect(store.get("push-dedupe", dedupe)).toBeUndefined();
    // Same stored question and subscribers; the newly discovered parent repository changes only projection.
    repository(env.home);
    expect(projectQuestion(fx.q, pcId).projectId).toBe(parentId);
    await fx.mobile.pollQuestionHints();
    expect(notify).toHaveBeenCalledTimes(2); expect(fx.submit).toHaveBeenCalledTimes(1);
    expect(subscriptionState.mock.results[1]!.value).toBe(subscriptionState.mock.results[0]!.value);
    expect(notify.mock.calls[1]![0]).toMatchObject({ id: fx.q.id, askedAt: fx.q.askedAt, projectId: parentId });
    expect(store.get("push-dedupe", dedupe)).toEqual({ state: "submitted" });
    // Moving the child to another repository rechecks actual grants; moving back rechecks persisted dedupe.
    const other = join(env.home, "other"); repository(other); linked(child, other, "child");
    await fx.mobile.pollQuestionHints(); expect(notify).toHaveBeenCalledTimes(3); expect(fx.submit).toHaveBeenCalledTimes(1);
    linked(child, env.home, "child-returned");
    await fx.mobile.pollQuestionHints(); expect(notify).toHaveBeenCalledTimes(4); expect(fx.submit).toHaveBeenCalledTimes(1);
    await fx.mobile.pollQuestionHints(); expect(notify).toHaveBeenCalledTimes(4);
    expect(fx.snapshotPeers).not.toHaveBeenCalled();
  });

  it("hints a question asked after the first poll", async () => {
    const fx = mobileFixture(), headers = await adminHeaders(fx.mobile.desktopAdmin); await subscribe(fx, headers);
    await fx.mobile.pollQuestionHints(); expect(fx.submit).toHaveBeenCalledTimes(1);
    fx.ask("Second fixture question");
    await fx.mobile.pollQuestionHints(); expect(fx.submit).toHaveBeenCalledTimes(2);
    await fx.mobile.pollQuestionHints(); expect(fx.submit).toHaveBeenCalledTimes(2);
  });

  it("offers every open question again when a device's grants or revision change", async () => {
    const notify = vi.spyOn(MobilePush.prototype, "notify");
    const fx = mobileFixture(), headers = await adminHeaders(fx.mobile.desktopAdmin), c = await subscribe(fx, headers);
    await fx.mobile.pollQuestionHints(); await fx.mobile.pollQuestionHints(); expect(notify).toHaveBeenCalledTimes(1);
    const store = fx.mobile.gateway.store, device = store.get<Device>("device", c.deviceId)!;
    store.put("device", device.id, { ...device, revision: randomUUID(), grants: device.grants.map(g => ({ ...g, capabilities: [...g.capabilities, "chat.read" as const] })) });
    await fx.mobile.pollQuestionHints(); expect(notify).toHaveBeenCalledTimes(2);
    // The persisted per-device dedupe still prevents a duplicate hint for the same question.
    expect(fx.submit).toHaveBeenCalledTimes(1);
  });

  it("never hints a revoked device on the incremental path", async () => {
    const fx = mobileFixture(), headers = await adminHeaders(fx.mobile.desktopAdmin);
    const first = await subscribe(fx, headers); await subscribe(fx, headers);
    await fx.mobile.pollQuestionHints(); expect(fx.submit).toHaveBeenCalledTimes(2);
    fx.mobile.gateway.store.revoke(first.deviceId);
    fx.ask("Asked after revocation");
    await fx.mobile.pollQuestionHints(); expect(fx.submit).toHaveBeenCalledTimes(3);
    fx.mobile.gateway.store.revoke(fx.mobile.gateway.store.list<Device>("device").find(d => !d.revoked)!.id);
    fx.ask("Asked with no device left"); fx.list.mockClear();
    await fx.mobile.pollQuestionHints(); expect(fx.submit).toHaveBeenCalledTimes(3); expect(fx.list).not.toHaveBeenCalled();
  });
});

describe("desktop catalog refresh", () => {
  function deferred() {
    let resolve!: (view: SourceView) => void, reject!: (error: Error) => void;
    const promise = new Promise<SourceView>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }
  function view(id: string): SourceView {
    return { sessions: [{ id, pcId, generation: id, name: id, agent: "codex", projectId: null, activity: "idle", connection: "connected",
      parentId: null, chatId: null, sendSupported: false, sampledAt: Date.now(), version: id }], jobs: [], questions: [], sampledAt: Date.now(), sourceState: "ready" };
  }
  function fixture(snapshot: MobileSource["snapshot"]) {
    const store = new MobileStore(join(env.home, "mobile.db"), pcId, origin); closers.push(() => store.close());
    const admin = new MobileDesktopAdmin(store, { snapshot } as MobileSource, "http://127.0.0.1:4321");
    const read = async () => (await admin.handle("GET", "/api/mobile/phones", {})).body as { catalog: { sessions: { id: string }[]; stale: boolean } };
    return { store, admin, read };
  }

  it("never publishes timed-out A after replacement B or authorizes A's retired identities", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const a = deferred(), b = deferred(), current = view("replacement");
    const snapshot = vi.fn<MobileSource["snapshot"]>().mockResolvedValueOnce(view("initial"))
      .mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise).mockResolvedValue(current);
    const { admin, store, read } = fixture(snapshot), headers = await adminHeaders(admin);
    vi.advanceTimersByTime(MobileDesktopAdmin.CATALOG_MS);
    await read(); expect(snapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MobileDesktopAdmin.REFRESH_TIMEOUT_MS);
    await read(); expect(snapshot).toHaveBeenCalledTimes(3);
    b.resolve(current); await vi.advanceTimersByTimeAsync(0);
    expect((await read()).catalog.sessions).toEqual([expect.objectContaining({ id: "replacement" })]);
    a.resolve(view("retired")); await vi.advanceTimersByTimeAsync(0);
    expect((await read()).catalog.sessions).toEqual([expect.objectContaining({ id: "replacement" })]);
    const invitation = store.invite(), pending = store.claim(invitation.invitationId, invitation.nonce, "Fixture", "android", randomUUID()) as PairingClaim;
    const confirm = (id: string) => admin.handle("POST", "/api/mobile/claims/" + pending.claimId, headers(), JSON.stringify({
      comparisonCode: pending.comparisonCode, allow: true,
      grants: [{ pcId, projectIds: [], sessionIds: [id], jobIds: [], capabilities: ["overview.read"] }],
    }));
    await expect(confirm("retired")).rejects.toMatchObject({ status: 403, code: "unsupported_grant" });
    expect(snapshot).toHaveBeenCalledTimes(4); expect(store.list("device")).toHaveLength(0);
    expect((await confirm("replacement")).status).toBe(200); expect(snapshot).toHaveBeenCalledTimes(4);
  });

  it("caps unsettled traversals at two, serves explicitly stale claims live, and frees a settled quarantine", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const a = deferred(), b = deferred(), c = deferred(); let active = 0, peak = 0;
    const track = (work: ReturnType<typeof deferred>) => { active++; peak = Math.max(peak, active); return work.promise.finally(() => { active--; }); };
    const snapshot = vi.fn<MobileSource["snapshot"]>().mockResolvedValueOnce(view("initial"))
      .mockImplementationOnce(() => track(a)).mockImplementationOnce(() => track(b)).mockImplementationOnce(() => track(c));
    const { admin, store, read } = fixture(snapshot), headers = await adminHeaders(admin);
    vi.advanceTimersByTime(MobileDesktopAdmin.CATALOG_MS);
    await read(); await read(); expect(active).toBe(1); expect(snapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MobileDesktopAdmin.REFRESH_TIMEOUT_MS);
    await read(); await read(); expect(active).toBe(2); expect(snapshot).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(MobileDesktopAdmin.REFRESH_TIMEOUT_MS);
    const invitation = store.invite(), pending = store.claim(invitation.invitationId, invitation.nonce, "Live claim", "android", randomUUID()) as PairingClaim;
    for (let i = 0; i < 4; i++) {
      const response = await read();
      expect(snapshot).toHaveBeenCalledTimes(3);
      expect(response.catalog.stale).toBe(true);
      expect(response).toMatchObject({ pending: [expect.objectContaining({ claimId: pending.claimId })] });
      await vi.advanceTimersByTimeAsync(MobileDesktopAdmin.REFRESH_TIMEOUT_MS);
    }
    expect(snapshot).toHaveBeenCalledTimes(3); expect(active).toBe(2); expect(peak).toBe(2);
    // The stale displayed session is not sufficient evidence for a grant while both slots are quarantined.
    await expect(admin.handle("POST", "/api/mobile/claims/" + pending.claimId, headers(), JSON.stringify({
      comparisonCode: pending.comparisonCode, allow: true,
      grants: [{ pcId, projectIds: [], sessionIds: ["initial"], jobIds: [], capabilities: ["overview.read"] }],
    }))).rejects.toMatchObject({ status: 503, code: "catalog_refresh_busy" });
    expect(store.list("device")).toHaveLength(0); expect(snapshot).toHaveBeenCalledTimes(3);
    a.reject(new Error("Late source failure")); await vi.advanceTimersByTimeAsync(0); expect(active).toBe(1);
    expect((await read()).catalog.sessions[0]!.id).toBe("initial"); expect(snapshot).toHaveBeenCalledTimes(4); expect(active).toBe(2);
    c.resolve(view("recovered")); await vi.advanceTimersByTimeAsync(0);
    expect((await read()).catalog).toMatchObject({ sessions: [{ id: "recovered" }], stale: false });
    b.resolve(view("retired")); await vi.advanceTimersByTimeAsync(0);
    expect((await read()).catalog.sessions[0]!.id).toBe("recovered"); expect(active).toBe(0); expect(peak).toBe(2);
  });

  it("bounds first-catalog callers at 15 seconds and refuses a third uncancellable traversal without a cache", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const a = deferred(), b = deferred();
    const snapshot = vi.fn<MobileSource["snapshot"]>().mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise);
    const { read } = fixture(snapshot);
    const first = read(), joined = read(); let settled = false;
    const firstFailure = expect(first).rejects.toMatchObject({ status: 503, code: "source_unavailable" });
    const joinedFailure = expect(joined).rejects.toMatchObject({ status: 503, code: "source_unavailable" });
    void first.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(MobileDesktopAdmin.REFRESH_TIMEOUT_MS - 1); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await firstFailure; await joinedFailure; expect(snapshot).toHaveBeenCalledTimes(1);
    const secondFailure = expect(read()).rejects.toMatchObject({ status: 503, code: "source_unavailable" });
    await vi.advanceTimersByTimeAsync(MobileDesktopAdmin.REFRESH_TIMEOUT_MS); await secondFailure;
    for (let i = 0; i < 4; i++) {
      await expect(read()).rejects.toMatchObject({ status: 503, code: "catalog_refresh_busy" });
      await vi.advanceTimersByTimeAsync(MobileDesktopAdmin.REFRESH_TIMEOUT_MS);
    }
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("releases a refresh whose snapshot never settles and keeps serving the last catalog", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const store = new MobileStore(join(env.home, "mobile.db"), pcId, origin); closers.push(() => store.close());
    const view = { sessions: [], jobs: [], questions: [], sampledAt: 0, sourceState: "ready" as const };
    const snapshot = vi.fn<MobileSource["snapshot"]>().mockResolvedValueOnce(view).mockImplementation(() => new Promise(() => {}));
    const source = { snapshot } as unknown as MobileSource, admin = new MobileDesktopAdmin(store, source, "http://127.0.0.1:4321");
    expect((await admin.handle("GET", "/api/mobile/phones", {})).status).toBe(200);
    vi.advanceTimersByTime(MobileDesktopAdmin.CATALOG_MS);
    expect((await admin.handle("GET", "/api/mobile/phones", {})).status).toBe(200); expect(snapshot).toHaveBeenCalledTimes(2);
    expect((await admin.handle("GET", "/api/mobile/phones", {})).status).toBe(200); expect(snapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MobileDesktopAdmin.REFRESH_TIMEOUT_MS);
    expect((await admin.handle("GET", "/api/mobile/phones", {})).status).toBe(200); expect(snapshot).toHaveBeenCalledTimes(3);
  });
});
