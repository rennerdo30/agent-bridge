import { Dir, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openArchive, archiveInitializationObservation, ARCHIVE_DB_NAME } from "../src/core/sqlite-maintenance.js";
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
const directoryFault = vi.hoisted(() => ({ path: "", stage: "none" as "none" | "before" | "after", calls: 0, nativeEntries: 0,
  failure: Object.assign(new Error("SIMULATED directory opener ENOENT"), { code: "ENOENT" }),
  before: undefined as (() => void) | undefined, returned: undefined as ((dir: import("node:fs").Dir) => void) | undefined,
  owned: new Map<import("node:fs").Dir, { closed: boolean }>(), actualClose: undefined as typeof import("node:fs").Dir.prototype.closeSync | undefined }));
vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  acquisitionFault.actualClose = original.closeSync;
  directoryFault.actualClose = original.Dir.prototype.closeSync;
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
  const openDirectory: typeof original.opendirSync = (path, options) => {
    if (path !== directoryFault.path) return original.opendirSync(path, options);
    directoryFault.calls++; directoryFault.before?.();
    if (directoryFault.stage === "before") throw directoryFault.failure;
    directoryFault.nativeEntries++;
    const dir = original.opendirSync(path, options); directoryFault.owned.set(dir, { closed: false }); directoryFault.returned?.(dir);
    if (directoryFault.stage === "after") throw directoryFault.failure;
    return dir;
  };
  const forwarding = { rmSync: remove, openSync: open, writeSync: write, closeSync: close, opendirSync: openDirectory };
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
beforeEach(() => {
  leaseFault.path = ""; leaseFault.mode = "none"; acquisitionFault.directory = ""; acquisitionFault.stage = "none";
  directoryFault.path = ""; directoryFault.stage = "none"; directoryFault.calls = 0; directoryFault.nativeEntries = 0; directoryFault.before = undefined; directoryFault.returned = undefined;
  env = makeEnv();
});
afterEach(async () => {
  leaseFault.path = ""; leaseFault.mode = "none";
  acquisitionFault.directory = ""; acquisitionFault.stage = "none";
  directoryFault.path = ""; directoryFault.stage = "none"; directoryFault.before = undefined; directoryFault.returned = undefined;
  vi.restoreAllMocks();
  for (const capture of acquisitionFault.descriptors) {
    if (!capture.closed) { acquisitionFault.actualClose!(capture.fd); capture.closed = true; acquisitionFault.active.delete(capture.fd); }
    acquisitionFault.descriptors.delete(capture);
  }
  for (const lock of ownedWriteLocks) { if (lock.isTransaction) nativeExec.call(lock, "ROLLBACK"); dispose(lock); ownedWriteLocks.delete(lock); }
  const acceptedOutcomes = await Promise.allSettled([...acceptedFixturePromises]); acceptedFixturePromises.clear();
  for (const index of ownedIndexes) {
    const dir = (Reflect.get(index, "walk") as { dir: Dir } | null)?.dir;
    // Do not retry an uncertain source close. Dispose only an exact native
    // object actually obtained by this isolated fixture, without source ACK.
    if (dir && directoryFault.owned.has(dir)) disposeDirectory(dir);
    else { index.resumeLifecycleConsumer(); index.close(); }
    ownedIndexes.delete(index);
  }
  for (const store of ownedStores) { if (store.lifecycleProducerObservation().sealed) store.resumeLifecycleProducers(); store.close(); ownedStores.delete(store); }
  for (const [dir, outcome] of directoryFault.owned) {
    if (!outcome.closed) disposeDirectory(dir);
    directoryFault.owned.delete(dir);
  }
  for (const [db, outcome] of owned) {
    if (!outcome.actuallyClosed) { nativeClose.call(db); outcome.actuallyClosed = true; }
    owned.delete(db);
  }
  await env.cleanup();
  const acceptedFailures = acceptedOutcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
  if (acceptedFailures.length) throw new AggregateError(acceptedFailures, "owned accepted fixture operation failed during cleanup");
});
function dispose(db: DatabaseSync): void { nativeClose.call(db); owned.get(db)!.actuallyClosed = true; }
function disposeDirectory(dir: Dir): void {
  const outcome = directoryFault.owned.get(dir);
  if (!outcome) throw new Error("fixture directory ownership is unknown");
  if (!outcome.closed) { directoryFault.actualClose!.call(dir); outcome.closed = true; }
}
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

