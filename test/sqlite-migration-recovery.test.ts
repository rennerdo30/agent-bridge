import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nullLogger } from "../src/core/logger.js";
import { migrateSqlite } from "../src/core/sqlite-migrations.js";
import { MessageStore } from "../src/core/store.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0"); });
afterEach(async () => { vi.unstubAllEnvs(); await env.cleanup(); });

it("restores a failed migration's backup although conversation records are append-only, streaming rows (AB-235)", () => {
  new MessageStore(env.db, nullLogger).close();
  const db = new DatabaseSync(env.db);
  try {
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='conversation_records_no_delete'").get()).toBeTruthy();
    db.prepare("INSERT OR IGNORE INTO conversations(id,agent,session) VALUES('codex:a','codex','a')").run();
    const insert = db.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('s',0,?,'codex:a',1,?,?)");
    db.exec("BEGIN");
    for (let i = 0; i < 2000; i++) insert.run(i, Buffer.from([0, 255, i & 0xff]), `record ${i}`);
    db.exec("COMMIT");
    const before = db.prepare("SELECT * FROM conversation_records ORDER BY id").all();
    const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
    let error: unknown;
    try {
      migrateSqlite(db, env.db, true, version + 1, [{ version: version + 1, sql: `ALTER TABLE messages ADD COLUMN future TEXT; SELECT invalid FROM missing; PRAGMA user_version=${version + 1};` }], nullLogger);
    } catch (err) { error = err; }
    // The migration's own error, not a failed recovery.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(String(error)).toMatch(/missing/);
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(version);
    expect(db.prepare("SELECT * FROM conversation_records ORDER BY id").all()).toEqual(before);
    // The append-only guards are back in place.
    expect(() => db.prepare("DELETE FROM conversation_records WHERE id=1").run()).toThrow("append-only");
    expect(() => db.prepare("UPDATE conversation_records SET body='x' WHERE id=1").run()).toThrow("append-only");
  } finally { db.close(); }
  // The store reopens with every original row.
  const store = new MessageStore(env.db, nullLogger);
  store.close();
  const check = new DatabaseSync(env.db, { readOnly: true });
  try { expect(check.prepare("SELECT count(*) n FROM conversation_records").get()!.n).toBe(2000); } finally { check.close(); }
});
