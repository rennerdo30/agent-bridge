import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer, request } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeNode } from "../src/core/node.js";
import { Broker } from "../src/core/broker.js";
import { nullLogger } from "../src/core/logger.js";
import { resolvePipePath } from "../src/core/paths.js";
import * as processIdentity from "../src/core/process-identity.js";
import { OwnerQuestionService } from "../src/core/owner-question-service.js";
import { ownerQuestionVersion } from "../src/core/owner-questions.js";
import { MessageStore } from "../src/core/store.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { startUi } from "../src/cli/ui.js";
import { DashboardController, hostDashboard } from "../src/cli/dashboard.js";
import { MobileClient, type StoredDevice, type WireFetch } from "../apps/mobile/src/client.js";
import { provisionMobile } from "../src/mobile/bootstrap.js";
import { projectQuestion, type MobileSource } from "../src/mobile/adapter.js";
import { prepareMobileDesktopHost } from "../src/mobile/host.js";
import { createMobileHttpsListeners, type MobileListenerConfig } from "../src/mobile/https.js";
import type { MobileGateway, MobileRequest } from "../src/mobile/gateway.js";
import type { Credentials, Grant, PairingClaim, PairingQr, Snapshot } from "../src/mobile/contract.js";
import type { PushHint } from "../src/mobile/push.js";
import baseline from "./fixtures/mobile-wiring-baseline.json" with { type: "json" };

