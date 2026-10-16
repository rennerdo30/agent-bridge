import { expect, it, vi } from "vitest";
import { UI_PAGE } from "../src/cli/ui-page.js";

// AB-398: a paused subagent reads as paused (with its reason and time) everywhere on the dashboard, never as done.
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
  const fetch = vi.fn(() => new Promise(() => {}));
  const document = { getElementById: element, documentElement: { dataset: {} }, addEventListener() {}, querySelectorAll: () => [] };
  const api = new Function("document", "window", "location", "localStorage", "setInterval", "fetch",
    `${script}\nreturn { buildModel, groupRow, countGroups, countsLine, renderConversation };`)(
    document, { addEventListener() {} }, { hash: "" }, { setItem() {}, removeItem() {} }, () => 0, fetch);
  return { ...api, element };
}

const run = (name: string, job: string, status: string, extra = {}) => ({ name, job, agent: "codex", status, startedAt: 1_000, updatedAt: 2_000, task: "task", last: "", owner: "claude-app", ...extra });

it("shows a saved paused job as paused, escapes its reason and keeps it with the working rows", () => {
  const p = page();
  const reason = "<img src=x onerror=alert(1)> owner build";
  const model = p.buildModel({
    peers: [],
    runs: [run("run-paused", "codex-job-paused", "cancelled"), run("run-done", "codex-job-done", "done", { startedAt: 3_000, updatedAt: 4_000 })],
    jobs: {
      "codex-job-paused": { next: {}, status: "paused", pauseReason: reason, pausedAt: Date.UTC(2026, 9, 16, 1, 2, 3) },
      "codex-job-done": { next: {}, status: "done" },
    },
  });
  const paused = model.sorted.find((g: { job: string }) => g.job === "codex-job-paused");
  expect(paused).toMatchObject({ status: "paused", pauseReason: reason });
  // Paused rows sort with the working ones, ahead of finished ones.
  expect(model.sorted[0].job).toBe("codex-job-paused");
  const row = p.groupRow(paused, false, true);
  expect(row).toContain('class="pill paused"');
  expect(row).toContain(">paused<");
  expect(row).toContain("&lt;img src=x onerror=alert(1)&gt; owner build");
  expect(row).not.toContain("<img");
  const counts = p.countGroups(model.sorted);
  expect(counts).toMatchObject({ paused: 1, done: 1, working: 0, failed: 0 });
  expect(p.countsLine(counts)).toContain("1 paused");
});

it("names the pause and offers resume_subagent in the conversation view", () => {
  const p = page();
  const model = p.buildModel({ peers: [], runs: [run("run-a", "codex-job-a", "running")], jobs: { "codex-job-a": { next: {}, status: "paused", pausePending: true } } });
  const g = model.sorted[0];
  expect(g).toMatchObject({ status: "paused", pauseReason: "supervisor request" });
  p.renderConversation(g);
  expect(p.element("cTitle").innerHTML).toContain('class="pill paused"');
  expect(p.element("cNote").textContent).toContain("supervisor request");
  expect(p.element("cNote").textContent).toMatch(/^Paused /);
  expect(p.element("cHint").innerHTML).toContain('resume_subagent(job="codex-job-a")');
});