describe("actual History native statement admission (not cold or retirement permission)", () => {
  it("retains an accepted real history batch across a seal and rejects later admission before SQL", () => {
    const store = new MessageStore(env.db, nullLogger); ownedStores.add(store);
    const db = Reflect.get(store, "historyDb") as DatabaseSync, source = Reflect.get(store, "db") as DatabaseSync;
    const index = new HistoryIndex(db, null, undefined, source); ownedIndexes.add(index);
    db.prepare("INSERT INTO history_pending VALUES(?,?,?,?,?,?,?,?)").run("owned-native-pending", "Accepted native batch bytes", "other", "owned-sender", "owned-id", "owned-recipient", "owned-recipient", 1);
    let sealedDuringAcceptedBatch = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
      const result = nativeExec.call(this, sql);
      if (this === db && sql === "SAVEPOINT history_rows" && !sealedDuringAcceptedBatch) {
        sealedDuringAcceptedBatch = true;
        expect(index.sealLifecycleConsumer()).toMatchObject({ pendingOperations: 1, settled: false, ownershipReleased: false });
        expect(() => index.wake()).toThrow(expect.objectContaining({ code: "OWNER_QUIESCED" }));
      }
      return result;
    });
    index.tick(); expect(sealedDuringAcceptedBatch).toBe(true);
    vi.restoreAllMocks();
    expect(db.prepare("SELECT * FROM history_pending WHERE id=?").all("owned-native-pending")).toEqual([]);
    expect(db.prepare("SELECT body FROM history_documents WHERE id=?").get("message:owned-native-pending")!.body).toBe("Accepted native batch bytes");
    expect(index.lifecycleConsumerObservation()).toMatchObject({ sealed: true, pendingOperations: 0, nativeBorrower: false,
      nativeCompositeCoverage: "unverified", durableObligations: "unverified", settled: false, ownershipReleased: false });
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare"), exec = vi.spyOn(DatabaseSync.prototype, "exec");
    expect(() => index.tick()).toThrow(expect.objectContaining({ code: "OWNER_QUIESCED" }));
    expect(prepare).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
  });
  it("actual retained native frames refuse get/all/run and iterator creation or stepping after seal", () => {
    const db = openHistoryStore(join(env.home, "native-frame-history.db")); owned.set(db, { actuallyClosed: false });
    const index = new HistoryIndex(db, null); ownedIndexes.add(index);
    db.exec("CREATE TABLE owned_native_history(id INTEGER PRIMARY KEY, body TEXT NOT NULL); INSERT INTO owned_native_history VALUES(1,'Exact retained bytes'),(2,'Second retained bytes');");
    // Private source frame inspection is test-only and expressly records an
    // unenrolled native borrower; it never mints owner/retirement permission.
    type Frame = { get(): unknown; all(): unknown; run(): unknown; iterate(): IterableIterator<unknown> };
    const capture = Reflect.get(index, "statement") as (db: DatabaseSync, sql: string) => Frame;
    const read = capture.call(index, db, "SELECT * FROM owned_native_history ORDER BY id");
    const write = capture.call(index, db, "INSERT INTO owned_native_history VALUES(3,'Forbidden later bytes')");
    const iterator = read.iterate(); expect(iterator.next().value).toMatchObject({ id: 1, body: "Exact retained bytes" });
    index.sealLifecycleConsumer();
    const get = vi.spyOn(StatementSync.prototype, "get"), all = vi.spyOn(StatementSync.prototype, "all"), run = vi.spyOn(StatementSync.prototype, "run");
    const iterate = vi.spyOn(StatementSync.prototype, "iterate");
    for (const operation of [() => read.get(), () => read.all(), () => write.run(), () => read.iterate(), () => iterator.next(), () => iterator.return!()])
      expect(operation).toThrow(expect.objectContaining({ code: "OWNER_QUIESCED" }));
    expect(get).not.toHaveBeenCalled(); expect(all).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled(); expect(iterate).not.toHaveBeenCalled();
    expect(index.lifecycleConsumerObservation()).toMatchObject({ nativeBorrower: true, settled: false, ownershipReleased: false });
    vi.restoreAllMocks(); index.resumeLifecycleConsumer(); iterator.return!();
    expect(read.all()).toEqual([{ id: 1, body: "Exact retained bytes" }, { id: 2, body: "Second retained bytes" }]);
  });
});

