import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationIngestor } from "../src/core/conversations.js";
import { HistoryIndex } from "../src/core/history.js";
import { historyDbPath, migrateHistoryStore } from "../src/core/history-store.js";
import { nullLogger } from "../src/core/logger.js";
import { MessageStore } from "../src/core/store.js";
import { installTranscriptFixtures } from "./transcript-fixtures.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
const closes: (() => void)[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) close(); await env.cleanup(); });

const claudeLine = (text: string, session: string) => JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: text }, uuid: `u-${text}`, timestamp: "2026-10-09T09:00:00.000Z", sessionId: session, version: "2.1.283" });
const codexLines = (text: string, session: string) => [
  JSON.stringify({ timestamp: "2026-10-09T09:00:00.000Z", type: "session_meta", payload: { id: session, timestamp: "2026-10-09T09:00:00.000Z", source: "vscode" } }),
  JSON.stringify({ timestamp: "2026-10-09T09:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }),
].join("\n");
const antigravityLine = (text: string, step: number) => JSON.stringify({ type: "USER_INPUT", content: text, step_index: step, created_at: "2026-10-09T09:00:00.000Z" });

it("keeps importing new sessions of all four CLIs and appended lines after the first import", async () => {
  const fixtures = installTranscriptFixtures(env.home);
  const paths = { ...fixtures.paths, antigravity: join(env.home, "antigravity") };
  const firstAntigravity = join(paths.antigravity, "brain", "anti-one", ".system_generated", "logs", "transcript.jsonl");
  mkdirSync(dirname(firstAntigravity), { recursive: true });
  writeFileSync(firstAntigravity, antigravityLine("antigravity original walrus", 0) + "\n");
  const store = new MessageStore(env.db, nullLogger); closes.push(() => store.close());
  await migrateHistoryStore(env.db, store.history.storageDatabase);
  const db = new DatabaseSync(historyDbPath(env.db)); closes.push(() => db.close());
  const source = new DatabaseSync(env.db, { readOnly: true }); closes.push(() => source.close());
  const index = new HistoryIndex(db, env.home, paths, source), ingest = new ConversationIngestor(db, env.home, paths, source);
  closes.push(() => { index.close(); ingest.close(); });
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const drain = () => {
    for (let i = 0; i < 400; i++) {
      const a = index.tick(true), b = ingest.tick();
      if (!a.work && !b && !a.discovering && !ingest.discovering) return;
      now += 50;
    }
  };
  drain();
  const found = (word: string) => index.search({ query: word, limit: 5 }).hits.length > 0;
  expect(found("walrus")).toBe(true);

  // After the first import: a new session per CLI and an appended Antigravity line.
  const claude = join(paths.claude, "projects", "project-example", "session-new.jsonl");
  writeFileSync(claude, claudeLine("claude newcomer zebra", "session-new") + "\n");
  const codexSession = "22222222-2222-4222-8222-222222222222";
  const codex = join(paths.codex, "sessions", "2026", "10", "09", `rollout-2026-10-09T09-00-00-${codexSession}.jsonl`);
  mkdirSync(dirname(codex), { recursive: true });
  writeFileSync(codex, codexLines("codex newcomer giraffe", codexSession) + "\n");
  const opencode = new DatabaseSync(fixtures.sqlite);
  opencode.prepare("INSERT INTO session VALUES('ses_new',NULL,'New work',1791500000000,1791500000010)").run();
  opencode.prepare("INSERT INTO message VALUES('msg_new','ses_new',1791500000000,1791500000000,?)").run(JSON.stringify({ role: "user", time: { created: 1791500000000 }, agent: "general" }));
  opencode.prepare("INSERT INTO part VALUES('prt_new','msg_new','ses_new',1791500000000,1791500000000,?)").run(JSON.stringify({ type: "text", text: "opencode newcomer okapi" }));
  opencode.close();
  const secondAntigravity = join(paths.antigravity, "brain", "anti-two", ".system_generated", "logs", "transcript.jsonl");
  mkdirSync(dirname(secondAntigravity), { recursive: true });
  writeFileSync(secondAntigravity, antigravityLine("antigravity newcomer narwhal", 0) + "\n");
  appendFileSync(firstAntigravity, antigravityLine("antigravity appended pelican", 1) + "\n");
  now += 10 * 60_000; // past the periodic rescan
  drain();
  for (const word of ["zebra", "giraffe", "okapi", "narwhal", "pelican"]) expect(found(word), word).toBe(true);
});
