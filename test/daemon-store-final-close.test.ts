import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openArchive, archiveInitializationObservation } from "../src/core/sqlite-maintenance.js";
import { openHistoryStore, historyInitializationObservation, legacyReadNotice } from "../src/core/history-store.js";
import { storageLease, storageLeaseObservation } from "../src/core/storage-lock.js";
import { DecisionStore, DECISIONS_SCHEMA } from "../src/core/decisions.js";
import { HistoryIndex } from "../src/core/history.js";
import { MessageStore, messageStoreHandleObservation } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { attachStoreCompatibility, storeCompatibilityObservation } from "../src/core/store-compatibility-overlay.js";
import { readConversation } from "../src/core/conversations.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import { makeEnv, type TestEnv } from "./helpers.js";

const leaseFault = vi.hoisted(() => ({ path: "", mode: "none" as "none" | "before" | "after", failure: new Error("SIMULATED lease removal failure") }));
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  const remove: typeof original.rmSync = (path, options) => {
    if (path === leaseFault.path && leaseFault.mode === "before") throw leaseFault.failure;
    original.rmSync(path, options);
    if (path === leaseFault.path && leaseFault.mode === "after") throw leaseFault.failure;
  };
  return { ...original, rmSync: remove, default: { ...original, rmSync: remove } };
});

