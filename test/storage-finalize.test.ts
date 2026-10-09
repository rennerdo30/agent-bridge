import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { planFinalize, rollbackHistoryStore, runFinalize } from "../src/core/storage-finalize.js";
import { historyDbPath, historyReadPath, migrateHistoryStore, openHistoryStore } from "../src/core/history-store.js";
import { decodeHistoryRow } from "../src/core/history-migration.js";
import { migrateJobArchives } from "../src/core/job-archive-migration.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
const closes: (() => void)[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) close(); await env.cleanup(); });

async function legacyHome(migrate: boolean) {
  const old = new DatabaseSync(env.db);
  const { historySchema } = await import("../src/core/history-schema.js");
  const { CONVERSATION_SCHEMA } = await import("../src/core/conversation-schema.js");
  old.exec("CREATE TABLE messages(id TEXT,body TEXT,from_agent TEXT,from_name TEXT,from_id TEXT,recipient TEXT,to_target TEXT,created_at INTEGER)");
  old.exec("CREATE TABLE decisions(id TEXT)");
  old.exec(historySchema()); old.exec(CONVERSATION_SCHEMA); old.exec("PRAGMA journal_mode=WAL");
  old.prepare("INSERT INTO messages VALUES('m1','kept message','codex','codex-a','a','claude-b','claude-b',1)").run();
  old.prepare("INSERT INTO conversations(id,agent,session) VALUES('codex:a','codex','a')").run();
  old.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('s',0,0,'codex:a',1,?,'x')").run(Buffer.from("record bytes"));
  old.close();
  mkdirSync(join(env.home, ".migration-snapshots"), { recursive: true });
  writeFileSync(join(env.home, ".migration-snapshots", "old-snapshot.db"), "snapshot");
  mkdirSync(join(env.home, "backups", ".pending-snapshot-1"), { recursive: true });
  writeFileSync(join(env.home, "backups", ".pending-snapshot-1", "bridge.db"), "partial");
  writeFileSync(join(env.home, "bridge.db.backup-1-x"), "old backup");
  const db = openHistoryStore(historyDbPath(env.db)); closes.push(() => db.close());
  if (migrate) await migrateHistoryStore(env.db, db);
  return db;
}

it("refuses and removes nothing before the new storage is verified", async () => {
  await legacyHome(false);
  const plan = planFinalize(env.home);
  expect(plan.ready).toBe(false);
  expect(plan.blockers.join("\n")).toMatch(/not verified/);
  runFinalize(env.home, () => {});
  expect(existsSync(join(env.home, ".migration-snapshots", "old-snapshot.db"))).toBe(true);
  const bridge = new DatabaseSync(env.db, { readOnly: true }); closes.push(() => bridge.close());
  expect(bridge.prepare("SELECT count(*) n FROM conversation_records").get()!.n).toBe(1);
});

it("refuses to delete while a late legacy record is not copied yet, and when a copy differs", async () => {
  const history = await legacyHome(true);
  await migrateJobArchives(join(env.home, "jobs.json"));
  const old = new DatabaseSync(env.db); closes.push(() => old.close());
  old.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('late',0,0,'codex:a',1,?,'late')").run(Buffer.from("late bytes"));
  const lines: string[] = [];
  let plan = runFinalize(env.home, line => lines.push(line));
  expect(plan.ready).toBe(false);
  expect(plan.blockers.join("\n")).toMatch(/legacy tail has not caught up/);
  expect(old.prepare("SELECT count(*) n FROM conversation_records").get()!.n).toBe(2);
  expect(existsSync(join(env.home, ".migration-snapshots", "old-snapshot.db"))).toBe(true);
  // Catch up, then tamper with the copy: a byte difference must also block.
  const { copyLegacyConversationTail } = await import("../src/core/history-store.js");
  expect(copyLegacyConversationTail(old, history)).toBe(1);
  history.exec("DROP TRIGGER conversation_records_no_update");
  history.prepare("UPDATE conversation_records SET raw=?, raw_codec=0 WHERE source='s'").run(Buffer.from("tampered"));
  plan = runFinalize(env.home, () => {});
  expect(plan.ready).toBe(false);
  expect(plan.blockers.join("\n")).toMatch(/differ from their copy/);
  expect(old.prepare("SELECT count(*) n FROM conversation_records").get()!.n).toBe(2);
});

