import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceSlots } from "../src/core/resource-slots.js";
import { acquireStartup, STARTUP_CAPACITY, STARTUP_RESOURCE } from "../src/core/startup-admission.js";
import { slotWaitFor, storedJobWaits, waitingText, WAIT_FRESH_MS } from "../src/core/job-waiting.js";
import { readDashboard } from "../src/core/dashboard-read.js";
import { startRunFeed } from "../src/core/runfeed.js";
import { nullLogger } from "../src/core/logger.js";
import { UI_PAGE } from "../src/cli/ui-page.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import type { BridgeNode } from "../src/core/node.js";
import { JobManager, readStore, type Run } from "../src/mcp/jobs.js";
import { LocalCoordinator } from "../src/mcp/local-coordinator.js";
import { registerTools } from "../src/mcp/server.js";

// AB-401: a job queued for a machine slot is visibly waiting, with what it waits for, its place and the holders;
// a running job that is not queued anywhere (a real stall included) never reads as waiting.
const TEST_ROOT = process.env.AGENT_BRIDGE_TEST_ROOT!;
let home: string;
const stores: ResourceSlots[] = [];
beforeEach(() => { mkdirSync(TEST_ROOT, { recursive: true }); home = mkdtempSync(join(TEST_ROOT, "waiting-")); });
afterEach(() => { for (const s of stores.splice(0)) s.close(); rmSync(home, { recursive: true, force: true }); });
const store = () => { const s = new ResourceSlots(home, () => true); stores.push(s); return s; };
const own = (job: string, kind = "") => ({ id: `${job}-${kind}${randomUUID()}`, pid: process.pid });