// Actual isolated native resources only. Fixture disposal is not a production
// force-close API or evidence the source's unknown close had succeeded.
const nativeExec = DatabaseSync.prototype.exec, nativeClose = DatabaseSync.prototype.close;
const owned = new Map<DatabaseSync, { actuallyClosed: boolean }>();
const ownedStores = new Set<MessageStore>();
let env: TestEnv;
beforeEach(() => { leaseFault.path = ""; leaseFault.mode = "none"; env = makeEnv(); });
afterEach(async () => {
  leaseFault.path = ""; leaseFault.mode = "none";
  vi.restoreAllMocks();
  for (const store of ownedStores) { store.close(); ownedStores.delete(store); }
  for (const [db, outcome] of owned) {
    if (!outcome.actuallyClosed) { nativeClose.call(db); outcome.actuallyClosed = true; }
    owned.delete(db);
  }
  await env.cleanup();
});
function dispose(db: DatabaseSync): void { nativeClose.call(db); owned.get(db)!.actuallyClosed = true; }
const kinds = [
  { name: "archive", open: openArchive, observe: archiveInitializationObservation, initialSql: "PRAGMA busy_timeout = 3000" },
  { name: "history", open: openHistoryStore, observe: historyInitializationObservation, initialSql: "PRAGMA busy_timeout=3000" },
] as const;
function initialized(kind: typeof kinds[number], name: string) {
  const file = join(env.home, name), db = kind.open(file); owned.set(db, { actuallyClosed: false });
  db.exec("CREATE TABLE owned_closure_fixture(id INTEGER PRIMARY KEY, body BLOB NOT NULL); INSERT INTO owned_closure_fixture VALUES(1,x'00ff04');");
  dispose(db); return { file, bytes: readFileSync(file) };
}
function retainedRow(file: string) {
  const db = new DatabaseSync(file, { readOnly: true }); owned.set(db, { actuallyClosed: false });
  try { db.exec("PRAGMA query_only=ON"); return [...db.prepare("SELECT body FROM owned_closure_fixture WHERE id=1").get()!.body as Uint8Array]; }
  finally { dispose(db); }
}
describe("owned opener capture dependency (not producer drain or final-close authority)", () => {
  for (const kind of kinds) {
    it(`${kind.name} records the actual initialized handle without native SQL or owner/retirement certification`, () => {
      const db = kind.open(join(env.home, `${kind.name}.db`)); owned.set(db, { actuallyClosed: false });
      const exec = vi.spyOn(DatabaseSync.prototype, "exec"), prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      expect(kind.observe(db)).toEqual({ captured: true, initialization: "returned", close: "not_attempted", retained: false,
        overflow: false, ownerBound: false, ownershipReleased: false });
      expect(exec).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
      expect(kind.observe({ ...db } as unknown as DatabaseSync)).toMatchObject({ captured: false, initialization: "unavailable", ownerBound: false, ownershipReleased: false });
      exec.mockRestore(); prepare.mockRestore(); dispose(db);
      // This is explicitly historical initialization evidence, not a fabricated
      // acknowledgement of a later caller's close or current owner completeness.
      expect(kind.observe(db)).toMatchObject({ initialization: "returned", close: "not_attempted", ownershipReleased: false });
    });
    it(`${kind.name} preserves a real initialized database when SIMULATED initialization fails and actual close returns`, () => {
      const fixture = initialized(kind, `${kind.name}-closed.db`), failure = new Error("SIMULATED initialization error after real native SQL");
      let captured: DatabaseSync | undefined;
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
        const result = nativeExec.call(this, sql);
        if (sql === kind.initialSql) {
          expect(kind.observe(this)).toMatchObject({ captured: true, initialization: "initializing", close: "not_attempted", ownerBound: false });
          captured = this; owned.set(this, { actuallyClosed: false }); throw failure;
        }
        return result;
      });
      const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
        const result = nativeClose.call(this); if (this === captured) owned.get(this)!.actuallyClosed = true; return result;
      });
      expect(() => kind.open(fixture.file)).toThrow(failure); expect(close).toHaveBeenCalledTimes(1);
      expect(kind.observe(captured!)).toMatchObject({ initialization: "failed", close: "returned", retained: true, ownerBound: false, ownershipReleased: false });
      vi.restoreAllMocks(); expect(readFileSync(fixture.file)).toEqual(fixture.bytes); expect(retainedRow(fixture.file)).toEqual([0, 255, 4]);
    });
    it(`${kind.name} strongly retains exact failed native capture when SIMULATED close throws before or after actual close`, () => {
      for (const when of ["before", "after"] as const) {
        const fixture = initialized(kind, `${kind.name}-${when}.db`);
        const initializationFailure = new Error("SIMULATED initialization failure"), closeFailure = new Error("SIMULATED native close outcome error");
        let captured: DatabaseSync | undefined;
        vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
          const result = nativeExec.call(this, sql);
          if (sql === kind.initialSql) {
            expect(kind.observe(this)).toMatchObject({ captured: true, initialization: "initializing", close: "not_attempted", ownerBound: false });
            captured = this; owned.set(this, { actuallyClosed: false }); throw initializationFailure;
          }
          return result;
        });
        const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
          if (this !== captured) return nativeClose.call(this);
          if (when === "after") { nativeClose.call(this); owned.get(this)!.actuallyClosed = true; }
          throw closeFailure;
        });
        // Existing helper semantics throw its actual close error if close fails.
        expect(() => kind.open(fixture.file)).toThrow(closeFailure); expect(close).toHaveBeenCalledTimes(1);
        expect(kind.observe(captured!)).toMatchObject({ captured: true, initialization: "failed", close: "unknown", retained: true,
          ownerBound: false, ownershipReleased: false });
        vi.restoreAllMocks();
        if (!owned.get(captured!)!.actuallyClosed) dispose(captured!);
        expect(kind.observe(captured!)).toMatchObject({ close: "unknown", retained: true, ownershipReleased: false });
        expect(readFileSync(fixture.file)).toEqual(fixture.bytes); expect(retainedRow(fixture.file)).toEqual([0, 255, 4]);
      }
    });
  }
  it("retains every actual failed capture beyond the bounded census limit without reusing native identities", () => {
    const kind = kinds[0], fixture = initialized(kind, "archive-overflow.db"), captures: DatabaseSync[] = [];
    const initializationFailure = new Error("SIMULATED initialization failure"), closeFailure = new Error("SIMULATED error after actual native close");
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
      const result = nativeExec.call(this, sql);
      if (sql === kind.initialSql) { captures.push(this); owned.set(this, { actuallyClosed: false }); throw initializationFailure; }
      return result;
    });
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
      nativeClose.call(this); owned.get(this)!.actuallyClosed = true; throw closeFailure;
    });
    for (let n = 0; n < 129; n++) expect(() => kind.open(fixture.file)).toThrow(closeFailure);
    expect(new Set(captures).size).toBe(129);
    for (const db of captures) expect(kind.observe(db)).toMatchObject({ initialization: "failed", close: "unknown", retained: true,
      overflow: true, ownerBound: false, ownershipReleased: false });
    vi.restoreAllMocks(); expect(readFileSync(fixture.file)).toEqual(fixture.bytes); expect(retainedRow(fixture.file)).toEqual([0, 255, 4]);
  });
});

