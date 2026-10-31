import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { T3_INDEX_MISS_MS, T3_INDEX_MS, t3FolderKey, t3SessionInfo } from "../src/core/t3-sessions.js";
import { UI_PAGE } from "../src/cli/ui-page.js";

// AB-468: the installed T3 store's tables this feature reads (unused columns kept so the reader
// cannot depend on a trimmed shape), plus an auth table it must never need.
const SCHEMA = `
CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,
 default_provider TEXT NOT NULL,runtime_mode TEXT NOT NULL,interaction_mode TEXT NOT NULL,active_provider_thread_id TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT,deleted_at TEXT,payload_json TEXT NOT NULL,provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_runs(run_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,ordinal INTEGER NOT NULL,provider TEXT,
 provider_thread_id TEXT,status TEXT NOT NULL,requested_at TEXT,completed_at TEXT,payload_json TEXT NOT NULL,provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_runtime_requests(runtime_request_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,node_id TEXT,
 provider_turn_id TEXT,kind TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,resolved_at TEXT,payload_json TEXT NOT NULL);
CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,owner_node_id TEXT,
 provider TEXT NOT NULL,provider_session_id TEXT,status TEXT,first_run_ordinal INTEGER,last_run_ordinal INTEGER,updated_at TEXT,payload_json TEXT,driver TEXT,provider_instance_id TEXT);
CREATE TABLE orchestration_v2_projection_subagents(subagent_id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,run_id TEXT,parent_node_id TEXT,provider TEXT,
 provider_thread_id TEXT,child_thread_id TEXT,origin TEXT,status TEXT,started_at TEXT,completed_at TEXT,updated_at TEXT,payload_json TEXT,driver TEXT,provider_instance_id TEXT);
CREATE TABLE auth_sessions(do_not_read TEXT);`;

const roots: { root: string; db: DatabaseSync }[] = [];
afterEach(() => {
  for (const { root, db } of roots.splice(0)) { if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); }
});
function store() {
  const root = mkdtempSync(join(tmpdir(), "ab-t3-sessions-"));
  mkdirSync(join(root, "userdata"));
  const db = new DatabaseSync(join(root, "userdata", "statev2.sqlite"));
  roots.push({ root, db });
  db.exec(SCHEMA);
  return { root, db };
}
const at = "2026-10-31T12:00:00Z";
function thread(db: DatabaseSync, id: string, o: { title?: string; provider?: string; folder?: string | null; parent?: string; deleted?: boolean; model?: string } = {}) {
  db.prepare(`INSERT INTO orchestration_v2_projection_threads VALUES(?,'p1',?,?,'full-access','default',NULL,?,?,NULL,?,?,?)`).run(
    id, o.title ?? id, o.provider ?? "codex", at, at, o.deleted ? at : null,
    JSON.stringify({ id, worktreePath: o.folder ?? null, lineage: { parentThreadId: o.parent ?? null, relationshipToParent: o.parent ? "subagent" : null },
      modelSelection: o.model ? { model: o.model } : null }), o.provider ?? "codex");
}
/** How T3 started a child chat: a delegated task (its own session) or a provider-native subagent (inside the parent's process). */
const origin = (db: DatabaseSync, child: string, parent: string, how: "app_owned" | "provider_native") =>
  db.prepare(`INSERT INTO orchestration_v2_projection_subagents(subagent_id,thread_id,child_thread_id,origin) VALUES(?,?,?,?)`).run(`sub-${child}`, parent, child, how);
/** T3 records one provider thread per provider a chat ran on (a provider switch adds one). */
const harness = (db: DatabaseSync, thread: string, provider: string) =>
  db.prepare(`INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider) VALUES(?,?,?)`).run(`${thread}:${provider}`, thread, provider);
const run = (db: DatabaseSync, thread: string, ordinal: number, status: string) =>
  db.prepare(`INSERT INTO orchestration_v2_projection_runs VALUES(?,?,?,NULL,NULL,?,NULL,NULL,'{}',NULL)`).run(`${thread}:${ordinal}`, thread, ordinal, status);
