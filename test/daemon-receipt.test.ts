import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleJournal, LifecycleUnavailable, observeLifecycleWriteOutcome, LIFECYCLE_ADMISSION_MS, LIFECYCLE_PRE_RELEASE_MS,
  LIFECYCLE_PREPARE_MS, LIFECYCLE_DISPATCH_DRAIN_MS, LIFECYCLE_WRITE_CHECKPOINT_MS, LIFECYCLE_BIND_OBSERVE_MS,
  type LifecycleInstance, type LifecycleRequest } from "../src/core/daemon-lifecycle.js";
import { readProcessIdentity } from "../src/core/process-identity.js";
import { verifyWindowsLifecyclePaths, assertWindowsLifecyclePathProof, pendingWindowsLifecycleVerifications, WindowsLifecyclePathUnavailable } from "../src/core/lifecycle-windows.js";
import { createServingJournalFixture } from "./fixtures/daemon-serving-journal.js";
import { settledOwnedHomes, startOwnedHomeHelper, stopOwnedHomeHelper } from "./fixtures/owned-home.js";
import { makeEnv, until, type TestEnv } from "./helpers.js";

type TimingBucket = "expired" | "0_25" | "26_100" | "101_500" | "501_1000" | "1001_plus" | "unavailable";
type AdmissionDiagnostic = { entry: TimingBucket; resolution: TimingBucket; wall: TimingBucket;
  result: "not_entered" | "resolved" | "rejected"; queryOnly: boolean; lineage: boolean; busyClamp: boolean; begin: boolean };
function timingBucket(value: number): TimingBucket {
  if (!Number.isFinite(value)) return "unavailable";
  if (value <= 0) return "expired";
  return value <= 25 ? "0_25" : value <= 100 ? "26_100" : value <= 500 ? "101_500" : value <= 1000 ? "501_1000" : "1001_plus";
}
const RECEIPT_DIAGNOSTIC_RECORD_LIMIT = 16, RECEIPT_DIAGNOSTIC_COUNT_LIMIT = 65535;
const mismatchCases = ["id", "revision", "digest", "home", "sql_digest", "matching_digest"] as const;
type MismatchCase = typeof mismatchCases[number];
const initialAdmissionCases = [...mismatchCases, "missing_journal_initial"] as const;
type InitialAdmissionCase = typeof initialAdmissionCases[number];
type ObservedOperation = "verifier" | "begin" | "commit" | "rollback";
type CallDisposition = "entered" | "returned" | "threw" | "resolved" | "rejected";
type AdmissionReason = "budget" | "writer_unknown" | "lineage_unknown" | "publication_unproved" |
  "unsafe_path" | "unsafe_acl" | "unsupported_fs" | "unavailable" | "other";
type CallObservation = { operation: ObservedOperation; disposition: CallDisposition;
  entry: TimingBucket; resolution: TimingBucket; wall: TimingBucket };
type InitialAdmissionTrace = { mismatch: InitialAdmissionCase; writer?: DatabaseSync; end?: number;
  outcome: "unavailable" | "resolved" | "rejected"; reason: AdmissionReason;
  count: number; overflow: boolean; records: CallObservation[] };
let initialAdmissionTrace: InitialAdmissionTrace | undefined;
type OperationSummary = "unavailable" | "not_entered" | CallDisposition;
type PublishedAdmissionTrace = Omit<InitialAdmissionTrace, "writer" | "end"> & {
  begin: OperationSummary; commit: OperationSummary; rollback: OperationSummary; verifier: OperationSummary };
