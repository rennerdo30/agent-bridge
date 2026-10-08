import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { archiveDbPath } from "../src/core/sqlite-maintenance.js";
import { MessageStore } from "../src/core/store.js";
import { searchMessages } from "../src/core/message-history.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await env.cleanup(); });

it("opens the existing store and skips an empty purge while another archive writer holds its lock", () => {
  new MessageStore(env.db, nullLogger).close();
  const writer = new DatabaseSync(archiveDbPath(env.db));
  let store: MessageStore | undefined;
  try {
    writer.exec("BEGIN IMMEDIATE");
    store = new MessageStore(env.db, nullLogger);
    expect(store.purgeOlderThan(Date.now())).toBe(0);
    expect(writer.isTransaction).toBe(true);
    expect(writer.prepare("SELECT COUNT(*) AS count FROM messages").get()!.count).toBe(0);
  } finally { store?.close(); if (writer.isTransaction) writer.exec("ROLLBACK"); writer.close(); }
});

it("serves requests under one second with retained legacy and expired rows while an archive writer is busy", async () => {
  // Warm the parent-session probe independently of the measured takeover.
  const previous = env.node("previous");
  await previous.start(); await previous.stop();
  const seed = new DatabaseSync(env.db);
  seed.exec(`INSERT INTO messages VALUES('expired-retained','offline','sender','sender','codex','offline','retained',NULL,0,'expired bytes',1,NULL);
    INSERT INTO archived_messages SELECT 'legacy-retained',recipient,from_id,from_name,from_agent,to_target,conversation_id,reply_to,hop,'legacy bytes',created_at,read_at,'legacy',1 FROM messages WHERE id='expired-retained';`);
  seed.close();
  const writer = new DatabaseSync(archiveDbPath(env.db));
  writer.exec("BEGIN IMMEDIATE");
  try {
    const replacement = env.node("replacement");
    const deadline = <T>(operation: Promise<T>) => {
      let timer: ReturnType<typeof setTimeout>;
      return Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("broker blocked on archive writer")), 1_000); })]).finally(() => clearTimeout(timer));
    };
    await deadline(replacement.start());
    // Allow maintenance to hit the held writer before checking responsiveness.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await deadline(replacement.peers())).toHaveLength(1);
    expect((await deadline(replacement.send({ to: "offline", body: "reachable during archival" }))).messages).toHaveLength(1);
    const check = new DatabaseSync(env.db, { readOnly: true });
    try {
      expect(check.prepare("SELECT body FROM messages WHERE id='expired-retained'").get()!.body).toBe("expired bytes");
      expect(check.prepare("SELECT body FROM archived_messages WHERE id='legacy-retained'").get()!.body).toBe("legacy bytes");
    } finally { check.close(); }
    writer.exec("ROLLBACK");
    await until(() => Number(writer.prepare("SELECT COUNT(*) AS count FROM messages WHERE id IN ('expired-retained','legacy-retained')").get()!.count) === 2);
    expect(writer.prepare("SELECT body FROM messages WHERE id='legacy-retained'").get()!.body).toBe("legacy bytes");
    expect(writer.prepare("SELECT body FROM messages WHERE id='expired-retained'").get()!.body).toBe("expired bytes");
  } finally { if (writer.isTransaction) writer.exec("ROLLBACK"); writer.close(); }
});

it("yields between legacy archival chunks and keeps their original bytes", () => {
  const store = new MessageStore(env.db, nullLogger);
  const seed = new DatabaseSync(env.db);
  try {
    for (let i = 0; i < 40; i++) seed.prepare("INSERT INTO archived_messages VALUES(?, 'offline','sender','sender','codex','offline','retained',NULL,0,?,1,NULL,'legacy',1)").run(`legacy-${i}`, `original-${i}`);
    seed.exec("UPDATE archived_messages SET read_at=99 WHERE id='legacy-39'");
    const visible = () => {
      expect(store.byId("legacy-39")?.body).toBe("original-39");
      expect(store.messagesById("legacy-39").map(message => message.body)).toEqual(["original-39"]);
      expect(store.receipts("legacy-39")).toEqual([{ recipient: "offline", readAt: 99 }]);
      expect(searchMessages(env.db, { query: "original-39" }).map(message => message.id)).toEqual(["legacy-39"]);
    };
    visible();
    vi.useFakeTimers();
    store.startBackups();
    vi.advanceTimersByTime(50);
    expect(seed.prepare("SELECT COUNT(*) AS count FROM archived_messages").get()!.count).toBe(24);
    visible();
    vi.advanceTimersByTime(150);
    expect(seed.prepare("SELECT COUNT(*) AS count FROM archived_messages").get()!.count).toBe(0);
    visible();
    const archive = new DatabaseSync(archiveDbPath(env.db), { readOnly: true });
    try {
      expect(archive.prepare("SELECT COUNT(*) AS count FROM messages").get()!.count).toBe(40);
      expect(archive.prepare("SELECT body FROM messages WHERE id='legacy-39'").get()!.body).toBe("original-39");
    } finally { archive.close(); }
  } finally { store.close(); seed.close(); }
});

