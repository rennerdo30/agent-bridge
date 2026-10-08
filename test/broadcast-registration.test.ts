import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MessageStore, BROADCAST_RECENT_MS, SQLITE_STORE_VERSION, migrateMessageSchema } from "../src/core/store.js";
import { recordStorePeer } from "../src/core/store-compatibility.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });
it("queues ordinary recent offline sessions while excluding plugin cache ghosts and old unknown names", async () => {
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
    db.prepare("INSERT INTO peer_last_seen VALUES (?,?)").run("real-offline", Date.now());
    const originals = db.prepare("SELECT * FROM peer_name_owners ORDER BY name").all();
    expect(store.broadcastNames()).toEqual(["real-offline", "unknown-offline"]);
    const sender = env.node("sender", "opencode"); await sender.start();
    const sent = await sender.send({ to: "*", body: "REGISTERED_OFFLINE" });
    expect(sent.queuedFor).toEqual(["real-offline"]); expect(sent.skippedFor).toEqual(["unknown-offline"]);
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
it("queues recent sessions and known masters without reviving stale aliases or changing retained rows", () => {
  const store = new MessageStore(env.db, nullLogger);
  try {
    const db = (store as unknown as { db: DatabaseSync }).db, now = Date.now();
    for (const [name, seen] of [["recent", now], ["stale", now - BROADCAST_RECENT_MS - 1], ["master", 1]] as const) {
      db.prepare("INSERT INTO peer_name_owners VALUES (?,?)").run(name, `unidentified:${name}`);
      db.prepare("INSERT INTO peer_last_seen VALUES (?,?)").run(name, seen);
    }
    const before = db.prepare("SELECT * FROM peer_name_owners ORDER BY name").all();
    expect(store.broadcastRecipients(now, new Set(["master", "known-master"]))).toEqual({ queued: ["master", "recent", "known-master"], skipped: ["stale"] });
    expect(db.prepare("SELECT * FROM peer_name_owners ORDER BY name").all()).toEqual(before);
  } finally { store.close(); }
});
it("backs up v8 before adding last-seen registrations and preserves original registrations", () => {
  const original = new MessageStore(env.db, nullLogger); original.close();
  const old = new DatabaseSync(env.db);
  old.exec("DROP TABLE peer_last_seen; PRAGMA user_version=8;");
  old.prepare("INSERT INTO peer_names VALUES (?,?,?,?,?)").run("identity", "retained", "native", "codex", 42);
  old.exec("CREATE TABLE retained_owner_data(body TEXT); INSERT INTO retained_owner_data VALUES('original owner bytes');");
  const registrations = old.prepare("SELECT * FROM peer_names ORDER BY rowid").all();
  const schema = old.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  const sourceRows = old.prepare("SELECT rowid AS __migration_rowid__, * FROM peer_names ORDER BY rowid");
  sourceRows.setReadBigInts(true);
  const expectedDigest = createHash("sha256");
  for (const row of sourceRows.iterate()) expectedDigest.update(JSON.stringify(row, (_, value) => typeof value === "bigint" ? { bigint: String(value) } : value));
  const sha256 = expectedDigest.digest("hex");
  old.close();
  const upgraded = new MessageStore(env.db, nullLogger);
  try {
    const db = (upgraded as unknown as { db: DatabaseSync }).db;
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(SQLITE_STORE_VERSION);
    expect(db.prepare("SELECT * FROM peer_last_seen").all()).toEqual([{ name: "retained", seen_at: 42 }]);
    expect(db.prepare("SELECT * FROM peer_names ORDER BY rowid").all()).toEqual(registrations);
    expect(db.prepare("SELECT body FROM retained_owner_data").get()!.body).toBe("original owner bytes");
    const folder = join(env.home, ".migration-snapshots");
    const snapshots = readdirSync(folder).filter((name) => name.endsWith(".db"));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatch(/^bridge\.db\.metadata-v8-to-v9-/);
    const path = join(folder, snapshots[0]!);
    const manifest = JSON.parse(readFileSync(`${path}.manifest.json`, "utf8"));
    expect(manifest).toMatchObject({ version: 1, kind: "sqlite-migration-metadata", sourceVersion: 8, targetVersion: SQLITE_STORE_VERSION });
    expect(manifest.schema).toEqual(schema);
    expect(manifest.tables).toEqual([{ name: "peer_names", rows: registrations.length, sha256 }]);
    const backup = new DatabaseSync(path, { readOnly: true });
    try {
      expect(backup.prepare("PRAGMA user_version").get()!.user_version).toBe(8);
      expect(backup.prepare("SELECT name FROM peer_names").get()!.name).toBe("retained");
      expect(backup.prepare("SELECT * FROM peer_names ORDER BY rowid").all()).toEqual(registrations);
      expect(backup.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()).toEqual([{ name: "peer_names" }]);
      const snapshotRows = backup.prepare("SELECT rowid AS __migration_rowid__, * FROM peer_names ORDER BY rowid");
      snapshotRows.setReadBigInts(true);
      const actualDigest = createHash("sha256");
      for (const row of snapshotRows.iterate()) actualDigest.update(JSON.stringify(row, (_, value) => typeof value === "bigint" ? { bigint: String(value) } : value));
      expect(actualDigest.digest("hex")).toBe(sha256);
    } finally { backup.close(); }
    expect(readdirSync(env.home).filter((name) => name.startsWith("bridge.db.backup-"))).toEqual([]);
  } finally { upgraded.close(); }
});
it("returns skipped registrations even when no offline recipient is eligible", async () => {
  const store = new MessageStore(env.db, nullLogger);
  try {
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare("INSERT INTO peer_name_owners VALUES (?,?)").run("gone", "unidentified:gone");
    const sender = env.node("sender"); await sender.start();
    const result = await sender.send({ to: "*", body: "only stale registrations" });
    expect(result.skippedFor).toEqual(["gone"]);
    expect(result.messages).toEqual([]); expect(result.queuedFor).toEqual([]);
  } finally { store.close(); }
});
it("defers last-seen migration while a retained v0.29.17 reader is alive", () => {
  const path = env.db, db = new DatabaseSync(path);
  db.exec("CREATE TABLE peer_names(identity TEXT, name TEXT, learned_at INTEGER); CREATE TABLE owner_data(body); INSERT INTO owner_data VALUES('keep'); PRAGMA user_version=8;");
  recordStorePeer(env.home, { pid: process.pid, name: "retained", version: "0.29.17", storeCapabilities: { json: 4, sqlite: 8 } });
  try {
    expect(() => migrateMessageSchema(db, path, true, nullLogger)).toThrow("Waiting to upgrade sqlite store");
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(8);
    expect(db.prepare("SELECT body FROM owner_data").get()!.body).toBe("keep");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='peer_last_seen'").get()).toBeUndefined();
    expect(readdirSync(env.home).some((name) => name.startsWith("bridge.db.backup-"))).toBe(false);
  } finally { db.close(); }
});
