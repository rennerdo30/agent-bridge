import { fork, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readBackup, restoreBackup } from "../src/core/backups.js";
import { listMessageBackups, messageBackupIfDue, MESSAGE_BACKUPS_DIR } from "../src/core/message-backups.js";
import { BackupBackground } from "../src/core/backup-background.js";
import { nullLogger } from "../src/core/logger.js";

let env: { home: string; db: string };
const children: ChildProcess[] = [];
beforeEach(() => { const home = realpathSync(mkdtempSync(join(tmpdir(), "ab-message-backup-"))); env = { home, db: join(home, "bridge.db") }; });
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); });
  await rm(env.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function seed(rows = 1): void {
  const db = new DatabaseSync(env.db);
  try {
    db.exec(`CREATE TABLE messages(id TEXT NOT NULL, recipient TEXT NOT NULL, from_id TEXT NOT NULL, from_name TEXT NOT NULL, from_agent TEXT NOT NULL,
      to_target TEXT NOT NULL, conversation_id TEXT NOT NULL, reply_to TEXT, hop INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER, PRIMARY KEY(id,recipient));
      CREATE TABLE archived_messages AS SELECT *, '' AS archive_reason, 0 AS archived_at FROM messages WHERE 0;
      CREATE TABLE job_delivery_routes(id TEXT PRIMARY KEY,recipient TEXT NOT NULL,consumed_at INTEGER);
      CREATE TABLE conversation_records(source TEXT,generation INTEGER,offset INTEGER,conversation TEXT,at INTEGER,raw BLOB,body TEXT);
      CREATE TABLE conversation_envelopes(message TEXT,recipient TEXT); PRAGMA user_version=9;`);
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO messages VALUES(?, 'recipient', 'sender', 'sender', 'codex', 'recipient', 'fixture', NULL, 0, ?, 1, NULL)");
    for (let i = 0; i < rows; i++) insert.run(`message-${i}`, "mail".repeat(128));
    db.exec("COMMIT");
  } finally { db.close(); }
}

async function bundle(entry: string, name: string): Promise<string> {
  const path = join(env.home, name);
  await build({ entryPoints: [join(import.meta.dirname, "../src/core", entry)], outfile: path, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  return path;
}

async function childResult(child: ChildProcess, timeoutMs = 20_000): Promise<any> {
  children.push(child);
  let response: any;
  child.on("message", message => { response = message; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Owned message-backup process exceeded deadline")); }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal) reject(new Error(`Message backup child failed: ${code}/${signal}`));
      else if (response?.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}

it("copies only mailbox tables, excludes large legacy history, and cannot be used for full restore", async () => {
  seed(130);
  const source = new DatabaseSync(env.db);
  source.exec("CREATE TABLE legacy_history_fixture(raw BLOB); INSERT INTO legacy_history_fixture VALUES(zeroblob(32*1024*1024));");
  source.exec("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('source',0,0,'history',1,X'0102','untouched history');");
  const original = readFileSync(env.db);
  let checkpoints = 0;
  try {
    const { path } = await messageBackupIfDue(env.home, { checkpoint: async () => { checkpoints++; } });
    expect(path).toBeTruthy();
    const manifest = JSON.parse(readFileSync(join(path!, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ version: 1, kind: "message-tables", restore: "merge-selected-tables-only" });
    expect(manifest.files.every((file: any) => file.bytes < 1024 * 1024)).toBe(true);
    const copied = new DatabaseSync(join(path!, "bridge.messages.db"), { readOnly: true });
    try {
      expect(copied.prepare("SELECT count(*) AS n FROM messages").get()!.n).toBe(130);
      expect(copied.prepare("SELECT name FROM sqlite_master WHERE name IN ('legacy_history_fixture','conversation_records','conversation_envelopes')").all()).toEqual([]);
    } finally { copied.close(); }
    expect(checkpoints).toBeGreaterThan(10);
    expect(readFileSync(env.db).equals(original)).toBe(true);
    expect(() => readBackup(path!)).toThrow("scoped message snapshots require a table merge");
    expect(() => restoreBackup(env.home, path!, true)).toThrow("scoped message snapshots require a table merge");
    expect(source.prepare("SELECT body FROM conversation_records WHERE source='source'").get()!.body).toBe("untouched history");
    expect((await messageBackupIfDue(env.home, { checkpoint: async () => {} })).skipped).toBe("not-due");
  } finally { source.close(); }
});

it("runs in a separate process at low priority with measured bounded-window throttling", async () => {
  seed(1024);
  const entry = await bundle("backup-worker.ts", "backup-child.mjs");
  const child = fork(entry, [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], windowsHide: true });
  const completed = childResult(child);
  const startedAt = Date.now();
  child.send({ type: "start", home: env.home });
  const result = await completed;
  expect(result.path).toBeTruthy();
  expect(child.pid).not.toBe(process.pid);
  expect(result.priority).toBeGreaterThanOrEqual(constants.priority.PRIORITY_BELOW_NORMAL);
  // Capture and verification each traverse at least sixteen 64-row windows.
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(32 * 5);
});

it("allows only one process generation and recovers the OS lock after its owner dies", async () => {
  seed(256);
  const entry = await bundle("message-backups.ts", "message-backup-api.mjs");
  const script = `import { messageBackupIfDue } from ${JSON.stringify(pathToFileURL(entry).href)};
    let checkpoints=0;let release;const hold=new Promise(resolve=>release=resolve);
    process.on('message',message=>{if(message==='release') release()});
    try {const result=await messageBackupIfDue(${JSON.stringify(env.home)},{checkpoint:async()=>{if(++checkpoints===2){process.send({held:true});await hold}}});process.send(result,()=>process.disconnect())}
    catch(error){process.send({error:String(error)},()=>process.disconnect())}`;
  const held = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
  children.push(held);
  let locked = false, failure = "";
  held.on("message", (message: any) => { if (message.held) locked = true; if (message.error) failure = message.error; });
  const deadline = Date.now() + 20_000;
  while (!locked) {
    if (failure) throw new Error(failure);
    if (held.exitCode !== null || held.signalCode !== null) throw new Error("Backup fixture exited before acquiring lock");
    if (Date.now() >= deadline) throw new Error("Owned backup fixture startup exceeded deadline");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const workerEntry = await bundle("backup-worker.ts", "contending-backup-child.mjs");
  const contender = fork(workerEntry, [], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [], windowsHide: true });
  const completed = childResult(contender); contender.send({ type: "start", home: env.home });
  expect(await completed).toMatchObject({ path: null, skipped: "already-running" });
  expect(listMessageBackups(env.home)).toEqual([]);
  await new Promise<void>(resolve => { held.once("exit", () => resolve()); held.kill(); });
  const recovered = await messageBackupIfDue(env.home, { checkpoint: async () => {} });
  expect(recovered.path).toBeTruthy();
  expect(listMessageBackups(env.home)).toHaveLength(1);
  expect(readdirSync(join(env.home, MESSAGE_BACKUPS_DIR)).some(name => name.startsWith(".pending-"))).toBe(true);
});

it("reports disabled when automatic backup is not opted in", async () => {
  const previous = process.env.AGENT_BRIDGE_AUTO_BACKUP;
  delete process.env.AGENT_BRIDGE_AUTO_BACKUP;
  const background = new BackupBackground(env.home, nullLogger);
  try { expect(background.status().phase).toBe("disabled"); expect(existsSync(join(env.home, MESSAGE_BACKUPS_DIR))).toBe(false); }
  finally { await background.close(); if (previous === undefined) delete process.env.AGENT_BRIDGE_AUTO_BACKUP; else process.env.AGENT_BRIDGE_AUTO_BACKUP = previous; }
});

it("preserves source and partial output when pressure interrupts table copying", async () => {
  seed(256);
  const original = readFileSync(env.db); let checkpoints = 0;
  await expect(messageBackupIfDue(env.home, { checkpoint: async () => { if (++checkpoints === 4) throw new Error("injected broker pressure"); } })).rejects.toThrow("injected broker pressure");
  expect(readFileSync(env.db).equals(original)).toBe(true);
  expect(listMessageBackups(env.home)).toEqual([]);
  const pending = readdirSync(join(env.home, MESSAGE_BACKUPS_DIR)).find(name => name.startsWith(".pending-"))!;
  expect(existsSync(join(env.home, MESSAGE_BACKUPS_DIR, pending, "bridge.messages.db"))).toBe(true);
  expect(JSON.parse(readFileSync(join(env.home, MESSAGE_BACKUPS_DIR, pending, "failure.json"), "utf8")).error).toContain("injected broker pressure");
});

it("refuses linked targets before writing any external backup or lock bytes", async () => {
  seed();
  const external = mkdtempSync(join(env.home, "external-fixture-"));
  writeFileSync(join(external, "keep"), "owner bytes");
  symlinkSync(external, join(env.home, MESSAGE_BACKUPS_DIR), process.platform === "win32" ? "junction" : "dir");
  await expect(messageBackupIfDue(env.home, { checkpoint: async () => {} })).rejects.toThrow("linked paths");
  expect(readdirSync(external)).toEqual(["keep"]);
  expect(readFileSync(join(external, "keep"), "utf8")).toBe("owner bytes");
  expect(existsSync(join(env.home, "message-backup-lock.db"))).toBe(false);
  // Unlink only this fixture link before ordinary sandbox-directory cleanup.
  await rm(join(env.home, MESSAGE_BACKUPS_DIR));
});

it("refuses a dangling coordination-file link without creating its external target", async () => {
  seed();
  const missing = join(env.home, "missing-lock-target"), link = join(env.home, "message-backup-lock.db");
  symlinkSync(missing, link, "file");
  await expect(messageBackupIfDue(env.home, { checkpoint: async () => {} })).rejects.toThrow("linked paths");
  expect(existsSync(missing)).toBe(false);
  await rm(link);
});
