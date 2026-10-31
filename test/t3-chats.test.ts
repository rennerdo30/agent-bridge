import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedT3Chats, readT3Chats, type T3ChatsResult } from "../src/core/t3-chats.js";
import { UI_PAGE } from "../src/cli/ui-page.js";
import { makeEnv } from "./helpers.js";

// AB-468: the installed T3 store's tables that the chat list reads (unused columns kept so the
// reader cannot depend on a trimmed shape), plus an auth table it must never need.
const SCHEMA = `
CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,title TEXT NOT NULL,workspace_root TEXT NOT NULL,
 scripts_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,
 default_provider TEXT NOT NULL,runtime_mode TEXT NOT NULL,interaction_mode TEXT NOT NULL,active_provider_thread_id TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT,deleted_at TEXT,payload_json TEXT NOT NULL,provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_runs(run_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,ordinal INTEGER NOT NULL,provider TEXT,
 provider_thread_id TEXT,status TEXT NOT NULL,requested_at TEXT,completed_at TEXT,payload_json TEXT NOT NULL,provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_runtime_requests(runtime_request_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,node_id TEXT,
 provider_turn_id TEXT,kind TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,resolved_at TEXT,payload_json TEXT NOT NULL);
CREATE TABLE auth_sessions(do_not_read TEXT);`;

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function store(schema = SCHEMA) {
  const root = mkdtempSync(join(tmpdir(), "ab-t3-chats-")); roots.push(root);
  mkdirSync(join(root, "userdata"));
  writeFileSync(join(root, "userdata", "environment-id"), "env-1\n");
  const db = new DatabaseSync(join(root, "userdata", "statev2.sqlite"));
  db.exec(schema);
  return { root, db };
}
const iso = (minutes: number) => new Date(Date.UTC(2026, 9, 31, 12, minutes)).toISOString();
function thread(db: DatabaseSync, id: string, o: { title?: string; provider?: string; minutes?: number; parent?: string; relation?: string; archived?: boolean; deleted?: boolean; model?: string } = {}) {
  db.prepare(`INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,'full-access','default',NULL,?,?,?,?,?,?)`).run(
    id, "p1", o.title ?? id, o.provider ?? "codex", iso(0), iso(o.minutes ?? 0), o.archived ? iso(1) : null, o.deleted ? iso(1) : null,
    JSON.stringify({ id, lineage: { parentThreadId: o.parent ?? null, relationshipToParent: o.relation ?? null }, modelSelection: o.model ? { model: o.model } : null, branch: "main" }),
    o.provider ?? "codex");
}
const run = (db: DatabaseSync, thread: string, ordinal: number, status: string) =>
  db.prepare(`INSERT INTO orchestration_v2_projection_runs VALUES(?,?,?,NULL,NULL,?,NULL,NULL,'{}',NULL)`).run(`${thread}:${ordinal}`, thread, ordinal, status);
const ready = (r: T3ChatsResult) => { if (r.state !== "ready") throw new Error(`unavailable: ${r.reason}`); return r; };

describe("T3 chat list from the local store (AB-468)", () => {
  it("nests subagent chats under their parent, keeps forks and orphans top-level and reports live status", () => {
    const { root, db } = store();
    db.prepare(`INSERT INTO projection_projects VALUES('p1','agent-bridge','E:/Development/claude-codex-comm','[]',?,?,NULL)`).run(iso(0), iso(0));
    thread(db, "main", { title: "Detect T3 chats", provider: "claudeAgent", minutes: 1, model: "claude-opus-5-5" });
    run(db, "main", 1, "running"); run(db, "main", 2, "completed");
    thread(db, "child", { title: "Implement", parent: "main", relation: "subagent", minutes: 5 }); run(db, "child", 1, "running");
    thread(db, "grandchild", { title: "Review", parent: "child", relation: "subagent", minutes: 4 });
    db.prepare(`INSERT INTO orchestration_v2_projection_runtime_requests VALUES('q1','grandchild',NULL,NULL,'user-input','pending',?,NULL,'{}')`).run(iso(4));
    thread(db, "fork", { title: "Fork of main", parent: "main", relation: "fork", minutes: 9 });
    thread(db, "orphan", { title: "Lost parent", parent: "gone", relation: "subagent", minutes: 8 });
    thread(db, "old", { title: "Archived chat", minutes: 7, archived: true });
    thread(db, "removed", { title: "Deleted chat", minutes: 9, deleted: true });
    db.close();

    const r = ready(readT3Chats(root));
    expect(r.environmentId).toBe("env-1");
    expect(r.projects).toEqual([{ id: "p1", title: "agent-bridge", root: "E:/Development/claude-codex-comm" }]);
    // A waiting descendant puts its top-level chat first; the rest by activity.
    expect(r.chats.map((c) => c.id)).toEqual(["main", "fork", "orphan"]);
    const main = r.chats[0]!;
    expect(main).toMatchObject({ title: "Detect T3 chats", provider: "claudeAgent", agent: "claude", model: "claude-opus-5-5",
      status: "done", relation: null, depth: 0, childCount: 2, childRunning: 1, childWaiting: 1 });
    expect(main.children.map((c) => [c.id, c.depth, c.status])).toEqual([["child", 1, "running"], ["grandchild", 2, "waiting"]]);
    expect(r.chats[1]).toMatchObject({ relation: "fork", parentId: "main", childCount: 0 });
    expect(r.chats[2]).toMatchObject({ relation: "subagent", status: "idle" });
    expect(r.archivedHidden).toBe(1);
    expect(ready(readT3Chats(root, { includeArchived: true })).chats.map((c) => c.id)).toContain("old");
  });

  it("reports a missing, unconfigured or unknown store as unavailable instead of an empty list", () => {
    expect(readT3Chats(undefined)).toMatchObject({ state: "unavailable" });
    expect(readT3Chats(join(tmpdir(), "ab-t3-chats-missing"))).toMatchObject({ state: "unavailable", reason: "T3 store missing, busy or unreadable" });
    const { root, db } = store(SCHEMA.replace(/CREATE TABLE orchestration_v2_projection_runs[^;]+;/, ""));
    db.close();
    expect(readT3Chats(root)).toMatchObject({ state: "unavailable", reason: "unsupported T3 store schema (orchestration_v2_projection_runs)" });
  });

  it("never writes to the T3 store", () => {
    const { root, db } = store();
    thread(db, "main");
    const before = db.prepare("PRAGMA data_version").get(), changes = db.prepare("SELECT total_changes() n").get();
    ready(readT3Chats(root));
    expect(db.prepare("PRAGMA data_version").get()).toEqual(before);
    expect(db.prepare("SELECT total_changes() n").get()).toEqual(changes);
    db.close();
  });

  it("serves /api/t3/chats behind dashboard authentication and rejects unknown parameters", async () => {
    vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
    const { root, db } = store();
    thread(db, "main", { title: "Served chat" }); db.close();
    const env = makeEnv();
    const { startUi } = await import("../src/cli/ui.js");
    const { nullLogger } = await import("../src/core/logger.js");
    const ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger, transcripts: { claude: env.home, codex: env.home, opencode: env.home, t3: root } });
    try {
      const base = ui.url.replace(/\/\?t=.*$/, "");
      expect((await fetch(`${base}/api/t3/chats`)).status).toBe(403);
      const headers = { cookie: String((await fetch(ui.url, { redirect: "manual" })).headers.get("set-cookie")).split(";")[0]! };
      const body = await (await fetch(`${base}/api/t3/chats`, { headers })).json();
      expect(body).toMatchObject({ state: "ready", chats: [{ id: "main", title: "Served chat" }] });
      expect((await fetch(`${base}/api/t3/chats?evil=1`, { headers })).status).toBe(400);
      expect((await fetch(`${base}/api/t3/chats?archived=yes`, { headers })).status).toBe(400);
    } finally { await ui.close(); env.cleanup(); }
  });

  it("re-reads the store only after the cache window", () => {
    const { root, db } = store();
    thread(db, "a");
    expect(ready(cachedT3Chats(root, false, 1_000)).total).toBe(1);
    thread(db, "b");
    expect(ready(cachedT3Chats(root, false, 5_000)).total).toBe(1);
    expect(ready(cachedT3Chats(root, false, 20_000)).total).toBe(2);
    db.close();
  });
});

