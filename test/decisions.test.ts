import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSessionStartHook } from "../src/cli/session-start-hook.js";
import { startUi } from "../src/cli/ui.js";
import { BridgeClient } from "../src/core/client.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { DECISION_MESSAGE_HOP, formatDecisionSummary, normalizeProject } from "../src/core/decisions.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore, SQLITE_STORE_VERSION } from "../src/core/store.js";
import { buildHookResponse } from "../src/mcp/hooks.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

const EARLIER_SCHEMA = `CREATE TABLE messages (
  id TEXT NOT NULL, recipient TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL,
  from_agent TEXT NOT NULL, to_target TEXT NOT NULL, conversation_id TEXT NOT NULL, reply_to TEXT,
  hop INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
  PRIMARY KEY (id, recipient));`;
const EARLIER_ARCHIVE = "CREATE TABLE archived_messages AS SELECT *, '' AS archive_reason, 0 AS archived_at FROM messages WHERE 0;";
const AUTHOR = { id: "author", name: "claude-owner", agent: "claude" as const };
let env: TestEnv;

beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.unstubAllEnvs(); await env.cleanup(); });

describe("decision schema migrations", () => {
  it.each([0, 1, 2])("backs up schema %i before adding decisions and retains all old data", async (version) => {
    const old = new DatabaseSync(env.db);
    old.exec(`${EARLIER_SCHEMA} PRAGMA user_version = ${version}`);
    old.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("legacy", "codex-app", "a", "claude-app", "claude", "codex-app", "c", null, 0, "old mail", 1, 2);
    if (version === 2) {
      old.exec(EARLIER_ARCHIVE);
      old.exec("INSERT INTO archived_messages SELECT *, 'expired', 3 FROM messages");
      old.exec("INSERT INTO archived_messages SELECT * FROM archived_messages");
      old.exec("UPDATE archived_messages SET id = 'legacy-archive' WHERE rowid = (SELECT MAX(rowid) FROM archived_messages)");
    }
    old.exec("PRAGMA journal_mode = WAL");
    old.exec("UPDATE messages SET body = 'committed WAL mail'");
    const store = new MessageStore(env.db, nullLogger);
    try {
      expect(store.byId("legacy")).toMatchObject({ body: "committed WAL mail", readAt: 2 });
      store.decisions.record({ topic: "Build", text: "Keep backups", scope: "all" }, AUTHOR, 10);
      expect(store.decisions.list()).toHaveLength(1);
      if (version === 2) {
        const retained = old.prepare("SELECT * FROM archived_messages ORDER BY id").all();
        expect(store.byId("legacy-archive")).toMatchObject({ body: "old mail", readAt: 2 });
        const archive = new DatabaseSync(join(env.home, "archive.db"), { readOnly: true });
        try {
          expect(archive.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n).toBe(0);
          vi.stubEnv("AGENT_BRIDGE_AUTO_BACKUP", "0");
          store.startBackups(); // Listener-ready maintenance is explicitly started, never constructor work.
          expect(old.prepare("SELECT * FROM archived_messages ORDER BY id").all()).toEqual(retained);
          await until(() => Number(old.prepare("SELECT COUNT(*) AS n FROM archived_messages").get()!.n) === 0);
          expect(archive.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(retained);
          expect(store.byId("legacy-archive")).toMatchObject({ body: "old mail", readAt: 2 });
          expect(store.byId("legacy")).toMatchObject({ body: "committed WAL mail", readAt: 2 });
        } finally { archive.close(); }
      }
    } finally { store.close(); old.close(); }
    const backups = readdirSync(env.home).filter((f) => f.startsWith("bridge.db.backup-"));
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(join(env.home, backups[0]!), { readOnly: true });
    try {
      expect(backup.prepare("PRAGMA user_version").get()!.user_version).toBe(version);
      expect(backup.prepare("SELECT body FROM messages").get()!.body).toBe("committed WAL mail");
      expect(backup.prepare("SELECT name FROM sqlite_master WHERE name = 'decisions'").get()).toBeUndefined();
      if (version === 2) expect(backup.prepare("SELECT body FROM archived_messages").get()!.body).toBe("old mail");
    } finally { backup.close(); }
    const check = new DatabaseSync(env.db, { readOnly: true });
    try {
      expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(SQLITE_STORE_VERSION);
      if (version === 2) expect(check.prepare("SELECT count(*) AS n FROM archived_messages").get()!.n).toBe(0);
    } finally { check.close(); }
    if (version === 2) {
      const archive = new DatabaseSync(join(env.home, "archive.db"), { readOnly: true });
      try { expect(archive.prepare("SELECT body FROM messages").get()!.body).toBe("old mail"); }
      finally { archive.close(); }
    }
    const reopened = new MessageStore(env.db, nullLogger);
    try { expect(reopened.decisions.list()).toHaveLength(1); } finally { reopened.close(); }
    expect(readdirSync(env.home).filter((f) => f.startsWith("bridge.db.backup-"))).toEqual(backups);
  });

  it("rolls back a failed v3 migration without losing earlier tables or their backup", () => {
    const old = new DatabaseSync(env.db);
    old.exec(`${EARLIER_SCHEMA} ${EARLIER_ARCHIVE} CREATE TABLE decisions (body TEXT); INSERT INTO decisions VALUES ('keep me'); PRAGMA user_version = 2;`);
    old.close();
    expect(() => new MessageStore(env.db, nullLogger)).toThrow();
    const check = new DatabaseSync(env.db, { readOnly: true });
    try {
      expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
      expect(check.prepare("SELECT body FROM decisions").get()!.body).toBe("keep me");
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'decision_deliveries'").get()).toBeUndefined();
    } finally { check.close(); }
    expect(readdirSync(env.home).filter((f) => f.startsWith("bridge.db.backup-"))).toHaveLength(1);
  });
});

describe("shared decision broker", () => {
  it("supersedes a case-insensitive topic across scopes while preserving provenance and history", async () => {
    const owner = env.node("claude-owner");
    const peer = env.node("codex-peer", "codex");
    await owner.start(); await peer.start();
    const source = (await owner.send({ to: peer.name, body: "Owner chose backups" })).messages[0]!;
    const first = await owner.decide({ topic: " Backups ", text: "Daily", scope: "all", sourceMessageId: source.id });
    const second = await peer.decide({ topic: "BACKUPS", text: "Before migrations", scope: { project: env.home } });
    expect(second.decision).toMatchObject({ topic: "backups", supersedes: first.decision.id, current: true, author: { name: peer.name } });
    expect(await peer.decisions()).toEqual([second.decision]);
    const history = await owner.decisions({ history: true, query: "backup" });
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({ current: false, text: "Daily", sourceMessageId: source.id, author: { name: owner.name } });
    expect(await peer.decisions({ query: "MIGRATIONS" })).toEqual([second.decision]);
    expect(await peer.decisions({ query: "missing" })).toEqual([]);
    await expect(owner.decide({ topic: "bad", text: "bad source", sourceMessageId: "missing" })).rejects.toThrow("Source message does not exist");
    await expect(owner.decide({ topic: "  ", text: "bad" })).rejects.toThrow("Invalid decision");
  });

  it("filters and delivers all, exact project folders, session names and host session ids", async () => {
    const owner = env.node("claude-owner");
    const peer = env.node("codex-peer", "codex");
    const elsewhere = env.node("opencode-elsewhere", "opencode");
    await owner.start(); await peer.start(); await elsewhere.start();
    await peer.setSessionId("host-session");
    await elsewhere.relocate(join(env.home, "other-project"));
    const global = await owner.decide({ topic: "global", text: "All sessions", scope: "all" });
    const project = await owner.decide({ topic: "project", text: "This folder" });
    const selected = await owner.decide({ topic: "session", text: "Selected", scope: { sessions: [peer.name, "host-session", peer.name] } });
    const host = await owner.decide({ topic: "host", text: "By host id", scope: { sessions: ["host-session"] } });
    expect(global.deliveredTo.sort()).toEqual([owner.name, peer.name, elsewhere.name].sort());
    expect(project.deliveredTo.sort()).toEqual([owner.name, peer.name].sort());
    expect(project.decision.scope).toEqual({ project: normalizeProject(env.home) });
    expect(selected.deliveredTo).toEqual([peer.name]);
    expect(host.deliveredTo).toEqual([peer.name]);
    expect((await peer.decisions()).map((d) => d.topic)).toEqual(["host", "session", "project", "global"]);
    expect((await elsewhere.decisions()).map((d) => d.topic)).toEqual(["global"]);
    expect((await peer.decisions({ scope: "all" })).map((d) => d.topic)).toEqual(["global"]);
    expect((await owner.decisions({ scope: { sessions: [peer.name] } })).map((d) => d.topic)).toEqual(["session", "global"]);
    await until(() => peer.unread().length === 4);
    expect(peer.unread().every((m) => m.hop === DECISION_MESSAGE_HOP)).toBe(true);
    expect(peer.lastSentAt).toBe(0);
  });

  it("keeps one durable notification per revision and session through identity discovery and reload", async () => {
    const owner = env.node("claude-owner");
    const first = env.node("codex-peer", "codex");
    await owner.start(); await first.start();
    await owner.decide({ topic: "render", text: "Keep detail", scope: "all" });
    await until(() => first.unread().length === 1);
    await first.setSessionId("stable-session");
    first.markRead(first.unread().map((m) => m.id));
    await first.stop();
    const reload = env.node("codex-peer", "codex");
    await reload.start(); await reload.setSessionId("stable-session");
    await reload.relocate(join(env.home, "elsewhere"));
    expect(reload.unread()).toEqual([]);
    const fresh = env.node("codex-fresh", "codex");
    await fresh.start(); await fresh.setSessionId("fresh-session");
    await until(() => fresh.unread().length === 1);
    const update = await owner.decide({ topic: "render", text: "Keep near detail", scope: "all" });
    await until(() => reload.unread().length === 1 && fresh.unread().length === 2);
    expect(reload.unread()[0]!.conversationId).toBe(`decision-${update.decision.id}`);
    const db = new DatabaseSync(env.db, { readOnly: true });
    try { expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE recipient = ?").get(reload.name)!.n).toBe(2); } finally { db.close(); }
  });

  it("retains current revisions and delivery receipts through a broker restart", async () => {
    const owner = env.node("claude-owner");
    await owner.start(); await owner.setSessionId("owner-session");
    const saved = await owner.decide({ topic: "restart", text: "Durable", scope: "all" });
    await until(() => owner.unread().length === 1);
    owner.markRead(owner.unread().map((m) => m.id));
    await owner.decisions(); // Round trip after the acknowledgement before stopping the broker.
    await owner.stop();
    const restart = env.node("claude-owner");
    await restart.start(); await restart.setSessionId("owner-session");
    expect(await restart.decisions()).toEqual([saved.decision]);
    expect(restart.unread()).toEqual([]);
  });

  it("requires broker authentication for decisions and recording", async () => {
    const owner = env.node("claude-owner"); await owner.start();
    const client = await BridgeClient.connect(env.pipe, nullLogger);
    try {
      await expect(client.request("decisions", {})).rejects.toThrow("authenticate first");
      await expect(client.request("decide", { topic: "x", text: "y", scope: "all" })).rejects.toThrow("authenticate first");
    } finally { client.close(); }
  });

  it("inserts the notification and receipt atomically and retries safely after insertion failure", () => {
    const store = new MessageStore(env.db, nullLogger);
    const db = new DatabaseSync(env.db);
    try {
      const decision = store.decisions.record({ topic: "atomic", text: "Preserve data", scope: "all" }, AUTHOR, 1);
      const message = { id: "notify", from: AUTHOR, to: "peer", recipient: "peer", conversationId: `decision-${decision.id}`, replyTo: null, hop: DECISION_MESSAGE_HOP, body: decision.text, createdAt: 2, readAt: null };
      db.exec("CREATE TRIGGER fail_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'cannot insert'); END;");
      expect(() => store.decisions.enqueue(decision, "session", message, () => store.insert(message))).toThrow("cannot insert");
      expect(db.prepare("SELECT COUNT(*) AS n FROM decision_deliveries").get()!.n).toBe(0);
      expect(store.decisions.list()).toHaveLength(1);
      db.exec("DROP TRIGGER fail_message");
      expect(store.decisions.enqueue(decision, "session", message, () => store.insert(message))).toBe(true);
      expect(store.decisions.enqueue(decision, "session", message, () => store.insert(message))).toBe(false);
      expect(store.unread("peer", 10)).toHaveLength(1);
    } finally { db.close(); store.close(); }
  });
});

describe("decision summaries and dashboard", () => {
  it("adds brief current project decisions to both SessionStart paths and never blocks Stop", async () => {
    const owner = env.node("claude-owner"); const peer = env.node("codex-peer", "codex", true);
    await owner.start(); await peer.start();
    await owner.decide({ topic: "quality", text: "Preserve near detail", scope: { project: env.home } });
    await owner.decide({ topic: "hidden", text: "Other folder only", scope: { project: join(env.home, "other") } });
    const context = { agent: "codex" as const, cfg: DEFAULT_CONFIG, node: peer, log: nullLogger, home: env.home, cwd: () => env.home, channelActive: () => false };
    const startup = await buildHookResponse(context, { event: "SessionStart", sessionId: "peer-session", stopHookActive: false }) as any;
    expect(startup.hookSpecificOutput.additionalContext).toContain("quality: Preserve near detail");
    expect(startup.hookSpecificOutput.additionalContext).not.toContain("hidden:");
    expect(await buildHookResponse(context, { event: "Stop", sessionId: "peer-session", stopHookActive: false })).toEqual({});
    vi.stubEnv("AGENT_BRIDGE_HOME", env.home);
    vi.stubEnv("AGENT_BRIDGE_PIPE", env.pipe);
    let stdout = "";
    await runSessionStartHook(nullLogger, (s) => { stdout += s; }, async () => JSON.stringify({ cwd: env.home }));
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toContain("quality: Preserve near detail");
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).not.toContain("hidden:");
    expect(formatDecisionSummary(Array.from({ length: 7 }, (_, i) => ({ ...startup, topic: `topic${i}`, text: "x".repeat(300) })))).not.toContain("topic5:");
  });

  it("authenticates searchable current and exact-topic history endpoints without dashboard writes", async () => {
    const owner = env.node("claude-owner"); await owner.start();
    await owner.decide({ topic: "Camera / input", text: "Drag", scope: "all" });
    await owner.decide({ topic: "Camera / input", text: "Hold to look", scope: "all" });
    await owner.decide({ topic: "other", text: "Other folder", scope: { project: join(env.home, "other") } });
    const ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
    try {
      const first = await fetch(ui.url, { redirect: "manual" });
      const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
      const base = ui.url.replace(/\/\?t=.*$/, "");
      expect((await fetch(`${base}/api/decisions`)).status).toBe(403);
      expect((await fetch(`${base}/api/decisions/${encodeURIComponent("camera / input")}/history`)).status).toBe(403);
      const request = (path: string) => fetch(`${base}${path}`, { headers: { cookie } });
      const current = await (await request("/api/decisions?q=LOOK&scope=all")).json();
      expect(current.decisions).toHaveLength(1);
      expect(current.decisions[0]).toMatchObject({ text: "Hold to look", current: true });
      const history = await (await request(`/api/decisions/${encodeURIComponent("camera / input")}/history`)).json();
      expect(history.topic).toBe("camera / input");
      expect(history.decisions.map((d: any) => d.current)).toEqual([true, false]);
      const scoped = await (await request(`/api/decisions?scope=${encodeURIComponent(JSON.stringify({ project: env.home }))}`)).json();
      expect(scoped.decisions).toHaveLength(1);
      expect((await request("/api/decisions?scope=bad")).status).toBe(400);
      expect((await (await request("/api/decisions/missing/history")).json()).decisions).toEqual([]);
      await owner.stop();
      expect((await (await request("/api/decisions")).json()).decisions).toHaveLength(2);
    } finally { await ui.close(); }
  });

  it("reads persisted project decisions in the command hook before any broker is running", async () => {
    const store = new MessageStore(env.db, nullLogger);
    store.decisions.record({ topic: "offline", text: "Keep the owner's choice", scope: { project: env.home } }, AUTHOR, 1);
    store.close();
    vi.stubEnv("AGENT_BRIDGE_HOME", env.home);
    vi.stubEnv("AGENT_BRIDGE_PIPE", env.pipe);
    let stdout = "";
    await runSessionStartHook(nullLogger, (s) => { stdout += s; }, async () => JSON.stringify({ cwd: env.home }));
    const context = JSON.parse(stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain("No other agents are online");
    expect(context).toContain("offline: Keep the owner's choice");
    expect(readdirSync(env.home).filter((f) => f.startsWith("bridge.db.backup-"))).toEqual([]);
  });
});
