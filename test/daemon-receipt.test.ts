import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleJournal, LifecycleUnavailable, LIFECYCLE_ADMISSION_MS, LIFECYCLE_PRE_RELEASE_MS,
  LIFECYCLE_PREPARE_MS, LIFECYCLE_DISPATCH_DRAIN_MS, LIFECYCLE_WRITE_CHECKPOINT_MS, LIFECYCLE_BIND_OBSERVE_MS,
  type LifecycleInstance, type LifecycleRequest } from "../src/core/daemon-lifecycle.js";
import { readProcessIdentity } from "../src/core/process-identity.js";
import { makeEnv, type TestEnv } from "./helpers.js";

let env: TestEnv, owner: LifecycleInstance, journal: LifecycleJournal | undefined, captured: DatabaseSync | undefined;
const sqliteExec = DatabaseSync.prototype.exec;
beforeEach(async () => {
  env = makeEnv(); journal = undefined; captured = undefined;
  const creationIdentity = await readProcessIdentity(process.pid); expect(creationIdentity).toBeTruthy();
  owner = { nonce: randomUUID(), pid: process.pid, creationIdentity: creationIdentity! };
});
afterEach(async () => {
  vi.restoreAllMocks();
  // Only exact fixture-owned local SQL transactions/handles, never product work.
  if (captured?.isTransaction) sqliteExec.call(captured, "ROLLBACK");
  if (journal && !journal.close()) {
    // Explicit disposal is fixture teardown ONLY, not a production force-close
    // API or proof that an unknown lifecycle outcome was rolled back/settled.
    const actual = captured ?? Reflect.get(journal, "writer");
    expect(actual).toBeInstanceOf(DatabaseSync); actual.close();
  }
  await env.cleanup();
});
const file = () => join(env.home, ".core-lifecycle", "receipts.sqlite");
const deadline = () => performance.now() + LIFECYCLE_ADMISSION_MS;
const request = (): LifecycleRequest => ({ restartId: randomUUID(), operation: "restart", oldInstance: owner,
  target: { immutableRuntimePath: join(env.home, "fixture-immutable-runtime.mjs"), version: "fixture", protocol: 1, fileManifestDigest: "a".repeat(64) } });
async function bootstrap() { journal = await LifecycleJournal.bootstrap(env.home, owner); return journal; }
const portable = process.platform !== "win32";
function publicQuarantineRefuses(j: LifecycleJournal, id: string) {
  const sql = vi.spyOn(DatabaseSync.prototype, "prepare"), close = vi.spyOn(DatabaseSync.prototype, "close"), exec = vi.spyOn(DatabaseSync.prototype, "exec");
  const counts = [sql.mock.calls.length, close.mock.calls.length, exec.mock.calls.length];
  expect(() => j.lookup(id)).toThrow("writer_unknown"); expect(() => j.selected()).toThrow("writer_unknown");
  expect(() => j.preparedReader(id)).toThrow("writer_unknown"); expect(j.close()).toBe(false);
  expect([sql.mock.calls.length, close.mock.calls.length, exec.mock.calls.length]).toEqual(counts);
}
function committedFixtureRows() {
  const observer = new DatabaseSync(file(), { readOnly: true });
  try { observer.exec("PRAGMA query_only=ON"); return observer.prepare("SELECT json FROM receipt_revisions ORDER BY revision").all(); }
  finally { observer.close(); }
}

