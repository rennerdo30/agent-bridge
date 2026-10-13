import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { OwnerQuestionStore, ownerQuestionVersion } from "../src/core/owner-questions.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { listRunsResponsive, readDashboard, type RunSummary } from "../src/core/dashboard-read.js";
import { LocalMobileSource, projectQuestion } from "../src/mobile/adapter.js";
import { MobileDesktopAdmin } from "../src/mobile/desktop.js";
import { MobileStore } from "../src/mobile/store.js";

vi.mock("../src/core/dashboard-read.js", () => ({ listRunsResponsive: vi.fn(), readDashboard: vi.fn() }));
let questions: OwnerQuestionStore, adapter: LocalMobileSource, peer: PeerInfo, runs: RunSummary[], home: string;
const closers: (() => void)[] = [];
beforeEach(() => {
  const root = resolve(".agent-bridge-test/mobile-adapter"); mkdirSync(root, { recursive: true }); home = mkdtempSync(join(root, "run-"));
  questions = new OwnerQuestionStore(home, nullLogger); closers.push(() => questions.close());
  peer = { id: "peer-1", name: "codex-local", agent: "codex", pid: 111, agentPid: 222, cwd: "D:/Fixture/Project", sessionId: "native-session", startedAt: 1, autoWake: false, activity: "busy" };
  runs = [{ name: "fixture-run", title: "Fixture job", agent: "codex", header: "private header", startedAt: 1, updatedAt: 2, status: "running", task: "private task", prompt: "private prompt", last: "private log", workdir: peer.cwd, percent: 25, progressNote: "Review source", hasLog: true }];
  vi.mocked(listRunsResponsive).mockImplementation(async () => runs);
  vi.mocked(readDashboard).mockResolvedValue({ status: 200, body: { items: [{ id: "item", kind: "assistant", at: 1, text: "Fixture chat", raw: "private raw" }], next: "native-cursor" } });
  adapter = new LocalMobileSource({ home, log: nullLogger, peers: () => [peer] }, questions, "fixture-pc", () => true);
});
afterEach(() => { for (const close of closers.splice(0).reverse()) close(); vi.clearAllMocks(); });
describe("fixed mobile local adapter", () => {
  it("projects only slim summaries and maps job chat to the existing run chat", async () => {
    const view = await adapter.snapshot();
    expect(view.sessions[0]?.activity).toBe("busy"); expect(view.jobs[0]?.progress.percent).toBe(25);
    const json = JSON.stringify(view); for (const secret of ["private prompt", "private task", "private header", "private log", "D:/Fixture", '"pid"', '"worktree"']) expect(json).not.toContain(secret);
    const chat = await adapter.chat(view.jobs[0]!.chatId!, undefined, 20);
    expect(vi.mocked(readDashboard).mock.calls[0]![1]).toEqual({ path: "/api/runs/fixture-run/chat", query: { from: "tail" } });
    expect(chat.items[0]).not.toHaveProperty("raw"); expect(chat.next).toBe("native-cursor");
  });
  it("rejects a renamed/reused native session before reading its transcript", async () => {
    const view = await adapter.snapshot(); peer = { ...peer, id: "replacement", sessionId: "new-session" };
    await expect(adapter.chat(view.sessions[0]!.chatId!, undefined, 20)).rejects.toThrow("snapshot_required"); expect(readDashboard).not.toHaveBeenCalled();
  });
  it("discards job chat if its generation changes during the source read", async () => {
    const view = await adapter.snapshot();
    vi.mocked(readDashboard).mockImplementation(async () => { runs = [{ ...runs[0]!, startedAt: 9 }]; return { status: 200, body: { items: [], next: "0" } }; });
    await expect(adapter.chat(view.jobs[0]!.chatId!, undefined, 20)).rejects.toThrow("snapshot_required");
  });
  it("projects local ask_owner terms, inert links, CAS answer and separate delivery outcome", async () => {
    const q = questions.ask({ topic: "scope", title: "Review terms", context: "Fixture terms", options: [{ id: "yes", label: "Yes", consequence: "Keeps candidate", recommended: true }, { id: "wait", label: "Wait", consequence: "Delays", recommended: false }], links: [{ kind: "file", value: "D:/private/file" }], blocking: true, blocks: "Action", meanwhile: "Read" }, peer.cwd, { session: peer.name, sessionId: peer.sessionId, main: "main", agent: "codex" }).question;
    const view = await adapter.snapshot(); expect(view.questions[0]?.projectId).toBe(view.sessions[0]?.projectId);
    expect(JSON.stringify(view.questions[0])).not.toContain("D:/private");
    const result = await adapter.answer(q.id, { expectedVersion: ownerQuestionVersion(q), option: "yes" }, "device", "11111111-1111-4111-8111-111111111111");
    expect(result.status).toBe("answered"); expect(result.answer?.source).toBe("owner"); expect(result.deliveries).toEqual([]);
    expect(projectQuestion(questions.get(q.id)!, "fixture-pc").answer).not.toHaveProperty("author");
  });
  it("renders a real single-use desktop QR without putting credentials in it", async () => {
    const store = new MobileStore(join(home, "mobile.db"), "fixture-pc", "https://pc.example.test"); closers.push(() => store.close());
    const admin = new MobileDesktopAdmin(store, adapter, "http://127.0.0.1:4321");
    const meta = await admin.handle("GET", "/api/mobile/phones", {}), csrf = (meta.body as { csrfToken: string }).csrfToken;
    const result = await admin.handle("POST", "/api/mobile/invitations", { origin: admin.localOrigin, "x-mobile-admin-csrf": csrf, "idempotency-key": "11111111-1111-4111-8111-111111111111", "content-type": "application/json" }, "{}");
    const body = result.body as { qrSvg: string; qrPayload: string }; expect(body.qrSvg).toContain("<svg"); expect(body.qrSvg).toContain("<path");
    const payload = JSON.parse(body.qrPayload); expect(Object.keys(payload).sort()).toEqual(["expiresAt", "invitationId", "nonce", "origin", "origins", "pcId", "v"]);
    expect(payload.expiresAt - Date.now()).toBeLessThanOrEqual(120_000);
  });
  it("does not redeliver or replace delivery metadata on a durable answer replay", async () => {
    const q = questions.ask({ topic: "replay", title: "Replay fixture", context: "Terms", options: [{ id: "yes", label: "Yes", consequence: "Keep", recommended: true }, { id: "wait", label: "Wait", consequence: "Delay", recommended: false }], blocking: false, blocks: "", meanwhile: "Read" }, peer.cwd, { session: peer.name, sessionId: peer.sessionId, main: "main", agent: "codex" }).question;
    const complete = vi.fn((current: typeof q) => { current.deliveryComplete = true; current.deliveries = [{ recipient: "main", state: "busy", detail: "Queued", readAt: 123 }]; questions.save(current); });
    const withDelivery = new LocalMobileSource({ home, log: nullLogger, peers: () => [peer] }, questions, "fixture-pc", () => true, complete);
    const intent = { expectedVersion: ownerQuestionVersion(q), option: "yes" }, key = "11111111-1111-4111-8111-111111111111";
    await withDelivery.answer(q.id, intent, "device", key); const replay = await withDelivery.answer(q.id, intent, "device", key);
    expect(complete).toHaveBeenCalledTimes(1); expect(replay.deliveries).toEqual([{ recipientLabel: "main", state: "busy", consumedAt: 123 }]);
  });
});
describe("project identity for grant scopes", () => {
  it("names projects for the desktop only and keeps a removed worktree's jobs in its repository project", async () => {
    runs = [{ ...runs[0]!, name: "gone-worktree-run", workdir: join(home, "missing-worktree"), repoRoot: peer.cwd }];
    const view = await adapter.snapshot();
    expect(view.jobs[0]?.projectId).toBe(view.sessions[0]?.projectId);
    expect(adapter.projectFolders().get(view.sessions[0]!.projectId!)).toBe("D:/Fixture/Project");
    expect(JSON.stringify(view)).not.toContain("D:/Fixture");
    const store = new MobileStore(join(home, "mobile.db"), "fixture-pc", "https://pc.example.test"); closers.push(() => store.close());
    const catalog = ((await new MobileDesktopAdmin(store, adapter, "http://127.0.0.1:4321").handle("GET", "/api/mobile/phones", {})).body as { catalog: { projects: { name: string; sessions: number; jobs: number }[] } }).catalog;
    expect(catalog.projects).toEqual([expect.objectContaining({ name: "Project", sessions: 1, jobs: 1 })]);
  });
});
