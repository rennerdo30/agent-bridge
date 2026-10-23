import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeMetadataDbs, closeMetadataDb, existingMetadataDb, metadataDb } from "../src/core/metadata-db.js";
import * as snapshots from "../src/core/metadata-snapshot.js";
import { nullLogger } from "../src/core/logger.js";
import { migrateSqlite } from "../src/core/sqlite-migrations.js";
import { openArchive } from "../src/core/sqlite-maintenance.js";
import { openHistoryStore } from "../src/core/history-store.js";
import { historyStoreV2Schema } from "../src/core/history-schema-v2.js";
import { jobRunIndexReady } from "../src/core/job-run-index.js";
import { admissionSqliteBusy, storageAdmissionRemaining, withStorageAdmission } from "../src/core/storage-admission.js";

let home: string, now: number, cancelled: Error | undefined;
const timeout = Object.assign(new Error("controlled admission deadline"), { code: "timeout" });
const check = () => { if (cancelled) throw cancelled; if (now >= 2000) throw timeout; return 2000 - now; };
const handles = new Set<DatabaseSync>();
const busy = (db: DatabaseSync) => Number(db.prepare("PRAGMA busy_timeout").get()!.timeout);
beforeEach(() => { home = mkdtempSync(join(process.env.AGENT_BRIDGE_TEST_ROOT!, "admission-phase-")); now = 0; cancelled = undefined; });
afterEach(() => { vi.restoreAllMocks(); closeMetadataDbs(); for (const db of handles) db.close(); handles.clear(); rmSync(home, { recursive: true, force: true }); });

it.each(["snapshot", "schema", "schema-cancel", "release"])("refuses the next SQLite migration phase after a slow %s and retains original rows/backup", stage => {
  const file = join(home, "source.db"), db = new DatabaseSync(file); handles.add(db);
  db.exec("CREATE TABLE originals(id TEXT PRIMARY KEY, body BLOB, owner TEXT); INSERT INTO originals VALUES('accepted-uuid',x'00ff0a','original-owner'); PRAGMA user_version=1;");
  const original = db.prepare("SELECT * FROM originals").all(), traces: string[] = [];
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (this === db) traces.push(sql);
    const result = exec.call(this, sql);
    if (this === db && stage.startsWith("schema") && sql.includes("ALTER TABLE originals")) {
      if (stage === "schema-cancel") cancelled = Object.assign(new Error("owned cancellation"), { name: "AbortError" }); else now = 2001;
    }
    if (this === db && stage === "release" && sql === "RELEASE schema_migration") now = 2001;
    return result;
  });
  const log = { ...nullLogger, info: (event: string) => { if (stage === "snapshot" && event === "backed up store before migration") now = 2001; } };
  expect(() => withStorageAdmission(check, () => migrateSqlite(db, file, true, 2,
    [{ version: 2, backupTables: ["originals"], sql: "ALTER TABLE originals ADD COLUMN pending TEXT; UPDATE originals SET body='transient'; PRAGMA user_version=2;" }], log))).toThrow(stage === "schema-cancel" ? "owned cancellation" : timeout);
  expect(traces.some(sql => sql.includes("COMMIT"))).toBe(false);
  if (stage === "snapshot") expect(traces.some(sql => sql === "BEGIN IMMEDIATE" || sql.includes("ALTER TABLE originals"))).toBe(false);
  expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(1);
  expect(db.prepare("SELECT * FROM originals").all()).toEqual(original);
  expect(db.prepare("PRAGMA table_info(originals)").all().map(row => row.name)).toEqual(["id", "body", "owner"]);
  db.exec("BEGIN; ROLLBACK"); // No retained transaction or writer lock.
  const copies = readdirSync(join(home, ".migration-snapshots")).filter(name => name.endsWith(".db")); expect(copies).toHaveLength(1);
  const backup = new DatabaseSync(join(home, ".migration-snapshots", copies[0]!), { readOnly: true });
  try { expect(backup.prepare("SELECT * FROM originals").all()).toEqual(original); } finally { backup.close(); }
});