describe("actual operation-scoped storage lease evidence (not lifecycle release authority)", () => {
  function acquired() {
    const release = storageLease(env.home), dir = join(env.home, ".storage-users");
    const paths = readdirSync(dir); expect(paths).toHaveLength(1);
    return { release, path: join(dir, paths[0]!) };
  }
  it("binds only the actual source release closure and observes real own-file removal", () => {
    const { release, path } = acquired();
    expect(storageLeaseObservation(release)).toMatchObject({ captured: true, acquisition: "returned", descriptorClose: "returned",
      release: "not_attempted", identityObserved: true, retained: true, ownerBound: false, ownershipReleased: false });
    expect(storageLeaseObservation(() => release())).toMatchObject({ captured: false, acquisition: "unavailable", ownershipReleased: false });
    release(); expect(existsSync(path)).toBe(false);
    expect(storageLeaseObservation(release)).toMatchObject({ release: "returned", retained: false, ownerBound: false, ownershipReleased: false });
  });
  for (const when of ["before", "after"] as const) {
    it(`retains exact lease operation when SIMULATED removal throws ${when} actual deletion`, () => {
      const { release, path } = acquired(), bytes = readFileSync(path);
      leaseFault.path = path; leaseFault.mode = when;
      expect(() => release()).toThrow(leaseFault.failure);
      expect(storageLeaseObservation(release)).toMatchObject({ acquisition: "returned", release: "unknown", retained: true, ownershipReleased: false });
      leaseFault.mode = "none";
      if (when === "before") { expect(readFileSync(path)).toEqual(bytes); rmSync(path); }
      else expect(existsSync(path)).toBe(false);
      // Only fixture-owned disposal occurred; it does not resolve source unknown.
      expect(storageLeaseObservation(release)).toMatchObject({ release: "unknown", retained: true, ownershipReleased: false });
    });
  }
  it("does not turn an already absent own lease into a release acknowledgement", () => {
    const { release, path } = acquired(); rmSync(path); release();
    expect(storageLeaseObservation(release)).toMatchObject({ release: "unknown", retained: true, ownershipReleased: false });
  });
  it("marks changed identity unknown while preserving the ordinary callback removal behavior", () => {
    const { release, path } = acquired(), retained = `${path}.owned-original`, bytes = readFileSync(path);
    renameSync(path, retained); writeFileSync(path, bytes);
    release(); expect(existsSync(path)).toBe(false); expect(readFileSync(retained)).toEqual(bytes);
    expect(storageLeaseObservation(release)).toMatchObject({ release: "unknown", retained: true, ownershipReleased: false });
  });
  it("never treats a repeated ordinary callback as another confirmed lease outcome", () => {
    const { release } = acquired(); release(); release();
    expect(storageLeaseObservation(release)).toMatchObject({ release: "unknown", retained: true, ownershipReleased: false });
  });
});

