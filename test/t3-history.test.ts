import { DatabaseSync } from "node:sqlite";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationIngestor, readConversation, CONVERSATION_BYTES } from "../src/core/conversations.js";
import { HistoryIndex } from "../src/core/history.js";
import { openHistoryStore, HISTORY_BATCH_MS } from "../src/core/history-store.js";
import { decodeBytes } from "../src/core/history-codec.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { conversationProject } from "../src/core/project-store.js";
import { localT3HistoryRoot, type TranscriptPaths } from "../src/core/transcripts/common.js";
import { makeEnv } from "./helpers.js";
import { historySearchSchema } from "../src/core/history-query.js";
import { conversationPageSchema } from "../src/core/conversation-query.js";

// Installed 7c3b3b3 schema, including unused columns: the reader must not depend on
// newer ProjectionStore tables or inspect provider-session/auth storage.
const SCHEMA = `
CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,title TEXT NOT NULL,workspace_root TEXT NOT NULL,
 scripts_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,
 default_model_selection_json TEXT,default_thread_env_mode TEXT,favicon_path TEXT,auto_pull INTEGER NOT NULL DEFAULT 0,project_icon_json TEXT);
CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,
 default_provider TEXT NOT NULL,runtime_mode TEXT NOT NULL,interaction_mode TEXT NOT NULL,active_provider_thread_id TEXT,
 created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT,deleted_at TEXT,payload_json TEXT NOT NULL,provider_instance_id TEXT);
CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,
 aggregate_kind TEXT NOT NULL,stream_id TEXT NOT NULL,stream_version INTEGER NOT NULL,event_type TEXT NOT NULL,
 occurred_at TEXT NOT NULL,command_id TEXT,causation_event_id TEXT,correlation_id TEXT,actor_kind TEXT NOT NULL,
 payload_json TEXT NOT NULL,metadata_json TEXT NOT NULL,application_event_version INTEGER NOT NULL DEFAULT 1);
CREATE INDEX idx_orchestration_events_application_sequence ON orchestration_events(application_event_version,sequence);
CREATE TABLE auth_sentinel(do_not_read TEXT);
PRAGMA user_version=17;`;
const close: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of close.splice(0).reverse()) await f();
  vi.unstubAllEnvs();
});
const at = "2026-10-31T10:00:00Z";
function thread(input: DatabaseSync, threadId: string, parent: string | null = null) {
  input.prepare(`INSERT INTO orchestration_v2_projection_threads VALUES(?, 'project', ?, 'codex','full-access','default',NULL,?,?,?,NULL,?,NULL)`)
    .run(threadId, `Archived ${threadId} azalea_title`, at, at, at, JSON.stringify({ id: threadId,
      lineage: { parentThreadId: parent, relationshipToParent: parent ? "fork" : null },
      forkedFrom: parent ? { type: "run", threadId: parent, runId: "source-run" } : null }));
}
function event(input: DatabaseSync, sequence: number, text = "local_t3_orchid", threadId = "child", version = 2, type = "message.updated") {
  const raw = JSON.stringify({ id: `message-${sequence}`, threadId, runId: "run", nodeId: "node", role: "assistant", text,
    streaming: false, createdAt: at, updatedAt: at, attachments: [] });
  input.prepare(`INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,
    occurred_at,actor_kind,payload_json,metadata_json,application_event_version) VALUES(?,?,'thread',?,?,?,?,'agent',?,'{}',?)`)
    .run(sequence, `event-${sequence}`, threadId, sequence, type, at, raw, version);
  return Buffer.from(raw);
}
function fixture(environment = "environment-one", encoded = true, messages = true) {
  vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
  const env = makeEnv(); close.push(() => env.cleanup());
  const store = new MessageStore(env.db, nullLogger); close.push(() => store.close());
  const bridge = new DatabaseSync(env.db); close.push(() => bridge.close());
  const db = encoded ? openHistoryStore(join(env.home, "retained.db")) : bridge;
  if (encoded) close.push(() => db.close());
  const root = join(env.home, "synthetic-t3"), userdata = join(root, "userdata"); mkdirSync(userdata, { recursive: true });
  writeFileSync(join(userdata, "environment-id"), environment + "\n");
  const file = join(userdata, "statev2.sqlite"), input = new DatabaseSync(file);
  let inputOpen = true;
  const closeInput = () => { if (inputOpen) { input.close(); inputOpen = false; } };
  close.push(closeInput);
  input.exec("PRAGMA journal_mode=WAL"); input.exec(SCHEMA);
  const project = join(env.home, "project"); mkdirSync(project);
  input.prepare("INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('project','Synthetic project',?,'[]',?,?)")
    .run(project, at, at);
  thread(input, "child", "root"); thread(input, "root");
  const paths: TranscriptPaths = { claude: join(env.home, "claude"), codex: join(env.home, "codex"), opencode: join(env.home, "opencode"), t3: root };
  // These #152 cases cover the explicit message import (AB-473 keeps it off by default).
  let ingest = new ConversationIngestor(db, env.home, paths, bridge, { t3Messages: messages }); close.push(() => ingest.close());
  // Query this standalone v2 fixture directly. Supplying the separate bridge DB
  // would intentionally serve its legacy history until a migration is verified.
  const index = new HistoryIndex(db, null, paths); close.push(() => index.close());
  const cursor = () => db.prepare("SELECT cursor FROM history_cursors WHERE source LIKE 'durable-t3:%' AND source NOT LIKE '%:status'").get();
  const state = () => JSON.parse(String(cursor()?.cursor ?? "{}"));
  const status = () => JSON.parse(String(db.prepare("SELECT cursor FROM history_cursors WHERE source LIKE 'durable-t3:%:status'").get()?.cursor ?? "{}"));
  const rows = (part?: string) => db.prepare(`SELECT * FROM conversation_records ${part ? "WHERE part=?" : ""} ORDER BY id`).all(...(part ? [part] : []));
  return { env, root, file, input, db, bridge, paths, project, index, state, status, rows, closeInput,
    get ingest() { return ingest; },
    restart() { ingest.close(); ingest = new ConversationIngestor(db, env.home, paths, bridge, { t3Messages: messages }); },
    drain() {
      for (let n = 0; n < 120; n++) { ingest.tick(); if (!ingest.discovering) return; }
      throw new Error("bounded T3 backlog did not drain");
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function raw(row: Record<string, any>): Buffer { return decodeBytes(row.raw, row.raw_codec); }
function fragments(f: Fixture, sequence: number): Buffer {
  return Buffer.concat(f.rows("t3:fragment").filter(r => String(r.source).includes(`:event:${sequence}:`)).map(raw));
}
function receipts(f: Fixture) { return f.rows().filter(r => String(r.part).startsWith("t3:") && r.part !== "t3:fragment" && r.part !== "t3:metadata").map(r => JSON.parse(raw(r).toString())); }
function oneFragment(f: Fixture) {
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now), prepare = DatabaseSync.prototype.prepare;
  const slow = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql.includes("octet_length(payload_json) bytes,substr")) now += HISTORY_BATCH_MS;
    return prepare.call(this, sql);
  });
  try { f.ingest.tick(); } finally { slow.mockRestore(); clock.mockRestore(); }
}

