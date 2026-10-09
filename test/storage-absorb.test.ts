import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { planFinalize, runFinalize } from "../src/core/storage-finalize.js";
import { decodeAbsorbedRow, encodeAbsorbedRow, readAbsorbedRows, runAbsorb } from "../src/core/storage-absorb.js";
import { historyDbPath, migrateHistoryStore, openHistoryStore } from "../src/core/history-store.js";
import { migrateJobArchives } from "../src/core/job-archive-migration.js";
import { runStorage } from "../src/cli/storage.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
const closes: (() => void)[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { for (const close of closes.splice(0).reverse()) close(); await env.cleanup(); });

/** A verified v2 home with a completed job archive, as finalize expects. */
async function verifiedHome(): Promise<void> {
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
  const history = openHistoryStore(historyDbPath(env.db));
  try { await migrateHistoryStore(env.db, history); } finally { history.close(); }
  await migrateJobArchives(join(env.home, "jobs.json"));
}

function copyOfBridge(path: string, extra?: (db: DatabaseSync) => void): void {
  const live = new DatabaseSync(env.db);
  try { live.prepare("VACUUM INTO ?").run(path); } finally { live.close(); }
  if (!extra) return;
  const copy = new DatabaseSync(path);
  // Keep the fixtures to the rows each test names (message triggers would add envelope and pending-history rows).
  try {
    for (const t of copy.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='messages'").all()) copy.exec(`DROP TRIGGER "${String(t.name)}"`);
    extra(copy);
  } finally { copy.close(); }
}

const big = 2n ** 62n + 7n;

it("a backup holding purged messages is kept before absorb, and removable after it with the messages readable in archive.db", async () => {
  await verifiedHome();
  const backup = join(env.home, "bridge.db.backup-2-purged");
  copyOfBridge(backup, db => {
    db.prepare("INSERT INTO messages VALUES('m0','purged by an old version','codex','codex-a','a','claude-b','claude-b',0)").run();
    db.prepare("INSERT INTO messages VALUES('m2',?,'codex','codex-a','a','claude-b','claude-b',?)").run("second purged message", big);
    // A table this version no longer has, with exact integer, real, blob and NULL values.
    db.exec("CREATE TABLE old_feature(a INTEGER, b REAL, c BLOB, d TEXT)");
    db.prepare("INSERT INTO old_feature VALUES(?,?,?,NULL)").run(big, 1.5, Buffer.from([0, 255, 1]));
  });
  expect(planFinalize(env.home, { prove: true }).kept.find(i => i.path === backup)?.reason).toMatch(/messages: 2 of 3 rows.*storage absorb/);

  const dry = runAbsorb(env.home);
  expect(dry).toMatchObject({ applied: false, rows: 3, conflicts: 0 });
  expect(existsSync(join(env.home, "archive.db"))).toBe(false);

  const applied = runAbsorb(env.home, { apply: true, batchRows: 1 });
  expect(applied).toMatchObject({ applied: true, rows: 3, conflicts: 0, blockers: [] });
  // Re-running absorbs nothing more.
  expect(runAbsorb(env.home, { apply: true })).toMatchObject({ rows: 0, conflicts: 0 });

  const archive = new DatabaseSync(join(env.home, "archive.db"), { readOnly: true }); closes.push(() => archive.close());
  expect(archive.prepare("SELECT body FROM messages WHERE id='m0' AND recipient='claude-b'").get()!.body).toBe("purged by an old version");
  const m2 = archive.prepare("SELECT created_at FROM messages WHERE id='m2'"); m2.setReadBigInts(true);
  expect(m2.get()!.created_at).toBe(big);
  const exact = readAbsorbedRows(env.home, "old_feature");
  expect(exact).toHaveLength(1);
  expect(exact[0]!.a).toBe(big);
  expect(exact[0]!.b).toBe(1.5);
  expect((exact[0]!.c as Buffer).equals(Buffer.from([0, 255, 1]))).toBe(true);
  expect(exact[0]!.d).toBeNull();
  expect(readAbsorbedRows(env.home, "messages").map(r => r.id).sort()).toEqual(["m0", "m2"]);

  const proven = planFinalize(env.home, { prove: true });
  expect(proven.kept.find(i => i.path === backup)?.reason).toBeUndefined();
  expect(proven.items.map(i => i.path)).toContain(backup);
  closes.splice(0).forEach(close => close());
  expect(runFinalize(env.home, () => {}).ready).toBe(true);
  expect(existsSync(backup)).toBe(false);
  const after = new DatabaseSync(join(env.home, "archive.db"), { readOnly: true }); closes.push(() => after.close());
  expect(after.prepare("SELECT body FROM messages WHERE id='m0'").get()!.body).toBe("purged by an old version");
});

it("a conflicting row is never imported or overwritten; its backup stays and is reported", async () => {
  await verifiedHome();
  const backup = join(env.home, ".migration-snapshots", "bridge.db.backup-3-conflict");
  copyOfBridge(backup, db => {
    db.prepare("UPDATE messages SET body='a different body for the same id' WHERE id='m1'").run();
    db.prepare("INSERT INTO messages VALUES('m9','only here','codex','codex-a','a','claude-b','claude-b',9)").run();
  });
  const result = runAbsorb(env.home, { apply: true });
  expect(result).toMatchObject({ rows: 1, conflicts: 1 });
  // Every run reports the conflict again; nothing more is imported.
  expect(runAbsorb(env.home, { apply: true })).toMatchObject({ rows: 0, conflicts: 1 });
  const plan = planFinalize(env.home, { prove: true });
  expect(plan.items.map(i => i.path)).not.toContain(backup);
  expect(plan.kept.find(i => i.path === backup)?.reason).toMatch(/messages: 1 rows conflict/);
  runFinalize(env.home, () => {});
  expect(existsSync(backup)).toBe(true);
  const bridge = new DatabaseSync(env.db, { readOnly: true }); closes.push(() => bridge.close());
  expect(bridge.prepare("SELECT body FROM messages WHERE id='m1'").get()!.body).toBe("kept message");
  const archive = new DatabaseSync(join(env.home, "archive.db"), { readOnly: true }); closes.push(() => archive.close());
  expect(archive.prepare("SELECT count(*) n FROM messages WHERE id='m1'").get()!.n).toBe(0);
  expect(archive.prepare("SELECT body FROM messages WHERE id='m9'").get()!.body).toBe("only here");
});

it("absorbs files that exist only in a pending backup byte-exact, so the folder becomes removable", async () => {
  await verifiedHome();
  const pending = join(env.home, "backups", ".pending-snapshot-9");
  mkdirSync(pending, { recursive: true });
  copyOfBridge(join(pending, "bridge.db"));
  const bytes = Buffer.from([0x7b, 0x00, 0xff, 0x7d]);
  writeFileSync(join(pending, "runs.json"), bytes);
  expect(planFinalize(env.home, { prove: true }).kept.find(i => i.path === pending)?.reason).toMatch(/runs\.json/);
  expect(runAbsorb(env.home, { apply: true })).toMatchObject({ files: 1, rows: 0 });
  const archive = new DatabaseSync(join(env.home, "archive.db"), { readOnly: true });
  try { expect(Buffer.from(archive.prepare("SELECT bytes FROM absorbed_files").get()!.bytes as Uint8Array).equals(bytes)).toBe(true); }
  finally { archive.close(); }
  expect(planFinalize(env.home, { prove: true }).items.map(i => i.path)).toContain(pending);
  runFinalize(env.home, () => {});
  expect(existsSync(pending)).toBe(false);
});

it("resumes from the last committed batch after an interruption", async () => {
  await verifiedHome();
  // The migration's own snapshots are complete already; finished tables are not read again.
  expect(runAbsorb(env.home, { apply: true }).rows).toBe(0);
  const backup = join(env.home, "bridge.db.backup-4-many");
  const db = new DatabaseSync(backup);
  db.exec("CREATE TABLE messages(id TEXT,body TEXT,from_agent TEXT,from_name TEXT,from_id TEXT,recipient TEXT,to_target TEXT,created_at INTEGER)");
  for (let i = 0; i < 25; i++) db.prepare("INSERT INTO messages VALUES(?,?,'codex','codex-a','a','claude-b','claude-b',?)").run(`p${i}`, `purged ${i}`, i);
  db.close();
  let batches = 0;
  const { DatabaseSync: Db } = await import("node:sqlite");
  const exec = Db.prototype.exec;
  // Fail the fourth batch commit, as a crash would.
  Db.prototype.exec = function (this: DatabaseSync, sql: string) { if (sql === "COMMIT" && ++batches === 4) throw new Error("simulated crash"); return exec.call(this, sql); };
  try { expect(() => runAbsorb(env.home, { apply: true, batchRows: 5 })).toThrow("simulated crash"); }
  finally { Db.prototype.exec = exec; }
  const archive = () => { const db = new DatabaseSync(join(env.home, "archive.db"), { readOnly: true }); try { return Number(db.prepare("SELECT count(*) n FROM messages").get()!.n); } finally { db.close(); } };
  expect(archive()).toBe(15);
  expect(runAbsorb(env.home, { apply: true, batchRows: 5 }).rows).toBe(10);
  expect(archive()).toBe(25);
  expect(planFinalize(env.home, { prove: true }).items.map(i => i.path)).toContain(backup);
});

it("round-trips every SQLite value type exactly", () => {
  const row = { a: big, b: -0.25, c: "text ü", d: Buffer.from([1, 2, 3]), e: null, f: 7 };
  const back = decodeAbsorbedRow(encodeAbsorbedRow(row, Object.keys(row)));
  expect(back).toEqual({ a: big, b: -0.25, c: "text ü", d: Buffer.from([1, 2, 3]), e: null, f: 7n });
});

it("the CLI lists before importing and imports with --yes", async () => {
  await verifiedHome();
  copyOfBridge(join(env.home, "bridge.db.backup-5"), db => db.prepare("INSERT INTO messages VALUES('m5','purged','codex','codex-a','a','claude-b','claude-b',5)").run());
  const lines: string[] = [];
  expect(runStorage(["absorb"], env.home, l => lines.push(l))).toBe(0);
  expect(lines.join("\n")).toMatch(/1 rows and 0 files exist only in old copies/);
  expect(runStorage(["absorb", "--yes"], env.home, l => lines.push(l))).toBe(0);
  expect(lines.join("\n")).toMatch(/1 rows and 0 files imported into archive\.db/);
});
