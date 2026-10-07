import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CONVERSATION_MIGRATION } from "../src/core/conversation-schema.js";
import { nullLogger } from "../src/core/logger.js";
import { migrateSqlite } from "../src/core/sqlite-migrations.js";
import { readJsonStore, writeJsonStore } from "../src/core/json-store.js";
import { SQLITE_STORE_VERSION } from "../src/core/store.js";
import { until } from "./helpers.js";

const mocks = vi.hoisted(() => ({ rename: vi.fn() }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  mocks.rename.mockImplementation(fs.renameSync);
  return { ...fs, renameSync: mocks.rename };
});
let home: string;
const children: ChildProcess[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ab-migration-interruption-")); });
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill(); })));
  mocks.rename.mockClear();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
const routeMigration = { version: 7, sql: "CREATE TABLE job_delivery_routes(id TEXT PRIMARY KEY, recipient TEXT NOT NULL, consumed_at INTEGER); PRAGMA user_version=7;" };
const migrations = [routeMigration, { version: 8, sql: CONVERSATION_MIGRATION }];
const createFixture = () => {
  expect(SQLITE_STORE_VERSION).toBe(8);
  const path = join(home, "bridge.db"), db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE messages(id TEXT, recipient TEXT, body TEXT); CREATE TABLE session_bindings(identity TEXT, session_id TEXT, learned_at INTEGER); CREATE TABLE owner_data(id INTEGER PRIMARY KEY, raw BLOB, body TEXT); PRAGMA user_version=6;");
  db.prepare("INSERT INTO owner_data VALUES(?,?,?)").run(9007199254740993n, Buffer.from([0, 255, 1]), "original");
  db.exec("INSERT INTO messages VALUES('retained','owner','original message');");
  return { path, db };
};
const verifyOriginal = (db: DatabaseSync) => {
  expect(db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
  expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(6);
  const query = db.prepare("SELECT id,raw,body FROM owner_data"); query.setReadBigInts(true);
  expect(query.get()).toEqual({ id: 9007199254740993n, raw: new Uint8Array([0, 255, 1]), body: "original" });
  expect(db.prepare("SELECT body FROM messages").get()!.body).toBe("original message");
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('job_delivery_routes','conversations')").all()).toEqual([]);
};
const snapshotPaths = () => readdirSync(join(home, ".migration-snapshots")).map((name) => join(home, ".migration-snapshots", name));

it("rolls the entire 6→7→8 chain back after a late failure and retries idempotently", () => {
  const { path, db } = createFixture();
  try {
    expect(() => migrateSqlite(db, path, true, 8, [
      { ...routeMigration, sql: `${routeMigration.sql} UPDATE owner_data SET body='intermediate'; DELETE FROM messages;` },
      { version: 8, sql: `${CONVERSATION_MIGRATION} INSERT INTO missing_table VALUES(1);` },
    ], nullLogger)).toThrow("no such table: missing_table");
    verifyOriginal(db);
    expect(snapshotPaths()).toHaveLength(1);
    const protectedBefore = snapshotPaths()[0]!, beforeBytes = readFileSync(protectedBefore);
    const before = new DatabaseSync(protectedBefore, { readOnly: true });
    try { verifyOriginal(before); } finally { before.close(); }
    migrateSqlite(db, path, true, 8, migrations, nullLogger);
    expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(8);
    expect(db.prepare("SELECT message,recipient FROM conversation_envelopes").all()).toEqual([{ message: "retained", recipient: "owner" }]);
    expect(readFileSync(protectedBefore)).toEqual(beforeBytes);
    const publishedFiles = readdirSync(home), protectedFiles = snapshotPaths();
    migrateSqlite(db, path, true, 8, migrations, nullLogger);
    expect(readdirSync(home)).toEqual(publishedFiles);
    expect(snapshotPaths()).toEqual(protectedFiles);
    expect(readFileSync(protectedBefore)).toEqual(beforeBytes);
  } finally { db.close(); }
});

it("recovers a killed writer between schema steps without publishing its partial transaction", async () => {
  const { path, db } = createFixture(); db.close();
  const bundle = join(home, "migration.mjs"), checkpoint = join(home, "checkpoint");
  await build({ entryPoints: [join(import.meta.dirname, "../src/core/sqlite-migrations.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite'; import { writeFileSync } from 'node:fs';
    import { migrateSqlite } from ${JSON.stringify(pathToFileURL(bundle).href)};
    const db = new DatabaseSync(${JSON.stringify(path)});
    db.function('checkpoint', () => { writeFileSync(${JSON.stringify(checkpoint)}, 'step7 uncommitted'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); return 0; });
    migrateSqlite(db, ${JSON.stringify(path)}, true, 8, ${JSON.stringify([{ ...routeMigration, sql: `${routeMigration.sql} UPDATE owner_data SET body='intermediate'; DELETE FROM messages; SELECT checkpoint();` }, migrations[1]])}, {info(){},warn(){}});
  `], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let errors = ""; child.stderr!.on("data", (chunk) => errors += chunk);
  await until(() => existsSync(checkpoint), 2_000);
  // The worker has executed step7, but the only publication boundary is COMMIT.
  const observer = new DatabaseSync(path, { readOnly: true });
  try { verifyOriginal(observer); } finally { observer.close(); }
  const pausedSnapshot = new DatabaseSync(snapshotPaths()[0]!, { readOnly: true });
  try { verifyOriginal(pausedSnapshot); } finally { pausedSnapshot.close(); }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL"); await exited;
  expect(errors).not.toContain("Error:");
  expect(existsSync(`${path}.migration-lock`)).toBe(true);
  const beforePath = snapshotPaths()[0]!, beforeBytes = readFileSync(beforePath);
  const recovered = new DatabaseSync(path);
  try {
    verifyOriginal(recovered);
    migrateSqlite(recovered, path, true, 8, migrations, nullLogger);
    expect(recovered.prepare("PRAGMA user_version").get()!.user_version).toBe(8);
    expect(recovered.prepare("SELECT body FROM owner_data").get()!.body).toBe("original");
    expect(recovered.prepare("SELECT body FROM messages").get()!.body).toBe("original message");
    expect(recovered.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe("ok");
    expect(existsSync(`${path}.migration-lock`)).toBe(false);
    expect(readFileSync(beforePath)).toEqual(beforeBytes);
    const files = snapshotPaths();
    migrateSqlite(recovered, path, true, 8, migrations, nullLogger);
    expect(snapshotPaths()).toEqual(files);
  } finally { recovered.close(); }
});

it("keeps JSON bytes and its completed backup when a writer dies before atomic replacement", async () => {
  const path = join(home, "config.json"), previous = { version: 3, owner: { unknown: "keep" } };
  writeFileSync(path, JSON.stringify(previous)); const bytes = readFileSync(path);
  const bundle = join(home, "json-writer.mjs"), checkpoint = join(home, "json-checkpoint");
  await build({ entryPoints: [join(import.meta.dirname, "../src/core/json-store.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === ${JSON.stringify(path)}) { fs.writeFileSync(${JSON.stringify(checkpoint)}, 'before atomic publication'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); }
      return rename(from, to);
    };
    syncBuiltinESMExports();
    const { writeJsonStore } = await import(${JSON.stringify(pathToFileURL(bundle).href)});
    writeJsonStore(${JSON.stringify(path)}, ${JSON.stringify({ ...previous, enabled: true })}, ${JSON.stringify(previous)});
  `], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  await until(() => existsSync(checkpoint), 2_000);
  expect(readFileSync(path)).toEqual(bytes);
  const backups = readdirSync(home).filter((name) => name.startsWith("config.json.backup-"));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(home, backups[0]!))).toEqual(bytes);
  const pending = readdirSync(home).find((name) => name.startsWith("config.json.") && name.endsWith(".tmp"))!;
  expect(JSON.parse(readFileSync(join(home, pending), "utf8"))).toMatchObject({ version: 4, enabled: true });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL"); await exited;
  expect(readFileSync(path)).toEqual(bytes);
  writeJsonStore(path, { ...previous, enabled: true }, readJsonStore(path));
  expect(readJsonStore(path)).toMatchObject({ version: 4, owner: { unknown: "keep" }, enabled: true });
  expect(readFileSync(join(home, backups[0]!))).toEqual(bytes);
  expect(existsSync(join(home, pending))).toBe(true);
  const files = readdirSync(home);
  writeJsonStore(path, { ...previous, enabled: true }, readJsonStore(path));
  expect(readdirSync(home)).toEqual(files);
});

it("preserves the original and its backup if a JSON publication fails, then retries once", () => {
  const path = join(home, "config.json"), previous = { version: 3, owner: { unknown: "keep" } };
  writeFileSync(path, JSON.stringify(previous)); const bytes = readFileSync(path);
  mocks.rename.mockImplementationOnce(() => { throw Object.assign(new Error("injected publication failure"), { code: "EIO" }); });
  expect(() => writeJsonStore(path, { ...previous, enabled: true }, previous)).toThrow("injected publication failure");
  expect(readFileSync(path)).toEqual(bytes);
  const backups = readdirSync(home).filter((name) => name.startsWith("config.json.backup-"));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(home, backups[0]!))).toEqual(bytes);
  expect(readdirSync(home).some((name) => name.endsWith(".tmp"))).toBe(false);
  writeJsonStore(path, { ...previous, enabled: true }, readJsonStore(path));
  expect(readJsonStore(path)).toMatchObject({ version: 4, owner: { unknown: "keep" }, enabled: true });
  const before = readdirSync(home);
  writeJsonStore(path, { ...previous, enabled: true }, readJsonStore(path));
  expect(readdirSync(home)).toEqual(before);
  expect(readFileSync(join(home, backups[0]!))).toEqual(bytes);
});
