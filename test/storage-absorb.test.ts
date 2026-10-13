import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fileCandidates, planFinalize, referenceSnapshot, runFinalize, type FinalizePlan } from "../src/core/storage-finalize.js";
import { candidateRows, fileSha256, provableTables, rowDigest, tableProof } from "../src/core/finalize-proof.js";
import { decodeAbsorbedRow, encodeAbsorbedRow, readAbsorbedRows, runAbsorb, type AbsorbResult } from "../src/core/storage-absorb.js";
import { historyDbPath, migrateHistoryStore, openHistoryStore } from "../src/core/history-store.js";
import { migrateJobArchives } from "../src/core/job-archive-migration.js";
import { runStorage } from "../src/cli/storage.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
const closes: (() => void)[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { for (const close of closes.splice(0).reverse()) close(); await env.cleanup(); });

/** A verified v2 home with a completed job archive, as finalize expects. */
async function verifiedHome(pendingOnly = false): Promise<void> {
  const old = new DatabaseSync(env.db);
  const { historySchema } = await import("../src/core/history-schema.js");
  const { CONVERSATION_SCHEMA } = await import("../src/core/conversation-schema.js");
  old.exec("CREATE TABLE messages(id TEXT,body TEXT,from_agent TEXT,from_name TEXT,from_id TEXT,recipient TEXT,to_target TEXT,created_at INTEGER)");
  old.exec("CREATE TABLE decisions(id TEXT)");
  old.exec(historySchema()); old.exec(CONVERSATION_SCHEMA); old.exec("PRAGMA journal_mode=WAL");
  if (pendingOnly) {
    old.prepare("INSERT INTO history_pending VALUES('p1','pending-only payload ü','codex','codex-a','a','claude-b','claude-b',1)").run();
  } else {
    old.prepare("INSERT INTO messages VALUES('m1','kept message','codex','codex-a','a','claude-b','claude-b',1)").run();
    old.prepare("INSERT INTO conversations(id,agent,session) VALUES('codex:a','codex','a')").run();
    old.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('s',0,0,'codex:a',1,?,'x')").run(Buffer.from("record bytes"));
  }
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

it("AB-228: CLI retains a manifest-covered sole-copy pending row until exact absorption", async () => {
  await verifiedHome(true);
  const history = new DatabaseSync(historyDbPath(env.db));
  let reference: string;
  try {
    const state = referenceSnapshot(history)!;
    expect(state.manifest.history_pending!.rows).toBe(1);
    reference = state.path;
    expect(history.prepare("SELECT count(*) n FROM history_pending").get()!.n).toBe(1);
    // These are generated fixture stores only. No backup or other message carries p1.
    history.exec("DELETE FROM history_pending WHERE id='p1'");
    expect(history.prepare("SELECT count(*) n FROM history_pending").get()!.n).toBe(0);
  } finally { history.close(); }
  const bridge = new DatabaseSync(env.db);
  try {
    expect(bridge.prepare("SELECT count(*) n FROM messages").get()!.n).toBe(0);
    expect(bridge.prepare("SELECT count(*) n FROM history_pending").get()!.n).toBe(1);
    bridge.exec("DELETE FROM history_pending WHERE id='p1'");
    expect(bridge.prepare("SELECT count(*) n FROM history_pending").get()!.n).toBe(0);
  } finally { bridge.close(); }
  // The product's job migration also creates an empty pre-DDL snapshot. Prove it has no user tables:
  // the unchanged history snapshot is the sole payload copy, with no second history backup.
  const candidates = fileCandidates(env.home).map(c => c.item.path);
  expect(candidates).toHaveLength(2);
  expect(candidates).toContain(reference);
  const emptyJobSnapshot = candidates.find(path => path !== reference)!;
  expect(emptyJobSnapshot).toMatch(/job-archive\.db\.backup-.*-v0-to-v1$/);
  const empty = new DatabaseSync(emptyJobSnapshot, { readOnly: true });
  try { expect(provableTables(empty)).toEqual([]); } finally { empty.close(); }
  const exact = { id: "p1", body: "pending-only payload ü", from_agent: "codex", from_name: "codex-a",
    from_id: "a", recipient: "claude-b", to_target: "claude-b", created_at: 1n };
  const sha = fileSha256(reference);
  const assertSnapshot = () => {
    expect(existsSync(reference)).toBe(true);
    expect(fileSha256(reference)).toBe(sha);
    const db = new DatabaseSync(reference, { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) n FROM history_pending").get()!.n).toBe(1);
      const row = db.prepare("SELECT * FROM history_pending"); row.setReadBigInts(true);
      expect({ ...row.get() }).toEqual(exact);
    } finally { db.close(); }
  };
  const cli = <T>(args: string[]): T => {
    const lines: string[] = [];
    expect(runStorage([...args, "--json"], env.home, line => lines.push(line))).toBe(0);
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]!) as T;
  };
  const assertKept = (plan: FinalizePlan) => {
    expect(plan).toMatchObject({ ready: true, proven: true, blockers: [] });
    expect(plan.items.map(i => i.path)).not.toContain(reference);
    expect(plan.kept.find(i => i.path === reference)?.reason).toMatch(/history_pending: 1 of 1 rows are not in/);
    assertSnapshot();
  };
  assertKept(cli<FinalizePlan>(["finalize", "--check"]));
  assertKept(cli<FinalizePlan>(["finalize", "--yes"]));
  expect(cli<AbsorbResult>(["absorb"])).toMatchObject({ applied: false, rows: 1, files: 0, conflicts: 0, blockers: [] });
  assertSnapshot();
  expect(existsSync(join(env.home, "archive.db"))).toBe(false);
  expect(cli<AbsorbResult>(["absorb", "--yes"])).toMatchObject({ applied: true, rows: 1, files: 0, conflicts: 0, blockers: [] });
  expect(readAbsorbedRows(env.home, "history_pending")).toEqual([exact]);
  assertSnapshot();
  const checked = cli<FinalizePlan>(["finalize", "--check"]);
  expect(checked.kept.find(i => i.path === reference)).toBeUndefined();
  expect(checked.items.map(i => i.path)).toContain(reference);
  assertSnapshot();
  const finalized = cli<FinalizePlan>(["finalize", "--yes"]);
  expect(finalized).toMatchObject({ ready: true, proven: true, blockers: [] });
  expect(finalized.kept.find(i => i.path === reference)).toBeUndefined();
  expect(finalized.items.map(i => i.path)).toContain(reference);
  expect(existsSync(reference)).toBe(false);
  expect(readAbsorbedRows(env.home, "history_pending")).toEqual([exact]);
});

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
  expect(back).toEqual({ a: big, b: -0.25, c: "text ü", d: Buffer.from([1, 2, 3]), e: null, f: 7 });
});