// HTTPS lifecycle simulation only; no certificates, TLS acceptance or private listeners are activated.
vi.mock("../src/mobile/https.js", () => ({ createMobileHttpsListeners: vi.fn((_gateway: unknown, configs: MobileListenerConfig[]) => configs.map(config => {
  const server = Object.assign(new EventEmitter(), { listening: false, closeAllConnections: vi.fn(),
    close: vi.fn(function (this: { listening: boolean }, callback?: (error?: Error) => void) { this.listening = false; callback?.(); return this; }) });
  return { config, server: server as unknown as HttpsServer };
})) }));
const pcId = "fixture-pc", origin = "https://pc.fixture.test:4433", origins = [origin, "https://pc.tailnet.ts.net"];
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.mocked(createMobileHttpsListeners).mockClear(); });
function fixtureHome() { const root = resolve(".agent-bridge-test/mobile-wiring"); mkdirSync(root, { recursive: true }); return mkdtempSync(join(root, "run-")); }
function fixture(home = fixtureHome()) {
  const messages = new MessageStore(join(home, "bridge.db"), nullLogger);
  const peers: PeerInfo[] = [{ id: "asker-peer", name: "asker", agent: "codex", pid: 1, agentPid: null, cwd: home, sessionId: "asker-session", activity: "busy", autoWake: false, startedAt: 1, subagent: true },
    { id: "main-peer", name: "main", agent: "codex", pid: 2, agentPid: null, cwd: home, sessionId: "main-session", activity: "idle", autoWake: false, startedAt: 1, projectMain: true, wakeAvailable: true, wakeOnDirect: true }];
  const emit = vi.fn(), service = new OwnerQuestionService(home, messages, nullLogger, () => peers, emit);
  const q = service.store.list()[0] ?? service.store.ask({ title: "Fixture scope", topic: "scope", context: "Synthetic question", options: [
    { id: "keep", label: "Keep", consequence: "Preserves", recommended: true }, { id: "wait", label: "Wait", consequence: "Defers", recommended: false },
  ], blocking: true, blocks: "Synthetic action", meanwhile: "Read source" }, home,
  { session: "asker", sessionId: "asker-session", main: "main", mainSessionId: "main-session", agent: "codex" }).question;
  let closed = false;
  const close = () => { if (closed) return; closed = true; service.close(); messages.close(); };
  closers.push(close);
  return { home, messages, service, peers, emit, q, close, disown: () => { closers.splice(closers.indexOf(close), 1); } };
}
function config(home: string, desktopOrigin = "http://127.0.0.1:4321") { return { registryFile: join(home, "mobile.db"), pcId, origins, desktopOrigin }; }
function req(method: string, path: string, c?: Credentials, body?: unknown, extra: Record<string, string> = {}): MobileRequest {
  return { method, path: "/mobile/v1" + path, authority: new URL(origin).host, tls: true, remoteAddress: "fixture", headers: {
    ...(c ? { authorization: "Bearer " + c.accessToken, "x-mobile-csrf": c.csrfToken } : {}),
    ...(method !== "GET" ? { "idempotency-key": randomUUID() } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra,
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
}
async function pair(mobile: ReturnType<typeof provisionMobile>, projectId: string): Promise<Credentials> {
  const admin = mobile.desktopAdmin, meta = await admin.handle("GET", "/api/mobile/phones", {}), csrf = (meta.body as { csrfToken: string }).csrfToken;
  const headers = { origin: admin.localOrigin, "x-mobile-admin-csrf": csrf, "idempotency-key": randomUUID(), "content-type": "application/json" };
  const invitation = await admin.handle("POST", "/api/mobile/invitations", headers, "{}"), qr = (invitation.body as { qr: PairingQr }).qr;
  const claimed = await mobile.gateway.handle(req("POST", "/pairing/claims", undefined, { invitationId: qr.invitationId, nonce: qr.nonce, deviceName: "Fixture phone", platform: "android" }));
  const claim = claimed.body as PairingClaim;
  const grant: Grant = { pcId, projectIds: [projectId], sessionIds: [], jobIds: [], capabilities: ["overview.read", "chat.read", "questions.read", "questions.answer"] };
  await admin.handle("POST", "/api/mobile/claims/" + claim.claimId, { ...headers, "idempotency-key": randomUUID() }, JSON.stringify({ comparisonCode: claim.comparisonCode, allow: true, grants: [grant] }));
  const issued = await mobile.gateway.handle(req("GET", "/pairing/claims/" + claim.claimId, undefined, undefined, { authorization: "Bearer " + claim.claimToken, "idempotency-key": randomUUID() }));
  expect(issued.status).toBe(200); return (issued.body as { credentials: Credentials }).credentials;
}
async function snap(gateway: MobileGateway, c: Credentials) { const result = await gateway.handle(req("GET", "/snapshot", c)); expect(result.status).toBe(200); return result.body as Snapshot; }
async function unusedPort() { const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as { port: number }).port; await new Promise<void>(r => server.close(() => r())); return port; }
function hostileHostPost(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port, path: "/api/mobile/invitations", method: "POST", headers: { ...headers, host: "evil.test" } }, response => {
      response.resume(); resolve(response.statusCode!);
    }); call.on("error", reject); call.end("{}");
  });
}
function borrowed(f: ReturnType<typeof fixture>) {
  const broker = new Broker("fixture-unused-pipe", f.messages, nullLogger, "fixture-token");
  const endpoint = { listening: true, close(callback: () => void) { this.listening = false; callback(); } };
  Object.assign(broker, { questions: f.service, server: endpoint });
  vi.spyOn(broker as unknown as { dashboardPeers(): PeerInfo[] }, "dashboardPeers").mockReturnValue(f.peers);
  const node = new BridgeNode({ pipePath: "fixture-unused-pipe", dbPath: ":memory:", token: "fixture-token", name: "fixture", cwd: f.home, agent: "codex", autoWake: false, canHostBroker: false, log: nullLogger });
  Object.assign(node, { broker }); f.disown(); closers.push(() => node.stop());
  return { node, broker };
}
const sha = (source: string) => createHash("sha256").update(source).digest("hex");
function methodBody(source: string, name: string) {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex(line => new RegExp("^  (?:(?:private|public|async) )*" + name + "\\(").test(line));
  if (start < 0) throw new Error("Missing pinned method " + name);
  if (lines[start]!.endsWith(") {}")) return "{}";
  let body = start; while (body < lines.length && !lines[body]!.trim().endsWith("{")) body++;
  const end = lines.findIndex((line, index) => index > body && line === "  }");
  if (end < 0) throw new Error("Missing pinned method end " + name);
  return ["{", ...lines.slice(body + 1, end + 1)]
    .filter(line => !/^\s*if \((?:this\.mobileResources|this\.opts\.mobileAdmin)/.test(line))
    .map(line => line.trim()).filter(Boolean).join("\n");
}

describe("unprepared host compatibility", () => {
  it("pins default broker/node/dashboard control flow and the complete unchanged startUi source", () => {
    for (const [key, expected] of Object.entries(baseline.methods)) {
      const split = key.lastIndexOf(":"), file = key.slice(0, split), name = key.slice(split + 1);
      expect(sha(methodBody(readFileSync(file, "utf8"), name)), key).toBe(expected);
    }
    const ui = readFileSync("src/cli/ui.ts", "utf8").replaceAll("\r\n", "\n")
      .replace('import { UI_PAGE, mobileDashboardPage, safeMobileStatus }', 'import { UI_PAGE }')
      .replace('  mobileStatus?: () => string;\n', '')
      .replace('      if (!opts.mobileAdmin.isReady() || opts.mobileStatus && opts.mobileStatus() !== "ready") return send(res, 503, { code: "source_unavailable" });\n', '')
      .replace('      if (req.method === "GET" && url.pathname === "/api/mobile/status") return send(res, 200, { state: opts.mobileStatus?.() ?? (opts.mobileAdmin.isReady() ? "ready" : "source_unavailable") });\n', '')
      .replace('location: url.searchParams.has("phonesStatus") ? "/?phonesStatus=" + safeMobileStatus(url.searchParams.get("phonesStatus")) : "/"', 'location: "/"')
      .replace('\n    if (req.method === "GET" && url.pathname === "/api/mobile/status" && opts.mobileStatus) {\n      if (req.headers.host !== `127.0.0.1:${req.socket.localPort}` || url.search) return send(res, 403, { code: "desktop_origin" });\n      const status = opts.mobileStatus(); return send(res, 200, { state: status === "ready" ? "ready" : safeMobileStatus(status) });\n    }\n', '')
      .replace('    const mobileReady = !!opts.mobileAdmin?.isReady() && (!opts.mobileStatus || opts.mobileStatus() === "ready");\n', '')
      .replace('    const mobileUnavailable = opts.mobileStatus && !mobileReady ? safeMobileStatus(opts.mobileStatus()) : url.searchParams.has("phonesStatus") ? safeMobileStatus(url.searchParams.get("phonesStatus")) : undefined;\n', '')
      .replace('mobileDashboardPage(mobileReady, mobileUnavailable)', 'UI_PAGE');
    // Reviewed Muse quota/chat additions leave mobile routes and startup pinned.
    const withoutMuse = ui.replace('    readUsage("muse", cfg.museBin, home, log, cfg.museModel),\n', '')
      .replace('["claude", "codex", "opencode", "antigravity", "muse"].includes(local.agent)', '["claude", "codex", "opencode", "antigravity"].includes(local.agent)');
    expect(sha(withoutMuse)).toBe(baseline.uiSha256);
  });
  it("does not open mobile stores, install timers/listeners or initialize a question service without preparation", async () => {
    const home = fixtureHome(), messages = new MessageStore(join(home, "bridge.db"), nullLogger), broker = new Broker("fixture-unused-pipe", messages, nullLogger, "fixture-token");
    const node = new BridgeNode({ pipePath: "fixture-unused-pipe", dbPath: ":memory:", token: "fixture-token", name: "fixture", cwd: home, agent: "codex", autoWake: false, canHostBroker: false, log: nullLogger });
    closers.push(() => node.stop(), () => broker.close());
    const files = readdirSync(home), intervals = vi.spyOn(globalThis, "setInterval"), timeouts = vi.spyOn(globalThis, "setTimeout"), sql = vi.spyOn(DatabaseSync.prototype, "exec"), queries = vi.spyOn(DatabaseSync.prototype, "prepare");
    expect(broker.mobileHostContext()).toBeUndefined(); expect(node.mobileHostContext()).toBeUndefined();
    expect(intervals).not.toHaveBeenCalled(); expect(timeouts).not.toHaveBeenCalled(); expect(sql).not.toHaveBeenCalled(); expect(queries).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual(files); expect(node.listenerCount("stopped")).toBe(0); expect(node.listenerCount("disconnected")).toBe(0);
    expect(createMobileHttpsListeners).not.toHaveBeenCalled();
    const ui = await startUi({ home, pipe: "fixture-unused-pipe", port: 0, log: nullLogger, secret: "a".repeat(64) }); closers.push(ui.close);
    const base = ui.url.split("/?")[0]!, visit = await fetch(ui.url, { redirect: "manual" }), cookie = visit.headers.get("set-cookie")!.split(";")[0]!;
    const page = await fetch(base + "/mobile/phones", { headers: { cookie } });
    expect(page.status).toBe(404); expect(await page.json()).toEqual({ code: "mobile_not_provisioned" });
    expect(createMobileHttpsListeners).not.toHaveBeenCalled(); expect(readdirSync(home)).not.toContain("mobile.db");
  });
});

describe("real owner-question completion and recovery", () => {
  it("recovers callback failure by tick, projects receipts, and reopens/replays without duplicate emit", async () => {
    vi.useFakeTimers(); const f = fixture(), originalTimer = (f.service as unknown as { timer: unknown }).timer;
    const complete = vi.spyOn(f.service, "complete").mockImplementationOnce(() => { throw new Error("fixture callback failure"); }), serviceClose = vi.spyOn(f.service, "close");
    const mobile = provisionMobile({ ...config(f.home), local: { home: f.home, log: nullLogger, peers: () => f.peers }, ownerQuestions: f.service, ready: () => true }); closers.push(mobile.close);
    expect((f.service as unknown as { timer: unknown }).timer).toBe(originalTimer);
    const c = await pair(mobile, projectQuestion(f.q, pcId).projectId), displayed = await snap(mobile.gateway, c), key = randomUUID();
    const intent = { expectedVersion: ownerQuestionVersion(f.q), text: "Exact\nowner fixture intent" };
    const answered = await mobile.gateway.handle(req("POST", `/questions/${f.q.id}/answer`, c, intent, { "x-mobile-view": displayed.cursor, "idempotency-key": key }));
    expect(answered.status).toBe(200); expect(f.service.store.get(f.q.id)?.status).toBe("answered"); expect(f.emit).not.toHaveBeenCalled(); expect(complete).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.emit).toHaveBeenCalledTimes(2); expect(f.messages.unread("asker", 50)).toHaveLength(1);
    const delivered = f.service.store.get(f.q.id)!, mainDelivery = delivered.deliveries.find(d => d.recipient === "main")!;
    const readAt = Date.now(); f.messages.markRead("main", [mainDelivery.messageId!], readAt);
    const enriched = await snap(mobile.gateway, c); expect(enriched.questions[0]?.deliveries.find(d => d.recipientLabel === "main")?.consumedAt).toBe(readAt);
    await vi.advanceTimersByTimeAsync(2000); expect(f.service.store.get(f.q.id)?.deliveryComplete).toBe(true); expect(f.emit).toHaveBeenCalledTimes(2);
    await mobile.close(); expect(serviceClose).not.toHaveBeenCalled(); f.close();
    const reopened = fixture(f.home), again = provisionMobile({ ...config(f.home), local: { home: f.home, log: nullLogger, peers: () => reopened.peers }, ownerQuestions: reopened.service, ready: () => true }); closers.push(again.close);
    const fresh = await snap(again.gateway, c), replay = await again.gateway.handle(req("POST", `/questions/${f.q.id}/answer`, c, intent, { "x-mobile-view": fresh.cursor, "idempotency-key": key }));
    expect(replay.status).toBe(200); expect((replay.body as { question: { deliveries: { recipientLabel: string; consumedAt: number | null }[] } }).question.deliveries.find(d => d.recipientLabel === "main")?.consumedAt).toBe(readAt);
    await vi.advanceTimersByTimeAsync(2000); expect(reopened.emit).not.toHaveBeenCalled(); expect(reopened.messages.unread("asker", 50)).toHaveLength(1);
  });
});

