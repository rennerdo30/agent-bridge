import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertStoreUpgrade, recordStorePeer, releasedStoreCapabilities } from "../src/core/store-compatibility.js";
import { readJsonStore, writeJsonStore } from "../src/core/json-store.js";
import { migrateSqlite } from "../src/core/sqlite-migrations.js";
import { nullLogger } from "../src/core/logger.js";
import { archiveJobs } from "../src/core/job-archive.js";
import { formatPeer, formatVersionSkew } from "../src/mcp/format.js";
import { APP_VERSION } from "../src/core/constants.js";
import type { PeerInfo } from "../src/core/protocol.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ab-compat-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); });
const old = () => recordStorePeer(home, { pid: process.pid, name: "retained-reader", version: "0.29.12" });

it("keeps JSON3 byte-for-byte until its live reader can read JSON4", () => {
  old(); const path = join(home, "config.json"), previous = { version: 3, unknown: "keep" };
  writeFileSync(path, JSON.stringify(previous)); const bytes = readFileSync(path);
  expect(() => writeJsonStore(path, { unknown: "keep", autoWake: true }, previous)).toThrow("Waiting to upgrade json store 3→4: retained-reader");
  expect(readFileSync(path)).toEqual(bytes);
  expect(readdirSync(home).filter((f) => f.startsWith("config.json."))).toEqual([]);
  expect(readJsonStore(path)).toEqual(previous);
  recordStorePeer(home, { pid: process.pid, name: "current", version: APP_VERSION, storeCapabilities: { json: 4, sqlite: 7 } });
  writeJsonStore(path, { unknown: "keep", autoWake: true }, previous);
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 4, unknown: "keep", autoWake: true });
});

it("defers SQLite7→8 without snapshotting or changing owner data", () => {
  old(); const path = join(home, "bridge.db"), db = new DatabaseSync(path);
  db.exec("CREATE TABLE owner_data(body); INSERT INTO owner_data VALUES('keep'); PRAGMA user_version=7;");
  try {
    expect(() => migrateSqlite(db, path, true, 8, [{ version: 8, sql: "CREATE TABLE additive(id); PRAGMA user_version=8;" }], nullLogger)).toThrow("Waiting to upgrade sqlite store 7→8");
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(7);
    expect(db.prepare("SELECT body FROM owner_data").get()!.body).toBe("keep");
    expect(existsSync(join(home, ".migration-snapshots"))).toBe(false);
    recordStorePeer(home, { pid: process.pid, name: "current", version: APP_VERSION, storeCapabilities: { json: 4, sqlite: 8 } });
    migrateSqlite(db, path, true, 8, [{ version: 8, sql: "CREATE TABLE additive(id); PRAGMA user_version=8;" }], nullLogger);
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(8);
  } finally { db.close(); }
});

it("does not archive unreadable JSON or overwrite explicit capabilities with a legacy observation", () => {
  old(); expect(() => archiveJobs(join(home, "jobs.json"), [{ id: "keep" }])).toThrow("Waiting to upgrade json");
  expect(existsSync(join(home, "archive"))).toBe(false);
  recordStorePeer(home, { pid: process.pid, name: "current", version: APP_VERSION, storeCapabilities: { json: 4, sqlite: 8 } });
  old(); expect(() => assertStoreUpgrade(home, "json", 3, 4)).not.toThrow();
});

it("lets readers finish naturally, but never expires a living reader by age", () => {
  old(); expect(() => assertStoreUpgrade(home, "sqlite", 6, 8)).toThrow("finish naturally");
  vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("finished"), { code: "ESRCH" }); });
  expect(() => assertStoreUpgrade(home, "sqlite", 6, 8)).not.toThrow();
  expect(readdirSync(join(home, "storage-capabilities"))).toHaveLength(1);
});

it("treats unrecognized legacy formats conservatively", () => {
  expect(releasedStoreCapabilities("0.29.14")).toEqual({ json: 4, sqlite: 7 });
  expect(releasedStoreCapabilities("0.29.15")).toEqual({ json: 4, sqlite: 7 });
  expect(releasedStoreCapabilities("0.29.16")).toEqual({ json: 4, sqlite: 8 });
  expect(releasedStoreCapabilities("0.29.12")).toEqual({ json: 3, sqlite: 7 });
  expect(releasedStoreCapabilities("future")).toEqual({ json: 0, sqlite: 0 });
  recordStorePeer(home, { pid: process.pid, name: "unknown", version: "future" });
  expect(() => assertStoreUpgrade(home, "json", 3, 4)).toThrow("unknown (vfuture");
});

it("announces exact versions and retained sessions to agents", () => {
  const peer = { id: "old", name: "older-session", version: "0.29.12", agent: "codex", cwd: "project", startedAt: Date.now() } as PeerInfo;
  expect(formatPeer(peer)).toContain("v0.29.12 · version skew (retained code)");
  expect(formatVersionSkew([peer]).join("\n")).toContain("older-session runs v0.29.12");
  expect(formatVersionSkew([{ name: "current", version: APP_VERSION }])).toEqual([]);
});
