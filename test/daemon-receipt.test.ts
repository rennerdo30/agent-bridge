import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleJournal, LifecycleUnavailable, LIFECYCLE_ADMISSION_MS, LIFECYCLE_PRE_RELEASE_MS,
  LIFECYCLE_PREPARE_MS, LIFECYCLE_DISPATCH_DRAIN_MS, LIFECYCLE_WRITE_CHECKPOINT_MS, LIFECYCLE_BIND_OBSERVE_MS,
  type LifecycleInstance, type LifecycleRequest } from "../src/core/daemon-lifecycle.js";
import { readProcessIdentity } from "../src/core/process-identity.js";
import { verifyWindowsLifecyclePaths, assertWindowsLifecyclePathProof, pendingWindowsLifecycleVerifications, WindowsLifecyclePathUnavailable } from "../src/core/lifecycle-windows.js";
import { createServingJournalFixture } from "./fixtures/daemon-serving-journal.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

type TimingBucket = "expired" | "0_25" | "26_100" | "101_500" | "501_1000" | "1001_plus" | "unavailable";
type AdmissionDiagnostic = { entry: TimingBucket; resolution: TimingBucket; wall: TimingBucket;
  result: "not_entered" | "resolved" | "rejected"; queryOnly: boolean; lineage: boolean; busyClamp: boolean; begin: boolean };
function timingBucket(value: number): TimingBucket {
  if (!Number.isFinite(value)) return "unavailable";
  if (value <= 0) return "expired";
  return value <= 25 ? "0_25" : value <= 100 ? "26_100" : value <= 500 ? "101_500" : value <= 1000 ? "501_1000" : "1001_plus";
}
const verificationFixture = vi.hoisted(() => ({
  before: undefined as ((home: string, phase: string, scope: string) => void) | undefined,
  rejected: undefined as ((error: unknown) => void) | undefined,
  diagnostic: undefined as AdmissionDiagnostic | undefined,
}));
vi.mock("../src/core/lifecycle-windows.js", async importOriginal => {
  const native = await importOriginal<typeof import("../src/core/lifecycle-windows.js")>();
  return { ...native, verifyWindowsLifecyclePaths: (...args: Parameters<typeof native.verifyWindowsLifecyclePaths>) => {
    verificationFixture.before?.(args[0], args[2], args[3]);
    const diagnostic = args[2] === "admission" && args[3] === "established" && verificationFixture.diagnostic?.result === "not_entered"
      ? verificationFixture.diagnostic : undefined;
    const started = performance.now();
    if (diagnostic) { diagnostic.entry = timingBucket(args[4] - started); diagnostic.result = "rejected"; }
    const completed = (result: "resolved" | "rejected") => {
      if (diagnostic) { const now = performance.now(); diagnostic.resolution = timingBucket(args[4] - now); diagnostic.wall = timingBucket(now - started); diagnostic.result = result; }
    };
    // Every proof is still produced/refused by the ORIGINAL native observer with
    // every original capability/deadline argument; no fixture-created permission.
    return native.verifyWindowsLifecyclePaths(...args).then(value => { completed("resolved"); return value; },
      error => { completed("rejected"); verificationFixture.rejected?.(error); throw error; });
  } };
});

