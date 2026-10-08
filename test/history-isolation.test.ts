import { copyFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copyLegacyConversationTail, historyDbPath, historyMigrationFailure, historyReadPath, historyReady, HISTORY_TABLES, migrateHistoryStore, openHistoryStore, releaseExitedHistoryLease } from "../src/core/history-store.js";
import { MessageStore } from "../src/core/store.js";
import { loadConfig } from "../src/core/config.js";
import { ConversationIngestor, indexedConversationText } from "../src/core/conversations.js";
import { nullLogger } from "../src/core/logger.js";
import { HistoryBackground } from "../src/core/history-background.js";
import { installTranscriptFixtures } from "./transcript-fixtures.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
const closes: (() => void)[] = [];
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { for (const close of closes.splice(0).reverse()) close(); await env.cleanup(); vi.unstubAllEnvs(); });
function legacy() {
  copyFileSync(join(import.meta.dirname, "fixtures/owner-questions-upgrade/v0.29.17/bridge.db"), env.db);
  const db = new DatabaseSync(env.db); closes.push(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000");
  db.prepare("INSERT OR IGNORE INTO conversations(id,agent,session) VALUES('codex:legacy','codex','legacy')").run();
  for (let i = 0; i < 80; i++) db.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('legacy-source',0,?,'codex:legacy',1,?,?)").run(i, Buffer.from([0,255,i]), `retained-${i}`);
  return db;
}
function target() { const db = openHistoryStore(historyDbPath(env.db)); closes.push(() => db.close()); return db; }

it("copies and verifies actual .17 tables with protected backup, preserving raw bytes and bridge schema", async () => {
  const old = legacy(), db = target();
  expect(historyReadPath(env.db)).toBe(env.db);
  const version = old.prepare("PRAGMA user_version").get()!.user_version;
  await migrateHistoryStore(env.db, db);
  expect(historyReady(db)).toBe(true);
  expect(historyReadPath(env.db)).toBe(historyDbPath(env.db));
  expect(old.prepare("PRAGMA user_version").get()!.user_version).toBe(version);
  const state = db.prepare("SELECT * FROM history_migration").get()!;
  expect(existsSync(String(state.snapshot))).toBe(true);
  const manifest = JSON.parse(String(state.manifest));
  for (const table of HISTORY_TABLES) {
    const filter = table === "history_cursors" ? "WHERE source<>'legacy-record-tail'" : "";
    expect(db.prepare(`SELECT rowid,* FROM ${table} ${filter} ORDER BY rowid`).all()).toEqual(old.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all());
    expect(manifest[table].rows).toBe(Number(old.prepare(`SELECT count(*) n FROM ${table}`).get()!.n));
    expect(manifest[table].sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  await migrateHistoryStore(env.db, db);
  expect(db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot).toBe(state.snapshot);
});

it("resumes an interrupted copy against its original snapshot without deleting source rows", async () => {
  const old = legacy(), db = target();
  await expect(migrateHistoryStore(env.db, db, () => false, () => Number(db.prepare("SELECT count(*) n FROM conversation_records").get()!.n) > 0)).rejects.toThrow("stopped");
  const snapshot = db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot;
  expect(historyReady(db)).toBe(false);
  await migrateHistoryStore(env.db, db);
  expect(historyReady(db)).toBe(true);
  expect(db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot).toBe(snapshot);
  expect(db.prepare("SELECT * FROM conversation_records").all()).toEqual(old.prepare("SELECT * FROM conversation_records").all());
});

it("fails closed on copy conflict and retains the backup and all original data", async () => {
  const old = legacy(), db = target();
  const row = old.prepare("SELECT * FROM history_documents LIMIT 1").get()!;
  db.prepare("INSERT INTO history_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(row.id!,row.kind!,row.agent!,row.at!,"conflict",row.folded!,row.link!,row.message!,row.job!,row.run!,row.session!,row.cursor!);
  await expect(migrateHistoryStore(env.db, db)).rejects.toThrow("verification failed");
  expect(historyReady(db)).toBe(false);
  expect(existsSync(String(db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot))).toBe(true);
  expect(old.prepare("SELECT body FROM history_documents WHERE id=?").get(row.id!)!.body).toBe(row.body);
  expect(historyMigrationFailure(db)).toMatch(/verification failed/);
  const snapshot = db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot;
  const retained = db.prepare("SELECT count(*) n FROM conversation_records").get()!.n;
  await expect(migrateHistoryStore(env.db, db)).rejects.toThrow("explicit retry");
  expect(db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot).toBe(snapshot);
  expect(db.prepare("SELECT count(*) n FROM conversation_records").get()!.n).toBe(retained);
  db.prepare("UPDATE history_documents SET body=? WHERE id=?").run(row.body!, row.id!);
  await migrateHistoryStore(env.db, db, undefined, undefined, undefined, true);
  expect(historyMigrationFailure(db)).toBeNull();
  expect(historyReady(db)).toBe(true);
});

it("backs up only history tables and excludes unrelated broker payloads and FTS shadow tables", async () => {
  const old = legacy(), db = target();
  old.exec("CREATE TABLE unrelated_payload(raw BLOB); INSERT INTO unrelated_payload VALUES(zeroblob(8388608))");
  await migrateHistoryStore(env.db, db);
  const snapshot = String(db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot);
  const backup = new DatabaseSync(snapshot, { readOnly: true });
  try {
    expect(backup.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name)).toEqual([...HISTORY_TABLES].sort());
    expect(statSync(snapshot).size).toBeLessThan(1024 * 1024);
    expect(backup.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    expect(backup.prepare("SELECT raw FROM conversation_records ORDER BY id").all()).toEqual(old.prepare("SELECT raw FROM conversation_records ORDER BY id").all());
  } finally { backup.close(); }
  expect(old.prepare("SELECT length(raw) n FROM unrelated_payload").get()!.n).toBe(8388608);
});

it("resumes durable snapshot chunks against a new consistent view without abandoning retained data", async () => {
  const old = legacy(), db = target();
  let checks = 0;
  await expect(migrateHistoryStore(env.db, db, () => false, () => ++checks > 7)).rejects.toThrow("stopped");
  const state = db.prepare("SELECT snapshot,status FROM history_migration").get()!;
  expect(state.status).toBe("snapshotting");
  expect(existsSync(String(state.snapshot))).toBe(true);
  expect(db.prepare("SELECT count(*) n FROM conversation_records").get()!.n).toBe(0);
  old.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('after-stop',0,0,'codex:legacy',1,?,'after stop')").run(Buffer.from("after stop"));
  await migrateHistoryStore(env.db, db);
  expect(historyReady(db)).toBe(true);
  expect(existsSync(String(state.snapshot))).toBe(true);
  expect(db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot).toBe(state.snapshot);
  // The append-only fence remains the initial high-water mark. Late rows replay
  // from the preserved legacy tail rather than moving that consistent cohort.
  expect(copyLegacyConversationTail(old, db)).toBe(1);
  expect(db.prepare("SELECT raw FROM conversation_records WHERE source='after-stop'").get()!.raw).toEqual(old.prepare("SELECT raw FROM conversation_records WHERE source='after-stop'").get()!.raw);
});

it("holds one source snapshot across tables while allowing legacy WAL appends", async () => {
  const old = legacy(), db = target();
  let appended = false;
  await migrateHistoryStore(env.db, db, () => {
    const state = db.prepare("SELECT snapshot,status FROM history_migration").get();
    if (!appended && state?.status === "snapshotting" && existsSync(String(state.snapshot))) {
      const backup = new DatabaseSync(String(state.snapshot), { readOnly: true });
      try {
        if (backup.prepare("SELECT name FROM sqlite_master WHERE name='history_cursors'").get()) {
          // Earlier tables are already committed to the backup. A late table append
          // must not enter the same snapshot with a different source view.
          old.prepare("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('during-snapshot',0,0,'codex:legacy',1,?,'late')").run(Buffer.from("late"));
          appended = true;
        }
      } finally { backup.close(); }
    }
    return false;
  });
  expect(appended).toBe(true);
  expect(db.prepare("SELECT * FROM conversation_records WHERE source='during-snapshot'").get()).toBeUndefined();
  expect(copyLegacyConversationTail(old, db)).toBe(1);
  expect(Buffer.from(db.prepare("SELECT raw FROM conversation_records WHERE source='during-snapshot'").get()!.raw as Uint8Array).toString()).toBe("late");
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

it("honors pressure during target verification and preserves the copy on stop", async () => {
  legacy(); const db = target(); let paused = false, stop = false;
  const migration = migrateHistoryStore(env.db, db, () => {
    if (Number(db.prepare("SELECT count(*) n FROM conversation_records").get()!.n) === 80) paused = true;
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

it("releases the source read transaction after sustained pressure and retains its partial snapshot", async () => {
  const old = legacy(), db = target(); let pressure = false;
  await expect(migrateHistoryStore(env.db, db, () => {
    const state = db.prepare("SELECT snapshot FROM history_migration").get();
    if (!pressure && state && existsSync(String(state.snapshot))) {
      const backup = new DatabaseSync(String(state.snapshot), { readOnly: true });
      try { pressure = !!backup.prepare("SELECT name FROM sqlite_master WHERE name='history_cursors'").get(); }
      finally { backup.close(); }
    }
    return pressure;
  })).rejects.toMatchObject({ code: "HISTORY_SNAPSHOT_PAUSED" });
  const state = db.prepare("SELECT snapshot,status FROM history_migration").get()!;
  expect(state.status).toBe("snapshotting");
  expect(existsSync(String(state.snapshot))).toBe(true);
  expect(historyMigrationFailure(db)).toBeNull();
  // No surviving read transaction pins committed WAL pages after the pause abort.
  expect(old.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!.busy).toBe(0);
  await migrateHistoryStore(env.db, db);
  expect(historyReady(db)).toBe(true);
  expect(existsSync(String(state.snapshot))).toBe(true);
  expect(db.prepare("SELECT snapshot FROM history_migration").get()!.snapshot).toBe(state.snapshot);
});

it("does not retry failed verification after worker restart until explicit reindex", async () => {
  const old = legacy(), db = target();
  const row = old.prepare("SELECT * FROM history_documents LIMIT 1").get()!;
  db.prepare("INSERT INTO history_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(row.id!,row.kind!,row.agent!,row.at!,"conflict",row.folded!,row.link!,row.message!,row.job!,row.run!,row.session!,row.cursor!);
  await expect(migrateHistoryStore(env.db, db)).rejects.toThrow("verification failed");
  db.prepare("UPDATE history_documents SET body=? WHERE id=?").run(row.body!, row.id!);
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
    await expect(worker.tick()).rejects.toThrow("verification failed");
    expect(historyReady(db)).toBe(false);
    worker.pressure(true);
    await worker.tick(true); // Explicit retry survives a pressure-deferred request.
    expect(historyReady(db)).toBe(false);
    worker.pressure(false);
    await worker.tick();
    expect(historyReady(db)).toBe(true);
    expect(historyMigrationFailure(db)).toBeNull();
  } finally { await worker.close(); }
}, 15_000);

function checkpoint(db: DatabaseSync, table: string) {
  const state = db.prepare("SELECT snapshot FROM history_migration").get();
  if (!state || !existsSync(`${state.snapshot}.progress.db`)) return undefined;
  const meta = new DatabaseSync(`${state.snapshot}.progress.db`, { readOnly: true, timeout: 100 });
  try {
    if (!meta.prepare("SELECT name FROM sqlite_master WHERE name='table_state'").get()) return undefined;
    return meta.prepare("SELECT * FROM table_state WHERE table_name=?").get(table);
  } finally { meta.close(); }
}

it("persists separate snapshot, copy and verification chunk cursors and resumes each phase", async () => {
  legacy(); const db = target();
  const snapshots: unknown[] = [];
  for (const field of ["snapshot_rows", "copy_rows", "verify_rows"]) {
    let stop = false;
    await expect(migrateHistoryStore(env.db, db, () => false, () => stop, undefined, false, { onProgress: progress => {
      const state = checkpoint(db, "conversation_records");
      if (state && Number(state[field]) >= 32 && Number(state[field]) < 80) { stop = true; snapshots.push(progress.snapshot); }
    } })).rejects.toThrow("stopped");
    const state = checkpoint(db,"conversation_records")!;
    expect(state[field]).toBe(32);
    for (const earlier of ["snapshot_rows", "copy_rows", "verify_rows"].slice(0,["snapshot_rows", "copy_rows", "verify_rows"].indexOf(field))) expect(state[earlier]).toBe(80);
  }
  await migrateHistoryStore(env.db, db);
  expect(historyReady(db)).toBe(true);
  expect(new Set(snapshots).size).toBe(1);
  expect(checkpoint(db,"conversation_records")).toMatchObject({snapshot_rows:80,snapshot_verify_rows:80,copy_rows:80,verify_rows:80,snapshot_done:1,copy_done:1,verify_done:1});
});

it("retains a changed mutable table generation and reuses unchanged snapshot chunks", async () => {
  const old = legacy(), db = target(); let stop = false;
  const row = old.prepare("SELECT id,body FROM history_documents LIMIT 1").get()!;
  await expect(migrateHistoryStore(env.db, db, () => false, () => stop, undefined, false, { onProgress: () => {
    if (checkpoint(db,"history_documents")?.snapshot_done) stop = true;
  } })).rejects.toThrow("stopped");
  const state = db.prepare("SELECT snapshot FROM history_migration").get()!;
  old.prepare("UPDATE history_documents SET body='updated retained history' WHERE id=?").run(row.id!);
  await migrateHistoryStore(env.db, db);
  expect(historyReady(db)).toBe(true);
  expect(db.prepare("SELECT body FROM history_documents WHERE id=?").get(row.id!)!.body).toBe("updated retained history");
  const meta = new DatabaseSync(`${state.snapshot}.progress.db`, { readOnly: true });
  const backup = new DatabaseSync(String(state.snapshot), { readOnly: true });
  try {
    const archived = meta.prepare("SELECT archived_table FROM artifacts WHERE table_name='history_documents' AND generation=0").get()!;
    expect(archived).toBeDefined();
    expect(backup.prepare(`SELECT body FROM "${archived.archived_table}" WHERE id=?`).get(row.id!)!.body).toBe(row.body);
    expect(checkpoint(db,"history_documents")!.generation).toBe(1);
  } finally { meta.close(); backup.close(); }
});

it("migrates history-only legacy schemas and leaves native ingestion able to continue", async () => {
  const old = new DatabaseSync(env.db); closes.push(() => old.close());
  // Schema6 precedes transcript storage but already has searchable history tables.
  const { historySchema } = await import("../src/core/history-schema.js");
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
  expect(Buffer.from(db.prepare("SELECT raw FROM conversation_records WHERE source='late-old'").get()!.raw as Uint8Array)).toEqual(raw);
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
  db.exec("PRAGMA user_version=2");
  expect(() => openHistoryStore(historyDbPath(env.db))).toThrow("unsupported history store version");
  expect(historyReadPath(env.db)).toBe(env.db);
  expect(() => new MessageStore(env.db,nullLogger)).toThrow("unsupported history store version");
  expect(readdirSync(join(env.home,".storage-users"))).toEqual([]);
  // A failed constructor leaves neither an authoritative writer lock nor a schema rewrite.
  old.exec("BEGIN IMMEDIATE; COMMIT");
  expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
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
