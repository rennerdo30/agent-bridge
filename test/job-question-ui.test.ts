import { describe, expect, it, vi } from "vitest";
import { UI_PAGE } from "../src/cli/ui-page.js";

// AB-249: open questions from delegated jobs show in "Waiting for you" and on the session page.
const script = UI_PAGE.split("<script>").pop()!.split("</script>")[0]!;
const jq = { id: "7d0c5a52-8f4e-4a43-9a43-1f7a0b2c3d4e", kind: "job-question", job: "codex-job-aa11", agent: "codex", owner: "claude-parent",
  recipient: "claude-main", rerouted: true, body: "May I delete <the stale branch>?", createdAt: Date.now() - 120_000, readAt: null };
const owned = { ...jq, id: "8d0c5a52-8f4e-4a43-9a43-1f7a0b2c3d4e", job: "codex-job-bb22", owner: "other-session", recipient: "other-session", rerouted: false };
function page(hash = "") {
  const elements = new Map<string, any>();
  const el = (id: string): any => {
    if (!elements.has(id)) elements.set(id, { dataset: {}, value: "", checked: false, innerHTML: "", textContent: "", focus: vi.fn(), scrollIntoView: vi.fn(), querySelectorAll: () => [], querySelector: () => null,
      classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn(), contains: () => false }, setAttribute: vi.fn(), parentElement: { addEventListener: vi.fn() }, addEventListener: vi.fn() });
    return elements.get(id);
  };
  const document = { hidden: false, title: "", documentElement: { dataset: {} }, getElementById: el, addEventListener: vi.fn(), querySelectorAll: () => [] };
  const fetch = vi.fn((..._args: unknown[]) => new Promise(() => {}));
  const group = { key: "codex-job-aa11", job: "codex-job-aa11", title: "Release prep", owner: "claude-parent", turns: [{ name: "2026-10-09-10-00-00-codex-job-aa11" }] };
  const api = new Function("document", "window", "location", "localStorage", "setInterval", "fetch", "Notification", script +
    "\nreturn { jobQuestionCard, approvalCard, answerJobQuestion, renderSessionQuestions, approvalKind, setQuestions: qs => { approvals = qs; }, setDraft: (k, v) => apDrafts.set(k, v)," +
    " setModel: g => model = { groups: new Map(g ? [[g.key, g]] : []), sessions: [], byName: new Map() }, setRoute: r => route = r };")
    (document, { addEventListener: vi.fn() }, { hash }, { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }, () => 0, fetch, Object.assign(vi.fn(), { permission: "default" }));
  return { ...api, fetch, el, group };
}

describe("open job questions in the dashboard (AB-249)", () => {
  it("renders an escaped card that says the question was rerouted and offers an answer box", () => {
    const p = page(); p.setModel(p.group);
    const html = p.approvalCard(jq);
    expect(html).toContain("SUBAGENT QUESTION");
    expect(html).toContain("May I delete &lt;the stale branch&gt;?");
    expect(html).toContain("claude-parent was not connected.");
    expect(html).toContain("Routed to claude-main, the project main.");
    expect(html).toContain('data-jq-send="' + jq.id + '"');
    expect(html).toContain("Release prep");
    expect(html).not.toContain("data-ap-act");
    expect(p.approvalKind(jq)).toBe("question");
  });

  it("without its run listed, points to message_subagent instead of an answer box", () => {
    const p = page(); p.setModel(null);
    const html = p.jobQuestionCard({ ...jq, rerouted: false });
    expect(html).toContain("Asked claude-main");
    expect(html).not.toContain("data-jq-send");
    expect(html).toContain("message_subagent");
  });

  it("sends the answer to the job's latest run like message_subagent", async () => {
    const p = page(); p.setModel(p.group); p.setQuestions([jq]); p.setDraft("jq:" + jq.id, "Yes, delete it.");
    p.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ text: "sent" }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ approvals: [], questions: [] }) });
    await p.answerJobQuestion(jq.id);
    const call = p.fetch.mock.calls.find((c: any) => c[0] === "/api/subagents/message") as any;
    expect(JSON.parse(call[1].body)).toEqual({ run: p.group.turns[0]!.name, body: "Yes, delete it." });
  });

  it("lists on a session page only the questions of its jobs or routed to it", () => {
    const p = page(); p.setModel(p.group); p.setQuestions([jq, owned]);
    p.setRoute({ session: "claude-parent", group: null });
    p.renderSessionQuestions();
    expect(p.el("sQs").innerHTML).toContain(jq.id);
    expect(p.el("sQs").innerHTML).not.toContain(owned.id);
    expect(p.el("sQBox").classList.toggle).toHaveBeenLastCalledWith("hidden", false);
    p.setRoute({ session: "claude-main", group: null }); p.renderSessionQuestions();
    expect(p.el("sQs").innerHTML).toContain(jq.id);
    p.setRoute({ session: "someone-else", group: null }); p.renderSessionQuestions();
    expect(p.el("sQBox").classList.toggle).toHaveBeenLastCalledWith("hidden", true);
  });
});
