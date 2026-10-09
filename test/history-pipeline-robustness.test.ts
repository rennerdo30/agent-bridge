import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copyLegacyConversationTail, historyDbPath, historyMigrationFailure, historyReadPath, historyReady, migrateHistoryStore, openHistoryStore } from "../src/core/history-store.js";
import { decodeHistoryRow, HISTORY_V1_PREFIX } from "../src/core/history-migration.js";
import { historySchema } from "../src/core/history-schema.js";
import { CONVERSATION_SCHEMA } from "../src/core/conversation-schema.js";
import { readHistory } from "../src/core/history.js";
import { verifyBeforeFinalize } from "../src/core/storage-finalize.js";
import * as compatibility from "../src/core/store-compatibility.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
const closes: (() => void)[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) close(); await env.cleanup(); });

function legacy() {
  copyFileSync(join(import.meta.dirname, "fixtures/owner-questions-upgrade/v0.29.17/bridge.db"), env.db);
  const db = new DatabaseSync(env.db); closes.push(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000");
  db.prepare("INSERT OR IGNORE INTO conversations(id,agent,session) VALUES('codex:legacy','codex','legacy')").run();
  for (let i = 0; i < 5; i++) db.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('legacy-source',0,?,'codex:legacy',1,?,?)").run(i, Buffer.from([0, 255, i]), `retained-${i}`);
  return db;
}
function target() { const db = openHistoryStore(historyDbPath(env.db)); closes.push(() => db.close()); return db; }
const append = (db: DatabaseSync, source: string, raw: string, conversation = "codex:legacy") =>
  db.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES(?,0,0,?,1,?,?)").run(source, conversation, Buffer.from(raw), raw);

/** A verified history.db v1 (0.30.0–0.30.3) whose native ids are far above bridge.db ids. */
function v1Store(options: { tailCursor?: number; mapping?: [number, number] } = {}) {
  const v1 = new DatabaseSync(historyDbPath(env.db));
  v1.exec(historySchema().replace(/CREATE TRIGGER history_message_(?:insert|claim)[\s\S]*?END;/g, "").replace(/PRAGMA user_version = 4;/, ""));
  v1.exec(CONVERSATION_SCHEMA.slice(0, CONVERSATION_SCHEMA.indexOf("INSERT OR IGNORE INTO conversation_envelopes")));
  v1.exec(`CREATE TABLE history_migration(version INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, status TEXT NOT NULL, manifest TEXT);
    CREATE TABLE history_legacy_tail(source_id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL);
    INSERT INTO history_migration VALUES(1,'old-snapshot','verified','{}');
    INSERT INTO conversations(id,agent,session) VALUES('codex:legacy','codex','legacy');
    PRAGMA user_version=1;`);
  v1.prepare("INSERT INTO conversation_records(id,source,generation,offset,conversation,at,raw,body) VALUES(500000,'v1-native',0,0,'codex:legacy',1,?,'')").run(Buffer.from("pecan native v1 record"));
  v1.prepare("INSERT INTO history_documents(id,kind,agent,at,body,folded,link) VALUES('v1-doc','transcript','codex',1,'Pecan v1 document','pecan v1 document','/v1')").run();
  if (options.tailCursor !== undefined) v1.prepare("INSERT INTO history_cursors VALUES('legacy-record-tail',?)").run(String(options.tailCursor));
  if (options.mapping) {
    const [sourceId, targetId] = options.mapping;
    const bridge = new DatabaseSync(env.db, { readOnly: true });
    // v1's own migration copied bridge.db records at their ids; its tail remapped the last one onto a new id.
    for (const row of bridge.prepare("SELECT * FROM conversation_records WHERE id<? ORDER BY id").all(sourceId))
      v1.prepare("INSERT INTO conversation_records(id,source,generation,offset,conversation,at,raw,body,part) VALUES(?,?,?,?,?,?,?,?,?)").run(row.id!, row.source!, row.generation!, row.offset!, row.conversation!, row.at!, row.raw!, row.body!, row.part ?? null);
    const row = bridge.prepare("SELECT * FROM conversation_records WHERE id=?").get(sourceId)!;
    bridge.close();
    v1.prepare("INSERT INTO conversation_records(id,source,generation,offset,conversation,at,raw,body,part) VALUES(?,?,?,?,?,?,?,?,?)").run(targetId, row.source!, row.generation!, row.offset!, row.conversation!, row.at!, row.raw!, row.body!, row.part ?? null);
    v1.prepare("INSERT INTO history_legacy_tail VALUES(?,?)").run(sourceId, targetId);
  }
  v1.close();
}

it("records a conflicting or orphan legacy-tail row and keeps copying instead of halting ingestion (AB-226, AB-240)", async () => {
  const old = legacy(), db = target();
  await migrateHistoryStore(env.db, db);
  // Native ingestion already holds this natural key with different bytes.
  db.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,raw_codec,body) VALUES('rewritten',0,0,'codex:legacy',1,?,0,NULL)").run(Buffer.from("native bytes"));
  append(old, "rewritten", "older pinned writer bytes");
  append(old, "orphan", "orphan bytes", "codex:missing-conversation");
  append(old, "after-conflict", "later bytes");
  let copied = 0;
  for (let i = 0; i < 3; i++) copied += copyLegacyConversationTail(old, db);
  expect(copied).toBe(3);
  const after = db.prepare("SELECT * FROM conversation_records WHERE source='after-conflict'").get();
  expect((decodeHistoryRow("conversation_records", after!).raw as Buffer).toString()).toBe("later bytes");
  // Both originals stay: the native copy is untouched and the legacy bytes are retained verbatim.
  expect((decodeHistoryRow("conversation_records", db.prepare("SELECT * FROM conversation_records WHERE source='rewritten'").get()!).raw as Buffer).toString()).toBe("native bytes");
  const conflicts = db.prepare("SELECT source,reason,raw FROM history_legacy_conflicts ORDER BY source_id").all();
  expect(conflicts.map(c => [c.source, c.reason])).toEqual([["rewritten", "conflict"], ["orphan", "orphan"]]);
  expect(Buffer.from(conflicts[0]!.raw as Uint8Array).toString()).toBe("older pinned writer bytes");
  // Finalize stays blocked while conflicts exist.
  expect(verifyBeforeFinalize(env.home).join("\n")).toMatch(/legacy tail conflict/);
});

