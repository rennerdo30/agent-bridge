import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savedAutoWake, saveAutoWake } from "../src/core/auto-wake-pref.js";
import { loadConfig, saveConfigValue } from "../src/core/config.js";
import { JSON_STORE_VERSION, KEEP_STORE_BACKUPS, readJsonStore } from "../src/core/json-store.js";
import { nullLogger } from "../src/core/logger.js";
import type { BridgeNode } from "../src/core/node.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import { runMetaPath, startRunFeed } from "../src/core/runfeed.js";
import { MessageStore, SQLITE_STORE_VERSION } from "../src/core/store.js";
import { JobRunners, readRunnerState, runnerStatePath, writeRunnerState } from "../src/mcp/job-host.js";
import { JobManager, readStore } from "../src/mcp/jobs.js";

const V1_SCHEMA = `
CREATE TABLE messages (
  id TEXT NOT NULL, recipient TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL,
  from_agent TEXT NOT NULL, to_target TEXT NOT NULL, conversation_id TEXT NOT NULL, reply_to TEXT,
  hop INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
  PRIMARY KEY (id, recipient)
);
CREATE INDEX idx_messages_unread ON messages (recipient, read_at, created_at);
CREATE INDEX idx_messages_id ON messages (id);
`;
const LEGACY_MESSAGE = ["m1", "claude-main", "p1", "codex-main", "codex", "claude", "c1", null, 0, "keep this", 1, null];
const OLD_TIME = new Date(0);
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(import.meta.dirname, ".storage-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function stubNode(): BridgeNode {
  return Object.assign(new EventEmitter(), { name: "claude-main", deliverLocal: () => {} }) as unknown as BridgeNode;
}

function storedJob(id: string, startedAt: number, status = "done") {
  return { id, name: `codex-job-${id}`, agent: "codex", model: null, prompt: "original task", startedAt, status, sessionId: "s1", workdir: null, worktree: null };
}

function json(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, "utf8"));
}

describe("SQLite migrations", () => {
  it.each([0, 1])("upgrades schema version %i with a readable backup and all messages intact", (version) => {
    const path = join(home, "bridge.db");
    const old = new DatabaseSync(path);
    old.exec(V1_SCHEMA);
    old.exec(`PRAGMA user_version = ${version}`);
    old.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...LEGACY_MESSAGE);
    // An open WAL database proves the backup includes committed WAL pages.
    old.exec("PRAGMA journal_mode = WAL");
    old.prepare("UPDATE messages SET body = ? WHERE id = ?").run("committed in WAL", "m1");
    const store = new MessageStore(path, nullLogger);
    expect(store.byId("m1")).toMatchObject({ body: "committed in WAL", createdAt: 1 });
    store.close();
    old.close();
    const backups = readdirSync(home).filter((f) => f.startsWith("bridge.db.backup-"));
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(join(home, backups[0]!), { readOnly: true });
    expect(backup.prepare("PRAGMA user_version").get()!.user_version).toBe(version);
    expect(backup.prepare("SELECT body FROM messages").get()!.body).toBe("committed in WAL");
    backup.close();
    const current = new DatabaseSync(path, { readOnly: true });
    expect(current.prepare("PRAGMA user_version").get()!.user_version).toBe(SQLITE_STORE_VERSION);
    current.close();
    const reopened = new MessageStore(path, nullLogger);
    expect(reopened.byId("m1")).not.toBeNull();
    reopened.close();
    expect(readdirSync(home).filter((f) => f.startsWith("bridge.db.backup-"))).toEqual(backups);
  });

  it("refuses a newer schema without changing the database", () => {
    const path = join(home, "bridge.db");
    const db = new DatabaseSync(path);
    db.exec(`${V1_SCHEMA} PRAGMA user_version = ${SQLITE_STORE_VERSION + 1}`);
    db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(...LEGACY_MESSAGE);
    db.close();
    const before = readFileSync(path);
    expect(() => new MessageStore(path, nullLogger)).toThrow("unsupported SQLite store version");
    expect(readFileSync(path)).toEqual(before);
    expect(readdirSync(home).filter((f) => !f.startsWith("."))).toEqual(["bridge.db"]);
  });

  it("rolls back a failed migration and preserves its backup", () => {
    const path = join(home, "bridge.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE messages (body TEXT); INSERT INTO messages VALUES ('original');");
    db.close();
    expect(() => new MessageStore(path, nullLogger)).toThrow();
    const check = new DatabaseSync(path);
    expect(check.prepare("PRAGMA user_version").get()!.user_version).toBe(0);
    expect(check.prepare("SELECT body FROM messages").get()!.body).toBe("original");
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()).toEqual([]);
    check.close();
    expect(readdirSync(home).filter((f) => f.startsWith("bridge.db.backup-"))).toHaveLength(1);
  });

  it("archives both expired and stale queued messages and rolls back failed archival", () => {
    const path = join(home, "bridge.db");
    const store = new MessageStore(path, nullLogger);
    const message: BridgeMessage = {
      id: "old", recipient: "agent:codex", from: { id: "p1", name: "claude-main", agent: "claude" },
      to: "codex", conversationId: "c1", replyTo: null, hop: 0, body: "original", createdAt: 1, readAt: null,
    };
    store.insert(message);
    store.insert({ ...message, id: "queued" });
    store.insert({ ...message, id: "recent", createdAt: 100 });
    expect(store.expireQueued("agent:codex", 2)).toBe(2);
    expect(store.byId("old")?.body).toBe("original");
    expect(store.byId("queued")?.body).toBe("original");
    expect(store.expireQueued("agent:codex", 2)).toBe(0);
    const db = new DatabaseSync(join(home, "archive.db"));
    expect(db.prepare("SELECT body, archive_reason FROM messages").all()).toHaveLength(2);
    db.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'archive failed'); END;");
    expect(() => store.purgeOlderThan(101)).toThrow("archive failed");
    expect(store.byId("recent")).not.toBeNull();
    db.exec("DROP TRIGGER fail_archive");
    expect(store.purgeOlderThan(101)).toBe(1);
    expect(db.prepare("SELECT archive_reason FROM messages WHERE id = ?").get("recent")!.archive_reason).toBe("expired");
    db.close();
    store.close();
  });
});