// AB-473: T3 wraps provider sessions whose transcripts Bridge already indexes. By default T3 adds what only
// it knows (titles, projects, relations, archived chats) and never its copy of the message text.
it("by default imports T3 thread metadata only: titles are searchable, message text is not duplicated and the event log is not read", () => {
  const f = fixture("environment-one", true, false);
  event(f.input, 5);
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  f.drain();
  expect(prepare.mock.calls.some(([sql]) => String(sql).includes("FROM orchestration_events WHERE sequence>"))).toBe(false);
  prepare.mockRestore();
  const id = "t3:environment-one:child";
  expect(readConversation(f.db, { id }).conversation).toMatchObject({ id, parent: "t3:environment-one:root", project: conversationProject(f.project) });
  expect(f.rows("t3:metadata").map(r => JSON.parse(raw(r).toString()).title)).toContain("Archived child azalea_title");
  expect(f.index.search({ query: "azalea_title" }).hits.length).toBeGreaterThan(0);
  expect(f.index.search({ query: "local_t3_orchid" }).hits).toEqual([]);
  expect(f.rows("t3:fragment")).toEqual([]);
  expect(receipts(f)).toEqual([]);
  expect(f.status()).toMatchObject({ state: "ready", reason: "coverage: thread metadata only; message text comes from the provider transcripts" });
});

