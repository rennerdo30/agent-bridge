import { Dir, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openArchive, archiveInitializationObservation } from "../src/core/sqlite-maintenance.js";
import { openHistoryStore, historyInitializationObservation, legacyReadNotice, historyReadStatus, openHistoryReader, historyReaderObservation } from "../src/core/history-store.js";
import { storageLease, storageLeaseObservation } from "../src/core/storage-lock.js";
import { DecisionStore, DECISIONS_SCHEMA } from "../src/core/decisions.js";
import { HistoryIndex } from "../src/core/history.js";
import { MessageStore, messageStoreHandleObservation } from "../src/core/store.js";
import { nullLogger } from "../src/core/logger.js";
import { attachStoreCompatibility, storeCompatibilityObservation } from "../src/core/store-compatibility-overlay.js";
import { readConversation } from "../src/core/conversations.js";
import type { BridgeMessage } from "../src/core/protocol.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

const leaseFault = vi.hoisted(() => ({ path: "", mode: "none" as "none" | "before" | "after", failure: new Error("SIMULATED lease removal failure") }));
const acquisitionFault = vi.hoisted(() => ({ directory: "", stage: "none" as "none" | "write" | "close_before" | "close_after",
  failure: new Error("SIMULATED lease acquisition/descriptor failure"),
  descriptors: new Set<{ fd: number; path: string; closed: boolean }>(), active: new Map<number, { fd: number; path: string; closed: boolean }>(),
  actualClose: undefined as typeof import("node:fs").closeSync | undefined }));
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  acquisitionFault.actualClose = original.closeSync;
  const remove: typeof original.rmSync = (path, options) => {
    if (path === leaseFault.path && leaseFault.mode === "before") throw leaseFault.failure;
    original.rmSync(path, options);
    if (path === leaseFault.path && leaseFault.mode === "after") throw leaseFault.failure;
  };
  const open: typeof original.openSync = (path, flags, mode) => {
    const fd = original.openSync(path, flags, mode);
    if (typeof path === "string" && acquisitionFault.directory && dirname(path) === acquisitionFault.directory) {
      const capture = { fd, path, closed: false }; acquisitionFault.descriptors.add(capture); acquisitionFault.active.set(fd, capture);
    }
    return fd;
  };
  const write: typeof original.writeSync = (...args: unknown[]) => {
    const result = Reflect.apply(original.writeSync, original, args) as number;
    if (typeof args[0] === "number" && acquisitionFault.active.has(args[0]) && acquisitionFault.stage === "write") throw acquisitionFault.failure;
    return result;
  };
  const close: typeof original.closeSync = fd => {
    const capture = acquisitionFault.active.get(fd);
    if (capture && acquisitionFault.stage === "close_before") throw acquisitionFault.failure;
    original.closeSync(fd);
    if (capture) { capture.closed = true; acquisitionFault.active.delete(fd); }
    if (capture && acquisitionFault.stage === "close_after") throw acquisitionFault.failure;
  };
  const forwarding = { rmSync: remove, openSync: open, writeSync: write, closeSync: close };
  return { ...original, ...forwarding, default: { ...original, ...forwarding } };
});