describe("opt-in host ownership and authenticated desktop administration", () => {
  it.each(["close", "abortStartup"] as const)("%s continues core teardown after a rejecting optional disposer and sanitizes diagnostics", async mode => {
    const f = fixture(), { broker } = borrowed(f), context = broker.mobileHostContext()!, serviceClose = vi.spyOn(f.service, "close"), coreClose = vi.spyOn(f.messages, "close");
    const warn = vi.fn(() => { throw new Error("fixture diagnostic sink failure"); }); Object.assign(broker, { log: { ...nullLogger, warn } });
    context.onDispose(() => { throw new Error("fixture sensitive path/body/token must not appear"); });
    const close = mode === "close" ? () => broker.close() : () => (broker as unknown as { abortStartup(): Promise<void> }).abortStartup();
    await expect(close()).resolves.toBeUndefined(); expect(context.ready()).toBe(false); expect(serviceClose).toHaveBeenCalledTimes(1);
    expect(coreClose).toHaveBeenCalledTimes(mode === "close" ? 1 : 0); // Existing abort contract leaves the store with its caller.
    expect(warn).toHaveBeenCalledExactlyOnceWith("mobile shutdown requires restart", { requestId: expect.any(String), errorCategory: "mobile_disposal_failed" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sensitive");
    expect(() => context.ownerQuestions.store.get(f.q.id)).toThrow("source_unavailable");
    expect(() => context.ownerQuestions.list()).toThrow("source_unavailable");
    expect(() => context.ownerQuestions.complete(f.q)).toThrow("source_unavailable");
  });
  it.each(["close", "abortStartup"] as const)("%s bounds a hanging disposer and guards its eventual access to retired resources", async mode => {
    vi.useFakeTimers(); const f = fixture(), { broker } = borrowed(f), context = broker.mobileHostContext()!, host = await prepareMobileDesktopHost({ mobileHostContext: () => context }, config(f.home));
    const serviceClose = vi.spyOn(f.service, "close"), coreClose = vi.spyOn(f.messages, "close"), rawGet = vi.spyOn(f.service.store, "get"), rawList = vi.spyOn(f.service, "list"), rawComplete = vi.spyOn(f.service, "complete"), warn = vi.fn();
    Object.assign(broker, { log: { ...nullLogger, warn } });
    let release!: () => void, late!: Promise<void>;
    const gate = new Promise<void>(resolve => { release = resolve; });
    context.onDispose(() => late = gate.then(() => {
      expect(() => context.ownerQuestions.store.get(f.q.id)).toThrow("source_unavailable");
      expect(() => context.ownerQuestions.store.list()).toThrow("source_unavailable");
      expect(() => context.ownerQuestions.store.answerMobile(f.q.id, { expectedVersion: ownerQuestionVersion(f.q), text: "late fixture" }, "fixture", randomUUID(), { id: "fixture", name: "fixture", agent: "other" })).toThrow("source_unavailable");
      expect(() => context.ownerQuestions.list()).toThrow("source_unavailable");
      expect(() => context.ownerQuestions.complete(f.q)).toThrow("source_unavailable");
      expect(() => context.local.peers()).toThrow("source_unavailable");
    }));
    let finished = false; const close = (mode === "close" ? broker.close() : (broker as unknown as { abortStartup(): Promise<void> }).abortStartup()).then(() => { finished = true; });
    expect(context.ready()).toBe(false); expect((await host.gateway.handle(req("GET", "/hello"))).status).toBe(503);
    await vi.advanceTimersByTimeAsync(4999); expect(finished).toBe(false); expect(serviceClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await close; expect(serviceClose).toHaveBeenCalledTimes(1); expect(coreClose).toHaveBeenCalledTimes(mode === "close" ? 1 : 0);
    expect(warn).toHaveBeenCalledExactlyOnceWith("mobile shutdown requires restart", { requestId: expect.any(String), errorCategory: "mobile_disposal_timeout" });
    rawGet.mockClear(); rawList.mockClear(); rawComplete.mockClear(); release(); await late;
    expect(rawGet).not.toHaveBeenCalled(); expect(rawList).not.toHaveBeenCalled(); expect(rawComplete).not.toHaveBeenCalled();
    expect((await host.gateway.handle(req("GET", "/hello"))).status).toBe(503);
  });
  it.each(["reject", "hang"] as const)("releases the actual isolated fixture endpoint/store after %s so a new node can reacquire it", async failure => {
    vi.stubEnv("AGENT_BRIDGE_HISTORY_INGEST", "0"); vi.stubEnv("AGENT_BRIDGE_AUTO_BACKUP", "0");
    vi.spyOn(MessageStore.prototype, "startBackups").mockImplementation(() => {});
    vi.spyOn(processIdentity, "parentProcessIdentity").mockResolvedValue("synthetic-parent");
    vi.spyOn(processIdentity, "readProcessIdentities").mockImplementation(async pids => new Map(pids.map(pid => [pid, "synthetic-parent"])));
    const f = fixture(), pipe = resolvePipePath(f.home, {}), broker = new Broker(pipe, f.messages, nullLogger, "fixture-token");
    Object.assign(broker, { questions: f.service }); await broker.listen();
    const node = new BridgeNode({ pipePath: pipe, dbPath: join(f.home, "bridge.db"), token: "fixture-token", name: "retiring-fixture", cwd: f.home, agent: "codex", autoWake: false, log: nullLogger });
    Object.assign(node, { broker }); f.disown(); closers.push(() => node.stop());
    const context = broker.mobileHostContext()!, serviceClose = vi.spyOn(f.service, "close"), coreClose = vi.spyOn(f.messages, "close");
    let release!: () => void;
    if (failure === "reject") context.onDispose(async () => { throw new Error("synthetic disposal rejection"); });
    else { const gate = new Promise<void>(resolve => { release = resolve; }); context.onDispose(() => gate); vi.useFakeTimers(); }
    const stopped = node.stop(); if (failure === "hang") await vi.advanceTimersByTimeAsync(5000); await stopped; vi.useRealTimers();
    expect(serviceClose).toHaveBeenCalledTimes(1); expect(coreClose).toHaveBeenCalledTimes(1); expect(node.isBroker).toBe(false);
    const replacement = new BridgeNode({ pipePath: pipe, dbPath: join(f.home, "bridge.db"), token: "fixture-token", name: "replacement-fixture", cwd: f.home, agent: "codex", autoWake: false, log: nullLogger });
    closers.push(() => replacement.stop()); await replacement.start();
    expect(replacement.isBroker).toBe(true); expect(replacement.isConnected).toBe(true); expect(await replacement.peers()).toHaveLength(1);
    if (failure === "hang") release();
  });
  it("borrows only the existing broker service and retires owned listeners before that service closes", async () => {
    const f = fixture(), { node, broker } = borrowed(f), timer = (f.service as unknown as { timer: unknown }).timer;
    const serviceClose = vi.spyOn(f.service, "close"), configs = [{ bindAddress: "127.0.0.1", port: 4433, origin, tls: { key: "synthetic-not-used", cert: "synthetic-not-used" } }];
    const host = await prepareMobileDesktopHost(node, { ...config(f.home), listeners: configs });
    expect(host.ready()).toBe(true); expect((f.service as unknown as { timer: unknown }).timer).toBe(timer); expect(serviceClose).not.toHaveBeenCalled();
    const listener = host.listeners[0]!.server; expect(listener.listening).toBe(false);
    Object.assign(listener, { listening: true }); // Simulated activation: no actual TLS listener.
    const closeOrder: string[] = [], listenerClose = listener.close as unknown as ReturnType<typeof vi.fn>;
    listenerClose.mockImplementation((callback?: () => void) => { closeOrder.push("mobile-listener"); Object.assign(listener, { listening: false }); callback?.(); });
    serviceClose.mockImplementation(() => { closeOrder.push("question-service"); f.service.store.close(); });
    await broker.close();
    expect(closeOrder).toEqual(["mobile-listener", "question-service"]); expect(host.ready()).toBe(false); expect(listener.listening).toBe(false);
    expect((await host.gateway.handle(req("GET", "/hello"))).body).toMatchObject({ code: "source_unavailable" });
    await expect(host.desktopAdmin.handle("GET", "/api/mobile/phones", {})).rejects.toThrow("source_unavailable");
    await expect(host.desktopAdmin.handle("POST", "/api/mobile/invitations", {}, "{}")).rejects.toThrow("source_unavailable");
    expect(node.mobileHostContext()).toBeUndefined();
    await expect(prepareMobileDesktopHost(node, config(f.home))).rejects.toThrow("source_unavailable");
    // Retaining an old handle cannot activate a listener after handover either.
    Object.assign(listener, { listening: true }); listener.emit("listening"); expect(listener.listening).toBe(false);
    closers.splice(closers.length - 1, 1); Object.assign(node, { broker: null }); await node.stop();
  });
  it("disposes a prepared host on node ownership disconnect without closing or retiming the borrowed service", async () => {
    const f = fixture(), { node } = borrowed(f), serviceClose = vi.spyOn(f.service, "close"), timer = (f.service as unknown as { timer: unknown }).timer;
    const host = await prepareMobileDesktopHost(node, config(f.home)); node.emit("disconnected"); await host.close();
    expect(host.ready()).toBe(false); expect(serviceClose).not.toHaveBeenCalled(); expect((f.service as unknown as { timer: unknown }).timer).toBe(timer);
    expect(f.service.store.get(f.q.id)?.status).toBe("open"); expect(node.listenerCount("disconnected")).toBe(0);
    expect((await host.gateway.handle(req("GET", "/snapshot"))).status).toBe(503);
  });
  it("node stop waits for an in-flight hint poll before the broker closes its borrowed question service", async () => {
    const f = fixture(), { node } = borrowed(f), serviceClose = vi.spyOn(f.service, "close");
    let entered!: () => void, finish!: (result: { state: "submitted" }) => void;
    const dispatched = new Promise<void>(resolve => { entered = resolve; });
    const submission = new Promise<{ state: "submitted" }>(resolve => { finish = resolve; });
    const projectId = randomUUID(), host = await prepareMobileDesktopHost(node, { ...config(f.home),
      push: { provider: { submit: async () => { entered(); return submission; } }, encryptionKey: new Uint8Array(32).fill(7), projectId, environment: "development" } });
    const c = await pair(host, projectQuestion(f.q, pcId).projectId);
    expect((await host.gateway.handle(req("PUT", "/me/push", c, { expoPushToken: "ExpoPushToken[fixture-only]", platform: "android", projectId, environment: "development" }))).status).toBe(200);
    const poll = host.pollQuestionHints(); await dispatched;
    const stopped = node.stop();
    expect(host.ready()).toBe(false); expect(serviceClose).not.toHaveBeenCalled(); expect(f.service.store.get(f.q.id)?.status).toBe("open");
    finish({ state: "submitted" }); await poll; await stopped;
    expect(serviceClose).toHaveBeenCalledTimes(1);
    expect((await host.gateway.handle(req("GET", "/hello"))).status).toBe(503);
  });
  it("drains a suspended gateway handler before node/broker disposal closes the borrowed service and registry", async () => {
    const f = fixture(), { node, broker } = borrowed(f), serviceClose = vi.spyOn(f.service, "close");
    const host = await prepareMobileDesktopHost(node, config(f.home)), registryClose = vi.spyOn(host.gateway.store, "close");
    const c = await pair(host, projectQuestion(f.q, pcId).projectId);
    let entered!: () => void, release!: (peers: PeerInfo[]) => void;
    const suspended = new Promise<PeerInfo[]>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    vi.mocked((broker as unknown as { dashboardPeers(): PeerInfo[] }).dashboardPeers).mockImplementationOnce(() => { entered(); return suspended as unknown as PeerInfo[]; });
    const request = host.gateway.handle(req("GET", "/snapshot", c)); await started;
    const stopped = node.stop(), closing = host.close();
    expect(host.close()).toBe(closing); // Node lost and broker close already joined this exact disposal promise.
    expect(serviceClose).not.toHaveBeenCalled(); expect(registryClose).not.toHaveBeenCalled(); expect(f.service.store.get(f.q.id)?.status).toBe("open");
    expect((await host.gateway.handle(req("GET", "/hello"))).status).toBe(503);
    release(f.peers); expect((await request).body).toMatchObject({ code: "source_unavailable" });
    await stopped; await closing;
    expect(registryClose).toHaveBeenCalledTimes(1); expect(serviceClose).toHaveBeenCalledTimes(1);
  });
  it("settles every listener close before mobile close/unregister and aggregates a listener rejection", async () => {
    const f = fixture(), { node } = borrowed(f), serviceClose = vi.spyOn(f.service, "close");
    const host = await prepareMobileDesktopHost(node, { ...config(f.home), listeners: origins.map((address, index) => ({ origin: address,
      bindAddress: index ? "100.64.0.1" : "127.0.0.1", port: index ? 443 : 4433, tls: { key: "synthetic-not-used", cert: "synthetic-not-used" } })) });
    const registryClose = vi.spyOn(host.gateway.store, "close"), first = host.listeners[0]!.server, second = host.listeners[1]!.server;
    Object.assign(first, { listening: true }); Object.assign(second, { listening: true });
    const rejected = new Error("fixture listener close rejection");
    vi.mocked(first.close).mockImplementation(() => { throw rejected; });
    let release!: () => void;
    vi.mocked(second.close).mockImplementation(((callback: () => void) => { release = () => { Object.assign(second, { listening: false }); callback(); }; return second; }) as typeof second.close);
    const closing = host.close(), outcome = closing.catch(error => error as AggregateError);
    expect(host.close()).toBe(closing); expect(second.close).toHaveBeenCalledTimes(1); expect(registryClose).not.toHaveBeenCalled();
    expect(node.listenerCount("disconnected")).toBe(1); // Disposal remains registered while the second listener is pending.
    release(); const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError); if (!(error instanceof AggregateError)) throw new Error("Expected aggregated disposal failure");
    expect(error.errors).toEqual([rejected]);
    expect(second.listening).toBe(false); expect(registryClose).toHaveBeenCalledTimes(1); expect(node.listenerCount("disconnected")).toBe(0);
    expect(serviceClose).not.toHaveBeenCalled(); expect((await host.gateway.handle(req("GET", "/hello"))).status).toBe(503);
    expect(first.close).toHaveBeenCalledTimes(1); // No blind automatic close retry; caller receives the aggregated failure.
  });
  it("retains a committed answer but suppresses its delayed success response during ownership retirement", async () => {
    const f = fixture(), { node } = borrowed(f), host = await prepareMobileDesktopHost(node, config(f.home));
    const c = await pair(host, projectQuestion(f.q, pcId).projectId), displayed = await snap(host.gateway, c);
    const source = (host.gateway as unknown as { source: MobileSource }).source, answer = source.answer.bind(source), serviceClose = vi.spyOn(f.service, "close");
    let entered!: () => void, release!: () => void;
    const committed = new Promise<void>(resolve => { entered = resolve; }), responseGate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(source, "answer").mockImplementation(async (...args) => { const result = await answer(...args); entered(); await responseGate; return result; });
    const request = host.gateway.handle(req("POST", `/questions/${f.q.id}/answer`, c, { expectedVersion: ownerQuestionVersion(f.q), text: "Retained synthetic owner intent" }, { "x-mobile-view": displayed.cursor }));
    await committed; const stopped = node.stop();
    expect(serviceClose).not.toHaveBeenCalled(); expect(f.service.store.get(f.q.id)?.answer?.text).toBe("Retained synthetic owner intent");
    release(); const response = await request; expect(response.status).toBe(503); expect(response.body).toMatchObject({ code: "source_unavailable" });
    expect(JSON.stringify(response.body)).not.toContain("Retained synthetic owner intent"); await stopped;
    const reopened = fixture(f.home); expect(reopened.service.store.get(f.q.id)?.answer?.text).toBe("Retained synthetic owner intent");
  });
  it("bounds a nonsettling handler drain and emits only a safe timeout category before retiring the registry", async () => {
    vi.useFakeTimers(); const f = fixture(), { node, broker } = borrowed(f);
    const host = await prepareMobileDesktopHost(node, config(f.home)), registryClose = vi.spyOn(host.gateway.store, "close"), diagnostics = vi.fn();
    Object.assign(host.gateway, { diagnostics });
    const c = await pair(host, projectQuestion(f.q, pcId).projectId);
    let release!: (peers: PeerInfo[]) => void;
    const suspended = new Promise<PeerInfo[]>(resolve => { release = resolve; });
    vi.mocked((broker as unknown as { dashboardPeers(): PeerInfo[] }).dashboardPeers).mockReturnValueOnce(suspended as unknown as PeerInfo[]);
    // Simulate a future adapter ignoring its normal request deadline to exercise the independent shutdown bound.
    vi.spyOn(host.gateway as unknown as { deadline(work: Promise<unknown>): Promise<unknown> }, "deadline").mockImplementation(work => work);
    const request = host.gateway.handle(req("GET", "/snapshot", c)), outcome = host.close().catch(error => error as AggregateError);
    await vi.advanceTimersByTimeAsync(4999); expect(registryClose).not.toHaveBeenCalled(); expect(diagnostics).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); const error = await outcome;
    expect(error).toBeInstanceOf(AggregateError); expect(registryClose).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveBeenCalledExactlyOnceWith({ requestId: expect.any(String), errorCategory: "gateway_shutdown_timeout" });
    expect(Object.keys(diagnostics.mock.calls[0]![0]).sort()).toEqual(["errorCategory", "requestId"]);
    release(f.peers); expect((await request).body).toMatchObject({ code: "source_unavailable" });
    expect((await host.gateway.handle(req("GET", "/hello"))).status).toBe(503);
  });
  it("pairs/confirms/issues/revokes through real owner-authenticated startUi routes", async () => {
    const f = fixture(), { node } = borrowed(f), port = await unusedPort(), localOrigin = `http://127.0.0.1:${port}`;
    const host = await prepareMobileDesktopHost(node, config(f.home, localOrigin));
    const ui = await startUi({ home: f.home, pipe: "fixture-unused-pipe", port, log: nullLogger, secret: "a".repeat(64), mobileAdmin: host.desktopAdmin }); closers.push(ui.close);
    expect((await fetch(localOrigin + "/mobile/phones")).status).toBe(403);
    const visit = await fetch(ui.url, { redirect: "manual" }), cookie = visit.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(localOrigin + "/mobile/phones", { headers: { cookie } })).status).toBe(200);
    const metadata = await (await fetch(localOrigin + "/api/mobile/phones", { headers: { cookie } })).json() as { csrfToken: string };
    const headers = { cookie, origin: localOrigin, "content-type": "application/json", "x-mobile-admin-csrf": metadata.csrfToken, "idempotency-key": randomUUID() };
    expect(await hostileHostPost(port, headers)).toBe(403);
    expect((await fetch(localOrigin + "/api/mobile/invitations", { method: "POST", headers: { ...headers, origin: "http://evil.test" }, body: "{}" })).status).toBe(403);
    expect((await fetch(localOrigin + "/api/mobile/invitations", { method: "POST", headers: { ...headers, "x-mobile-admin-csrf": "wrong" }, body: "{}" })).status).toBe(403);
    const invitation = await (await fetch(localOrigin + "/api/mobile/invitations", { method: "POST", headers, body: "{}" })).json() as { qr: PairingQr; qrSvg: string };
    expect(invitation.qrSvg).toContain("<svg");
    const result = await host.gateway.handle(req("POST", "/pairing/claims", undefined, { invitationId: invitation.qr.invitationId, nonce: invitation.qr.nonce, deviceName: "Fixture phone", platform: "android" })), claim = result.body as PairingClaim;
    const grant: Grant = { pcId, projectIds: [projectQuestion(f.q, pcId).projectId], sessionIds: [], jobIds: [], capabilities: ["overview.read", "chat.read", "questions.read", "questions.answer"] };
    const confirm = (grants: Grant[], comparisonCode = claim.comparisonCode) => fetch(localOrigin + "/api/mobile/claims/" + claim.claimId, { method: "POST", headers: { ...headers, "idempotency-key": randomUUID() }, body: JSON.stringify({ comparisonCode, allow: true, grants }) });
    expect((await confirm([{ ...grant, sessionIds: ["ungranted-native-id"] }])).status).toBe(403);
    expect((await confirm([grant], claim.comparisonCode === "000000" ? "999999" : "000000")).status).toBe(409);
    expect((await confirm([grant])).status).toBe(200);
    const issued = await host.gateway.handle(req("GET", "/pairing/claims/" + claim.claimId, undefined, undefined, { authorization: "Bearer " + claim.claimToken, "idempotency-key": randomUUID() })), c = (issued.body as { credentials: Credentials }).credentials;
    expect((await snap(host.gateway, c)).questions).toHaveLength(1);
    expect((await fetch(localOrigin + "/api/mobile/devices/" + c.deviceId, { method: "DELETE", headers: { ...headers, "idempotency-key": randomUUID() }, body: "{}" })).status).toBe(204);
    for (const address of origins) expect((await host.gateway.handle({ ...req("GET", "/me", c), authority: new URL(address).host })).status).toBe(401);
  });
  it("fails closed on an exact-port mismatch and never adopts an existing uninjected dashboard", async () => {
    const f = fixture(), { node } = borrowed(f), host = await prepareMobileDesktopHost(node, config(f.home));
    await expect(hostDashboard({ home: f.home, pipe: "fixture-unused-pipe", port: 0, log: nullLogger, mobileAdmin: host.desktopAdmin })).rejects.toThrow("mobile_dashboard_exact_origin_required");
    const ordinary = await hostDashboard({ home: f.home, pipe: "fixture-unused-pipe", port: 0, log: nullLogger }); closers.push(ordinary.close);
    const controller = new DashboardController({ home: f.home, pipe: "fixture-unused-pipe", port: ordinary.info.port, log: nullLogger, mobileAdmin: host.desktopAdmin });
    await expect(controller.ensure()).rejects.toThrow("mobile_dashboard_requires_this_host"); expect(controller.isHosting).toBe(false);
  });
});

