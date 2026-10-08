import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { MessageStore } from "../src/core/store.js";
import { cleanupSavepoint } from "../src/core/savepoint.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv } from "./helpers.js";
import { HistoryIndex } from "../src/core/history.js";
import { historySchema } from "../src/core/history-schema.js";

it("preserves the original acknowledgement error after SQLite automatically rolls back", async () => {
  const env = makeEnv(), store = new MessageStore(env.db, nullLogger), db = new DatabaseSync(env.db);
  try {
    for (const id of ["first", "second"]) store.insert({ id, recipient: "receiver", to: "receiver", from: { id: "sender", name: "sender", agent: "codex" }, body: id, conversationId: "fixture", replyTo: null, hop: 0, createdAt: 1, readAt: null });
    db.exec("CREATE TRIGGER rollback_ack BEFORE UPDATE OF read_at ON messages WHEN new.id='second' BEGIN SELECT RAISE(ROLLBACK, 'original rollback error'); END");
    expect(() => store.markRead("receiver", ["first", "second"], 2)).toThrow("original rollback error");
    expect(store.unread("receiver", 10).map(m => m.id)).toEqual(["first", "second"]);
  } finally { db.close(); store.close(); await env.cleanup(); }
});
it("rethrows the exact operation error when nested savepoints have disappeared", () => {
  const db = new DatabaseSync(":memory:"), original = new Error("SQLITE_FULL original");
  try {
    db.exec("SAVEPOINT history_rows; SAVEPOINT history_document; ROLLBACK");
    let caught: unknown;
    try { cleanupSavepoint(db, "history_document", true, original); } catch (error) { caught = error; }
    expect(caught).toBe(original);
    expect(() => cleanupSavepoint(db, "history_rows", false, original)).toThrow("SQLITE_FULL original");
  } finally { db.close(); }
});
it("keeps the history insertion failure after an automatic transaction rollback", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE messages(id TEXT, recipient TEXT, from_id TEXT, from_name TEXT, from_agent TEXT, to_target TEXT, conversation_id TEXT, reply_to TEXT, hop INTEGER, body TEXT, created_at INTEGER, read_at INTEGER)");
  db.exec(historySchema(false));
  const index = new HistoryIndex(db, null, { claude: "", codex: "", opencode: "", antigravity: "" });
  try {
    db.exec("CREATE TRIGGER rollback_document BEFORE INSERT ON history_documents BEGIN SELECT RAISE(ROLLBACK, 'original history failure'); END");
    const put = (index as unknown as { put(doc: Record<string, unknown>): void }).put.bind(index);
    expect(() => put({ id: "fixture", kind: "message", agent: "codex", at: 1, body: "retained source", link: "", message: null, job: null, run: null, session: null, cursor: null })).toThrow("original history failure");
    expect(db.prepare("SELECT count(*) AS n FROM history_documents").get()!.n).toBe(0);
  } finally { index.close(); db.close(); }
});