it("AB-215 absorption boundary: unsupported views fail without mutation while BLOB subarray bytes stay exact", () => {
  const bytes = Buffer.from([0xaa, 0xff, 0xfe, 0xbb]), before = Buffer.from(bytes);
  const slice = new Uint8Array(bytes.buffer, bytes.byteOffset + 1, 2);
  expect(decodeAbsorbedRow(encodeAbsorbedRow({ payload: slice }, ["payload"])).payload).toEqual(Buffer.from([0xff, 0xfe]));
  expect(decodeAbsorbedRow(encodeAbsorbedRow({ payload: bytes.subarray(1, 3) }, ["payload"])).payload).toEqual(Buffer.from([0xff, 0xfe]));
  for (const view of [new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), new Uint16Array(new Uint8Array([1, 2, 3, 4]).buffer)]) {
    const original = Buffer.from(view.buffer, view.byteOffset, view.byteLength), copy = Buffer.from(original);
    expect(() => encodeAbsorbedRow({ payload: view }, ["payload"])).toThrow(/Unsupported stored value/);
    expect(Buffer.from(view.buffer, view.byteOffset, view.byteLength)).toEqual(copy);
  }
  expect(bytes).toEqual(before);
});

it("AB-215 absorption boundary: integral REAL stays REAL and its exact stored receipt proves survival", async () => {
  await verifiedHome();
  const backup = join(env.home, "bridge.db.backup-215-real"), db = new DatabaseSync(backup); closes.push(() => db.close());
  db.exec("CREATE TABLE numeric_row(id INTEGER PRIMARY KEY,payload,optional); INSERT INTO numeric_row VALUES(1,1.0,NULL)");
  const before = db.prepare("SELECT typeof(payload) t,payload FROM numeric_row").get()!;
  expect(before.t).toBe("real");
  const applied = runAbsorb(env.home, { apply: true });
  expect(applied.sources.find(s => s.path === backup)?.problems).toEqual([]);
  const exported = readAbsorbedRows(env.home, "numeric_row");
  expect(exported).toEqual([{ id: 1n, payload: 1, optional: null }]);
  expect(typeof exported[0]!.payload).toBe("number");
  const archive = new DatabaseSync(join(env.home, "archive.db")); closes.push(() => archive.close());
  expect(JSON.parse(String(archive.prepare("SELECT row FROM absorbed_rows WHERE source_table='numeric_row'").get()!.row)).values[1]).toEqual({ r: 1 });
  expect(planFinalize(env.home, { prove: true }).items.map(i => i.path)).toContain(backup);
  expect(db.prepare("SELECT typeof(payload) t,payload FROM numeric_row").get()).toEqual(before);
});