describe("JSON store upgrades", () => {
  it("versions legacy config and auto-wake preferences with backups and unknown fields", () => {
    const config = join(home, "config.json");
    writeFileSync(config, JSON.stringify({ maxJobs: 3, future: { keep: true }, codex: { futureOption: "yes" } }));
    saveConfigValue(home, "autoWake", true);
    expect(json(config)).toMatchObject({ version: JSON_STORE_VERSION, future: { keep: true }, codex: { futureOption: "yes" } });
    expect(loadConfig(home, "codex", nullLogger, {}).maxJobs).toBe(3);
    const prefs = join(home, "auto-wake.json");
    writeFileSync(prefs, JSON.stringify({ "claude-main": true, unknown: { keep: true } }));
    expect(savedAutoWake(home, "claude-main")).toBe(true);
    saveAutoWake(home, "codex-main", false);
    expect(savedAutoWake(home, "claude-main")).toBe(true);
    expect(savedAutoWake(home, "codex-main")).toBe(false);
    expect(json(prefs)).toMatchObject({ version: JSON_STORE_VERSION, unknown: { keep: true } });
    expect(readdirSync(home).filter((f) => f.includes(".backup-"))).toHaveLength(2);
  });

  it("upgrades a legacy job array while keeping unknown entries and fields", () => {
    const path = join(home, "jobs.json");
    const entries = [{ ...storedJob("old", 1), future: { keep: true } }, { unknownEntry: "keep" }];
    writeFileSync(path, JSON.stringify(entries));
    const manager = new JobManager(stubNode(), nullLogger, path);
    expect(readStore(path)).toHaveLength(1);
    manager.persist();
    expect(json(path).version).toBe(JSON_STORE_VERSION);
    expect(json(path).jobs).toEqual(expect.arrayContaining(entries));
    const backup = readdirSync(home).find((f) => f.startsWith("jobs.json.backup-"))!;
    expect(JSON.parse(readFileSync(join(home, backup), "utf8"))).toEqual(entries);
    writeFileSync(path, JSON.stringify({ ...json(path), futureEnvelope: "keep" }));
    manager.persist();
    expect(json(path).futureEnvelope).toBe("keep");
  });

  it("keeps a full task and unknown job fields when that job is continued", async () => {
    const path = join(home, "jobs.json");
    const longPrompt = "task ".repeat(400);
    writeFileSync(path, JSON.stringify({ version: JSON_STORE_VERSION, jobs: [{ ...storedJob("old", Date.now()), prompt: longPrompt, args: { future: "keep" }, future: "keep" }] }));
    const manager = new JobManager(stubNode(), nullLogger, path);
    manager.restore(() => () => async () => ({ text: "done", sessionId: "s1", isError: false, details: {} }));
    expect(manager.followUp("codex-job-old", "continue").outcome).toBe("started");
    await vi.waitFor(() => expect(readStore(path)[0]?.status).toBe("done"));
    expect(json(path).jobs[0]).toMatchObject({ prompt: longPrompt, args: { future: "keep" }, future: "keep" });
  });

  it.each(["config.json", "jobs.json", "auto-wake.json", "jobs/old.json", "runs/old.json"])("preserves corrupt %s exactly and logs recovery", (name) => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const path = join(home, name);
    mkdirSync(join(path, ".."), { recursive: true });
    const raw = '{"broken":';
    writeFileSync(path, raw);
    const warn = vi.fn();
    const log = { ...nullLogger, warn };
    if (name === "config.json") loadConfig(home, "codex", log, {});
    else if (name === "jobs.json") readStore(path, log);
    else if (name === "auto-wake.json") savedAutoWake(home, "claude-main");
    else if (name.startsWith("jobs/")) readRunnerState(home, "old");
    else readJsonStore(path, log);
    expect(existsSync(path)).toBe(false);
    const preserved = readdirSync(join(path, "..")).find((f) => f.startsWith(name.split("/").at(-1)! + ".corrupt-"))!;
    expect(readFileSync(join(path, "..", preserved), "utf8")).toBe(raw);
    expect(warn.mock.calls.length + vi.mocked(process.stderr.write).mock.calls.length).toBeGreaterThan(0);
  });

  it("does not overwrite data when an I/O error prevents reading it", () => {
    mkdirSync(join(home, "config.json"));
    expect(() => saveConfigValue(home, "autoWake", true)).toThrow();
    expect(readdirSync(home)).toEqual(["config.json"]);
  });

  it("leaves newer JSON stores unchanged even when their format is unknown", () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const value = { version: JSON_STORE_VERSION + 1, futureFormat: ["keep"] };
    const raw = JSON.stringify(value);
    for (const name of ["config.json", "jobs.json", "auto-wake.json"]) writeFileSync(join(home, name), raw);
    expect(() => saveConfigValue(home, "autoWake", true)).toThrow("unsupported JSON store version");
    new JobManager(stubNode(), nullLogger, join(home, "jobs.json")).persist();
    saveAutoWake(home, "claude-main", true);
    mkdirSync(join(home, "jobs"));
    const runner = runnerStatePath(home, "future");
    writeFileSync(runner, raw);
    expect(() => writeRunnerState(home, "future", { pid: 1, peer: "p", status: "done", updatedAt: 1 })).toThrow("unsupported JSON store version");
    for (const name of ["config.json", "jobs.json", "auto-wake.json", "jobs/future.json"]) expect(readFileSync(join(home, name), "utf8")).toBe(raw);
    expect(readStore(join(home, "jobs.json"))).toEqual([]);
    expect(loadConfig(home, "codex", nullLogger, {}).autoWake).toBe(false);
    expect(readRunnerState(home, "future")).toBeNull();
  });

  it("keeps three recent migration backups and archives older copies", () => {
    const path = join(home, "config.json");
    const count = KEEP_STORE_BACKUPS + 2;
    for (let i = 0; i < count; i++) {
      writeFileSync(path, JSON.stringify({ version: 0, marker: i }));
      saveConfigValue(home, "autoWake", true);
    }
    const recent = readdirSync(home).filter((f) => f.startsWith("config.json.backup-"));
    const archived = readdirSync(join(home, "archive"));
    expect(recent).toHaveLength(KEEP_STORE_BACKUPS);
    expect(archived).toHaveLength(count - KEEP_STORE_BACKUPS);
    const markers = [...recent.map((f) => json(join(home, f)).marker), ...archived.map((f) => json(join(home, "archive", f)).marker)];
    expect(markers.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("merges runner and run metadata fields and protects newer metadata", () => {
    const path = runnerStatePath(home, "old");
    mkdirSync(join(home, "jobs"));
    writeFileSync(path, JSON.stringify({ pid: 1, peer: "p", status: "running", updatedAt: 1, future: { keep: true } }));
    writeRunnerState(home, "old", { pid: 1, peer: "p", status: "done", updatedAt: 2 });
    expect(json(path)).toMatchObject({ version: JSON_STORE_VERSION, status: "done", future: { keep: true } });
    const feed = startRunFeed({ home, name: "meta", header: "test" });
    const metaPath = runMetaPath(feed.logPath);
    writeFileSync(metaPath, JSON.stringify({ version: JSON_STORE_VERSION, future: "keep" }));
    feed.meta({ title: "new title" });
    expect(json(metaPath)).toMatchObject({ future: "keep", title: "new title", version: JSON_STORE_VERSION });
    const newer = JSON.stringify({ version: JSON_STORE_VERSION + 1, future: "keep" });
    writeFileSync(metaPath, newer);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    feed.meta({ title: "should not write" });
    feed.end("done");
    expect(readFileSync(metaPath, "utf8")).toBe(newer);
  });
});

describe("retention archives", () => {
  it("archives only finished overflow jobs and keeps every running or interrupted job", () => {
    vi.stubEnv("AGENT_BRIDGE_JOB_STORE_LIMIT", "1");
    const path = join(home, "jobs.json");
    writeFileSync(path, JSON.stringify([storedJob("old", 1), storedJob("new", 2), storedJob("running", 0, "running"), storedJob("interrupted", 0, "interrupted")]));
    const manager = new JobManager(stubNode(), nullLogger, path);
    manager.persist();
    expect(readStore(path).map((j) => j.id)).toEqual(["running", "interrupted", "new"]);
    const archive = readdirSync(join(home, "archive")).find((f) => f.startsWith("jobs.json.overflow.json-"))!;
    expect(json(join(home, "archive", archive)).jobs).toEqual([storedJob("old", 1)]);
    vi.stubEnv("AGENT_BRIDGE_JOB_STORE_LIMIT", "0");
    writeFileSync(path, JSON.stringify([storedJob("old", 1), storedJob("new", 2)]));
    manager.persist();
    expect(readStore(path)).toHaveLength(2);
  });

  it("archives log and metadata pairs and never prunes a live feed", () => {
    vi.stubEnv("AGENT_BRIDGE_RUN_LOG_LIMIT", "1");
    const old = startRunFeed({ home, name: "old", header: "old" });
    old.end("done");
    const active = startRunFeed({ home, name: "active", header: "active" });
    expect(existsSync(old.logPath)).toBe(false);
    const next = startRunFeed({ home, name: "next", header: "next" });
    active.report("still here");
    active.end("done");
    next.end("done");
    expect(readFileSync(active.logPath, "utf8")).toContain("still here");
    const archive = readdirSync(join(home, "runs", "archive"));
    expect(archive).toHaveLength(2);
    expect(archive.some((f) => f.startsWith(runMetaPath(old.logPath).split(/[\\/]/).at(-1)!))).toBe(true);
    vi.stubEnv("AGENT_BRIDGE_RUN_LOG_LIMIT", "0");
    const last = startRunFeed({ home, name: "last", header: "last" });
    last.end("done");
    expect(existsSync(active.logPath)).toBe(true);
  });

  it("archives old finished runner files together and keeps running state", () => {
    vi.stubEnv("AGENT_BRIDGE_RUNNER_KEEP_MS", "1");
    const dir = join(home, "jobs");
    for (const [id, status] of [["old", "done"], ["live", "running"]] as const) {
      writeRunnerState(home, id, { pid: 1, peer: "p", status, updatedAt: 1 });
      writeFileSync(join(dir, `${id}.spec.json`), JSON.stringify({ original: id }));
      utimesSync(runnerStatePath(home, id), OLD_TIME, OLD_TIME);
      utimesSync(join(dir, `${id}.spec.json`), OLD_TIME, OLD_TIME);
    }
    new JobRunners(stubNode(), home, "", nullLogger);
    expect(readRunnerState(home, "live")?.status).toBe("running");
    expect(existsSync(join(dir, "live.spec.json"))).toBe(true);
    expect(existsSync(runnerStatePath(home, "old"))).toBe(false);
    expect(readdirSync(join(dir, "archive"))).toHaveLength(2);
  });
});
