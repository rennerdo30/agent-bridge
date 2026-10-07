import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { HistoryIndex, readHistory } from "../src/core/history.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv } from "./helpers.js";
import { ConversationIngestor, readConversation } from "../src/core/conversations.js";

describe("Antigravity conversation search", () => {
  it("indexes native JSONL, retains user data and skips duplicate internal logs", async () => {
    const env = makeEnv(), store = new MessageStore(env.db, nullLogger), db = new DatabaseSync(env.db);
    const paths = { claude: join(env.home, "claude"), codex: join(env.home, "codex"), opencode: join(env.home, "opencode"), antigravity: join(env.home, "agy") };
    const file = join(paths.antigravity, "brain", "native-session", ".system_generated", "logs", "transcript.jsonl");
    const raw = JSON.stringify({ type: "USER_INPUT", source: "USER_EXPLICIT", step_index: 0, content: "agyorchid searchable question" }) + "\n" + JSON.stringify({ type: "GENERIC", source: "MODEL", step_index: 1, content: "agyorchid answer", subagent_info: { subagents: [{ conversation_id: "native-child", role: "review" }] } }) + "\n";
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, raw);
    writeFileSync(join(dirname(file), "transcript_full.jsonl"), raw);
    const index = new HistoryIndex(db, env.home, paths);
    const ingestor = new ConversationIngestor(db, env.home, paths);
    try {
      for (let n = 0; n < 100; n++) { const tick = index.tick(); if (!tick.work && !tick.discovering) break; }
      const hits = readHistory(env.db, { query: "agyorchid", filters: { agent: "antigravity" } }).hits;
      expect(hits).toHaveLength(2);
      expect(hits.every((hit) => hit.agent === "antigravity" && hit.session === "native-session")).toBe(true);
      expect(db.prepare("SELECT path FROM history_files WHERE agent='antigravity'").all()).toEqual([{ path: file }]);
      for (let n = 0; n < 30; n++) ingestor.tick();
      const conversation = readConversation(db, { id: "antigravity:native-session" });
      expect(conversation.records.map((record) => Buffer.from(record.raw, "base64").toString("utf8")).join("")).toBe(raw);
      expect(readConversation(db, { id: "antigravity:native-child" }).conversation?.parent).toBe("antigravity:native-session");
      expect(readFileSync(file, "utf8")).toBe(raw);
    } finally { ingestor.close(); index.close(); db.close(); store.close(); await env.cleanup(); }
  });
});
