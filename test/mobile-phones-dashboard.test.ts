import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { mobileDashboardPage, UI_PAGE } from "../src/cli/ui-page.js";

// Execute the existing Phones script with synthetic DOM/event/HTTP seams; no browser or broker.
function fixture() {
  const now = 1_800_000_000_000, claim = { claimId: "fixture-claim", name: "Fixture phone", platform: "ios", comparisonCode: "123456", expiresAt: now + 120_000 };
  const state = { csrfToken: "fixture-csrf", pending: [claim], devices: [], fingerprints: ["AAAA·BBBB·CCCC·DDDD"], gatewayOrigins: ["https://pc.fixture.test:8443"],
    catalog: { pcId: "fixture-pc", projects: [{ id: "opaque-a", name: "Alpha", folder: "E:/Fixture/Alpha", sessions: 1, jobs: 1, questions: 1 }], sessions: [{ id: "opaque-session", name: "Fixture session", agent: "codex", projectId: "opaque-a" }] } };
  const events = new Map<string, (event: any) => Promise<void> | void>(), elements = new Map<string, any>(), writes: { path: string; init: any; body: any }[] = [];
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, { textContent: "", innerHTML: "", classList: { toggle() {}, add() {} }, setAttribute() {}, removeAttribute() {}, addEventListener(type: string, fn: any) { events.set(id + ":" + type, fn); } });
    return elements.get(id);
  };
  let fail = false, time = now;
  const context: any = { location: { hash: "#/", reload() {} }, parseRoute: () => ({ session: null, group: null }), render() {}, renderSide() {}, route: {},
    $: element, esc: (text: unknown) => String(text).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;"), ago: () => "just now", mmss: () => "2:00",
    Date: class extends Date { static override now() { return time; } }, crypto: { randomUUID }, setInterval() {}, window: { addEventListener() {} },
    document: { activeElement: null, querySelectorAll: () => [], querySelector: () => null },
    fetch: async (path: string, init?: any) => {
      if (init?.method && init.method !== "GET") {
        writes.push({ path, init, body: JSON.parse(init.body) });
        if (fail) throw new Error("fixture connection lost");
        return { ok: true, status: 200, json: async () => ({ state: "recorded" }) };
      }
      return { ok: true, json: async () => state };
    } };
  const scripts = [...mobileDashboardPage(true).matchAll(/<script>([\s\S]*?)<\/script>/g)], script = scripts.at(-1)![1]!;
  runInNewContext(script.replace("})();", "globalThis.phonesFixture = { phState, phClaimHtml, phValid, phLoad, phTick };})();"), context);
  const api = context.phonesFixture;
  const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
  const card = { dataset: { claim: claim.claimId }, querySelector: () => null };
  const click = async (act: string) => {
    const button: any = { dataset: { ph: act, id: "fixture-device" }, closest: () => card, disabled: false };
    await events.get("phones:click")!({ target: { closest: () => button } }); await flush();
  };
  return { state, claim, api, writes, click, flush, element, expire: () => { time = claim.expiresAt; }, fail: () => { fail = true; } };
}

describe("finished Phones dashboard wiring", () => {
  it("preserves the unprovisioned dashboard and uses the existing sidebar and unavailable shell", () => {
    expect(mobileDashboardPage(false)).toBe(UI_PAGE);
    expect(mobileDashboardPage(true)).toContain('href="#/phones" id="tabPhones"');
    expect(mobileDashboardPage(false, "preparing")).toContain("Phone access is starting");
  });
  it("defaults to whole-PC read-only and sends opaque project/session IDs with explicit answer opt-in", async () => {
    for (const mode of ["all", "project", "sessions"]) {
      const f = fixture(); await f.flush(); const selection = f.api.phState(f.claim.claimId);
      expect(selection.mode).toBe("all"); expect(selection.answers).toBe(false);
      const initial = f.api.phClaimHtml(f.claim);
      expect(initial).toContain('value="all" data-ph="mode" checked'); expect(initial).toContain("123 456");
      selection.mode = mode; selection.projects.add("opaque-a"); selection.sessions.add("opaque-session"); selection.answers = mode !== "all";
      if (mode === "sessions") expect(f.api.phClaimHtml(f.claim)).toContain('data-ph="answers" disabled');
      await f.click("confirm"); expect(f.writes).toHaveLength(1);
      const write = f.writes[0]!, grant = write.body.grants[0];
      expect(write.init.credentials).toBe("same-origin"); expect(write.init.redirect).toBe("error"); expect(write.init.headers["x-mobile-admin-csrf"]).toBe("fixture-csrf");
      expect(write.body.comparisonCode).toBe("123456"); expect(write.body.allow).toBe(true);
      expect(grant).toEqual({ pcId: "fixture-pc", ...(mode !== "sessions" ? { scope: mode } : {}), projectIds: mode === "project" ? ["opaque-a"] : [], sessionIds: mode === "sessions" ? ["opaque-session"] : [], jobIds: [],
        capabilities: ["overview.read", "chat.read", "questions.read", ...(mode === "project" ? ["questions.answer"] : [])] });
      expect(JSON.stringify(write.body)).not.toContain("E:/Fixture");
    }
  });
  it("prunes disappeared server IDs and refuses expired or already-busy claims", async () => {
    const f = fixture(); await f.flush(); const selection = f.api.phState(f.claim.claimId);
    selection.mode = "project"; selection.projects.add("opaque-a"); selection.sessions.add("opaque-session");
    f.state.catalog.projects = []; f.state.catalog.sessions = []; await f.api.phLoad();
    expect(selection.projects.size).toBe(0); expect(selection.sessions.size).toBe(0); expect(f.api.phValid(selection, f.claim)).toBe(false);
    expect(selection.note.text).toContain("no longer available"); await f.click("confirm"); expect(f.writes).toHaveLength(0);
    selection.mode = "all"; selection.busy = true; await f.click("deny"); expect(f.writes).toHaveLength(0);
    selection.busy = false; f.expire(); expect(f.api.phValid(selection, f.claim)).toBe(false);
    expect(f.api.phClaimHtml(f.claim)).toContain('data-ph="confirm" disabled'); await f.click("confirm"); await f.click("deny"); expect(f.writes).toHaveLength(0);
  });
  it("denies without grants and never describes an ambiguous revoke as a known failure", async () => {
    const f = fixture(); await f.flush(); await f.click("deny"); expect(f.writes[0]!.body.grants).toEqual([]);
    f.fail(); await f.click("revoke"); expect(f.element("phNotice").textContent).toContain("The result is unknown"); expect(f.element("phNotice").textContent).not.toContain("Not revoked");
  });
});