it("does not latch the migration as failed on a transient file error during the snapshot (AB-238)", async () => {
  legacy();
  const db = target();
  let calls = 0;
  const { fastSnapshot } = await import("../src/core/sqlite-fast-snapshot.js");
  const snapshot = (async (...args: Parameters<typeof fastSnapshot>) => {
    if (calls++ === 0) throw Object.assign(new Error("EBUSY: resource busy or locked, copyfile"), { code: "EBUSY" });
    return fastSnapshot(...args);
  }) as typeof fastSnapshot;
  await expect(migrateHistoryStore(env.db, db, undefined, undefined, undefined, false, { snapshot })).rejects.toThrow("EBUSY");
  expect(historyMigrationFailure(db)).toBeNull();
  await migrateHistoryStore(env.db, db, undefined, undefined, undefined, false, { snapshot });
  expect(historyReady(db)).toBe(true);
});

it("keeps the v1 legacy-tail cursor and mappings across the v1 to v2 upgrade (AB-216)", async () => {
  const old = legacy();
  const lastBridge = Number(old.prepare("SELECT max(id) n FROM conversation_records").get()!.n);
  v1Store({ tailCursor: lastBridge, mapping: [lastBridge, 600000] });
  const db = target();
  await migrateHistoryStore(env.db, db);
  expect(db.prepare("SELECT source FROM history_migration").get()!.source).toBe("history-v1");
  expect(db.prepare("SELECT cursor FROM history_cursors WHERE source='legacy-record-tail'").get()!.cursor).toBe(String(lastBridge));
  expect(db.prepare("SELECT target_id FROM history_legacy_tail WHERE source_id=?").get(lastBridge)?.target_id).toBe(600000);
  // An older pinned session appends after the upgrade; the tail must still see it.
  append(old, "late-after-upgrade", "late bytes");
  expect(copyLegacyConversationTail(old, db)).toBe(1);
  expect(db.prepare("SELECT 1 FROM conversation_records WHERE source='late-after-upgrade'").get()).toBeTruthy();
  const blockers = verifyBeforeFinalize(env.home).join("\n");
  expect(blockers).not.toMatch(/not in history\.db yet/);
});

it("defers the in-place v1 to v2 rename while a 0.30.0-0.30.3 history writer is alive (AB-225)", async () => {
  legacy();
  v1Store();
  const peers = vi.spyOn(compatibility, "liveStorePeers").mockReturnValue([{ pid: 1, name: "claude-old", version: "0.30.3", json: 1, sqlite: 9, explicit: true }]);
  const db = target();
  expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(1);
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(`${HISTORY_V1_PREFIX}conversation_records`)).toBeUndefined();
  await expect(migrateHistoryStore(env.db, db)).rejects.toMatchObject({ code: "STORE_UPGRADE_DEFERRED" });
  expect(historyMigrationFailure(db)).toBeNull();
  peers.mockReturnValue([]);
  await migrateHistoryStore(env.db, db);
  expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
  expect(historyReady(db)).toBe(true);
});

it("tells history readers that the migration is still running and where results come from (AB-224)", async () => {
  legacy();
  v1Store();
  const db = target();
  expect(historyReady(db)).toBe(false);
  expect(historyReadPath(env.db)).toBe(env.db);
  const result = readHistory(env.db, { query: "retained" });
  expect(result.migration).toMatchObject({ ready: false, readsFrom: "legacy" });
  expect(result.migration?.notice).toMatch(/migration/i);
  await migrateHistoryStore(env.db, db);
  expect(readHistory(env.db, { query: "pecan" }).migration).toBeUndefined();
  expect(existsSync(historyDbPath(env.db))).toBe(true);
});