describe("actual decision consumer admission (not complete owner or retirement authority)", () => {
  function consumer() {
    const db = new DatabaseSync(join(env.home, "owned-decisions.db")); owned.set(db, { actuallyClosed: false });
    db.exec(DECISIONS_SCHEMA); db.exec("CREATE TABLE owned_mail(id TEXT PRIMARY KEY, body BLOB NOT NULL)");
    return { db, decisions: new DecisionStore(db) };
  }
  const author = { id: "owned-author", name: "owned-author", agent: "other" as const };
  const message: BridgeMessage = { id: "owned-notification", from: author, to: "owned-session", recipient: "owned-session",
    conversationId: "owned-decision", replyTo: null, hop: 1, body: "Exact accepted notification bytes", createdAt: 1, readAt: null };
  it("sealed direct record/import/list/enqueue/link entry refuses before any native SQL and reversible resume preserves normal behavior", () => {
    const { db, decisions } = consumer();
    const row = decisions.record({ topic: "owned", text: "Exact accepted decision bytes", scope: "all" }, author, 1);
    decisions.sealLifecycleConsumer();
    const exec = vi.spyOn(DatabaseSync.prototype, "exec"), prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    for (const operation of [
      () => decisions.record({ topic: "next", text: "retained", scope: "all" }, author, 2),
      () => decisions.importSync(row), () => decisions.list(),
      () => decisions.enqueue(row, "owned-session", message, () => { throw new Error("must not enter"); }),
      () => decisions.linkSession("owned-session", "next-session"),
    ]) expect(operation).toThrow(expect.objectContaining({ code: "OWNER_QUIESCED" }));
    expect(decisions.lifecycleConsumerObservation()).toMatchObject({ sealed: true, pendingOperations: 0, transactionSettled: true,
      ownerBound: false, settled: false, blocker: "owner_unsupported", ownershipReleased: false });
    expect(exec).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    vi.restoreAllMocks(); decisions.resumeLifecycleConsumer();
    expect(decisions.list()).toContainEqual(expect.objectContaining({ id: row.id, text: "Exact accepted decision bytes" }));
    expect(db.prepare("SELECT count(*) AS n FROM decision_deliveries").get()!.n).toBe(0);
  });
  it("a seal during an already accepted arbitrary insert preserves actual COMMIT and bytes but admits no new decision entry", () => {
    const { db, decisions } = consumer();
    const row = decisions.record({ topic: "owned", text: "Exact accepted decision bytes", scope: "all" }, author, 1);
    expect(decisions.enqueue(row, "owned-session", message, () => {
      expect(decisions.sealLifecycleConsumer()).toMatchObject({ sealed: true, pendingOperations: 1, callbackUnknown: true, transactionSettled: false });
      expect(() => decisions.linkSession("owned-session", "new-unaccepted-session")).toThrow(expect.objectContaining({ code: "OWNER_QUIESCED" }));
      db.prepare("INSERT INTO owned_mail VALUES(?,?)").run(message.id, Buffer.from(message.body));
    })).toBe(true);
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM decision_deliveries").get()!.n).toBe(1);
    expect(Buffer.from(db.prepare("SELECT body FROM owned_mail WHERE id=?").get(message.id)!.body as Uint8Array).toString()).toBe(message.body);
    expect(decisions.lifecycleConsumerObservation()).toMatchObject({ sealed: true, pendingOperations: 0, callbackUnknown: true,
      settled: false, blocker: "owner_unsupported", ownershipReleased: false });
    decisions.resumeLifecycleConsumer(); expect(decisions.lifecycleConsumerObservation().callbackUnknown).toBe(true);
  });
  it("real SQL failure is retained as unknown and a native transaction property is not complete settlement proof", () => {
    const { db, decisions } = consumer();
    db.exec("DROP TABLE decision_deliveries");
    expect(() => decisions.linkSession("owned-session", "next-session")).toThrow();
    expect(decisions.lifecycleConsumerObservation()).toMatchObject({ pendingOperations: 0, unknown: true, ownershipReleased: false });
    db.exec("BEGIN IMMEDIATE");
    try {
      expect(decisions.sealLifecycleConsumer()).toMatchObject({ pendingOperations: 0, transactionSettled: false, settled: false,
        ownerBound: false, blocker: "owner_unsupported" });
    } finally { db.exec("ROLLBACK"); }
    decisions.resumeLifecycleConsumer(); expect(decisions.lifecycleConsumerObservation().unknown).toBe(true);
  });
});