it.each(["integer-receipt", "malformed-json", "missing-column"] as const)("AB-215 absorption boundary: %s cannot authorize removal or OR IGNORE success", async kind => {
  await verifiedHome(); runAbsorb(env.home, { apply: true });
  const backup = join(env.home, "bridge.db.backup-216-invalid"), db = new DatabaseSync(backup); closes.push(() => db.close());
  db.exec("CREATE TABLE numeric_row(id INTEGER PRIMARY KEY,payload); INSERT INTO numeric_row VALUES(1,1.0)");
  const p = tableProof(db, "numeric_row", { live: [] }), row = [...candidateRows(db, "numeric_row")][0]!;
  const digest = p.digest(row), before = p.storedDigest(row);
  const payload = kind === "integer-receipt" ? '{"columns":["id","payload"],"values":[{"i":"1"},{"i":"1"}]}' : kind === "malformed-json" ? '{bad' : '{"columns":["id"],"values":[{"i":"1"}]}';
  const archive = new DatabaseSync(join(env.home, "archive.db")); closes.push(() => archive.close());
  archive.prepare("INSERT INTO absorbed_rows VALUES('numeric_row',?,?,?,1)").run(digest, payload, "legacy");
  // A historical completion flag must not bypass validation of the lossy receipt.
  const st = statSync(backup), sig = `${backup}|${st.size}|${Math.trunc(st.mtimeMs)}`;
  archive.prepare("INSERT INTO absorb_progress VALUES(?,'numeric_row',1,1)").run(sig);
  for (const check of [() => planFinalize(env.home, { prove: true }), () => runFinalize(env.home, () => {}, { dryRun: true }), () => runFinalize(env.home, () => {})]) {
    expect(check().kept.map(i => i.path)).toContain(backup);
    expect(p.storedDigest([...candidateRows(db, "numeric_row")][0]!)).toBe(before);
    expect(db.prepare("SELECT typeof(payload) t FROM numeric_row").get()!.t).toBe("real");
  }
  const applied = runAbsorb(env.home, { apply: true });
  const source = applied.sources.find(s => s.path === backup)!;
  expect(source.rows).toBe(0); expect(source.problems.join(" ")).toMatch(/conflicts/);
  expect(archive.prepare("SELECT row FROM absorbed_rows WHERE source_table='numeric_row' AND digest=?").get(digest)!.row).toBe(payload);
  expect(archive.prepare("SELECT after_rowid,done FROM absorb_progress WHERE source=? AND table_name='numeric_row'").get(sig)).toEqual({ after_rowid: -1, done: 0 });
  const repeated = runAbsorb(env.home, { apply: true }).sources.find(s => s.path === backup)!;
  expect(repeated.rows).toBe(0); expect(repeated.problems.join(" ")).toMatch(/conflicts/);
  expect(archive.prepare("SELECT after_rowid,done FROM absorb_progress WHERE source=? AND table_name='numeric_row'").get(sig)).toEqual({ after_rowid: -1, done: 0 });
  expect(archive.prepare("SELECT row FROM absorbed_rows WHERE source_table='numeric_row' AND digest=?").get(digest)!.row).toBe(payload);
  expect(p.storedDigest([...candidateRows(db, "numeric_row")][0]!)).toBe(before);
  expect(planFinalize(env.home, { prove: true }).kept.map(i => i.path)).toContain(backup);
});