// Actual isolated native resources only. Fixture disposal is not a production
// force-close API or evidence the source's unknown close had succeeded.
const nativeExec = DatabaseSync.prototype.exec, nativeClose = DatabaseSync.prototype.close;
const nativeFunction = DatabaseSync.prototype.function, nativePrepare = DatabaseSync.prototype.prepare;
const owned = new Map<DatabaseSync, { actuallyClosed: boolean }>();
const ownedStores = new Set<MessageStore>();
const ownedIndexes = new Set<HistoryIndex>();
const ownedWriteLocks = new Set<DatabaseSync>();
const acceptedFixturePromises = new Set<Promise<unknown>>();
let env: TestEnv;
beforeEach(() => { leaseFault.path = ""; leaseFault.mode = "none"; acquisitionFault.directory = ""; acquisitionFault.stage = "none"; env = makeEnv(); });
afterEach(async () => {
  leaseFault.path = ""; leaseFault.mode = "none";
  acquisitionFault.directory = ""; acquisitionFault.stage = "none";
  vi.restoreAllMocks();
  for (const capture of acquisitionFault.descriptors) {
    if (!capture.closed) { acquisitionFault.actualClose!(capture.fd); capture.closed = true; acquisitionFault.active.delete(capture.fd); }
    acquisitionFault.descriptors.delete(capture);
  }
  for (const lock of ownedWriteLocks) { if (lock.isTransaction) nativeExec.call(lock, "ROLLBACK"); dispose(lock); ownedWriteLocks.delete(lock); }
  const acceptedOutcomes = await Promise.allSettled([...acceptedFixturePromises]); acceptedFixturePromises.clear();
  for (const index of ownedIndexes) { index.resumeLifecycleConsumer(); index.close(); ownedIndexes.delete(index); }
  for (const store of ownedStores) { if (store.lifecycleProducerObservation().sealed) store.resumeLifecycleProducers(); store.close(); ownedStores.delete(store); }
  for (const [db, outcome] of owned) {
    if (!outcome.actuallyClosed) { nativeClose.call(db); outcome.actuallyClosed = true; }
    owned.delete(db);
  }
  await env.cleanup();
  const acceptedFailures = acceptedOutcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
  if (acceptedFailures.length) throw new AggregateError(acceptedFailures, "owned accepted fixture operation failed during cleanup");
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

describe("actual readonly history helper capture (not enrolled consumer or cold ownership proof)", () => {
  function fixture() {
    const db = openHistoryStore(join(env.home, "history.db")); owned.set(db, { actuallyClosed: false });
    db.exec("CREATE TABLE owned_reader_fixture(body BLOB NOT NULL); INSERT INTO owned_reader_fixture VALUES(x'00ff04')");
    dispose(db); const path = join(env.home, "history.db"); return { path, bytes: readFileSync(path) };
  }
  it("returned actual readonly reader stays unenrolled and external actual close cannot manufacture a source ACK", () => {
    const input = fixture(), db = openHistoryReader(input.path); owned.set(db, { actuallyClosed: false });
    const exec = vi.spyOn(DatabaseSync.prototype, "exec"), prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    expect(historyReaderObservation(db)).toMatchObject({ captured: true, kind: "reader", open: "returned", initialize: "returned",
      close: "not_attempted", retained: false, physicalIdentity: "unproved", consumer: "unenrolled", ownerBound: false, settled: false, ownershipReleased: false });
    expect(exec).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); vi.restoreAllMocks();
    expect(() => db.exec("INSERT INTO owned_reader_fixture VALUES(x'01')")).toThrow();
    expect([...db.prepare("SELECT body FROM owned_reader_fixture").get()!.body as Uint8Array]).toEqual([0, 255, 4]);
    dispose(db); expect(historyReaderObservation(db)).toMatchObject({ close: "not_attempted", consumer: "unenrolled", ownershipReleased: false });
    expect(readFileSync(input.path)).toEqual(input.bytes);
  });
  it("retains actual unreturned readonly constructor attempts without inventing a DB or physical identity", () => {
    const input = fixture(), db = openHistoryReader(input.path); owned.set(db, { actuallyClosed: false });
    const before = historyReaderObservation(db).unknownOpens;
    expect(() => openHistoryReader(join(env.home, "owned-absent-reader.db"))).toThrow();
    expect(historyReaderObservation(db)).toMatchObject({ unknownOpens: before + 1, physicalIdentity: "unproved", settled: false, ownershipReleased: false });
    expect(existsSync(join(env.home, "owned-absent-reader.db"))).toBe(false);
  });
  for (const kind of ["reader", "status"] as const) {
    it(`${kind} captures the actual readonly connection before initialization/page SQL and retains SIMULATED init/close uncertainty`, () => {
      const input = fixture(), initializationFailure = new Error("SIMULATED readonly helper initialization error"), closeFailure = new Error("SIMULATED readonly close outcome");
      for (const closeFault of [false, true]) {
        let captured: DatabaseSync | undefined;
        if (kind === "reader") {
          vi.spyOn(DatabaseSync.prototype, "function").mockImplementation(function(this: DatabaseSync, ...args: Parameters<DatabaseSync["function"]>) {
            const result = nativeFunction.apply(this, args);
            if (captured === undefined) {
              captured = this; owned.set(this, { actuallyClosed: false });
              expect(historyReaderObservation(this)).toMatchObject({ captured: true, kind, open: "returned", initialize: "attempted", close: "not_attempted" });
              throw initializationFailure;
            }
            return result;
          });
        } else {
          vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
            const statement = nativePrepare.call(this, sql);
            if (captured === undefined) {
              captured = this; owned.set(this, { actuallyClosed: false });
              expect(historyReaderObservation(this)).toMatchObject({ captured: true, kind, open: "returned", initialize: "attempted", close: "not_attempted" });
              throw initializationFailure;
            }
            return statement;
          });
        }
        vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
          if (this === captured && closeFault) throw closeFailure;
          const result = nativeClose.call(this); if (this === captured) owned.get(this)!.actuallyClosed = true; return result;
        });
        expect(() => kind === "reader" ? openHistoryReader(input.path) : historyReadStatus(env.db)).toThrow(closeFault ? closeFailure : initializationFailure);
        expect(historyReaderObservation(captured!)).toMatchObject({ captured: true, initialize: "unknown", close: closeFault ? "unknown" : "returned",
          retained: true, consumer: "unenrolled", physicalIdentity: "unproved", ownershipReleased: false });
        vi.restoreAllMocks(); if (!owned.get(captured!)!.actuallyClosed) dispose(captured!);
        expect(historyReaderObservation(captured!)).toMatchObject({ initialize: "unknown", retained: true, ownershipReleased: false });
        expect(readFileSync(input.path)).toEqual(input.bytes);
      }
    });
  }
});