describe("actual history consumer admission and managed values (not full native resource closure)", () => {
  function consumer(sink?: ConstructorParameters<typeof HistoryIndex>[4]) {
    const db = openHistoryStore(join(env.home, "owned-history.db")); owned.set(db, { actuallyClosed: false });
    return { db, index: new HistoryIndex(db, null, undefined, db, sink) };
  }
  it("typed known reads return detached values without registering a raw borrower", () => {
    const { db, index } = consumer();
    db.prepare("INSERT INTO history_sessions VALUES (?,?,?)").run("owned-alias", "owned-session", null);
    db.prepare("INSERT INTO history_files(path,kind,agent,session,cwd) VALUES(?,?,?,?,?)").run("owned-file", "run", "other", "owned-session", "owned-project");
    expect(index.sessionProjectPaths("owned-alias")).toEqual(["owned-project"]);
    expect(index.conversationPage({ id: "owned-missing-conversation" })).toEqual({ conversation: null, records: [], next: null });
    expect(index.lifecycleConsumerObservation()).toMatchObject({ rawBorrower: false, pendingOperations: 0, durableObligations: "unverified",
      ownerBound: false, settled: false, ownershipReleased: false });
  });
  it("seal rejects every direct producer/read/raw-borrower entry before SQL without clearing discovery or durable obligations", () => {
    const { db, index } = consumer();
    db.prepare("INSERT INTO history_sessions VALUES (?,?,?)").run("owned-alias", "owned-session", null);
    index.sealLifecycleConsumer();
    const exec = vi.spyOn(DatabaseSync.prototype, "exec"), prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    for (const operation of [
      () => index.rememberPeer({ id: "new-id", name: "new-peer", sessionId: "new-session" }), () => index.tick(), () => index.wake(),
      () => index.search({ query: "owned" }), () => index.reset(), () => index.close(), () => index.database,
      () => index.storageDatabase, () => index.legacyReadNotice, () => index.sessionProjectPaths("owned-alias"),
      () => index.conversationPage({ id: "owned-missing-conversation" }),
    ]) expect(operation).toThrow(expect.objectContaining({ code: "OWNER_QUIESCED" }));
    expect(index.lifecycleConsumerObservation()).toMatchObject({ sealed: true, pendingOperations: 0, rawBorrower: false, durableObligations: "unverified", settled: false });
    expect(exec).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    vi.restoreAllMocks(); index.resumeLifecycleConsumer();
    expect(db.prepare("SELECT session FROM history_sessions WHERE alias=?").get("owned-alias")!.session).toBe("owned-session");
    expect(index.sessionProjectPaths("owned-alias")).toEqual([]);
  });
  it("an actual escaped legacy getter remains an unenrolled borrower after reversible resume", () => {
    const { db, index } = consumer(); expect(index.storageDatabase).toBe(db);
    expect(index.database).toBe(db); index.sealLifecycleConsumer(); index.resumeLifecycleConsumer();
    expect(index.lifecycleConsumerObservation()).toMatchObject({ rawBorrower: true, settled: false, blocker: "owner_unsupported", ownershipReleased: false });
  });
  it("retains an accepted sink operation across a seal while refusing new reentrant admission", () => {
    let index!: HistoryIndex, db!: DatabaseSync;
    const fixture = consumer(peer => {
      expect(index.sealLifecycleConsumer()).toMatchObject({ pendingOperations: 1, callbackUnknown: true });
      expect(() => index.wake()).toThrow(expect.objectContaining({ code: "OWNER_QUIESCED" }));
      db.prepare("INSERT INTO history_sessions VALUES (?,?,?)").run(peer.id, peer.sessionId!, null);
    });
    index = fixture.index; db = fixture.db;
    index.rememberPeer({ id: "owned-alias", name: "owned-peer", sessionId: "owned-session" });
    expect(db.prepare("SELECT session FROM history_sessions WHERE alias=?").get("owned-alias")!.session).toBe("owned-session");
    expect(index.lifecycleConsumerObservation()).toMatchObject({ pendingOperations: 0, sealed: true, callbackUnknown: true, settled: false });
    index.resumeLifecycleConsumer(); expect(index.lifecycleConsumerObservation().callbackUnknown).toBe(true);
  });
  it("the actual Store broadcast consumer uses typed history values without escaping a native handle", () => {
    const store = new MessageStore(env.db, nullLogger); ownedStores.add(store);
    store.rememberName({ id: "owned-peer", name: "owned-peer", agent: "other", sessionId: "owned-session", cwd: env.home,
      pid: process.pid, agentPid: null, startedAt: 1, autoWake: false }, 1);
    expect(store.broadcastNames()).toContain("owned-peer");
    expect(store.history.lifecycleConsumerObservation()).toMatchObject({ rawBorrower: false, ownerBound: false, settled: false, ownershipReleased: false });
  });
});

