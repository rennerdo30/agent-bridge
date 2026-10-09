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
  // Transcript bytes stay bytes; the body is resolved for viewers that do not know the v2 conventions.
  expect(Buffer.from(plain.prepare("SELECT raw FROM conversation_records LIMIT 1").get()!.raw as Uint8Array).toString("utf8")).toBe(text);
  expect(plain.prepare("SELECT body FROM conversation_records LIMIT 1").get()!.body).toBe(text);
  expect(() => exportDecompressed(env.home, "history", "conversation_records", out)).toThrow("already exists");
  const lines: string[] = [];
  expect(runDb(["query", "SELECT count(*) AS n FROM v_conversation_records", "--json"], env.home, l => lines.push(l))).toBe(0);
  expect(JSON.parse(lines[0]!)).toEqual([{ n: 5 }]);
  expect(runDb(["bogus"], env.home, () => {})).toBe(2);
  expect(existsSync(out)).toBe(true);
});

it("AB-213: exports compressed non-UTF-8 transcript bytes byte-exact as a BLOB and resolves the body", async () => {
  await migrated();
  const db = openHistoryStore(historyDbPath(env.db)); closes.push(() => db.close());
  const { encodeBytes } = await import("../src/core/history-codec.js");
  const raw = Buffer.alloc(4096);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7) % 256 === 10 ? 0xff : (i * 7) % 256;
  const encoded = encodeBytes(raw);
  expect(encoded.codec).not.toBe(0);
  db.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,raw_codec,body) VALUES('binary',0,0,'codex:a',2,?,?,NULL)").run(encoded.value, encoded.codec);
  const out = join(env.home, "binary.sqlite");
  exportDecompressed(env.home, "history", "conversation_records", out);
  const plain = new DatabaseSync(out, { readOnly: true }); closes.push(() => plain.close());
  const row = plain.prepare("SELECT raw, typeof(raw) t, body FROM conversation_records WHERE source='binary'").get()!;
  expect(row.t).toBe("blob");
  expect(Buffer.from(row.raw as Uint8Array).equals(raw)).toBe(true);
  expect(row.body).toBe(raw.toString("utf8"));
});

it("AB-229: v_conversation_records shows the body text for records stored with body '' (derived from raw)", async () => {
  await migrated();
  const db = openHistoryStore(historyDbPath(env.db)); closes.push(() => db.close());
  // The live writer stores '' when the indexed text equals the raw text (conversations.ts).
  db.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,raw_codec,body) VALUES('plain',0,0,'codex:a',2,?,0,'')").run(Buffer.from("plain transcript line"));
  db.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,raw_codec,body) VALUES('meta',0,0,'codex:a',2,?,0,'')").run(Buffer.from(JSON.stringify({ type: "meta", id: 1 })));
  const view = (source: string) => inspectQuery(env.home, "history", `SELECT body_text FROM v_conversation_records WHERE source='${source}'`).rows[0]!.body_text;
  expect(view("plain")).toBe("plain transcript line");
  expect(view("meta")).toBe("");
  expect(view("s")).toBe(text);
  // A store created before this fix gets the corrected view when a writer opens it.
  db.exec("DROP VIEW v_conversation_records; CREATE VIEW v_conversation_records AS SELECT id, source, generation, offset, conversation, at, part, ab_text(raw, raw_codec) AS raw_text, coalesce(body, ab_text(raw, raw_codec)) AS body_text, length(raw) AS stored_bytes, raw_codec FROM conversation_records;");
  expect(view("plain")).toBe("");
  openHistoryStore(historyDbPath(env.db)).close();
  expect(view("plain")).toBe("plain transcript line");
});

it("serves the Database inspector API behind dashboard authentication with validated, bounded parameters", async () => {
  await migrated();
  const { startUi } = await import("../src/cli/ui.js");
  const { nullLogger } = await import("../src/core/logger.js");
  const ui = await startUi({ home: env.home, pipe: env.pipe, port: 0, log: nullLogger });
  try {
    const base = ui.url.replace(/\/\?t=.*$/, "");
    expect((await fetch(`${base}/api/db/tables`)).status).toBe(403);
    const cookie = String((await fetch(ui.url, { redirect: "manual" })).headers.get("set-cookie")).split(";")[0]!;
    const headers = { cookie };
    const catalog = await (await fetch(`${base}/api/db/tables`, { headers })).json();
    expect(catalog.dbs.map((d: { db: string }) => d.db)).toContain("history");
    const page = await (await fetch(`${base}/api/db/rows?db=history&table=conversation_records&limit=2`, { headers })).json();
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0][page.columns.indexOf("raw")]).toBe(text);
    expect((await fetch(`${base}/api/db/rows?db=history&table=conversation_records&limit=9999`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/api/db/rows?db=history&table=nope`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/api/db/rows?db=history&table=conversation_records&evil=1`, { headers })).status).toBe(400);
    expect((await fetch(`${base}/api/db/rows?db=../bridge&table=messages`, { headers })).status).toBe(400);
  } finally { await ui.close(); }
});