const completedAdmissionTraces: PublishedAdmissionTrace[] = [];
// These are JS call observations only. In particular COMMIT returning does not
// prove autocommit, durability, an accepted receipt, or lifecycle permission.
function observeCall(trace: InitialAdmissionTrace, operation: ObservedOperation): CallObservation | undefined {
  try {
    trace.count = Math.min(RECEIPT_DIAGNOSTIC_COUNT_LIMIT, trace.count + 1);
    if (trace.records.length >= RECEIPT_DIAGNOSTIC_RECORD_LIMIT) { trace.overflow = true; return; }
    const record: CallObservation = { operation, disposition: "entered", entry: timingBucket(trace.end! - diagnosticNow()),
      resolution: "unavailable", wall: "unavailable" };
    trace.records.push(record); return record;
  } catch { trace.overflow = true; return; } // Lost diagnostic evidence never proves no entry.
}
function diagnosticNow(): number { try { return performance.now(); } catch { return NaN; } }
function completeCall(trace: InitialAdmissionTrace, record: CallObservation | undefined, started: number, disposition: CallDisposition): void {
  if (!record) return;
  try {
    const now = diagnosticNow(); record.disposition = disposition;
    record.resolution = timingBucket(trace.end! - now); record.wall = timingBucket(now - started);
  } catch { /* Diagnostic completion never replaces the native value/error. */ }
}
function diagnosticReason(error: unknown): AdmissionReason {
  try {
    if (!(error instanceof LifecycleUnavailable) && !(error instanceof WindowsLifecyclePathUnavailable)) return "unavailable";
    const reason: unknown = error.reason;
    return typeof reason === "string" && ["budget", "writer_unknown", "lineage_unknown", "publication_unproved",
      "unsafe_path", "unsafe_acl", "unsupported_fs"].includes(reason) ? reason as AdmissionReason : "other";
  } catch { return "unavailable"; }
}
function publishInitialAdmissionTrace(): void {
  const trace = initialAdmissionTrace; initialAdmissionTrace = undefined;
  if (!trace) return;
  // Publication follows the original owned teardown, never the timed admission.
  // Missing opt-in metadata/directory or any diagnostic failure changes nothing.
  try {
    const sourceHead = process.env.SOURCE_HEAD, runId = process.env.GITHUB_RUN_ID, runAttempt = process.env.GITHUB_RUN_ATTEMPT;
    if (process.env.GITHUB_ACTIONS !== "true" || typeof sourceHead !== "string" || !/^[a-f0-9]{40}$/.test(sourceHead) ||
      typeof runId !== "string" || !/^\d{1,20}$/.test(runId) || typeof runAttempt !== "string" || !/^\d{1,6}$/.test(runAttempt)) return;
    const buckets = ["expired", "0_25", "26_100", "101_500", "501_1000", "1001_plus", "unavailable"];
    if (typeof trace.mismatch !== "string" || !initialAdmissionCases.includes(trace.mismatch) ||
      typeof trace.outcome !== "string" || !["unavailable", "resolved", "rejected"].includes(trace.outcome) ||
      typeof trace.reason !== "string" || !["budget", "writer_unknown", "lineage_unknown", "publication_unproved",
        "unsafe_path", "unsafe_acl", "unsupported_fs", "unavailable", "other"].includes(trace.reason) ||
      typeof trace.overflow !== "boolean" || typeof trace.count !== "number" || !Number.isSafeInteger(trace.count) ||
      trace.count < 0 || trace.count > RECEIPT_DIAGNOSTIC_COUNT_LIMIT || !Array.isArray(trace.records) || trace.records.length > RECEIPT_DIAGNOSTIC_RECORD_LIMIT) return;
    const records = trace.records.map(record => {
      if (typeof record.operation !== "string" || !["verifier", "begin", "commit", "rollback"].includes(record.operation) ||
        typeof record.disposition !== "string" || !["entered", "returned", "threw", "resolved", "rejected"].includes(record.disposition) ||
        typeof record.entry !== "string" || !buckets.includes(record.entry) || typeof record.resolution !== "string" || !buckets.includes(record.resolution) ||
        typeof record.wall !== "string" || !buckets.includes(record.wall)) throw new Error("Unavailable fixture diagnostic");
      if (record.operation === "verifier" ? ["returned"].includes(record.disposition) : ["resolved", "rejected"].includes(record.disposition))
        throw new Error("Unavailable fixture diagnostic");
      return { operation: record.operation, disposition: record.disposition, entry: record.entry, resolution: record.resolution, wall: record.wall };
    });
    if (completedAdmissionTraces.length >= RECEIPT_DIAGNOSTIC_RECORD_LIMIT) return;
    const disposition = (operation: ObservedOperation): OperationSummary => records.findLast(record => record.operation === operation)?.disposition ??
      (trace.overflow || trace.end === undefined || (operation === "verifier" ? portable : !trace.writer) ? "unavailable" : "not_entered");
    completedAdmissionTraces.push({ mismatch: trace.mismatch, outcome: trace.outcome, reason: trace.reason,
      count: trace.count, overflow: trace.overflow, records,
      begin: disposition("begin"), commit: disposition("commit"), rollback: disposition("rollback"), verifier: disposition("verifier") });
    const out = join(process.cwd(), ".agent-bridge-test", "ab325-artifact"), directory = lstatSync(out);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return;
    const destination = join(out, "receipt-admission-diagnostics.json");
    if (existsSync(destination)) {
      const previous = lstatSync(destination); if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1) return;
    }
    writeFileSync(destination, JSON.stringify({ schema: 1, sourceHead, runId, runAttempt,
      fixture: "receipt_initial_envelope_admission", recordLimit: RECEIPT_DIAGNOSTIC_RECORD_LIMIT,
      countLimit: RECEIPT_DIAGNOSTIC_COUNT_LIMIT, observations: completedAdmissionTraces }) + "\n");
  } catch { /* Only passive diagnostic output failures are swallowed. */ }
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
    const trace = initialAdmissionTrace;
    const observed = trace && args[0] === journalHome && args[2] === "admission" && args[3] === "established" && args[4] === trace.end
      ? observeCall(trace, "verifier") : undefined;
    if (diagnostic) { diagnostic.entry = timingBucket(args[4] - started); diagnostic.result = "rejected"; }
    const completed = (result: "resolved" | "rejected") => {
      if (trace && observed) completeCall(trace, observed, started, result);
      if (diagnostic) { const now = performance.now(); diagnostic.resolution = timingBucket(args[4] - now); diagnostic.wall = timingBucket(now - started); diagnostic.result = result; }
    };
    // Every proof is still produced/refused by the ORIGINAL native observer with
    // every original capability/deadline argument; no fixture-created permission.
    let invocation: ReturnType<typeof native.verifyWindowsLifecyclePaths>;
    try { invocation = native.verifyWindowsLifecyclePaths(...args); }
    catch (error) { if (trace && observed) completeCall(trace, observed, started, "threw"); throw error; }
    return invocation.then(value => { completed("resolved"); return value; },
      error => { completed("rejected"); verificationFixture.rejected?.(error); throw error; });
  }, cachedWindowsLifecyclePathProof: (...args: Parameters<typeof native.cachedWindowsLifecyclePathProof>) => {
    // Same observation hooks for the cached (no-helper) phase check. The proof or
    // refusal is still produced ONLY by the ORIGINAL source check with its arguments.
    verificationFixture.before?.(args[0], args[2], args[3]);
    const diagnostic = args[2] === "admission" && args[3] === "established" && verificationFixture.diagnostic?.result === "not_entered"
      ? verificationFixture.diagnostic : undefined;
    const started = performance.now(), trace = initialAdmissionTrace;
    const observed = trace && args[0] === journalHome && args[2] === "admission" && args[3] === "established" && args[4] === trace.end
      ? observeCall(trace, "verifier") : undefined;
    if (diagnostic) { diagnostic.entry = timingBucket(args[4] - started); diagnostic.result = "rejected"; }
    const completed = (result: "resolved" | "rejected") => {
      if (trace && observed) completeCall(trace, observed, started, result);
      if (diagnostic) { const now = performance.now(); diagnostic.resolution = timingBucket(args[4] - now); diagnostic.wall = timingBucket(now - started); diagnostic.result = result; }
    };
    try { const proof = native.cachedWindowsLifecyclePathProof(...args); completed("resolved"); return proof; }
    catch (error) { completed("rejected"); verificationFixture.rejected?.(error); throw error; }
  } };
});

