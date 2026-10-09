import { describe, expect, it, vi } from "vitest";
import { UI_PAGE } from "../src/cli/ui-page.js";
import { markRemoteDashboard } from "../src/network/dashboard-projection.js";

const script = UI_PAGE.split("<script>").pop()!.split("</script>")[0]!;
function page() {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, {
      value: "", innerHTML: "", textContent: "", dataset: {}, checked: true, attrs: {} as Record<string, string>,
      classes: new Set<string>(),
      focus() {}, querySelectorAll: () => [], querySelector: () => null,
      get classList() {
        const c = this.classes as Set<string>;
        return { toggle: (n: string, on?: boolean) => ((on ?? !c.has(n)) ? c.add(n) : c.delete(n)), add: (n: string) => c.add(n), remove: (n: string) => c.delete(n), contains: (n: string) => c.has(n) };
      },
      setAttribute(name: string, value: string) { this.attrs[name] = value; },
      parentElement: { addEventListener() {} },
      addEventListener() {}, after() {}, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    });
    return elements.get(id);
  };
  const fetch = vi.fn(() => new Promise(() => {}));
  const document = { getElementById: element, documentElement: { dataset: {} }, addEventListener() {}, querySelectorAll: () => [] };
  return new Function("document", "window", "location", "localStorage", "setInterval", "fetch",
    `${script}\nreturn { pill, esc, renderPaired, setNet: (n) => { net = n; } };`)(
    document, { addEventListener() {} }, { hash: "" }, { setItem() {}, removeItem() {} }, () => 0, fetch) as {
    pill: (status: unknown, percent?: unknown) => string; esc: (s: unknown) => string;
    renderPaired: () => void; setNet: (n: unknown) => void;
  } & { element?: never };
}

const PAYLOAD = "<img src=x onerror=alert(1)>";

describe("dashboard rendering of data from a paired PC (AB-231)", () => {
  it("never writes a run status as raw HTML or as an unquoted class name", () => {
    const p = page();
    const html = p.pill(PAYLOAD);
    expect(html).not.toContain("<img");
    expect(p.pill('x" onmouseover="alert(1)')).not.toMatch(/class="pill [^"]*" onmouseover/);
    expect(p.pill("done")).toBe('<span class="pill done">done</span>');
    expect(p.pill("running", 40)).toContain("working · 40%");
    expect(p.pill("running", "<b>")).not.toContain("<b>");
  });

  it("escapes single quotes too", () => {
    expect(page().esc(`'"<>&`)).toBe("&#39;&quot;&lt;&gt;&amp;");
  });

  it("drops script-bearing statuses and non-numeric progress from remote runs on the server", () => {
    const out = markRemoteDashboard({ runs: [{ name: "r1", status: PAYLOAD, percent: "<b>", etaAt: "x", updatedAt: 5, startedAt: "y" }, { name: "r2", status: "done", percent: 50 }] }, "pc2") as { runs: Record<string, unknown>[] };
    expect(out.runs[0]).toMatchObject({ name: "pc2/r1", status: "interrupted", updatedAt: 5 });
    expect(out.runs[0]!.percent).toBeUndefined();
    expect(out.runs[0]!.etaAt).toBeUndefined();
    expect(out.runs[0]!.startedAt).toBe(0);
    expect(out.runs[1]).toMatchObject({ status: "done", percent: 50 });
  });
});