it("after verification removes exactly the listed old-format data and keeps everything still in use", async () => {
  const history = await legacyHome(true);
  // The real job archive import, on a home without legacy copies, completes immediately.
  await migrateJobArchives(join(env.home, "jobs.json"));
  const plan = planFinalize(env.home);
  expect(plan.blockers).toEqual([]);
  const paths = plan.items.map(i => i.path);
  expect(paths).toContain("bridge.db:conversation_records");
  expect(paths).toContain("bridge.db:history_documents");
  expect(paths).not.toContain("bridge.db:messages");
  // Files that are not provably redundant row by row are kept and reported, never removed.
  expect(paths.some(p => p.endsWith("old-snapshot.db"))).toBe(false);
  expect(paths.some(p => p.includes(".pending-snapshot-1"))).toBe(false);
  expect(plan.kept.map(i => i.path).some(p => p.endsWith("old-snapshot.db"))).toBe(true);
  const lines: string[] = [];
  runFinalize(env.home, line => lines.push(line));
  expect(lines.some(l => l.includes("conversation_records"))).toBe(true);
  const bridge = new DatabaseSync(env.db, { readOnly: true }); closes.push(() => bridge.close());
  expect(bridge.prepare("SELECT name FROM sqlite_master WHERE name='conversation_records'").get()).toBeUndefined();
  expect(bridge.prepare("SELECT body FROM messages WHERE id='m1'").get()!.body).toBe("kept message");
  expect(existsSync(join(env.home, ".migration-snapshots", "old-snapshot.db"))).toBe(true);
  expect(existsSync(join(env.home, "backups", ".pending-snapshot-1"))).toBe(true);
  expect(existsSync(join(env.home, "bridge.db.backup-1-x"))).toBe(true);
  // The verified copy is untouched.
  expect((decodeHistoryRow("conversation_records", history.prepare("SELECT * FROM conversation_records").get()!).raw as Buffer).toString()).toBe("record bytes");
});

it("rolls back to the legacy history before finalize, keeps the copy, and refuses once finalize removed the legacy tables", async () => {
  const history = await legacyHome(true);
  expect(historyReadPath(env.db)).toBe(historyDbPath(env.db));
  expect(rollbackHistoryStore(env.home)).toMatch(/Rolled back/);
  expect(historyReadPath(env.db)).toBe(env.db);
  expect(history.prepare("SELECT count(*) n FROM conversation_records").get()!.n).toBe(1);
  await expect(migrateHistoryStore(env.db, history)).rejects.toThrow("explicit retry");
  await migrateHistoryStore(env.db, history, undefined, undefined, undefined, true);
  expect(historyReadPath(env.db)).toBe(historyDbPath(env.db));
  await migrateJobArchives(join(env.home, "jobs.json"));
  expect(runFinalize(env.home, () => {}).ready).toBe(true);
  expect(() => rollbackHistoryStore(env.home)).toThrow(/no longer possible/);
});

/** A whole-database copy of bridge.db, like the backups and snapshots earlier migrations wrote. */
function copyOfBridge(path: string, extra?: (db: DatabaseSync) => void): void {
  const live = new DatabaseSync(env.db);
  try { live.prepare("VACUUM INTO ?").run(path); } finally { live.close(); }
  if (!extra) return;
  const copy = new DatabaseSync(path);
  try { extra(copy); } finally { copy.close(); }
}

