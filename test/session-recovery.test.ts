import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageStore, SQLITE_STORE_VERSION } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });
function peer(): PeerInfo {
  return { id: "old-server", name: "session", agent: "claude", cwd: env.home, pid: 123,
    agentPid: 456, agentStartedAt: "creation-time", sessionId: "chat-one", startedAt: 1, autoWake: false };
}

describe("session reload recovery", () => {
  it("recovers the same CLI process after a broker restart and preserves prior bindings", () => {
    const original = peer();
    let store = new MessageStore(env.db, nullLogger);
    store.rememberSession(original, 1);
    store.rememberSession({ ...original, sessionId: "chat-two" }, 2);
    store.close();
    store = new MessageStore(env.db, nullLogger);
    try {
      expect(store.recoverSession({ ...original, id: "new-server", pid: 789, name: "session-2", cwd: join(env.home, "."), sessionId: null })).toBe("chat-two");
      for (const changed of [{ agentPid: 999 }, { agentStartedAt: "reused-pid" }, { agentStartedAt: null },
        { agentPid: null }, { agent: "codex" as const }, { cwd: join(env.home, "other") }, { name: "other-session" }, { jobAgent: "claude" as const }]) {
        expect(store.recoverSession({ ...original, ...changed, sessionId: null })).toBeNull();
      }
      const db = new DatabaseSync(env.db, { readOnly: true });
      try { expect(db.prepare("SELECT session_id FROM session_bindings ORDER BY learned_at").all()).toEqual([{ session_id: "chat-one" }, { session_id: "chat-two" }]); }
      finally { db.close(); }
    } finally { store.close(); }
  });

  it("backs up v4 before adding reload bindings and retains the original message", () => {
    const original = new MessageStore(env.db, nullLogger);
    original.insert({ id: "keep", recipient: "session", from: { id: "sender", name: "sender", agent: "claude" },
      to: "session", conversationId: "chat", replyTo: null, hop: 0, body: "owner history", createdAt: 1, readAt: null });
    original.close();
    const old = new DatabaseSync(env.db);
    old.exec("DROP TABLE session_bindings; PRAGMA user_version=4;"); old.close();
    const upgraded = new MessageStore(env.db, nullLogger);
    try {
      expect(upgraded.byId("keep")?.body).toBe("owner history");
      upgraded.rememberSession(peer(), 1);
      expect(upgraded.recoverSession(peer())).toBe("chat-one");
      const snapshot = readdirSync(env.home).find((name) => name.startsWith("bridge.db.backup-"))!;
      const backup = new DatabaseSync(join(env.home, snapshot), { readOnly: true });
      try {
        expect(backup.prepare("PRAGMA user_version").get()!.user_version).toBe(4);
        expect(backup.prepare("SELECT body FROM messages WHERE id='keep'").get()!.body).toBe("owner history");
      } finally { backup.close(); }
      const current = new DatabaseSync(env.db, { readOnly: true });
      try { expect(current.prepare("PRAGMA user_version").get()!.user_version).toBe(SQLITE_STORE_VERSION); }
      finally { current.close(); }
    } finally { upgraded.close(); }
  });
});