describe("actual History owned readonly source captures (not cold or ownership proof)", () => {
  function fixture() {
    const store = new MessageStore(env.db, nullLogger); ownedStores.add(store);
    const home = join(env.home, "owned-source-read-home"); mkdirSync(home);
    const archive = initialized(kinds[0], join("owned-source-read-home", ARCHIVE_DB_NAME));
    const history = Reflect.get(store, "historyDb") as DatabaseSync, main = Reflect.get(store, "db") as DatabaseSync;
    const paths = { claude: join(home, "owned-claude"), codex: join(home, "owned-codex"), opencode: join(home, "owned-opencode") };
    const index = new HistoryIndex(history, home, paths, main); ownedIndexes.add(index);
    return { index, archive, history, main };
  }
  it("records the actual readonly archive connection before page SQL and completes only its actual native close", () => {
    const { index, archive, history, main } = fixture(); let captured: DatabaseSync | undefined, actualClose = false;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
      if (this !== history && this !== main && index.lifecycleConsumerObservation().sourceReaders === 1) {
        captured = this; owned.set(this, { actuallyClosed: false });
        expect(index.lifecycleConsumerObservation()).toMatchObject({ sourceReaders: 1, unknownSourceReads: 0, sourceReadIdentity: "unproved", settled: false });
      }
      return nativePrepare.call(this, sql);
    });
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
      if (this === captured) expect(index.lifecycleConsumerObservation()).toMatchObject({ sourceReaders: 1, unknownSourceReads: 0 });
      const result = nativeClose.call(this);
      if (this === captured) { actualClose = true; owned.get(this)!.actuallyClosed = true; }
      return result;
    });
    index.tick(); expect(captured).toBeInstanceOf(DatabaseSync); expect(actualClose).toBe(true);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare"), calls = prepare.mock.calls.length;
    expect(index.lifecycleConsumerObservation()).toMatchObject({ sourceReaders: 0, unknownSourceReads: 0, nativeBorrower: false,
      sourceReadIdentity: "unproved", settled: false, ownershipReleased: false });
    expect(prepare.mock.calls.length).toBe(calls);
    vi.restoreAllMocks(); expect(readFileSync(archive.file)).toEqual(archive.bytes); expect(retainedRow(archive.file)).toEqual([0, 255, 4]);
  });
  for (const when of ["before", "after"] as const) it(`retains the exact actual reader when SIMULATED page initialization and close ${when} native disposal fail`, () => {
    const { index, archive, history, main } = fixture();
    const initializationFailure = new Error("SIMULATED readonly page initialization failure after actual prepare"), closeFailure = new Error("SIMULATED reader close outcome error");
    let captured: DatabaseSync | undefined;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
      const result = nativePrepare.call(this, sql);
      if (this !== history && this !== main && index.lifecycleConsumerObservation().sourceReaders === 1) {
        captured = this; owned.set(this, { actuallyClosed: false });
        expect(index.lifecycleConsumerObservation()).toMatchObject({ sourceReaders: 1, unknownSourceReads: 0 });
        throw initializationFailure;
      }
      return result;
    });
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
      if (this !== captured) return nativeClose.call(this);
      if (when === "after") { nativeClose.call(this); owned.get(this)!.actuallyClosed = true; }
      throw closeFailure;
    });
    // Original finally-close exception precedence remains unchanged.
    expect(() => index.tick()).toThrow(closeFailure); expect(captured).toBeInstanceOf(DatabaseSync);
    expect(index.lifecycleConsumerObservation()).toMatchObject({ sourceReaders: 1, unknownSourceReads: 1, unknown: true,
      settled: false, ownershipReleased: false, blocker: "owner_unsupported" });
    vi.restoreAllMocks(); if (when === "before") dispose(captured!);
    // Fixture disposal is a separate native outcome, never a source ACK or a
    // public renewal/force-close API for the source's uncertain resource.
    expect(index.lifecycleConsumerObservation()).toMatchObject({ sourceReaders: 1, unknownSourceReads: 1, ownershipReleased: false });
    expect(readFileSync(archive.file)).toEqual(archive.bytes); expect(retainedRow(archive.file)).toEqual([0, 255, 4]);
  });
  it("retains an actual unreturned readonly constructor attempt without inventing a DB or creating a missing file", () => {
    const { index, archive } = fixture(), missing = join(env.home, "owned-missing-source.db");
    const open = Reflect.get(index, "openSourceReader") as (file: string, kind: "archive") => DatabaseSync;
    // Test-only inspection of the existing private source call; no public
    // authority factory or counterfeit returned native object is provided.
    expect(() => open.call(index, missing, "archive")).toThrow(); expect(existsSync(missing)).toBe(false);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare"), close = vi.spyOn(DatabaseSync.prototype, "close");
    expect(index.lifecycleConsumerObservation()).toMatchObject({ sourceReaders: 0, unknownSourceReads: 1, unknown: true,
      sourceReadIdentity: "unproved", settled: false, ownershipReleased: false });
    expect(prepare).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    vi.restoreAllMocks(); expect(readFileSync(archive.file)).toEqual(archive.bytes); expect(retainedRow(archive.file)).toEqual([0, 255, 4]);
  });
});