describe("waiting for a machine slot", () => {
  it("shows a job waiting for a held resource slot with its queue position and holders; the holder is not waiting", () => {
    const slots = store();
    const holder = own("codex-job-hold"), first = own("codex-job-a"), second = own("claude-job-b");
    expect(slots.tryAcquire("unity", 1, holder)).toBe(true);
    expect(slots.tryAcquire("unity", 1, first)).toBe(false);
    expect(slots.tryAcquire("unity", 1, second)).toBe(false);
    const snapshot = slots.snapshot();
    expect(slotWaitFor(snapshot, "codex-job-a", { unity: 1 })).toEqual({ kind: "resource", resource: "unity", position: 1, holders: 1, capacity: 1 });
    expect(slotWaitFor(snapshot, "claude-job-b", { unity: 1 })).toEqual({ kind: "resource", resource: "unity", position: 2, holders: 1, capacity: 1 });
    expect(slotWaitFor(snapshot, "codex-job-hold", { unity: 1 })).toBeNull();
    // A name prefix of another job's name is not that job.
    expect(slotWaitFor(snapshot, "codex-job", { unity: 1 })).toBeNull();
    expect(waitingText(slotWaitFor(snapshot, "claude-job-b", { unity: 1 })!)).toBe('waiting for machine resource slot "unity": position 2 in queue, 1/1 held');
  });

  it("shows a job waiting at machine startup admission", async () => {
    const slots = store();
    for (let i = 0; i < STARTUP_CAPACITY; i++) expect(slots.tryAcquire(STARTUP_RESOURCE, STARTUP_CAPACITY, own(`codex-job-busy${i}`, "startup-"))).toBe(true);
    const controller = new AbortController();
    const pending = acquireStartup(home, controller.signal, "codex-job-s");
    try {
      await vi.waitFor(() => expect(slotWaitFor(slots.snapshot(), "codex-job-s")).toEqual({ kind: "startup", position: 1, holders: STARTUP_CAPACITY, capacity: STARTUP_CAPACITY }), { timeout: 5_000, interval: 50 });
      expect(waitingText(slotWaitFor(slots.snapshot(), "codex-job-s")!)).toBe(`waiting for machine startup admission: position 1 in queue, ${STARTUP_CAPACITY}/${STARTUP_CAPACITY} held`);
    } finally { controller.abort(); await pending.catch(() => {}); }
    // An abandoned wait leaves no row behind.
    expect(slotWaitFor(slots.snapshot(), "codex-job-s")).toBeNull();
  });

  it("shows the root job budget as the job limit", () => {
    const slots = store();
    expect(slots.tryAcquire("root-abc", 1, own("codex-job-r1"))).toBe(true);
    expect(slots.tryAcquire("root-abc", 1, own("codex-job-r2"))).toBe(false);
    expect(slotWaitFor(slots.snapshot(), "codex-job-r2")).toEqual({ kind: "job-limit", position: 1, holders: 1, capacity: null });
  });

  it("keeps a stall a stall: a waiting row that stopped polling is not a wait", () => {
    const slots = store();
    expect(slots.tryAcquire("unity", 1, own("codex-job-hold"))).toBe(true);
    expect(slots.tryAcquire("unity", 1, own("codex-job-stuck"))).toBe(false);
    expect(slotWaitFor(slots.snapshot(), "codex-job-stuck", {}, Date.now() + WAIT_FRESH_MS + 1_000)).toBeNull();
  });

  it("gives stored jobs their wait: job limit position among the session's waiting jobs, slot waits for running jobs", () => {
    const slots = store();
    expect(slots.tryAcquire("unity", 1, own("codex-job-hold"))).toBe(true);
    expect(slots.tryAcquire("unity", 1, own("codex-job-a"))).toBe(false);
    const waits = storedJobWaits([
      { name: "codex-job-hold", owner: "s1", status: "running", startedAt: 1 },
      { name: "codex-job-a", owner: "s1", status: "running", startedAt: 2 },
      { name: "codex-job-run", owner: "s1", status: "running", startedAt: 3 },
      { name: "codex-job-w2", owner: "s1", status: "interrupted", waitingForStart: true, startedAt: 5 },
      { name: "codex-job-w1", owner: "s1", status: "interrupted", waitingForStart: true, startedAt: 4 },
      { name: "codex-job-other", owner: "s2", status: "interrupted", waitingForStart: true, startedAt: 1 },
      { name: "codex-job-done", owner: "s1", status: "done", startedAt: 0 },
    ], () => slots.snapshot(), () => ({ unity: 1 }));
    expect(waits.get("codex-job-a")).toEqual({ kind: "resource", resource: "unity", position: 1, holders: 1, capacity: 1 });
    expect(waits.get("codex-job-w1")).toEqual({ kind: "job-limit", position: 1, holders: 3, capacity: null });
    expect(waits.get("codex-job-w2")).toEqual({ kind: "job-limit", position: 2, holders: 3, capacity: null });
    expect(waits.get("codex-job-other")).toEqual({ kind: "job-limit", position: 1, holders: 0, capacity: null });
    for (const name of ["codex-job-hold", "codex-job-run", "codex-job-done"]) expect(waits.has(name)).toBe(false);
  });

  it("reports waitingFor in /api/state for a waiting job and not for a running one", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ resourceSlots: { unity: 1 } }));
    writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: 4, jobs: [
      { id: "aaaa1111", name: "codex-job-aaaa1111", agent: "codex", status: "running", owner: "s1", startedAt: 1_000, prompt: "wait for unity", args: {} },
      { id: "bbbb2222", name: "codex-job-bbbb2222", agent: "codex", status: "running", owner: "s1", startedAt: 2_000, prompt: "run", args: {} },
    ] }));
    const feeds = ["aaaa1111", "bbbb2222"].map(id => startRunFeed({ home, name: `codex-${id}`, header: "codex by s1", meta: { job: `codex-job-${id}` } }));
    const slots = store();
    expect(slots.tryAcquire("unity", 1, own("codex-job-bbbb2222"))).toBe(true);
    expect(slots.tryAcquire("unity", 1, own("codex-job-aaaa1111"))).toBe(false);
    try {
      const state = await readDashboard({ home, log: nullLogger, peers: () => [] }, { path: "/api/state" });
      const jobs = (state.body as { jobs: Record<string, { waitingFor?: unknown }> }).jobs;
      expect(jobs["codex-job-aaaa1111"]!.waitingFor).toEqual({ kind: "resource", resource: "unity", position: 1, holders: 1, capacity: 1 });
      expect(jobs["codex-job-bbbb2222"]).toBeDefined();
      expect(jobs["codex-job-bbbb2222"]!.waitingFor).toBeUndefined();
    } finally { for (const feed of feeds) feed.end("done"); }
  });
});