it.each([false, true])("imports archived metadata, exact lineage and message text through existing FTS and conversation pages (encoded=%s)", encoded => {
  const f = fixture("environment-one", encoded), expected = event(f.input, 5);
  f.drain();
  const id = "t3:environment-one:child", conversation = readConversation(f.db, { id });
  expect(conversation.conversation).toMatchObject({ id, agent: "other", session: id, parent: "t3:environment-one:root", project: conversationProject(f.project) });
  const metadata = f.rows("t3:metadata").map(r => JSON.parse(raw(r).toString())).find(r => r.thread_id === "child");
  expect(metadata).toMatchObject({ environmentId: "environment-one", title: "Archived child azalea_title", archived_at: at,
    relation: { parentThreadId: "root", relationshipToParent: "fork", forkThreadId: "root", forkRunId: "source-run" } });
  expect(f.index.search({ query: "local_t3_orchid", filters: { agent: "other", project: f.project, session: id } }).hits)
    .toMatchObject([{ conversation: id, agent: "other" }]);
  expect(f.index.search({ query: "azalea_title" }).hits.length).toBeGreaterThan(0);
  expect(fragments(f, 5)).toEqual(expected);
  expect(conversation.records.some(r => r.part === "t3:complete")).toBe(true);
  expect(f.db.prepare("SELECT 1 FROM history_fts LIMIT 1").get()).toBeDefined();
});

it("retains namespaced T3 parent and delegated thread identifiers without native transcript restrictions", () => {
  const f = fixture();
  const parent = "mcp:150dda30-b6d6-4b15-a149-6f22e1ac5852";
  const child = "thread:delegated-task:command%3Amcp%3Af716f8c7-3010-4609-bb82-91a8ee20960e%3Adelegate-task%3Aab466-local-history-implementation-20261031-1";
  expect(child.length).toBeGreaterThan(128);
  thread(f.input, parent); thread(f.input, child, parent);
  event(f.input, 9, "namespaced_t3_history", child);
  f.drain();
  const conversation = `t3:environment-one:${child}`;
  expect(f.db.prepare("SELECT parent FROM conversations WHERE id=?").get(conversation))
    .toEqual({ parent: `t3:environment-one:${parent}` });
  expect(f.index.search({ query: "namespaced_t3_history", filters: { session: conversation } }).hits)
    .toMatchObject([{ conversation }]);
  expect(receipts(f)).toMatchObject([{ sequence: 9, outcome: "complete" }]);
});

it("scans historical events from zero while metadata bootstrap and later appends remain discoverable", () => {
  const f = fixture();
  for (let n = 0; n < 8; n++) thread(f.input, `thread-${n}`);
  event(f.input, 1, "first_backfill_iris");
  f.ingest.tick();
  expect(f.ingest.discovering).toBe(true); // metadata still has pages even if native discovery is idle
  event(f.input, 100, "appended_during_bootstrap"); f.restart(); f.drain();
  expect(f.rows("t3:metadata")).toHaveLength(10);
  expect(receipts(f).map(r => r.sequence)).toEqual([1, 100]);
  expect(f.index.search({ query: "first_backfill_iris" }).hits).toHaveLength(1);
  expect(f.index.search({ query: "appended_during_bootstrap" }).hits).toHaveLength(1);
});

it("reconstructs immutable oversized UTF-8 revisions exactly across restart with bounded chunks and no duplicates", () => {
  const f = fixture(), expected = event(f.input, 1, "🪷".repeat(CONVERSATION_BYTES) + " lotus_tail");
  oneFragment(f);
  expect(f.state()).toMatchObject({ sequence: 0, pending: { sequence: 1, offset: CONVERSATION_BYTES } });
  expect(receipts(f)).toHaveLength(0);
  const before = f.rows("t3:fragment"); f.restart(); f.drain();
  expect(fragments(f, 1)).toEqual(expected);
  expect(f.rows("t3:fragment").every(r => raw(r).length <= CONVERSATION_BYTES)).toBe(true);
  expect(f.rows("t3:fragment").some(r => Number(r.raw_codec) !== 0)).toBe(true);
  expect(f.rows("t3:fragment")[0]).toEqual(before[0]);
  expect(receipts(f)).toMatchObject([{ sequence: 1, outcome: "complete", confirmedBytes: expected.length }]);
  const completed = f.rows(); f.restart(); f.drain(); expect(f.rows()).toEqual(completed);
  expect(f.index.search({ query: "lotus_tail" }).hits).toHaveLength(1);
});

