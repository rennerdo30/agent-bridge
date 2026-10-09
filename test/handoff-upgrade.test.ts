import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commitHandoff, migrateJobOwnership } from "../src/core/job-handoff.js";
import { writeJsonStore, JSON_STORE_VERSION } from "../src/core/json-store.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import type { PeerInfo } from "../src/core/protocol.js";
import { DatabaseSync } from "node:sqlite";
import { MessageStore, SQLITE_STORE_VERSION } from "../src/core/store.js";
import { migrateSqlite } from "../src/core/sqlite-migrations.js";
import { nullLogger } from "../src/core/logger.js";
import { archiveDbPath } from "../src/core/sqlite-maintenance.js";
import { JobManager, readStore } from "../src/mcp/jobs.js";
import { readJobVersions } from "../src/core/job-archive-index.js";
import { processIdentity } from "../src/core/process-identity.js";

vi.mock("../src/core/json-store.js", async (original) => {
  const actual = await original<typeof import("../src/core/json-store.js")>();
  return { ...actual, writeJsonStore: vi.fn(actual.writeJsonStore) };
});
let env: TestEnv;
const fixture = readFileSync(join(import.meta.dirname, "fixtures", "handoff", "jobs-0.29.10.json"), "utf8");
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.mocked(writeJsonStore).mockClear(); vi.unstubAllEnvs(); await env.cleanup(); });
const peer = (name: string): PeerInfo => ({ id: name, name, agent: "codex", cwd: env.home, pid: process.pid, agentPid: null, sessionId: null, startedAt: 1, autoWake: false });

/** Failure releases the canonical lock while retaining its immutable ownership evidence. */
function expectRetainedReleasedLock(): void {
  expect(readdirSync(env.home).sort()).toEqual([".metadata-leases", "jobs.json"]);
  expect(existsSync(join(env.home, "jobs.json.lock"))).toBe(false);
  const key = createHash("sha256").update("jobs.json.lock").digest("hex");
  const namespace = join(env.home, ".metadata-leases"), registry = join(namespace, key);
  expect(readdirSync(namespace)).toEqual([key]); expect(readdirSync(registry)).toEqual(["archive"]);
  const archive = join(registry, "archive"), directories = readdirSync(archive);
  expect(directories).toHaveLength(1);
  const directory = join(archive, directories[0]!), names = readdirSync(directory);
  expect(names).toHaveLength(2);
  expect(names.some(name => name.startsWith("claim-v1."))).toBe(true);
  expect(names.some(name => name.startsWith("released-v2."))).toBe(true);
  const records = names.map(name => JSON.parse(readFileSync(join(directory, name), "utf8")));
  expect(records[0]).toEqual(records[1]);
  expect(records[0]).toMatchObject({ version: 2, pid: process.pid, identity: processIdentity(process.pid) });
  expect(records[0].nonce).toMatch(/^owner-v1\./);
  expect(directories[0]!.startsWith(`${records[0].ownerDirectory}-`)).toBe(true);
}

it("upgrades the real 0.29.10 job records with a byte-exact backup and preserves every old field", () => {
  const path = join(env.home, "jobs.json"); writeFileSync(path, fixture);
  const old = JSON.parse(fixture);
  const archived = join(env.home, "archive", "jobs-original.json"); mkdirSync(join(env.home, "archive"));
  writeFileSync(archived, fixture);
  const log = join(env.home, "runs-original.json"); writeFileSync(log, '{"by":"codex-fixture-source","future":"keep"}');
  const config = join(env.home, "config.json"); writeFileSync(config, '{"version":2,"future":{"keep":true}}');
  commitHandoff(path, peer("codex-fixture-source"), peer("codex-target"), { to: "codex-target" });
  const next = JSON.parse(readFileSync(path, "utf8"));
  expect(next.version).toBe(JSON_STORE_VERSION); expect(next.jobs).toHaveLength(old.jobs.length);
  for (const record of old.jobs) {
    const saved = next.jobs.find((j: { id: string }) => j.id === record.id);
    for (const [key, value] of Object.entries(record)) {
      if (!["owner", "supervisor", "rootSession", "rootName", "args"].includes(key)) expect(saved[key]).toEqual(value);
    }
    expect(saved.args).toMatchObject(record.args); expect(saved.ownershipHistory).toHaveLength(1);
  }
  const backups = readdirSync(env.home).filter((name) => name.startsWith("jobs.json.backup-"));
  expect(backups).toHaveLength(1); expect(readFileSync(join(env.home, backups[0]!), "utf8")).toBe(fixture);
  expect(readFileSync(archived, "utf8")).toBe(fixture);
  expect(readFileSync(log, "utf8")).toBe('{"by":"codex-fixture-source","future":"keep"}');
  expect(readFileSync(config, "utf8")).toBe('{"version":2,"future":{"keep":true}}');
  const bytes = readFileSync(path, "utf8");
  expect(migrateJobOwnership(migrateJobOwnership(next))).toEqual(next);
  expect(readFileSync(path, "utf8")).toBe(bytes);
});

