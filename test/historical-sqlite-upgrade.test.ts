import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageStore, migrateMessageSchema, SQLITE_STORE_VERSION } from "../src/core/store.js";
import { migrateSqlite } from "../src/core/sqlite-migrations.js";
import { nullLogger } from "../src/core/logger.js";
import { HistoryIndex } from "../src/core/history.js";
import { ConversationIngestor } from "../src/core/conversations.js";
import { makeEnv, type TestEnv } from "./helpers.js";

type Table = { name: string; count: number; sha256: string };
type Capture = { tag: string; commit: string; storeSourceSha256: string; archiveSourceSha256: string | null; files: { name: string; version: number; sha256: string; tables: Table[] }[] };
const fixtures = join(import.meta.dirname, "fixtures", "sqlite-upgrade");
const captures = (JSON.parse(readFileSync(join(fixtures, "manifest.json"), "utf8")) as { captures: Capture[] }).captures;
const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const encode = (row: unknown) => JSON.stringify(row, (_key, value) => value instanceof Uint8Array ? { blob: Buffer.from(value).toString("base64") } : typeof value === "bigint" ? { integer: String(value) } : value);
function table(db: DatabaseSync, name: string): Table {
  const rows = db.prepare(`SELECT * FROM ${quote(name)}`).all().map(encode).sort();
  return { name, count: rows.length, sha256: digest(JSON.stringify(rows)) };
}
function paths(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? paths(join(folder, entry.name)) : [join(folder, entry.name)]);
}
let env: TestEnv;
beforeEach(() => { env = makeEnv(); vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0"); });
afterEach(async () => { await env.cleanup(); vi.unstubAllEnvs(); });
function install(capture: Capture) {
  expect(capture.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(digest(readFileSync(join(fixtures, capture.tag, "store.ts.txt")))).toBe(capture.storeSourceSha256);
  if (capture.archiveSourceSha256) expect(digest(readFileSync(join(fixtures, capture.tag, "sqlite-maintenance.ts.txt")))).toBe(capture.archiveSourceSha256);
  for (const file of capture.files) {
    const source = join(fixtures, capture.tag, file.name);
    expect(digest(readFileSync(source))).toBe(file.sha256);
    copyFileSync(source, join(env.home, file.name));
  }
}
it.each(captures)("preserves every captured table through the $tag schema upgrade, failure and downgrade", (capture) => {
  install(capture);
  const original = capture.files.find((file) => file.name === "bridge.db")!;
  const db = new DatabaseSync(env.db);
  try {
    expect(Number(db.prepare("PRAGMA user_version").get()!.user_version)).toBe(original.version);
    for (const before of original.tables) expect(table(db, before.name)).toEqual(before);
    migrateMessageSchema(db, env.db, true, nullLogger);
    expect(Number(db.prepare("PRAGMA user_version").get()!.user_version)).toBe(SQLITE_STORE_VERSION);
    for (const before of original.tables) expect(table(db, before.name)).toEqual(before);
    migrateMessageSchema(db, env.db, true, nullLogger);
    for (const before of original.tables) expect(table(db, before.name)).toEqual(before);
    const snapshots = paths(env.home).filter((path) => path !== env.db && !path.endsWith("archive.db") && readFileSync(path).subarray(0, 16).toString() === "SQLite format 3\0");
    expect(snapshots.some((path) => {
      const backup = new DatabaseSync(path, { readOnly: true });
      try { return Number(backup.prepare("PRAGMA user_version").get()!.user_version) === original.version && original.tables.every((before) => encode(table(backup, before.name)) === encode(before)); }
      finally { backup.close(); }
    })).toBe(true);
    // VACUUM INTO may repack FTS shadow segments. Compare every logical record,
    // including the external-content virtual table, rather than its physical index pages.
    const logical = original.tables.filter((before) => !before.name.startsWith("history_fts_"));
    const baseline = logical.map((before) => table(db, before.name));
    const query = `"historical_sqlite_${capture.tag.slice(1).replaceAll(".", "_")}"`;
    const matches = db.prepare("SELECT rowid FROM history_fts WHERE history_fts MATCH ? ORDER BY rowid").all(query);
    expect(() => migrateSqlite(db, env.db, true, SQLITE_STORE_VERSION + 1, [{ version: SQLITE_STORE_VERSION + 1, sql: "UPDATE messages SET body='rollback witness'; CREATE TABLE incomplete_witness(id TEXT); SELECT * FROM missing_witness;" }], nullLogger)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='incomplete_witness'").get()).toBeUndefined();
    expect(logical.map((before) => table(db, before.name))).toEqual(baseline);
    expect(db.prepare("SELECT rowid FROM history_fts WHERE history_fts MATCH ? ORDER BY rowid").all(query)).toEqual(matches);
    expect(() => migrateSqlite(db, env.db, true, original.version, [], nullLogger)).toThrow("unsupported");
    expect(logical.map((before) => table(db, before.name))).toEqual(baseline);
    expect(db.prepare("SELECT rowid FROM history_fts WHERE history_fts MATCH ? ORDER BY rowid").all(query)).toEqual(matches);
    expect(db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    for (const file of capture.files.filter((file) => file.name === "archive.db")) expect(digest(readFileSync(join(env.home, file.name)))).toBe(file.sha256);
  } finally { db.close(); }
});
it.each(captures)("keeps all $tag messages and archival metadata readable and searchable after real startup", (capture) => {
  install(capture);
  // Captured project metadata must never direct a test mirror into a real outside folder.
  expect(existsSync("D:/retention-witness")).toBe(false);
  const before = new DatabaseSync(env.db, { readOnly: true });
  const live = before.prepare("SELECT * FROM messages").all();
  const legacy = before.prepare("SELECT * FROM archived_messages").all();
  const decisions = capture.files[0]!.tables.find((entry) => entry.name === "decisions");
  before.close();
  const archiveFile = capture.files.find((file) => file.name === "archive.db");
  const oldCold = archiveFile ? new DatabaseSync(join(env.home, "archive.db"), { readOnly: true }) : null;
  const cold = oldCold?.prepare("SELECT * FROM messages").all() ?? [];
  oldCold?.close();
  const store = new MessageStore(env.db, nullLogger);
  const db = new DatabaseSync(env.db), archive = new DatabaseSync(join(env.home, "archive.db"), { readOnly: true });
  const cli = { claude: join(env.home, "empty-cli/claude"), codex: join(env.home, "empty-cli/codex"), opencode: join(env.home, "empty-cli/opencode") };
  const index = new HistoryIndex(db, env.home, cli), ingest = new ConversationIngestor(db, env.home, cli);
  try {
    expect(db.prepare("SELECT * FROM messages").all()).toEqual(live);
    const retained = archive.prepare("SELECT * FROM messages").all();
    expect(retained.map(encode).sort()).toEqual([...legacy, ...cold].map(encode).sort());
    for (const row of [...live, ...legacy, ...cold]) expect(store.byId(String(row.id))?.body).toBe(row.body);
    for (let batch = 0; batch < 80; batch++) { index.tick(); ingest.tick(); }
    const query = `historical_sqlite_${capture.tag.slice(1).replaceAll(".", "_")}`;
    expect(index.search({ query }).hits.length).toBeGreaterThan(0);
    for (const row of [...live, ...legacy, ...cold]) {
      expect(store.byId(String(row.id))?.body).toBe(row.body);
      expect(index.search({ query, limit: 50, filters: { agent: row.from_agent as "claude" | "codex" | "opencode" } }).hits.some((hit) => hit.message === row.id)).toBe(true);
    }
    if (decisions) {
      expect(table(db, "decisions")).toEqual(decisions);
      for (const revision of [0, 1]) expect(index.search({ query: `${query} decision ${revision}`, filters: { kind: "decision" } }).hits.length).toBeGreaterThan(0);
    }
    expect(table(db, "witness_user_extensions")).toEqual(capture.files[0]!.tables.find((entry) => entry.name === "witness_user_extensions"));
    expect(archive.prepare("SELECT * FROM messages").all().map(encode).sort()).toEqual(retained.map(encode).sort());
  } finally { ingest.close(); index.close(); archive.close(); db.close(); store.close(); }
});