it("awaits stale queue archival with yielding lock retries and retains source rows until the archive commits", async () => {
  const store = new MessageStore(env.db, nullLogger);
  const source = new DatabaseSync(env.db);
  const writer = new DatabaseSync(archiveDbPath(env.db));
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    source.exec("INSERT INTO messages VALUES('stale-queued','reused-name','sender','sender','codex','reused-name','retained',NULL,0,'stale queue bytes',1,NULL)");
    writer.exec("BEGIN IMMEDIATE");
    let heartbeat = false;
    release = setTimeout(() => { heartbeat = true; writer.exec("ROLLBACK"); }, 150);
    const pending = store.expireQueuedAsync("reused-name", 2);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(source.prepare("SELECT body FROM messages WHERE id='stale-queued'").get()!.body).toBe("stale queue bytes");
    expect(store.receipts("stale-queued")).toEqual([{ recipient: "reused-name", readAt: null }]);
    expect(await pending).toBe(1);
    expect(heartbeat).toBe(true);
    expect(source.prepare("SELECT body FROM messages WHERE id='stale-queued'").get()).toBeUndefined();
    expect(writer.prepare("SELECT body FROM messages WHERE id='stale-queued'").get()!.body).toBe("stale queue bytes");
  } finally {
    if (release) clearTimeout(release);
    if (writer.isTransaction) writer.exec("ROLLBACK");
    store.close(); source.close(); writer.close();
  }
});

it("limits maintenance payload bytes before selecting a second chunk", () => {
  const store = new MessageStore(env.db, nullLogger);
  const source = new DatabaseSync(env.db);
  try {
    for (let i = 0; i < 8; i++) source.prepare("INSERT INTO archived_messages VALUES(?, 'offline','sender','sender','codex','offline','retained',NULL,0,?,1,NULL,'legacy',1)").run(`large-${i}`, "a".repeat(64 * 1024));
    vi.useFakeTimers(); store.startBackups(); vi.advanceTimersByTime(50);
    expect(source.prepare("SELECT COUNT(*) AS count FROM archived_messages").get()!.count).toBe(4);
    vi.advanceTimersByTime(50);
    expect(source.prepare("SELECT COUNT(*) AS count FROM archived_messages").get()!.count).toBe(0);
  } finally { store.close(); source.close(); }
});

it("yields while scanning unexpired rowid ranges before reaching expired rows", () => {
  const store = new MessageStore(env.db, nullLogger);
  const source = new DatabaseSync(env.db);
  try {
    const insert = source.prepare("INSERT INTO messages VALUES(?, 'offline','sender','sender','codex','offline','retained',NULL,0,'retained',?,NULL)");
    for (let i = 0; i < 32; i++) insert.run(`recent-${i}`, 100);
    insert.run("old-after-recent", 1);
    vi.useFakeTimers(); store.startBackups(); store.schedulePurgeOlderThan(2);
    vi.advanceTimersByTime(100);
    expect(source.prepare("SELECT COUNT(*) AS count FROM messages").get()!.count).toBe(33);
    vi.advanceTimersByTime(100);
    expect(source.prepare("SELECT COUNT(*) AS count FROM messages").get()!.count).toBe(32);
    expect(store.byId("old-after-recent")?.body).toBe("retained");
  } finally { store.close(); source.close(); }
});