describe("lifecycle-only committed receipt storage (not restart acceptance)", () => {
  it("freezes lifecycle budgets and refuses the currently unproved Windows bootstrap without mutation", async () => {
    expect([LIFECYCLE_PRE_RELEASE_MS, LIFECYCLE_ADMISSION_MS, LIFECYCLE_PREPARE_MS, LIFECYCLE_DISPATCH_DRAIN_MS,
      LIFECYCLE_WRITE_CHECKPOINT_MS, LIFECYCLE_BIND_OBSERVE_MS]).toEqual([10000, 1000, 5000, 2000, 2000, 2000]);
    if (!portable) {
      await expect(bootstrap()).rejects.toMatchObject({ reason: "publication_unproved" });
      expect(existsSync(join(env.home, ".core-lifecycle"))).toBe(false);
    }
  });
  it.skipIf(!portable)("retains every committed revision and conflicting request while same-ID lost reply is idempotent", async () => {
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.includes("PRAGMA journal_mode=PERSIST")) captured = this;
      return sqliteExec.call(this, sql);
    });
    const began = performance.now(), j = await bootstrap(), input = request(), accepted = j.admit(input, deadline());
    spy.mockRestore();
    expect(captured!.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("persist");
    expect(captured!.prepare("PRAGMA synchronous").get()?.synchronous).toBe(2);
    expect(captured!.prepare("PRAGMA journal_size_limit").get()?.journal_size_limit).toBe(-1);
    expect(j.admit(input, deadline())).toEqual(accepted);
    const prepared = j.advance(input.restartId, 1, "preparing", {}, deadline());
    expect(prepared.revision).toBe(2); expect(j.admit(input, deadline())).toEqual(prepared);
    expect(() => j.admit({ ...input, operation: "stop" }, deadline())).toThrow(LifecycleUnavailable);
    const db = new DatabaseSync(file(), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM receipt_revisions").get()?.n).toBe(2);
      expect(db.prepare("SELECT count(*) AS n FROM receipt_conflicts").get()?.n).toBe(1);
      expect(db.prepare("SELECT sqlite_version() AS version").get()?.version).toBeTruthy();
      process.stderr.write("AB325 receipt fixture measurements " + JSON.stringify({ platform: process.platform, node: process.version,
        sqlite: db.prepare("SELECT sqlite_version() AS version").get()?.version, bootstrapAndReceiptMs: Math.round(performance.now() - began),
        publication: "unix_directory_sync_and_committed_reopen", restartAcceptance: false }) + "\n");
    } finally { db.close(); }
    expect(lstatSync(file()).mode & 0o077).toBe(0); expect(existsSync(file() + "-journal")).toBe(true);
  });
  it.skipIf(!portable)("actual prepared reader rejects UPDATE and INSERT with strict readonly flags/query_only", async () => {
    const j = await bootstrap(), input = request(); j.admit(input, deadline());
    const prepare = DatabaseSync.prototype.prepare; let checked = false;
    const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith("SELECT l.json AS lineage")) {
        expect(prepare.call(this, "PRAGMA query_only").get()?.query_only).toBe(1);
        expect(() => prepare.call(this, "UPDATE lifecycle_lineage SET json=json").run()).toThrow();
        expect(() => prepare.call(this, "INSERT INTO receipt_conflicts(restart_id,observed_digest,json) VALUES ('x','x','x')").run()).toThrow();
        checked = true;
      }
      return prepare.call(this, sql);
    });
    const reader = j.preparedReader(input.restartId);
    try { expect(reader.read().restartId).toBe(input.restartId); expect(checked).toBe(true); }
    finally { reader.close(); spy.mockRestore(); }
    expect(j.lookup(input.restartId)?.revision).toBe(1);
  });
  it.skipIf(!portable)("old writer CAS rejects stale prepared acknowledgements and cannot cross release without checkpoint", async () => {
    const j = await bootstrap(), input = request(); j.admit(input, deadline());
    const replacement = { ...owner, nonce: randomUUID() };
    j.advance(input.restartId, 1, "preparing", { replacementInstance: replacement }, deadline());
    expect(() => j.advance(input.restartId, 1, "preparing", { replacementInstance: replacement }, deadline())).toThrow(LifecycleUnavailable);
    j.advance(input.restartId, 2, "draining", {}, deadline()); j.advance(input.restartId, 3, "prepared", {}, deadline());
    expect(() => j.advance(input.restartId, 4, "release_intent", {}, deadline())).toThrow(LifecycleUnavailable);
    const retained = j.selected();
    expect(retained).toMatchObject({ currentActor: { kind: "old", instance: owner }, actorGeneration: 1 });
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    expect(() => j.advance(input.restartId, 4, "release_intent", { checkpointManifest: {
      closureDigest: "a".repeat(64), owners: [] } }, deadline())).toThrow("owner_unsupported");
    expect(exec.mock.calls.some(([sql]) => sql === "BEGIN IMMEDIATE")).toBe(false);
    expect(() => j.advance(input.restartId, 4, "unknown", ({ currentActor: { kind: "successor", instance: replacement } } as unknown
      as Parameters<typeof j.advance>[3]), deadline())).toThrow("revision_conflict");
    expect(j.selected()).toEqual(retained);
    expect(j.selected()?.state).toBe("prepared");
  });
  it.skipIf(!portable)("real COMMIT_BUSY is locally settled and quarantined, never replayed or visible as acceptance", async () => {
    const j = await bootstrap(), input = request(), blocker = new DatabaseSync(file(), { readOnly: true });
    blocker.exec("BEGIN"); blocker.prepare("SELECT json FROM lifecycle_lineage").get();
    let commits = 0, begins = 0;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") { begins++; captured = this; }
      if (sql === "COMMIT") commits++;
      return sqliteExec.call(this, sql);
    });
    try {
      expect(() => j.admit(input, deadline())).toThrow(LifecycleUnavailable);
      expect(j.isQuarantined).toBe(true); expect(captured?.isTransaction).toBe(false); expect(commits).toBe(1);
      publicQuarantineRefuses(j, input.restartId); expect(committedFixtureRows()).toHaveLength(0);
      expect(() => j.admit(input, deadline())).toThrow(LifecycleUnavailable); expect(begins).toBe(1);
    } finally { spy.mockRestore(); blocker.exec("ROLLBACK"); blocker.close(); }
  });
  it.skipIf(!portable).each([false, true])("injected IOERR/FULL active versus auto-rollback quarantine (autoRollback=%s)", async autoRollback => {
    const j = await bootstrap(), input = request(); let rollbacks = 0;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") captured = this;
      if (sql === "COMMIT") {
        if (autoRollback) sqliteExec.call(this, "ROLLBACK");
        throw Object.assign(new Error("fixture SQLite fault"), { code: autoRollback ? "SQLITE_FULL" : "SQLITE_IOERR" });
      }
      if (sql === "ROLLBACK") rollbacks++;
      return sqliteExec.call(this, sql);
    });
    expect(() => j.admit(input, deadline())).toThrow(LifecycleUnavailable);
    expect(j.isQuarantined).toBe(true); expect(captured?.isTransaction).toBe(false);
    expect(rollbacks).toBe(autoRollback ? 0 : 1); publicQuarantineRefuses(j, input.restartId); expect(committedFixtureRows()).toHaveLength(0);
  });
  it.skipIf(!portable)("failed ROLLBACK retains unknown transaction/lock without forced close or tentative receipt reads", async () => {
    const j = await bootstrap(), input = request();
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") captured = this;
      if (sql === "COMMIT" || sql === "ROLLBACK") throw new Error("fixture unsettled transaction");
      return sqliteExec.call(this, sql);
    });
    expect(() => j.admit(input, deadline())).toThrow(LifecycleUnavailable);
    expect(captured?.isTransaction).toBe(true); expect(j.isQuarantined).toBe(true); expect(j.close()).toBe(false);
    expect(captured!.prepare("SELECT count(*) AS n FROM receipt_revisions").get()?.n).toBe(1);
    publicQuarantineRefuses(j, input.restartId); expect(committedFixtureRows()).toHaveLength(0);
  });
  it.skipIf(!portable)("unknown transaction-state API quarantines before BEGIN and cannot authorize close", async () => {
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.includes("PRAGMA journal_mode=PERSIST")) captured = this;
      return sqliteExec.call(this, sql);
    });
    const j = await bootstrap(); spy.mockRestore();
    const input = request(), retained = j.admit(input, deadline());
    // Native isTransaction is nonconfigurable. Inject ONLY the unavailable
    // observation at this private fixture boundary; keep real SQLite methods.
    const actual = captured!;
    expect(Reflect.set(j, "writer", { isTransaction: undefined, exec: actual.exec.bind(actual), prepare: actual.prepare.bind(actual) })).toBe(true);
    try {
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const reads = vi.spyOn(DatabaseSync.prototype, "prepare");
      expect(() => j.advance(input.restartId, 1, "preparing", {}, deadline())).toThrow(LifecycleUnavailable);
      expect(j.isQuarantined).toBe(true); expect(j.close()).toBe(false);
      expect(exec.mock.calls.some(([sql]) => sql === "BEGIN IMMEDIATE")).toBe(false);
      publicQuarantineRefuses(j, input.restartId);
      expect(JSON.parse(String(committedFixtureRows()[0]!.json))).toEqual(retained);
      expect(reads.mock.contexts.some(context => context === actual)).toBe(false);
    } finally { Reflect.set(j, "writer", actual); }
  });
  it.skipIf(!portable)("SIMULATED error after actual COMMIT retains committed bytes but quarantined public APIs cannot claim readiness or close", async () => {
    const j = await bootstrap(), input = request();
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") captured = this;
      const result = sqliteExec.call(this, sql);
      if (sql === "COMMIT") throw Object.assign(new Error("SIMULATED error after real COMMIT"), { errcode: 10 });
      return result;
    });
    expect(() => j.admit(input, deadline())).toThrow(LifecycleUnavailable);
    expect(captured!.isTransaction).toBe(false); expect(j.isQuarantined).toBe(true);
    const before = readFileSync(file()), rows = committedFixtureRows(); expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]!.json))).toMatchObject({ restartId: input.restartId, state: "accepted", revision: 1 });
    publicQuarantineRefuses(j, input.restartId);
    expect(readFileSync(file())).toEqual(before); expect(committedFixtureRows()).toEqual(rows);
  });
  it.skipIf(!portable)("actual crash hot journal cannot be repaired or reopened through quarantined public APIs", async () => {
    const j = await bootstrap(), input = request();
    const fault = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") captured = this;
      const result = sqliteExec.call(this, sql);
      if (sql === "COMMIT") throw new Error("SIMULATED error after real COMMIT");
      return result;
    });
    expect(() => j.admit(input, deadline())).toThrow(LifecycleUnavailable); fault.mockRestore();
    // The exact owned synthetic child deliberately exits mid-transaction. Its
    // small pager cache forces real journal/database spill; no signals or fake
    // journal header, writable recovery, or production teardown are used.
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      const db=new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA journal_mode=PERSIST; PRAGMA synchronous=FULL; PRAGMA cache_size=4; BEGIN IMMEDIATE');
      const insert=db.prepare('INSERT INTO receipt_conflicts(restart_id,observed_digest,json) VALUES(?,?,?)');
      for(let n=0;n<512;n++) insert.run('hot-fixture',String(n),'x'.repeat(8192));
      process.exit(23);
    `, file()], { stdio: "ignore", windowsHide: true });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", () => reject(new Error("Owned hot-journal fixture creation failed"))); child.once("exit", resolve); });
    expect(code).toBe(23);
    const main = readFileSync(file()), rollback = readFileSync(file() + "-journal"); expect(rollback.length).toBeGreaterThan(512);
    let observer: DatabaseSync | undefined;
    try { expect(() => { observer = new DatabaseSync(file(), { readOnly: true }); observer.exec("PRAGMA query_only=ON"); observer.prepare("SELECT count(*) FROM receipt_revisions").get(); }).toThrow(); }
    finally { observer?.close(); }
    publicQuarantineRefuses(j, input.restartId);
    expect(readFileSync(file())).toEqual(main); expect(readFileSync(file() + "-journal")).toEqual(rollback);
  });
  it.skipIf(!portable)("missing established journal is unknown, not repaired/recreated or treated as fresh home", async () => {
    const j = await bootstrap(), input = request(); j.admit(input, deadline());
    const before = readFileSync(file()); renameSync(file() + "-journal", file() + "-fixture-retained-journal");
    expect(() => j.lookup(input.restartId)).toThrow(LifecycleUnavailable);
    expect(() => j.admit(input, deadline())).toThrow(LifecycleUnavailable);
    expect(existsSync(file() + "-journal")).toBe(false); expect(readFileSync(file()).equals(before)).toBe(true);
    await expect(LifecycleJournal.bootstrap(env.home, owner)).rejects.toMatchObject({ reason: "lineage_unknown" });
    renameSync(file() + "-fixture-retained-journal", file() + "-journal");
    expect(j.lookup(input.restartId)?.state).toBe("accepted");
  });
});
