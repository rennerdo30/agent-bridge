import { copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copyLegacyConversationTail, historyDbPath, historyMigrationFailure, historyReadPath, historyReady, HISTORY_TABLES, migrateHistoryStore, openHistoryStore, releaseExitedHistoryLease, type HistoryMigrationProgress } from "../src/core/history-store.js";
import { decodeHistoryRow, HISTORY_V1_PREFIX } from "../src/core/history-migration.js";
import { CODEC_PLAIN } from "../src/core/history-codec.js";
import { MessageStore } from "../src/core/store.js";
import { loadConfig } from "../src/core/config.js";
import { ConversationIngestor, indexedConversationText } from "../src/core/conversations.js";
import { HistoryIndex } from "../src/core/history.js";
import { nullLogger } from "../src/core/logger.js";
import { HistoryBackground } from "../src/core/history-background.js";
import { historySchema } from "../src/core/history-schema.js";
import { CONVERSATION_SCHEMA } from "../src/core/conversation-schema.js";
import { installTranscriptFixtures } from "./transcript-fixtures.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
const closes: (() => void)[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) close(); await env.cleanup(); vi.unstubAllEnvs(); });
function legacy() {
  copyFileSync(join(import.meta.dirname, "fixtures/owner-questions-upgrade/v0.29.17/bridge.db"), env.db);
  const db = new DatabaseSync(env.db); closes.push(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000");
  db.prepare("INSERT OR IGNORE INTO conversations(id,agent,session) VALUES('codex:legacy','codex','legacy')").run();
  for (let i = 0; i < 80; i++) db.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('legacy-source',0,?,'codex:legacy',1,?,?)").run(i, Buffer.from([0,255,i]), `retained-${i}`);
  return db;
}
function target() { const db = openHistoryStore(historyDbPath(env.db)); closes.push(() => db.close()); return db; }
type Row = Record<string, SQLInputValue>;
/** v2 rows decoded back to the legacy layout, keyed like the legacy SELECT rowid,* rows. */
function decoded(db: DatabaseSync, table: string, filter = ""): Row[] {
  return db.prepare(`SELECT rowid,* FROM ${table} ${filter} ORDER BY rowid`).all().map(row => {
    const { rowid, ...rest } = decodeHistoryRow(table, row as Row);
    // SELECT rowid,* names the column after an INTEGER PRIMARY KEY alias instead.
    return (rowid === undefined ? rest : { rowid, ...rest }) as Row;
  });
}
function legacyRows(db: DatabaseSync, table: string): Row[] {
  return db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all().map(row => {
    // Byte columns decode to Buffer; compare the same representation.
    const out: Row = {};
    for (const [key, value] of Object.entries(row)) out[key] = value instanceof Uint8Array ? Buffer.from(value) : value;
    return out;
  });
}
function normalize(rows: Row[]): Row[] {
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v) : v])));
}
function copyState(db: DatabaseSync, table: string) {
  return db.prepare("SELECT * FROM history_copy_state WHERE table_name=?").get(table);
}

