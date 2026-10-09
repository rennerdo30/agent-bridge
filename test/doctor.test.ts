import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backupIfDue, createBackup, listBackups, readBackup, restoreBackup } from "../src/core/backups.js";
import { archiveHome, doctor, fixDoctor } from "../src/core/doctor.js";
import { nullLogger } from "../src/core/logger.js";
import { searchMessages } from "../src/core/message-history.js";
import { MessageStore, SQLITE_STORE_VERSION } from "../src/core/store.js";
import { migrateSqlite } from "../src/core/sqlite-migrations.js";
import { ARCHIVE_STORE_VERSION, openArchive } from "../src/core/sqlite-maintenance.js";
import { maintenanceLock, storageLease } from "../src/core/storage-lock.js";
import { runDoctor } from "../src/cli/doctor.js";
import { findRunLog } from "../src/cli/watch.js";
import { listRuns, readStoredJobs, startUi } from "../src/cli/ui.js";
import { runMetaPath, startRunFeed } from "../src/core/runfeed.js";
import { resolvePipePath } from "../src/core/paths.js";
import { JobManager, readStore } from "../src/mcp/jobs.js";
import { BridgeNode } from "../src/core/node.js";
import { loadOrCreateToken } from "../src/core/token.js";
import { ReadJournal } from "../src/core/read-journal.js";
import { closeMetadataDb, closeMetadataDbs } from "../src/core/metadata-db.js";
import { listPendingApprovals, publishApproval } from "../src/core/relay.js";
import { readArchivedJobs } from "../src/core/job-archive.js";
import type { BridgeMessage } from "../src/core/protocol.js";

let home: string;
const stores: MessageStore[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "doctor-")); });
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  closeMetadataDbs();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function store(): MessageStore { const s = new MessageStore(join(home, "bridge.db"), nullLogger); stores.push(s); return s; }
function message(id: string, createdAt = 1): BridgeMessage {
  return { id, recipient: "claude-main", from: { id: "p1", name: "codex-main", agent: "codex" }, to: "claude-main", conversationId: "c1", replyTo: null, hop: 0, body: `preserve ${id}`, createdAt, readAt: null };
}
function savedJob(id: string, status = "done") {
  return { id, name: `codex-job-${id}`, agent: "codex", status, prompt: "full task", startedAt: 1, finishedAt: 2, sessionId: "session1", owner: "claude-main", supervisor: "supervisor1", args: { send_to: "claude-main" }, future: "keep" };
}
function json(path: string): any { return JSON.parse(readFileSync(path, "utf8")); }

describe("doctor read-only diagnostics", () => {
  it("reports versions, size, JSON failures and orphaned files without mutating data", () => {
    const s = store(); s.close();
    writeFileSync(join(home, "jobs.json"), '{"jobs":');
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 99, maxJobs: 3 }));
    mkdirSync(join(home, "runs"));
    writeFileSync(join(home, "runs", "old.json"), JSON.stringify({ version: 1, title: "keep" }));
    writeFileSync(join(home, "left.tmp"), "unfinished bytes");
    const before = readFileSync(join(home, "jobs.json"));
    const report = doctor(home);
    expect(report.ok).toBe(false);
    expect(report.schema.map((s) => s.actual)).toEqual([SQLITE_STORE_VERSION, ARCHIVE_STORE_VERSION]);
    expect(report.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["json-parse", "json-version", "orphan-temp", "orphan-metadata"]));
    expect(report.totalBytes).toBe(report.sizes.reduce((n, s) => n + s.bytes, 0));
    expect(readFileSync(join(home, "jobs.json"))).toEqual(before);
    expect(existsSync(join(home, "left.tmp"))).toBe(true);
  });
  it("finds foreign-key violations and unsupported SQLite versions", () => {
    const db = new DatabaseSync(join(home, "bridge.db"));
    db.exec("PRAGMA foreign_keys=OFF; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(p REFERENCES parent(id)); INSERT INTO child VALUES(42); PRAGMA user_version=99");
    db.close();
    const report = doctor(home);
    expect(report.findings.map((f) => f.code)).toEqual(expect.arrayContaining(["sqlite-integrity", "schema-version"]));
    expect(report.ok).toBe(false);
  });
  it("reports a damaged database and invalid job shape", () => {
    writeFileSync(join(home, "bridge.db"), "broken database");
    writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: 1, jobs: "wrong" }));
    expect(doctor(home).findings.map((f) => f.code)).toEqual(expect.arrayContaining(["sqlite-unreadable", "json-shape"]));
  });
  it("requires confirmed, offline repairs and preserves exact orphan bytes", () => {
    writeFileSync(join(home, "left.tmp"), "unfinished bytes");
    expect(() => fixDoctor(home, false)).toThrow("confirmation");
    const release = storageLease(home);
    expect(() => fixDoctor(home, true)).toThrow("in use");
    release();
    const preserved = fixDoctor(home, true);
    expect(readFileSync(preserved[0]!, "utf8")).toBe("unfinished bytes");
    expect(existsSync(join(home, "left.tmp"))).toBe(false);
    expect(fixDoctor(home, true)).toEqual([]);
  });
});