describe("lease acquisition native fault coverage (historical records only)", () => {
  for (const stage of ["write", "close_before", "close_after"] as const) {
    it(`captures actual owned descriptor and preserves original SIMULATED ${stage} error without inventing a returned lease`, () => {
      acquisitionFault.directory = join(env.home, ".storage-users"); acquisitionFault.stage = stage;
      expect(() => storageLease(env.home)).toThrow(acquisitionFault.failure);
      expect(acquisitionFault.descriptors.size).toBe(1);
      const capture = [...acquisitionFault.descriptors][0]!;
      expect(capture.closed).toBe(stage !== "close_before");
      expect(existsSync(capture.path)).toBe(true);
      const bytes = readFileSync(capture.path); expect(bytes.byteLength).toBeGreaterThan(0);
      acquisitionFault.stage = "none";
      if (!capture.closed) { acquisitionFault.actualClose!(capture.fd); capture.closed = true; acquisitionFault.active.delete(capture.fd); }
      expect(readFileSync(capture.path)).toEqual(bytes);
      // No release closure was returned. No invented observer key, transfer,
      // owner proof or source ACK follows this exact fixture-owned disposal.
    });
  }
  it("retains failed acquisition records past128 and exposes only overflow refusal, not source/native disposal proof", () => {
    const anchor = storageLease(env.home);
    acquisitionFault.directory = join(env.home, ".storage-users"); acquisitionFault.stage = "close_before";
    for (let n = 0; n < 129; n++) expect(() => storageLease(env.home)).toThrow(acquisitionFault.failure);
    expect(acquisitionFault.descriptors.size).toBe(129);
    expect([...acquisitionFault.descriptors].every(capture => !capture.closed)).toBe(true);
    expect(new Set([...acquisitionFault.descriptors].map(capture => capture.path)).size).toBe(129);
    expect(storageLeaseObservation(anchor)).toMatchObject({ overflow: true, ownerBound: false, ownershipReleased: false });
    acquisitionFault.stage = "none";
    for (const capture of acquisitionFault.descriptors) {
      acquisitionFault.actualClose!(capture.fd); capture.closed = true; acquisitionFault.active.delete(capture.fd);
    }
    anchor();
    expect(storageLeaseObservation(anchor)).toMatchObject({ overflow: true, ownerBound: false, ownershipReleased: false });
  });
});

