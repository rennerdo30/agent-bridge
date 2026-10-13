import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeEach, expect, it } from "vitest";
import { listBackups, readBackup, restoreBackup } from "../src/core/backups.js";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

/** Native asynchronous SQLite backup runs in the same isolated runtime as production. */
async function backgroundBackup(failAfter = 0): Promise<{ path: string | null; checkpoints: number }> {
  const bundle = join(env.home, "backup-fixture.mjs");
  await build({ entryPoints: [join(import.meta.dirname, "../src/core/backups.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const script = `import { backupIfDueBackground } from ${JSON.stringify(pathToFileURL(bundle).href)};
    let checkpoints=0;
    try { const path=await backupIfDueBackground(${JSON.stringify(env.home)},{checkpoint:()=>{if (++checkpoints===${failAfter}) throw new Error('injected backup pressure')}});console.log(JSON.stringify({path,checkpoints})); }
    catch(error) {console.log(JSON.stringify({error:String(error),checkpoints}));}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout!.on("data", chunk => { stdout += chunk; });
  child.stderr!.on("data", chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill(); reject(new Error(`Owned backup fixture exceeded 20s: ${stdout} ${stderr}`));
    }, 20_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", code => {
      clearTimeout(timeout);
      try {
        if (code !== 0) throw new Error(`Backup fixture exited ${code}: ${stderr}`);
        const result = JSON.parse(stdout.trim());
        if (result.error) throw new Error(result.error);
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}

it("incrementally captures committed WAL and sidecar data, then verifies chunked checksums", async () => {
  const store = new MessageStore(env.db, nullLogger);
  const overlay = new DatabaseSync(join(env.home, "store-compatibility.db"));
  overlay.exec("CREATE TABLE retained_metadata(body); INSERT INTO retained_metadata VALUES('durable overlay'); PRAGMA user_version=1;");
  writeFileSync(join(env.home, "config.json"), JSON.stringify({ version: 4, retained: "owner config" }));
  try {
    store.insert({ id: "wal", recipient: "recipient", from: { id: "sender", name: "sender", agent: "codex" }, to: "recipient", conversationId: "fixture", replyTo: null, hop: 0, body: "committed WAL bytes", createdAt: Date.now(), readAt: null });
    store.history.storageDatabase.exec("INSERT INTO conversations(id,agent,session) VALUES('retained-history','codex','retained-session'); INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('retained-source',0,0,'retained-history',1,X'0102ff','owner history');");
    const { path, checkpoints } = await backgroundBackup();
    expect(path).not.toBeNull();
    const manifest = readBackup(path!);
    expect(manifest.files.map(file => file.path)).toEqual(expect.arrayContaining(["bridge.db", "archive.db", "history.db", "store-compatibility.db", "config.json"]));
    const copied = new DatabaseSync(join(path!, "bridge.db"), { readOnly: true });
    try { expect(copied.prepare("SELECT body FROM messages WHERE id='wal'").get()!.body).toBe("committed WAL bytes"); } finally { copied.close(); }
    const history = new DatabaseSync(join(path!, "history.db"), { readOnly: true });
    try { expect(history.prepare("SELECT raw FROM conversation_records").get()!.raw).toEqual(new Uint8Array([1, 2, 255])); } finally { history.close(); }
    expect(checkpoints).toBeGreaterThan(10);
    expect((await backgroundBackup()).path).toBeNull();
  } finally { overlay.close(); store.close(); }
});

it("restores isolated history and owner answers while archiving all newer original database bytes", async () => {
  const store = new MessageStore(env.db, nullLogger);
  const history = store.history.storageDatabase;
  const questions = new DatabaseSync(join(env.home, "owner-questions.db"));
  questions.exec("CREATE TABLE retained_answer(body); INSERT INTO retained_answer VALUES('owner answer'); PRAGMA user_version=1;");
  try {
    history.exec("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('old',0,0,'session',1,X'01','original');");
    const { path } = await backgroundBackup();
    history.exec("INSERT INTO conversation_records(source,generation,offset,conversation,at,raw,body) VALUES('new',0,0,'session',2,X'02','later');");
    questions.exec("INSERT INTO retained_answer VALUES('later answer');");
    store.close(); questions.close();
    const recovery = restoreBackup(env.home, path!, true);
    for (const [folder, expectedRows] of [[env.home, 1], [recovery, 2]] as const) {
      const preservedHistory = new DatabaseSync(join(folder, "history.db"), { readOnly: true });
      const preservedQuestions = new DatabaseSync(join(folder, "owner-questions.db"), { readOnly: true });
      try {
        expect(preservedHistory.prepare("SELECT count(*) AS n FROM conversation_records").get()!.n).toBe(expectedRows);
        expect(preservedQuestions.prepare("SELECT count(*) AS n FROM retained_answer").get()!.n).toBe(expectedRows);
      } finally { preservedHistory.close(); preservedQuestions.close(); }
    }
  } finally { store.close(); try { questions.close(); } catch {} }
});

it("keeps original and partial backup bytes on a checkpoint failure without publishing a verified backup", async () => {
  const store = new MessageStore(env.db, nullLogger);
  const payload = new DatabaseSync(env.db);
  payload.exec("CREATE TABLE large_backup_fixture(raw BLOB); INSERT INTO large_backup_fixture VALUES(zeroblob(2*1024*1024));");
  payload.close();
  const original = readFileSync(env.db);
  try {
    await expect(backgroundBackup(4)).rejects.toThrow("injected backup pressure");
    expect(readFileSync(env.db)).toEqual(original);
    expect(listBackups(env.home)).toEqual([]);
    const pending = readdirSync(join(env.home, "backups")).find(name => name.startsWith(".pending-"))!;
    expect(pending).toBeDefined();
    expect(existsSync(join(env.home, "backups", pending, "bridge.db"))).toBe(true);
    expect(JSON.parse(readFileSync(join(env.home, "backups", pending, "failure.json"), "utf8")).error).toContain("injected backup pressure");
  } finally { store.close(); }
});

it("has no synchronous automatic snapshot on MessageStore open or purge", () => {
  const store = new MessageStore(env.db, nullLogger);
  try { store.purgeOlderThan(0); expect(existsSync(join(env.home, "backups"))).toBe(false); }
  finally { store.close(); }
});