it("leaves original records untouched if backup/publication fails", () => {
  const path = join(env.home, "jobs.json"); writeFileSync(path, fixture);
  vi.mocked(writeJsonStore).mockImplementationOnce(() => { throw new Error("Backup failed"); });
  expect(() => commitHandoff(path, peer("codex-fixture-source"), peer("codex-target"), { to: "codex-target" })).toThrow("Backup failed");
  expect(readFileSync(path, "utf8")).toBe(fixture);
  expectRetainedReleasedLock();
});

it("publishes a unique archive without overwriting an interrupted legacy overflow file", () => {
  const path = join(env.home, "jobs.json"), leftover = `${path}.overflow.json`;
  const seeded = { ...JSON.parse(fixture), futureEnvelope: { retained: ["all", "original", "bytes"] } };
  seeded.jobs = seeded.jobs.map((job: Record<string, unknown>) => ({ ...job, futureJobField: { id: job.id, retained: true } }));
  const original = JSON.stringify(seeded);
  writeFileSync(path, original); writeFileSync(leftover, '{"original":"untouched"}');
  vi.stubEnv("AGENT_BRIDGE_JOB_STORE_LIMIT", "1");
  vi.stubEnv("AGENT_BRIDGE_ARCHIVE_AGE_MS", "0");
  const manager = new JobManager(env.node("codex-fixture-source", "codex"), nullLogger, path);
  manager.restore(() => undefined);
  expect(readFileSync(path, "utf8")).toBe(original);
  // A real connected owner first refreshes durable authority. Merely loading
  // already-supervised finished jobs does not claim their write ownership.
  manager.refreshOwnership(); manager.persist();
  expect(readFileSync(leftover, "utf8")).toBe('{"original":"untouched"}');
  const retained = readStore(path, nullLogger, true);
  expect(retained.map((j) => j.id).sort()).toEqual(seeded.jobs.map((j: { id: string }) => j.id).sort());
  for (const record of seeded.jobs) expect(retained.find(job => job.id === record.id)).toMatchObject(record);
  expect(readStore(path)).toHaveLength(1);
  expect(JSON.parse(readFileSync(path, "utf8")).futureEnvelope).toEqual(seeded.futureEnvelope);
  const backups = readdirSync(env.home).filter(name => name.startsWith("jobs.json.backup-"));
  expect(backups).toHaveLength(1); expect(readFileSync(join(env.home, backups[0]!), "utf8")).toBe(original);
  // AB-206: overflow is published as job index rows, never as archive files beside a leftover.
  const active = new Set(readStore(path).map((j) => j.id));
  for (const record of seeded.jobs.filter((j: { id: string }) => !active.has(j.id))) expect(readJobVersions(path, record.id)).toContainEqual(expect.objectContaining(record));
  expect(existsSync(join(env.home, "archive"))).toBe(false);
});

it.each(['{"version":2,"jobs":"bad"}', '{broken'])("does not rename or modify invalid old data on failed migration", (bytes) => {
  const path = join(env.home, "jobs.json"); writeFileSync(path, bytes);
  expect(() => commitHandoff(path, peer("source"), peer("target"), { to: "target" })).toThrow();
  expect(readFileSync(path, "utf8")).toBe(bytes);
  expectRetainedReleasedLock();
});

it("makes old version-2 writers fail closed and preserves unknown fields", () => {
  const next = migrateJobOwnership({ ...JSON.parse(fixture), extension: { retained: true } });
  // The guard in v0.29.10 json-store.ts rejects future versions before backup or replacement.
  const oldWriterGuard = (value: unknown) => {
    const v = (value as { version: number }).version;
    if (!Number.isInteger(v) || v < 0 || v > 2) throw new Error(`unsupported JSON store version: ${v}`);
  };
  expect(() => oldWriterGuard(next)).toThrow(`unsupported JSON store version: ${JSON_STORE_VERSION}`);
  expect(next.extension).toEqual({ retained: true });
});