describe("retained overlay DTO and actual unknown history obligations", () => {
  it("populated migration fallback stays equivalent with actual retained store_compatibility attachment and original rows/bytes", () => {
    const store = new MessageStore(env.db, nullLogger); ownedStores.add(store);
    const main = Reflect.get(store, "db") as DatabaseSync, history = Reflect.get(store, "historyDb") as DatabaseSync;
    attachStoreCompatibility(main, env.db, nullLogger, true);
    main.prepare("INSERT INTO store_compatibility.peer_names VALUES(?,?,?,?,?)").run("overlay-owned-id", "Exact retained overlay registration", "overlay-owned-session", "other", 1);
    main.prepare("INSERT INTO conversations(id,agent,session,project) VALUES(?,?,?,?)").run("other:overlay-session", "other", "overlay-session", "owned-project");
    main.prepare("INSERT INTO conversation_records(id,source,generation,offset,conversation,at,raw,body) VALUES(?,?,?,?,?,?,?,?)")
      .run(1, "owned-overlay-source", 1, 0, "other:overlay-session", 1, Buffer.from("Exact retained overlay DTO bytes\n"), "Exact retained overlay DTO body");
    const bytes = readFileSync(join(env.home, "store-compatibility.db")), input = { id: "other:overlay-session" }, migration = legacyReadNotice(history);
    expect(store.history.conversationPage(input)).toEqual({ ...readConversation(main, input), migration });
    expect(store.history.lifecycleConsumerObservation()).toMatchObject({ rawBorrower: false, durableObligations: "unverified", settled: false, ownershipReleased: false });
    expect(main.prepare("SELECT name FROM store_compatibility.peer_names WHERE identity=?").get("overlay-owned-id")!.name).toBe("Exact retained overlay registration");
    expect(readFileSync(join(env.home, "store-compatibility.db"))).toEqual(bytes);
  });
  it("real pending rows and actual active/partial discovery cannot become preparation from zero callback counters", () => {
    const store = new MessageStore(env.db, nullLogger); ownedStores.add(store);
    const main = Reflect.get(store, "db") as DatabaseSync, history = Reflect.get(store, "historyDb") as DatabaseSync;
    const paths = { claude: join(env.home, "owned-claude"), codex: join(env.home, "owned-codex"), opencode: join(env.home, "owned-opencode") };
    const projects = join(paths.claude, "projects"); mkdirSync(projects, { recursive: true });
    for (let n = 0; n < 100; n++) mkdirSync(join(projects, `owned-discovery-${n}`));
    const index = new HistoryIndex(history, env.home, paths, main); ownedIndexes.add(index);
    history.prepare("INSERT INTO history_pending VALUES(?,?,?,?,?,?,?,?)").run("owned-pending-row", "Exact accepted pending history bytes", "other", "owned-sender", "owned-id", "owned-recipient", "owned-recipient", 1);
    index.sealLifecycleConsumer(); const before = history.prepare("SELECT * FROM history_pending").all();
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare"), exec = vi.spyOn(DatabaseSync.prototype, "exec");
    expect(index.lifecycleConsumerObservation()).toMatchObject({ sealed: true, pendingOperations: 0, durableObligations: "unverified", settled: false });
    expect(() => index.tick()).toThrow(expect.objectContaining({ code: "OWNER_QUIESCED" }));
    expect(prepare).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled(); vi.restoreAllMocks();
    expect(history.prepare("SELECT * FROM history_pending").all()).toEqual(before);
    index.resumeLifecycleConsumer(); let actualActiveDirectoryObserved = false;
    const read = Dir.prototype.readSync;
    vi.spyOn(Dir.prototype, "readSync").mockImplementation(function(this: Dir) {
      const result = read.call(this);
      if (!actualActiveDirectoryObserved) {
        actualActiveDirectoryObserved = true;
        expect(index.lifecycleConsumerObservation()).toMatchObject({ pendingOperations: 1, activeDirectories: 1, durableObligations: "unverified", settled: false });
      }
      return result;
    });
    index.tick(); expect(actualActiveDirectoryObserved).toBe(true); vi.restoreAllMocks();
    const observation = index.sealLifecycleConsumer();
    expect(observation.pendingOperations).toBe(0); expect(observation.queuedDiscovery + observation.activeDirectories).toBeGreaterThan(0);
    expect(observation).toMatchObject({ durableObligations: "unverified", settled: false, ownerBound: false, ownershipReleased: false });
    const cursors = history.prepare("SELECT * FROM history_cursors ORDER BY source").all(), remaining = history.prepare("SELECT * FROM history_pending").all();
    expect(() => index.tick()).toThrow(expect.objectContaining({ code: "OWNER_QUIESCED" }));
    expect(history.prepare("SELECT * FROM history_cursors ORDER BY source").all()).toEqual(cursors);
    expect(history.prepare("SELECT * FROM history_pending").all()).toEqual(remaining);
    // Normal accepted tick indexed its work; no pending flags/rows/cursors were
    // cleared to manufacture a complete cold/worker/owner witness.
  });
});

