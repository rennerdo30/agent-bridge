import { describe, expect, it, vi, beforeEach } from "vitest";
import { codexQueue, deliverDashboardChat } from "../src/core/dashboard-chat.js";
import { DelegateError, runProcess } from "../src/core/delegate.js";
import { nullLogger } from "../src/core/logger.js";
import type { PeerInfo, SendResult } from "../src/core/protocol.js";

vi.mock("../src/core/delegate.js", async (original) => ({ ...await original(), runProcess: vi.fn() }));
const peer = (agent = "codex", activity = "idle") => ({ name: "session", agent, sessionId: "thread", cwd: "/project", activity, wakeAvailable: true, wakeOnDirect: true, autoWake: false }) as PeerInfo;
const sent = (p: PeerInfo): SendResult => ({ messages: [{ id: "message-id", recipient: p.name } as any], deliveredTo: [p.name], queuedFor: [], recipientStates: [p] });
beforeEach(() => vi.mocked(runProcess).mockReset());

describe("owner CLI transport", () => {
  it("queues literal owner text with exact argv and no resume, shell or policy overrides", async () => {
    vi.mocked(runProcess).mockResolvedValue({ code: 0 } as any);
    const text = 'owner "quoted" $(literal) & <tag>\nnext line';
    expect(await codexQueue("codex", nullLogger)("child-uuid", text, "/project")).toBe("accepted");
    expect(runProcess).toHaveBeenCalledWith(expect.objectContaining({ bin: "codex", args: ["queue", "--thread", "child-uuid", "--message", text], cwd: "/project", stdin: "", timeoutMs: 10_000 }));
  });
  it("distinguishes unavailable from ambiguous launch/timeout failures", async () => {
    const queue = codexQueue("codex", nullLogger);
    vi.mocked(runProcess).mockResolvedValueOnce({ code: 1 } as any);
    expect(await queue("t", "body", "/p")).toBe("unsupported");
    vi.mocked(runProcess).mockRejectedValueOnce(new DelegateError("missing", "not_found"));
    expect(await queue("t", "body", "/p")).toBe("unsupported");
    vi.mocked(runProcess).mockRejectedValueOnce(new DelegateError("timeout", "timeout"));
    expect(await queue("t", "body", "/p")).toBe("unconfirmed");
  });
  it("uses native queue for main and accessible native children without a duplicate bridge send", async () => {
    const queue = vi.fn(async () => "accepted" as const), send = vi.fn();
    const p = peer("codex", "busy");
    expect(await deliverDashboardChat(p, "work", { queue, send })).toMatchObject({ state: "queued", transport: "native-prompt" });
    expect(await deliverDashboardChat(p, "child work", { queue, send, child: { id: "child", title: "helper" } })).toMatchObject({ state: "queued", transport: "native-prompt" });
    expect(queue.mock.calls.map((c: any) => c[0])).toEqual(["thread", "child"]);
    expect(send).not.toHaveBeenCalled();
  });
  it("does not fall back on ambiguous acceptance", async () => {
    const send = vi.fn();
    expect(await deliverDashboardChat(peer(), "work", { queue: async () => "unconfirmed", send })).toMatchObject({ state: "unconfirmed" });
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["claude", "opencode", "antigravity", "codex"])("uses labeled %s bridge fallback with honest consumption state", async (agent) => {
    const p = peer(agent, "busy"), send = vi.fn(async () => sent(p));
    const result = await deliverDashboardChat(p, "work", { queue: async () => "unsupported", send });
    expect(send).toHaveBeenCalledWith("Owner message from the local dashboard:\n\nwork");
    expect(result).toMatchObject({ state: "queued", transport: "bridge", receipt: "message-id" });
    expect(result.text).toContain("current turn is not interrupted");
  });
  it("explains idle Antigravity without falsely promising a wake", async () => {
    const p = { ...peer("antigravity"), wakeAvailable: false };
    const result = await deliverDashboardChat(p, "work", { queue: vi.fn(), send: async () => sent(p) });
    expect(result.text).toContain("next turn or inbox read");
    expect(result.text).not.toContain("Wake requested");
  });
  it("offers parent delivery for unsupported children and bypasses native queue for parent notes", async () => {
    const p = peer("claude"), send = vi.fn(async (_body: string) => sent(p)), queue = vi.fn(async () => "accepted" as const);
    const child = { id: "child", title: "helper" };
    expect(await deliverDashboardChat(p, "work", { queue, send, child })).toMatchObject({ state: "not-supported", transport: "parent" });
    expect(send).not.toHaveBeenCalled();
    expect(await deliverDashboardChat(peer(), "work", { queue, send, child, parent: true })).toMatchObject({ transport: "parent" });
    expect(queue).not.toHaveBeenCalled();
    expect(send.mock.calls[0]![0]).toContain("native subagent child (helper)");
  });
});
