import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { T3_INDEX_MISS_MS, T3_INDEX_MS, t3FolderKey, t3LocalSessions, t3SessionInfo } from "../src/core/t3-sessions.js";
import { UI_PAGE } from "../src/cli/ui-page.js";

// AB-468: the installed T3 store's tables this feature reads (unused columns kept so the reader
// cannot depend on a trimmed shape), plus an auth table it must never need.
const SCHEMA = `
CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,title TEXT NOT NULL,workspace_root TEXT NOT NULL,
 scripts_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT);
INSERT INTO projection_projects VALUES('p1','game','E:/Development/game','[]','2026-10-31T12:00:00Z','2026-10-31T12:00:00Z',NULL);
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
/** `provider` is T3's driver kind (default_provider); `instance` its provider instance name (defaults to the driver). */
function thread(db: DatabaseSync, id: string, o: { title?: string; provider?: string; instance?: string; folder?: string | null; parent?: string; deleted?: boolean; model?: string; pad?: number } = {}) {
  db.prepare(`INSERT INTO orchestration_v2_projection_threads VALUES(?,'p1',?,?,'full-access','default',NULL,?,?,NULL,?,?,?)`).run(
    id, o.title ?? id, o.provider ?? "codex", at, at, o.deleted ? at : null,
    JSON.stringify({ id, worktreePath: o.folder ?? null, lineage: { parentThreadId: o.parent ?? null, relationshipToParent: o.parent ? "subagent" : null },
      modelSelection: o.model ? { model: o.model } : null, pad: "x".repeat(o.pad ?? 0) }), o.instance ?? o.provider ?? "codex");
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
      // Separators and a trailing separator do not matter.
      { key: "codex-t3-aaaa1111", cwd: "E:\\AgentData\\game\\t3-aaaa1111\\", agent: "codex" },
      { key: "claude-asks", cwd: "E:/AgentData/game/t3-bbbb2222", agent: "claude" },
    ], 1_000);
    expect(info.get("codex-t3-aaaa1111")).toEqual({ id: "chat", title: "Dungeon epic round 2", provider: "codex", model: "gpt-6.1-sol", projectRoot: "E:/Development/game", status: "done", parentTitle: "Game main thread", harness: "current" });
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

  it("matches only this PC's CLI sessions: a Bridge job in the chat's folder neither links nor unlinks the chat", () => {
    const { root, db } = store();
    thread(db, "chat", { folder: WT, title: "Chat with a job" });
    const peers = [
      { name: "codex-t3-aaaa1111", agent: "codex", cwd: WT },
      { name: "codex-job-1234", agent: "codex", cwd: WT, jobAgent: "codex" },
      { name: "kid", agent: "codex", cwd: WT, subagent: true },
      { name: "pc2/codex-x", agent: "codex", cwd: WT },
    ];
    const local = t3LocalSessions(peers);
    expect(local.map((p) => p.name)).toEqual(["codex-t3-aaaa1111"]);
    expect(t3SessionInfo(root, local.map((p) => ({ key: p.name, cwd: p.cwd, agent: p.agent })), 1_000).get("codex-t3-aaaa1111")).toMatchObject({ title: "Chat with a job" });
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

  it("normalizes folder keys and resolves aliases of the same physical folder, without assuming any drive layout", () => {
    expect(t3FolderKey("E:\\AgentData\\x\\")).toBe(t3FolderKey("E:/AgentData/x"));
    // Folder names are case-insensitive only on Windows.
    expect(t3FolderKey("E:/agentdata/X") === t3FolderKey("E:/AgentData/x")).toBe(process.platform === "win32");
    // A link (junction on Windows) to a folder is that folder.
    const base = mkdtempSync(join(tmpdir(), "ab-t3-alias-")); roots.push({ root: base, db: new DatabaseSync(":memory:") });
    const real = join(base, "real"), link = join(base, "link"); mkdirSync(real);
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    expect(t3FolderKey(link)).toBe(t3FolderKey(real));
    // Different physical folders stay different.
    const other = join(base, "other"); mkdirSync(other);
    expect(t3FolderKey(other)).not.toBe(t3FolderKey(real));
  });

  it("links a provider-switched chat's new session within the short window, not after the full rebuild", () => {
    const { root, db } = store();
    thread(db, "chat", { title: "Switching chat", folder: WT, provider: "claudeAgent" });
    const t0 = 70_000_000;
    expect(t3SessionInfo(root, [{ key: "claude", cwd: WT, agent: "claude" }], t0).get("claude")).toMatchObject({ harness: "current" });
    // T3 switches the chat to Codex: the provider changes and a Codex provider thread appears.
    db.prepare("UPDATE orchestration_v2_projection_threads SET default_provider='codex', provider_instance_id='codex' WHERE thread_id='chat'").run();
    harness(db, "chat", "claudeAgent"); harness(db, "chat", "codex");
    const both = [{ key: "claude", cwd: WT, agent: "claude" }, { key: "codex", cwd: WT, agent: "codex" }];
    const info = t3SessionInfo(root, both, t0 + T3_INDEX_MISS_MS);
    expect(info.get("codex")).toMatchObject({ title: "Switching chat", harness: "current" });
    expect(info.get("claude")).toMatchObject({ harness: "earlier" });
  });

  it("links by T3's driver kind: a custom instance name still links, an unknown driver never matches any agent", () => {
    const { root, db } = store();
    thread(db, "custom", { folder: WT, provider: "claudeAgent", instance: "claude-work", title: "Custom instance" });
    thread(db, "unknown", { folder: "E:/AgentData/game/t3-grok", provider: "grok", title: "Unknown driver" });
    const info = t3SessionInfo(root, [
      { key: "claude", cwd: WT, agent: "claude" }, { key: "codex", cwd: WT, agent: "codex" },
      { key: "u-codex", cwd: "E:/AgentData/game/t3-grok", agent: "codex" }, { key: "u-claude", cwd: "E:/AgentData/game/t3-grok", agent: "claude" },
    ], 1_000);
    expect(info.get("claude")).toMatchObject({ title: "Custom instance", provider: "claude-work", harness: "current" });
    expect([...info.keys()]).toEqual(["claude"]);
  });

  it("never lets a child own its folder on missing parent information", () => {
    for (const how of ["provider_native", "app_owned"] as const) {
      const { root, db } = store();
      thread(db, "big-parent", { folder: WT, pad: 70_000 }); // unreadable here: payload over the size limit
      thread(db, "child", { folder: WT, parent: "big-parent" }); origin(db, "child", "big-parent", how); run(db, "child", 1, "completed");
      expect(t3SessionInfo(root, [{ key: "s", cwd: WT, agent: "codex" }], 1_000).size, how).toBe(0);
    }
  });

  it("retries a store that cannot be indexed after the short window, not on every poll", () => {
    const { root, db } = store();
    thread(db, "chat", { folder: WT, title: "Chat" });
    db.exec("DROP TABLE orchestration_v2_projection_subagents");
    const s = [{ key: "s", cwd: WT, agent: "codex" }], t0 = 50_000_000;
    expect(t3SessionInfo(root, s, t0).size).toBe(0);
    db.exec(SCHEMA.split(";").find((q) => q.includes("CREATE TABLE orchestration_v2_projection_subagents"))!);
    expect(t3SessionInfo(root, s, t0 + 1_000).size).toBe(0); // the failed attempt is remembered
    expect(t3SessionInfo(root, s, t0 + T3_INDEX_MISS_MS).get("s")).toMatchObject({ title: "Chat" });
  });
});

describe("T3 chats on the normal session entries (AB-468)", () => {
  const script = UI_PAGE.split("<script>").pop()!.split("</script>")[0]!;
  function page() {
    const el = (): any => ({ dataset: {}, value: "", checked: false, innerHTML: "", textContent: "", focus: vi.fn(), scrollIntoView: vi.fn(), querySelectorAll: () => [], querySelector: () => null,
      classList: { toggle: vi.fn(), add: vi.fn(), remove: vi.fn(), contains: () => false }, setAttribute: vi.fn(), parentElement: { addEventListener: vi.fn() }, addEventListener: vi.fn() });
    const document = { hidden: false, title: "", documentElement: { dataset: {} }, getElementById: el, addEventListener: vi.fn(), querySelectorAll: () => [] };
    return new Function("document", "window", "location", "localStorage", "setInterval", "fetch", "Notification", script +
      "\nreturn { sideSession, sideMember, sessionTitle, sessionMatches, sideGroups, load: s => { state = s; model = buildModel(s); return model; } };")
      (document, { addEventListener: vi.fn() }, { hash: "" }, { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }, () => 0,
        vi.fn(() => new Promise(() => {})), Object.assign(vi.fn(), { permission: "default" }));
  }
  const peer = (t3?: object) => ({ name: "codex-t3-aaaa1111", agent: "codex", cwd: "E:\\AgentData\\game\\t3-aaaa1111", activity: "busy", ...(t3 ? { t3 } : {}) });
  const session = (p: object) => ({ name: (p as { name: string }).name, peer: p, live: true, groups: [], children: [], running: 0 });

  it("keeps the project folder as the title (the T3 project's folder, not the worktree name) and puts the chat title on the second line, escaped", () => {
    const ui = page();
    const x = session(peer({ id: "chat", title: "Dungeon <epic>", provider: "codex", model: null, projectRoot: "E:\\Development\\animal-catch-game", status: "waiting", parentTitle: 'Main "x" <y> $`' }));
    expect(ui.sessionTitle(x)).toBe("animal-catch-game");
    const html = ui.sideSession(x);
    expect(html).toContain('<span class="ttl"><span class="ell">animal-catch-game</span><span class="chip harness codex" title="Runs on Codex">Codex</span><span class="chip t3"');
    expect(html).toContain('<small class="ell">Dungeon &lt;epic&gt; · busy');
    expect(html).not.toContain(">t3-aaaa1111<");
    expect(html).toContain('<span class="chip t3" title="T3 Code chat · waiting for an answer · subagent of Main &quot;x&quot; &lt;y&gt; $`">T3</span>');
    expect(html).toContain('<span class="t3-ask">waiting for an answer</span>');
    expect(ui.sessionMatches(x, "dungeon")).toBe(true);
  });

  const t3 = { id: "chat", title: "Switched chat", provider: "codex", model: null, projectRoot: null, status: "running", parentTitle: null };
  const listed = (ui: any) => ui.sideGroups("").flatMap((g: { items: { name: string }[] }) => g.items.map((x) => x.name)).sort();

  it("shows one entry per T3 chat: an earlier provider's session folds into the current one with its subagents", () => {
    const ui = page();
    const m = ui.load({ peers: [
      // The earlier provider's session is the newer one here: the current provider's still wins.
      { name: "claude-old", agent: "claude", cwd: "E:/wt", activity: "idle", startedAt: 9, t3: { ...t3, harness: "earlier" } },
      { name: "codex-new", agent: "codex", cwd: "E:/wt", activity: "busy", startedAt: 2, t3: { ...t3, harness: "current" } },
      { name: "claude-other", agent: "claude", cwd: "E:/Development/repo", activity: "idle", startedAt: 3 },
      { name: "kid", agent: "codex", cwd: "E:/AgentData/worktrees/x", activity: "busy", startedAt: 4, subagent: true, parent: "claude-old" },
    ], runs: [{ name: "r1", job: "codex-job-aa11", by: "claude-old", agent: "codex", status: "running", startedAt: 5, updatedAt: 6, task: "t" }], jobs: {}, messages: [] });
    expect(listed(ui)).toEqual(["claude-other", "codex-new"]);
    const cur = m.byName.get("codex-new");
    expect(cur.folded).toEqual(["claude-old"]);
    expect(cur.groups.map((g: { key: string }) => g.key)).toEqual(["codex-job-aa11"]); // the folded session's job stays visible
    expect(cur.children.map((c: { name: string }) => c.name)).toEqual(["kid"]);
    expect(cur.running).toBe(1);
    expect(m.byName.get("claude-old").foldedInto).toBe("codex-new"); // still reachable by its own page
  });

  it("folds sessions of earlier providers into the newest one while the current provider's session is not connected", () => {
    const ui = page();
    ui.load({ peers: [
      { name: "claude-a", agent: "claude", cwd: "E:/wt", activity: "idle", startedAt: 1, t3: { ...t3, harness: "earlier" } },
      { name: "muse-b", agent: "muse", cwd: "E:/wt", activity: "idle", startedAt: 2, t3: { ...t3, harness: "earlier" } },
    ], runs: [], jobs: {}, messages: [] });
    expect(listed(ui)).toEqual(["muse-b"]);
  });

  it("shows the T3 chat on grouped project rows too", () => {
    const ui = page();
    const html = ui.sideMember(session({ ...peer({ ...t3, harness: "current", title: "Grouped <chat>" }), projectGroup: "g", projectMain: true }));
    expect(html).toContain("Grouped &lt;chat&gt; · busy");
    expect(html).toContain('class="chip t3"');
  });

  it("gives every session its harness badge; sessions that are not T3 chats keep their folder title and no T3 badge", () => {
    const ui = page();
    const x = session(peer());
    expect(ui.sessionTitle(x)).toBe("t3-aaaa1111");
    const html = ui.sideSession(x);
    expect(html).toContain('<span class="ttl"><span class="ell">t3-aaaa1111</span><span class="chip harness codex" title="Runs on Codex">Codex</span></span>');
    expect(html).not.toContain("chip t3");
    expect(ui.sideSession(session({ ...peer(), agent: "claude" }))).toContain('<span class="chip harness claude" title="Runs on Claude">Claude</span>');
    // Unknown agent kinds get no badge (and never reach a class name).
    expect(ui.sideSession(session({ ...peer(), agent: 'x" onclick="y' }))).not.toContain("chip harness");
  });
});