it("AB-228: keeps an old backup that holds a message the live databases no longer have, and removes a provably redundant snapshot", async () => {
  await legacyHome(true);
  await migrateJobArchives(join(env.home, "jobs.json"));
  const purged = join(env.home, "bridge.db.backup-2-purged");
  copyOfBridge(purged, db => db.prepare("INSERT INTO messages VALUES('m0','purged by an old version','codex','codex-a','a','claude-b','claude-b',0)").run());
  const redundant = join(env.home, ".migration-snapshots", "bridge.db.backup-3-v1-to-v2");
  copyOfBridge(redundant);
  const plan = planFinalize(env.home);
  expect(plan.items.map(i => i.path)).toContain(redundant);
  expect(plan.items.map(i => i.path)).not.toContain(purged);
  expect(plan.kept.find(i => i.path === purged)?.reason).toMatch(/messages: 1 of 2 rows/);
  const done = runFinalize(env.home, () => {});
  expect(done.ready).toBe(true);
  expect(existsSync(purged)).toBe(true);
  expect(existsSync(redundant)).toBe(false);
  const backup = new DatabaseSync(purged, { readOnly: true }); closes.push(() => backup.close());
  expect(backup.prepare("SELECT body FROM messages WHERE id='m0'").get()!.body).toBe("purged by an old version");
});

it("AB-228: keeps a pending backup directory unless every file in it is proven redundant", async () => {
  await legacyHome(true);
  await migrateJobArchives(join(env.home, "jobs.json"));
  const pending = join(env.home, "backups", ".pending-snapshot-2");
  mkdirSync(pending, { recursive: true });
  copyOfBridge(join(pending, "bridge.db"));
  writeFileSync(join(pending, "jobs.json"), "{\"version\":1,\"jobs\":[]}");
  writeFileSync(join(env.home, "jobs.json"), "{\"version\":1,\"jobs\":[]}");
  expect(planFinalize(env.home).items.map(i => i.path)).toContain(pending);
  writeFileSync(join(pending, "runs.json"), "only here");
  expect(planFinalize(env.home).kept.find(i => i.path === pending)?.reason).toMatch(/runs\.json/);
  runFinalize(env.home, () => {});
  expect(existsSync(join(pending, "runs.json"))).toBe(true);
});

it("AB-215: keeps a retained failed-attempt table that holds a natively ingested record missing from v2", async () => {
  const history = await legacyHome(true);
  await migrateJobArchives(join(env.home, "jobs.json"));
  // Native ingestion after the verified copy: this record exists only in history.db.
  history.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,raw_codec,body) VALUES('native',0,0,'codex:a',2,?,0,'')").run(Buffer.from("native only"));
  rollbackHistoryStore(env.home);
  await migrateHistoryStore(env.db, history, undefined, undefined, undefined, true);
  const retained = String(history.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'retained%conversation_records'").get()!.name);
  expect(history.prepare("SELECT count(*) n FROM conversation_records WHERE source='native'").get()!.n).toBe(0);
  const plan = planFinalize(env.home);
  expect(plan.items.map(i => i.path)).not.toContain(`history.db:${retained}`);
  expect(plan.kept.find(i => i.path === `history.db:${retained}`)?.reason).toMatch(/1 of 2 rows/);
  // Retained tables whose rows all exist in v2 are proven and may go.
  expect(plan.items.some(i => /^history\.db:retained_\d+_conversations$/.test(i.path))).toBe(true);
  for (const close of closes.splice(0).reverse()) close();
  expect(runFinalize(env.home, () => {}).ready).toBe(true);
  const after = new DatabaseSync(historyDbPath(env.db), { readOnly: true }); closes.push(() => after.close());
  expect(Buffer.from(after.prepare(`SELECT raw FROM "${retained}" WHERE source='native'`).get()!.raw as Uint8Array).toString()).toBe("native only");
});

