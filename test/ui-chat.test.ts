import { describe, expect, it, vi } from "vitest";
import { UI_PAGE } from "../src/cli/ui-page.js";

const script = UI_PAGE.split("<script>").pop()!.split("</script>")[0]!;
function page() {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, {
      value: "", innerHTML: "", textContent: "", dataset: {}, checked: true, attrs: {} as Record<string, string>,
      classes: new Set<string>(id === "jobSettings" ? ["hidden"] : []),
      focus() {},
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
  const location = { hash: "" };
  const api = new Function("document", "window", "location", "localStorage", "setInterval", "fetch", `${script}\nreturn { renderJobForm, renderSendForm, modelsCard, renderNetwork, renderSide, chatHtml, setModel: (m) => { model = m; state = { peers: [] }; }, setRoute: (r) => route = r, setNet: (n, i) => { net = n; invite = i || null; } };`)(document, { addEventListener() {} }, location, { setItem() {}, removeItem() {} }, () => 0, fetch);
  return { ...api, element, fetch, location };
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

describe("dashboard network tab", () => {
  const status = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    config: { enabled: true, name: "office-pc", bind: "0.0.0.0", port: 48148, discovery: true },
    identity: { id: "self", name: "office-pc", fingerprint: "f".repeat(64) },
    port: 48148,
    addresses: ["192.168.1.20"],
    discovered: [{ id: "lap", name: "laptop", fingerprint: "a".repeat(64), host: "192.168.1.30", port: 48148, seenAt: Date.now() }],
    paired: [{ id: "mac", name: "<mac>", fingerprint: "b".repeat(64), connected: true, health: { lastVerifiedAt: Date.now(), roundTripMs: 12 } }],
    ...over,
  });

  it("shows a waiting code with the steps for the other PC", () => {
    const p = page();
    p.setNet(status(), { code: "secret-code", expiresAt: Date.now() + 60_000, before: new Set(["mac"]), done: null });
    p.renderNetwork();
    const share = p.element("netShare").innerHTML;
    expect(share).toContain("secret-code");
    expect(share).toContain("192.168.1.20:48148");
    expect(share).toContain("waiting for the other PC");
    expect(p.element("netState").textContent).toBe("Networking is on as office-pc");
  });

  it("lists discovered PCs that are not paired yet, and escapes paired names", () => {
    const p = page();
    p.setNet(status());
    p.renderNetwork();
    expect(p.element("netFound").innerHTML).toContain('data-addr="192.168.1.30:48148"');
    expect(p.element("netPaired").innerHTML).toContain("&lt;mac&gt;");
    expect(p.element("netPaired").innerHTML).toContain("12 ms");
  });

  it("asks before unlinking and never posts on the first click", async () => {
    const p = page();
    p.setNet(status());
    p.renderNetwork();
    const click = p.element("network").listeners.get("click");
    const button = (act: string) => ({ target: { closest: () => ({ dataset: { act, id: "mac" }, disabled: false }) } });
    await click(button("unlink-ask"));
    expect(p.element("netPaired").innerHTML).toContain("Pairing again needs a new code.");
    expect(p.fetch.mock.calls.some(([url]: any[]) => String(url).includes("unlink"))).toBe(false);
    p.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ removed: true }) });
    await click(button("unlink"));
    const request = p.fetch.mock.calls.find(([url]: any[]) => url === "/api/network/unlink");
    expect(JSON.parse(request[1].body)).toEqual({ id: "mac" });
  });

  it("adds the default port to a bare address when connecting", async () => {
    const p = page();
    p.setNet(status());
    p.element("netAddr").value = "192.168.1.30";
    p.element("netCode").value = "the-code";
    p.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ name: "laptop" }) });
    await p.element("netJoin").listeners.get("submit")({ preventDefault() {} });
    const request = p.fetch.mock.calls.find(([url]: any[]) => url === "/api/network/link");
    expect(JSON.parse(request[1].body)).toEqual({ address: "192.168.1.30:48148", code: "the-code" });
    expect(p.element("netCode").value).toBe("");
    expect(p.element("netJoinInfo").textContent).toContain("Paired with laptop");
  });

  it("asks to turn networking on before pairing", () => {
    const p = page();
    p.setNet(status({ enabled: false, config: { enabled: false, name: "office-pc", bind: "127.0.0.1", port: 48148, discovery: false } }));
    p.renderNetwork();
    expect(p.element("netShare").innerHTML).toContain("Turn on networking above first.");
    expect(p.element("netSave").textContent).toBe("Turn on");
    // Suggested for pairing: reachable from other PCs, discovery on.
    expect(p.element("netBind").value).toBe("0.0.0.0");
    expect(p.element("netDiscovery").checked).toBe(true);
  });
});

