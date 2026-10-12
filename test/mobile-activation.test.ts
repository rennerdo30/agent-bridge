import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { Server } from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Broker } from "../src/core/broker.js";
import { BridgeNode } from "../src/core/node.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { MobileActivation, configuredMobileDashboard } from "../src/mobile/activation.js";
import { readPrivateMaterial, type EnabledMobileConfig } from "../src/mobile/config.js";
import { createMobileHttpsListeners } from "../src/mobile/https.js";
import type { OwnerQuestionService } from "../src/core/owner-question-service.js";
import type { PushProvider } from "../src/mobile/push.js";
import type { PushHint } from "../src/mobile/push.js";
import type { PreparedMobileDesktopHost } from "../src/mobile/host.js";
import { MobileClient, type StoredDevice, type WireFetch } from "../apps/mobile/src/client.js";
import { projectQuestion } from "../src/mobile/adapter.js";
import type { PairingQr } from "../src/mobile/contract.js";
import { ownerQuestionVersion } from "../src/core/owner-questions.js";
import { DashboardController, hostDashboard } from "../src/cli/dashboard.js";
import { createServer } from "node:http";

vi.mock("../src/mobile/https.js", () => ({ createMobileHttpsListeners: vi.fn() }));
const closers: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.useRealTimers(); });
class Listener extends EventEmitter {
  listening = false; fail = false; closeFail = false; bind = vi.fn();
  listen(port: number, address: string) { this.bind(port, address); queueMicrotask(() => { if (this.fail) this.emit("error", new Error("fixture sensitive bind error")); else { this.listening = true; this.emit("listening"); } }); return this; }
  closeAllConnections() {}
  close(callback?: (error?: Error) => void) { this.listening = false; callback?.(this.closeFail ? new Error("fixture sensitive close error") : undefined); }
}
function fixture() {
  const root = resolve(".agent-bridge-test/mobile-activation"); mkdirSync(root, { recursive: true }); const home = mkdtempSync(join(root, "host-"));
  const messages = new MessageStore(join(home, "bridge.db"), nullLogger), broker = new Broker("fixture-unused", messages, nullLogger, "fixture-token");
  Object.assign(broker, { server: { listening: true, close(callback: () => void) { this.listening = false; callback(); } } });
  const node = new BridgeNode({ pipePath: "fixture-unused", dbPath: ":memory:", token: "fixture-token", name: "fixture", cwd: home, agent: "codex", autoWake: false, log: nullLogger, canHostBroker: false });
  Object.assign(node, { broker }); closers.push(() => node.stop());
  const origins = ["https://lan.fixture:8443", "https://fixture.ts.net:8444"], listeners = origins.map((origin, index) => ({ origin, port: 8443 + index, bindAddress: index ? "100.64.1.2" : "192.168.1.2", certFile: join(home, `cert${index}`), keyFile: join(home, `key${index}`) }));
  for (const listener of listeners) { writeFileSync(listener.certFile, "synthetic cert"); writeFileSync(listener.keyFile, "synthetic key"); }
  const config: EnabledMobileConfig & { listeners: typeof listeners } = { enabled: true, pcId: "fixture-pc", origins, listeners };
  const servers = listeners.map(() => new Listener());
  vi.mocked(createMobileHttpsListeners).mockImplementation((_, configs) => configs.map((config, i) => ({ config, server: servers[i]! as unknown as Server })));
  const ensure = vi.fn(async () => ({ url: "http://127.0.0.1:4321/?t=fixture", port: 4321, pid: 0 })), desktopClose = vi.fn(async () => {}), desktop = vi.fn(() => ({ ensure, close: desktopClose }));
  const material = vi.fn((file: string) => readPrivateMaterial(file, { platform: "win32", acl: async () => true })), validateTls = vi.fn();
  const log = { ...nullLogger, warn: vi.fn() }, options = { home, pipe: "fixture-unused", port: 4321, log };
  const activation = (extra = {}) => { const a = new MobileActivation(node, config, options, { material, validateTls, desktop, ...extra }); closers.push(() => a.close()); return a; };
  return { home, messages, node, broker, config, servers, material, validateTls, desktop, ensure, desktopClose, options, activation };
}
function service(broker: Broker) { return (broker as unknown as { questions: OwnerQuestionService | null }).questions; }
function question(f: ReturnType<typeof fixture>) {
  return service(f.broker)!.store.ask({ title: "Synthetic activation question", topic: "fixture", context: "Synthetic only", options: [
    { id: "keep", label: "Keep", consequence: "Preserve", recommended: true }, { id: "wait", label: "Wait", consequence: "Defer", recommended: false }], blocking: true, blocks: "fixture", meanwhile: "fixture" },
    f.home, { session: "fixture-asker", sessionId: null, main: "fixture-main", mainSessionId: null, agent: "codex" }).question;
}
async function phone(f: ReturnType<typeof fixture>, a: MobileActivation, q: ReturnType<typeof question>) {
  const prepared = (a as unknown as { prepared: PreparedMobileDesktopHost }).prepared, admin = prepared.desktopAdmin;
  let saved: StoredDevice | null = null;
  const wire: WireFetch = async (url, init) => { const u = new URL(url), result = await prepared.gateway.handle({ method: init.method, path: u.pathname, authority: u.host, tls: true, remoteAddress: "fixture", headers: init.headers, body: init.body }); return { status: result.status, ok: result.status < 300, redirected: false, url, text: async () => JSON.stringify(result.body ?? null) }; };
  const client = new MobileClient(wire, { load: async () => saved, save: async value => { saved = value; }, clear: async () => { saved = null; } }, randomUUID);
  const meta = await admin.handle("GET", "/api/mobile/phones", {}), headers = { origin: admin.localOrigin, "content-type": "application/json", "x-mobile-admin-csrf": (meta.body as { csrfToken: string }).csrfToken, "idempotency-key": randomUUID() };
  const invite = await admin.handle("POST", "/api/mobile/invitations", headers, "{}"), claim = await client.beginPairing((invite.body as { qr: PairingQr }).qr, "Synthetic phone", "android");
  await admin.handle("POST", "/api/mobile/claims/" + claim.claimId, { ...headers, "idempotency-key": randomUUID() }, JSON.stringify({ comparisonCode: claim.comparisonCode, allow: true,
    grants: [{ pcId: f.config.pcId, projectIds: [projectQuestion(q, f.config.pcId).projectId], sessionIds: [], jobIds: [], capabilities: ["overview.read", "questions.read", "questions.answer"] }] }));
  await client.pollPairing(); return { client, prepared, credentials: () => saved!.credentials };
}
describe("explicit owner activation", () => {
  it("does nothing when unconfigured, even with injected material/listener factories", async () => {
    const f = fixture(); expect(service(f.broker)).toBeNull();
    expect(await configuredMobileDashboard(f.node, undefined, f.options, { material: f.material, desktop: f.desktop })).toBeUndefined();
    expect(f.material).not.toHaveBeenCalled(); expect(f.desktop).not.toHaveBeenCalled(); expect(service(f.broker)).toBeNull();
  });
  it("initializes the fresh existing owner service once after material checks and shares it on repeats", async () => {
    const f = fixture(), a = f.activation(); expect(service(f.broker)).toBeNull();
    const results = await Promise.all([a.start(), a.start()]); expect(results[0]).toEqual(results[1]); expect(a.status()).toBe("ready");
    const q = service(f.broker)!, timer = (q as unknown as { timer: unknown }).timer;
    expect(f.node.initializeMobileOwnerQuestions()).toBe(true); expect(service(f.broker)).toBe(q); expect((q as unknown as { timer: unknown }).timer).toBe(timer);
    expect(f.material).toHaveBeenCalledTimes(4); expect(f.ensure).toHaveBeenCalledTimes(1);
    expect(f.servers[0]!.bind).toHaveBeenCalledWith(8443, "192.168.1.2"); expect(f.servers[1]!.bind).toHaveBeenCalledWith(8444, "100.64.1.2");
    expect(f.desktop.mock.calls[0]).toBeDefined(); await a.close(); expect(q.store.list()).toEqual([]);
  });
  it("rejects non-owner before any material read or service initialization", async () => {
    const f = fixture(); Object.assign(f.node, { broker: null }); const a = f.activation(); expect(await a.start()).toBeUndefined();
    expect(a.status()).toBe("source_unavailable"); expect(f.material).not.toHaveBeenCalled(); expect(service(f.broker)).toBeNull(); await f.broker.close();
  });
  it.each(["invalid", "missing", "tls", "public"])("fails closed on %s input before lazy service creation", async mode => {
    const f = fixture(); if (mode === "invalid") Object.assign(f.config, { invalid: true });
    if (mode === "missing") f.config.listeners[0]!.keyFile = join(f.home, "missing");
    if (mode === "tls") f.validateTls.mockImplementation(() => { throw new Error("sensitive cert detail"); });
    if (mode === "public") f.config.listeners[0]!.bindAddress = "8.8.8.8";
    const a = f.activation(); expect(await a.start()).toBeUndefined(); expect(service(f.broker)).toBeNull(); expect(f.desktop).not.toHaveBeenCalled();
    const diagnostics = JSON.stringify(f.options.log.warn.mock.calls); expect(diagnostics).not.toContain(f.home); expect(diagnostics).not.toContain("sensitive");
  });
  it.each(["cert", "key", "push"].flatMap(kind => ["missing", "unreadable", "symlink", "permissions"].map(failure => [kind, failure])))
    ("%s material %s fails activation closed with only a fixed category", async (kind, failure) => {
    const f = fixture(), file = join(f.home, "bad-material");
    f.config.push = { provider: "expo", materialRef: join(f.home, "valid-push"), projectId: "11111111-1111-4111-8111-111111111111", environment: "development" };
    writeFileSync(f.config.push.materialRef, JSON.stringify({ accessToken: "synthetic", encryptionKey: Buffer.alloc(32).toString("base64") }));
    if (failure === "symlink") symlinkSync(f.config.listeners[0]!.certFile, file); else if (failure !== "missing") writeFileSync(file, "synthetic only");
    if (kind === "push") f.config.push.materialRef = file; else f.config.listeners[0]![kind === "key" ? "keyFile" : "certFile"] = file;
    const originalOpen = fs.open.bind(fs);
    if (failure === "unreadable") vi.spyOn(fs, "open").mockImplementation((...args: Parameters<typeof fs.open>) => {
      if (args[0] === file) return Promise.reject(new Error("private material path detail")); return originalOpen(...args);
    });
    const a = f.activation({ material: (path: string) => readPrivateMaterial(path, { platform: "win32", acl: async path => failure !== "permissions" || path !== file }) });
    expect(await a.start()).toBeUndefined(); expect(a.status()).toBe("material_unavailable"); expect(service(f.broker)).toBeNull();
    expect(f.desktop).not.toHaveBeenCalled(); expect(JSON.stringify(f.options.log.warn.mock.calls)).not.toContain(f.home);
  });
  it("resolves private hostname once and binds the exact checked address; mixed/public DNS fails", async () => {
    const f = fixture(); f.config.listeners[0]!.bindAddress = "lan.fixture"; const addresses = vi.fn(async () => ["192.168.1.2"]);
    const a = f.activation({ addresses }); expect(await a.start()).toBeDefined(); expect(addresses).toHaveBeenCalledTimes(1); expect(f.servers[0]!.bind).toHaveBeenCalledWith(8443, "192.168.1.2");
    await a.close(); const g = fixture(); g.config.listeners[0]!.bindAddress = "lan.fixture";
    expect(await g.activation({ addresses: async () => ["192.168.1.2", "8.8.8.8"] }).start()).toBeUndefined(); expect(service(g.broker)).toBeNull();
  });
  it("unwinds partial listener startup and owned dashboard; disables gateway on failure", async () => {
    const f = fixture(); f.servers[1]!.fail = true; const a = f.activation(); expect(await a.start()).toBeUndefined();
    expect(a.status()).toBe("restart_required"); expect(f.servers.every(s => !s.listening)).toBe(true); expect(f.desktopClose).toHaveBeenCalled();
    expect(service(f.broker)!.store.list()).toEqual([]);
  });
  it("failed mobile preparation never closes a recognized foreign desktop; normal fallback may open it", async () => {
    const f = fixture(), reservation = createServer(); await new Promise<void>(r => reservation.listen(0, "127.0.0.1", r));
    const port = (reservation.address() as { port: number }).port; await new Promise<void>(r => reservation.close(() => r())); f.options.port = port;
    const foreign = await hostDashboard({ ...f.options, log: nullLogger }); closers.push(foreign.close);
    const a = f.activation({ desktop: (opts: Parameters<typeof hostDashboard>[0]) => new DashboardController(opts) });
    expect(await a.start()).toBeUndefined(); expect(a.status()).toBe("restart_required"); expect(f.servers.every(s => !s.listening)).toBe(true);
    const fallback = new DashboardController({ ...f.options, mobileStatus: a.status }); closers.push(() => fallback.close());
    expect(await fallback.ensure()).toEqual(foreign.info); expect(fallback.isHosting).toBe(false);
    await a.close(); expect((await fetch(foreign.info.url, { redirect: "manual" })).status).toBe(302);
  });
  it("disposes on broker ownership loss and is idempotent across node and broker close", async () => {
    const f = fixture(), a = f.activation(); await a.start(); const close = vi.spyOn(service(f.broker)!, "close");
    f.node.emit("disconnected"); expect(a.status()).toBe("source_unavailable"); expect(f.desktopClose).not.toHaveBeenCalled(); await a.close(); await f.node.stop();
    expect(f.servers.every(s => !s.listening)).toBe(true); expect(close).toHaveBeenCalledTimes(1); expect(f.desktopClose).toHaveBeenCalledTimes(1);
  });
  it("close while desktop startup is pending disables dispatch and never binds after the late result", async () => {
    const f = fixture(); let resume!: (value: { url: string; port: number; pid: number }) => void;
    f.ensure.mockImplementation(() => new Promise(resolve => { resume = resolve; })); const a = f.activation(), pending = a.start();
    while (!resume) await new Promise<void>(resolve => setImmediate(resolve));
    await a.close(); resume({ url: "late-fixture", port: 4321, pid: 0 }); expect(await pending).toBeUndefined();
    expect(f.servers.every(s => s.bind.mock.calls.length === 0)).toBe(true); expect(f.desktopClose).toHaveBeenCalledTimes(1); expect(a.status()).toBe("source_unavailable");
  });
  it("failed listener close surfaces restart-required but cannot abort core teardown", async () => {
    const f = fixture(), a = f.activation(); await a.start(); f.servers[0]!.closeFail = true; const close = vi.spyOn(service(f.broker)!, "close");
    await f.node.stop(); expect(close).toHaveBeenCalledTimes(1); expect(a.status()).toBe("restart_required"); expect(f.desktopClose).not.toHaveBeenCalled();
    await a.close(); expect(f.desktopClose).toHaveBeenCalledTimes(1);
  });
  it("hang past deadline still closes core service and exposes restart-required", async () => {
    const f = fixture(), a = f.activation(); await a.start(); vi.useFakeTimers();
    let resume!: () => void; vi.spyOn(f.servers[0]!, "close").mockImplementation(callback => { resume = () => callback?.(); });
    const close = vi.spyOn(service(f.broker)!, "close"), stop = f.node.stop();
    await vi.advanceTimersByTimeAsync(5001); await stop; expect(close).toHaveBeenCalledTimes(1); expect(a.status()).toBe("restart_required");
    expect(f.desktopClose).not.toHaveBeenCalled(); resume(); await a.close();
  });
  it("loads synthetic Expo material once in memory and injects configured push", async () => {
    const f = fixture(), materialRef = join(f.home, "push-material"); writeFileSync(materialRef, JSON.stringify({ accessToken: "synthetic-only-token", encryptionKey: Buffer.alloc(32, 7).toString("base64") }));
    f.config.push = { provider: "expo", materialRef, projectId: "11111111-1111-4111-8111-111111111111", environment: "development" };
    const submit = vi.fn(async (_registration: unknown, _hint: PushHint) => ({ state: "submitted" as const, ticketId: "fixture-ticket" })), provider = vi.fn((): PushProvider => ({ submit }));
    const a = f.activation({ provider }); await a.start(); expect(a.status()).toBe("ready"); expect(provider).toHaveBeenCalledWith("synthetic-only-token");
    const secret = JSON.stringify(f.options.log.warn.mock.calls); expect(secret).not.toContain(materialRef); expect(secret).not.toContain("synthetic-only-token");
    const q = question(f), p = await phone(f, a, q); expect(p.prepared.gateway.hello().push).toBe("configured");
    await p.client.registerPush({ expoPushToken: "ExpoPushToken[synthetic-only]", platform: "android", projectId: f.config.push.projectId, environment: "development" });
    await p.prepared.pollQuestionHints(); expect(submit).toHaveBeenCalledTimes(1); const hint = submit.mock.calls[0]![1];
    expect(JSON.stringify(hint)).not.toContain(q.title); expect(await p.client.resolveNotification(hint.data.notificationId)).toBe(q.id);
    await a.start(); expect(provider).toHaveBeenCalledTimes(1); await a.close();
  });
  it("fresh initialized service completes mobile answers into the same-home durable inbox and projects receipts", async () => {
    const f = fixture(), a = f.activation(); await a.start(); const q = question(f), p = await phone(f, a, q), svc = service(f.broker)!;
    expect(p.client.state.snapshot!.questions[0]!.version).toBe(ownerQuestionVersion(q));
    const answered = await p.client.answer(p.client.state.snapshot!.questions[0]!, { text: "Synthetic owner intent" }); expect(answered.status).toBe("answered");
    const messages = f.messages.unread("fixture-asker", 50); expect(messages).toHaveLength(1); f.messages.markRead("fixture-asker", [messages[0]!.id], Date.now());
    expect(svc.list()[0]!.deliveries.find(d => d.recipient === "fixture-asker")!.readAt).not.toBeNull(); await a.close(); expect(service(f.broker)).toBe(svc);
  });
});