let env: TestEnv, owner: LifecycleInstance, journal: LifecycleJournal | undefined, captured: DatabaseSync | undefined;
let journalHome: string, servingFixture: Awaited<ReturnType<typeof createServingJournalFixture>> | undefined;
const sqliteExec = DatabaseSync.prototype.exec;
const sqlitePrepare = DatabaseSync.prototype.prepare;
beforeEach(async () => {
  verificationFixture.before = undefined; verificationFixture.rejected = undefined; verificationFixture.diagnostic = undefined;
  env = makeEnv(); journal = undefined; captured = undefined; servingFixture = undefined; journalHome = env.home;
  const creationIdentity = await readProcessIdentity(process.pid); expect(creationIdentity).toBeTruthy();
  owner = { nonce: randomUUID(), pid: process.pid, creationIdentity: creationIdentity! };
  if (!portable) { servingFixture = await createServingJournalFixture(env); journalHome = servingFixture.home; owner = servingFixture.owner; }
});
afterEach(async () => {
  verificationFixture.before = undefined; verificationFixture.rejected = undefined; verificationFixture.diagnostic = undefined;
  vi.restoreAllMocks();
  // Only exact fixture-owned local SQL transactions/handles, never product work.
  if (captured?.isTransaction) sqliteExec.call(captured, "ROLLBACK");
  if (journal && !journal.close()) {
    // Explicit disposal is fixture teardown ONLY, not a production force-close
    // API or proof that an unknown lifecycle outcome was rolled back/settled.
    const actual = captured ?? Reflect.get(journal, "writer");
    expect(actual).toBeInstanceOf(DatabaseSync); actual.close();
  }
  await servingFixture?.close(); servingFixture = undefined;
  await until(() => pendingWindowsLifecycleVerifications() === 0); await env.cleanup();
});
const file = () => join(journalHome, ".core-lifecycle", "receipts.sqlite");
const deadline = () => performance.now() + LIFECYCLE_ADMISSION_MS;
const request = (): LifecycleRequest => ({ restartId: randomUUID(), operation: "restart", oldInstance: owner,
  target: { immutableRuntimePath: join(env.home, "fixture-immutable-runtime.mjs"), version: "fixture", protocol: 1, fileManifestDigest: "a".repeat(64) } });