describe("sessions sidebar", () => {
  const group = (key: string, status: string, title: string, updatedAt = Date.now()) => ({ key, job: key, owner: "", agent: "codex", status, percent: status === "running" ? 40 : null, title, task: "", updatedAt, turns: [] });
  const live = (name: string, cwd: string, groups: any[] = []) => ({ name, live: true, running: groups.filter((g) => g.status === "running").length, groups, children: [], peer: { agent: "claude", activity: "busy", cwd, startedAt: Date.now() } });
  const sessions = [
    live("Dominics-MacBook-Pro.local/claude-Development", "/Users/d/Development"),
    live("claude-strategy-game", "E:/Development/strategy-game", [group("s1", "running", "Fix the path finder"), group("s2", "done", "Old balance pass", Date.now() - 86_400_000)]),
    live("claude-project-mmorpg", "E:/Development/project-mmorpg", [group("m1", "done", "Server login")]),
    { name: "claude-old", live: false, running: 0, groups: [group("o1", "done", "Archived")], children: [], peer: null },
  ];
  const setup = (route: Record<string, unknown> = { session: null }) => {
    const p = page();
    p.setModel({ sessions, byName: new Map(sessions.map((x) => [x.name, x])) });
    p.setRoute(route);
    p.renderSide();
    return p;
  };

  it("lists sessions by PC (this PC first, busiest first) with their recent subagents nested", () => {
    const html = setup().element("sideTree").innerHTML;
    const order = ["This PC", "strategy-game", "Fix the path finder", "project-mmorpg", "Server login", "Dominics-MacBook-Pro.local", "Ended", "claude-old"].map((s) => html.indexOf(s));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A day-old finished subagent hides behind "more" once there are recent ones; ended sessions start folded.
    expect(html).not.toContain("Old balance pass");
    expect(html).not.toContain("Archived");
    expect(html).toContain('href="#/s/claude-strategy-game/s1"');
  });

  it("marks the open subagent and searches subagent titles too", () => {
    const p = setup({ session: "claude-strategy-game", group: "s1" });
    expect(p.element("sideTree").innerHTML).toContain('class="tree-row sel"');
    p.element("sessFilter").value = "balance";
    p.element("sessFilter").listeners.get("input")();
    const html = p.element("sideTree").innerHTML;
    expect(html).toContain("Old balance pass");
    expect(html).not.toContain("project-mmorpg");
  });

  it("folds a session's subagents and remembers it", () => {
    const p = setup();
    p.element("sideTree").listeners.get("click")({ target: { closest: (sel: string) => (sel === "[data-fold]" ? { dataset: { fold: "claude-strategy-game" } } : null) } });
    expect(p.element("sideTree").innerHTML).not.toContain("Fix the path finder");
  });
});

describe("native chats", () => {
  it("renders a transcript as chat with folded tool steps and escaped text", () => {
    const p = page();
    const tools = [1, 2, 3, 4].map((n) => ({ kind: "tool", at: 0, tool: "Read", summary: "file" + n + ".ts" }));
    const html = p.chatHtml([
      { kind: "user", at: 0, text: "Fix <the> build" },
      ...tools,
      { kind: "assistant", at: 0, text: "Done." },
      { kind: "subagent", at: 0, subagent: { id: "a1", title: "Explore", agent: "claude" } },
    ], "claude", "claude-app");
    expect(html).toContain("Fix &lt;the&gt; build");
    expect(html).toContain("4 steps");
    expect(html).toContain("Done.");
    expect(html).toContain('href="#/s/claude-app/~native%3Aa1"');
  });

  it("offers the session's own chat only for local sessions that reported their CLI session", () => {
    const p = page();
    const peer = (sessionId?: string) => ({ agent: "claude", activity: "idle", cwd: "E:/Development/app", startedAt: Date.now(), sessionId });
    const sessions = [
      { name: "claude-app", live: true, running: 0, groups: [], children: [], peer: peer("s-1") },
      { name: "claude-new", live: true, running: 0, groups: [], children: [], peer: peer() },
      { name: "mac.local/claude-app", live: true, running: 0, groups: [], children: [], peer: peer("s-2") },
    ];
    p.setModel({ sessions, byName: new Map(sessions.map((x) => [x.name, x])) });
    p.setRoute({ session: null });
    p.renderSide();
    const html = p.element("sideTree").innerHTML;
    expect(html.match(/tree-row chat/g)?.length).toBe(1);
    expect(html).toContain('href="#/s/claude-app/~chat"');
  });
});
