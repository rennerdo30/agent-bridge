import { expect, it, vi } from "vitest";
import { UI_PAGE } from "../src/cli/ui-page.js";

// AB-428: the dashboard shows a job's checklist progress on its row and the list in the job view, escaped.
const script = UI_PAGE.split("<script>").pop()!.split("</script>")[0]!;
function page() {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, {
      value: "", innerHTML: "", textContent: "", dataset: {}, checked: true, attrs: {} as Record<string, string>, classes: new Set<string>(),
      focus() {}, querySelectorAll: () => [], querySelector: () => null,
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
  const document = { getElementById: element, documentElement: { dataset: {} }, addEventListener() {}, querySelectorAll: () => [] };
  const api = new Function("document", "window", "location", "localStorage", "setInterval", "fetch",
    `${script}\nreturn { buildModel, groupRow, renderConversation };`)(
    document, { addEventListener() {} }, { hash: "" }, { setItem() {}, removeItem() {} }, () => 0, vi.fn(() => new Promise(() => {})));
  return { ...api, element };
}

const hostile = '<img src=x onerror=alert(1)> "quoted"';
const checklist = {
  summary: { total: 3, done: 1, skipped: 0, blocked: 1, inProgress: 0, open: 1, requiredOpen: 2, proposed: 1 },
  items: [
    { id: "c1", text: "Write tests", status: "done", required: true, source: "parent", note: "" },
    { id: "c2", text: hostile, status: "blocked", required: true, source: "project", note: "<b>waiting</b>" },
    { id: "c3", text: "Docs", status: "open", required: false, source: "parent", note: "" },
    { id: "c4", text: "Proposed idea", status: "proposed", required: false, source: "job", note: "" },
  ],
};
const run = (extra = {}) => ({ name: "run-a", job: "codex-job-a", agent: "codex", status: "running", startedAt: 1_000, updatedAt: 2_000, task: "task", last: "", owner: "claude-app", title: "Checklist job", ...extra });

it("shows checklist progress on the job row, escaped", () => {
  const p = page();
  const g = p.buildModel({ peers: [], runs: [run({ checklist })], jobs: {} }).sorted[0];
  const row = p.groupRow(g, false, true);
  expect(row).toContain('class="chip checklist"');
  expect(row).toContain("1/3");
  expect(row).not.toContain("<img");
  // A job without a checklist has no chip.
  const plain = p.buildModel({ peers: [], runs: [run()], jobs: {} }).sorted[0];
  expect(p.groupRow(plain, false, true)).not.toContain("checklist");
});

it("lists the checklist with notes and proposals in the job view, escaped", () => {
  const p = page();
  const g = p.buildModel({ peers: [], runs: [run({ checklist })], jobs: {} }).sorted[0];
  p.renderConversation(g);
  const list = p.element("cList");
  expect(list.classes.has("hidden")).toBe(false);
  expect(list.innerHTML).toContain("c2");
  expect(list.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot;");
  expect(list.innerHTML).toContain("&lt;b&gt;waiting&lt;/b&gt;");
  expect(list.innerHTML).toContain("proposed");
  expect(list.innerHTML).not.toContain("<img");
  expect(list.innerHTML).not.toContain("<b>");
  const empty = p.buildModel({ peers: [], runs: [run()], jobs: {} }).sorted[0];
  p.renderConversation(empty);
  expect(list.classes.has("hidden")).toBe(true);
  expect(list.innerHTML).toBe("");
});