describe("T3 Code dashboard view (AB-468)", () => {
  const script = UI_PAGE.split("<script>").pop()!.split("</script>")[0]!;
  function page() {
    const elements = new Map<string, any>();
    const el = (id: string): any => {
      if (!elements.has(id)) elements.set(id, { dataset: {}, value: "", checked: false, innerHTML: "", textContent: "", focus: vi.fn(), scrollIntoView: vi.fn(), querySelectorAll: () => [], querySelector: () => null,
        classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn(), contains: () => false }, setAttribute: vi.fn(), parentElement: { addEventListener: vi.fn() }, addEventListener: vi.fn() });
      return elements.get(id);
    };
    const document = { hidden: false, title: "", documentElement: { dataset: {} }, getElementById: el, addEventListener: vi.fn(), querySelectorAll: () => [] };
    const api = new Function("document", "window", "location", "localStorage", "setInterval", "fetch", "Notification", script +
      "\nreturn { renderT3, setT3: d => { t3Data = d; t3LoadedAt = Date.now(); }, open: id => t3Open.add(id) };")
      (document, { addEventListener: vi.fn() }, { hash: "#/t3" }, { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }, () => 0,
        vi.fn(() => new Promise(() => {})), Object.assign(vi.fn(), { permission: "default" }));
    return { ...api, html: () => el("t3List").innerHTML as string };
  }
  const chat = (id: string, extra: object = {}) => ({ id, title: id, projectId: "p1", provider: "codex", agent: "codex", model: null, status: "idle", settled: false, archived: false,
    parentId: null, relation: null, createdAt: 1, updatedAt: Date.now(), branch: null, depth: 0, children: [], childCount: 0, childRunning: 0, childWaiting: 0, ...extra });

  it("groups chats by project, escapes titles and shows subagent chats only when expanded", () => {
    const p = page();
    p.setT3({ state: "ready", projects: [{ id: "p1", title: "agent-bridge", root: "E:/Development/claude-codex-comm" }], archivedHidden: 2, truncated: false, total: 1,
      chats: [chat("main", { title: "Fix <dashboard>", status: "running", childCount: 1, childWaiting: 1,
        children: [chat("kid", { title: "Review kid", status: "waiting", depth: 1, relation: "subagent", parentId: "main" })] })] });
    p.renderT3();
    expect(p.html()).toContain("agent-bridge");
    expect(p.html()).toContain("Fix &lt;dashboard&gt;");
    expect(p.html()).toContain("1 subagent chat</button>");
    expect(p.html()).toContain('<span class="t3-wait">1 waiting for an answer</span>');
    expect(p.html()).toContain("2 archived chats hidden.");
    expect(p.html()).not.toContain("Review kid");
    p.open("main"); p.renderT3();
    expect(p.html()).toContain("Review kid");
    expect(p.html()).toContain("waiting for an answer");
  });

  it("shows why the list is unavailable", () => {
    const p = page();
    p.setT3({ state: "unavailable", reason: "T3 store missing, busy or unreadable" });
    p.renderT3();
    expect(p.html()).toContain("T3 chats are unavailable: T3 store missing, busy or unreadable.");
  });
});
