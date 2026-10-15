import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { z } from "zod";
import { readProcessIdentity } from "./process-identity.js";
import { assertLifecycleServingCapability, type LifecycleServingCapability, type LifecycleServingPhase } from "./broker.js";
import { createWindowsLifecycleObjects, assertWindowsLifecycleCreation, readOwnWindowsLifecycleIdentity, WindowsLifecyclePathUnavailable,
  verifyWindowsLifecyclePaths, assertWindowsLifecyclePathProof } from "./lifecycle-windows.js";
import { lifecycleInstanceSchema as instanceSchema, lifecycleActorSchema, LIFECYCLE_STATES, LIFECYCLE_NEXT,
  LIFECYCLE_PROOF_REQUIRED, sameLifecycleInstance } from "./daemon-lifecycle-role.js";

// These caps belong to lifecycle coordination, not ordinary request deadlines.
export const LIFECYCLE_PRE_RELEASE_MS = 10_000;
export const LIFECYCLE_ADMISSION_MS = 1_000;
export const LIFECYCLE_PREPARE_MS = 5_000;
export const LIFECYCLE_DISPATCH_DRAIN_MS = 2_000;
export const LIFECYCLE_WRITE_CHECKPOINT_MS = 2_000;
export const LIFECYCLE_BIND_OBSERVE_MS = 2_000;
export const LIFECYCLE_METADATA_BYTES = 64 * 1024;
const BUSY_MS = 25;
const DIRECTORY = ".core-lifecycle", FILE = "receipts.sqlite";
const targetSchema = z.object({ immutableRuntimePath: z.string().min(1).max(4096), version: z.string().min(1).max(128),
  protocol: z.number().int().positive(), fileManifestDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const receiptDataSchema = z.object({ schema: z.literal(1), restartId: z.string().uuid(), operation: z.enum(["restart", "stop"]),
  homeIdentity: z.string().regex(/^[a-f0-9]{64}$/), oldInstance: instanceSchema, target: targetSchema,
  state: z.enum(LIFECYCLE_STATES), revision: z.number().int().positive(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  currentActor: lifecycleActorSchema, actorGeneration: z.number().int().positive(),
  historicalOldOutcome: z.enum(["unknown", "released", "released_late"]).optional(),
  acceptedAt: z.number().int().nonnegative(), replacementInstance: instanceSchema.optional(),
  checkpointManifest: z.object({ closureDigest: z.string().regex(/^[a-f0-9]{64}$/),
    owners: z.array(z.object({ ownerId: z.string().min(1).max(128), checkpointRevision: z.string().min(1).max(128),
      durabilityEvidence: z.string().min(1).max(1024), ownershipReleaseEvidence: z.string().min(1).max(1024) }).strict()).max(128) }).strict().optional(),
  failureCode: z.string().regex(/^[a-z_]+(?::[a-z_]+)?$/).max(128).optional(),
}).strict();
const receiptSchema = receiptDataSchema.superRefine((receipt, ctx) => {
  const actor = receipt.currentActor;
  const expected = actor.kind === "old" ? receipt.oldInstance : receipt.replacementInstance;
  if (!expected || !sameLifecycleInstance(actor.instance, expected) ||
      (actor.kind === "old" ? receipt.actorGeneration !== 1 : receipt.actorGeneration <= 1)) {
    ctx.addIssue({ code: "custom", message: "Unproved lifecycle actor binding" });
  }
  if ((["binding", "done"].includes(receipt.state) && actor.kind !== "successor") ||
      (["accepted", "preparing", "draining", "prepared", "release_intent", "released", "failed_serving", "stop_intent", "stop_committed"].includes(receipt.state) && actor.kind !== "old") ||
      (receipt.operation === "stop" && (["preparing", "release_intent", "released", "binding", "done"].includes(receipt.state) || !!receipt.replacementInstance)) ||
      (receipt.operation === "restart" && ["stop_intent", "stop_committed"].includes(receipt.state))) {
    ctx.addIssue({ code: "custom", message: "Unproved lifecycle actor transition" });
  }
});
const advanceFieldsSchema = receiptDataSchema.pick({ replacementInstance: true, checkpointManifest: true, failureCode: true }).strict();
export type LifecycleInstance = z.infer<typeof instanceSchema>;
export type LifecycleReceipt = z.infer<typeof receiptSchema>;
export type LifecycleRequest = Pick<LifecycleReceipt, "restartId" | "operation" | "oldInstance" | "target">;
const BOOTSTRAP_STAGES = ["configure", "schema", "commit", "file_flush", "journal_flush", "readonly_lineage", "final_guard"] as const;
type BootstrapStage = typeof BOOTSTRAP_STAGES[number];
const BOOTSTRAP_FLUSH_ERRNOS = ["EPERM", "EBADF", "EACCES", "EIO", "unknown"] as const;
type BootstrapFlushErrno = typeof BOOTSTRAP_FLUSH_ERRNOS[number];
export class LifecycleUnavailable extends Error {
  readonly bootstrapStage?: BootstrapStage;
  readonly bootstrapFlushOk?: boolean;
  readonly bootstrapFlushErrno?: BootstrapFlushErrno;
  readonly bootstrapCloseErrno?: BootstrapFlushErrno;
  constructor(readonly reason: "private_path" | "publication_unproved" | "lineage_unknown" | "writer_unknown" | "owner_unsupported" | "revision_conflict" | "receipt_conflict" | "budget" | "metadata_bound", bootstrapStage?: BootstrapStage,
    flush?: { ok: boolean; errno?: BootstrapFlushErrno; closeErrno?: BootstrapFlushErrno }) {
    super(`Core lifecycle unavailable: ${reason}.`);
    if (bootstrapStage !== undefined && BOOTSTRAP_STAGES.includes(bootstrapStage)) this.bootstrapStage = bootstrapStage;
    if (typeof flush?.ok === "boolean") this.bootstrapFlushOk = flush.ok;
    if (flush?.errno !== undefined && BOOTSTRAP_FLUSH_ERRNOS.includes(flush.errno)) this.bootstrapFlushErrno = flush.errno;
    if (flush?.closeErrno !== undefined && BOOTSTRAP_FLUSH_ERRNOS.includes(flush.closeErrno)) this.bootstrapCloseErrno = flush.closeErrno;
  }
}
function fail(reason: LifecycleUnavailable["reason"]): never { throw new LifecycleUnavailable(reason); }
/** Historical call/observation facts only, never a receipt, retry or ownership permit. */
export type LifecycleWriteOutcome = Readonly<{
  acknowledgement: "unknown";
  commit: "call_returned" | "call_threw_or_unreturned";
  observation: "not_completed" | "expected_snapshot_observed";
  stoppedAt: "commit" | "post_commit_guard" | "autocommit" | "committed_read" | "final_deadline" | "phase_return";
  cause: "deadline" | "authority_or_lineage" | "observation" | "commit_exception";
  followUp: "held";
}>;
type WriteAttempt = {
  readonly writer: DatabaseSync;
  readonly deadline: number;
  readonly effect: "admission" | "advance" | "conflict";
  readonly restartId: string;
  readonly revision: number;
  readonly requestDigest: string;
  commit: "not_attempted" | LifecycleWriteOutcome["commit"];
  stage: LifecycleWriteOutcome["stoppedAt"];
  observed: boolean;
  knownConflict: boolean;
  failure?: LifecycleUnavailable;
  failureCause?: unknown;
};
const writeOutcomes = new WeakMap<object, LifecycleWriteOutcome>();
// Strongly retain the exact owner/resources after an unconfirmed publication.
// Bounded observation must not discard unknown native connections or their owner.
const unconfirmedPublications = new Map<WriteAttempt, LifecycleJournal>();
export function observeLifecycleWriteOutcome(error: unknown): LifecycleWriteOutcome | null {
  // No property access, deserialization or caller-supplied fields establish provenance.
  // No association is absence of evidence, never permission to retry a write.
  return typeof error === "object" && error !== null ? writeOutcomes.get(error) ?? null : null;
}
// Module-private association: no public constructor, method or caller DTO can mint it.
function unconfirmedWrite(journal: LifecycleJournal, attempt: WriteAttempt, error: unknown): LifecycleUnavailable {
  unconfirmedPublications.set(attempt, journal);
  // Only this invocation's own wrapper can pass through the outer phase catch.
  // A source-associated error from another invocation is not this attempt's evidence.
  if (attempt.failure && error === attempt.failure) return attempt.failure;
  const cause: LifecycleWriteOutcome["cause"] = attempt.stage === "commit" ? "commit_exception"
    : error instanceof LifecycleUnavailable && error.reason === "budget" ? "deadline"
    : attempt.stage === "autocommit" || attempt.stage === "committed_read" ? "observation" : "authority_or_lineage";
  const unavailable = new LifecycleUnavailable("writer_unknown");
  attempt.failureCause = error; attempt.failure = unavailable;
  writeOutcomes.set(unavailable, Object.freeze({ acknowledgement: "unknown",
    commit: attempt.commit === "call_returned" ? "call_returned" : "call_threw_or_unreturned",
    observation: attempt.observed ? "expected_snapshot_observed" : "not_completed",
    stoppedAt: attempt.stage, cause, followUp: "held" }));
  return unavailable;
}
function digest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, item]) => [k, canonical(item)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function bytes(receipt: LifecycleReceipt): string {
  const json = JSON.stringify(receiptSchema.parse(receipt));
  if (Buffer.byteLength(json) > LIFECYCLE_METADATA_BYTES) fail("metadata_bound");
  return json;
}
function receiptEnvelope(row: Record<string, unknown>, homeIdentity: string, expectedId?: string): LifecycleReceipt {
  try {
    if (typeof row.json !== "string") fail("lineage_unknown");
    const receipt = receiptSchema.parse(JSON.parse(row.json));
    const acceptedRequest: LifecycleRequest = { restartId: receipt.restartId, operation: receipt.operation,
      oldInstance: receipt.oldInstance, target: receipt.target };
    if (row.receipt_id !== receipt.restartId || expectedId !== undefined && row.receipt_id !== expectedId ||
        row.receipt_revision !== receipt.revision || row.receipt_digest !== receipt.requestDigest ||
        receipt.requestDigest !== digest(acceptedRequest) || receipt.homeIdentity !== homeIdentity) fail("lineage_unknown");
    return receipt;
  } catch { fail("lineage_unknown"); }
}
function hasSelectedReceipt(row: Record<string, unknown>): boolean {
  if (row.selected_id === null && row.selected_revision === null) {
    if (row.json !== null || row.receipt_id !== null || row.receipt_revision !== null || row.receipt_digest !== null) fail("lineage_unknown");
    return false;
  }
  if (row.json === null || row.selected_id !== row.receipt_id || row.selected_revision !== row.receipt_revision) fail("lineage_unknown");
  return true;
}
interface FileIdentity { dev: string; ino: string; creation: string }
interface Lineage { schema: 1; lineage: string; homeIdentity: string; directory: FileIdentity; file: FileIdentity; journal: FileIdentity }
function identity(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (stat.ino <= 0n || stat.dev < 0n || stat.isSymbolicLink()) fail("private_path");
  return { dev: String(stat.dev), ino: String(stat.ino), creation: String(stat.birthtimeNs) };
}
function same(a: FileIdentity, b: FileIdentity): boolean { return a.dev === b.dev && a.ino === b.ino && a.creation === b.creation; }
function physical(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) fail("private_path");
    if (dirname(current) === current) break;
  }
}
function privatePath(path: string, directory: boolean): void {
  physical(path);
  const stat = lstatSync(path);
  if (directory ? !stat.isDirectory() : !stat.isFile()) fail("private_path");
  if (!directory && stat.nlink !== 1) fail("private_path");
  if (process.platform === "win32") fail("publication_unproved"); // Reviewed Windows established-bootstrap proof is pending.
  if (process.getuid?.() !== stat.uid || (stat.mode & 0o077) !== 0) fail("private_path");
}
function flush(path: string): void { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function transactionState(db: DatabaseSync): boolean {
  // Added in the documented minimum Node22.16. Unknown cannot mean autocommit.
  const state: unknown = db.isTransaction;
  if (typeof state !== "boolean") fail("writer_unknown");
  return state;
}
function configureWriter(db: DatabaseSync, guard: () => void = () => {}): void {
  guard();
  db.exec(`PRAGMA busy_timeout=${BUSY_MS}; PRAGMA journal_mode=PERSIST; PRAGMA journal_size_limit=-1; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;`);
  guard(); if (process.platform === "darwin") { guard(); db.exec("PRAGMA fullfsync=ON"); guard(); }
  const observed = (pragma: string, field: string) => { guard(); const result = db.prepare(pragma).get()?.[field]; guard(); return result; };
  if (observed("PRAGMA journal_mode", "journal_mode") !== "persist" || observed("PRAGMA synchronous", "synchronous") !== 2 ||
      observed("PRAGMA foreign_keys", "foreign_keys") !== 1 || observed("PRAGMA trusted_schema", "trusted_schema") !== 0 ||
      (process.platform === "darwin" && observed("PRAGMA fullfsync", "fullfsync") !== 1)) fail("publication_unproved");
}
type ReadConnectionRecord = { db: DatabaseSync; file: string; state: "initializing" | "ready" | "unknown" | "closed";
  owner?: Set<ReadConnectionRecord>; unknown?(): void };
const readConnectionRecords = new WeakMap<DatabaseSync, ReadConnectionRecord>();
const unconfirmedReadonlyConnections = new Set<ReadConnectionRecord>();
function closeReadConnection(db: DatabaseSync): void {
  const record = readConnectionRecords.get(db);
  try { db.close(); }
  catch {
    if (record) { record.state = "unknown"; unconfirmedReadonlyConnections.add(record); record.unknown?.(); }
    fail("writer_unknown");
  }
  if (record) { record.state = "closed"; record.owner?.delete(record); unconfirmedReadonlyConnections.delete(record); }
}
function readConnection(file: string, exclusivelyNewGuard?: () => void, deadline?: number,
  owner?: Set<ReadConnectionRecord>, unknown?: () => void): DatabaseSync {
  try {
    exclusivelyNewGuard?.();
    // A portable deadline guard is not Windows path/ACL proof. Preserve the
    // original portable private-path checks before every native reader open.
    if (!exclusivelyNewGuard || process.platform !== "win32") { privatePath(dirname(file), true); privatePath(file, false); privatePath(file + "-journal", false); }
  }
  catch { fail("lineage_unknown"); }
  const before = identity(file);
  let db: DatabaseSync;
  try { exclusivelyNewGuard?.(); db = new DatabaseSync(file, { readOnly: true,
    timeout: deadline === undefined ? BUSY_MS : Math.max(0, Math.min(BUSY_MS, Math.floor(deadline - performance.now()))) }); }
  catch { fail("lineage_unknown"); } // Hot recovery requiring writes is not a prepared-reader exception.
  // Capture the exact native connection before any initialization/guard can fail.
  // Unknown disposal retains both this record and its source-owned journal owner.
  const record: ReadConnectionRecord = { db, file, state: "initializing", owner, unknown };
  readConnectionRecords.set(db, record); owner?.add(record);
  try {
    exclusivelyNewGuard?.(); db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;"); exclusivelyNewGuard?.();
    if (db.prepare("PRAGMA query_only").get()?.query_only !== 1 || !same(before, identity(file))) fail("lineage_unknown");
    record.state = "ready"; return db;
  } catch { closeReadConnection(db); fail("lineage_unknown"); }
}
const SCHEMA = `
CREATE TABLE lifecycle_lineage (singleton INTEGER PRIMARY KEY CHECK(singleton=1), json TEXT NOT NULL);
CREATE TABLE receipt_revisions (restart_id TEXT NOT NULL, revision INTEGER NOT NULL, request_digest TEXT NOT NULL, json TEXT NOT NULL,
 PRIMARY KEY(restart_id,revision));
CREATE TABLE selected_receipt (singleton INTEGER PRIMARY KEY CHECK(singleton=1), restart_id TEXT NOT NULL, revision INTEGER NOT NULL,
 FOREIGN KEY(restart_id,revision) REFERENCES receipt_revisions(restart_id,revision));
CREATE TABLE receipt_conflicts (sequence INTEGER PRIMARY KEY, restart_id TEXT NOT NULL, observed_digest TEXT NOT NULL, json TEXT NOT NULL);
`;

/** Strict reader of committed snapshots. It cannot repair/recover a hot journal. */
export class PreparedLifecycleReader {
  private readonly db: DatabaseSync;
  private readonly phaseGuard?: () => void;
  private readonly phaseDeadline?: number;
  private disposed = false;
  private disposalUnknown = false;
  constructor(private readonly file: string, private readonly lineage: Lineage, private readonly restartId: string, private readonly access?: object) {
    z.string().uuid().parse(restartId);
    if (access !== undefined) {
      const record = preparedPhaseAccess.get(access);
      if (!record || record.claimed || record.file !== file || record.lineage !== lineage.lineage || record.id !== restartId) fail("writer_unknown");
      record.claimed = true; this.phaseGuard = record.guard; this.phaseDeadline = record.deadline;
      record.reader = this; // Retain the constructing owner, even if initialization throws.
    }
    const record = access === undefined ? undefined : preparedPhaseAccess.get(access);
    this.db = readConnection(file, this.phaseGuard, this.phaseDeadline, record?.connections, record?.unknown);
  }
  read(): LifecycleReceipt {
    try {
      if (this.disposed || this.disposalUnknown) fail("lineage_unknown");
      this.phaseGuard?.();
      // One SELECT is one settled committed snapshot; no cursor/read transaction is retained.
      const row = this.db.prepare(`SELECT l.json AS lineage, r.json AS receipt,
        r.restart_id AS receipt_id, r.revision AS receipt_revision, r.request_digest AS receipt_digest,
        s.restart_id AS selected_id,s.revision AS selected_revision FROM lifecycle_lineage l
        JOIN selected_receipt s ON s.singleton=l.singleton JOIN receipt_revisions r
        ON r.restart_id=s.restart_id AND r.revision=s.revision WHERE l.singleton=1 AND r.restart_id=?`).get(this.restartId);
      this.phaseGuard?.();
      if (!row || JSON.stringify(JSON.parse(String(row.lineage))) !== JSON.stringify(this.lineage) ||
          !same(this.lineage.directory, identity(dirname(this.file))) || !same(this.lineage.file, identity(this.file)) ||
          !same(this.lineage.journal, identity(this.file + "-journal"))) fail("lineage_unknown");
      const envelope = { ...row, json: row.receipt };
      if (!hasSelectedReceipt(envelope)) fail("lineage_unknown");
      const receipt = receiptEnvelope(envelope, this.lineage.homeIdentity, this.restartId); this.phaseGuard?.(); return receipt;
    } catch { fail("lineage_unknown"); }
  }
  close(): void {
    if (this.disposed) return;
    if (this.disposalUnknown) fail("writer_unknown"); // No disposal retry/renewal after an uncertain close.
    try { closeReadConnection(this.db); } catch { this.disposalUnknown = true; fail("writer_unknown"); }
    this.disposed = true;
    if (this.access) { preparedPhaseAccess.get(this.access)?.closed(); preparedPhaseAccess.delete(this.access); }
  }
}

// Private, single-reader, bounded READONLY lifetime. Shape/copy/caller callbacks
// cannot mint access; no writable role, renewal or cross-phase cache is granted.
const preparedPhaseAccess = new WeakMap<object, { file: string; lineage: string; id: string; claimed: boolean;
  deadline: number; reader?: PreparedLifecycleReader; connections: Set<ReadConnectionRecord>;
  unknown(): void; guard(): void; closed(): void }>();

// Source-owned quarantine retention, not a public force-dispose/recovery API.
const failedBootstrapJournals = new Set<LifecycleJournal>();
const failedBootstrapFlushDescriptors = new Set<number>();

/** Storage only. Dispatch/producer closure and pre-writable ownership guards belong to the coordinator; not yet wired. */
export class LifecycleJournal {
  private quarantined = false;
  private servingPhaseBusy = false;
  private servingPhase?: { phase: LifecycleServingPhase; deadline: number; guard(): void; write?: WriteAttempt };
  private writeAttempt?: WriteAttempt;
  private readonly servingReaderAccess = new Set<object>();
  private readonly ownedReadonlyConnections = new Set<ReadConnectionRecord>();
  private constructor(private readonly file: string, private readonly lineage: Lineage, private readonly owner: LifecycleInstance, private readonly writer: DatabaseSync) {}

  /** Boundary2: actual CURRENT serving owner, fresh phase-local OS/lineage proof.
   * No ordinary Windows method/default role or successor promotion is enabled. */
  private async inServingPhase<T>(capability: LifecycleServingCapability, phase: LifecycleServingPhase, deadline: number,
    work: (guard: () => void) => T): Promise<T> {
    this.requireKnownWriter();
    if (process.platform !== "win32" || this.servingPhaseBusy || this.servingPhase) fail("owner_unsupported");
    this.servingPhaseBusy = true;
    try {
      const initial = assertLifecycleServingCapability(capability, phase), home = dirname(dirname(this.file));
      const current = () => {
        if (!Number.isFinite(deadline) || performance.now() >= deadline) fail("budget");
        const actual = assertLifecycleServingCapability(capability, phase);
        if (actual.ownerInstance !== this.owner.nonce || actual.ownerInstance !== initial.ownerInstance || actual.generation !== initial.generation ||
            actual.endpoint !== initial.endpoint || digest(realpathSync.native(actual.home)) !== this.lineage.homeIdentity ||
            !same(identity(actual.home), identity(home))) fail("writer_unknown");
      };
      current();
      if (phase !== "prepare") {
        try { if (transactionState(this.writer)) fail("writer_unknown"); }
        catch { this.quarantined = true; fail("writer_unknown"); }
      }
      const proof = await verifyWindowsLifecyclePaths(home, this.owner.nonce, phase, "established", deadline, capability);
      current();
      const guard = () => { current(); assertWindowsLifecyclePathProof(proof, home, this.owner.nonce, phase, "established"); };
      guard(); this.servingPhase = { phase, deadline, guard };
      this.verifyLineage(); // Actual strict RO/query_only observation BEFORE any writer SQL.
      if (phase !== "prepare") {
        try { if (transactionState(this.writer)) fail("writer_unknown"); }
        catch { this.quarantined = true; fail("writer_unknown"); }
        for (const [pragma, key, expected] of [["PRAGMA journal_mode", "journal_mode", "persist"], ["PRAGMA synchronous", "synchronous", 2],
          ["PRAGMA journal_size_limit", "journal_size_limit", -1], ["PRAGMA trusted_schema", "trusted_schema", 0], ["PRAGMA foreign_keys", "foreign_keys", 1]] as const) {
          guard(); const value = this.writer.prepare(pragma).get()?.[key]; guard(); if (value !== expected) fail("publication_unproved");
        }
        guard(); const busy = this.writer.prepare("PRAGMA busy_timeout").get()?.timeout; guard();
        if (typeof busy !== "number" || !Number.isSafeInteger(busy) || busy < 0 || busy > BUSY_MS) fail("publication_unproved");
      }
      const result = work(guard);
      if (this.servingPhase.write) this.servingPhase.write.stage = "phase_return";
      guard(); return result;
    } catch (error) {
      const write = this.servingPhase?.write;
      if (write && write.commit !== "not_attempted" && !write.knownConflict) {
        this.quarantined = true; throw unconfirmedWrite(this, write, error);
      }
      throw error instanceof LifecycleUnavailable ? error : new LifecycleUnavailable(
        error instanceof WindowsLifecyclePathUnavailable && error.reason === "budget" ? "budget" : "lineage_unknown");
    } finally { this.servingPhase = undefined; this.servingPhaseBusy = false; }
  }
  admitServing(capability: LifecycleServingCapability, request: LifecycleRequest, deadline: number): Promise<LifecycleReceipt> {
    return this.inServingPhase(capability, "admission", deadline, () => this.admit(request, deadline));
  }
  advanceServing(capability: LifecycleServingCapability, id: string, revision: number, state: LifecycleReceipt["state"],
    fields: Pick<LifecycleReceipt, "replacementInstance" | "checkpointManifest" | "failureCode">, deadline: number): Promise<LifecycleReceipt> {
    return this.inServingPhase(capability, "write", deadline, () => this.advance(id, revision, state, fields, deadline));
  }
  lookupServing(capability: LifecycleServingCapability, id: string, deadline: number): Promise<LifecycleReceipt | null> {
    return this.inServingPhase(capability, "prepare", deadline, () => this.lookup(id));
  }
  selectedServing(capability: LifecycleServingCapability, deadline: number): Promise<LifecycleReceipt | null> {
    return this.inServingPhase(capability, "prepare", deadline, () => this.selected());
  }
  preparedReaderServing(capability: LifecycleServingCapability, id: string, deadline: number): Promise<PreparedLifecycleReader> {
    return this.inServingPhase(capability, "prepare", deadline, guard => {
      const selected = this.selected(); if (!selected || selected.restartId !== id) fail("receipt_conflict");
      const access = Object.freeze({}); this.servingReaderAccess.add(access);
      const record = { file: this.file, lineage: this.lineage.lineage, id, deadline, claimed: false, reader: undefined as PreparedLifecycleReader | undefined,
        connections: this.ownedReadonlyConnections, unknown: () => { this.quarantined = true; },
        guard: () => { this.requireKnownWriter(); guard(); }, closed: () => { this.servingReaderAccess.delete(access); } };
      preparedPhaseAccess.set(access, record);
      return record.reader = new PreparedLifecycleReader(this.file, this.lineage, id, access);
    });
  }
  private readerGuard(): (() => void) | undefined {
    if (process.platform === "win32") return this.servingPhase?.guard;
    const attempt = this.writeAttempt;
    // Portable post-COMMIT verification uses the same original budget too;
    // an expired intermediate read cannot begin the next verification SQL.
    return attempt?.commit === "call_returned" ? () => { if (performance.now() >= attempt.deadline) fail("budget"); } : undefined;
  }
  private readerDeadline(): number | undefined { return process.platform === "win32" ? this.servingPhase?.deadline : undefined; }
  private writerGuard(): void { if (process.platform === "win32") { if (!this.servingPhase || this.servingPhase.phase === "prepare") fail("owner_unsupported"); this.servingPhase.guard(); } }
  private writerExec(sql: string): void {
    this.writerGuard();
    if (process.platform === "win32") {
      this.writer.exec(`PRAGMA busy_timeout=${Math.max(0, Math.min(BUSY_MS, Math.floor(this.servingPhase!.deadline - performance.now())))}`);
      this.writerGuard();
    }
    const write = sql === "COMMIT" ? this.writeAttempt : undefined;
    if (sql === "COMMIT" && (!write || write.writer !== this.writer)) fail("writer_unknown");
    if (write) { write.stage = "commit"; write.commit = "call_threw_or_unreturned"; }
    this.writer.exec(sql);
    if (write) { write.commit = "call_returned"; write.stage = "post_commit_guard"; }
    this.writerGuard();
  }
  private writerRun(sql: string, ...args: SQLInputValue[]) {
    this.writerGuard(); const statement = this.writer.prepare(sql); this.writerGuard(); const result = statement.run(...args); this.writerGuard(); return result;
  }

  /** Boundary1 ONLY: explicit real serving issuer, exclusive new Windows objects,
   * initial committed lineage. No ordinary admission, controller or role promotion.
   * Existing public Windows bootstrap/reader/admission paths remain unsupported. */
  static async bootstrapServing(capability: LifecycleServingCapability, deadline: number): Promise<LifecycleJournal> {
    const initial = assertLifecycleServingCapability(capability, "prepare");
    if (process.platform !== "win32" || !Number.isFinite(deadline) || performance.now() >= deadline) fail("publication_unproved");
    const current = () => {
      const actual = assertLifecycleServingCapability(capability, "prepare");
      if (performance.now() >= deadline || actual.ownerInstance !== initial.ownerInstance || actual.generation !== initial.generation || actual.home !== initial.home) fail("writer_unknown");
    };
    current(); const creationIdentity = await readOwnWindowsLifecycleIdentity(capability, deadline); current();
    if (!creationIdentity) fail("writer_unknown");
    const owner = { nonce: initial.ownerInstance, pid: process.pid, creationIdentity };
    // Refusal only: any existing object (including a link) or unreadable/unknown
    // fixed path cannot be adopted as exclusively NEW bootstrap state.
    let absent = false;
    try { lstatSync(join(initial.home, DIRECTORY)); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") absent = true; else fail("publication_unproved"); }
    if (!absent) fail("publication_unproved");
    current(); // Original cap/deadline still applies before atomic exclusive creation.
    const created = await createWindowsLifecycleObjects(capability, deadline); current();
    const guard = () => { current(); assertWindowsLifecycleCreation(created, capability); };
    const dir = join(initial.home, DIRECTORY), file = join(dir, FILE);
    guard();
    const lineage: Lineage = { schema: 1, lineage: randomUUID(), homeIdentity: digest(initial.home), directory: identity(dir), file: identity(file), journal: identity(file + "-journal") };
    const writer = (() => { try { guard(); return new DatabaseSync(file, { timeout: BUSY_MS }); } catch { fail("publication_unproved"); } })();
    const journal = new LifecycleJournal(file, lineage, owner, writer);
    let stage: BootstrapStage = "final_guard";
    let flushOutcome: { ok: boolean; errno?: BootstrapFlushErrno; closeErrno?: BootstrapFlushErrno } | undefined;
    // Windows FlushFileBuffers requires GENERIC_WRITE. This private closure is
    // limited to the two exact newly created objects from the source-owned proof;
    // generic flush(), existing files, Unix and readonly readers keep their modes.
    const flushCreated = (path: string) => {
      // CURRENT-stage fsync return only, never publication/close success or a
      // previous file's outcome. Reset before even the first admission check.
      flushOutcome = { ok: false };
      let fd: number | undefined, primaryError: unknown;
      const errno = (error: unknown): BootstrapFlushErrno => {
        const code = (error as NodeJS.ErrnoException)?.code;
        return BOOTSTRAP_FLUSH_ERRNOS.includes(code as BootstrapFlushErrno) ? code as BootstrapFlushErrno : "unknown";
      };
      try {
        guard(); if (path !== file && path !== file + "-journal") fail("writer_unknown");
        fd = openSync(path, "r+"); guard(); fsyncSync(fd); flushOutcome = { ok: true }; guard();
      } catch (error) {
        flushOutcome.errno = errno(error); primaryError = error;
      } finally {
        if (fd !== undefined) {
          try { closeSync(fd); }
          catch (error) { failedBootstrapFlushDescriptors.add(fd); flushOutcome.closeErrno = errno(error); primaryError ??= error; }
        }
      }
      if (primaryError !== undefined) throw primaryError;
    };
    try {
      guard(); stage = "configure"; configureWriter(writer, guard); stage = "final_guard"; guard();
      if (writer.prepare("PRAGMA journal_size_limit").get()?.journal_size_limit !== -1) fail("publication_unproved");
      guard(); stage = "schema"; writer.exec("BEGIN IMMEDIATE"); guard(); writer.exec(SCHEMA);
      guard(); writer.prepare("INSERT INTO lifecycle_lineage VALUES (1,?)").run(JSON.stringify(lineage));
      guard(); stage = "commit"; writer.exec("COMMIT"); stage = "final_guard"; guard();
      if (transactionState(writer)) fail("writer_unknown");
      // Actual file flush/reopen evidence only. No Windows directory power-loss claim.
      guard(); stage = "file_flush"; flushCreated(file); stage = "final_guard"; guard();
      stage = "journal_flush"; flushCreated(file + "-journal"); stage = "final_guard"; guard();
      stage = "readonly_lineage";
      const reader = readConnection(file, guard, undefined, journal.ownedReadonlyConnections, () => { journal.quarantined = true; });
      try {
        guard(); const row = reader.prepare("SELECT json FROM lifecycle_lineage WHERE singleton=1").get(); guard();
        if (!row || row.json !== JSON.stringify(lineage)) fail("lineage_unknown");
      } finally { closeReadConnection(reader); }
      stage = "final_guard"; guard(); return journal;
    } catch {
      // No accepted lifecycle command exists. Keep actual handles/files and any
      // unconfirmed transaction; no rollback, close, cleanup or second bootstrap.
      journal.quarantined = true; failedBootstrapJournals.add(journal);
      throw new LifecycleUnavailable("publication_unproved", stage, stage === "file_flush" || stage === "journal_flush" ? flushOutcome : undefined);
    }
  }

  static async bootstrap(home: string, owner: LifecycleInstance): Promise<LifecycleJournal> {
    instanceSchema.parse(owner);
    if (owner.pid !== process.pid || await readProcessIdentity(owner.pid) !== owner.creationIdentity) fail("writer_unknown");
    // No implicit Windows success from file fsync/reopen. Existing bootstrap establishment is under review.
    if (process.platform === "win32") fail("publication_unproved");
    privatePath(home, true);
    const physicalHome = realpathSync.native(home), dir = join(physicalHome, DIRECTORY), file = join(dir, FILE);
    // Exclusive first creation; an interrupted/replaced/missing existing journal is never re-created.
    try { mkdirSync(dir, { mode: 0o700 }); } catch { fail("lineage_unknown"); }
    privatePath(dir, true);
    const fd = openSync(file, "wx", 0o600); closeSync(fd);
    const journalFd = openSync(file + "-journal", "wx", 0o600); closeSync(journalFd);
    const lineage: Lineage = { schema: 1, lineage: randomUUID(), homeIdentity: digest(physicalHome), directory: identity(dir), file: identity(file), journal: identity(file + "-journal") };
    const writer = new DatabaseSync(file, { timeout: BUSY_MS });
    try {
      configureWriter(writer); writer.exec("BEGIN IMMEDIATE"); writer.exec(SCHEMA);
      writer.prepare("INSERT INTO lifecycle_lineage VALUES (1,?)").run(JSON.stringify(lineage)); writer.exec("COMMIT");
      if (transactionState(writer)) fail("writer_unknown");
      privatePath(file + "-journal", false); flush(file); flush(file + "-journal"); flush(dir); flush(physicalHome);
      const journal = new LifecycleJournal(file, lineage, owner, writer); journal.verifyLineage(); return journal;
    } catch {
      // No accepted lifecycle effect exists at bootstrap. Retain all files, never repair/rebootstrap.
      try { if (transactionState(writer)) writer.exec("ROLLBACK"); if (!transactionState(writer)) writer.close(); } catch { /* quarantine unresolved connection */ }
      fail("publication_unproved");
    }
  }
  private verifyLineage(): void {
    const guard = this.readerGuard(), reader = readConnection(this.file, guard, this.readerDeadline(), this.ownedReadonlyConnections, () => { this.quarantined = true; });
    try {
      guard?.();
      const row = reader.prepare("SELECT json FROM lifecycle_lineage WHERE singleton=1").get();
      guard?.();
      if (!row || String(row.json) !== JSON.stringify(this.lineage) || !same(this.lineage.directory, identity(dirname(this.file))) ||
          !same(this.lineage.file, identity(this.file)) || !same(this.lineage.journal, identity(this.file + "-journal"))) fail("lineage_unknown");
    } finally { closeReadConnection(reader); }
  }
  private read(id?: string): LifecycleReceipt | null {
    const guard = this.readerGuard(), reader = readConnection(this.file, guard, this.readerDeadline(), this.ownedReadonlyConnections, () => { this.quarantined = true; });
    try {
      guard?.();
      const row = id ? reader.prepare(`SELECT r.json,l.json AS lineage,
        r.restart_id AS receipt_id,r.revision AS receipt_revision,r.request_digest AS receipt_digest FROM lifecycle_lineage l LEFT JOIN receipt_revisions r
        ON r.restart_id=? AND r.revision=(SELECT max(revision) FROM receipt_revisions WHERE restart_id=?) WHERE l.singleton=1`).get(id, id)
        : reader.prepare(`SELECT r.json,l.json AS lineage,
          r.restart_id AS receipt_id,r.revision AS receipt_revision,r.request_digest AS receipt_digest,
          s.restart_id AS selected_id,s.revision AS selected_revision FROM lifecycle_lineage l LEFT JOIN selected_receipt s ON s.singleton=l.singleton
          LEFT JOIN receipt_revisions r ON r.restart_id=s.restart_id AND r.revision=s.revision WHERE l.singleton=1`).get();
      guard?.();
      if (!row || (String(row.lineage) !== JSON.stringify(this.lineage) || !same(this.lineage.directory, identity(dirname(this.file))) ||
          !same(this.lineage.file, identity(this.file)) || !same(this.lineage.journal, identity(this.file + "-journal")))) fail("lineage_unknown");
      if (id === undefined && !hasSelectedReceipt(row)) return null;
      return row.json === null ? null : receiptEnvelope(row, this.lineage.homeIdentity, id);
    } catch { fail("lineage_unknown"); }
    finally { closeReadConnection(reader); }
  }
  lookup(id: string): LifecycleReceipt | null { this.requireKnownWriter(); z.string().uuid().parse(id); this.verifyLineage(); return this.read(id); }
  selected(): LifecycleReceipt | null { this.requireKnownWriter(); this.verifyLineage(); return this.read(); }
  preparedReader(id: string): PreparedLifecycleReader { this.requireKnownWriter(); this.verifyLineage(); return new PreparedLifecycleReader(this.file, this.lineage, id); }
  get isQuarantined(): boolean { return this.quarantined; }
  private requireKnownWriter(): void { if (this.quarantined) fail("writer_unknown"); }
  private transaction<T>(deadline: number, work: () => T, committed: (value: T) => boolean,
    publication: Pick<WriteAttempt, "effect" | "restartId" | "revision" | "requestDigest">): T {
    if (this.quarantined) fail("writer_unknown");
    if (this.writeAttempt) fail("owner_unsupported");
    try { if (transactionState(this.writer)) fail("writer_unknown"); }
    catch { this.quarantined = true; fail("writer_unknown"); }
    if (performance.now() >= deadline) fail("budget");
    this.verifyLineage();
    const attempt: WriteAttempt = { ...publication, writer: this.writer, deadline,
      commit: "not_attempted", stage: "commit", observed: false, knownConflict: false };
    this.writeAttempt = attempt;
    if (this.servingPhase) this.servingPhase.write = attempt;
    try {
      this.writerExec("BEGIN IMMEDIATE"); const value = work();
      if (performance.now() >= deadline) fail("budget");
      this.writerExec("COMMIT");
      attempt.stage = "autocommit";
      if (performance.now() >= deadline) fail("budget");
      if (transactionState(this.writer)) fail("writer_unknown");
      if (performance.now() >= deadline) fail("budget");
      attempt.stage = "committed_read";
      if (!committed(value)) fail("writer_unknown");
      attempt.observed = true; attempt.stage = "final_deadline";
      if (performance.now() >= deadline) fail("budget");
      return value;
    } catch (error) {
      // Latch before any further observer/effect. COMMIT throw does not imply rollback.
      this.quarantined = true;
      let settled = false;
      try {
        if (attempt.commit !== "call_returned" && performance.now() < deadline) {
          if (transactionState(this.writer)) this.writerExec("ROLLBACK");
          if (!transactionState(this.writer) && performance.now() < deadline) { this.verifyLineage(); this.read(); settled = true; }
        }
      } catch { /* unresolved locks/visibility stay quarantined, without another BEGIN/COMMIT */ }
      // Only definitely local pre-COMMIT conflicts can resume. Commit/observation failures stay latched.
      if (attempt.commit !== "not_attempted") throw unconfirmedWrite(this, attempt, error);
      if (settled && error instanceof LifecycleUnavailable && ["revision_conflict", "receipt_conflict"].includes(error.reason)) this.quarantined = false;
      throw error instanceof LifecycleUnavailable ? error : new LifecycleUnavailable("writer_unknown");
    } finally { this.writeAttempt = undefined; }
  }
  admit(request: LifecycleRequest, deadline: number): LifecycleReceipt {
    const parsed = z.object({ restartId: z.string().uuid(), operation: z.enum(["restart", "stop"]), oldInstance: instanceSchema, target: targetSchema }).strict().parse(request);
    if (digest(parsed.oldInstance) !== digest(this.owner)) fail("writer_unknown");
    const requestDigest = digest(parsed), existing = this.lookup(parsed.restartId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        const json = JSON.stringify(parsed); if (Buffer.byteLength(json) > LIFECYCLE_METADATA_BYTES) fail("metadata_bound");
        this.transaction(deadline, () => {
          this.writerRun("INSERT INTO receipt_conflicts(restart_id,observed_digest,json) VALUES (?,?,?)", parsed.restartId, requestDigest, json);
          return requestDigest;
        }, value => {
          const guard = this.readerGuard(), reader = readConnection(this.file, guard, this.readerDeadline(), this.ownedReadonlyConnections, () => { this.quarantined = true; });
          try { guard?.(); const found = !!reader.prepare("SELECT 1 FROM receipt_conflicts WHERE restart_id=? AND observed_digest=? AND json=?").get(parsed.restartId, value, json); guard?.(); return found; }
          finally { closeReadConnection(reader); }
        }, { effect: "conflict", restartId: parsed.restartId, revision: existing.revision, requestDigest });
        // This is the deliberate refusal AFTER verified conflict evidence, not
        // an uncertain COMMIT labelled as a safe pre-COMMIT conflict.
        const conflict = this.servingPhase?.write;
        if (conflict?.effect === "conflict" && conflict.observed) conflict.knownConflict = true;
        fail("receipt_conflict");
      }
      return existing;
    }
    const selected = this.selected();
    if (selected && !["done", "failed_serving"].includes(selected.state)) fail("writer_unknown");
    const receipt: LifecycleReceipt = { ...parsed, schema: 1, homeIdentity: this.lineage.homeIdentity, state: "accepted", revision: 1,
      currentActor: { kind: "old", instance: { ...this.owner } }, actorGeneration: 1, requestDigest, acceptedAt: Date.now() };
    const json = bytes(receipt);
    return this.transaction(deadline, () => {
      this.writerRun("INSERT INTO receipt_revisions VALUES (?,?,?,?)", receipt.restartId, 1, requestDigest, json);
      this.writerRun("INSERT INTO selected_receipt VALUES (1,?,1) ON CONFLICT(singleton) DO UPDATE SET restart_id=excluded.restart_id,revision=excluded.revision", receipt.restartId);
      return receipt;
    }, value => this.lookup(value.restartId)?.requestDigest === requestDigest && this.selected()?.revision === 1,
      { effect: "admission", restartId: receipt.restartId, revision: 1, requestDigest });
  }
  advance(id: string, expectedRevision: number, state: LifecycleReceipt["state"], fields: Pick<LifecycleReceipt, "replacementInstance" | "checkpointManifest" | "failureCode">, deadline: number): LifecycleReceipt {
    const parsedState = z.enum(LIFECYCLE_STATES).safeParse(state), parsedFields = advanceFieldsSchema.safeParse(fields);
    if (!parsedState.success || !parsedFields.success) fail("revision_conflict");
    const previous = this.lookup(id);
    if (!previous || previous.revision !== expectedRevision || !sameLifecycleInstance(previous.oldInstance, this.owner) ||
        previous.currentActor.kind !== "old" || !sameLifecycleInstance(previous.currentActor.instance, this.owner) || previous.actorGeneration !== 1 ||
        !LIFECYCLE_NEXT[previous.state].includes(parsedState.data)) fail("revision_conflict");
    // Canonical-schema substage: census/closure/retirement and successor CAS proofs
    // are not wired. No public fields, checkpoint strings or row can substitute.
    if (LIFECYCLE_PROOF_REQUIRED.includes(parsedState.data)) fail("owner_unsupported");
    const parsedNext = receiptSchema.safeParse({ ...previous, ...parsedFields.data, state: parsedState.data, revision: expectedRevision + 1 });
    if (!parsedNext.success) fail("revision_conflict");
    const next = parsedNext.data, json = bytes(next);
    return this.transaction(deadline, () => {
      this.writerRun("INSERT INTO receipt_revisions VALUES (?,?,?,?)", id, next.revision, next.requestDigest, json);
      const changed = this.writerRun("UPDATE selected_receipt SET revision=? WHERE singleton=1 AND restart_id=? AND revision=?", next.revision, id, expectedRevision);
      if (changed.changes !== 1) fail("revision_conflict");
      return next;
    }, value => this.lookup(id)?.revision === value.revision && digest(this.selected()) === digest(value),
      { effect: "advance", restartId: id, revision: next.revision, requestDigest: next.requestDigest });
  }
  close(): boolean {
    if (this.quarantined) return false;
    // No forced close of an unresolved local transaction/lock.
    try { if (transactionState(this.writer)) return false; }
    catch { this.quarantined = true; return false; }
    this.writer.close(); return true;
  }
}