describe("actual known compatibility overlay admission (not main-only or owner completeness)", () => {
  function main(name: string) {
    const db = new DatabaseSync(join(env.home, name)); owned.set(db, { actuallyClosed: false }); return db;
  }
  function existingOverlay() {
    const db = main("overlay-seed-main.db"); attachStoreCompatibility(db, join(env.home, "overlay-seed-main.db"), nullLogger, true);
    db.exec("CREATE TABLE store_compatibility.owned_overlay_fixture(body BLOB NOT NULL); INSERT INTO store_compatibility.owned_overlay_fixture VALUES(x'00ff04');");
    dispose(db); const path = join(env.home, "store-compatibility.db"); return { path, bytes: readFileSync(path) };
  }
  it("records the actual source attachment without census SQL, preserves retained routing and does not certify arbitrary attachments", () => {
    const db = main("owned-main.db"); attachStoreCompatibility(db, join(env.home, "owned-main.db"), nullLogger, true);
    db.prepare("INSERT INTO peer_names VALUES(?,?,?,?,?)").run("owned-id", "Exact retained overlay name", "owned-session", "other", 1);
    const extra = main("unknown-attachment.db"); dispose(extra);
    db.prepare("ATTACH DATABASE ? AS unknown_attachment").run(join(env.home, "unknown-attachment.db"));
    const exec = vi.spyOn(DatabaseSync.prototype, "exec"), prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    expect(storeCompatibilityObservation(db)).toMatchObject({ captures: 1, pending: 0, unknown: false, attached: 1,
      initializedHandlesClosed: 1, retained: 0, ownerBound: false, settled: false, ownershipReleased: false });
    expect(exec).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); vi.restoreAllMocks();
    expect(db.prepare("SELECT name FROM peer_names").get()!.name).toBe("Exact retained overlay name");
    expect(db.prepare("PRAGMA database_list").all().map(row => row.name)).toContain("unknown_attachment");
    expect(storeCompatibilityObservation({ ...db } as unknown as DatabaseSync)).toMatchObject({ captures: 0, ownerBound: false, settled: false });
  });
  it("retains an actual temporary initialization capture before SIMULATED failure while real close leaves accepted overlay bytes intact", () => {
    const fixture = existingOverlay(), db = main("failed-init-main.db"), failure = new Error("SIMULATED overlay initialization failure");
    let overlay: DatabaseSync | undefined;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
      const result = nativeExec.call(this, sql);
      if (this !== db && /^PRAGMA busy_timeout/.test(sql)) {
        overlay = this; owned.set(this, { actuallyClosed: false });
        expect(storeCompatibilityObservation(db)).toMatchObject({ captures: 1, pending: 1, attached: 0, retained: 1 }); throw failure;
      }
      return result;
    });
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
      const result = nativeClose.call(this); if (this === overlay) owned.get(this)!.actuallyClosed = true; return result;
    });
    expect(() => attachStoreCompatibility(db, join(env.home, "failed-init-main.db"), nullLogger, false)).toThrow(failure);
    expect(storeCompatibilityObservation(db)).toMatchObject({ pending: 0, unknown: true, attached: 0, initializedHandlesClosed: 1, retained: 1, ownershipReleased: false });
    vi.restoreAllMocks(); expect(readFileSync(fixture.path)).toEqual(fixture.bytes);
  });
  it("keeps exact temporary native capture after SIMULATED close errors before or after actual native close", () => {
    const fixture = existingOverlay();
    for (const when of ["before", "after"] as const) {
      const db = main(`failed-${when}-main.db`), failure = new Error("SIMULATED overlay close failure"); let overlay: DatabaseSync | undefined;
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
        const result = nativeExec.call(this, sql);
        if (this !== db && /^PRAGMA busy_timeout/.test(sql)) { overlay = this; owned.set(this, { actuallyClosed: false }); }
        return result;
      });
      vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
        if (this !== overlay) return nativeClose.call(this);
        if (when === "after") { nativeClose.call(this); owned.get(this)!.actuallyClosed = true; }
        throw failure;
      });
      expect(() => attachStoreCompatibility(db, join(env.home, `failed-${when}-main.db`), nullLogger, false)).toThrow(failure);
      expect(storeCompatibilityObservation(db)).toMatchObject({ pending: 0, unknown: true, attached: 0, initializedHandlesClosed: 0, retained: 1, ownershipReleased: false });
      vi.restoreAllMocks(); if (!owned.get(overlay!)!.actuallyClosed) dispose(overlay!);
      expect(storeCompatibilityObservation(db)).toMatchObject({ unknown: true, retained: 1, initializedHandlesClosed: 0 });
      expect(readFileSync(fixture.path)).toEqual(fixture.bytes);
    }
  });
});

