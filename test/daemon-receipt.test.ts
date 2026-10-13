import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  journal?.close(); await env.cleanup();
});
const file = () => join(env.home, ".core-lifecycle", "receipts.sqlite");
const deadline = () => performance.now() + LIFECYCLE_ADMISSION_MS;
const request = (): LifecycleRequest => ({ restartId: randomUUID(), operation: "restart", oldInstance: owner,
  target: { immutableRuntimePath: join(env.home, "fixture-immutable-runtime.mjs"), version: "fixture", protocol: 1, fileManifestDigest: "a".repeat(64) } });
async function bootstrap() { journal = await LifecycleJournal.bootstrap(env.home, owner); return journal; }
const portable = process.platform !== "win32";

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
    expect(() => j.advance(input.restartId, 4, "release_committed", {}, deadline())).toThrow(LifecycleUnavailable);
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
      expect(j.lookup(input.restartId)).toBeNull();
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
    expect(rollbacks).toBe(autoRollback ? 0 : 1); expect(j.lookup(input.restartId)).toBeNull();
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
    expect(j.lookup(input.restartId)).toBeNull();
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
