import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertStoreUpgrade, liveStorePeers, recordStorePeer, releasedStoreCapabilities } from "../src/core/store-compatibility.js";
import { readJsonStore, writeJsonStore } from "../src/core/json-store.js";
import { migrateSqlite } from "../src/core/sqlite-migrations.js";
import { nullLogger } from "../src/core/logger.js";
import { readArchivedJobs } from "../src/core/job-archive.js";
import { EventEmitter } from "node:events";
import { JobManager } from "../src/mcp/jobs.js";
import type { BridgeNode } from "../src/core/node.js";
import { formatPeer, formatVersionSkew } from "../src/mcp/format.js";
import { APP_VERSION } from "../src/core/constants.js";
import type { PeerInfo } from "../src/core/protocol.js";
import * as identity from "../src/core/process-identity.js";
import { closeMetadataDb, metadataDb, metadataValue } from "../src/core/metadata-db.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ab-compat-")); });
afterEach(() => { closeMetadataDb(home); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
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
  // AB-206: archives are index rows, never JSON files an older reader would miss. While such a reader
  // lives, overflow jobs are copied into the index but stay in jobs.json (the jobArchive gate defers).
  vi.stubEnv("AGENT_BRIDGE_JOB_STORE_LIMIT", "1");
  const path = join(home, "jobs.json"), job = (id: string, startedAt: number) => ({ id, name: `codex-job-${id}`, agent: "codex", prompt: "task", startedAt, status: "done", sessionId: "s1" });
  writeFileSync(path, JSON.stringify({ version: 2, jobs: [job("keep", 1), job("new", 2)] }));
  old();
  const node = Object.assign(new EventEmitter(), { name: "claude-main", deliverLocal: () => {} }) as unknown as BridgeNode;
  new JobManager(node, nullLogger, path).restore(() => undefined);
  expect(JSON.parse(readFileSync(path, "utf8")).jobs.map((j: { id: string }) => j.id)).toEqual(["keep", "new"]);
  expect(readArchivedJobs(path).map((j) => j.id)).toContain("keep");
  expect(existsSync(join(home, "archive"))).toBe(false);
  expect(() => assertStoreUpgrade(home, "jobArchive", 0, 1)).toThrow("Waiting to upgrade jobArchive");
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
  expect(releasedStoreCapabilities("0.29.17")).toEqual({ json: 4, sqlite: 8 });
  expect(releasedStoreCapabilities("0.29.12")).toEqual({ json: 3, sqlite: 7 });
  expect(releasedStoreCapabilities("future")).toEqual({ json: 0, sqlite: 0 });
  recordStorePeer(home, { pid: process.pid, name: "unknown", version: "future" });
  expect(() => assertStoreUpgrade(home, "json", 3, 4)).toThrow("unknown (vfuture");
});

it("ignores retained capability records after PID reuse without removing their bytes", () => {
  old();
  const path = join(home, "storage-capabilities", `${process.pid}.json`);
  const bytes = readFileSync(path);
  vi.spyOn(identity, "processIdentity").mockReturnValue("a-different-process-creation");
  expect(liveStorePeers(home)).toEqual([]);
  expect(() => assertStoreUpgrade(home, "sqlite", 7, 9)).not.toThrow();
  expect(readFileSync(path)).toEqual(bytes);
});

it("does not preserve another PID generation's explicit capabilities over a legacy reader", () => {
  recordStorePeer(home, { pid: process.pid, name: "previous-generation", version: APP_VERSION, storeCapabilities: { json: 4, sqlite: 9 } });
  vi.spyOn(identity, "processIdentity").mockReturnValue("reused-pid-generation");
  old();
  expect(() => assertStoreUpgrade(home, "sqlite", 7, 9)).toThrow("retained-reader");
});

it("does not republish identical explicit capability records observed by another node", () => {
  const peer = { pid: process.pid, name: "authoritative-owner", version: APP_VERSION, storeCapabilities: { json: 4, sqlite: 9 } };
  recordStorePeer(home, peer);
  const before = metadataDb(home).prepare("SELECT * FROM bridge_metadata WHERE domain='storage-capabilities' AND key=?").get(String(process.pid));
  vi.spyOn(identity, "processIdentity").mockReturnValue(undefined);
  for (let observer = 0; observer < 10; observer++) recordStorePeer(home, { ...peer, name: "foreign-observation" });
  expect(metadataDb(home).prepare("SELECT * FROM bridge_metadata WHERE domain='storage-capabilities' AND key=?").get(String(process.pid))).toEqual(before);
  expect(existsSync(join(home, "storage-capabilities"))).toBe(false);
});

it("refreshes an authoritative resolved name while retaining its process generation", () => {
  const peer = { pid: process.pid, name: "owner", version: APP_VERSION, storeCapabilities: { json: 4, sqlite: 9 } };
  recordStorePeer(home, peer);
  const original = metadataValue(home,"storage-capabilities",String(process.pid)) as Record<string,unknown>;
  vi.spyOn(identity, "processIdentity").mockReturnValue(undefined);
  recordStorePeer(home, { ...peer, name: "owner-2" }, { authoritative: true });
  expect(metadataValue(home,"storage-capabilities",String(process.pid))).toMatchObject({ name: "owner-2", processIdentity: original.processIdentity });
});

it("announces exact versions and retained sessions to agents", () => {
  const peer = { id: "old", name: "older-session", version: "0.29.12", agent: "codex", cwd: "project", startedAt: Date.now() } as PeerInfo;
  expect(formatPeer(peer)).toContain("v0.29.12 · version skew (retained code)");
  expect(formatVersionSkew([peer]).join("\n")).toContain("older-session runs v0.29.12");
  expect(formatVersionSkew([{ name: "current", version: APP_VERSION }])).toEqual([]);
});
