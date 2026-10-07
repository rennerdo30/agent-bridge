import { copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copyLegacyConversationTail, historyDbPath, historyReadPath, historyReady, HISTORY_TABLES, migrateHistoryStore, openHistoryStore, releaseExitedHistoryLease } from "../src/core/history-store.js";
import { MessageStore } from "../src/core/store.js";
import { loadConfig } from "../src/core/config.js";
import { indexedConversationText } from "../src/core/conversations.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
const closes: (() => void)[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { for (const close of closes.splice(0).reverse()) close(); await env.cleanup(); vi.unstubAllEnvs(); });
function legacy() {
  copyFileSync(join(import.meta.dirname, "fixtures/owner-questions-upgrade/v0.29.17/bridge.db"), env.db);
  const db = new DatabaseSync(env.db); closes.push(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000");
  db.prepare("INSERT OR IGNORE INTO conversations(id,agent,session) VALUES('codex:legacy','codex','legacy')").run();
  for (let i = 0; i < 80; i++) db.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('legacy-source',0,?,'codex:legacy',1,?,?)").run(i, Buffer.from([0,255,i]), `retained-${i}`);
  return db;
}
function target() { const db = openHistoryStore(historyDbPath(env.db)); closes.push(() => db.close()); return db; }

it("copies and verifies actual .17 tables with protected backup, preserving raw bytes and bridge schema", async () => {
  const old = legacy(), db = target();
  expect(historyReadPath(env.db)).toBe(env.db);
  const version = old.prepare("PRAGMA user_version").get()!.user_version;
  await migrateHistoryStore(env.db, db);
  expect(historyReady(db)).toBe(true);
  expect(historyReadPath(env.db)).toBe(historyDbPath(env.db));
  expect(old.prepare("PRAGMA user_version").get()!.user_version).toBe(version);
  const state = db.prepare("SELECT * FROM history_migration").get()!;
  expect(existsSync(String(state.snapshot))).toBe(true);
  const manifest = JSON.parse(String(state.manifest));
  for (const table of HISTORY_TABLES) {
    const filter = table === "history_cursors" ? "WHERE source<>'legacy-record-tail'" : "";
    expect(db.prepare(`SELECT rowid,* FROM ${table} ${filter} ORDER BY rowid`).all()).toEqual(old.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
    expect(manifest[table].rows).toBe(Number(old.prepare(`SELECT count(*) n FROM ${table}`).get()!.n));
    expect(manifest[table].sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  await migrateHistoryStore(env.db, db);
  expect(db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot).toBe(state.snapshot);
});

it("resumes an interrupted copy against its original snapshot without deleting source rows", async () => {
  const old = legacy(), db = target();
  let checks = 0;
  await expect(migrateHistoryStore(env.db, db, () => false, () => ++checks > 5)).rejects.toThrow("stopped");
  const snapshot = db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot;
  expect(historyReady(db)).toBe(false);
  await migrateHistoryStore(env.db, db);
  expect(historyReady(db)).toBe(true);
  expect(db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot).toBe(snapshot);
  expect(db.prepare("SELECT * FROM conversation_records").all()).toEqual(old.prepare("SELECT * FROM conversation_records").all());
});

it("fails closed on copy conflict and retains the backup and all original data", async () => {
  const old = legacy(), db = target();
  const row = old.prepare("SELECT * FROM history_documents LIMIT 1").get()!;
  db.prepare("INSERT INTO history_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(row.id!,row.kind!,row.agent!,row.at!,"conflict",row.folded!,row.link!,row.message!,row.job!,row.run!,row.session!,row.cursor!);
  await expect(migrateHistoryStore(env.db, db)).rejects.toThrow("verification failed");
  expect(historyReady(db)).toBe(false);
  expect(existsSync(String(db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot))).toBe(true);
  expect(old.prepare("SELECT body FROM history_documents WHERE id=?").get(row.id!)!.body).toBe(row.body);
});

it("replays .17 raw appends after snapshot despite colliding numeric ids, idempotently", async () => {
  const old = legacy(), db = target();
  await migrateHistoryStore(env.db, db);
  // A new ingestor allocates the same next numeric id before a pinned writer appends.
  db.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('new',0,0,'codex:legacy',1,?,'new')").run(Buffer.from("new"));
  const raw = Buffer.from([0,255,128,12]);
  old.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('late-old',0,0,'codex:legacy',1,?,'old')").run(raw);
  expect(copyLegacyConversationTail(old, db)).toBe(1);
  expect(copyLegacyConversationTail(old, db)).toBe(0);
  expect(Buffer.from(db.prepare("SELECT raw FROM conversation_records WHERE source='late-old'").get()!.raw as Uint8Array)).toEqual(raw);
  expect(Buffer.from(db.prepare("SELECT raw FROM conversation_records WHERE source='new'").get()!.raw as Uint8Array).toString()).toBe("new");
  expect(db.prepare("SELECT source_id,target_id FROM history_legacy_tail").get()!.target_id).not.toBe(db.prepare("SELECT source_id FROM history_legacy_tail").get()!.source_id);
});

it("honors both kill switches and indexes text without duplicating full transcript metadata", () => {
  expect(loadConfig(env.home,"other",nullLogger,{}).history.ingest).toBe(true);
  writeFileSync(join(env.home,"config.json"), JSON.stringify({ history: { ingest: false } }));
  expect(loadConfig(env.home,"other",nullLogger,{}).history.ingest).toBe(false);
  writeFileSync(join(env.home,"config.json"), "{}");
  expect(loadConfig(env.home,"other",nullLogger,{ AGENT_BRIDGE_HISTORY_INGEST: "0" }).history.ingest).toBe(false);
  expect(loadConfig(env.home,"other",nullLogger,{ AGENT_BRIDGE_HISTORY_INGEST: "false" }).history.ingest).toBe(false);
  expect(indexedConversationText(Buffer.from(JSON.stringify({ payload: { content: [{ text: "search needle" }] }, metadata: "x".repeat(60000) })))).toBe("search needle");
});

it("preserves a future history schema, falls back to legacy reads, and cleans constructor resources", () => {
  const old = legacy(), db = target();
  db.exec("PRAGMA user_version=2");
  expect(() => openHistoryStore(historyDbPath(env.db))).toThrow("unsupported history store version");
  expect(historyReadPath(env.db)).toBe(env.db);
  expect(() => new MessageStore(env.db,nullLogger)).toThrow("unsupported history store version");
  expect(readdirSync(join(env.home,".storage-users"))).toEqual([]);
  // A failed constructor leaves neither an authoritative writer lock nor a schema rewrite.
  old.exec("BEGIN IMMEDIATE; COMMIT");
  expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
});

it("cleans a terminated worker lease only when its exact owner nonce still matches", () => {
  const path = `${historyDbPath(env.db)}.migration-lock`;
  const owner = JSON.stringify({pid:process.pid,nonce:"original-worker"});
  const other = JSON.stringify({pid:process.pid,nonce:"another-worker"});
  writeFileSync(path,other);
  releaseExitedHistoryLease(env.db,owner);
  expect(existsSync(path)).toBe(true);
  releaseExitedHistoryLease(env.db,other);
  expect(existsSync(path)).toBe(false);
});