const WT = "E:/AgentData/game/t3-aaaa1111";

describe("T3 chats behind Bridge sessions (AB-468)", () => {
  it("matches a session to the T3 chat whose own folder it runs in, with title, model, status and parent", () => {
    const { root, db } = store();
    thread(db, "main", { title: "Game main thread", provider: "claudeAgent" });
    thread(db, "chat", { title: "Dungeon epic round 2", folder: "E:\\AgentData\\game\\t3-aaaa1111", parent: "main", model: "gpt-6.1-sol" });
    run(db, "chat", 1, "running"); run(db, "chat", 2, "completed");
    thread(db, "asks", { title: "Needs an answer", folder: "E:/AgentData/game/t3-bbbb2222", provider: "claudeAgent" });
    db.prepare(`INSERT INTO orchestration_v2_projection_runtime_requests VALUES('q','asks',NULL,NULL,'user-input','pending',?,NULL,'{}')`).run(at);
    const info = t3SessionInfo(root, [
      // Separators, case and the D: alias of the same drive do not matter.
      { key: "codex-t3-aaaa1111", cwd: "d:\\agentdata\\GAME\\t3-aaaa1111\\", agent: "codex" },
      { key: "claude-asks", cwd: "E:/AgentData/game/t3-bbbb2222", agent: "claude" },
    ], 1_000);
    expect(info.get("codex-t3-aaaa1111")).toEqual({ id: "chat", title: "Dungeon epic round 2", provider: "codex", model: "gpt-6.1-sol", status: "done", parentTitle: "Game main thread", harness: "current" });
    expect(info.get("claude-asks")).toMatchObject({ title: "Needs an answer", status: "waiting", parentTitle: null });
    db.close();
  });

  it("never guesses: shared folders, a different agent, deleted chats and project-root chats get nothing", () => {
    const { root, db } = store();
    thread(db, "a", { folder: "E:/shared" }); thread(db, "b", { folder: "E:/shared" });
    thread(db, "claude-chat", { folder: WT, provider: "claudeAgent" });
    thread(db, "gone", { folder: "E:/gone", deleted: true });
    thread(db, "root-chat", { title: "Main in project root" });
    const info = t3SessionInfo(root, [
      { key: "shared", cwd: "E:/shared", agent: "codex" },
      { key: "wrong-agent", cwd: WT, agent: "codex" },
      { key: "deleted", cwd: "E:/gone", agent: "codex" },
      { key: "root", cwd: "E:/Development/game", agent: "codex" },
    ], 1_000);
    expect(info.size).toBe(0);
    db.close();
  });

  it("treats a missing, busy or unknown store as no T3 data, without throwing", () => {
    expect(t3SessionInfo(undefined, [{ key: "x", cwd: WT, agent: "codex" }]).size).toBe(0);
    expect(t3SessionInfo(join(tmpdir(), "ab-t3-missing"), [{ key: "x", cwd: WT, agent: "codex" }]).size).toBe(0);
    const { root, db } = store();
    thread(db, "chat", { folder: WT });
    db.exec("BEGIN EXCLUSIVE");
    expect(t3SessionInfo(root, [{ key: "x", cwd: WT, agent: "codex" }], 1_000).size).toBe(0);
    db.exec("ROLLBACK");
    db.exec("DROP TABLE orchestration_v2_projection_runs");
    expect(t3SessionInfo(root, [{ key: "x", cwd: WT, agent: "codex" }], 2_000_000).size).toBe(0);
    db.close();
  });

  it("never writes to the T3 store", () => {
    const { root, db } = store();
    thread(db, "chat", { folder: WT }); run(db, "chat", 1, "running");
    const before = db.prepare("PRAGMA data_version").get();
    expect(t3SessionInfo(root, [{ key: "x", cwd: WT, agent: "codex" }], 1_000).size).toBe(1);
    // data_version changes when another connection commits a write to this database.
    expect(db.prepare("PRAGMA data_version").get()).toEqual(before);
    db.close();
  });

  it("finds a new chat's folder after a short delay, but folders that are no chat do not force rebuilds", () => {
    const { root, db } = store();
    const t0 = 10_000_000;
    expect(t3SessionInfo(root, [{ key: "repo", cwd: "E:/Development/repo", agent: "codex" }], t0).size).toBe(0);
    thread(db, "new", { folder: WT, title: "New chat" });
    const both = [{ key: "repo", cwd: "E:/Development/repo", agent: "codex" }, { key: "new", cwd: WT, agent: "codex" }];
    expect(t3SessionInfo(root, both, t0 + 1_000).size).toBe(0); // index is younger than the miss window
    expect(t3SessionInfo(root, both, t0 + T3_INDEX_MISS_MS).get("new")).toMatchObject({ title: "New chat" });
    db.prepare("UPDATE orchestration_v2_projection_threads SET title='Renamed' WHERE thread_id='new'").run();
    // Both folders were known when the index was built ("repo" is simply no chat): no early rebuild.
    expect(t3SessionInfo(root, both, t0 + 2 * T3_INDEX_MISS_MS + 1).get("new")).toMatchObject({ title: "New chat" });
    expect(t3SessionInfo(root, both, t0 + T3_INDEX_MISS_MS + T3_INDEX_MS).get("new")).toMatchObject({ title: "Renamed" });
    db.close();
  });

  it("in a folder shared with its subagent chats, links the main chat unless an active delegated task of the same agent could be the session", () => {
    const { root, db } = store();
    thread(db, "main", { title: "kwil main", folder: WT, provider: "codex" });
    thread(db, "done-task", { folder: WT, parent: "main" }); origin(db, "done-task", "main", "app_owned"); run(db, "done-task", 1, "completed");
    thread(db, "native", { folder: WT, parent: "main" }); origin(db, "native", "main", "provider_native"); run(db, "native", 1, "running");
    expect(t3SessionInfo(root, [{ key: "s", cwd: WT, agent: "codex" }], 1_000).get("s")).toMatchObject({ id: "main", title: "kwil main" });
    thread(db, "live-task", { folder: WT, parent: "main" }); origin(db, "live-task", "main", "app_owned"); run(db, "live-task", 1, "running");
    expect(t3SessionInfo(root, [{ key: "s", cwd: WT, agent: "codex" }], 1_000 + 60_000).has("s")).toBe(false); // main or the live task: unknown
    db.close();
  });

  it("links neither of two same-agent sessions that claim the same chat", () => {
    const { root, db } = store();
    thread(db, "chat", { folder: WT });
    const info = t3SessionInfo(root, [{ key: "a", cwd: WT, agent: "codex" }, { key: "b", cwd: WT, agent: "codex" }], 1_000);
    expect(info.size).toBe(0);
    db.close();
  });

  it("links the sessions of every provider a chat ran on after T3 switched it, marking which one is current", () => {
    const { root, db } = store();
    thread(db, "chat", { title: "Switched chat", folder: WT, provider: "codex" });
    harness(db, "chat", "claudeAgent"); harness(db, "chat", "codex");
    const info = t3SessionInfo(root, [
      { key: "claude-old", cwd: WT, agent: "claude" }, { key: "codex-new", cwd: WT, agent: "codex" }, { key: "muse", cwd: WT, agent: "muse" },
    ], 1_000);
    expect(info.get("claude-old")).toMatchObject({ title: "Switched chat", harness: "earlier", provider: "codex" });
    expect(info.get("codex-new")).toMatchObject({ title: "Switched chat", harness: "current" });
    expect(info.has("muse")).toBe(false); // never ran this chat
    db.close();
  });

  it("normalizes folder keys", () => {
    expect(t3FolderKey("D:\\AgentData\\x\\")).toBe(t3FolderKey("E:/AgentData/x"));
  });
});

