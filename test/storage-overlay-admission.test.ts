import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachStoreCompatibility } from "../src/core/store-compatibility-overlay.js";
import { MessageStore } from "../src/core/store.js";
import * as migrations from "../src/core/sqlite-migrations.js";
import { withStorageAdmission } from "../src/core/storage-admission.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv, db: DatabaseSync, now: number;
const timeout = Object.assign(new Error("original overlay admission expired"), { code: "timeout" });
const check = () => { if (now >= 2000) throw timeout; return 2000 - now; };
const tables = ["session_bindings", "peer_names", "peer_name_owners", "job_delivery_routes", "peer_last_seen"];
const rows = () => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM main.${table}`).all()]));
beforeEach(() => {
  env = makeEnv(); now = 0;
  const canonical = new MessageStore(env.db, nullLogger); canonical.close();
  const seed = new DatabaseSync(env.db);
  try {
    attachStoreCompatibility(seed, env.db, nullLogger, true);
    seed.exec(`INSERT INTO store_compatibility.session_bindings VALUES('source-owner','native-session',9);
      INSERT INTO store_compatibility.peer_names VALUES('source-owner','intended-recipient','native-session','codex',9);
      INSERT INTO store_compatibility.peer_name_owners VALUES('intended-recipient','source-owner');
      INSERT INTO store_compatibility.job_delivery_routes VALUES('original-uuid','intended-recipient',NULL);
      INSERT INTO store_compatibility.peer_last_seen VALUES('intended-recipient',9);
      CREATE TABLE store_compatibility.retained_proof(id TEXT,body BLOB,owner TEXT,namespace TEXT,direction TEXT);
      INSERT INTO store_compatibility.retained_proof VALUES('original-uuid',x'00ff04','source-owner','authenticated-host/fingerprint','remote');`);
  } finally { seed.close(); }
  db = new DatabaseSync(env.db);
});
afterEach(async () => { vi.restoreAllMocks(); db.close(); await env.cleanup(); });

it.each(["initialize", "close", "attach", "begin", "adopt", "before-commit"])("refuses the next adoption phase after slow %s and retains exact original sidecar/proofs", phase => {
  const sidecar = join(env.home, "store-compatibility.db"), original = readFileSync(sidecar), before = rows(), traces: string[] = [];
  const migrate = migrations.migrateSqlite, exec = DatabaseSync.prototype.exec, close = DatabaseSync.prototype.close, run = StatementSync.prototype.run, get = StatementSync.prototype.get;
  vi.spyOn(migrations, "migrateSqlite").mockImplementation((...args) => { migrate(...args); if (phase === "initialize") now = 2001; });
  vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) { close.call(this); if (this !== db && phase === "close") now = 2001; });
  vi.spyOn(StatementSync.prototype, "run").mockImplementation(function(this: StatementSync, ...args: any[]) {
    const value = Reflect.apply(run, this, args);
    if (/^ATTACH DATABASE/.test(this.sourceSQL)) { traces.push("ATTACH"); if (phase === "attach") now = 2001; }
    return value;
  });
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    const result = exec.call(this, sql); if (this === db) traces.push(sql);
    if (this === db && (phase === "begin" && sql === "BEGIN IMMEDIATE" || phase === "adopt" && sql.startsWith("INSERT INTO main."))) now = 2001;
    return result;
  });
  vi.spyOn(StatementSync.prototype, "get").mockImplementation(function(this: StatementSync, ...args: any[]) {
    const result = Reflect.apply(get, this, args);
    if (phase === "before-commit" && this.sourceSQL === "SELECT name FROM main.sqlite_master WHERE name='peer_last_seen'") now = 2001;
    return result;
  });
  expect(() => withStorageAdmission(check, () => attachStoreCompatibility(db, env.db, nullLogger, false))).toThrow(timeout);
  expect(traces).not.toContain("COMMIT");
  if (["initialize", "close"].includes(phase)) expect(traces).not.toContain("ATTACH");
  if (phase === "attach") expect(traces).not.toContain("BEGIN IMMEDIATE");
  if (phase === "begin") expect(traces.some(sql => sql.startsWith("INSERT INTO"))).toBe(false);
  vi.restoreAllMocks(); expect(db.isTransaction).toBe(false); expect(rows()).toEqual(before);
  expect(readFileSync(sidecar)).toEqual(original); db.exec("BEGIN IMMEDIATE; ROLLBACK");
});

it("adopts once across legitimate reopen while preserving original sidecar namespace/direction evidence", () => {
  const sidecar = join(env.home, "store-compatibility.db"), original = readFileSync(sidecar);
  withStorageAdmission(check, () => attachStoreCompatibility(db, env.db, nullLogger, false)); const first = rows();
  expect(first.peer_names).toHaveLength(1);
  expect(first.job_delivery_routes).toMatchObject([{ id: "original-uuid", recipient: "intended-recipient", namespace: "", consumed_at: null }]);
  db.close(); db = new DatabaseSync(env.db);
  withStorageAdmission(check, () => attachStoreCompatibility(db, env.db, nullLogger, false)); expect(rows()).toEqual(first);
  expect(db.prepare("SELECT * FROM store_compatibility.retained_proof").all()).toEqual([{ id: "original-uuid", body: new Uint8Array([0,255,4]),
    owner: "source-owner", namespace: "authenticated-host/fingerprint", direction: "remote" }]);
  expect(readFileSync(sidecar)).toEqual(original);
});

it("rolls back fallback sidecar writes together with main adoption if they return after the original deadline", () => {
  db.exec("DROP TABLE main.peer_last_seen; INSERT INTO main.peer_names VALUES('local-owner','local-peer','local-session','codex',99)");
  const sidecar = join(env.home, "store-compatibility.db"), original = readFileSync(sidecar), before = db.prepare("SELECT * FROM main.peer_names").all();
  let wrote = false; const exec = db.exec;
  vi.spyOn(db, "exec").mockImplementation(sql => {
    exec.call(db, sql);
    if (sql.startsWith("INSERT INTO store_compatibility.peer_last_seen")) { wrote = true; now = 2001; }
  });
  expect(() => withStorageAdmission(check, () => attachStoreCompatibility(db, env.db, nullLogger, false))).toThrow(timeout);
  expect(wrote).toBe(true); expect(db.isTransaction).toBe(false);
  expect(db.prepare("SELECT * FROM main.peer_names").all()).toEqual(before);
  expect(readFileSync(sidecar)).toEqual(original);
});