it("retains partial bytes and a compaction gap receipt, then imports the later replacement independently", () => {
  const f = fixture(), expected = event(f.input, 2, "a".repeat(CONVERSATION_BYTES * 3));
  oneFragment(f); const before = f.rows("t3:fragment");
  // Compaction removes an intermediate revision; gaps are not evidence of missing message rows.
  event(f.input, 200, "replacement_camellia"); f.input.exec("DELETE FROM orchestration_events WHERE sequence=2");
  f.restart(); f.drain();
  expect(fragments(f, 2)).toEqual(expected.subarray(0, CONVERSATION_BYTES));
  expect(f.rows("t3:fragment")[0]).toEqual(before[0]);
  expect(receipts(f)).toMatchObject([{ sequence: 2, outcome: "incomplete-compacted-source", confirmedBytes: CONVERSATION_BYTES }, { sequence: 200, outcome: "complete" }]);
  expect(receipts(f).some(r => r.sequence === 2 && r.outcome === "complete")).toBe(false);
  expect(f.status().state).toBe("incomplete");
  expect(f.index.search({ query: "replacement_camellia" }).hits).toHaveLength(1);
});

it("does not advance over a failed derived index insert and repairs retained fragments on restart", () => {
  const f = fixture(), expected = event(f.input, 1, "derived_retry_dahlia");
  f.db.exec(`CREATE TRIGGER reject_t3_index BEFORE INSERT ON history_documents
    WHEN EXISTS(SELECT 1 FROM conversation_records WHERE 'durable:'||id=new.id AND part='t3:fragment')
    BEGIN SELECT RAISE(ABORT,'synthetic derived failure'); END`);
  expect(() => f.drain()).toThrow("synthetic derived failure");
  expect(f.state()).toMatchObject({ sequence: 0, pending: { offset: 0 } });
  expect(f.rows("t3:fragment")).toHaveLength(1); expect(receipts(f)).toHaveLength(0);
  f.db.exec("DROP TRIGGER reject_t3_index"); f.restart(); f.drain();
  expect(f.rows("t3:fragment")).toHaveLength(1); expect(fragments(f, 1)).toEqual(expected);
  expect(f.index.search({ query: "derived_retry_dahlia" }).hits).toHaveLength(1);
  expect(receipts(f)).toMatchObject([{ outcome: "complete" }]);
});

it("repairs an unconfirmed derived fragment before advancing a compacted pending event", () => {
  const f = fixture(); event(f.input, 1, "unconfirmed_compaction_lily");
  f.db.exec(`CREATE TRIGGER reject_t3_index BEFORE INSERT ON history_documents
    WHEN EXISTS(SELECT 1 FROM conversation_records WHERE 'durable:'||id=new.id AND part='t3:fragment')
    BEGIN SELECT RAISE(ABORT,'synthetic derived failure'); END`);
  expect(() => f.drain()).toThrow("synthetic derived failure");
  event(f.input, 7, "later_retained_revision"); f.input.exec("DELETE FROM orchestration_events WHERE sequence=1");
  f.restart(); expect(() => f.drain()).toThrow("synthetic derived failure");
  expect(f.state()).toMatchObject({ sequence: 0, pending: { offset: 0 } }); expect(receipts(f)).toHaveLength(0);
  f.db.exec("DROP TRIGGER reject_t3_index"); f.drain();
  expect(receipts(f)).toMatchObject([{ sequence: 1, outcome: "incomplete-compacted-source" }, { sequence: 7, outcome: "complete" }]);
  expect(f.index.search({ query: "unconfirmed_compaction_lily" }).hits).toHaveLength(1);
});

it("replays a retained completion receipt whose derived indexing failed before source compaction", () => {
  const f = fixture(), expected = event(f.input, 1, "receipt_replay_magnolia");
  f.db.exec(`CREATE TRIGGER reject_receipt_index BEFORE INSERT ON history_documents
    WHEN EXISTS(SELECT 1 FROM conversation_records WHERE 'durable:'||id=new.id AND part='t3:complete')
    BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END`);
  expect(() => f.drain()).toThrow("synthetic receipt failure");
  expect(f.state()).toMatchObject({ sequence: 0, pending: { offset: 0 } });
  expect(fragments(f, 1)).toEqual(expected);
  event(f.input, 7, "later_receipt_revision"); f.input.exec("DELETE FROM orchestration_events WHERE sequence=1");
  f.db.exec("DROP TRIGGER reject_receipt_index"); f.restart(); f.drain();
  expect(receipts(f)).toMatchObject([{ sequence: 1, outcome: "complete", confirmedBytes: expected.length }, { sequence: 7, outcome: "complete" }]);
  expect(f.index.search({ query: "receipt_replay_magnolia" }).hits).toHaveLength(1);
});