const oldSchema = readFileSync(join(import.meta.dirname, "fixtures", "handoff", "bridge-0.29.10.sql"), "utf8");
function oldDatabase() {
  const file = join(env.home, "old.db"), db = new DatabaseSync(file);
  db.exec(oldSchema);
  db.exec(`INSERT INTO messages VALUES ('old-mail','codex-source','job:a','codex-job-a','codex','codex-source','job-a',NULL,0,'Original evidence',1,NULL);
    INSERT INTO archived_messages SELECT *, 'retained', 2 FROM messages;
    INSERT INTO decisions VALUES (1,'decision','topic','Decision text','project','source','codex-source','codex',1,NULL,NULL);
    INSERT INTO history_documents VALUES ('document','message','codex',1,'Original evidence','original evidence','message:old-mail','old-mail',NULL,NULL,NULL,NULL);
    INSERT INTO history_cursors VALUES ('source','cursor');
    INSERT INTO session_bindings VALUES ('identity','session',1);
    INSERT INTO peer_names VALUES ('identity','codex-source','session','codex',1);
    INSERT INTO peer_name_owners VALUES ('codex-source','identity');`);
  const snapshot = () => Object.fromEntries(db.prepare("PRAGMA table_list").all().filter((r) => r.schema === "main" && r.type === "table" && !String(r.name).startsWith("sqlite_")).map((r) => [String(r.name), db.prepare(`SELECT * FROM "${String(r.name).replaceAll('"', '""')}" ORDER BY rowid`).all()]));
  return { file, db, snapshot };
}

it("upgrades the released 0.29.10 SQLite layout without changing any old table records", async () => {
  const { file, db, snapshot } = oldDatabase();
  db.exec(`INSERT INTO archived_messages SELECT 'legacy-only-mail',recipient,from_id,from_name,from_agent,to_target,conversation_id,reply_to,hop,
    'Original legacy-only evidence',created_at,42,archive_reason,archived_at FROM archived_messages WHERE id='old-mail';
    CREATE TABLE future_user_metadata (id TEXT PRIMARY KEY, opaque TEXT NOT NULL);
    INSERT INTO future_user_metadata VALUES ('retained','{"unknown":{"keep":[1,2,3]}}');`);
  const original = snapshot();
  db.close();
  const store = new MessageStore(file, nullLogger);
  const next = new DatabaseSync(file);
  const archive = new DatabaseSync(archiveDbPath(file), { readOnly: true });
  try {
    expect(next.prepare("PRAGMA user_version").get()!.user_version).toBe(SQLITE_STORE_VERSION);
    // Startup preserves the complete old source until post-listen maintenance.
    for (const [table, records] of Object.entries(original)) expect(next.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()).toEqual(records);
    expect(archive.prepare("SELECT * FROM messages ORDER BY rowid").all()).toEqual([]);
    const visible = () => {
      expect(store.byId("legacy-only-mail")?.body).toBe("Original legacy-only evidence");
      expect(store.messagesById("legacy-only-mail").map(message => message.body)).toEqual(["Original legacy-only evidence"]);
      expect(store.receipts("legacy-only-mail")).toEqual([{ recipient: "codex-source", readAt: 42 }]);
    };
    visible();
    vi.stubEnv("AGENT_BRIDGE_AUTO_BACKUP", "0");
    store.startBackups();
    await until(() => Number(next.prepare("SELECT COUNT(*) AS count FROM archived_messages").get()!.count) === 0);
    visible();
    expect(archive.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    for (const [table, records] of Object.entries(original)) {
      if (table === "archived_messages") {
        expect(archive.prepare("SELECT * FROM messages ORDER BY rowid").all()).toEqual(records);
      } else expect(next.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()).toEqual(records);
    }
    const backup = readdirSync(env.home).find((name) => name.startsWith("old.db.backup-"))!;
    expect(backup).toBeTruthy();
    const saved = new DatabaseSync(join(env.home, backup), { readOnly: true });
    try {
      expect(saved.prepare("PRAGMA user_version").get()!.user_version).toBe(6);
      for (const [table, records] of Object.entries(original)) expect(saved.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()).toEqual(records);
      expect(saved.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally { saved.close(); }
  } finally { archive.close(); next.close(); store.close(); }
  const backups = readdirSync(env.home).filter((name) => name.startsWith("old.db.backup-"));
  const again = new MessageStore(file, nullLogger); again.close();
  expect(readdirSync(env.home).filter((name) => name.startsWith("old.db.backup-"))).toEqual(backups);
});

it("rolls back a failing SQLite migration and makes older SQLite writers refuse the upgraded format", () => {
  const { file, db, snapshot } = oldDatabase(), original = snapshot();
  try {
    expect(() => migrateSqlite(db, file, true, 7, [{ version: 7, sql: "UPDATE messages SET body='incorrect'; CREATE TABLE broken(;" }], nullLogger)).toThrow();
    expect(snapshot()).toEqual(original);
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(6);
    db.exec("PRAGMA user_version=7");
    expect(() => migrateSqlite(db, file, true, 6, [], nullLogger)).toThrow("unsupported SQLite store version: 7");
    expect(snapshot()).toEqual(original);
  } finally { db.close(); }
});
