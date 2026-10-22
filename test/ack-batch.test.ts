import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv } from "./helpers.js";
import { fixturePeer, markOwned, ownedMessage, unreadOwned } from "./owned-mail.js";

it("rolls back a failed acknowledgement group and retries without losing unread messages", async () => {
  const env = makeEnv(), store = new MessageStore(env.db, nullLogger), db = new DatabaseSync(env.db);
  try {
    const receiver = fixturePeer(store, "receiver");
    for (const id of ["first", "second"]) store.insert(ownedMessage(store, receiver, { id, recipient: "receiver", to: "receiver",
      from: { id: "sender", name: "sender", agent: "codex" }, body: id, conversationId: "fixture",
      replyTo: null, hop: 0, createdAt: 1, readAt: null }));
    db.exec("CREATE TRIGGER refuse_ack BEFORE UPDATE OF read_at ON messages WHEN new.id='second' BEGIN SELECT RAISE(ABORT, 'ack refused'); END;");
    expect(() => markOwned(store, receiver, ["first", "second"], 2)).toThrow("ack refused");
    expect(unreadOwned(store, receiver).map(m => m.id)).toEqual(["first", "second"]);
    db.exec("DROP TRIGGER refuse_ack");
    expect(markOwned(store, receiver, ["first", "second"], 3)).toBe(2);
    expect(unreadOwned(store, receiver)).toEqual([]);
    expect(markOwned(store, receiver, ["first", "second"], 4)).toBe(0);
    expect(store.byId("first")?.readAt).toBe(3);
    expect(store.byId("second")?.readAt).toBe(3);
  } finally { db.close(); store.close(); await env.cleanup(); }
});