describe("source-owned History directory bookkeeping (no resource-absence or retirement authority)", () => {
  function consumer(sink?: (index: HistoryIndex) => void) {
    const db = openHistoryStore(join(env.home, "owned-directory-history.db")); owned.set(db, { actuallyClosed: false });
    let index!: HistoryIndex;
    index = new HistoryIndex(db, null, undefined, db, sink ? () => sink(index) : undefined); ownedIndexes.add(index);
    return { db, index };
  }
  function open(index: HistoryIndex, path: string): Dir {
    const operation = Reflect.get(index, "openSourceDirectory") as (entry: { path: string; root: string; kind: string; agent: string }) => Dir;
    return operation.call(index, { path, root: env.home, kind: "run", agent: "other" });
  }
  function read(index: HistoryIndex, dir: Dir) {
    return (Reflect.get(index, "readSourceDirectory") as (dir: Dir) => ReturnType<Dir["readSync"]>).call(index, dir);
  }
  function close(index: HistoryIndex, dir: Dir): void {
    (Reflect.get(index, "closeSourceDirectory") as (dir: Dir) => void).call(index, dir);
  }
  function trackClose(failure?: Error, when?: "before" | "after") {
    return vi.spyOn(Dir.prototype, "closeSync").mockImplementation(function(this: Dir) {
      const outcome = directoryFault.owned.get(this);
      if (outcome && when === "before") throw failure;
      const result = directoryFault.actualClose!.call(this); if (outcome) outcome.closed = true;
      if (outcome && when === "after") throw failure;
      return result;
    });
  }
  it("captures a real empty Dir before reading and completes only its actual source close through an accepted seal", () => {
    const path = join(env.home, "owned-empty-directory"); mkdirSync(path); directoryFault.path = path;
    let returned: Dir | undefined;
    const { index } = consumer(actual => {
      const dir = open(actual, path); expect(dir).toBe(returned);
      expect(actual.lifecycleConsumerObservation()).toMatchObject({ directoryAttempts: 1, directoryCaptures: 1,
        unknownDirectoryAttempts: 0, pendingOperations: 1, directoryNoResource: "unsupported" });
      expect(read(actual, dir)).toBe(null);
      actual.sealLifecycleConsumer(); close(actual, dir);
    });
    directoryFault.before = () => expect(index.lifecycleConsumerObservation()).toMatchObject({ directoryAttempts: 1, directoryCaptures: 0, pendingOperations: 1 });
    directoryFault.returned = dir => { returned = dir; expect(index.lifecycleConsumerObservation().directoryCaptures).toBe(0); };
    const closed = trackClose(); index.rememberPeer({ id: "owned-dir-peer", name: "owned-dir-peer", sessionId: "owned-dir-session" });
    expect(directoryFault.nativeEntries).toBe(1); expect(closed).toHaveBeenCalledTimes(1); expect(directoryFault.owned.get(returned!)!.closed).toBe(true);
    expect(index.lifecycleConsumerObservation()).toMatchObject({ sealed: true, pendingOperations: 0, directoryAttempts: 0, directoryCaptures: 0,
      directoryCloseReturns: 1, unknownDirectoryAttempts: 0, callbackUnknown: true, ownerBound: false, settled: false, ownershipReleased: false });
  });
  it("an actual original missing-directory error stays unknown with no invented returned object or authority", () => {
    const { index } = consumer(); directoryFault.path = join(env.home, "owned-missing-directory");
    expect(() => open(index, directoryFault.path)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(directoryFault.nativeEntries).toBe(1); expect(directoryFault.owned.size).toBe(0);
    const before = index.lifecycleConsumerObservation();
    expect(before).toMatchObject({ directoryAttempts: 1, directoryCaptures: 0, unknownDirectoryAttempts: 1, directoryCloseReturns: 0,
      unknown: true, directoryNoResource: "unsupported", ownerBound: false, settled: false, ownershipReleased: false });
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare"), exec = vi.spyOn(DatabaseSync.prototype, "exec"), next = vi.spyOn(Dir.prototype, "readSync"), closed = vi.spyOn(Dir.prototype, "closeSync");
    for (let n = 0; n < 50; n++) expect(index.lifecycleConsumerObservation()).toEqual(before);
    expect(directoryFault.nativeEntries).toBe(1); expect(prepare).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
    index.sealLifecycleConsumer(); index.resumeLifecycleConsumer(); expect(index.lifecycleConsumerObservation().unknownDirectoryAttempts).toBe(1);
  });
  it("a reversible seal refuses a new directory action before any native entry or attempt publication", () => {
    const { index } = consumer(); directoryFault.path = join(env.home, "owned-unentered-directory"); mkdirSync(directoryFault.path);
    index.sealLifecycleConsumer();
    expect(() => open(index, directoryFault.path)).toThrow(expect.objectContaining({ code: "OWNER_QUIESCED" }));
    expect(directoryFault.calls).toBe(0); expect(directoryFault.nativeEntries).toBe(0); expect(directoryFault.owned.size).toBe(0);
    expect(index.lifecycleConsumerObservation()).toMatchObject({ directoryAttempts: 0, directoryCaptures: 0, unknownDirectoryAttempts: 0,
      directoryNoResource: "unsupported", settled: false, ownershipReleased: false });
  });
  for (const stage of ["before", "after"] as const) it(`SIMULATED ENOENT ${stage} the native opener cannot certify resource absence`, () => {
    const { index } = consumer(), path = join(env.home, `owned-${stage}-directory`); mkdirSync(path);
    directoryFault.path = path; directoryFault.stage = stage;
    let returned: Dir | undefined; directoryFault.returned = dir => { returned = dir; };
    expect(() => open(index, path)).toThrow(directoryFault.failure);
    expect(directoryFault.nativeEntries).toBe(stage === "before" ? 0 : 1);
    expect(directoryFault.owned.size).toBe(stage === "before" ? 0 : 1);
    expect(index.lifecycleConsumerObservation()).toMatchObject({ directoryAttempts: 1, directoryCaptures: 0, unknownDirectoryAttempts: 1,
      directoryNoResource: "unsupported", settled: false, ownershipReleased: false });
    // A wrapper-owned object never received by the source is disposed ONLY by
    // its actual isolated fixture. This cannot acknowledge the source attempt.
    if (returned) disposeDirectory(returned);
    expect(index.lifecycleConsumerObservation().unknownDirectoryAttempts).toBe(1); expect(existsSync(path)).toBe(true);
  });
  it("a real native read on an explicitly fixture-disposed Dir retains the source's exact capture as unknown", () => {
    const { index } = consumer(), path = join(env.home, "owned-disposed-read-directory"); mkdirSync(path); directoryFault.path = path;
    const dir = open(index, path); disposeDirectory(dir);
    expect(() => read(index, dir)).toThrow(expect.objectContaining({ code: "ERR_DIR_CLOSED" }));
    expect(index.lifecycleConsumerObservation()).toMatchObject({ directoryAttempts: 1, directoryCaptures: 1, unknownDirectoryAttempts: 1,
      directoryCloseReturns: 0, unknown: true, settled: false, ownershipReleased: false });
    index.sealLifecycleConsumer(); index.resumeLifecycleConsumer();
    expect(index.lifecycleConsumerObservation().directoryCaptures).toBe(1);
  });
  it("SIMULATED read failure followed by an actual successful source close records that return without erasing uncertainty", () => {
    const { index } = consumer(), path = join(env.home, "owned-read-fault-directory"); mkdirSync(path); directoryFault.path = path;
    const dir = open(index, path), failure = new Error("SIMULATED directory read failure");
    const originalRead = Dir.prototype.readSync;
    const next = vi.spyOn(Dir.prototype, "readSync").mockImplementation(function(this: Dir) {
      if (this === dir) throw failure;
      return originalRead.call(this);
    });
    expect(() => read(index, dir)).toThrow(failure); next.mockRestore();
    const closed = trackClose(); close(index, dir); expect(closed).toHaveBeenCalledTimes(1);
    expect(directoryFault.owned.get(dir)!.closed).toBe(true);
    expect(index.lifecycleConsumerObservation()).toMatchObject({ directoryAttempts: 1, directoryCaptures: 1, unknownDirectoryAttempts: 1,
      directoryCloseReturns: 1, unknown: true, directoryNoResource: "unsupported", settled: false, ownershipReleased: false });
  });
  for (const when of ["before", "after"] as const) it(`SIMULATED close failure ${when} actual native disposal retains exact unacknowledged capture`, () => {
    const { index } = consumer(), path = join(env.home, `owned-close-${when}-directory`); mkdirSync(path); directoryFault.path = path;
    const dir = open(index, path), failure = new Error("SIMULATED directory close outcome error");
    const closed = trackClose(failure, when);
    expect(() => close(index, dir)).toThrow(failure); expect(closed).toHaveBeenCalledTimes(1);
    expect(directoryFault.owned.get(dir)!.closed).toBe(when === "after");
    expect(index.lifecycleConsumerObservation()).toMatchObject({ directoryAttempts: 1, directoryCaptures: 1, unknownDirectoryAttempts: 1,
      directoryCloseReturns: 0, unknown: true, directoryNoResource: "unsupported", settled: false, ownershipReleased: false });
    vi.restoreAllMocks(); disposeDirectory(dir);
    expect(index.lifecycleConsumerObservation()).toMatchObject({ directoryCaptures: 1, unknownDirectoryAttempts: 1, ownershipReleased: false });
  });
  it("actual partial discovery keeps the same Dir, accepted queue and cursors while a seal refuses new admission", () => {
    const store = new MessageStore(env.db, nullLogger); ownedStores.add(store);
    const main = Reflect.get(store, "db") as DatabaseSync, db = Reflect.get(store, "historyDb") as DatabaseSync;
    const paths = { claude: join(env.home, "owned-directory-claude"), codex: join(env.home, "owned-directory-codex"), opencode: join(env.home, "owned-directory-opencode") };
    const projects = join(paths.claude, "projects"); mkdirSync(projects, { recursive: true });
    for (let n = 0; n < 100; n++) mkdirSync(join(projects, `owned-partial-${n}`));
    const index = new HistoryIndex(db, env.home, paths, main); ownedIndexes.add(index); directoryFault.path = projects;
    let returned: Dir | undefined, observed = false; directoryFault.returned = dir => { returned = dir; };
    const originalRead = Dir.prototype.readSync;
    vi.spyOn(Dir.prototype, "readSync").mockImplementation(function(this: Dir) {
      if (this === returned && !observed) {
        observed = true; expect(index.lifecycleConsumerObservation()).toMatchObject({ directoryCaptures: 1, activeDirectories: 1, pendingOperations: 1 });
        index.sealLifecycleConsumer();
      }
      return originalRead.call(this);
    });
    index.tick(); expect(observed).toBe(true);
    expect((Reflect.get(index, "walk") as { dir: Dir }).dir).toBe(returned);
    const queue = [...Reflect.get(index, "queue")], cursors = db.prepare("SELECT * FROM history_cursors ORDER BY source").all();
    expect(queue.length).toBeGreaterThan(0);
    expect(index.lifecycleConsumerObservation()).toMatchObject({ sealed: true, pendingOperations: 0, directoryCaptures: 1, activeDirectories: 1,
      durableObligations: "unverified", directoryNoResource: "unsupported", settled: false, ownershipReleased: false });
    expect(() => index.tick()).toThrow(expect.objectContaining({ code: "OWNER_QUIESCED" }));
    expect(Reflect.get(index, "queue")).toEqual(queue); expect(db.prepare("SELECT * FROM history_cursors ORDER BY source").all()).toEqual(cursors);
  });
  it("overflow diagnostics remain clamped and probe-free while every actual failed attempt stays retained", () => {
    const { index } = consumer(); directoryFault.path = join(env.home, "owned-overflow-missing-directory");
    for (let n = 0; n < 130; n++) expect(() => open(index, directoryFault.path)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(directoryFault.nativeEntries).toBe(130);
    const before = index.lifecycleConsumerObservation();
    expect(before).toMatchObject({ directoryAttempts: 129, directoryCaptures: 0, unknownDirectoryAttempts: 129, directoryOverflow: true,
      directoryNoResource: "unsupported", ownerBound: false, settled: false, ownershipReleased: false });
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare"), exec = vi.spyOn(DatabaseSync.prototype, "exec"), next = vi.spyOn(Dir.prototype, "readSync"), closed = vi.spyOn(Dir.prototype, "closeSync");
    for (let n = 0; n < 50; n++) expect(index.lifecycleConsumerObservation()).toEqual(before);
    expect(directoryFault.nativeEntries).toBe(130); expect(prepare).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled();
    index.sealLifecycleConsumer(); index.resumeLifecycleConsumer(); expect(index.lifecycleConsumerObservation().directoryOverflow).toBe(true);
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
