import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MessageStore, SQLITE_STORE_VERSION } from "../src/core/store.js";
import { ResourceSlots } from "../src/core/resource-slots.js";
import { RootConcurrency } from "../src/core/root-concurrency.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => { env = makeEnv(); });
afterEach(async () => { await env.cleanup(); });

it("upgrades the v0.29.10 store without losing mail, session names, pinned decisions or unknown data", () => {
  const old = new DatabaseSync(env.db);
  old.exec(readFileSync(join(import.meta.dirname, "fixtures", "store-v0.29.10.sql"), "utf8"));
  old.exec(`INSERT INTO messages VALUES ('completion','owner','job:old','opencode-job-old','opencode','owner','job-old',NULL,0,'saved result',1,NULL);
    INSERT INTO messages VALUES ('observer','owner','job:old','opencode-job-old','opencode','owner','siblings-old:note',NULL,0,'saved observer',2,NULL);
    INSERT INTO peer_name_owners VALUES ('offline-open','unidentified:offline-open');
    INSERT INTO session_bindings VALUES ('retained-identity','retained-session',3);
    INSERT INTO decisions (id,topic,body,scope,author_id,author_name,author_agent,created_at) VALUES ('decision','keep','preserve me','"all"','owner','owner','opencode',3);
    CREATE TABLE future_user_data (body TEXT); INSERT INTO future_user_data VALUES ('untouched');`);
  const originals = old.prepare("SELECT * FROM messages ORDER BY id").all();
  old.close();
  const store = new MessageStore(env.db, nullLogger);
  try {
    expect(store.byId("completion")?.body).toBe("saved result");
    expect(store.byId("observer")?.body).toBe("saved observer");
    expect(store.broadcastNames()).toContain("offline-open");
    expect(store.decisions.list()[0]?.text).toBe("preserve me");
    const db = new DatabaseSync(env.db, { readOnly: true, timeout: 50 });
    try {
      expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(SQLITE_STORE_VERSION);
      expect(db.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(originals);
      expect(db.prepare("SELECT * FROM session_bindings").all()).toMatchObject([{ identity: "retained-identity", session_id: "retained-session" }]);
      expect(db.prepare("SELECT body FROM future_user_data").get()!.body).toBe("untouched");
    } finally { db.close(); }
    // Configuration-only changes do not migrate. Later versioned integrations must retain a backup.
    if (SQLITE_STORE_VERSION > 6) {
      const backupFile = readdirSync(env.home).find((f) => f.startsWith("bridge.db.backup-"))!;
      expect(backupFile).toBeDefined();
      const backup = new DatabaseSync(join(env.home, backupFile), { readOnly: true, timeout: 50 });
      try {
        expect(backup.prepare("PRAGMA user_version").get()!.user_version).toBe(6);
        expect(backup.prepare("SELECT * FROM messages ORDER BY id").all()).toEqual(originals);
        expect(backup.prepare("SELECT body FROM future_user_data").get()!.body).toBe("untouched");
      } finally { backup.close(); }
    }
  } finally { store.close(); }
});

it("configures WAL and busy timeout on every bridge-owned writable connection", () => {
  const store = new MessageStore(env.db, nullLogger);
  const slots = new ResourceSlots(env.home);
  const roots = new RootConcurrency(env.home, "fixture-root");
  try {
    for (const db of [(store as any).db, (store as any).archiveDb, (slots as any).db, (roots as any).db, (roots as any).slots.db] as DatabaseSync[]) {
      expect(db.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
      expect(Number(db.prepare("PRAGMA busy_timeout").get()!.timeout)).toBeGreaterThan(0);
    }
  } finally { roots.close(); slots.close(); store.close(); }
});