describe("consistent snapshots and restore", () => {
  it("includes committed WAL data and JSON bytes in a verified round trip", () => {
    const s = store(); s.insert(message("wal"));
    writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: 1, jobs: [savedJob("old")] }));
    const backup = createBackup(home);
    expect(readBackup(backup).files.map((f) => f.path)).toEqual(expect.arrayContaining(["bridge.db", "archive.db", "jobs.json"]));
    const copy = new DatabaseSync(join(backup, "bridge.db"), { readOnly: true });
    expect(copy.prepare("SELECT body FROM messages").get()!.body).toBe("preserve wal"); copy.close();
    expect(() => restoreBackup(home, backup, false)).toThrow("confirmation");
    expect(() => restoreBackup(home, backup, true)).toThrow("in use");
    s.insert(message("later", 2)); s.close();
    writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: 1, jobs: [savedJob("later")] }));
    const recovery = restoreBackup(home, backup, true);
    const restored = store();
    expect(restored.byId("wal")).not.toBeNull();
    expect(restored.byId("later")).toBeNull();
    expect(json(join(home, "jobs.json")).jobs[0].id).toBe("old");
    const old = new DatabaseSync(join(recovery, "bridge.db"), { readOnly: true });
    expect(old.prepare("SELECT id FROM messages WHERE id='later'").get()).toBeDefined(); old.close();
    expect(json(join(recovery, "jobs.json")).jobs[0].id).toBe("later");
  });
  it("rotates N recent snapshots into a never-deleted cold directory", () => {
    vi.stubEnv("AGENT_BRIDGE_BACKUP_RETENTION", "2");
    for (let i = 1; i <= 4; i++) { writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, marker: i })); createBackup(home, i); }
    expect(listBackups(home)).toHaveLength(2);
    const cold = join(home, "backups", "archive");
    expect(readdirSync(cold)).toHaveLength(2);
    const path = join(cold, readdirSync(cold)[0]!);
    expect(readBackup(path).files).toHaveLength(1);
    restoreBackup(home, path, true);
    expect(json(join(home, "config.json")).marker).toBeLessThanOrEqual(2);
  });
  it("backs up only when due and supports disabled intervals and unlimited retention", () => {
    vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "10");
    expect(backupIfDue(home, 10)).not.toBeNull();
    expect(backupIfDue(home, 19)).toBeNull();
    expect(backupIfDue(home, 20)).not.toBeNull();
    vi.stubEnv("AGENT_BRIDGE_BACKUP_INTERVAL_MS", "0");
    expect(backupIfDue(home, 40)).toBeNull();
    vi.stubEnv("AGENT_BRIDGE_BACKUP_RETENTION", "0");
    for (let i = 0; i < 10; i++) createBackup(home, 100 + i);
    expect(listBackups(home)).toHaveLength(12);
  });
  it("rejects modified and traversing snapshots before changing current data", () => {
    writeFileSync(join(home, "config.json"), '{"version":1,"keep":true}');
    const backup = createBackup(home);
    writeFileSync(join(backup, "config.json"), "changed");
    expect(() => restoreBackup(home, backup, true)).toThrow("checksum");
    expect(json(join(home, "config.json")).keep).toBe(true);
    const manifest = json(join(backup, "manifest.json"));
    manifest.files[0].path = "../config.json";
    writeFileSync(join(backup, "manifest.json"), JSON.stringify(manifest));
    expect(() => restoreBackup(home, backup, true)).toThrow("unsafe");
  });
  it("writer registration refuses an exclusive maintenance lock", () => {
    const release = maintenanceLock(home);
    expect(() => storageLease(home)).toThrow("maintenance");
    expect(() => new MessageStore(join(home, "bridge.db"), nullLogger)).toThrow("maintenance");
    release();
    const s = store(); s.close();
  });
  it("can restore a damaged current database while preserving every original byte", () => {
    const s = store(); s.insert(message("healthy")); s.close();
    const backup = createBackup(home);
    const damaged = "damaged database bytes";
    writeFileSync(join(home, "bridge.db"), damaged);
    const recovery = restoreBackup(home, backup, true);
    expect(readFileSync(join(recovery, "bridge.db"), "utf8")).toBe(damaged);
    expect(store().byId("healthy")?.body).toBe("preserve healthy");
  });
  it("rolls back an interrupted restore and preserves partial copies", () => {
    writeFileSync(join(home, "config.json"), '{"version":1,"marker":"snapshot"}');
    mkdirSync(join(home, "jobs"));
    writeFileSync(join(home, "jobs", "old.json"), '{"version":1}');
    const backup = createBackup(home);
    writeFileSync(join(home, "config.json"), '{"version":1,"marker":"current"}');
    const blocked = join(home, "jobs");
    expect(blocked.startsWith(home)).toBe(true);
    rmSync(blocked, { recursive: true });
    writeFileSync(blocked, "preserve blocked directory bytes");
    expect(() => restoreBackup(home, backup, true)).toThrow();
    expect(json(join(home, "config.json")).marker).toBe("current");
    expect(readFileSync(blocked, "utf8")).toBe("preserve blocked directory bytes");
    expect(readdirSync(home).some((f) => f.startsWith("config.json.failed-restore-"))).toBe(true);
    expect(existsSync(join(home, ".maintenance-lock"))).toBe(false);
  });
});

