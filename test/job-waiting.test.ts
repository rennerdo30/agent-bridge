import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourceSlots } from "../src/core/resource-slots.js";
import { acquireStartup, STARTUP_CAPACITY, STARTUP_RESOURCE } from "../src/core/startup-admission.js";
import { readSlotSnapshot, slotSnapshotIo, slotWaitFor, storedJobWaits, waitingText, SLOT_SNAPSHOT_CACHE_MS, WAIT_FRESH_MS } from "../src/core/job-waiting.js";
import { SLOT_DB_NAME } from "../src/core/resource-slots.js";
import { startUi } from "../src/cli/ui.js";
import { makeEnv } from "./helpers.js";
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
      expect(slots.snapshot().find(e => !e.held)!.id).toMatch(/^codex-job-s~startup-[0-9a-f-]{36}$/);
    } finally { controller.abort(); await pending.catch(() => {}); }
    // An abandoned wait leaves no row behind.
    expect(slotWaitFor(slots.snapshot(), "codex-job-s")).toBeNull();
  });

  it("shows the root job budget as the job limit", () => {
    const slots = store();
    expect(slots.tryAcquire("root-abc", 1, own("codex-job-r1"))).toBe(true);
    expect(slots.tryAcquire("root-abc", 1, own("codex-job-r2"))).toBe(false);
    expect(slotWaitFor(slots.snapshot(), "codex-job-r2")).toEqual({ kind: "job-limit", scope: "root", position: 1, holders: 1, capacity: null });
    expect(waitingText(slotWaitFor(slots.snapshot(), "codex-job-r2")!)).toBe("waiting for the shared root job budget: position 1 in queue");
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

describe("matching a job's slot rows", () => {
  const row = (id: string, resource = "unity", ticket = 2) => ({ id, pid: process.pid, resource, ticket, held: false, expiresAt: Date.now() + 6 * 60 * 60_000 });
  const holder = (resource = "unity") => ({ ...row(`holder-${randomUUID()}`, resource, 1), held: true });

  it("treats regex characters in job names literally and matches case-sensitively", () => {
    const uuid = randomUUID();
    expect(slotWaitFor([holder(), row(`axb-${uuid}`)], "a.b")).toBeNull();
    expect(slotWaitFor([holder(), row(`a.b-${uuid}`)], "a.b")).toMatchObject({ kind: "resource", resource: "unity", position: 1 });
    expect(slotWaitFor([holder(), row(`aab-${uuid}`)], "a+b")).toBeNull();
    expect(slotWaitFor([holder(), row(`a+b-${uuid}`)], "a+b")).toMatchObject({ kind: "resource", resource: "unity" });
    expect(slotWaitFor([holder(), row(`job(1)-${uuid}`)], "job(1)")).toMatchObject({ kind: "resource", resource: "unity" });
    expect(slotWaitFor([holder(), row(`Codex-Job-${uuid}`)], "codex-job")).toBeNull();
    expect(slotWaitFor([holder(), row(`codex-job-${uuid.toUpperCase()}`)], "codex-job")).toBeNull();
  });

  it("keeps job x's startup row and job x-startup's rows apart; older runners' startup rows match no job", () => {
    const uuid = randomUUID();
    const startup = [holder(STARTUP_RESOURCE), row(`x~startup-${uuid}`, STARTUP_RESOURCE)];
    expect(slotWaitFor(startup, "x")).toMatchObject({ kind: "startup", position: 1 });
    expect(slotWaitFor(startup, "x-startup")).toBeNull();
    // Job "x-startup" waiting for unity is not job "x".
    const unity = [holder(), row(`x-startup-${uuid}`)];
    expect(slotWaitFor(unity, "x")).toBeNull();
    expect(slotWaitFor(unity, "x-startup")).toMatchObject({ kind: "resource", resource: "unity" });
    // Startup rows written before the `~startup-` separator (`startup-<uuid>`, `<job>-startup-<uuid>`) are nobody's wait.
    const old = [holder(STARTUP_RESOURCE), row(`x-startup-${uuid}`, STARTUP_RESOURCE), row(`startup-${randomUUID()}`, STARTUP_RESOURCE, 3)];
    for (const name of ["x", "x-startup", "startup"]) expect(slotWaitFor(old, name)).toBeNull();
  });
});

describe("read-only slot snapshot", () => {
  it("creates nothing when the slot database is missing", () => {
    expect(readSlotSnapshot(home, 0)).toEqual([]);
    expect(readSlotSnapshot(home)).toEqual([]);
    expect(existsSync(join(home, SLOT_DB_NAME))).toBe(false);
  });

  it("reads through a read-only connection and does not open again within the cache window", () => {
    const slots = store();
    expect(slots.tryAcquire("unity", 1, own("codex-job-hold"))).toBe(true);
    expect(slots.tryAcquire("unity", 1, own("codex-job-a"))).toBe(false);
    const probe = slotSnapshotIo.open(join(home, SLOT_DB_NAME));
    try { expect(() => probe.exec("DELETE FROM slots")).toThrow(/readonly/i); } finally { probe.close(); }
    const open = vi.spyOn(slotSnapshotIo, "open");
    try {
      const t0 = Date.now();
      const first = readSlotSnapshot(home, SLOT_SNAPSHOT_CACHE_MS, t0);
      expect(first.map(e => e.held)).toEqual([true, false]);
      expect(open).toHaveBeenCalledTimes(1);
      // A change inside the window is not read: the cached snapshot is returned without a second open.
      expect(slots.tryAcquire("unity", 1, own("codex-job-b"))).toBe(false);
      expect(readSlotSnapshot(home, SLOT_SNAPSHOT_CACHE_MS, t0 + SLOT_SNAPSHOT_CACHE_MS - 1)).toBe(first);
      expect(open).toHaveBeenCalledTimes(1);
      // After the window it reads again, and maxAge 0 always reads.
      expect(readSlotSnapshot(home, SLOT_SNAPSHOT_CACHE_MS, t0 + SLOT_SNAPSHOT_CACHE_MS)).toHaveLength(3);
      expect(open).toHaveBeenCalledTimes(2);
      readSlotSnapshot(home, 0, t0 + SLOT_SNAPSHOT_CACHE_MS);
      expect(open).toHaveBeenCalledTimes(3);
    } finally { open.mockRestore(); }
  });

  it("serves waitingFor in the dashboard's /api/state (startUi) without creating a missing slot database", async () => {
    const env = makeEnv();
    const ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    try {
      writeFileSync(join(env.home, "jobs.json"), JSON.stringify({ version: 4, jobs: [
        { id: "aaaa1111", name: "codex-job-aaaa1111", agent: "codex", status: "running", owner: "s1", startedAt: 1_000, prompt: "wait for unity", args: {} },
        { id: "cccc3333", name: "codex-job-cccc3333", agent: "codex", status: "interrupted", waitingForStart: true, owner: "s1", startedAt: 3_000, prompt: "queued", args: {} },
      ] }));
      const base = ui.url.replace(/\/\?t=.*$/, "");
      const cookie = String((await fetch(ui.url, { redirect: "manual" })).headers.get("set-cookie")).split(";")[0]!;
      const state = async () => (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()) as { jobs: Record<string, { waitingFor?: unknown }> };
      // No slot database: the running job has no wait and nothing is created.
      const before = await state();
      expect(before.jobs["codex-job-aaaa1111"]).toBeDefined();
      expect(before.jobs["codex-job-aaaa1111"]!.waitingFor).toBeUndefined();
      expect(before.jobs["codex-job-cccc3333"]!.waitingFor).toEqual({ kind: "job-limit", position: 1, holders: 1, capacity: null });
      expect(existsSync(join(env.home, SLOT_DB_NAME))).toBe(false);
      const slots = new ResourceSlots(env.home, () => true);
      try {
        expect(slots.tryAcquire("unity", 1, own("codex-job-hold"))).toBe(true);
        expect(slots.tryAcquire("unity", 1, own("codex-job-aaaa1111"))).toBe(false);
        // The snapshot is cached per home for a short window; the next poll after it shows the wait.
        await vi.waitFor(async () => expect((await state()).jobs["codex-job-aaaa1111"]!.waitingFor).toEqual({ kind: "resource", resource: "unity", position: 1, holders: 1, capacity: null }), { timeout: 5_000, interval: 250 });
      } finally { slots.close(); }
    } finally { await ui.close(); await env.cleanup(); }
  });
});

describe("job status and the peers listing", () => {
  const abortable = (): Run => signal => new Promise(resolve => signal.addEventListener("abort", () => resolve({ text: "", sessionId: null, isError: false, details: {}, status: "cancelled" } as never), { once: true }));
  /** A real JobManager behind the real tools, in its own folder (its root budget and job report databases outlive this test's synchronous cleanup); `slotHome` is the tools' home. */
  async function harness(max: number, slotHome?: string) {
    const dir = mkdtempSync(join(tmpdir(), "ab-waiting-tools-"));
    const path = join(dir, "jobs.json");
    const coordinator = new LocalCoordinator("owner", "root-session");
    Object.assign(coordinator, { setNotificationWaitHandlers: vi.fn(), jobAuthority: async (ref: string) => readStore(path).find(j => j.name === ref || j.id === ref) ?? null });
    const jobs = new JobManager(coordinator, nullLogger, path, max);
    // The listing's own session: a minimal node like ab404-delivery's.
    const node = { id: "self", name: "owner", isBroker: false, autoWakeEnabled: false, wasReplaced: false, isConnected: true,
      setNotificationWaitHandlers: () => {}, peers: async () => [], health: async () => null, refreshPending: async () => {},
      projectJobSummaries: async () => [], unread: () => [], brokerLoad: async () => null, nativeChildren: async () => [],
      jobAuthority: async (ref: string) => readStore(path).find(j => j.name === ref || j.id === ref) ?? null };
    const server = new McpServer({ name: "waiting-test", version: "0" });
    registerTools(server, { agent: "codex", cfg: { ...DEFAULT_CONFIG, resourceSlots: { unity: 1 } }, node: node as unknown as BridgeNode, jobs, home: slotHome ?? dir, cwd: () => dir, channelActive: () => false, log: nullLogger }, []);
    const client = new Client({ name: "waiting-test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (args: Record<string, unknown>) => ((await client.callTool({ name: "peers", arguments: args })) as { content: { text: string }[] }).content.map(c => c.text).join("\n");
    return {
      jobs, call, status: async (job: string) => JSON.parse(await call({ job })),
      waitingJobs: (jobs as unknown as { waitingJobs: Map<string, unknown> }).waitingJobs,
      close: async () => { jobs.setDormant(true); jobs.cancelAll(); await client.close(); await server.close(); },
    };
  }

  it("shows a job held back by the session's job limit with its place and the running holders; the running job is not waiting", async () => {
    const h = await harness(1);
    try {
      const running = h.jobs.start("codex", null, "holds the only slot", abortable());
      const queued = h.jobs.start("codex", null, "waits", abortable());
      expect((await h.status(queued.name)).waitingFor).toEqual({ kind: "job-limit", scope: "session", position: 1, holders: 1, capacity: 1 });
      expect((await h.status(running.name))).toMatchObject({ status: "running", waitingFor: null });
      expect(waitingText(h.jobs.limitWait(queued)!)).toBe("waiting for a subagent slot (job limit): position 1 in queue, 1/1 running");
      for (const args of [{}, { limit: 50 }]) expect(await h.call(args)).toContain(`(${waitingText(h.jobs.limitWait(queued)!)})`);
    } finally { await h.close(); }
  });

  it("never labels a stopping job's queued follow-up, a paused job's queued resume or a deferral as the job limit", async () => {
    const h = await harness(2);
    try {
      const running = h.jobs.start("codex", null, "runs", abortable());
      // A follow-up queued while the running job stops puts the running job itself in the queue.
      h.waitingJobs.set(running.id, running);
      expect(h.jobs.limitWait(running)).toBeNull();
      expect((await h.status(running.name)).waitingFor).toBeNull();
      // A deferred start (job store lock, store upgrade, EBUSY) while the limit has room: not the job limit.
      const deferred = { id: "deferred1", name: "codex-job-deferred1", agent: "codex", status: "interrupted" as "interrupted" | "paused", waitingForStart: true, queue: [] as string[], args: {}, startedAt: Date.now(), owner: "owner" };
      h.waitingJobs.set(deferred.id, deferred);
      expect(h.jobs.canStart()).toBe(true);
      expect(h.jobs.limitWait(deferred)).toBeNull();
      // A paused job whose resume is queued is worded as that.
      Object.assign(deferred, { status: "paused", pausedAt: Date.now(), resumeRequested: true });
      expect(h.jobs.limitWait(deferred)).toBeNull();
      for (const args of [{}, { limit: 50 }]) {
        const listing = await h.call(args);
        expect(listing).toContain(`${deferred.name}`);
        expect(listing).toContain("(paused; resume queued)");
        expect(listing).not.toContain("job limit");
      }
    } finally { await h.close(); }
  });

  it("shows a running job's slot wait in the paged listing and in peers(job=) from one read-only snapshot", async () => {
    const h = await harness(2, home);
    const slots = store();
    try {
      const job = h.jobs.start("codex", null, "needs unity", abortable());
      expect(slots.tryAcquire("unity", 1, own("codex-job-hold"))).toBe(true);
      expect(slots.tryAcquire("unity", 1, own(job.name))).toBe(false);
      const text = 'waiting for machine resource slot "unity": position 1 in queue, 1/1 held';
      for (const args of [{}, { limit: 50 }, { limit: 50, offset: 0, name: job.name }]) {
        const listing = await h.call(args);
        expect(listing).toContain(text);
        expect(listing).toContain("Resource slots (holders, then the queue in order):");
      }
      expect((await h.status(job.name)).waitingFor).toEqual({ kind: "resource", resource: "unity", position: 1, holders: 1, capacity: 1 });
    } finally { await h.close(); }
  });

  it("does not create a missing slot database from peers or peers(job=)", async () => {
    const empty = mkdtempSync(join(TEST_ROOT, "waiting-empty-"));
    const h = await harness(2, empty);
    try {
      const job = h.jobs.start("codex", null, "runs", abortable());
      await h.call({});
      await h.call({ limit: 50 });
      expect((await h.status(job.name)).waitingFor).toBeNull();
      expect(existsSync(join(empty, SLOT_DB_NAME))).toBe(false);
    } finally { await h.close(); rmSync(empty, { recursive: true, force: true }); }
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