describe("job status (peers job=...)", () => {
  it("shows a job held back by the session's job limit with its place and the running holders; the running job is not waiting", async () => {
    // Its own folder: the job manager's root budget database outlives this test's synchronous cleanup.
    const dir = mkdtempSync(join(tmpdir(), "ab-waiting-tools-"));
    const path = join(dir, "jobs.json");
    const node = new LocalCoordinator("owner", "root-session");
    Object.assign(node, { setNotificationWaitHandlers: vi.fn(), jobAuthority: async (ref: string) => readStore(path).find(j => j.name === ref || j.id === ref) ?? null });
    const jobs = new JobManager(node, nullLogger, path, 1);
    const server = new McpServer({ name: "waiting-test", version: "0" });
    registerTools(server, { agent: "codex", cfg: { ...DEFAULT_CONFIG }, node: node as unknown as BridgeNode, jobs, home: dir, cwd: () => dir, channelActive: () => false, log: nullLogger }, []);
    const client = new Client({ name: "waiting-test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const abortable = (): Run => signal => new Promise(resolve => signal.addEventListener("abort", () => resolve({ text: "", sessionId: null, isError: false, details: {}, status: "cancelled" } as never), { once: true }));
    try {
      const running = jobs.start("codex", null, "holds the only slot", abortable());
      const queued = jobs.start("codex", null, "waits", abortable());
      const status = async (job: string) => JSON.parse(((await client.callTool({ name: "peers", arguments: { job } })) as { content: { text: string }[] }).content[0]!.text);
      expect((await status(queued.name)).waitingFor).toEqual({ kind: "job-limit", position: 1, holders: 1, capacity: 1 });
      expect((await status(running.name))).toMatchObject({ status: "running", waitingFor: null });
      expect(waitingText(jobs.limitWait(queued)!)).toBe("waiting for a subagent slot (job limit): position 1 in queue, 1/1 running");
    } finally {
      jobs.setDormant(true); jobs.cancelAll();
      await client.close(); await server.close();
    }
  });
});

describe("dashboard", () => {
  const script = UI_PAGE.split("<script>").pop()!.split("</script>")[0]!;
  const element = () => ({ value: "", innerHTML: "", textContent: "", dataset: {}, classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, setAttribute() {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, parentElement: { addEventListener() {} } });
  const api = new Function("document", "window", "location", "localStorage", "setInterval", "fetch",
    `${script}\nreturn { buildModel, groupRow };`)(
    { getElementById: element, documentElement: { dataset: {} }, addEventListener() {}, querySelectorAll: () => [] }, { addEventListener() {} }, { hash: "" }, { setItem() {}, removeItem() {} }, () => 0, () => new Promise(() => {}));
  const run = (name: string, job: string) => ({ name, job, agent: "codex", status: "running", startedAt: 1_000, updatedAt: 2_000, task: "task", last: "", owner: "claude-app" });

  it("shows a distinct, escaped waiting pill for a queued job and the working pill for a running one", () => {
    const model = api.buildModel({ peers: [], runs: [run("run-a", "codex-job-a"), run("run-b", "codex-job-b")], jobs: {
      "codex-job-a": { next: {}, status: "running", waitingFor: { kind: "resource", resource: "<b>unity</b>", position: 2, holders: 1, capacity: 1 } },
      "codex-job-b": { next: {}, status: "running" },
    } });
    const waiting = api.groupRow(model.sorted.find((g: { job: string }) => g.job === "codex-job-a"), false, false);
    expect(waiting).toContain('class="pill waiting"');
    expect(waiting).toContain("waiting · slot &lt;b&gt;unity&lt;/b&gt; #2");
    expect(waiting).not.toContain("<b>unity");
    const working = api.groupRow(model.sorted.find((g: { job: string }) => g.job === "codex-job-b"), false, false);
    expect(working).toContain('class="pill running"');
    expect(working).not.toContain("waiting");
  });
});