describe("versioned migrations and backup recovery", () => {
  it.each([0, 1, 2])("restores data, schema and version after a failed migration from %i", (version) => {
    const path = join(home, "migration.db");
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE payload (id TEXT PRIMARY KEY, body TEXT); INSERT INTO payload VALUES ('old','original'); PRAGMA user_version=${version}`);
    expect(() => migrateSqlite(db, path, true, version + 1, [{ version: version + 1, sql: "UPDATE payload SET body='damaged'; ALTER TABLE payload ADD COLUMN extra TEXT; INVALID SQL;" }], nullLogger)).toThrow();
    expect(db.prepare("SELECT * FROM payload").get()).toEqual({ id: "old", body: "original" });
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(version);
    db.close();
    const backup = readdirSync(home).find((f) => f.startsWith("migration.db.backup-"))!;
    const original = new DatabaseSync(join(home, backup), { readOnly: true });
    expect(original.prepare("SELECT body FROM payload").get()!.body).toBe("original"); original.close();
  });
  it("upgrades an older archive schema with a backup and refuses a newer one", () => {
    const path = join(home, "archive.db");
    const old = new DatabaseSync(path); old.close();
    const archive = openArchive(path);
    expect(archive.prepare("PRAGMA user_version").get()!.user_version).toBe(ARCHIVE_STORE_VERSION); archive.close();
    expect(readdirSync(home).some((f) => f.startsWith("archive.db.backup-"))).toBe(true);
    const future = new DatabaseSync(path); future.exec("PRAGMA user_version=99"); future.close();
    const before = readFileSync(path);
    expect(() => openArchive(path)).toThrow("unsupported");
    expect(readFileSync(path)).toEqual(before);
  });
  it("supports an appended full-text migration and preserves rowid cursors on future failure", () => {
    const path = join(home, "future-migration.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE payload(id TEXT PRIMARY KEY, body TEXT); INSERT INTO payload(rowid,id,body) VALUES(1,'one','original'),(4,'four','history'); PRAGMA user_version=3");
    migrateSqlite(db, path, true, 4, [{ version: 4, sql: `
      CREATE VIRTUAL TABLE search USING fts5(body);
      INSERT INTO search(rowid,body) SELECT rowid,body FROM payload;
      CREATE TRIGGER payload_delete AFTER DELETE ON payload BEGIN DELETE FROM search WHERE rowid=old.rowid; END;
      CREATE TRIGGER payload_insert AFTER INSERT ON payload BEGIN INSERT INTO search(rowid,body) VALUES(new.rowid,new.body); END;
      PRAGMA user_version=4;` }], nullLogger);
    expect(db.prepare("SELECT rowid FROM search WHERE search MATCH 'history'").get()!.rowid).toBe(4);
    expect(() => migrateSqlite(db, path, true, 5, [{ version: 5, sql: "DELETE FROM payload; ALTER TABLE payload ADD COLUMN extra TEXT; INVALID SQL;" }], nullLogger)).toThrow();
    expect(db.prepare("SELECT rowid,id,body FROM payload ORDER BY rowid").all()).toEqual([{ rowid: 1, id: "one", body: "original" }, { rowid: 4, id: "four", body: "history" }]);
    expect(db.prepare("SELECT rowid FROM search WHERE search MATCH 'history'").get()!.rowid).toBe(4);
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(4);
    db.close();
  });
});

describe("lossless, readable archives", () => {
  it("moves expired messages out of primary and keeps replies and literal search readable", () => {
    const s = store(); s.insert(message("old")); s.insert({ ...message("reply", 2), body: "literal %_\\", replyTo: "old" });
    s.insert(message("new", 100));
    s.markRead("claude-main", ["old"], 10);
    expect(s.purgeOlderThan(3)).toBe(2);
    expect(s.byId("old")?.body).toBe("preserve old");
    expect(s.byId("reply")?.replyTo).toBe("old");
    expect(s.receipts("old")).toEqual([{ recipient: "claude-main", readAt: 10 }]);
    expect(searchMessages(join(home, "bridge.db"), { query: "%_\\" }).map((m) => m.id)).toEqual(["reply"]);
    expect(searchMessages(join(home, "bridge.db"), { before: 3, limit: 1 }).map((m) => m.id)).toEqual(["reply"]);
    const db = new DatabaseSync(join(home, "bridge.db"));
    expect(db.prepare("SELECT count(*) AS n FROM messages").get()!.n).toBe(1); db.close();
    s.close();
    expect(store().byId("old")).not.toBeNull();
  });
  it("keeps originals when the archive insert or primary removal fails", () => {
    const s = store(); s.insert(message("old"));
    const db = new DatabaseSync(join(home, "bridge.db"));
    db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'do not remove'); END;");
    expect(() => s.purgeOlderThan(2)).toThrow("do not remove");
    expect(s.unread("claude-main", 10)).toHaveLength(1);
    expect(searchMessages(join(home, "bridge.db"))).toHaveLength(1);
    db.exec("DROP TRIGGER fail_delete"); db.close();
    expect(s.purgeOlderThan(2)).toBe(1);
  });
  it("does not overwrite different archived content sharing the same identity", () => {
    const s = store(); s.insert(message("old")); s.purgeOlderThan(2);
    s.insert({ ...message("old"), body: "different" });
    expect(() => s.purgeOlderThan(2)).toThrow("identity conflict");
    expect(s.unread("claude-main", 10)[0]?.body).toBe("different");
  });
  it("archives aged finished jobs with raw fields and keeps them continuable", async () => {
    vi.stubEnv("AGENT_BRIDGE_ARCHIVE_AGE_MS", "10");
    const path = join(home, "jobs.json");
    writeFileSync(path, JSON.stringify({ version: 1, futureEnvelope: "keep", jobs: [savedJob("old"), savedJob("active", "running"), savedJob("interrupted", "interrupted")] }));
    expect(() => archiveHome(home, false, 100)).toThrow("confirmation");
    expect(archiveHome(home, true, 100).jobs).toBe(1);
    expect(readStore(path).map((j) => j.id)).toEqual(["active", "interrupted"]);
    expect(readStore(path, undefined, true).find((j) => j.id === "old")).toMatchObject({ supervisor: "supervisor1", future: "keep", args: { send_to: "claude-main" } });
    expect(json(path).futureEnvelope).toBe("keep");
    expect(readStoredJobs(home).get("codex-job-old")?.owner).toBe("claude-main");
    const node = Object.assign(new EventEmitter(), { name: "claude-main", deliverLocal: () => {} }) as unknown as BridgeNode;
    const manager = new JobManager(node, nullLogger, path);
    manager.restore(() => () => async () => ({ text: "continued", isError: false, sessionId: "session1", details: {} }));
    expect(manager.followUp("codex-job-old", "continue").outcome).toBe("started");
    await vi.waitFor(() => expect(readStore(path, undefined, true).find((j) => j.id === "old")?.status).toBe("done"));
    expect(readStore(path, undefined, true).find((j) => j.id === "old")).toMatchObject({ future: "keep", supervisor: "supervisor1" });
    manager.cancelAll();
  });
  it("archives completed run pairs by age, keeps live runs, and reads current and legacy archives", () => {
    // Creating the next fixture must not auto-archive the finished run before the age check.
    vi.stubEnv("AGENT_BRIDGE_ARCHIVE_AGE_MS", "0");
    const finished = startRunFeed({ home, name: "old", header: "codex", meta: { title: "keep title" } }); finished.end("done");
    const active = startRunFeed({ home, name: "live", header: "codex" });
    vi.stubEnv("AGENT_BRIDGE_ARCHIVE_AGE_MS", "10");
    utimesSync(finished.logPath, new Date(0), new Date(0));
    utimesSync(active.logPath, new Date(0), new Date(0));
    vi.stubEnv("AGENT_BRIDGE_ARCHIVE_AGE_MS", "10");
    expect(archiveHome(home, true, 100).runs).toBe(1);
    expect(existsSync(finished.logPath)).toBe(false);
    expect(existsSync(active.logPath)).toBe(true);
    expect(findRunLog(home, "old")).toContain("archive");
    expect(listRuns(home).find((r) => r.name.includes("old"))?.title).toBe("keep title");
    active.end("done");
    const legacyName = "2026-01-01-00-00-00-codex-legacy";
    const dir = join(home, "runs", "archive");
    writeFileSync(join(dir, `${legacyName}.log-1-uuid`), "00:00:00 codex\n00:00:01 finished after 1s · done\n");
    writeFileSync(join(dir, `${legacyName}.json-2-uuid`), JSON.stringify({ version: 1, title: "legacy title" }));
    expect(listRuns(home).find((r) => r.name === legacyName)?.title).toBe("legacy title");
    const backup = createBackup(home);
    expect(readBackup(backup).files.map((f) => f.path)).toContain(`runs/archive/${legacyName}.json-2-uuid`);
  });
  it("includes archived siblings in broker discovery", async () => {
    vi.stubEnv("AGENT_BRIDGE_ARCHIVE_AGE_MS", "1");
    writeFileSync(join(home, "jobs.json"), JSON.stringify({ version: 1, jobs: [savedJob("old")] }));
    archiveHome(home, true, 100);
    const opts = { pipePath: resolvePipePath(home, {}), token: loadOrCreateToken(home), dbPath: join(home, "bridge.db"), cwd: home, autoWake: false, log: nullLogger };
    const owner = new BridgeNode({ ...opts, agent: "claude", name: "claude-main" });
    const job = new BridgeNode({ ...opts, agent: "other", name: "codex-job-live", id: "job:live", jobAgent: "codex", jobOwner: "supervisor1", jobParent: "claude-main", canHostBroker: false });
    try {
      await owner.start(); await job.start();
      expect(await job.siblings()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "codex-job-old", status: "done" })]));
    } finally { await job.stop(); await owner.stop(); }
  });
  it("can continue an archived job older than the in-memory history window", async () => {
    vi.stubEnv("AGENT_BRIDGE_ARCHIVE_AGE_MS", "1");
    const path = join(home, "jobs.json");
    writeFileSync(path, JSON.stringify({ version: 1, jobs: Array.from({ length: 60 }, (_, i) => ({ ...savedJob(String(i)), startedAt: i })) }));
    archiveHome(home, true, 100);
    const node = Object.assign(new EventEmitter(), { name: "claude-main", deliverLocal: () => {} }) as unknown as BridgeNode;
    const manager = new JobManager(node, nullLogger, path);
    // Finish only after the running continuation reached jobs.json: completing it
    // must archive "done" even though the replaced projection still says "running".
    let finish!: () => void;
    const published = new Promise<void>((resolve) => { finish = resolve; });
    manager.restore(() => () => async () => { await published; return { text: "continued", isError: false, sessionId: "session1", details: {} }; });
    expect(manager.list().some((j) => j.id === "0")).toBe(false);
    expect(manager.followUp("codex-job-0", "continue").outcome).toBe("started");
    await vi.waitFor(() => expect(readStore(path).find((j) => j.id === "0")?.status).toBe("running"));
    finish();
    await vi.waitFor(() => expect(readStore(path, undefined, true).find((j) => j.id === "0")?.status).toBe("done"));
    expect(readStore(path, undefined, true).find((j) => j.id === "0")).toMatchObject({ future: "keep", supervisor: "supervisor1" });
    manager.cancelAll();
  });
  it("snapshots and restores the durable read journal, preserving later consumption", () => {
    const journal = new ReadJournal(home);
    journal.append("session", ["old"]);
    const backup = createBackup(home);
    expect(readBackup(backup).files.some((f) => f.path.startsWith("read-state/"))).toBe(true);
    journal.append("session", ["new"]);
    const recovery = restoreBackup(home, backup, true);
    expect(journal.read("session")).toEqual(["old"]);
    expect(new ReadJournal(recovery).read("session")).toEqual(["old", "new"]);
    closeMetadataDb(recovery);
    expect(doctor(home).findings.some((f) => f.code.startsWith("journal-"))).toBe(false);
  });
  it("preserves completed approval metadata instead of unlinking user questions", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const close = await publishApproval(home, { id, owner: "claude-main", job: "codex-job-old", agent: "codex", tool: "shell", command: "npm test", reason: "Check the requested fix", askedAt: Date.now(), deadline: Date.now() + 5_000 }, () => true);
    const path = join(home, "approvals", `${id}.json`);
    const raw = readFileSync(path);
    close();
    expect(listPendingApprovals(home)).toEqual([]);
    expect(existsSync(path)).toBe(false);
    const dir = join(home, "approvals", "archive");
    expect(readFileSync(join(dir, readdirSync(dir)[0]!))).toEqual(raw);
  });
  it("reads earlier JSON archive versions and refuses unknown future versions without changing bytes", () => {
    const dir = join(home, "archive"); mkdirSync(dir);
    const path = join(dir, "jobs-old.json");
    writeFileSync(path, JSON.stringify({ version: 0, jobs: [savedJob("old")] }));
    expect(readArchivedJobs(join(home, "jobs.json"))[0]?.id).toBe("old");
    writeFileSync(path, JSON.stringify({ version: 99, jobs: [savedJob("future")] }));
    const raw = readFileSync(path);
    expect(() => readArchivedJobs(join(home, "jobs.json"))).toThrow("invalid job archive");
    expect(readFileSync(path)).toEqual(raw);
  });
});

describe("doctor CLI and authenticated contracts", () => {
  it("prints JSON findings, rejects invalid arguments and never assumes confirmation", async () => {
    const out: string[] = [];
    expect(await runDoctor(["--json"], home, (s) => out.push(s))).toBe(0);
    expect(JSON.parse(out[0]!).schema).toHaveLength(2);
    expect(await runDoctor(["--unknown"], home, () => {})).toBe(2);
    expect(await runDoctor(["--restore"], home, () => {})).toBe(2);
    writeFileSync(join(home, "left.tmp"), "keep");
    const ask = vi.fn(async () => false);
    expect(await runDoctor(["--fix"], home, () => {}, ask)).toBe(1);
    expect(ask).toHaveBeenCalledOnce();
    expect(existsSync(join(home, "left.tmp"))).toBe(true);
    expect(await runDoctor(["--fix", "--yes"], home, () => {}, ask)).toBe(0);
    expect(ask).toHaveBeenCalledOnce();
  });
  it("requires a cookie for doctor/history and returns archived run contents", async () => {
    const s = store(); s.insert(message("archived")); s.purgeOlderThan(2); s.close();
    const feed = startRunFeed({ home, name: "old", header: "codex" }); feed.end("done");
    vi.stubEnv("AGENT_BRIDGE_ARCHIVE_AGE_MS", "1");
    utimesSync(feed.logPath, new Date(0), new Date(0)); archiveHome(home, true);
    const ui = await startUi({ home, pipe: resolvePipePath(home, {}), port: 0, log: nullLogger });
    try {
      const base = ui.url.replace(/\/\?t=.*$/, "");
      expect((await fetch(`${base}/api/storage`)).status).toBe(403);
      expect((await fetch(`${base}/api/archive/messages`)).status).toBe(403);
      const first = await fetch(ui.url, { redirect: "manual" });
      const cookie = String(first.headers.get("set-cookie")).split(";")[0]!;
      const headers = { cookie };
      const report = await (await fetch(`${base}/api/storage`, { headers })).json();
      expect(report.schema[0].expected).toBe(SQLITE_STORE_VERSION);
      const history = await (await fetch(`${base}/api/archive/messages?query=preserve&limit=1`, { headers })).json();
      expect(history.messages[0].id).toBe("archived");
      expect((await fetch(`${base}/api/archive/messages?limit=0`, { headers })).status).toBe(400);
      const name = feed.logPath.split(/[\\/]/).at(-1)!.replace(/\.log$/, "");
      const log = await (await fetch(`${base}/api/runs/${name}`, { headers })).json();
      expect(log.text).toContain("finished after");
    } finally { await ui.close(); }
  });
});