async function bootstrap() {
  if (portable) journal = await LifecycleJournal.bootstrap(journalHome, owner);
  else { const end = performance.now() + LIFECYCLE_PREPARE_MS; journal = await LifecycleJournal.bootstrapServing(servingFixture!.broker.lifecycleServingCapability("prepare", end), end); }
  return journal;
}
const portable = process.platform !== "win32";
async function admit(j: LifecycleJournal, input: LifecycleRequest, end = deadline()) {
  return portable ? j.admit(input, end) : j.admitServing(servingFixture!.broker.lifecycleServingCapability("admission", end), input, end);
}
async function advance(j: LifecycleJournal, id: string, revision: number, state: Parameters<LifecycleJournal["advance"]>[2],
  fields: Parameters<LifecycleJournal["advance"]>[3], end = deadline()) {
  return portable ? j.advance(id, revision, state, fields, end) : j.advanceServing(servingFixture!.broker.lifecycleServingCapability("write", end), id, revision, state, fields, end);
}
async function lookup(j: LifecycleJournal, id: string) {
  const end = performance.now() + LIFECYCLE_PREPARE_MS;
  return portable ? j.lookup(id) : j.lookupServing(servingFixture!.broker.lifecycleServingCapability("prepare", end), id, end);
}
async function selected(j: LifecycleJournal) {
  const end = performance.now() + LIFECYCLE_PREPARE_MS;
  return portable ? j.selected() : j.selectedServing(servingFixture!.broker.lifecycleServingCapability("prepare", end), end);
}
async function preparedReader(j: LifecycleJournal, id: string) {
  const end = performance.now() + LIFECYCLE_PREPARE_MS;
  return portable ? j.preparedReader(id) : j.preparedReaderServing(servingFixture!.broker.lifecycleServingCapability("prepare", end), id, end);
}
function acceptedRequestDigest(input: LifecycleRequest): string {
  // The counterexample is valid JSON for a DIFFERENT accepted request, not an
  // invalid actor/schema. Canonicalize only these exact accepted request fields.
  const canonical = (value: unknown): unknown => value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => [key, canonical(item)])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(input))).digest("hex");
}
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
      await expect(LifecycleJournal.bootstrap(journalHome, owner)).rejects.toMatchObject({ reason: "publication_unproved" });
      expect(existsSync(join(journalHome, ".core-lifecycle"))).toBe(false);
    }
  });
  it("retains every committed revision and conflicting request while same-ID lost reply is idempotent", async () => {
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.includes("PRAGMA journal_mode=PERSIST")) captured = this;
      return sqliteExec.call(this, sql);
    });
    const began = performance.now(), j = await bootstrap(), input = request(), accepted = await admit(j, input, deadline());
    spy.mockRestore();
    expect(captured!.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("persist");
    expect(captured!.prepare("PRAGMA synchronous").get()?.synchronous).toBe(2);
    expect(captured!.prepare("PRAGMA journal_size_limit").get()?.journal_size_limit).toBe(-1);
    expect(await admit(j, input, deadline())).toEqual(accepted);
    const prepared = await advance(j, input.restartId, 1, "preparing", {}, deadline());
    expect(prepared.revision).toBe(2); expect(await admit(j, input, deadline())).toEqual(prepared);
    await expect(admit(j, { ...input, operation: "stop" }, deadline())).rejects.toThrow(LifecycleUnavailable);
    const db = new DatabaseSync(file(), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM receipt_revisions").get()?.n).toBe(2);
      expect(db.prepare("SELECT count(*) AS n FROM receipt_conflicts").get()?.n).toBe(1);
      expect(db.prepare("SELECT sqlite_version() AS version").get()?.version).toBeTruthy();
      process.stderr.write("AB325 receipt fixture measurements " + JSON.stringify({ platform: process.platform, node: process.version,
        sqlite: db.prepare("SELECT sqlite_version() AS version").get()?.version, bootstrapAndReceiptMs: Math.round(performance.now() - began),
        publication: portable ? "unix_directory_sync_and_committed_reopen" : "windows_owned_creation_assumptions_and_committed_reopen", restartAcceptance: false }) + "\n");
    } finally { db.close(); }
    if (portable) expect(lstatSync(file()).mode & 0o077).toBe(0);
    else {
      const end = performance.now() + LIFECYCLE_PREPARE_MS, cap = servingFixture!.broker.lifecycleServingCapability("prepare", end);
      const proof = await verifyWindowsLifecyclePaths(journalHome, owner.nonce, "prepare", "established", end, cap);
      assertWindowsLifecyclePathProof(proof, journalHome, owner.nonce, "prepare", "established");
      expect(proof.ownerInstance).toBe(owner.nonce); expect(proof.scope).toBe("established");
    }
    expect(existsSync(file() + "-journal")).toBe(true);
  });
  it("actual prepared reader rejects UPDATE and INSERT with strict readonly flags/query_only", async () => {
    const j = await bootstrap(), input = request(); await admit(j, input, deadline());
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
    const reader = await preparedReader(j, input.restartId);
    try { expect(reader.read().restartId).toBe(input.restartId); expect(checked).toBe(true); }
    finally { reader.close(); spy.mockRestore(); }
    expect((await lookup(j, input.restartId))?.revision).toBe(1);
  });
  it("old writer CAS rejects stale prepared acknowledgements and cannot cross release without checkpoint", async () => {
    const j = await bootstrap(), input = request(); await admit(j, input, deadline());
    const replacement = { ...owner, nonce: randomUUID() };
    await advance(j, input.restartId, 1, "preparing", { replacementInstance: replacement }, deadline());
    await expect(advance(j, input.restartId, 1, "preparing", { replacementInstance: replacement }, deadline())).rejects.toThrow(LifecycleUnavailable);
    await advance(j, input.restartId, 2, "draining", {}, deadline()); await advance(j, input.restartId, 3, "prepared", {}, deadline());
    await expect(advance(j, input.restartId, 4, "release_intent", {}, deadline())).rejects.toThrow(LifecycleUnavailable);
    const retained = await selected(j);
    expect(retained).toMatchObject({ currentActor: { kind: "old", instance: owner }, actorGeneration: 1 });
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    await expect(advance(j, input.restartId, 4, "release_intent", { checkpointManifest: {
      closureDigest: "a".repeat(64), owners: [] } }, deadline())).rejects.toThrow("owner_unsupported");
    expect(exec.mock.calls.some(([sql]) => sql === "BEGIN IMMEDIATE")).toBe(false);
    const forgedFields = { currentActor: { kind: "successor", instance: replacement } } as unknown as Parameters<typeof j.advance>[3];
    await expect(advance(j, input.restartId, 4, "unknown", forgedFields, deadline())).rejects.toThrow("revision_conflict");
    expect(await selected(j)).toEqual(retained);
    expect((await selected(j))?.state).toBe("prepared");
  });
  it.each(["id", "revision", "digest", "home", "sql_digest", "matching_digest"] as const)("retained %s envelope mismatch refuses lookup/selection/prepared read/advance without repair or BEGIN", async mismatch => {
    const j = await bootstrap(), input = request(), accepted = await admit(j, input, deadline());
    expect(await lookup(j, input.restartId)).toEqual(accepted); expect(await selected(j)).toEqual(accepted);
    const reader = await preparedReader(j, input.restartId), fixture = new DatabaseSync(file());
    try {
      fixture.exec("PRAGMA journal_mode=PERSIST; PRAGMA synchronous=FULL;");
      expect(reader.read()).toEqual(accepted);
      const corrupted = { ...accepted };
      if (mismatch === "id") {
        const otherRequest = { ...input, restartId: randomUUID() };
        corrupted.restartId = otherRequest.restartId; corrupted.requestDigest = acceptedRequestDigest(otherRequest);
      } else if (mismatch === "revision") corrupted.revision++;
      else if (mismatch === "digest" || mismatch === "matching_digest") corrupted.requestDigest = "b".repeat(64);
      else if (mismatch === "home") corrupted.homeIdentity = "c".repeat(64);
      fixture.prepare("UPDATE receipt_revisions SET json=?,request_digest=? WHERE restart_id=? AND revision=1")
        .run(JSON.stringify(corrupted), mismatch === "sql_digest" ? "d".repeat(64) : mismatch === "matching_digest" ? corrupted.requestDigest : accepted.requestDigest, input.restartId);
      const rows = () => fixture.prepare("SELECT restart_id,revision,request_digest,json FROM receipt_revisions ORDER BY revision").all();
      const selection = () => fixture.prepare("SELECT * FROM selected_receipt").all();
      const retainedRows = rows(), retainedSelection = selection(), retainedBytes = [readFileSync(file()), readFileSync(file() + "-journal")];
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      await expect(lookup(j, input.restartId)).rejects.toThrow("lineage_unknown"); await expect(selected(j)).rejects.toThrow("lineage_unknown");
      expect(() => reader.read()).toThrow("lineage_unknown");
      await expect(advance(j, input.restartId, 1, "preparing", {}, deadline())).rejects.toThrow("lineage_unknown");
      expect(exec.mock.calls.some(([sql]) => sql === "BEGIN IMMEDIATE")).toBe(false);
      expect(rows()).toEqual(retainedRows); expect(selection()).toEqual(retainedSelection);
      expect([readFileSync(file()), readFileSync(file() + "-journal")]).toEqual(retainedBytes);
    } finally { reader.close(); fixture.close(); }
  });
  it("a retained dangling selection refuses new-ID admission without overwriting its intent or accepted rows", async () => {
    const j = await bootstrap(), input = request(), missing = request();
    expect(await selected(j)).toBeNull(); expect(await lookup(j, missing.restartId)).toBeNull();
    const accepted = await admit(j, input, deadline()), reader = await preparedReader(j, input.restartId), fixture = new DatabaseSync(file());
    try {
      expect(reader.read()).toEqual(accepted);
      // Explicit OWNED retained-state fault only; the normal source writer has
      // foreign_keys=ON and cannot publish this dangling selection.
      fixture.exec("PRAGMA journal_mode=PERSIST; PRAGMA synchronous=FULL; PRAGMA foreign_keys=OFF;");
      fixture.prepare("UPDATE selected_receipt SET revision=2 WHERE singleton=1").run();
      const rows = () => fixture.prepare("SELECT * FROM receipt_revisions").all(), selection = () => fixture.prepare("SELECT * FROM selected_receipt").all();
      const retainedRows = rows(), retainedSelection = selection(), retainedBytes = [readFileSync(file()), readFileSync(file() + "-journal")];
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      expect(await lookup(j, input.restartId)).toEqual(accepted); expect(await lookup(j, missing.restartId)).toBeNull();
      await expect(selected(j)).rejects.toThrow("lineage_unknown"); expect(() => reader.read()).toThrow("lineage_unknown");
      await expect(admit(j, missing, deadline())).rejects.toThrow("lineage_unknown");
      expect(exec.mock.calls.some(([sql]) => sql === "BEGIN IMMEDIATE")).toBe(false);
      expect(rows()).toEqual(retainedRows); expect(selection()).toEqual(retainedSelection);
      expect([readFileSync(file()), readFileSync(file() + "-journal")]).toEqual(retainedBytes);
    } finally { reader.close(); fixture.close(); }
  });
  it("real COMMIT_BUSY is locally settled and quarantined, never replayed or visible as acceptance", async () => {
    const j = await bootstrap(), input = request(), blocker = new DatabaseSync(file(), { readOnly: true });
    blocker.exec("BEGIN"); blocker.prepare("SELECT json FROM lifecycle_lineage").get();
    let commits = 0, begins = 0;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") { begins++; captured = this; }
      if (sql === "COMMIT") commits++;
      return sqliteExec.call(this, sql);
    });
    try {
      await expect(admit(j, input, deadline())).rejects.toThrow(LifecycleUnavailable);
      expect(j.isQuarantined).toBe(true); expect(captured?.isTransaction).toBe(false); expect(commits).toBe(1);
      publicQuarantineRefuses(j, input.restartId); expect(committedFixtureRows()).toHaveLength(0);
      await expect(admit(j, input, deadline())).rejects.toThrow(LifecycleUnavailable); expect(begins).toBe(1);
    } finally { spy.mockRestore(); blocker.exec("ROLLBACK"); blocker.close(); }
  });
  it.each([false, true])("injected IOERR/FULL active versus auto-rollback quarantine (autoRollback=%s)", async autoRollback => {
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
    await expect(admit(j, input, deadline())).rejects.toThrow(LifecycleUnavailable);
    expect(j.isQuarantined).toBe(true); expect(captured?.isTransaction).toBe(false);
    expect(rollbacks).toBe(autoRollback ? 0 : 1); publicQuarantineRefuses(j, input.restartId); expect(committedFixtureRows()).toHaveLength(0);
  });
  it("failed ROLLBACK retains unknown transaction/lock without forced close or tentative receipt reads", async () => {
    const j = await bootstrap(), input = request();
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") captured = this;
      if (sql === "COMMIT" || sql === "ROLLBACK") throw new Error("fixture unsettled transaction");
      return sqliteExec.call(this, sql);
    });
    await expect(admit(j, input, deadline())).rejects.toThrow(LifecycleUnavailable);
    expect(captured?.isTransaction).toBe(true); expect(j.isQuarantined).toBe(true); expect(j.close()).toBe(false);
    expect(captured!.prepare("SELECT count(*) AS n FROM receipt_revisions").get()?.n).toBe(1);
    publicQuarantineRefuses(j, input.restartId); expect(committedFixtureRows()).toHaveLength(0);
  });
  it("unknown transaction-state API quarantines before BEGIN and cannot authorize close", async () => {
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.includes("PRAGMA journal_mode=PERSIST")) captured = this;
      return sqliteExec.call(this, sql);
    });
    const j = await bootstrap(); spy.mockRestore();
    const input = request(), retained = await admit(j, input, deadline());
    // Native isTransaction is nonconfigurable. Inject ONLY the unavailable
    // observation at this private fixture boundary; keep real SQLite methods.
    const actual = captured!;
    expect(Reflect.set(j, "writer", { isTransaction: undefined, exec: actual.exec.bind(actual), prepare: actual.prepare.bind(actual) })).toBe(true);
    try {
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const reads = vi.spyOn(DatabaseSync.prototype, "prepare");
      await expect(advance(j, input.restartId, 1, "preparing", {}, deadline())).rejects.toThrow(LifecycleUnavailable);
      expect(j.isQuarantined).toBe(true); expect(j.close()).toBe(false);
      expect(exec.mock.calls.some(([sql]) => sql === "BEGIN IMMEDIATE")).toBe(false);
      publicQuarantineRefuses(j, input.restartId);
      expect(JSON.parse(String(committedFixtureRows()[0]!.json))).toEqual(retained);
      expect(reads.mock.contexts.some(context => context === actual)).toBe(false);
    } finally { Reflect.set(j, "writer", actual); }
  });
  it("SIMULATED error after actual COMMIT retains committed bytes but quarantined public APIs cannot claim readiness or close", async () => {
    const j = await bootstrap(), input = request();
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") captured = this;
      const result = sqliteExec.call(this, sql);
      if (sql === "COMMIT") throw Object.assign(new Error("SIMULATED error after real COMMIT"), { errcode: 10 });
      return result;
    });
    await expect(admit(j, input, deadline())).rejects.toThrow(LifecycleUnavailable);
    expect(captured!.isTransaction).toBe(false); expect(j.isQuarantined).toBe(true);
    const before = readFileSync(file()), rows = committedFixtureRows(); expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]!.json))).toMatchObject({ restartId: input.restartId, state: "accepted", revision: 1 });
    publicQuarantineRefuses(j, input.restartId);
    expect(readFileSync(file())).toEqual(before); expect(committedFixtureRows()).toEqual(rows);
  });
  it("actual crash hot journal cannot be repaired or reopened through quarantined public APIs", async () => {
    const j = await bootstrap(), input = request();
    const fault = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") captured = this;
      const result = sqliteExec.call(this, sql);
      if (sql === "COMMIT") throw new Error("SIMULATED error after real COMMIT");
      return result;
    });
    await expect(admit(j, input, deadline())).rejects.toThrow(LifecycleUnavailable); fault.mockRestore();
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
  it("missing established journal is unknown, not repaired/recreated or treated as fresh home", async () => {
    const j = await bootstrap(), input = request();
    if (portable) await admit(j, input, deadline());
    else {
      // One bounded record for the original initial admission. No IDs, paths,
      // SQL text, absolute timestamps or alleged native helper timing are emitted.
      const diagnostic: AdmissionDiagnostic = { entry: "unavailable", resolution: "unavailable", wall: "unavailable", result: "not_entered",
        queryOnly: false, lineage: false, busyClamp: false, begin: false };
      verificationFixture.diagnostic = diagnostic;
      const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
        if (sql === "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;") diagnostic.queryOnly = true;
        if (/^PRAGMA busy_timeout=\d+$/.test(sql)) diagnostic.busyClamp = true;
        if (sql === "BEGIN IMMEDIATE") diagnostic.begin = true;
        return sqliteExec.call(this, sql);
      });
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
        if (sql === "SELECT json FROM lifecycle_lineage WHERE singleton=1") diagnostic.lineage = true;
        return sqlitePrepare.call(this, sql);
      });
      try { await admit(j, input, deadline()); }
      finally {
        verificationFixture.diagnostic = undefined; exec.mockRestore(); prepare.mockRestore();
        console.info("receipt admission diagnostic", JSON.stringify({ phase: "admission", remaining_at_verifier_entry: diagnostic.entry,
          remaining_at_verifier_resolution: diagnostic.resolution, verifier_call_wall: diagnostic.wall, verifier_result: diagnostic.result,
          real_query_only: diagnostic.queryOnly, real_lineage: diagnostic.lineage, real_busy_clamp: diagnostic.busyClamp,
          begin_entered: diagnostic.begin }));
      }
    }
    expect((await lookup(j, input.restartId))?.state).toBe("accepted"); expect((await selected(j))?.restartId).toBe(input.restartId);
    const beforeRows = committedFixtureRows();
    let before = readFileSync(file()), beforeJournal = readFileSync(file() + "-journal");
    const exec = vi.spyOn(DatabaseSync.prototype, "exec");
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    if (portable) renameSync(file() + "-journal", file() + "-fixture-retained-journal");
    else {
      let entered = false, originalMissingRefusal = false;
      verificationFixture.before = (observedHome, phase, scope) => {
        if (observedHome !== journalHome || phase !== "admission" || scope !== "established") return;
        verificationFixture.before = undefined; entered = true;
        // This source boundary follows the actual live writer transaction check.
        // Close the exact owned autocommit handle before Windows' real rename;
        // no reopened writer or fake isTransaction/path result is supplied.
        expect((Reflect.get(j, "writer") as DatabaseSync).isTransaction).toBe(false);
        expect(j.close()).toBe(true); journal = undefined;
        before = readFileSync(file()); beforeJournal = readFileSync(file() + "-journal");
        renameSync(file() + "-journal", file() + "-fixture-retained-journal");
        verificationFixture.rejected = error => {
          expect(error).toBeInstanceOf(WindowsLifecyclePathUnavailable);
          expect((error as WindowsLifecyclePathUnavailable).reason).toBe("unsafe_path");
          originalMissingRefusal = true;
        };
      };
      await expect(admit(j, input, deadline())).rejects.toThrow(LifecycleUnavailable);
      verificationFixture.before = undefined; verificationFixture.rejected = undefined;
      expect(entered).toBe(true); expect(originalMissingRefusal).toBe(true);
    }
    await expect(lookup(j, input.restartId)).rejects.toThrow(LifecycleUnavailable);
    await expect(selected(j)).rejects.toThrow(LifecycleUnavailable);
    if (portable) await expect(admit(j, input, deadline())).rejects.toThrow(LifecycleUnavailable);
    expect(exec.mock.calls.some(([sql]) => sql === "BEGIN IMMEDIATE" || sql === "COMMIT")).toBe(false);
    expect(prepare.mock.calls.some(([sql]) => /^INSERT\b/.test(sql))).toBe(false);
    expect(existsSync(file() + "-journal")).toBe(false); expect(readFileSync(file()).equals(before)).toBe(true);
    if (portable) await expect(LifecycleJournal.bootstrap(journalHome, owner)).rejects.toMatchObject({ reason: "lineage_unknown" });
    else {
      await expect(LifecycleJournal.bootstrap(journalHome, owner)).rejects.toMatchObject({ reason: "publication_unproved" });
      const end = performance.now() + LIFECYCLE_PREPARE_MS;
      await expect(LifecycleJournal.bootstrapServing(servingFixture!.broker.lifecycleServingCapability("prepare", end), end))
        .rejects.toMatchObject({ reason: "publication_unproved" });
    }
    expect(existsSync(file() + "-journal")).toBe(false); expect(readFileSync(file())).toEqual(before);
    expect(committedFixtureRows()).toEqual(beforeRows); expect(readFileSync(file() + "-fixture-retained-journal")).toEqual(beforeJournal);
    renameSync(file() + "-fixture-retained-journal", file() + "-journal");
    expect((await lookup(j, input.restartId))?.state).toBe("accepted");
  });
});