it("does not carry restoration authority over a close/reopen of the same database object", () => {
  const db = new DatabaseSync(join(home, "reopened.db")); handles.add(db); db.exec("PRAGMA busy_timeout=137");
  withStorageAdmission(check, () => { admissionSqliteBusy(db); db.close(); db.open(); db.exec("PRAGMA busy_timeout=71"); });
  expect(busy(db)).toBe(71);
});

it("nested admission cannot extend the original outer deadline and restores the cached policy", () => {
  const db = metadataDb(home); db.exec("PRAGMA busy_timeout=137");
  expect(() => withStorageAdmission(check, () => {
    metadataDb(home); withStorageAdmission(() => 10000, () => { now = 2001; metadataDb(home); });
  })).toThrow(timeout);
  expect(busy(db)).toBe(137);
});

it("does not let nested job-index discovery replace the admission cap or the cached handle's ordinary policy", () => {
  const db = metadataDb(home); db.exec("PRAGMA busy_timeout=137");
  const exec = db.exec, policies: number[] = [];
  vi.spyOn(db, "exec").mockImplementation(sql => { exec.call(db, sql); policies.push(busy(db)); });
  withStorageAdmission(check, () => { expect(jobRunIndexReady(home)).toBe(false); expect(busy(db)).toBe(0); });
  expect(policies).not.toContain(40); // The ordinary nonbroker discovery cap cannot escape the current scope.
  expect(busy(db)).toBe(137);
});

it.each(["snapshot", "schema"])("fences metadata component migration after a slow %s without losing original snapshot/rows", stage => {
  const file = join(home, "bridge.db"), seed = new DatabaseSync(file);
  seed.exec("CREATE TABLE original_owner_data(id TEXT, body BLOB); INSERT INTO original_owner_data VALUES('accepted-uuid',x'00ff0a')"); seed.close();
  let source: DatabaseSync | undefined, completedSnapshot = false; const traces: string[] = [];
  const snapshot = snapshots.snapshotMetadataTables;
  vi.spyOn(snapshots, "snapshotMetadataTables").mockImplementation((...args) => {
    source = args[0]; snapshot(...args); completedSnapshot = true; if (stage === "snapshot") now = 2001;
  });
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (this === source && completedSnapshot) traces.push(sql);
    const result = exec.call(this, sql);
    if (this === source && completedSnapshot && stage === "schema" && sql.includes("CREATE TABLE") && sql.includes("bridge_components")) now = 2001;
    return result;
  });
  expect(() => withStorageAdmission(check, () => metadataDb(home))).toThrow(timeout);
  expect(traces).not.toContain("COMMIT");
  if (stage === "snapshot") expect(traces).not.toContain("BEGIN IMMEDIATE");
  const inspect = new DatabaseSync(file, { readOnly: true });
  try {
    expect(inspect.prepare("SELECT hex(body) AS body,id FROM original_owner_data").all()).toEqual([{ body: "00FF0A", id: "accepted-uuid" }]);
    expect(inspect.prepare("SELECT name FROM sqlite_master WHERE name='bridge_components'").get()).toBeUndefined();
  } finally { inspect.close(); }
  expect(readdirSync(join(home, ".migration-snapshots")).some(name => name.endsWith(".manifest.json"))).toBe(true);
});

it.each(["begin", "schema"])("rolls back the actual history constructor after a slow %s without committing another phase", stage => {
  const file = join(home, "history.db"), seed = new DatabaseSync(file);
  seed.exec("CREATE TABLE accepted_original(id TEXT,body BLOB); INSERT INTO accepted_original VALUES('original-uuid',x'00ff0a')"); seed.close();
  const traces: string[] = [], schema = historyStoreV2Schema(), exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    traces.push(sql); const result = exec.call(this, sql);
    if (stage === "begin" && sql === "BEGIN IMMEDIATE" || stage === "schema" && sql === schema) now = 2001;
    return result;
  });
  expect(() => withStorageAdmission(check, () => openHistoryStore(file))).toThrow(timeout);
  expect(traces).not.toContain("COMMIT"); if (stage === "begin") expect(traces).not.toContain(schema);
  const inspect = new DatabaseSync(file);
  try {
    expect(inspect.prepare("PRAGMA user_version").get()!.user_version).toBe(0);
    expect(inspect.prepare("SELECT id,hex(body) AS body FROM accepted_original").all()).toEqual([{ id: "original-uuid", body: "00FF0A" }]);
    expect(inspect.prepare("SELECT name FROM sqlite_master WHERE name='conversation_records'").get()).toBeUndefined();
    inspect.exec("BEGIN IMMEDIATE; ROLLBACK");
  } finally { inspect.close(); }
});