it("copies and verifies actual .17 tables from a consistent snapshot, preserving raw bytes and the bridge schema", async () => {
  const old = legacy(), db = target();
  expect(historyReadPath(env.db)).toBe(env.db);
  const version = old.prepare("PRAGMA user_version").get()!.user_version;
  await migrateHistoryStore(env.db, db);
  expect(historyReady(db)).toBe(true);
  expect(historyReadPath(env.db)).toBe(historyDbPath(env.db));
  expect(old.prepare("PRAGMA user_version").get()!.user_version).toBe(version);
  const state = db.prepare("SELECT * FROM history_migration").get()!;
  expect(existsSync(String(state.snapshot))).toBe(true);
  expect(state.source).toBe("bridge");
  const manifest = JSON.parse(String(state.manifest));
  for (const table of HISTORY_TABLES) {
    if (!old.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
    const filter = table === "history_cursors" ? "WHERE source<>'legacy-record-tail'" : "";
    expect(normalize(decoded(db, table, filter))).toEqual(legacyRows(old, table));
    expect(manifest[table].rows).toBe(Number(old.prepare(`SELECT count(*) n FROM ${table}`).get()!.n));
    expect(manifest[table].sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  await migrateHistoryStore(env.db, db);
  expect(db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot).toBe(state.snapshot);
});

it("stores large text compressed and once, restores it byte-exact, and keeps search working", async () => {
  const old = legacy();
  const text = JSON.stringify({ type: "message", content: [{ type: "text", text: "walnut compression needle " + "lorem ipsum dolor ".repeat(400) }] });
  for (let i = 0; i < 20; i++) old.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('big',0,?,'codex:legacy',1,?,?)").run(i, Buffer.from(text), text);
  old.prepare("INSERT INTO history_documents(id,kind,agent,at,body,folded,link) VALUES('big-doc','transcript','codex',1,?,?,'/big')").run("Walnut Café " + "lorem ipsum ".repeat(500), ("Walnut Café " + "lorem ipsum ".repeat(500)).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase());
  const db = target();
  await migrateHistoryStore(env.db, db);
  const record = db.prepare("SELECT raw,raw_codec,body FROM conversation_records WHERE source='big' LIMIT 1").get()!;
  expect(record.raw_codec).not.toBe(CODEC_PLAIN);
  expect((record.raw as Uint8Array).length).toBeLessThan(Buffer.byteLength(text) / 5);
  expect(record.body).toBeNull();
  const doc = db.prepare("SELECT body_codec,folded FROM history_documents WHERE id='big-doc'").get()!;
  expect(doc.body_codec).not.toBe(CODEC_PLAIN);
  expect(doc.folded).toBeNull();
  expect(normalize(decoded(db, "conversation_records"))).toEqual(legacyRows(old, "conversation_records"));
  // Readable views for our own viewer.
  expect(db.prepare("SELECT raw_text FROM v_conversation_records WHERE source='big' LIMIT 1").get()!.raw_text).toBe(text);
  expect(new HistoryIndex(db, null).search({ query: "walnut cafe" }).hits.map(hit => hit.id)).toContain("big-doc");
});

it("resumes an interrupted copy against its original snapshot without deleting source rows", async () => {
  const old = legacy(), db = target();
  await expect(migrateHistoryStore(env.db, db, () => false, () => Number(db.prepare("SELECT count(*) n FROM conversation_records").get()!.n) > 0)).rejects.toThrow("stopped");
  const snapshot = db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot;
  expect(historyReady(db)).toBe(false);
  expect(historyMigrationFailure(db)).toBeNull();
  await migrateHistoryStore(env.db, db);
  expect(historyReady(db)).toBe(true);
  expect(db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot).toBe(snapshot);
  expect(normalize(decoded(db, "conversation_records"))).toEqual(legacyRows(old, "conversation_records"));
});

it("fails closed on a copy conflict, latches the failure, and an explicit retry keeps the failed attempt", async () => {
  const old = legacy(), db = target();
  const row = old.prepare("SELECT * FROM history_documents LIMIT 1").get()!;
  db.prepare("INSERT INTO history_documents(id,kind,agent,at,body,body_codec,folded,link,message,job,run,session,cursor) VALUES(?,?,?,?,?,0,?,?,?,?,?,?,?)").run(row.id!,row.kind!,row.agent!,row.at!,"conflict",row.folded!,row.link!,row.message!,row.job!,row.run!,row.session!,row.cursor!);
  await expect(migrateHistoryStore(env.db, db)).rejects.toThrow();
  expect(historyReady(db)).toBe(false);
  expect(existsSync(String(db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot))).toBe(true);
  expect(old.prepare("SELECT body FROM history_documents WHERE id=?").get(row.id!)!.body).toBe(row.body);
  expect(historyMigrationFailure(db)).toBeTruthy();
  await expect(migrateHistoryStore(env.db, db)).rejects.toThrow("explicit retry");
  await migrateHistoryStore(env.db, db, undefined, undefined, undefined, true);
  expect(historyMigrationFailure(db)).toBeNull();
  expect(historyReady(db)).toBe(true);
  // The conflicting partial attempt is retained, not erased.
  const retained = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'retained_%_history_documents'").get()!;
  expect(db.prepare(`SELECT body FROM "${retained.name}" WHERE id=?`).get(row.id!)!.body).toBe("conflict");
  expect(decodeHistoryRow("history_documents", db.prepare("SELECT * FROM history_documents WHERE id=?").get(row.id!)!).body).toBe(row.body);
});

it("copies rows appended after the snapshot through the legacy tail, idempotently", async () => {
  const old = legacy(), db = target();
  await migrateHistoryStore(env.db, db);
  old.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('after-snapshot',0,0,'codex:legacy',1,?,'late')").run(Buffer.from("late"));
  expect(copyLegacyConversationTail(old, db)).toBe(1);
  expect(copyLegacyConversationTail(old, db)).toBe(0);
  const row = db.prepare("SELECT * FROM conversation_records WHERE source='after-snapshot'").get()!;
  expect((decodeHistoryRow("conversation_records", row).raw as Buffer).toString()).toBe("late");
});

it("honors pressure before snapshot work and stop during the pressure pause", async () => {
  legacy(); const db = target(); let paused = true, stop = false;
  const migration = migrateHistoryStore(env.db, db, () => paused, () => stop);
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(db.prepare("SELECT * FROM history_migration").get()).toBeUndefined();
  expect(readdirSync(env.home)).not.toContain(".migration-snapshots");
  stop = true; paused = false;
  await expect(migration).rejects.toThrow("stopped");
  expect(historyMigrationFailure(db)).toBeNull();
});

it("honors pressure during verification and preserves the copy on stop", async () => {
  legacy(); const db = target(); let paused = false, stop = false;
  const migration = migrateHistoryStore(env.db, db, () => {
    if (Number(copyState(db, "conversation_records")?.verified_rows ?? 0) > 0) paused = true;
    return paused;
  }, () => stop);
  for (let i = 0; i < 500 && !paused; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(paused).toBe(true);
  expect(historyReady(db)).toBe(false);
  stop = true;
  await expect(migration).rejects.toThrow("stopped");
  expect(historyMigrationFailure(db)).toBeNull();
  const snapshot = db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot;
  await migrateHistoryStore(env.db, db);
  expect(historyReady(db)).toBe(true);
  expect(db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot).toBe(snapshot);
});

it("persists copy and verification cursors and resumes each phase after a stop", async () => {
  const old = legacy();
  for (let i = 0; i < 400; i++) old.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('many',0,?,'codex:legacy',1,?,'x')").run(i, Buffer.from(`row ${i}`));
  const db = target(); const total = Number(old.prepare("SELECT count(*) n FROM conversation_records").get()!.n);
  for (const field of ["copied_rows", "verified_rows"]) {
    let stop = false;
    await expect(migrateHistoryStore(env.db, db, () => false, () => stop, undefined, false, { onProgress: () => {
      const n = Number(copyState(db, "conversation_records")?.[field] ?? 0);
      if (n > 0 && n < total) stop = true;
    } })).rejects.toThrow("stopped");
    const state = copyState(db, "conversation_records")!;
    expect(Number(state[field])).toBeGreaterThan(0);
    expect(Number(state[field])).toBeLessThan(total);
    if (field === "verified_rows") expect(state.copied_rows).toBe(total);
  }
  await migrateHistoryStore(env.db, db);
  expect(historyReady(db)).toBe(true);
  expect(copyState(db, "conversation_records")).toMatchObject({ copied_rows: total, verified_rows: total, done: 1, verified: 1 });
  expect(normalize(decoded(db, "conversation_records"))).toEqual(legacyRows(old, "conversation_records"));
});

it("does not retry failed verification after worker restart until explicit reindex", async () => {
  const old = legacy(), db = target();
  const row = old.prepare("SELECT * FROM history_documents LIMIT 1").get()!;
  db.prepare("INSERT INTO history_documents(id,kind,agent,at,body,body_codec,folded,link,message,job,run,session,cursor) VALUES(?,?,?,?,?,0,?,?,?,?,?,?,?)").run(row.id!,row.kind!,row.agent!,row.at!,"conflict",row.folded!,row.link!,row.message!,row.job!,row.run!,row.session!,row.cursor!);
  await expect(migrateHistoryStore(env.db, db)).rejects.toThrow();
  vi.stubEnv("CODEX_HOME", join(env.home, "codex-fixture"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(env.home, "claude-fixture"));
  vi.stubEnv("XDG_DATA_HOME", join(env.home, "xdg-fixture"));
  vi.stubEnv("ANTIGRAVITY_CLI_HOME", join(env.home, "antigravity-fixture"));
  const warnings: string[] = [];
  const worker = new HistoryBackground(env.db, { ...nullLogger, warn: (text: string) => warnings.push(text) });
  try {
    await new Promise(resolve => setTimeout(resolve, 2300));
    expect(historyReady(db)).toBe(false);
    expect(warnings).toEqual(["history background batch deferred"]);
    await expect(worker.tick()).rejects.toThrow();
    expect(historyReady(db)).toBe(false);
    worker.pressure(true);
    await worker.tick(true); // Explicit retry survives a pressure-deferred request.
    expect(historyReady(db)).toBe(false);
    worker.pressure(false);
    await worker.tick();
    expect(historyReady(db)).toBe(true);
    expect(historyMigrationFailure(db)).toBeNull();
  } finally { await worker.close(); }
}, 30_000);

it("bases ETA on new work when resuming", async () => {
  const old = legacy();
  for (let i = 0; i < 400; i++) old.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('eta',0,?,'codex:legacy',1,?,'x')").run(i, Buffer.from(`row ${i}`));
  const db = target(); let stop = false;
  await expect(migrateHistoryStore(env.db, db, () => false, () => stop, undefined, false, { onProgress: () => {
    if (Number(copyState(db, "conversation_records")?.copied_rows ?? 0) > 0) stop = true;
  } })).rejects.toThrow("stopped");
  const now = Date.now.bind(Date); let offset = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + offset);
  const updates: HistoryMigrationProgress[] = [];
  let baseline: HistoryMigrationProgress | undefined;
  try {
    await migrateHistoryStore(env.db, db, undefined, undefined, undefined, false, { onProgress: progress => {
      updates.push(progress);
      if (!baseline) { baseline = progress; offset = 60_000; }
    } });
  } finally { clock.mockRestore(); }
  expect(baseline!.completedRows).toBeGreaterThan(0);
  expect(baseline!.etaSeconds).toBeNull();
  const advanced = updates.find(progress => progress.completedRows > baseline!.completedRows && progress.phase !== "verified")!;
  expect(advanced).toBeDefined();
  expect(advanced.etaSeconds).not.toBeNull();
  expect(historyReady(db)).toBe(true);
});

it("upgrades a verified v1 store in place, keeps its tables and copies from them", async () => {
  legacy();
  const path = historyDbPath(env.db);
  const v1 = new DatabaseSync(path);
  v1.exec(historySchema().replace(/CREATE TRIGGER history_message_(?:insert|claim)[\s\S]*?END;/g, "").replace(/PRAGMA user_version = 4;/, ""));
  v1.exec(CONVERSATION_SCHEMA.slice(0, CONVERSATION_SCHEMA.indexOf("INSERT OR IGNORE INTO conversation_envelopes")));
  v1.exec(`CREATE TABLE history_migration(version INTEGER PRIMARY KEY, snapshot TEXT NOT NULL, status TEXT NOT NULL, manifest TEXT);
    CREATE TABLE history_legacy_tail(source_id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL);
    INSERT INTO history_migration VALUES(1,'old-snapshot','verified','{}');
    INSERT INTO conversations(id,agent,session) VALUES('codex:v1-only','codex','v1');
    PRAGMA user_version=1;`);
  const raw = Buffer.from("ingested after the v1 migration ".repeat(40));
  v1.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('v1-only',0,0,'codex:v1-only',1,?,'')").run(raw);
  v1.prepare("INSERT INTO history_documents(id,kind,agent,at,body,folded,link) VALUES('v1-doc','transcript','codex',1,'Pecan v1 document','pecan v1 document','/v1')").run();
  v1.close();
  const db = target();
  expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
  expect(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name=?").get(`${HISTORY_V1_PREFIX}conversation_records`)!.n).toBe(1);
  await migrateHistoryStore(env.db, db);
  expect(db.prepare("SELECT source FROM history_migration").get()!.source).toBe("history-v1");
  const copied = decodeHistoryRow("conversation_records", db.prepare("SELECT * FROM conversation_records WHERE source='v1-only'").get()!);
  expect((copied.raw as Buffer).equals(raw)).toBe(true);
  expect(copied.body).toBe("");
  expect(Buffer.from(db.prepare(`SELECT raw FROM ${HISTORY_V1_PREFIX}conversation_records WHERE source='v1-only'`).get()!.raw as Uint8Array).equals(raw)).toBe(true);
  expect(new HistoryIndex(db, null).search({ query: "pecan" }).hits.map(hit => hit.id)).toEqual(["v1-doc"]);
});

it("migrates history-only legacy schemas and leaves native ingestion able to continue", async () => {
  const old = new DatabaseSync(env.db); closes.push(() => old.close());
  // Schema6 precedes transcript storage but already has searchable history tables.
  old.exec("CREATE TABLE messages(id TEXT,body TEXT,from_agent TEXT,from_name TEXT,from_id TEXT,recipient TEXT,to_target TEXT,created_at INTEGER)");
  old.exec(historySchema());
  old.exec("CREATE TABLE decisions(id TEXT); PRAGMA user_version=6");
  old.prepare("INSERT INTO history_documents VALUES('legacy','message','codex',1,'history-only','history-only','/legacy',NULL,NULL,NULL,NULL,NULL)").run();
  const db = target(); await migrateHistoryStore(env.db,db);
  expect(historyReady(db)).toBe(true); expect(copyLegacyConversationTail(old,db)).toBe(0);
  const fixtures = installTranscriptFixtures(env.home);
  db.prepare("INSERT INTO history_files VALUES(?,'transcript','claude','session-example',?,NULL,0)").run(fixtures.claude,env.home);
  const ingest = new ConversationIngestor(db,env.home,fixtures.paths,old);
  try {
    for (let i = 0; i < 12; i++) ingest.tick();
    expect(db.prepare("SELECT count(*) n FROM conversation_records").get()!.n).toBeGreaterThan(0);
  } finally { ingest.close(); }
});

it("replays .17 raw appends after snapshot despite colliding numeric ids, idempotently", async () => {
  const old = legacy(), db = target();
  await migrateHistoryStore(env.db, db);
  // A new ingestor allocates the same next numeric id before a pinned writer appends.
  db.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('new',0,0,'codex:legacy',1,?,'new')").run(Buffer.from("new"));
  const raw = Buffer.from([0,255,128,12]);
  old.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('late-old',0,0,'codex:legacy',1,?,'old')").run(raw);
  expect(copyLegacyConversationTail(old, db)).toBe(1);
  expect(copyLegacyConversationTail(old, db)).toBe(0);
  expect(decodeHistoryRow("conversation_records", db.prepare("SELECT * FROM conversation_records WHERE source='late-old'").get()!).raw).toEqual(raw);
  expect(Buffer.from(db.prepare("SELECT raw FROM conversation_records WHERE source='new'").get()!.raw as Uint8Array).toString()).toBe("new");
  expect(db.prepare("SELECT source_id,target_id FROM history_legacy_tail").get()!.target_id).not.toBe(db.prepare("SELECT source_id FROM history_legacy_tail").get()!.source_id);
});

it("honors both kill switches and indexes text without duplicating full transcript metadata", () => {
  expect(loadConfig(env.home,"other",nullLogger,{}).history.ingest).toBe(true);
  writeFileSync(join(env.home,"config.json"), JSON.stringify({ history: { ingest: false } }));
  expect(loadConfig(env.home,"other",nullLogger,{}).history.ingest).toBe(false);
  writeFileSync(join(env.home,"config.json"), "{}");
  expect(loadConfig(env.home,"other",nullLogger,{ AGENT_BRIDGE_HISTORY_INGEST: "0" }).history.ingest).toBe(false);
  expect(loadConfig(env.home,"other",nullLogger,{ AGENT_BRIDGE_HISTORY_INGEST: "false" }).history.ingest).toBe(false);
  expect(indexedConversationText(Buffer.from(JSON.stringify({ payload: { content: [{ text: "search needle" }] }, metadata: "x".repeat(60000) })))).toBe("search needle");
});

it("preserves a future history schema, falls back to legacy reads, and cleans constructor resources", () => {
  const old = legacy(), db = target();
  db.exec("PRAGMA user_version=3");
  expect(() => openHistoryStore(historyDbPath(env.db))).toThrow("unsupported history store version");
  expect(historyReadPath(env.db)).toBe(env.db);
  expect(() => new MessageStore(env.db,nullLogger)).toThrow("unsupported history store version");
  expect(readdirSync(join(env.home,".storage-users"))).toEqual([]);
  // A failed constructor leaves neither an authoritative writer lock nor a schema rewrite.
  old.exec("BEGIN IMMEDIATE; COMMIT");
  expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(3);
});

it("cleans a terminated worker lease only when its exact owner nonce still matches", () => {
  const path = `${historyDbPath(env.db)}.migration-lock`;
  const owner = JSON.stringify({pid:process.pid,nonce:"original-worker"});
  const other = JSON.stringify({pid:process.pid,nonce:"another-worker"});
  writeFileSync(path,other);
  releaseExitedHistoryLease(env.db,owner);
  expect(existsSync(path)).toBe(true);
  releaseExitedHistoryLease(env.db,other);
  expect(existsSync(path)).toBe(false);
});

it("verifies regardless of how the copy and verification passes cut rows into batches", async () => {
  const old = legacy();
  for (let i = 0; i < 300; i++) old.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('batches',0,?,'codex:legacy',1,?,'x')").run(i, Buffer.from(`row ${i}`));
  const db = target();
  // During the copy every row takes "100 ms", so copy batches hold one row; verification batches are large.
  const real = Date.now.bind(Date); let offset = 0, copying = true;
  vi.spyOn(Date, "now").mockImplementation(() => copying ? real() + (offset += 100) : real());
  await migrateHistoryStore(env.db, db, () => false, () => false, undefined, false, { onProgress: progress => { if (progress.phase === "verify") copying = false; } });
  expect(historyReady(db)).toBe(true);
  expect(normalize(decoded(db, "conversation_records"))).toEqual(legacyRows(old, "conversation_records"));
});
