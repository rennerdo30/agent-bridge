import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { migrateMessageSchema } from "../src/core/store.js";
import { migrateSqlite } from "../src/core/sqlite-migrations.js";
import { nullLogger } from "../src/core/logger.js";
import { CONVERSATION_MIGRATION } from "../src/core/conversation-schema.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });
function fixture(): DatabaseSync {
  const db = new DatabaseSync(env.db);
  db.exec(readFileSync(join(import.meta.dirname, "fixtures/store-v0.29.10.sql"), "utf8"));
  db.exec("CREATE TABLE job_delivery_routes(id TEXT PRIMARY KEY,recipient TEXT NOT NULL,consumed_at INTEGER);");
  db.exec(CONVERSATION_MIGRATION);
  db.exec("INSERT INTO peer_names VALUES('retained','offline-peer','retained-session','codex',17); CREATE TABLE opaque_owner_data(raw BLOB); INSERT INTO opaque_owner_data VALUES(zeroblob(8*1024*1024));");
  return db;
}

it("backs up additive v8→v9 inputs and complete schema without copying unrelated large tables", () => {
  const db = fixture();
  try {
    migrateMessageSchema(db, env.db, true, nullLogger);
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(9);
    expect(db.prepare("SELECT length(raw) AS n FROM opaque_owner_data").get()!.n).toBe(8 * 1024 * 1024);
    const folder = join(env.home, ".migration-snapshots");
    const name = readdirSync(folder).find(name => name.endsWith(".db"))!;
    expect(name).toMatch(/^bridge\.db\.metadata-v8-to-v9-/);
    const path = join(folder, name);
    expect(statSync(path).size).toBeLessThan(1024 * 1024);
    const manifest = JSON.parse(readFileSync(`${path}.manifest.json`, "utf8"));
    expect(manifest).toMatchObject({ version: 1, kind: "sqlite-migration-metadata", sourceVersion: 8, targetVersion: 9, tables: [{ name: "peer_names", rows: 1 }] });
    expect(manifest.schema).toEqual(expect.arrayContaining([expect.objectContaining({ name: "opaque_owner_data", type: "table" })]));
    const snapshot = new DatabaseSync(path, { readOnly: true });
    try {
      expect(snapshot.prepare("PRAGMA user_version").get()!.user_version).toBe(8);
      expect(snapshot.prepare("SELECT * FROM peer_names").all()).toMatchObject([{ name: "offline-peer", learned_at: 17 }]);
      expect(snapshot.prepare("SELECT name FROM sqlite_master WHERE name='opaque_owner_data'").get()).toBeUndefined();
    } finally { snapshot.close(); }
    expect(readdirSync(env.home).some(name => name.startsWith("bridge.db.backup-"))).toBe(false);
  } finally { db.close(); }
});

it("rolls an additive migration failure back while preserving its labeled verified metadata snapshot", () => {
  const db = fixture();
  try {
    const before = db.prepare("SELECT * FROM peer_names").all();
    expect(() => migrateSqlite(db, env.db, true, 9, [{ version: 9, backupTables: ["peer_names"], sql: "CREATE TABLE additive_witness(id); UPDATE peer_names SET name='changed'; SELECT * FROM missing_witness; PRAGMA user_version=9;" }], nullLogger)).toThrow("no such table: missing_witness");
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(8);
    expect(db.prepare("SELECT * FROM peer_names").all()).toEqual(before);
    expect(db.prepare("SELECT length(raw) AS n FROM opaque_owner_data").get()!.n).toBe(8 * 1024 * 1024);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='additive_witness'").get()).toBeUndefined();
    const folder = join(env.home, ".migration-snapshots");
    expect(readdirSync(folder).filter(name => name.endsWith(".db"))).toHaveLength(1);
    expect(existsSync(join(folder, readdirSync(folder).find(name => name.endsWith(".manifest.json"))!))).toBe(true);
  } finally { db.close(); }
});