describe("actual Store operation/native admission (not current cold or joint-owner grant)", () => {
  const mail: BridgeMessage = { id: "owned-admission-mail", from: { id: "owned-author", name: "owned-author", agent: "other" },
    recipient: "owned-recipient", to: "owned-recipient", conversationId: "owned-admission", replyTo: null, hop: 1,
    body: "Exact accepted admission bytes", createdAt: 1, readAt: null };
  function store() { const value = new MessageStore(env.db, nullLogger); ownedStores.add(value); return value; }
  it("outside-context direct/cache/child writes and default abort/close refuse before native SQL under the own-store seal", () => {
    const value = store(); value.insert(mail); const sealed = value.sealLifecycleProducers();
    expect(sealed).toMatchObject({ sealed: true, pendingOperations: 0, consumersSealed: true, coldPreparation: "unverified", settled: false, ownershipReleased: false });
    const exec = vi.spyOn(DatabaseSync.prototype, "exec"), prepare = vi.spyOn(DatabaseSync.prototype, "prepare"), close = vi.spyOn(DatabaseSync.prototype, "close");
    const all = vi.spyOn(StatementSync.prototype, "all"), cached = Reflect.get(value, "stmt").unread;
    for (const operation of [() => value.insert({ ...mail, id: "not-admitted" }), () => value.unread(mail.recipient, 10),
      () => value.markPeerSeen("not-admitted", 2), () => value.retainNativeChild("not-admitted", "owned-parent"),
      () => value.markRead(mail.recipient, [mail.id]), () => value.claim(mail.recipient, "not-admitted"),
      () => value.schedulePurgeOlderThan(2), () => value.stopWrites(), () => value.close(),
      () => cached.all(mail.recipient, 10),
      () => value.decisions.list(), () => value.history.wake()]) expect(operation).toThrow(expect.objectContaining({ code: "OWNER_QUIESCED" }));
    expect(exec).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    expect(all).not.toHaveBeenCalled();
    vi.restoreAllMocks(); value.resumeLifecycleProducers();
    expect(value.unread(mail.recipient, 10)).toContainEqual(expect.objectContaining({ id: mail.id, body: mail.body, readAt: null }));
    expect(value.nativeChildRoutes()).toEqual([]);
  });
  it("an actual SQLite-busy accepted retry keeps its original promise/bytes past observer expiry and naturally finishes after lock release", async () => {
    const value = store(), lock = new DatabaseSync(env.db, { timeout: 25 }); owned.set(lock, { actuallyClosed: false }); ownedWriteLocks.add(lock);
    lock.exec("BEGIN IMMEDIATE"); let completed = false;
    const pending = value.retryWrite(() => value.insert(mail)); acceptedFixturePromises.add(pending);
    void pending.then(() => { completed = true; }, () => {});
    expect(value.sealLifecycleProducers()).toMatchObject({ pendingOperations: 1, consumersSealed: false, callbackUnknown: true });
    expect(await value.observeLifecycleProducers(performance.now() + 10)).toMatchObject({ pendingOperations: 1, sealed: true, settled: false });
    expect(completed).toBe(false); expect(() => value.stopWrites()).toThrow(expect.objectContaining({ code: "OWNER_QUIESCED" }));
    lock.exec("ROLLBACK"); await pending; acceptedFixturePromises.delete(pending);
    expect(await value.observeLifecycleProducers(performance.now() + 2000)).toMatchObject({ pendingOperations: 0, consumersSealed: true,
      callbackUnknown: true, coldPreparation: "unverified", settled: false, ownershipReleased: false });
    value.resumeLifecycleProducers(); expect(value.unread(mail.recipient, 10)).toContainEqual(expect.objectContaining({ id: mail.id, body: mail.body }));
  });
  it("a seal inside an accepted batch cannot abort its original transaction or drop nested accepted mail", () => {
    const value = store();
    value.insertBatch([mail], () => {
      expect(value.sealLifecycleProducers()).toMatchObject({ pendingOperations: 1, consumersSealed: false, callbackUnknown: true, settled: false });
      expect(() => value.close()).toThrow(expect.objectContaining({ code: "OWNER_QUIESCED" }));
    });
    expect(value.lifecycleProducerObservation()).toMatchObject({ pendingOperations: 0, consumersSealed: true, callbackUnknown: true, settled: false });
    value.resumeLifecycleProducers(); expect(value.byId(mail.id)).toMatchObject({ body: mail.body, readAt: null });
  });
  it("actual scheduled maintenance remains accepted through timer pause and only natural work completion removes its pending record", async () => {
    const value = store(); value.insert(mail); value.schedulePurgeOlderThan(0); value.quiesceLifecycleMaintenance();
    expect(value.sealLifecycleProducers()).toMatchObject({ pendingMaintenance: true, pendingOperations: 1, legacyArchivePending: true, purgePending: true });
    expect(await value.observeLifecycleProducers(performance.now() + 10)).toMatchObject({ pendingMaintenance: true, pendingOperations: 1, settled: false });
    value.resumeLifecycleProducers(); value.resumeLifecycleMaintenance();
    await until(() => value.lifecycleProducerObservation().pendingOperations === 0);
    expect(value.lifecycleProducerObservation()).toMatchObject({ pendingMaintenance: false, legacyArchivePending: false, purgePending: false,
      purgeCursorPending: false, coldPreparation: "unverified", settled: false, ownershipReleased: false });
    expect(value.byId(mail.id)).toMatchObject({ body: mail.body, readAt: null });
  });
});