describe("T3 chats on the normal session entries (AB-468)", () => {
  const script = UI_PAGE.split("<script>").pop()!.split("</script>")[0]!;
  function page() {
    const el = (): any => ({ dataset: {}, value: "", checked: false, innerHTML: "", textContent: "", focus: vi.fn(), scrollIntoView: vi.fn(), querySelectorAll: () => [], querySelector: () => null,
      classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn(), contains: () => false }, setAttribute: vi.fn(), parentElement: { addEventListener: vi.fn() }, addEventListener: vi.fn() });
    const document = { hidden: false, title: "", documentElement: { dataset: {} }, getElementById: el, addEventListener: vi.fn(), querySelectorAll: () => [] };
    return new Function("document", "window", "location", "localStorage", "setInterval", "fetch", "Notification", script +
      "\nreturn { sideSession, sessionTitle, sessionMatches, sideGroups, load: s => { state = s; model = buildModel(s); return model; } };")
      (document, { addEventListener: vi.fn() }, { hash: "" }, { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }, () => 0,
        vi.fn(() => new Promise(() => {})), Object.assign(vi.fn(), { permission: "default" }));
  }
  const peer = (t3?: object) => ({ name: "codex-t3-aaaa1111", agent: "codex", cwd: "E:\\AgentData\\game\\t3-aaaa1111", activity: "busy", ...(t3 ? { t3 } : {}) });
  const session = (p: object) => ({ name: (p as { name: string }).name, peer: p, live: true, groups: [], children: [], running: 0 });

  it("shows the T3 chat title with a T3 badge instead of the worktree folder, escaped", () => {
    const ui = page();
    const x = session(peer({ id: "chat", title: "Dungeon <epic>", provider: "codex", model: null, status: "waiting", parentTitle: 'Main "x" <y> $`' }));
    expect(ui.sessionTitle(x)).toBe("Dungeon <epic>");
    const html = ui.sideSession(x);
    expect(html).toContain('<span class="t3-ttl"><span class="ell">Dungeon &lt;epic&gt;</span><span class="chip t3"');
    expect(html).not.toContain(">t3-aaaa1111<");
    expect(html).toContain('<span class="chip t3" title="T3 Code chat · waiting for an answer · subagent of Main &quot;x&quot; &lt;y&gt; $`">T3</span>');
    expect(html).toContain('<span class="t3-ask">waiting for an answer</span>');
    expect(ui.sessionMatches(x, "dungeon")).toBe(true);
  });

  it("shows one entry per T3 chat: a still-connected earlier provider session folds into the current one", () => {
    const ui = page();
    const t3 = { id: "chat", title: "Switched chat", provider: "codex", model: null, status: "running", parentTitle: null };
    const m = ui.load({ peers: [
      { name: "claude-old", agent: "claude", cwd: "E:/wt", activity: "idle", startedAt: 1, t3: { ...t3, harness: "earlier" } },
      { name: "codex-new", agent: "codex", cwd: "E:/wt", activity: "busy", startedAt: 2, t3: { ...t3, harness: "current" } },
      { name: "claude-other", agent: "claude", cwd: "E:/Development/repo", activity: "idle", startedAt: 3 },
    ], runs: [], jobs: {}, messages: [] });
    const listed = ui.sideGroups("").flatMap((g: { items: { name: string }[] }) => g.items.map((x) => x.name));
    expect(listed.sort()).toEqual(["claude-other", "codex-new"]);
    expect(m.byName.get("codex-new").folded).toEqual(["claude-old"]);
    expect(m.byName.get("claude-old").foldedInto).toBe("codex-new"); // still reachable by its own page
  });

  it("leaves sessions that are not T3 chats unchanged", () => {
    const ui = page();
    const x = session(peer());
    expect(ui.sessionTitle(x)).toBe("t3-aaaa1111");
    expect(ui.sideSession(x)).not.toContain("chip t3");
  });
});
