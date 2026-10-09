import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { planFinalize, runFinalize } from "../src/core/storage-finalize.js";
import { historyDbPath, migrateHistoryStore, openHistoryStore } from "../src/core/history-store.js";
import { migrateJobArchives } from "../src/core/job-archive-migration.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.cleanup(); });

const RECORDS = 1500;

/** A migrated home with many legacy transcript records (compressed in v2), as on a real machine. */
async function bigHome(pending = false): Promise<string> {
  const old = new DatabaseSync(env.db);
  const { historySchema } = await import("../src/core/history-schema.js");
  const { CONVERSATION_SCHEMA } = await import("../src/core/conversation-schema.js");
  old.exec("CREATE TABLE messages(id TEXT,body TEXT,from_agent TEXT,from_name TEXT,from_id TEXT,recipient TEXT,to_target TEXT,created_at INTEGER, PRIMARY KEY(id,recipient))");
  old.exec(historySchema()); old.exec(CONVERSATION_SCHEMA); old.exec("PRAGMA journal_mode=WAL");
  for (const t of old.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='messages'").all()) old.exec(`DROP TRIGGER "${String(t.name)}"`);
  old.exec("BEGIN");
  old.prepare("INSERT INTO conversations(id,agent,session) VALUES('codex:a','codex','a')").run();
  const raw = (i: number) => Buffer.from(JSON.stringify({ type: "message", text: `record ${i} ${"transcript words ".repeat(40)}` }));
  for (let i = 0; i < RECORDS; i++) old.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('s',0,?,'codex:a',?,?,'')").run(i, i, raw(i));
  for (let i = 0; i < 300; i++) old.prepare("INSERT INTO messages VALUES(?,?,'codex','codex-a','a','claude-b','claude-b',?)").run(`m${i}`, `message ${i}`, i);
  if (pending) old.prepare("INSERT INTO history_pending VALUES('p1','pending body','codex','codex-a','a','claude-b','claude-b',1)").run();
  old.exec("COMMIT");
  old.close();
  const history = openHistoryStore(historyDbPath(env.db));
  try { await migrateHistoryStore(env.db, history); } finally { history.close(); }
  await migrateJobArchives(join(env.home, "jobs.json"));
  const snapshots = join(env.home, ".migration-snapshots");
  return join(snapshots, readdirSync(snapshots).find(name => /^history-v2-source-.*\.db$/.test(name))!);
}

function copyOfBridge(path: string): void {
  const live = new DatabaseSync(env.db);
  try { live.prepare("VACUUM INTO ?").run(path); } finally { live.close(); }
}

/** Statement executions (each get/all/iterate call is one query, an indexed lookup or a scan). */
function countQueries() {
  const calls = { n: 0 };
  for (const method of ["get", "all", "iterate", "run"] as const) {
    const original = StatementSync.prototype[method] as (...args: unknown[]) => unknown;
    vi.spyOn(StatementSync.prototype, method).mockImplementation(function (this: StatementSync, ...args: unknown[]) { calls.n++; return original.apply(this, args); } as never);
  }
  return calls;
}

it("the plan without --yes reads no rows: its query count does not grow with the data", async () => {
  const reference = await bigHome();
  copyOfBridge(join(env.home, "bridge.db.backup-1-copy"));
  const calls = countQueries();
  const plan = planFinalize(env.home);
  expect(plan.proven).toBe(false);
  expect(plan.items.map(i => i.path)).toEqual(expect.arrayContaining([reference, join(env.home, "bridge.db.backup-1-copy"), "bridge.db:conversation_records"]));
  expect(plan.items.find(i => i.path === reference)!.reason).toMatch(/proven by the migration manifest/);
  // A handful of catalog and state queries; per-row work would be thousands.
  expect(calls.n).toBeLessThan(80);
});

it("the proof reads sequentially: no per-row lookups for the legacy history, the snapshot and a backup copy", async () => {
  const reference = await bigHome();
  const backup = join(env.home, "bridge.db.backup-1-copy");
  copyOfBridge(backup);
  const calls = countQueries();
  const plan = runFinalize(env.home, () => {}, { dryRun: true });
  vi.restoreAllMocks();
  expect(plan.blockers).toEqual([]);
  expect(plan.items.map(i => i.path)).toEqual(expect.arrayContaining([reference, backup, "bridge.db:conversation_records"]));
  // 1,500 records and 300 messages in each of three copies: a lookup per row would be well over 5,000 queries.
  expect(calls.n).toBeLessThan(1500);
  // Nothing was removed by the dry run.
  const bridge = new DatabaseSync(env.db, { readOnly: true });
  try { expect(bridge.prepare("SELECT count(*) n FROM conversation_records").get()!.n).toBe(RECORDS); } finally { bridge.close(); }
});

it("proves the verified migration's source snapshot by its manifest, and keeps it when its bytes no longer match", async () => {
  const reference = await bigHome(true);
  // The live stores drained the pending row since the migration: only the snapshot (and a copy) still hold it.
  const history = new DatabaseSync(historyDbPath(env.db));
  try { history.exec("DELETE FROM history_pending"); } finally { history.close(); }
  const bridge = new DatabaseSync(env.db);
  try { bridge.exec("DELETE FROM history_pending"); } finally { bridge.close(); }
  const backup = join(env.home, "bridge.db.backup-2-copy");
  copyOfBridge(backup);
  const copy = new DatabaseSync(backup);
  try { copy.prepare("INSERT INTO history_pending VALUES('p1','pending body','codex','codex-a','a','claude-b','claude-b',1)").run(); } finally { copy.close(); }
  let plan = runFinalize(env.home, () => {}, { dryRun: true });
  // The snapshot is exactly what the verified migration copied; the other copy needs a live row (or absorb).
  expect(plan.items.map(i => i.path)).toContain(reference);
  expect(plan.kept.find(i => i.path === backup)?.reason).toMatch(/history_pending: 1 of 1 rows are not in/);
  // Changed after the migration verified it: the manifest no longer vouches for that table, which is then proven row
  // by row, and the drained row keeps the snapshot.
  const tampered = new DatabaseSync(reference);
  try { tampered.prepare("INSERT INTO history_pending VALUES('p2','added later','codex','codex-a','a','claude-b','claude-b',2)").run(); } finally { tampered.close(); }
  const lines: string[] = [];
  plan = runFinalize(env.home, line => lines.push(line), { dryRun: true });
  expect(lines.join("\n")).toMatch(/history_pending: 2 rows with sha256 .* but the verified migration copied 1 rows/);
  expect(plan.kept.find(i => i.path === reference)?.reason).toMatch(/history_pending: 2 of 2 rows are not in/);
});