describe("configured provisioning push registration and tap", () => {
  it("uses the same configured push for gateway registration, polling and authenticated client tap", async () => {
    const f = fixture(), submit = vi.fn(async (_registration: unknown, _hint: PushHint) => ({ state: "submitted" as const })), projectId = randomUUID();
    const mobile = provisionMobile({ ...config(f.home), local: { home: f.home, log: nullLogger, peers: () => f.peers }, ownerQuestions: f.service, ready: () => true,
      push: { provider: { submit }, encryptionKey: new Uint8Array(32).fill(7), projectId, environment: "development" } }); closers.push(mobile.close);
    const c = await pair(mobile, projectQuestion(f.q, pcId).projectId); expect(mobile.gateway.hello().push).toBe("configured");
    expect((await mobile.gateway.handle(req("GET", "/me", c))).body).toMatchObject({ push: "configured" });
    expect((await mobile.gateway.handle(req("PUT", "/me/push", c, { expoPushToken: "ExpoPushToken[fixture-only]", platform: "android", projectId: randomUUID(), environment: "development" }))).status).toBe(403);
    const wireCalls: string[] = [], wire: WireFetch = async (url, init) => {
      wireCalls.push(url); const u = new URL(url), result = await mobile.gateway.handle({ method: init.method, path: u.pathname + u.search, authority: u.host, tls: true, remoteAddress: "fixture", headers: init.headers, body: init.body });
      return { url, status: result.status, ok: result.status < 300, redirected: false, text: async () => JSON.stringify(result.body ?? null) };
    };
    let saved: StoredDevice | null = { origins, preferredOrigin: origin, credentials: c };
    const client = new MobileClient(wire, { load: async () => saved, save: async value => { saved = value; }, clear: async () => { saved = null; } }, randomUUID);
    await client.initialize(); await client.registerPush({ expoPushToken: "ExpoPushToken[fixture-only]", platform: "android", projectId, environment: "development" });
    await Promise.all([mobile.pollQuestionHints(), mobile.pollQuestionHints()]); expect(submit).toHaveBeenCalledTimes(1);
    const hint = submit.mock.calls[0]![1]; expect(JSON.stringify(hint)).not.toContain(f.q.title); expect(Object.keys(hint.data)).toEqual(["v", "notificationId"]);
    wireCalls.length = 0; expect(await client.resolveNotification(hint.data.notificationId)).toBe(f.q.id);
    expect(wireCalls.some(url => url.endsWith("/auth/refresh"))).toBe(true); expect(wireCalls.some(url => url.endsWith("/snapshot"))).toBe(true);
    const second = await pair(mobile, projectQuestion(f.q, pcId).projectId);
    expect((await mobile.gateway.handle(req("GET", "/notifications/" + hint.data.notificationId, second))).status).toBe(410);
    const active = saved!.credentials; mobile.gateway.store.revoke(active.deviceId);
    expect((await mobile.gateway.handle(req("GET", "/notifications/" + hint.data.notificationId, active))).status).toBe(401);
    await mobile.pollQuestionHints(); expect(submit).toHaveBeenCalledTimes(1);
  });
});
