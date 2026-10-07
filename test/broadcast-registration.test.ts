import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

it("queues ordinary offline sessions while excluding retained plugin cache ghosts", async () => {
  const store = new MessageStore(env.db, nullLogger);
  try {
    const db = (store as unknown as { db: DatabaseSync }).db;
    const insert = db.prepare("INSERT INTO peer_name_owners VALUES (?,?)");
    insert.run("cache-process", JSON.stringify(["codex", 1, "started", "/fixture/.codex/plugins/cache/agent-bridge/version", "cache-process"]));
    insert.run("real-offline", JSON.stringify(["opencode", 2, "started", env.home, "real-offline"]));
    insert.run("unknown-offline", "unidentified:unknown");
    insert.run("cache-session", JSON.stringify(["session", "claude", "cache-native"]));
    insert.run("cache-unidentified", "unidentified:old-peer");
    db.prepare("INSERT INTO history_sessions VALUES (?,?,NULL)").run("old-peer", "cache-native");
    db.prepare("INSERT INTO history_files VALUES (?,?,?,?,?,?,?)").run("fixture-native", "claude", "claude", "cache-native", "/fixture/.claude/plugins/cache/agent-bridge/version", null, 1);
    const originals = db.prepare("SELECT * FROM peer_name_owners ORDER BY name").all();
    expect(store.broadcastNames()).toEqual(["real-offline", "unknown-offline"]);
    const sender = env.node("sender", "opencode"); await sender.start();
    const sent = await sender.send({ to: "*", body: "REGISTERED_OFFLINE" });
    expect(sent.queuedFor.sort()).toEqual(["real-offline", "unknown-offline"]);
    expect(sent.deliveredTo).toEqual([]);
    expect(db.prepare("SELECT * FROM peer_name_owners WHERE name<>'sender' ORDER BY name").all()).toEqual(originals);
    expect(db.prepare("SELECT cwd FROM history_files WHERE path='fixture-native'").get()!.cwd).toContain("plugins/cache");
  } finally { store.close(); }
});

it("keeps a session eligible when indexed paths include a real project", () => {
  const store = new MessageStore(env.db, nullLogger);
  try {
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare("INSERT INTO peer_name_owners VALUES (?,?)").run("moved-session", JSON.stringify(["session", "opencode", "moved"]));
    const file = db.prepare("INSERT INTO history_files VALUES (?,?,?,?,?,?,?)");
    file.run("old", "opencode", "opencode", "moved", "/fixture/.config/opencode/plugins/agent-bridge", null, 1);
    file.run("project", "opencode", "opencode", "moved", env.home, null, 2);
    expect(store.broadcastNames()).toEqual(["moved-session"]);
  } finally { store.close(); }
});
