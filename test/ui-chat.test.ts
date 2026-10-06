import { describe, expect, it, vi } from "vitest";
import { UI_PAGE } from "../src/cli/ui-page.js";

const script = UI_PAGE.split("<script>").pop()!.split("</script>")[0]!;
function page() {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, {
      value: "", innerHTML: "", textContent: "", dataset: {}, checked: true, attrs: {} as Record<string, string>,
      classes: new Set<string>(id === "jobSettings" ? ["hidden"] : []),
      get classList() {
        const c = this.classes as Set<string>;
        return { toggle: (n: string, on?: boolean) => ((on ?? !c.has(n)) ? c.add(n) : c.delete(n)), add: (n: string) => c.add(n), remove: (n: string) => c.delete(n), contains: (n: string) => c.has(n) };
      },
      setAttribute(name: string, value: string) { this.attrs[name] = value; },
      parentElement: { addEventListener() {} },
      listeners: new Map(), addEventListener(event: string, fn: unknown) { this.listeners.set(event, fn); },
      after() {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    });
    return elements.get(id);
  };
  const fetch = vi.fn(() => new Promise(() => {}));
  const document = { getElementById: element, documentElement: { dataset: {} }, addEventListener() {}, querySelectorAll: () => [] };
  const api = new Function("document", "window", "location", "localStorage", "setInterval", "fetch", `${script}\nreturn { renderJobForm, renderSendForm, modelsCard, setModel: (m) => { model = m; state = { peers: [] }; }, setRoute: (r) => route = r };`)(document, { addEventListener() {} }, { hash: "" }, { setItem() {}, removeItem() {} }, () => 0, fetch);
  return { ...api, element, fetch };
}
const group = (key: string) => ({ key, job: `codex-job-${key}`, owner: "claude-app", agent: "codex", status: "done", percent: null, turns: [{ name: `run-${key}`, startedAt: 0 }] });

describe("dashboard chat inputs", () => {
  it("keeps each subagent's draft while selecting another chat", () => {
    const p = page(), first = group("first"), second = group("second");
    p.renderJobForm(first);
    p.element("jobBody").value = "for the first";
    p.renderJobForm(second);
    expect(p.element("jobBody").value).toBe("");
    p.element("jobBody").value = "for the second";
    p.renderJobForm(first);
    expect(p.element("jobBody").value).toBe("for the first");
    p.renderJobForm(second);
    expect(p.element("jobBody").value).toBe("for the second");
  });

  it("sends to the selected job and shows the outcome in its chat", async () => {
    const p = page(), g = group("first");
    p.setModel({ groups: new Map([[g.key, g]]) });
    p.renderJobForm(g);
    p.element("jobBody").value = "continue with tests";
    p.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ text: "Continued this subagent." }) });
    await p.element("jobSend").listeners.get("submit")({ preventDefault() {} });
    const request = p.fetch.mock.calls.find(([url]: any[]) => url === "/api/subagents/message");
    expect(JSON.parse(request[1].body)).toEqual({ run: "run-first", body: "continue with tests" });
    expect(request[1].headers["x-agent-bridge"]).toBe("1");
    expect(p.element("chat").innerHTML).toContain("Continued this subagent.");
    expect(p.element("jobBody").value).toBe("");
    expect(p.element("jobSendBtn").disabled).toBe(false);
  });

  it("keeps the draft and shows an escaped delivery error", async () => {
    const p = page(), g = group("first");
    p.setModel({ groups: new Map([[g.key, g]]) });
    p.renderJobForm(g);
    p.element("jobBody").value = "keep this";
    p.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "<unavailable>" }) });
    await p.element("jobSend").listeners.get("submit")({ preventDefault() {} });
    expect(p.element("jobBody").value).toBe("keep this");
    expect(p.element("chat").innerHTML).toContain("Message error: &lt;unavailable&gt;");
  });

  it("sends only the chosen next-turn settings, as the job's agent names them", async () => {
    const p = page(), g = { ...group("first"), agent: "opencode", effort: "medium" };
    p.setModel({ groups: new Map([[g.key, g]]) });
    p.renderJobForm(g);
    expect(p.element("setToggle").classes.has("hidden")).toBe(false);
    expect(p.element("setEffort").innerHTML).toContain("keep: medium");
    p.element("setToggle").listeners.get("click")();
    expect(p.element("jobSettings").classes.has("hidden")).toBe(false);
    expect(p.element("setToggle").attrs["aria-expanded"]).toBe("true");
    p.element("setEffort").value = "high";
    p.element("setPerm").value = "false";
    p.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ text: "Saved settings." }) });
    await p.element("jobSettings").listeners.get("submit")({ preventDefault() {} });
    const request = p.fetch.mock.calls.find(([url]: any[]) => url === "/api/subagents/settings");
    expect(JSON.parse(request[1].body)).toEqual({ run: "run-first", settings: { effort: "high", auto_approve: false } });
    expect(request[1].headers["x-agent-bridge"]).toBe("1");
    expect(p.element("setInfo").textContent).toBe("Saved settings.");
    expect(p.element("chat").innerHTML).toContain("Saved settings.");
  });

  it("hides the settings for runs without a job", () => {
    const p = page();
    p.renderJobForm({ ...group("first"), job: null });
    expect(p.element("setToggle").classes.has("hidden")).toBe(true);
  });

  it("addresses the session being viewed, including an ended session", () => {
    const p = page();
    p.setModel({ sessions: [{ name: "another-session", live: true }] });
    p.setRoute({ session: "ended-session" });
    p.element("to").value = "another-session";
    p.renderSendForm(true);
    expect(p.element("to").value).toBe("ended-session");
    expect(p.element("to").disabled).toBe(true);
    p.renderSendForm(false);
    expect(p.element("to").disabled).toBe(false);
  });

  it("renders the model default, list and efforts with escaped markup", () => {
    const p = page();
    const html = p.modelsCard({ agent: "codex", defaultModel: "<model>", lines: ["- test-model: Efforts: low, high", "<script>"] });
    expect(html).toContain("Default: &lt;model&gt;");
    expect(html).toContain("Efforts: low, high");
    expect(html).not.toContain("<script>");
  });
});