describe("actual MessageStore construction resources (not complete consumer/producer closure)", () => {
  it("captures the actual main before initialization and actual handles/cache/consumers without census SQL", () => {
    let main: DatabaseSync | undefined;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
      const observation = messageStoreHandleObservation(this);
      if (observation.captured && observation.main && observation.construction === "attempted" && main === undefined) {
        main = this; expect(observation).toMatchObject({ handles: 1, statements: 0, consumers: 0, ownerBound: false, settled: false });
      }
      return nativeExec.call(this, sql);
    });
    const store = new MessageStore(env.db, nullLogger); ownedStores.add(store); vi.restoreAllMocks();
    const exec = vi.spyOn(DatabaseSync.prototype, "exec"), prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    expect(main).toBeDefined();
    expect(messageStoreHandleObservation(main!)).toMatchObject({ construction: "returned", handles: 3, statements: 6, consumers: 2,
      close: "not_attempted", ordinaryClose: "not_attempted", retained: false, ownerBound: false, settled: false, ownershipReleased: false });
    expect(exec).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); vi.restoreAllMocks();
    store.close(); ownedStores.delete(store);
    expect(messageStoreHandleObservation(main!)).toMatchObject({ close: "returned", ordinaryClose: "returned", ownerBound: false, settled: false, ownershipReleased: false });
  });
  function acceptedStore() {
    const store = new MessageStore(env.db, nullLogger); ownedStores.add(store);
    store.insert({ id: "accepted-construction-mail", from: { id: "owned-author", name: "owned-author", agent: "other" },
      to: "owned-peer", recipient: "owned-peer", conversationId: "owned-construction", replyTo: null, hop: 1,
      body: "Exact accepted construction bytes", createdAt: 1, readAt: null });
    store.close(); ownedStores.delete(store); return readFileSync(env.db);
  }
  for (const closeFault of [false, true]) {
    it(`retains actual failed construction and ${closeFault ? "SIMULATED unknown close" : "actual close return"} without losing accepted bytes`, () => {
      const bytes = acceptedStore(), initFailure = new Error("SIMULATED Store initialization failure"), closeFailure = new Error("SIMULATED Store close failure before native close");
      let main: DatabaseSync | undefined;
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
        const result = nativeExec.call(this, sql), observation = messageStoreHandleObservation(this);
        if (main === undefined && observation.captured && observation.main && observation.construction === "attempted") {
          main = this; owned.set(this, { actuallyClosed: false }); throw initFailure;
        }
        return result;
      });
      vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
        if (this === main && closeFault) throw closeFailure;
        const result = nativeClose.call(this); if (this === main) owned.get(this)!.actuallyClosed = true; return result;
      });
      expect(() => new MessageStore(env.db, nullLogger)).toThrow(closeFault ? closeFailure : initFailure);
      expect(messageStoreHandleObservation(main!)).toMatchObject({ construction: "unknown", close: closeFault ? "unknown" : "returned",
        unknown: true, retained: true, ownerBound: false, settled: false, ownershipReleased: false });
      vi.restoreAllMocks(); if (!owned.get(main!)!.actuallyClosed) dispose(main!);
      expect(messageStoreHandleObservation(main!)).toMatchObject({ construction: "unknown", close: closeFault ? "unknown" : "returned", retained: true });
      expect(readFileSync(env.db)).toEqual(bytes);
      const reader = new DatabaseSync(env.db, { readOnly: true }); owned.set(reader, { actuallyClosed: false });
      expect(reader.prepare("SELECT body FROM messages WHERE id=?").get("accepted-construction-mail")!.body).toBe("Exact accepted construction bytes"); dispose(reader);
    });
  }
});