let env: TestEnv, owner: LifecycleInstance, journal: LifecycleJournal | undefined, captured: DatabaseSync | undefined;
let journalHome: string, servingFixture: Awaited<ReturnType<typeof createServingJournalFixture>> | undefined;
const sqliteExec = DatabaseSync.prototype.exec;
const sqlitePrepare = DatabaseSync.prototype.prepare;
// The owned-home helper's powershell.exe cold start is setup before the tests, not per-test fixture time.
beforeAll(async () => { if (process.platform === "win32") await startOwnedHomeHelper(); });
afterAll(async () => { if (process.platform === "win32") await stopOwnedHomeHelper(); });
beforeEach(async () => {
  initialAdmissionTrace = undefined;
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
  // A HOME observer timeout is not the helper's answer or permission to remove its home.
  if (process.platform === "win32") await settledOwnedHomes();
  await until(() => pendingWindowsLifecycleVerifications() === 0); await env.cleanup();
  publishInitialAdmissionTrace();
});
const file = () => join(journalHome, ".core-lifecycle", "receipts.sqlite");

// SIMULATED elapsed time only; every SQLite call is native. These semantic
// cases retain their original phase deadlines through beforeDeadline below.
function simulateReceiptStall(stage: "BEGIN IMMEDIATE" | "COMMIT") {
  let elapsed = 0;
  const now = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => now() + elapsed);
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    const value = sqliteExec.call(this, sql);
    if (sql === stage) elapsed += LIFECYCLE_ADMISSION_MS + 1;
    return value;
  });
}

const deadline = () => performance.now() + LIFECYCLE_ADMISSION_MS;
const request = (): LifecycleRequest => ({ restartId: randomUUID(), operation: "restart", oldInstance: owner,
  target: { immutableRuntimePath: join(env.home, "fixture-immutable-runtime.mjs"), version: "fixture", protocol: 1, fileManifestDigest: "a".repeat(64) } });
async function bootstrap() {
  if (portable) journal = await LifecycleJournal.bootstrap(journalHome, owner);
  else {
    // Own-identity and HOME ACL helpers run in the setup step, outside the timed bootstrap.
    const prepareEnd = performance.now() + LIFECYCLE_PREPARE_MS;
    const preparation = await LifecycleJournal.prepareServingBootstrap(servingFixture!.broker.lifecycleServingCapability("prepare", prepareEnd), prepareEnd);
    const end = performance.now() + LIFECYCLE_PREPARE_MS;
    journal = await LifecycleJournal.bootstrapServing(servingFixture!.broker.lifecycleServingCapability("prepare", end), end, preparation);
  }
  return journal;
}
const portable = process.platform !== "win32";
async function admit(j: LifecycleJournal, input: LifecycleRequest, end = deadline()) {
  return portable ? j.admit(input, end) : j.admitServing(servingFixture!.broker.lifecycleServingCapability("admission", end), input, end);
}
async function observeInitialAdmission(mismatch: MismatchCase) {
  const trace: InitialAdmissionTrace = { mismatch, outcome: "unavailable", reason: "unavailable", count: 0, overflow: false, records: [] };
  initialAdmissionTrace = trace;
  const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    // Same existing source-owned bootstrap receiver capture used elsewhere in
    // this fixture. No writer getter, SQL/read probe, or supplied ownership flag.
    if (sql.includes("PRAGMA journal_mode=PERSIST") && trace.end === undefined) trace.writer = this;
    const operation = sql === "BEGIN IMMEDIATE" ? "begin" : sql === "COMMIT" ? "commit" : sql === "ROLLBACK" ? "rollback" : undefined;
    const record = this === trace.writer && trace.end !== undefined && operation ? observeCall(trace, operation) : undefined;
    const started = record ? diagnosticNow() : 0;
    try {
      const value = sqliteExec.call(this, sql);
      if (record) completeCall(trace, record, started, "returned");
      return value;
    } catch (error) { if (record) completeCall(trace, record, started, "threw"); throw error; }
  });
  try {
    const j = await bootstrap(), input = request(), end = deadline();
    trace.end = end; // The original deadline is evaluated exactly once, here.
    try {
      const accepted = await admit(j, input, end); trace.outcome = "resolved";
      return { j, input, accepted };
    } catch (error) { trace.outcome = "rejected"; trace.reason = diagnosticReason(error); throw error; }
  } finally { exec.mockRestore(); }
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

// Supplemental Package1 fixtures: real SQLite calls, SIMULATED clock/fault
// boundaries only. These observers cannot grant publication or reconciliation.
async function capturedOutcomeJournal() {
  const capture = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql.includes("PRAGMA journal_mode=PERSIST")) captured = this;
    return sqliteExec.call(this, sql);
  });
  try { return await bootstrap(); } finally { capture.mockRestore(); }
}
async function captureRefusal(action: () => unknown | Promise<unknown>): Promise<unknown> {
  try { await action(); } catch (error) { return error; }
  throw new Error("Expected the original operation to refuse");
}
// Real-time insulation for operations whose subject is NOT the phase budget: the
// clock stays strictly before the operation's ORIGINAL deadline, so a real SQLite
// fsync or scheduler stall on a loaded runner cannot expire the phase. Every source
// guard, proof and capability still receives that original deadline; budget
// refusals keep their own SIMULATED-boundary tests (outcomeFault).
async function beforeDeadline<T>(end: number, action: (end: number) => Promise<T>): Promise<T> {
  // Preserve a supplied slow-dependency clock as well as the native clock.
  const previous = vi.isMockFunction(performance.now) ? vi.mocked(performance.now).getMockImplementation() : undefined;
  const realNow = previous ?? performance.now.bind(performance);
  const clock = vi.spyOn(performance, "now").mockImplementation(() => Math.min(realNow(), end - 1));
  try { return await action(end); } finally { if (previous) clock.mockImplementation(previous); else clock.mockRestore(); }
}
// Failure diagnostic only: names the source-associated write outcome (stage/cause).
function withWriteOutcome(error: unknown): unknown {
  const outcome = observeLifecycleWriteOutcome(error);
  if (outcome && error instanceof Error) error.message += ` Write outcome: ${JSON.stringify(outcome)}`;
  return error;
}
type OutcomeFault = "late_commit" | "before_commit" | "reader" | "reader_expiry" | "reader_close" |
  "reader_preflight" | "reader_init" | "reader_prepare" | "reader_native_expiry" | "reader_init_close" |
  "wrapper_throw" | "conflict_throw" | "last_guard" | "reader_chain";
