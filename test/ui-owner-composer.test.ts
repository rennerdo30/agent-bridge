import { describe, expect, it, vi } from "vitest";
import { UI_PAGE } from "../src/cli/ui-page.js";

const script = UI_PAGE.split("<script>").pop()!.split("</script>")[0]!;
function page() {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, {
      value: "", innerHTML: "", textContent: "", dataset: {}, checked: true, attrs: {}, classes: new Set(),
      focus() {}, querySelectorAll: () => [], querySelector: () => null,
      get classList() { const c = this.classes; return { toggle: (n: string, on?: boolean) => ((on ?? !c.has(n)) ? c.add(n) : c.delete(n)), add: (n: string) => c.add(n), remove: (n: string) => c.delete(n), contains: (n: string) => c.has(n) }; },
      setAttribute(name: string, value: string) { this.attrs[name] = value; }, parentElement: { addEventListener() {} },
      listeners: new Map(), addEventListener(event: string, fn: unknown) { this.listeners.set(event, fn); },
      after() {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    });
    return elements.get(id);
  };
  const fetch = vi.fn(() => new Promise(() => {}));
  const document = { getElementById: element, documentElement: { dataset: {} }, addEventListener() {}, querySelectorAll: () => [] };
  const api = new Function("document", "window", "location", "localStorage", "setInterval", "fetch", `${script}\nreturn { renderChatForm, sendChat, showNative, setModel: (x) => { model = { byName: new Map(x.map(s => [s.name, s])) }; }, setRoute: (r) => route = r };`)
    (document, { addEventListener() {} }, { hash: "" }, { setItem() {}, removeItem() {} }, () => 0, fetch);
  return { ...api, element, fetch };
}
const session = (name: string, agent = "codex") => ({ name, live: true, groups: [], peer: { agent, sessionId: "thread" } });

describe("owner chat composer", () => {
  it("renders the initial main transcript without requiring an explicit Chat route", async () => {
    const p = page(), x = session("session"); p.setModel([x]); p.setRoute({ session: x.name, group: null });
    p.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ kind: "user", at: Date.now(), text: "initial transcript" }], next: null }) });
    await p.showNative(x, "~chat");
    expect(p.element("chat").innerHTML).toContain("initial transcript");
    expect(p.element("cMeta").innerHTML).toContain("owner input");
  });
  it("preserves each own/native chat draft without resetting the current input on polls", () => {
    const p = page(), x = session("session");
    p.renderChatForm(x, "~chat"); p.element("chatBody").value = "main draft";
    p.renderChatForm(x, "~chat"); expect(p.element("chatBody").value).toBe("main draft");
    p.renderChatForm(x, "~native:child"); expect(p.element("chatBody").value).toBe("");
    p.element("chatBody").value = "child draft";
    p.renderChatForm(x, "~chat"); expect(p.element("chatBody").value).toBe("main draft");
    p.renderChatForm(x, "~native:child"); expect(p.element("chatBody").value).toBe("child draft");
  });
  it("sends from the default Chat row as an authenticated owner request", async () => {
    const p = page(), x = session("session"); p.setModel([x]); p.setRoute({ session: x.name, group: null });
    p.renderChatForm(x, "~chat"); p.element("chatBody").value = "owner text";
    p.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ state: "queued", text: "Queued until idle." }) });
    await p.sendChat();
    const call = p.fetch.mock.calls.find(([url]: any) => url === "/api/sessions/session/message")!;
    expect(JSON.parse(call[1].body)).toEqual({ body: "owner text" });
    expect(call[1].headers).toMatchObject({ "x-agent-bridge": "1", "content-type": "application/json" });
    expect(p.element("chatSendInfo").textContent).toBe("Queued until idle.");
    expect(p.element("chatBody").value).toBe("");
  });
  it("explains unsupported native input and sends an explicit parent note", async () => {
    const p = page(), x = session("session", "claude"); p.setModel([x]); p.setRoute({ session: x.name, group: "~native:child" });
    p.renderChatForm(x, "~native:child");
    expect(p.element("chatSendNote").textContent).toContain("Not supported: direct input");
    expect(p.element("chatSendBtn").classes.has("hidden")).toBe(true);
    expect(p.element("chatParentBtn").classes.has("hidden")).toBe(false);
    p.element("chatBody").value = "for helper";
    p.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ state: "queued", text: "Parent queued." }) });
    await p.sendChat(true);
    const call = p.fetch.mock.calls.find(([url]: any) => url === "/api/sessions/session/message")!;
    expect(JSON.parse(call[1].body)).toEqual({ body: "for helper", child: "child", target: "parent" });
  });
  it("keeps paired-PC chats view-only and preserves text after rejection", async () => {
    const p = page(), remote = session("pc/session"); p.setModel([remote]); p.setRoute({ session: remote.name, group: "~chat" });
    p.renderChatForm(remote, "~chat");
    expect(p.element("chatBody").disabled).toBe(true);
    expect(p.element("chatSendNote").textContent).toContain("paired-PC chats are view-only");
    p.element("chatBody").value = "draft"; await p.sendChat();
    expect(p.fetch.mock.calls.some(([url]: any) => url.endsWith("/message"))).toBe(false);
    const local = session("session"); p.setModel([local]); p.setRoute({ session: local.name, group: "~chat" });
    p.renderChatForm(local, "~chat"); p.element("chatBody").value = "keep me";
    p.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "<offline>" }) });
    await p.sendChat();
    expect(p.element("chatBody").value).toBe("keep me");
    expect(p.element("chatSendInfo").textContent).toBe("<offline>");
  });
  it("a late response cannot clear the newly selected chat's draft", async () => {
    const p = page(), first = session("first"), next = session("next"); p.setModel([first, next]);
    p.setRoute({ session: first.name, group: "~chat" }); p.renderChatForm(first, "~chat"); p.element("chatBody").value = "first";
    let resolve!: (v: any) => void;
    p.fetch.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const sending = p.sendChat();
    p.setRoute({ session: next.name, group: "~chat" }); p.renderChatForm(next, "~chat"); p.element("chatBody").value = "next draft";
    resolve({ ok: true, json: async () => ({ state: "queued", text: "accepted first" }) }); await sending;
    expect(p.element("chatBody").value).toBe("next draft");
    expect(p.element("chatSendInfo").textContent).toBe("");
  });
});