describe("managed conversation DTO equivalence before pinned Broker wiring", () => {
  function retainedPage(db: DatabaseSync) {
    db.prepare("INSERT INTO conversations(id,agent,session,project,kind) VALUES(?,?,?,?,?)").run("other:owned-session", "other", "owned-session", "owned-project", "transcript");
    const insert = db.prepare("INSERT INTO conversation_records(id,source,generation,offset,conversation,at,raw,body,part) VALUES(?,?,?,?,?,?,?,?,?)");
    insert.run(1, "owned-native-source", 1, 0, "other:owned-session", 1, Buffer.from("Exact accepted raw Unicode π\n"), "Exact accepted record", null);
    insert.run(2, "owned-native-source", 1, 31, "other:owned-session", 2, Buffer.from("Second accepted raw record\n"), "Second accepted record", null);
  }
  it("returns the same populated native page, raw bytes/base64, pagination and missing DTO without native escape", () => {
    const db = openHistoryStore(join(env.home, "conversation-dto.db")); owned.set(db, { actuallyClosed: false });
    retainedPage(db); const index = new HistoryIndex(db, null), input = { id: "other:owned-session", limit: 1 };
    const expected = readConversation(db, input);
    expect(expected.records).toHaveLength(1); expect(expected.next).toBe(1);
    expect(index.conversationPage(input)).toEqual(expected);
    expect(index.conversationPage({ ...input, after: 1 })).toEqual(readConversation(db, { ...input, after: 1 }));
    expect(index.conversationPage({ id: "owned-absent" })).toEqual(readConversation(db, { id: "owned-absent" }));
    expect(index.lifecycleConsumerObservation()).toMatchObject({ rawBorrower: false, ownerBound: false, settled: false, ownershipReleased: false });
  });
  it("retains exact actual legacy fallback page plus unchanged migration DTO", () => {
    const store = new MessageStore(env.db, nullLogger); ownedStores.add(store);
    // Fixture inspection accesses its OWN real handles, never an issuer/permit.
    const main = Reflect.get(store, "db") as DatabaseSync, history = Reflect.get(store, "historyDb") as DatabaseSync;
    retainedPage(main); const input = { id: "other:owned-session", limit: 1 };
    const migration = legacyReadNotice(history); expect(migration).toMatchObject({ ready: false, readsFrom: "legacy" });
    expect(store.history.conversationPage(input)).toEqual({ ...readConversation(main, input), migration });
    expect(store.history.legacyReadNotice).toEqual(migration);
    expect(store.history.lifecycleConsumerObservation()).toMatchObject({ rawBorrower: false, ownerBound: false, settled: false, ownershipReleased: false });
  });
});