it.each(["success", "failure", "cancel"])("restores exact cached metadata busy policy after admission %s", result => {
  const db = metadataDb(home); db.exec("PRAGMA busy_timeout=137"); const failure = new Error("owned callback failure");
  const effect = () => withStorageAdmission(check, () => {
    expect(metadataDb(home)).toBe(db); expect(existingMetadataDb(home)).toBe(db); expect(busy(db)).toBe(0);
    if (result === "failure") throw failure;
    if (result === "cancel") { now = 2001; storageAdmissionRemaining(); }
  });
  if (result === "success") effect(); else expect(effect).toThrow(result === "failure" ? failure : timeout);
  expect(busy(db)).toBe(137);
  // Model one short writer at the native SQL boundary, without real contention.
  // Zero wait would refuse; the restored ordinary policy permits this one write.
  let held = true; const exec = db.exec;
  vi.spyOn(db, "exec").mockImplementation(sql => {
    if (sql.includes("INSERT INTO accepted_after_admission") && held) {
      if (busy(db) === 0) throw Object.assign(new Error("database is locked"), { errcode: 5 });
      held = false;
    }
    exec.call(db, sql);
  });
  db.exec("CREATE TABLE accepted_after_admission(value TEXT); INSERT INTO accepted_after_admission VALUES('original')");
  expect(held).toBe(false);
  expect(db.prepare("SELECT value FROM accepted_after_admission").get()!.value).toBe("original");
});

it("keeps nested and reentrant captures zero until the original outer scope finishes", () => {
  const db = metadataDb(home); db.exec("PRAGMA busy_timeout=137");
  withStorageAdmission(check, () => {
    withStorageAdmission(check, () => { expect(existingMetadataDb(home)).toBe(db); expect(busy(db)).toBe(0); });
    expect(busy(db)).toBe(0); expect(metadataDb(home)).toBe(db);
    expect(() => withStorageAdmission(check, () => { metadataDb(home); throw new Error("inner failure"); })).toThrow("inner failure");
    expect(busy(db)).toBe(0);
  });
  expect(busy(db)).toBe(137);
});

it.each([0, 41])("preserves a legitimate reentrant policy update to %s instead of overwriting it", policy => {
  const db = metadataDb(home); db.exec("PRAGMA busy_timeout=137");
  withStorageAdmission(check, () => {
    metadataDb(home); db.exec(`PRAGMA busy_timeout=${policy}`);
    withStorageAdmission(check, () => { metadataDb(home); expect(busy(db)).toBe(0); });
  });
  expect(busy(db)).toBe(policy);
});

it("establishes ordinary policy on new returned archive/history handles after nested admission", () => {
  mkdirSync(join(home, "stores")); let archive!: DatabaseSync, history!: DatabaseSync;
  withStorageAdmission(check, () => {
    withStorageAdmission(check, () => {
      archive = openArchive(join(home, "stores", "archive.db")); handles.add(archive);
      history = openHistoryStore(join(home, "stores", "history.db")); handles.add(history);
      expect(busy(archive)).toBe(0); expect(busy(history)).toBe(0);
    });
    expect(busy(archive)).toBe(0); expect(busy(history)).toBe(0);
  });
  expect(busy(archive)).toBe(3000); expect(busy(history)).toBe(3000);
});

it("never restores a closed handle or a different connection to the same database", () => {
  const db = metadataDb(home); db.exec("PRAGMA busy_timeout=137"); let replacement!: DatabaseSync;
  withStorageAdmission(check, () => {
    metadataDb(home); closeMetadataDb(home);
    replacement = new DatabaseSync(join(home, "bridge.db")); handles.add(replacement); replacement.exec("PRAGMA busy_timeout=71");
  });
  expect(busy(replacement)).toBe(71);
});