it("allows a synthetic WAL writer during an active bounded reader and preserves source schema/data/journal mode", () => {
  const f = fixture(); event(f.input, 1);
  const schema = f.input.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
  const original = f.input.prepare("SELECT * FROM orchestration_events").all(), prepare = DatabaseSync.prototype.prepare;
  let wrote = false; const observed: string[] = [], readers = new Set<DatabaseSync>();
  const audit = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    // Source connections are distinguishable without touching source data.
    if (this !== f.input && this.location() === f.file) {
      if (!readers.has(this)) expect(() => this.exec("UPDATE projection_projects SET title=title WHERE 0")).toThrow(/readonly|read-only/);
      readers.add(this);
      observed.push(sql);
      expect(sql).not.toMatch(/auth|provider_session|projection_messages|metadata_json/i);
      expect(sql).toMatch(/^SELECT|^PRAGMA table_info/);
      if (!wrote && sql.includes("FROM orchestration_events WHERE sequence>")) {
        const all = statement.all.bind(statement);
        statement.all = ((...args: Parameters<typeof all>) => {
          const iterator = statement.iterate(...args), first = iterator.next();
          try {
            f.input.exec("BEGIN IMMEDIATE"); event(f.input, 99, "wal_commit_peony"); f.input.exec("COMMIT"); wrote = true;
            return [...(first.done ? [] : [first.value]), ...iterator];
          } finally { iterator.return?.(); }
        }) as typeof statement.all;
      }
    }
    return statement;
  });
  try { f.drain(); } finally { audit.mockRestore(); }
  expect(wrote).toBe(true); expect(observed.length).toBeGreaterThan(0);
  expect([...readers].every(reader => !reader.isOpen)).toBe(true);
  expect(f.input.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
  expect(f.input.prepare("SELECT * FROM orchestration_events WHERE sequence=1").all()).toEqual(original);
  expect(f.input.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
  expect(f.input.prepare("PRAGMA user_version").get()?.user_version).toBe(17);
  expect(f.index.search({ query: "wal_commit_peony" }).hits).toHaveLength(1);
  // Every tick closes its reader: a source exclusive lock can be acquired after it returns.
  f.input.exec("BEGIN EXCLUSIVE; ROLLBACK");
});

it("keeps environment namespaces stable and refuses environment replacement and rollback without changing checkpoints", () => {
  const f = fixture(); event(f.input, 5); f.drain(); const prior = f.state(), rows = f.rows();
  writeFileSync(join(f.root, "userdata", "environment-id"), "different-environment");
  event(f.input, 8, "must_not_import"); f.restart(); f.ingest.tick();
  expect(f.state()).toEqual(prior); expect(f.rows()).toEqual(rows); expect(f.status().state).toBe("unavailable");
  writeFileSync(join(f.root, "userdata", "environment-id"), "environment-one"); f.input.exec("DELETE FROM orchestration_events");
  f.restart(); f.ingest.tick(); expect(f.state()).toEqual(prior); expect(f.rows()).toEqual(rows);
  expect(f.status().reason).toContain("rolled back");
  const second = fixture("environment-two"); event(second.input, 5); second.drain();
  expect(second.db.prepare("SELECT id FROM conversations WHERE agent='other' AND parent IS NOT NULL").get()?.id).toBe("t3:environment-two:child");
});

it("refuses a replacement file even when event IDs and highwater are identical", () => {
  const f = fixture(); event(f.input, 1); f.drain(); const before = f.state(), rows = f.rows();
  // A separate synthetic SQLite file, never a copy of owner storage.
  const replacement = `${f.file}.replacement`, other = new DatabaseSync(replacement);
  other.exec(SCHEMA); event(other, 1); other.close();
  // Close our writer before moving its database; its handle is replaced for cleanup.
  f.closeInput();
  renameSync(f.file, `${f.file}.retired`); renameSync(replacement, f.file);
  expect(() => f.ingest.tick()).not.toThrow(); expect(f.state()).toEqual(before); expect(f.rows()).toEqual(rows);
  expect(f.status().state).toBe("unavailable");
});