type VerificationQuery = "lineage" | "receipt_id" | "receipt_selected" | "conflict";
type VerificationBoundary = "prepare_expiry" | "get_expiry" | "get_native_expiry" | "get_close_expiry";
function outcomeFault(writer: DatabaseSync, end: number, fault: OutcomeFault, finalClockRead = 1,
  verification?: { query: VerificationQuery; boundary: VerificationBoundary }) {
  const realNow = performance.now.bind(performance), originalClose = DatabaseSync.prototype.close;
  let expired = false, committed = false, lastReader: DatabaseSync | undefined, arm = false, clockReads = 0;
  let retainedReadonly: DatabaseSync | undefined;
  const counts = { begins: 0, commits: 0, returnedCommits: 0, lateSql: 0 };
  const readerCalls = { initialized: 0, closed: 0, queryOnlyPrepared: 0, queryOnlyGets: 0, gets: 0, lateGets: 0 };
  const readers = new Set<DatabaseSync>();
  const queryCalls = { lineage: { prepared: 0, gets: 0, returned: 0 }, receipt_id: { prepared: 0, gets: 0, returned: 0 },
    receipt_selected: { prepared: 0, gets: 0, returned: 0 }, conflict: { prepared: 0, gets: 0, returned: 0 } };
  let targetReader: DatabaseSync | undefined;
  let postCommitClockReads = 0;
  const expire = () => { expired = true; };
  const clock = vi.spyOn(performance, "now").mockImplementation(() => {
    if (arm && ++clockReads >= finalClockRead) expire();
    // Pinned source ordering after ORIGINAL COMMIT: Windows' post-write guard
    // has four clock reads, then both platforms have two autocommit checks.
    // Expire at the first reader guard, not a prior transaction/phase guard.
    if (committed && fault === "reader_preflight" && ++postCommitClockReads >= (portable ? 3 : 7)) expire();
    // Until the SIMULATED boundary fires, the phase clock stays strictly before the
    // original deadline: real SQLite/fsync time on a loaded runner can no longer
    // expire the phase first, so the simulated boundary is the only reachable expiry.
    return expired ? Math.max(realNow(), end + 1) : Math.min(realNow(), end - 1);
  });
  const runs: Array<() => void> = [];
  const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (expired) counts.lateSql++;
    if (this === writer && sql === "BEGIN IMMEDIATE") counts.begins++;
    if (this === writer && sql === "COMMIT") counts.commits++;
    const value = sqliteExec.call(this, sql);
    if (this === writer && sql === "COMMIT") {
      committed = true; counts.returnedCommits++;
      if (fault === "late_commit") expire();
      if (fault === "wrapper_throw") throw new Error("SIMULATED wrapper error after ORIGINAL COMMIT");
      if (fault === "conflict_throw") throw new LifecycleUnavailable("revision_conflict");
    }
    if (committed && this !== writer && sql === "PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;") {
      readers.add(this); readerCalls.initialized++;
      if (["reader_init", "reader_native_expiry", "reader_init_close"].includes(fault)) expire();
      // SIMULATED budget-shaped native-boundary exception, not thrown by guard.
      if (fault === "reader_native_expiry") throw new LifecycleUnavailable("budget");
    }
    return value;
  });
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
    if (expired) counts.lateSql++;
    const statement = sqlitePrepare.call(this, sql);
    if (committed && this !== writer && fault === "reader" && sql === "SELECT json FROM lifecycle_lineage WHERE singleton=1") {
      throw new Error("SIMULATED independent reader error after ORIGINAL prepare");
    }
    if (committed && this !== writer) {
      const query: VerificationQuery | undefined = sql === "SELECT json FROM lifecycle_lineage WHERE singleton=1" ? "lineage"
        : sql.startsWith("SELECT r.json,l.json AS lineage,") ? (sql.includes("s.restart_id AS selected_id") ? "receipt_selected" : "receipt_id")
        : sql === "SELECT 1 FROM receipt_conflicts WHERE restart_id=? AND observed_digest=? AND json=?" ? "conflict" : undefined;
      if (query) queryCalls[query].prepared++;
      const target = query !== undefined && verification?.query === query;
      if (target) targetReader = this; // Actual returned statement's native DB receiver only.
      const get = statement.get;
      const pending = vi.spyOn(statement, "get").mockImplementation(function(this: typeof statement, ...args: unknown[]) {
        readerCalls.gets++; if (sql === "PRAGMA query_only") readerCalls.queryOnlyGets++;
        if (query) queryCalls[query].gets++;
        if (expired) { counts.lateSql++; readerCalls.lateGets++; }
        const value = Reflect.apply(get, this, args);
        if (query) queryCalls[query].returned++;
        if (target && verification!.boundary !== "prepare_expiry") {
          expire(); // Only AFTER ORIGINAL receipt/lineage/conflict SELECT.get returned.
          if (verification!.boundary === "get_native_expiry") throw new LifecycleUnavailable("budget"); // SIMULATED native-boundary error, not guard provenance.
        }
        if (fault === "reader_expiry" && sql === "SELECT json FROM lifecycle_lineage WHERE singleton=1") expire();
        return value;
      });
      runs.push(() => pending.mockRestore());
      if (target && verification!.boundary === "prepare_expiry") expire(); // Only AFTER ORIGINAL prepare returned.
      if (sql === "PRAGMA query_only") {
        readerCalls.queryOnlyPrepared++;
        if (fault === "reader_prepare") expire(); // Only AFTER ORIGINAL prepare returned.
      }
    }
    if (committed && this !== writer && sql.includes("s.restart_id AS selected_id")) lastReader = this;
    if (this === writer && fault === "before_commit" && sql.startsWith("INSERT INTO selected_receipt")) {
      const run = statement.run;
      const pending = vi.spyOn(statement, "run").mockImplementation(function(this: typeof statement, ...args: unknown[]) {
        const value = Reflect.apply(run, this, args); expire(); return value;
      });
      runs.push(() => pending.mockRestore());
    }
    return statement;
  });
  const close = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function(this: DatabaseSync) {
    if (committed && this !== writer && (["reader_close", "reader_init_close"].includes(fault) ||
        (this === targetReader && verification?.boundary === "get_close_expiry")) && !retainedReadonly) {
      retainedReadonly = this; // Exact actual source readonly receiver, before the SIMULATED close error.
      throw new Error("SIMULATED unconfirmed readonly disposal after ORIGINAL COMMIT");
    }
    const value = originalClose.call(this);
    if (readers.has(this)) readerCalls.closed++;
    // The real selected snapshot and real readonly disposal precede this switch.
    if (this === lastReader && fault === "last_guard") arm = true;
    return value;
  });
  return { counts, readerCalls, queryCalls, get retainedReadonly() { return retainedReadonly !== undefined; },
    disposeReadonlyFixture() {
      if (!retainedReadonly) return;
      // Fixture-owned exact receiver only. Clear only after the actual native close
      // returns; this does not acknowledge the product's unknown disposal record.
      originalClose.call(retainedReadonly); retainedReadonly = undefined;
    },
    restore() { for (const restore of runs) restore(); close.mockRestore(); prepare.mockRestore(); exec.mockRestore(); clock.mockRestore(); } };
}
async function verificationRefusal(query: VerificationQuery, boundary: VerificationBoundary) {
  const j = await capturedOutcomeJournal(), input = request();
  if (query === "conflict") await admit(j, input, deadline()); // Separate original accepted operation, before fault capture.
  const end = deadline(), fault = outcomeFault(captured!, end, "reader_chain", 1, { query, boundary });
  let error: unknown, unexpected: unknown, retained = false;
  try { error = await captureRefusal(() => admit(j, query === "conflict" ? { ...input, operation: "stop" } : input, end)); }
  catch (failure) { unexpected = failure; }
  finally {
    retained = fault.retainedReadonly; fault.restore(); // Before any oracle/fixture disposal.
    try { fault.disposeReadonlyFixture(); }
    catch (cleanup) { if (unexpected) throw new AggregateError([unexpected, cleanup], "Fixture operation and exact readonly disposal failed"); throw cleanup; }
  }
  if (unexpected) throw unexpected;
  return { j, input, error, retained, fault };
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
    const j = await bootstrap(), input = request();
    simulateReceiptStall("COMMIT");
    await beforeDeadline(deadline(), end => admit(j, input, end));
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
    const j = await bootstrap(), input = request();
    simulateReceiptStall("COMMIT");
    await beforeDeadline(deadline(), end => admit(j, input, end));
    const replacement = { ...owner, nonce: randomUUID() };
    const step = (revision: number, state: Parameters<typeof advance>[3], fields: Parameters<typeof advance>[4] = {}) =>
      beforeDeadline(deadline(), end => advance(j, input.restartId, revision, state, fields, end));
    await step(1, "preparing", { replacementInstance: replacement });
    await expect(step(1, "preparing", { replacementInstance: replacement })).rejects.toThrow(LifecycleUnavailable);
    await step(2, "draining"); await step(3, "prepared");
    await expect(step(4, "release_intent")).rejects.toThrow(LifecycleUnavailable);
    const retained = await selected(j);
    expect(retained).toMatchObject({ currentActor: { kind: "old", instance: owner }, actorGeneration: 1 });
    // The slow-SQL fixture already spies on exec; start this no-BEGIN census
    // at the same boundary as the original standalone spy.
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockClear();
    await expect(step(4, "release_intent", { checkpointManifest: {
      closureDigest: "a".repeat(64), owners: [] } })).rejects.toThrow("owner_unsupported");
    expect(exec.mock.calls.some(([sql]) => sql === "BEGIN IMMEDIATE")).toBe(false);
    const forgedFields = { currentActor: { kind: "successor", instance: replacement } } as unknown as Parameters<typeof j.advance>[3];
    await expect(step(4, "unknown", forgedFields)).rejects.toThrow("revision_conflict");
    expect(await selected(j)).toEqual(retained);
    expect((await selected(j))?.state).toBe("prepared");
  });
  it.each(["id", "revision", "digest", "home", "sql_digest", "matching_digest"] as const)("retained %s envelope mismatch refuses lookup/selection/prepared read/advance without repair or BEGIN", async mismatch => {
    const { j, input, accepted } = await observeInitialAdmission(mismatch);
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
    let elapsed = 0; const now = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => now() + elapsed);
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE") captured = this;
      const result = sqliteExec.call(this, sql);
      if (sql === "BEGIN IMMEDIATE") elapsed += LIFECYCLE_ADMISSION_MS + 1;
      if (sql === "COMMIT") throw Object.assign(new Error("SIMULATED error after real COMMIT"), { errcode: 10 });
      return result;
    });
    await expect(beforeDeadline(deadline(), end => admit(j, input, end))).rejects.toThrow(LifecycleUnavailable);
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
    const trace: InitialAdmissionTrace | undefined = portable ? undefined : { mismatch: "missing_journal_initial",
      outcome: "unavailable", reason: "unavailable", count: 0, overflow: false, records: [] };
    if (trace) initialAdmissionTrace = trace;
    const capture = trace ? vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
      // The ORIGINAL bootstrap initialization supplies this exact actual writer;
      // no getter, extra SQL or supplied resource/authority proof is used.
      if (sql.includes("PRAGMA journal_mode=PERSIST") && trace.end === undefined) trace.writer = this;
      return sqliteExec.call(this, sql);
    }) : undefined;
    const j = await bootstrap(), input = request();
    capture?.mockRestore(); // Bootstrap failure still uses the unchanged afterEach mock restoration.
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
        const operation = sql === "BEGIN IMMEDIATE" ? "begin" : sql === "COMMIT" ? "commit" : sql === "ROLLBACK" ? "rollback" : undefined;
        const record = trace && this === trace.writer && trace.end !== undefined && operation ? observeCall(trace, operation) : undefined;
        const started = record ? diagnosticNow() : 0;
        try {
          const value = sqliteExec.call(this, sql);
          if (trace && record) completeCall(trace, record, started, "returned");
          return value;
        } catch (error) { if (trace && record) completeCall(trace, record, started, "threw"); throw error; }
      });
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
        if (sql === "SELECT json FROM lifecycle_lineage WHERE singleton=1") diagnostic.lineage = true;
        return sqlitePrepare.call(this, sql);
      });
      try {
        // Windows created this private trace above. Capture the one original
        // third argument during its original evaluation, not a fresh allowance.
        await admit(j, input, (trace!.end = deadline()));
        if (trace) trace.outcome = "resolved";
      } catch (error) {
        if (trace) { trace.outcome = "rejected"; trace.reason = diagnosticReason(error); }
        throw error;
      }
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
      const prepareEnd = performance.now() + LIFECYCLE_PREPARE_MS;
      const preparation = await LifecycleJournal.prepareServingBootstrap(servingFixture!.broker.lifecycleServingCapability("prepare", prepareEnd), prepareEnd);
      const end = performance.now() + LIFECYCLE_PREPARE_MS;
      await expect(LifecycleJournal.bootstrapServing(servingFixture!.broker.lifecycleServingCapability("prepare", end), end, preparation))
        .rejects.toMatchObject({ reason: "publication_unproved" });
    }
    expect(existsSync(file() + "-journal")).toBe(false); expect(readFileSync(file())).toEqual(before);
    expect(committedFixtureRows()).toEqual(beforeRows); expect(readFileSync(file() + "-fixture-retained-journal")).toEqual(beforeJournal);
    renameSync(file() + "-fixture-retained-journal", file() + "-journal");
    expect((await lookup(j, input.restartId))?.state).toBe("accepted");
  });
});