it("AB-215 absorption boundary: unsupported TEXT bytes preserve whole-row witnesses and stop before counts/cursor claims", async () => {
  await verifiedHome();
  const backup = join(env.home, "bridge.db.backup-217-text"), db = new DatabaseSync(backup); closes.push(() => db.close());
  db.exec("CREATE TABLE text_row(id INTEGER PRIMARY KEY,payload,__proof_text_0,__cid); INSERT INTO text_row VALUES(1,CAST(x'ff' AS TEXT),'extra','cid'); INSERT INTO text_row VALUES(2,'later','extra','cid')");
  const original = [...candidateRows(db, "text_row")];
  const before = original.map(r => rowDigest(r, Object.keys(r), false));
  expect(db.prepare("SELECT typeof(payload) t,hex(CAST(payload AS BLOB)) h FROM text_row WHERE id=1").get()).toEqual({ t: "text", h: "FF" });
  expect(() => encodeAbsorbedRow({ ...original[0]! }, Object.keys(original[0]!))).toThrow(/stored type\/bytes/);
  for (const apply of [false, true]) {
    const result = runAbsorb(env.home, { apply, batchRows: 1 }), source = result.sources.find(s => s.path === backup)!;
    expect(source.rows).toBe(0); expect(source.problems.join(" ")).toMatch(/stored type\/bytes/);
    expect([...candidateRows(db, "text_row")].map(r => rowDigest(r, Object.keys(r), false))).toEqual(before);
  }
  const archive = new DatabaseSync(join(env.home, "archive.db")); closes.push(() => archive.close());
  expect(archive.prepare("SELECT count(*) n FROM absorbed_rows WHERE source_table='text_row'").get()!.n).toBe(0);
  expect(archive.prepare("SELECT count(*) n FROM absorb_progress WHERE table_name='text_row'").get()!.n).toBe(0);
  expect(planFinalize(env.home, { prove: true }).kept.map(i => i.path)).toContain(backup);
  // Valid exact TEXT remains encodable/absorbable, with original byte class and payload retained.
  db.exec("UPDATE text_row SET payload='valid ü' WHERE id=1");
  const valid = [...candidateRows(db, "text_row")][0]!, json = encodeAbsorbedRow({ ...valid }, Object.keys(valid));
  expect(Object.keys(JSON.parse(json))).toEqual(["columns", "values"]);
  expect(JSON.parse(json).columns).toEqual(Object.keys(valid));
  expect(json).not.toContain("SQL stored-cell witnesses");
  expect(runAbsorb(env.home, { apply: true }).sources.find(s => s.path === backup)?.rows).toBe(2);
  expect(readAbsorbedRows(env.home, "text_row").some(r => r.payload === "valid ü")).toBe(true);
  expect(planFinalize(env.home, { prove: true }).items.map(i => i.path)).toContain(backup);
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
