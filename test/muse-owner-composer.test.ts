import { describe, expect, it, vi } from "vitest";
import { UI_PAGE } from "../src/cli/ui-page.js";

const script = UI_PAGE.split("<script>").pop()!.split("</script>")[0]!;
function page() {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, { value: "", innerHTML: "", textContent: "", dataset: {}, checked: true, attrs: {}, classes: new Set(),
      focus() {}, querySelectorAll: () => [], querySelector: () => null,
      get classList() { const classes = this.classes; return { toggle: (name: string, on?: boolean) => ((on ?? !classes.has(name)) ? classes.add(name) : classes.delete(name)), add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name), contains: (name: string) => classes.has(name) }; },
      setAttribute(name: string, value: string) { this.attrs[name] = value; }, parentElement: { addEventListener() {} },
      addEventListener() {}, after() {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0 });
    return elements.get(id);
  };
  const fetch = vi.fn(() => new Promise(() => {}));
  const document = { getElementById: element, documentElement: { dataset: {} }, addEventListener() {}, querySelectorAll: () => [] };
  const api = new Function("document", "window", "location", "localStorage", "setInterval", "fetch", `${script}\nreturn {renderChatForm,sendChat,setModel:(sessions)=>{model={byName:new Map(sessions.map(session=>[session.name,session]))}},setRoute:(value)=>route=value};`)
    (document, { addEventListener() {} }, { hash: "" }, { setItem() {}, removeItem() {} }, () => 0, fetch);
  return { ...api, element, fetch };
}
const muse = (name = "muse-owner", live = true) => ({ name, live, groups: [], peer: { agent: "muse", sessionId: "native-root" } });

describe("Muse owner chat composer", () => {
  it("offers root owner input through Bridge and describes queued idle delivery honestly", async () => {
    const p = page(), session = muse(); p.setModel([session]); p.setRoute({ session: session.name, group: "~chat" });
    p.renderChatForm(session, "~chat");
    expect(p.element("chatBody").disabled).toBe(false); expect(p.element("chatSendBtn").disabled).toBe(false);
    expect(p.element("chatSendNote").textContent).toContain("through the bridge");
    expect(p.element("chatSendNote").textContent).toContain("next turn or inbox read");
    expect(p.element("chatSendNote").textContent).not.toContain("native user prompt");
    p.element("chatBody").value = "owner text";
    p.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ state: "queued", text: "Awaiting hook consumption." }) });
    await p.sendChat();
    const call = p.fetch.mock.calls.find(([url]: any) => url === "/api/sessions/muse-owner/message")!;
    expect(JSON.parse(call[1].body)).toEqual({ body: "owner text" });
    expect(call[1].headers).toMatchObject({ "x-agent-bridge": "1", "content-type": "application/json" });
    expect(p.element("chatSendInfo").textContent).toBe("Awaiting hook consumption.");
  });
  it.each(["~native:child", "~jc:muse-job-example|child"])("offers only the explicit parent note for %s", async key => {
    const p = page(), session = muse(); p.setModel([session]); p.setRoute({ session: session.name, group: key }); p.renderChatForm(session, key);
    expect(p.element("chatBody").disabled).toBe(false);
    expect(p.element("chatSendBtn").classes.has("hidden")).toBe(true); expect(p.element("chatSendBtn").disabled).toBe(true);
    expect(p.element("chatParentBtn").classes.has("hidden")).toBe(false); expect(p.element("chatParentBtn").disabled).toBe(false);
    expect(p.element("chatSendNote").textContent).toContain("Send to its parent with a note");
    p.element("chatBody").value = "child review";
    p.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ state: "queued", text: "Parent queued." }) });
    await p.sendChat(true);
    const path = key.startsWith("~jc:") ? "/api/jobs/muse-job-example/message" : "/api/sessions/muse-owner/message";
    const call = p.fetch.mock.calls.find(([url]: any) => url === path)!;
    expect(JSON.parse(call[1].body)).toEqual({ body: "child review", child: "child", target: "parent" });
  });
  it.each([muse("pc/muse-owner"), muse("offline-muse", false)])("keeps remote/offline Muse chats unavailable", session => {
    const p = page(); p.renderChatForm(session, "~chat");
    expect(p.element("chatBody").disabled).toBe(true); expect(p.element("chatSendBtn").disabled).toBe(true);
    expect(p.element("chatParentBtn").classes.has("hidden")).toBe(true);
  });
});
