import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { claudeChatTitle, codexChatTitle, sessionChatTitle } from "../src/core/session-titles.js";

// AB-474: plain Claude sessions show the AI title Claude Code writes into its transcript.
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
const CWD = "E:/Development/game";
function transcript(lines: object[]) {
  const home = mkdtempSync(join(tmpdir(), "ab-titles-")); homes.push(home);
  const id = "0f9d5c0e-1111-4222-8333-" + String(homes.length).padStart(12, "0");
  const dir = join(home, "projects", CWD.replace(/[^A-Za-z0-9]/g, "-")); mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const paths = { claude: home, codex: join(home, "codex"), opencode: join(home, "opencode") };
  return { file, paths, session: { agent: "claude" as const, cwd: CWD, sessionId: id } };
}
const user = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });

it("returns the newest AI title of a Claude session, and nothing for other agents or untitled sessions", () => {
  const t = transcript([{ type: "ai-title", aiTitle: "First guess", sessionId: "x" }, user("hello"), { type: "ai-title", aiTitle: "T3 integration status", sessionId: "x" }]);
  expect(claudeChatTitle(t.session, t.paths, 1_000)).toBe("T3 integration status");
  expect(claudeChatTitle({ ...t.session, agent: "codex" }, t.paths, 1_000)).toBeNull();
  const untitled = transcript([user("no title yet")]);
  expect(claudeChatTitle(untitled.session, untitled.paths, 1_000)).toBeNull();
});

it("re-reads a changed transcript only after the refresh interval", () => {
  const t = transcript([{ type: "ai-title", aiTitle: "Old title", sessionId: "x" }]);
  expect(claudeChatTitle(t.session, t.paths, 10_000)).toBe("Old title");
  appendFileSync(t.file, JSON.stringify({ type: "ai-title", aiTitle: "New title", sessionId: "x" }) + "\n");
  expect(claudeChatTitle(t.session, t.paths, 11_000)).toBe("Old title"); // within 30 s: cached
  expect(claudeChatTitle(t.session, t.paths, 41_000)).toBe("New title");
});

it("finds a title that long tool output pushed far back, and keeps it when a later tail has none", () => {
  const filler = { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x".repeat(600 * 1024) }] } };
  const t = transcript([{ type: "ai-title", aiTitle: "Title before a long tool run", sessionId: "x" }, filler]);
  expect(claudeChatTitle(t.session, t.paths, 1_000)).toBe("Title before a long tool run");
  appendFileSync(t.file, JSON.stringify(filler) + "\n"); // the tail window now holds no title at all
  expect(claudeChatTitle(t.session, t.paths, 40_000)).toBe("Title before a long tool run");
});

it("finds a transcript that appears later, without looking for it on every poll", () => {
  const t = transcript([{ type: "ai-title", aiTitle: "Late transcript", sessionId: "x" }]);
  const hidden = t.file + ".hidden"; renameSync(t.file, hidden);
  expect(claudeChatTitle(t.session, t.paths, 1_000)).toBeNull();
  renameSync(hidden, t.file);
  expect(claudeChatTitle(t.session, t.paths, 40_000)).toBeNull(); // a missing transcript is looked up again only after 5 min
  expect(claudeChatTitle(t.session, t.paths, 1_000 + 5 * 60_000)).toBe("Late transcript");
});

// AB-474 part 2: Codex sessions show the chat's name from Codex's state database, else the first line of the first prompt.
function codexState(rows: { id: string; name: string | null; title: string }[]) {
  const home = mkdtempSync(join(tmpdir(), "ab-titles-codex-")); homes.push(home);
  const codex = join(home, "codex"); mkdirSync(codex);
  writeFileSync(join(codex, "state_4.sqlite"), ""); // an older database Codex no longer writes
  const db = new DatabaseSync(join(codex, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT NOT NULL)");
  for (const r of rows) db.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(r.id, r.name, r.title);
  const paths = { claude: join(home, "claude"), codex, opencode: join(home, "opencode") };
  return { db, paths, session: (sessionId: string) => ({ agent: "codex" as const, cwd: CWD, sessionId }) };
}

it("titles a Codex session by its name, else the first line of its first prompt, never by injected context", () => {
  const s = codexState([
    { id: "named", name: "Dungeon balance pass", title: "rebalance the dungeon loot tables" },
    { id: "prompt", name: null, title: "\n  do we detect   t3 code main chats?\nmore detail on the second line" },
    { id: "long", name: "", title: "x".repeat(500) },
    { id: "injected", name: null, title: "<environment_context>\n  <cwd>E:/x</cwd>" },
  ]);
  try {
    expect(sessionChatTitle(s.session("named"), s.paths, 1_000)).toBe("Dungeon balance pass");
    expect(sessionChatTitle(s.session("prompt"), s.paths, 1_000)).toBe("do we detect t3 code main chats?");
    expect(sessionChatTitle(s.session("long"), s.paths, 1_000)).toBe("x".repeat(159) + "…");
    expect(sessionChatTitle(s.session("injected"), s.paths, 1_000)).toBeNull();
    expect(sessionChatTitle(s.session("unknown"), s.paths, 1_000)).toBeNull();
    expect(codexChatTitle({ ...s.session("named"), agent: "claude" }, s.paths, 1_000)).toBeNull();
  } finally { s.db.close(); }
});

it("picks up a renamed Codex chat after the refresh interval, and keeps the last title while the database is unreadable", () => {
  const s = codexState([{ id: "chat", name: null, title: "first prompt" }]);
  expect(codexChatTitle(s.session("chat"), s.paths, 1_000)).toBe("first prompt");
  s.db.prepare("UPDATE threads SET name = 'Renamed chat' WHERE id = 'chat'").run();
  expect(codexChatTitle(s.session("chat"), s.paths, 2_000)).toBe("first prompt"); // within 30 s: cached
  expect(codexChatTitle(s.session("chat"), s.paths, 32_000)).toBe("Renamed chat");
  s.db.exec("DROP TABLE threads"); s.db.close();
  expect(codexChatTitle(s.session("chat"), s.paths, 63_000)).toBe("Renamed chat");
});
