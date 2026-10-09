import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { exportDecompressed, inspectCatalog, inspectQuery, inspectRows } from "../src/core/db-inspect.js";
import { historyDbPath, migrateHistoryStore, openHistoryStore } from "../src/core/history-store.js";
import { runDb } from "../src/cli/db.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
const closes: (() => void)[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { for (const close of closes.splice(0).reverse()) close(); await env.cleanup(); });
const text = JSON.stringify({ content: [{ type: "text", text: "inspector needle " + "padding words ".repeat(300) }] });

async function migrated() {
  const old = new DatabaseSync(env.db); closes.push(() => old.close());
  const { historySchema } = await import("../src/core/history-schema.js");
  const { CONVERSATION_SCHEMA } = await import("../src/core/conversation-schema.js");
  old.exec("CREATE TABLE messages(id TEXT,body TEXT,from_agent TEXT,from_name TEXT,from_id TEXT,recipient TEXT,to_target TEXT,created_at INTEGER)");
  old.exec(historySchema()); old.exec(CONVERSATION_SCHEMA); old.exec("PRAGMA journal_mode=WAL");
  old.prepare("INSERT INTO conversations(id,agent,session) VALUES('codex:a','codex','a')").run();
  for (let i = 0; i < 5; i++) old.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('s',0,?,'codex:a',1,?,?)").run(i, Buffer.from(text), text);
  const db = openHistoryStore(historyDbPath(env.db)); closes.push(() => db.close());
  await migrateHistoryStore(env.db, db);
}

it("lists tables and views without scanning, decodes compressed text, and shows raw storage on request", async () => {
  await migrated();
  const catalog = inspectCatalog(env.home);
  const history = catalog.dbs.find(d => d.db === "history")!;
  expect(history.tables.find(t => t.name === "conversation_records")).toMatchObject({ kind: "table", rows: 5 });
  expect(history.tables.find(t => t.name === "v_conversation_records")).toMatchObject({ kind: "view" });
  expect(history.tables.some(t => t.name === "history_fts_data")).toBe(false);
  const decoded = inspectRows(env.home, { db: "history", table: "conversation_records", limit: 2 });
  expect(decoded.columns).not.toContain("raw_codec");
  expect(decoded.rows).toHaveLength(2);
  expect(decoded.rows[0]![decoded.columns.indexOf("raw")]).toBe(text);
  const raw = inspectRows(env.home, { db: "history", table: "conversation_records", limit: 1, raw: true });
  expect(raw.rows[0]![raw.columns.indexOf("raw")]).toMatchObject({ codec: expect.any(Number), bytes: expect.any(Number) });
  const filtered = inspectRows(env.home, { db: "history", table: "conversation_records", filter: "INSPECTOR NEEDLE", limit: 10 });
  expect(filtered.rows).toHaveLength(5);
  expect(() => inspectRows(env.home, { db: "history", table: "nope" })).toThrow("Unknown table");
  expect(() => inspectRows(env.home, { db: "elsewhere", table: "x" })).toThrow("Unknown database");
});

it("runs read-only SQL with the decode functions and exports a plain copy for third-party viewers", async () => {
  await migrated();
  const result = inspectQuery(env.home, "history", "SELECT count(*) n, min(ab_text(raw, raw_codec)) t FROM conversation_records");
  expect(result.rows[0]).toEqual({ n: 5, t: text });
  expect(() => inspectQuery(env.home, "history", "DELETE FROM conversation_records")).toThrow();
  const out = join(env.home, "export.sqlite");
  expect(exportDecompressed(env.home, "history", "conversation_records", out)).toBe(5);
  const plain = new DatabaseSync(out, { readOnly: true }); closes.push(() => plain.close());
  expect(plain.prepare("SELECT raw FROM conversation_records LIMIT 1").get()!.raw).toBe(text);
  expect(() => exportDecompressed(env.home, "history", "conversation_records", out)).toThrow("already exists");
  const lines: string[] = [];
  expect(runDb(["query", "SELECT count(*) AS n FROM v_conversation_records", "--json"], env.home, l => lines.push(l))).toBe(0);
  expect(JSON.parse(lines[0]!)).toEqual([{ n: 5 }]);
  expect(runDb(["bogus"], env.home, () => {})).toBe(2);
  expect(existsSync(out)).toBe(true);
});