it("review: refuses a source swapped after environment sampling but before SQLite open", () => {
  const f = fixture(); event(f.input, 1); f.drain();
  const before = f.state(), rows = f.rows(), replacement = `${f.file}.opening-replacement`;
  const other = new DatabaseSync(replacement); other.exec(SCHEMA);
  for (const table of ["projection_projects", "orchestration_v2_projection_threads", "orchestration_events"])
    for (const row of f.input.prepare(`SELECT * FROM ${table}`).all())
      other.prepare(`INSERT INTO ${table} VALUES(${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row));
  event(other, 2, "foreign_opening_replacement"); other.close(); f.closeInput();
  const read = fs.readSync;
  let swapped = false;
  fs.readSync = ((...args: any[]) => {
    const count = (read as any)(...args);
    if (!swapped && Buffer.isBuffer(args[1]) && args[1].subarray(0, count).toString().trim() === "environment-one") {
      swapped = true;
      renameSync(f.file, `${f.file}.opening-retired`); renameSync(replacement, f.file);
      writeFileSync(join(f.root, "userdata", "environment-id"), "replacement-environment");
    }
    return count;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try { f.ingest.tick(); } finally { fs.readSync = read; syncBuiltinESMExports(); }
  expect(swapped).toBe(true);
  expect(f.state()).toEqual(before); expect(f.rows()).toEqual(rows);
  expect(f.status().state).toBe("unavailable");
  expect(f.index.search({ query: "foreign_opening_replacement" }).hits).toHaveLength(0);
});

it("review: revalidates environment binding after a source read and before destination publication", () => {
  const f = fixture(); event(f.input, 1); f.drain(); const before = f.rows();
  event(f.input, 2, "foreign_publication_replacement");
  const prepare = DatabaseSync.prototype.prepare;
  let changed = false;
  const intercept = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (this !== f.input && this.location() === f.file && sql.includes("CAST(payload_json AS BLOB)")) {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...args) => {
        const result = all(...args);
        if (!changed) { changed = true; writeFileSync(join(f.root, "userdata", "environment-id"), "replacement-environment"); }
        return result;
      });
    }
    return statement;
  });
  try { f.ingest.tick(); } finally { intercept.mockRestore(); }
  expect(changed).toBe(true); expect(f.rows()).toEqual(before);
  expect(f.state().sequence).toBe(1); expect(f.status().state).toBe("unavailable");
  expect(f.index.search({ query: "foreign_publication_replacement" }).hits).toHaveLength(0);
});

it("review: admits payload size before any CAST or JSON evaluation and reports unsupported rows", () => {
  const f = fixture(); event(f.input, 1, "x".repeat(1024 * 1024 + 1));
  const prepare = DatabaseSync.prototype.prepare;
  let payloadEvaluations = 0;
  const intercept = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (this !== f.input && this.location() === f.file && sql.includes("CAST(payload_json AS BLOB)")) payloadEvaluations++;
    return prepare.call(this, sql);
  });
  try { f.drain(); } finally { intercept.mockRestore(); }
  expect(payloadEvaluations).toBe(0); expect(f.rows("t3:fragment")).toHaveLength(0);
  expect(receipts(f)).toMatchObject([{ sequence: 1, outcome: "unavailable-oversized-message", confirmedBytes: 0 }]);
  expect(f.status().state).toBe("incomplete");
  event(f.input, 2, "supported_after_size_refusal"); f.drain();
  expect(f.index.search({ query: "supported_after_size_refusal" }).hits).toHaveLength(1);
});

it.each([250, 500])("review: retains exact %i-character T3 IDs with public-query-compatible keys", length => {
  const f = fixture(), child = "thread:delegated-task:" + "x".repeat(length - 22);
  thread(f.input, child, "root"); const expected = event(f.input, 1, `public_t3_identity_${length}`, child);
  f.drain();
  const hit = f.index.search({ query: `public_t3_identity_${length}` }).hits[0];
  expect(hit).toBeDefined();
  expect(historySearchSchema.safeParse({ query: "identity", filters: { session: hit!.session } }).success).toBe(true);
  expect(conversationPageSchema.safeParse({ id: hit!.conversation }).success).toBe(true);
  const metadata = f.rows("t3:metadata").map(r => JSON.parse(raw(r).toString())).find(r => r.thread_id === child);
  expect(metadata.thread_id).toBe(child); expect(metadata.environmentId).toBe("environment-one");
  expect(readConversation(f.db, { id: hit!.conversation! }).conversation?.parent).toBe("t3:environment-one:root");
  expect(fragments(f, 1)).toEqual(expected);
  const prior = f.rows(); f.restart(); f.drain(); expect(f.rows()).toEqual(prior);
});

it.each(["missing", "unknown", "busy"])("isolates %s T3 failure from native capture and preserves prior retained history", mode => {
  const f = fixture(); event(f.input, 1); f.drain(); const prior = f.rows(), state = f.state();
  const nativeDir = join(f.paths.claude, "projects", "fixture"); mkdirSync(nativeDir, { recursive: true });
  const nativeFile = join(nativeDir, "native.jsonl");
  writeFileSync(nativeFile, JSON.stringify({ type: "user", message: { content: `native_survives_${mode}` } }) + "\n");
  f.db.prepare("INSERT INTO history_files(path,kind,agent,session,cwd) VALUES(?,'transcript','claude','native',?)").run(nativeFile, f.project);
  const prepare = DatabaseSync.prototype.prepare;
  const failure = mode === "busy" ? vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (this !== f.input && this.location() === f.file) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    return prepare.call(this, sql);
  }) : undefined;
  if (mode === "missing") f.paths.t3 = join(f.env.home, "absent-t3");
  if (mode === "unknown") f.input.exec("ALTER TABLE orchestration_events RENAME COLUMN payload_json TO unsupported_payload");
  f.restart();
  try { f.drain(); } finally { failure?.mockRestore(); }
  expect(f.rows().filter(r => String(r.conversation).startsWith("t3:"))).toEqual(prior);
  if (mode !== "missing") expect(f.state()).toEqual(state);
  expect(f.index.search({ query: `native_survives_${mode}` }).hits).toHaveLength(1);
  expect(f.index.search({ query: "local_t3_orchid" }).hits).toHaveLength(1);
});

it("records unsupported message shapes/versions explicitly and does not fetch unrelated event payloads", () => {
  const f = fixture(); event(f.input, 1, "unavailable_version", "child", 3);
  event(f.input, 3, "unrelated_payload", "child", 2, "turn-item.updated");
  event(f.input, 9); f.input.prepare("UPDATE orchestration_events SET payload_json='{}' WHERE sequence=9").run();
  event(f.input, 12, "supported_after_gap"); f.drain();
  expect(receipts(f).map(r => [r.sequence, r.outcome])).toEqual([[1, "unavailable-event-schema"], [9, "unavailable-message-schema"], [12, "complete"]]);
  expect(f.status().state).toBe("incomplete");
  expect(f.rows("t3:fragment")).toHaveLength(1);
  expect(f.index.search({ query: "unrelated_payload" }).hits).toHaveLength(0);
  expect(f.index.search({ query: "supported_after_gap" }).hits).toHaveLength(1);
});

it("never implicitly discovers owner T3 storage in tests and refuses malformed explicit homes", () => {
  expect(localT3HistoryRoot({ AGENT_BRIDGE_TEST_ROOT: "", T3CODE_HOME: "inherited-owner-home" }, "/synthetic")).toBeUndefined();
  expect(localT3HistoryRoot({ T3CODE_HOME: "" }, "/synthetic")).toBe("");
  expect(localT3HistoryRoot({}, "/synthetic")).toMatch(/[\\/]synthetic[\\/]\.t3$/);
  const f = fixture(); f.paths.t3 = ""; f.restart(); f.drain();
  expect(f.status().reason).toBe("invalid explicit T3 home"); expect(f.rows()).toHaveLength(0);
});

it("refreshes metadata by bounded periodic keyset pages without losing same-time title changes", () => {
  const f = fixture(); event(f.input, 1); f.drain(); const before = f.rows("t3:metadata");
  f.input.prepare("UPDATE orchestration_v2_projection_threads SET title='same_time_zinnia' WHERE thread_id='child'").run();
  f.ingest.tick(); expect(f.rows("t3:metadata")).toEqual(before);
  const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
  try { f.drain(); } finally { clock.mockRestore(); }
  expect(f.index.search({ query: "same_time_zinnia" }).hits).toHaveLength(1);
  for (const row of before) expect(f.rows().find(r => r.id === row.id)).toEqual(row);
});