it.each(["queued", "purge"] as const)("rechecks %s eligibility after a concurrent process changes a selected row", async mode => {
  const store = new MessageStore(env.db, nullLogger);
  const source = new DatabaseSync(env.db);
  try {
    source.exec("INSERT INTO messages VALUES('changed-between-locks','old-queue','sender','sender','codex','old-queue','retained',NULL,0,'original bytes',1,NULL)");
    const exec = DatabaseSync.prototype.exec;
    let changed = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (!changed && sql === "BEGIN IMMEDIATE") {
        changed = true;
        source.prepare("UPDATE messages SET recipient='current-owner', read_at=99, created_at=100 WHERE id='changed-between-locks'").run();
      }
      exec.call(this, sql);
    });
    if (mode === "queued") expect(await store.expireQueuedAsync("old-queue", 2)).toBe(0);
    else {
      vi.useFakeTimers(); store.startBackups(); store.schedulePurgeOlderThan(2);
      vi.advanceTimersByTime(150);
    }
    expect(changed).toBe(true);
    expect(source.prepare("SELECT recipient,read_at,created_at,body FROM messages WHERE id='changed-between-locks'").get()).toMatchObject({ recipient: "current-owner", read_at: 99, created_at: 100, body: "original bytes" });
    expect(store.receipts("changed-between-locks")).toEqual([{ recipient: "current-owner", readAt: 99 }]);
    const archive = new DatabaseSync(archiveDbPath(env.db), { readOnly: true });
    try { expect(archive.prepare("SELECT id FROM messages WHERE id='changed-between-locks'").get()).toBeUndefined(); }
    finally { archive.close(); }
  } finally { store.close(); source.close(); }
});

it("does not mistake a zero-copy raced chunk for an empty queue with another stale row remaining", async () => {
  const store = new MessageStore(env.db, nullLogger);
  const source = new DatabaseSync(env.db);
  try {
    const insert = source.prepare("INSERT INTO messages VALUES(?, 'old-queue','sender','sender','codex','old-queue','retained',NULL,0,'retained bytes',1,NULL)");
    for (let i = 0; i < 16; i++) insert.run(`selected-${i}`);
    insert.run("seventeenth-stale");
    const exec = DatabaseSync.prototype.exec;
    let changed = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (!changed && sql === "BEGIN IMMEDIATE") {
        changed = true;
        source.prepare("UPDATE messages SET read_at=99 WHERE id LIKE 'selected-%'").run();
      }
      exec.call(this, sql);
    });
    expect(await store.expireQueuedAsync("old-queue", 2)).toBe(1);
    expect(source.prepare("SELECT id FROM messages WHERE id='seventeenth-stale'").get()).toBeUndefined();
    expect(source.prepare("SELECT COUNT(*) AS count FROM messages WHERE read_at=99").get()!.count).toBe(16);
    const archive = new DatabaseSync(archiveDbPath(env.db), { readOnly: true });
    try { expect(archive.prepare("SELECT id FROM messages").all()).toEqual([{ id: "seventeenth-stale" }]); }
    finally { archive.close(); }
  } finally { store.close(); source.close(); }
});

it("finishes the current bounded highwater pass before applying a newer cutoff", () => {
  const store = new MessageStore(env.db, nullLogger);
  const source = new DatabaseSync(env.db);
  try {
    const insert = source.prepare("INSERT INTO messages VALUES(?, 'offline','sender','sender','codex','offline','retained',NULL,0,'retained',?,NULL)");
    for (let i = 0; i < 32; i++) insert.run(`recent-${i}`, 100);
    insert.run("old-tail", 1);
    vi.useFakeTimers(); store.startBackups(); store.schedulePurgeOlderThan(2);
    vi.advanceTimersByTime(100); // legacy check, then first16 metadata rows
    store.schedulePurgeOlderThan(101);
    insert.run("inserted-after-highwater", 1);
    vi.advanceTimersByTime(100); // original pass reaches its old tail
    expect(source.prepare("SELECT id FROM messages WHERE id='old-tail'").get()).toBeUndefined();
    expect(source.prepare("SELECT id FROM messages WHERE id='inserted-after-highwater'").get()).toBeDefined();
    expect(source.prepare("SELECT COUNT(*) AS count FROM messages WHERE id LIKE 'recent-%'").get()!.count).toBe(32);
    vi.advanceTimersByTime(200); // queued new cutoff starts after original pass ends
    expect(source.prepare("SELECT COUNT(*) AS count FROM messages").get()!.count).toBe(0);
    expect(store.byId("old-tail")?.body).toBe("retained");
    expect(store.byId("inserted-after-highwater")?.body).toBe("retained");
  } finally { store.close(); source.close(); }
});
