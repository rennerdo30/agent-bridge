import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MessageStore } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";
import { fixturePeer, ownedMessage, unreadOwned } from "./owned-mail.js";

let env: TestEnv, store: MessageStore, lock: DatabaseSync | undefined;
beforeEach(() => { env = makeEnv(); store = new MessageStore(env.db, nullLogger); });
afterEach(async () => { if (lock?.isTransaction) lock.exec("ROLLBACK"); lock?.close(); lock = undefined; store.close(); await env.cleanup(); });
const deadline = () => performance.now() + 2000;
function lockWriter() { lock = new DatabaseSync(env.db, { timeout: 25 }); lock.exec("BEGIN IMMEDIATE"); }

describe("owned store queue observation (not durability/restart acceptance)", () => {
  it("tracks an actual SQLite busy retry before its callback and timeout cannot reject/cancel accepted bytes", async () => {
    const recipient = fixturePeer(store, "recipient");
    const message = ownedMessage(store, recipient, { id: "drain-mail", from: { id: "sender", name: "sender", agent: "other" }, recipient: "recipient", to: "recipient",
      conversationId: "drain-fixture", replyTo: null, hop: 0, body: "Accepted exact fixture bytes", createdAt: 1, readAt: null });
    lockWriter(); let completed = false;
    const pending = store.retryWrite(() => store.insert(message)).then(() => { completed = true; });
    expect(store.lifecycleWriteManifest().pending).toBe(1); store.quiesceLifecycleMaintenance();
    const observation = await store.settleLifecycleWrites(performance.now() + 10);
    expect(observation).toMatchObject({ settled: false, pending: 1, maintenanceQuiesced: true }); expect(completed).toBe(false);
    lock!.exec("ROLLBACK"); await pending;
    expect(await store.settleLifecycleWrites(deadline())).toMatchObject({ settled: true, pending: 0, transactionsSettled: true });
    expect(unreadOwned(store, recipient)).toContainEqual(expect.objectContaining({ id: "drain-mail", body: "Accepted exact fixture bytes", readAt: null }));
    store.resumeLifecycleMaintenance(); expect(store.lifecycleWriteManifest().maintenanceQuiesced).toBe(false);
  });
  it("pre-abort maintenance resumes retained work without clearing queue/cursor evidence or aborting a write", async () => {
    store.schedulePurgeOlderThan(1); store.quiesceLifecycleMaintenance();
    expect(Reflect.get(store, "archiveTimer")).toBeNull(); const frozen = store.lifecycleWriteManifest();
    expect(frozen.purgePending).toBe(true); expect(frozen.legacyArchivePending).toBe(true);
    store.resumeLifecycleMaintenance(); expect(Reflect.get(store, "archiveTimer")).not.toBeNull();
    expect(store.lifecycleWriteManifest()).toMatchObject({ purgePending: true, legacyArchivePending: true });
    await until(() => store.lifecycleWriteManifest().pending === 0);
  });
  it("failed actual SQL and an active local transaction refuse settlement without force closing/recovering the store", async () => {
    store.quiesceLifecycleMaintenance();
    await expect(store.retryWrite(() => Reflect.get(store, "db").exec("INSERT INTO missing_fixture_table VALUES(1)"))).rejects.toThrow();
    expect(await store.settleLifecycleWrites(deadline())).toMatchObject({ settled: false, unknown: true });
    const db = Reflect.get(store, "db"); db.exec("BEGIN IMMEDIATE");
    try { expect(await store.settleLifecycleWrites(deadline())).toMatchObject({ settled: false, transactionsSettled: false }); expect(db.isTransaction).toBe(true); }
    finally { db.exec("ROLLBACK"); }
    store.resumeLifecycleMaintenance(); expect(store.lifecycleWriteManifest().unknown).toBe(true);
  });
});