it("AB-211: drops v1_* tables only with a row-level proof against v2", async () => {
  const old = new DatabaseSync(env.db);
  old.exec("CREATE TABLE messages(id TEXT,body TEXT,from_agent TEXT,from_name TEXT,from_id TEXT,recipient TEXT,to_target TEXT,created_at INTEGER)");
  old.close();
  const { historySchema } = await import("../src/core/history-schema.js");
  const { CONVERSATION_SCHEMA } = await import("../src/core/conversation-schema.js");
  const v1 = new DatabaseSync(historyDbPath(env.db));
  v1.exec(historySchema().replace(/CREATE TRIGGER history_message_(?:insert|claim)[\s\S]*?END;/g, "").replace(/PRAGMA user_version = 4;/, ""));
  v1.exec(CONVERSATION_SCHEMA.slice(0, CONVERSATION_SCHEMA.indexOf("INSERT OR IGNORE INTO conversation_envelopes")));
  v1.exec(`CREATE TABLE history_migration(version INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, status TEXT NOT NULL, manifest TEXT);
    INSERT INTO history_migration VALUES(1,'old-snapshot','verified','{}');
    INSERT INTO conversations(id,agent,session) VALUES('codex:v1','codex','v1');
    PRAGMA user_version=1;`);
  v1.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('v1',0,0,'codex:v1',1,?,'')").run(Buffer.from("v1 record"));
  v1.close();
  const history = openHistoryStore(historyDbPath(env.db)); closes.push(() => history.close());
  await migrateHistoryStore(env.db, history);
  await migrateJobArchives(join(env.home, "jobs.json"));
  expect(planFinalize(env.home).items.map(i => i.path)).toContain("history.db:v1_conversation_records");
  // A v1 row that never reached v2 must keep its table.
  history.prepare("INSERT INTO v1_conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('v1-late',0,0,'codex:v1',2,?,'')").run(Buffer.from("late v1 record"));
  const plan = planFinalize(env.home);
  expect(plan.items.map(i => i.path)).not.toContain("history.db:v1_conversation_records");
  expect(plan.items.map(i => i.path)).toContain("history.db:v1_conversations");
  for (const close of closes.splice(0).reverse()) close();
  runFinalize(env.home, () => {});
  const after = new DatabaseSync(historyDbPath(env.db), { readOnly: true }); closes.push(() => after.close());
  expect(after.prepare("SELECT count(*) n FROM v1_conversation_records").get()!.n).toBe(2);
  expect(after.prepare("SELECT name FROM sqlite_master WHERE name='v1_conversations'").get()).toBeUndefined();
});

it("AB-212: re-verifies inside the dropping transaction, so a legacy record written after verification survives", async () => {
  await legacyHome(true);
  await migrateJobArchives(join(env.home, "jobs.json"));
  const plan = runFinalize(env.home, line => {
    if (!line.startsWith("verification passed")) return;
    // A writer without a storage lease commits between verification and the drop.
    const late = new DatabaseSync(env.db);
    try { late.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('late',0,0,'codex:a',1,?,'late')").run(Buffer.from("late bytes")); }
    finally { late.close(); }
  });
  expect(plan.ready).toBe(false);
  expect(plan.blockers.join("\n")).toMatch(/legacy tail has not caught up/);
  const bridge = new DatabaseSync(env.db, { readOnly: true }); closes.push(() => bridge.close());
  expect(bridge.prepare("SELECT count(*) n FROM conversation_records").get()!.n).toBe(2);
});

it("AB-230: removes only job-copy originals listed in a verified manifest, never unlisted files in their folder", async () => {
  await legacyHome(true);
  const archive = join(env.home, "archive");
  mkdirSync(archive, { recursive: true });
  for (let i = 0; i < 3; i++) writeFileSync(join(archive, `jobs-${1791524700000 + i}-${String(i).padStart(8, "0")}-0000-4000-8000-000000000000.json`), JSON.stringify({ version: 1, jobs: [] }) + " ".repeat(i));
  await migrateJobArchives(join(env.home, "jobs.json"));
  const originals = join(env.home, "cold-storage", "jobs-v1", "archive-originals");
  expect(readdirSync(originals)).toHaveLength(3);
  writeFileSync(join(originals, "notes.txt"), "not in any manifest");
  expect(runFinalize(env.home, () => {}).ready).toBe(true);
  expect(readdirSync(originals)).toEqual(["notes.txt"]);
});
