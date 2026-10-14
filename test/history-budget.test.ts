import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { historyBudget } from "../src/core/history-budget.js";
import { archiveHistory } from "../src/cli/history-archive.js";
import { makeEnv, type TestEnv } from "./helpers.js";
import { MessageStore } from "../src/core/store.js";
import { HistoryBackground } from "../src/core/history-background.js";
import { nullLogger } from "../src/core/logger.js";
let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });
it("pauses the external worker at the budget and safely resumes after configuration changes", async () => {
  const store = new MessageStore(env.db, nullLogger);
  writeFileSync(join(env.home, "config.json"), JSON.stringify({ history: { ingest: true, budgetBytes: 1 } }));
  const worker = new HistoryBackground(env.db, nullLogger);
  try {
    expect(await worker.tick()).toEqual({ work: 0, discovering: true });
    expect(worker.status()).toMatchObject({ paused: true, error: expect.stringContaining("storage budget reached") });
    writeFileSync(join(env.home, "config.json"), JSON.stringify({ history: { ingest: false, budgetBytes: 32 * 1024 ** 2 } }));
    expect((await worker.tick()).work).toBe(0);
    writeFileSync(join(env.home, "config.json"), JSON.stringify({ history: { ingest: true, budgetBytes: 32 * 1024 ** 2 } }));
    await worker.tick();
    expect(worker.status()).toMatchObject({ paused: false, error: null, phase: "verified" });
  } finally { await worker.close(); store.close(); }
});
it("accounts for DB/WAL, snapshots, backups and mirrors and pauses without removing bytes", async () => {
  for (const file of ["history.db", "history.db-wal", "history.db.backup-1", ".migration-snapshots/snapshot.db", "project-mirrors/mirror.db"]) {
    const path = join(env.home, file); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, Buffer.alloc(1024, 17));
  }
  // Temporary migration snapshots never count against the budget; they would block the migration itself.
  expect(await historyBudget(env.home, 1)).toMatchObject({ bytes: 4096, files: 4, paused: true, policy: "retain-and-pause" });
  expect(await historyBudget(env.home, 20 * 1024 ** 2)).toMatchObject({ paused: false });
  expect(readFileSync(join(env.home, "history.db"))).toEqual(Buffer.alloc(1024, 17));
});
it("retains verification failure evidence across restart and explicit retry", async () => {
  const store = new MessageStore(env.db, nullLogger), file = join(env.home, "history-import-failure.json");
  const error = "History import verification failed in retained fixture";
  writeFileSync(file, JSON.stringify({ version: 4, importVersion: 1, error, futureField: "retained" }));
  const worker = new HistoryBackground(env.db, nullLogger);
  try {
    await expect(worker.tick()).rejects.toThrow(error);
    expect(worker.status()).toMatchObject({ paused: true, error });
    await worker.tick(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ importVersion: 1, history: [error], futureField: "retained" });
    expect(worker.status()).toMatchObject({ paused: false, error: null });
  } finally { await worker.close(); store.close(); }
});
it("creates compact verified immutable archives while retaining original history and prior archives", async () => {
  const file = join(env.home, "history.db"), db = new DatabaseSync(file);
  db.exec("CREATE TABLE user_context(raw BLOB)"); db.prepare("INSERT INTO user_context VALUES(?)").run(Buffer.from("complete retained context")); db.close();
  const original = readFileSync(file), first = await archiveHistory(env.home), second = await archiveHistory(env.home);
  expect(first).not.toBe(second); expect(existsSync(first)).toBe(true);
  const manifest = JSON.parse(readFileSync(second, "utf8"));
  expect(manifest).toMatchObject({ version: 1, verified: true, policy: "retain-and-pause" });
  expect(readFileSync(file)).toEqual(original);
  const copy = new DatabaseSync(manifest.snapshot, { readOnly: true });
  try { expect(Buffer.from(copy.prepare("SELECT raw FROM user_context").get()!.raw as Uint8Array).toString()).toBe("complete retained context"); }
  finally { copy.close(); }
});
