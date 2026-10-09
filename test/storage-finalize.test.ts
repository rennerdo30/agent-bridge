import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  expect(paths.some(p => p.endsWith("old-snapshot.db"))).toBe(true);
  expect(paths.some(p => p.includes(".pending-snapshot-1"))).toBe(true);
  const lines: string[] = [];
  runFinalize(env.home, line => lines.push(line));
  expect(lines.some(l => l.includes("conversation_records"))).toBe(true);
  const bridge = new DatabaseSync(env.db, { readOnly: true }); closes.push(() => bridge.close());
  expect(bridge.prepare("SELECT name FROM sqlite_master WHERE name='conversation_records'").get()).toBeUndefined();
  expect(bridge.prepare("SELECT body FROM messages WHERE id='m1'").get()!.body).toBe("kept message");
  expect(existsSync(join(env.home, ".migration-snapshots", "old-snapshot.db"))).toBe(false);
  expect(existsSync(join(env.home, "backups", ".pending-snapshot-1"))).toBe(false);
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