describe("source-associated publication UNKNOWN (not controller or durability authority)", () => {
  it("keeps an expired pre-BEGIN admission as the original budget refusal", async () => {
    const j = await capturedOutcomeJournal(), input = request(), end = deadline();
    const cap = portable ? undefined : servingFixture!.broker.lifecycleServingCapability("admission", end);
    const exec = vi.spyOn(DatabaseSync.prototype, "exec"), expired = performance.now() - 1;
    const error = await captureRefusal(() => portable ? j.admit(input, expired) : j.admitServing(cap!, input, expired));
    expect(error).toMatchObject({ reason: "budget" }); expect(observeLifecycleWriteOutcome(error)).toBeNull();
    expect(exec.mock.calls.some(([sql]) => sql === "BEGIN IMMEDIATE" || sql === "COMMIT")).toBe(false);
    expect(j.isQuarantined).toBe(false);
  });

  it("SIMULATED expiry after real transaction work never enters COMMIT or late settlement SQL", async () => {
    const j = await capturedOutcomeJournal(), input = request(), end = deadline(), fault = outcomeFault(captured!, end, "before_commit");
    let error: unknown;
    try { error = await captureRefusal(() => admit(j, input, end)); } finally { fault.restore(); }
    expect(error).toMatchObject({ reason: "budget" }); expect(observeLifecycleWriteOutcome(error)).toBeNull();
    expect(fault.counts).toMatchObject({ begins: 1, commits: 0, returnedCommits: 0, lateSql: 0 });
    expect(j.isQuarantined).toBe(true); publicQuarantineRefuses(j, input.restartId);
    expect(committedFixtureRows()).toHaveLength(0);
  });

  it("ORIGINAL COMMIT then SIMULATED elapsed time yields Held with no duplicate, not a safe budget retry", async () => {
    const j = await capturedOutcomeJournal(), input = request(), end = deadline(), fault = outcomeFault(captured!, end, "late_commit");
    let held = false, calls = 0, error: unknown;
    // Fixture caller contract only; this is not a product job/status adapter.
    const invokeOriginal = async () => {
      if (held) return "held";
      calls++;
      try { await admit(j, input, end); return "unexpected_acknowledgement"; }
      catch (failure) {
        if (!(failure instanceof LifecycleUnavailable) || failure.reason !== "writer_unknown") throw failure;
        error = failure; held = true; return "held";
      }
    };
    try { expect(await invokeOriginal()).toBe("held"); } finally { fault.restore(); }
    expect(await invokeOriginal()).toBe("held"); expect(calls).toBe(1);
    expect(error).toBeInstanceOf(LifecycleUnavailable); expect(error).toMatchObject({ reason: "writer_unknown" });
    const outcome = observeLifecycleWriteOutcome(error);
    expect(outcome).toEqual({ acknowledgement: "unknown", commit: "call_returned", observation: "not_completed",
      stoppedAt: portable ? "autocommit" : "post_commit_guard", cause: "deadline", followUp: "held" });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(observeLifecycleWriteOutcome({ ...Object(error) })).toBeNull();
    expect(observeLifecycleWriteOutcome(JSON.parse(JSON.stringify(error)))).toBeNull();
    expect(observeLifecycleWriteOutcome(new LifecycleUnavailable("writer_unknown"))).toBeNull();
    let accessed = false;
    const proxy = new Proxy(Object(error), { get() { accessed = true; throw new Error("Untrusted error property access"); } });
    expect(observeLifecycleWriteOutcome(proxy)).toBeNull(); expect(accessed).toBe(false);
    expect(observeLifecycleWriteOutcome(null)).toBeNull(); expect(observeLifecycleWriteOutcome("writer_unknown")).toBeNull();
    expect(fault.counts).toEqual({ begins: 1, commits: 1, returnedCommits: 1, lateSql: 0 });
    // A current legitimate read opportunity still refuses this quarantined owner.
    const heldRead = await captureRefusal(() => lookup(j, input.restartId));
    expect(heldRead).toMatchObject({ reason: "writer_unknown" }); expect(observeLifecycleWriteOutcome(heldRead)).toBeNull();
    expect(await invokeOriginal()).toBe("held"); expect(calls).toBe(1); publicQuarantineRefuses(j, input.restartId);
    // Actual fixture-owned readonly oracle, NOT a product reconciliation permit.
    const rows = committedFixtureRows(); expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]!.json))).toMatchObject({ restartId: input.restartId, revision: 1, requestDigest: acceptedRequestDigest(input) });
    expect(j.isQuarantined).toBe(true); expect(j.close()).toBe(false);
  });

  it.each(["reader", "reader_expiry", "reader_close", "reader_native_expiry", "reader_init_close"] as const)("SIMULATED %s failure after ORIGINAL COMMIT cannot acknowledge its tentative return value", async mode => {
    const j = await capturedOutcomeJournal(), input = request(), end = deadline(), fault = outcomeFault(captured!, end, mode);
    let error: unknown, unexpected: unknown, retained = false;
    try { error = await captureRefusal(() => admit(j, input, end)); }
    catch (failure) { unexpected = failure; }
    finally {
      retained = fault.retainedReadonly; fault.restore();
      try { fault.disposeReadonlyFixture(); }
      catch (cleanup) { if (unexpected) throw new AggregateError([unexpected, cleanup], "Fixture operation and actual readonly disposal failed"); throw cleanup; }
    }
    if (unexpected) throw unexpected;
    expect(retained).toBe(mode === "reader_close" || mode === "reader_init_close");
    expect(error).toMatchObject({ reason: "writer_unknown" });
    expect(observeLifecycleWriteOutcome(error)).toMatchObject({ commit: "call_returned", observation: "not_completed",
      stoppedAt: "committed_read", cause: mode === "reader_expiry" ? "deadline" : "observation", followUp: "held" });
    expect(fault.counts.commits).toBe(1); expect(fault.counts.lateSql).toBe(0); expect(committedFixtureRows()).toHaveLength(1);
    if (mode === "reader_native_expiry" || mode === "reader_init_close") {
      expect(fault.readerCalls).toEqual({ initialized: 1, closed: mode === "reader_init_close" ? 0 : 1,
        queryOnlyPrepared: 0, queryOnlyGets: 0, gets: 0, lateGets: 0 });
    }
    publicQuarantineRefuses(j, input.restartId);
  });

  it.each(["reader_preflight", "reader_init", "reader_prepare"] as const)(
    "ORIGINAL COMMIT then SIMULATED %s expiry preserves the exact guard reason and prevents later Statement.get", async mode => {
      const j = await capturedOutcomeJournal(), input = request(), end = deadline(), fault = outcomeFault(captured!, end, mode);
      let error: unknown;
      try { error = await captureRefusal(() => admit(j, input, end)); } finally { fault.restore(); }
      expect(error).toMatchObject({ reason: "writer_unknown" });
      expect(observeLifecycleWriteOutcome(error)).toEqual({ acknowledgement: "unknown", commit: "call_returned",
        observation: "not_completed", stoppedAt: "committed_read", cause: "deadline", followUp: "held" });
      expect(fault.counts).toEqual({ begins: 1, commits: 1, returnedCommits: 1, lateSql: 0 });
      expect(fault.readerCalls).toEqual({ initialized: mode === "reader_preflight" ? 0 : 1,
        closed: mode === "reader_preflight" ? 0 : 1, queryOnlyPrepared: mode === "reader_prepare" ? 1 : 0,
        queryOnlyGets: 0, gets: 0, lateGets: 0 });
      expect(fault.retainedReadonly).toBe(false); expect(j.isQuarantined).toBe(true); expect(j.close()).toBe(false);
      publicQuarantineRefuses(j, input.restartId);
      const rows = committedFixtureRows(); expect(rows).toHaveLength(1);
      expect(JSON.parse(String(rows[0]!.json))).toMatchObject({ restartId: input.restartId, revision: 1, requestDigest: acceptedRequestDigest(input) });
    });

  const verificationCases = (["lineage", "receipt_id", "receipt_selected", "conflict"] as const)
    .flatMap(query => (["prepare_expiry", "get_expiry"] as const).map(boundary => ({ query, boundary })));
  it.each(verificationCases)("ORIGINAL $query SELECT $boundary stays inside its original verification budget", async ({ query, boundary }) => {
    const { j, input, error, retained, fault } = await verificationRefusal(query, boundary);
    expect(error).toMatchObject({ reason: "writer_unknown" });
    expect(observeLifecycleWriteOutcome(error)).toEqual({ acknowledgement: "unknown", commit: "call_returned",
      observation: "not_completed", stoppedAt: "committed_read", cause: "deadline", followUp: "held" });
    expect(fault.counts).toEqual({ begins: 1, commits: 1, returnedCommits: 1, lateSql: 0 });
    expect(fault.queryCalls[query]).toEqual({ prepared: 1, gets: boundary === "get_expiry" ? 1 : 0,
      returned: boundary === "get_expiry" ? 1 : 0 });
    expect(fault.readerCalls.lateGets).toBe(0); expect(fault.readerCalls.closed).toBe(fault.readerCalls.initialized);
    expect(retained).toBe(false); expect(j.isQuarantined).toBe(true); publicQuarantineRefuses(j, input.restartId);
    // Fixture oracle after clock/observers restore; retained bytes are not reconciliation authority.
    const rows = committedFixtureRows(); expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]!.json))).toMatchObject({ restartId: input.restartId, revision: 1, requestDigest: acceptedRequestDigest(input) });
  });

  const receiptFailureCases = (["receipt_id", "receipt_selected"] as const)
    .flatMap(query => (["get_native_expiry", "get_close_expiry"] as const).map(boundary => ({ query, boundary })));
  it.each(receiptFailureCases)("SIMULATED $query $boundary preserves native normalization or exact close uncertainty", async ({ query, boundary }) => {
    const { j, input, error, retained, fault } = await verificationRefusal(query, boundary);
    expect(error).toMatchObject({ reason: "writer_unknown" });
    expect(observeLifecycleWriteOutcome(error)).toMatchObject({ commit: "call_returned", observation: "not_completed",
      stoppedAt: "committed_read", cause: "observation", followUp: "held" });
    expect(fault.counts).toEqual({ begins: 1, commits: 1, returnedCommits: 1, lateSql: 0 });
    expect(fault.queryCalls[query]).toEqual({ prepared: 1, gets: 1, returned: 1 });
    expect(fault.readerCalls.lateGets).toBe(0); expect(retained).toBe(boundary === "get_close_expiry");
    expect(fault.readerCalls.closed).toBe(fault.readerCalls.initialized - (retained ? 1 : 0));
    expect(j.isQuarantined).toBe(true); publicQuarantineRefuses(j, input.restartId); expect(committedFixtureRows()).toHaveLength(1);
  });

  it.each(portable ? ["final_deadline"] as const : ["final_deadline", "phase_return"] as const)(
    "SIMULATED %s expiry after the actual strict selected snapshot/disposal remains UNKNOWN", async stage => {
      const j = await capturedOutcomeJournal(), input = request(), end = deadline();
      const fault = outcomeFault(captured!, end, "last_guard", stage === "phase_return" ? 2 : 1);
      let error: unknown;
      try { error = await captureRefusal(() => admit(j, input, end)); } finally { fault.restore(); }
      expect(error).toMatchObject({ reason: "writer_unknown" });
      expect(observeLifecycleWriteOutcome(error)).toMatchObject({ commit: "call_returned", observation: "expected_snapshot_observed",
        stoppedAt: stage, cause: "deadline", followUp: "held" });
      expect(fault.counts).toEqual({ begins: 1, commits: 1, returnedCommits: 1, lateSql: 0 });
      expect(committedFixtureRows()).toHaveLength(1); publicQuarantineRefuses(j, input.restartId);
    });

  it("an actual native BUSY COMMIT exposes source-associated thrown uncertainty without replay", async () => {
    const j = await capturedOutcomeJournal(), input = request(), blocker = new DatabaseSync(file(), { readOnly: true });
    let commits = 0;
    blocker.exec("BEGIN"); blocker.prepare("SELECT json FROM lifecycle_lineage").get();
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, sql: string) {
      if (this === captured && sql === "COMMIT") commits++;
      return sqliteExec.call(this, sql);
    });
    try {
      const error = await captureRefusal(() => admit(j, input, deadline()));
      expect(error).toMatchObject({ reason: "writer_unknown" });
      expect(observeLifecycleWriteOutcome(error)).toMatchObject({ commit: "call_threw_or_unreturned", observation: "not_completed",
        stoppedAt: "commit", cause: "commit_exception", followUp: "held" });
      expect(commits).toBe(1); expect(j.isQuarantined).toBe(true); publicQuarantineRefuses(j, input.restartId);
    } finally { exec.mockRestore(); blocker.exec("ROLLBACK"); blocker.close(); }
  });

  it.each(["wrapper_throw", "conflict_throw"] as const)("SIMULATED %s after real COMMIT never becomes success or pre-COMMIT conflict settlement", async mode => {
    const j = await capturedOutcomeJournal(), input = request(), end = deadline(), fault = outcomeFault(captured!, end, mode);
    let error: unknown;
    try { error = await captureRefusal(() => admit(j, input, end)); } finally { fault.restore(); }
    expect(error).toMatchObject({ reason: "writer_unknown" });
    expect(observeLifecycleWriteOutcome(error)).toMatchObject({ commit: "call_threw_or_unreturned", observation: "not_completed",
      stoppedAt: "commit", cause: "commit_exception", followUp: "held" });
    expect(fault.counts.commits).toBe(1); expect(fault.counts.returnedCommits).toBe(1);
    expect(committedFixtureRows()).toHaveLength(1); publicQuarantineRefuses(j, input.restartId);
  });

  it.each(["advance", "conflict"] as const)("late ORIGINAL %s COMMIT cannot replay its CAS/evidence publication", async mode => {
    const j = await capturedOutcomeJournal(), input = request(), accepted = await admit(j, input, deadline());
    const end = deadline(), fault = outcomeFault(captured!, end, "late_commit");
    let error: unknown;
    try {
      error = await captureRefusal(() => mode === "advance" ? advance(j, input.restartId, accepted.revision, "preparing", {}, end)
        : admit(j, { ...input, operation: "stop" }, end));
    } finally { fault.restore(); }
    expect(error).toMatchObject({ reason: "writer_unknown" });
    expect(observeLifecycleWriteOutcome(error)).toMatchObject({ commit: "call_returned", observation: "not_completed", followUp: "held" });
    expect(fault.counts).toEqual({ begins: 1, commits: 1, returnedCommits: 1, lateSql: 0 });
    publicQuarantineRefuses(j, input.restartId);
    const rows = committedFixtureRows(); expect(rows).toHaveLength(mode === "advance" ? 2 : 1);
    expect(JSON.parse(String(rows[0]!.json))).toEqual(accepted);
    const oracle = new DatabaseSync(file(), { readOnly: true });
    try {
      oracle.exec("PRAGMA query_only=ON");
      expect(oracle.prepare("SELECT count(*) AS n FROM receipt_conflicts").get()?.n).toBe(mode === "conflict" ? 1 : 0);
      expect(oracle.prepare("SELECT revision FROM selected_receipt WHERE singleton=1").get()?.revision).toBe(mode === "advance" ? 2 : 1);
    } finally { oracle.close(); }
    expect(j.isQuarantined).toBe(true);
  });

  it("a verified intentional conflict remains receipt_conflict and a later read never inherits an old write scope", async () => {
    // Receipt/conflict semantics, not the phase budget: each admission keeps its
    // original 1 s deadline, insulated from real-time stalls of the loaded runner.
    const j = await capturedOutcomeJournal(), input = request();
    const accepted = await beforeDeadline(deadline(), end => admit(j, input, end)).catch(error => { throw withWriteOutcome(error); });
    const conflict = await beforeDeadline(deadline(), end => captureRefusal(() => admit(j, { ...input, operation: "stop" }, end)));
    expect(conflict).toMatchObject({ reason: "receipt_conflict" }); expect(observeLifecycleWriteOutcome(conflict)).toBeNull();
    expect(j.isQuarantined).toBe(false); expect(await beforeDeadline(deadline(), end => admit(j, input, end))).toEqual(accepted);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, sql: string) {
      const value = sqlitePrepare.call(this, sql);
      if (sql === "SELECT json FROM lifecycle_lineage WHERE singleton=1") throw new Error("SIMULATED later independent-read failure");
      return value;
    });
    let later: unknown;
    try { later = await captureRefusal(() => lookup(j, input.restartId)); } finally { prepare.mockRestore(); }
    expect(observeLifecycleWriteOutcome(later)).toBeNull(); expect(later).not.toMatchObject({ reason: "writer_unknown" });
    expect(j.isQuarantined).toBe(false);
  });
});
