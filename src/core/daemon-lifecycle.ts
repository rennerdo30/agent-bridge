import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readProcessIdentity } from "./process-identity.js";
import { assertLifecycleServingCapability, type LifecycleServingCapability } from "./broker.js";
import { createWindowsLifecycleObjects, assertWindowsLifecycleCreation, readOwnWindowsLifecycleIdentity } from "./lifecycle-windows.js";
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
function readConnection(file: string, exclusivelyNewGuard?: () => void): DatabaseSync {
  try { if (exclusivelyNewGuard) exclusivelyNewGuard(); else { privatePath(dirname(file), true); privatePath(file, false); privatePath(file + "-journal", false); } }
  catch { fail("lineage_unknown"); }
  const before = identity(file);
  let db: DatabaseSync;
  try { exclusivelyNewGuard?.(); db = new DatabaseSync(file, { readOnly: true, timeout: BUSY_MS }); }
  catch { fail("lineage_unknown"); } // Hot recovery requiring writes is not a prepared-reader exception.
  try {
    exclusivelyNewGuard?.(); db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;"); exclusivelyNewGuard?.();
    if (db.prepare("PRAGMA query_only").get()?.query_only !== 1 || !same(before, identity(file))) fail("lineage_unknown");
    return db;
  } catch { db.close(); fail("lineage_unknown"); }
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
  constructor(private readonly file: string, private readonly lineage: Lineage, private readonly restartId: string) {
    z.string().uuid().parse(restartId); this.db = readConnection(file);
  }
  read(): LifecycleReceipt {
    try {
      // One SELECT is one settled committed snapshot; no cursor/read transaction is retained.
      const row = this.db.prepare(`SELECT l.json AS lineage, r.json AS receipt FROM lifecycle_lineage l
        JOIN selected_receipt s ON s.singleton=l.singleton JOIN receipt_revisions r
        ON r.restart_id=s.restart_id AND r.revision=s.revision WHERE l.singleton=1 AND r.restart_id=?`).get(this.restartId);
      if (!row || JSON.stringify(JSON.parse(String(row.lineage))) !== JSON.stringify(this.lineage) ||
          !same(this.lineage.directory, identity(dirname(this.file))) || !same(this.lineage.file, identity(this.file)) ||
          !same(this.lineage.journal, identity(this.file + "-journal"))) fail("lineage_unknown");
      return receiptSchema.parse(JSON.parse(String(row.receipt)));
    } catch { fail("lineage_unknown"); }
  }
  close(): void { this.db.close(); }
}

// Source-owned quarantine retention, not a public force-dispose/recovery API.
const failedBootstrapJournals = new Set<LifecycleJournal>();
const failedBootstrapFlushDescriptors = new Set<number>();

/** Storage only. Dispatch/producer closure and pre-writable ownership guards belong to the coordinator; not yet wired. */
export class LifecycleJournal {
  private quarantined = false;
  private constructor(private readonly file: string, private readonly lineage: Lineage, private readonly owner: LifecycleInstance, private readonly writer: DatabaseSync) {}

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
      const reader = readConnection(file, guard);
      try {
        guard(); const row = reader.prepare("SELECT json FROM lifecycle_lineage WHERE singleton=1").get(); guard();
        if (!row || row.json !== JSON.stringify(lineage)) fail("lineage_unknown");
      } finally { reader.close(); }
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
    const reader = readConnection(this.file);
    try {
      const row = reader.prepare("SELECT json FROM lifecycle_lineage WHERE singleton=1").get();
      if (!row || String(row.json) !== JSON.stringify(this.lineage) || !same(this.lineage.directory, identity(dirname(this.file))) ||
          !same(this.lineage.file, identity(this.file)) || !same(this.lineage.journal, identity(this.file + "-journal"))) fail("lineage_unknown");
    } finally { reader.close(); }
  }
  private read(id?: string): LifecycleReceipt | null {
    const reader = readConnection(this.file);
    try {
      const row = id ? reader.prepare(`SELECT r.json,l.json AS lineage FROM lifecycle_lineage l LEFT JOIN receipt_revisions r
        ON r.restart_id=? AND r.revision=(SELECT max(revision) FROM receipt_revisions WHERE restart_id=?) WHERE l.singleton=1`).get(id, id)
        : reader.prepare(`SELECT r.json,l.json AS lineage FROM lifecycle_lineage l LEFT JOIN selected_receipt s ON s.singleton=l.singleton
          LEFT JOIN receipt_revisions r ON r.restart_id=s.restart_id AND r.revision=s.revision WHERE l.singleton=1`).get();
      if (!row || (String(row.lineage) !== JSON.stringify(this.lineage) || !same(this.lineage.directory, identity(dirname(this.file))) ||
          !same(this.lineage.file, identity(this.file)) || !same(this.lineage.journal, identity(this.file + "-journal")))) fail("lineage_unknown");
      return row.json === null ? null : receiptSchema.parse(JSON.parse(String(row.json)));
    } catch { fail("lineage_unknown"); }
    finally { reader.close(); }
  }
  lookup(id: string): LifecycleReceipt | null { this.requireKnownWriter(); z.string().uuid().parse(id); this.verifyLineage(); return this.read(id); }
  selected(): LifecycleReceipt | null { this.requireKnownWriter(); this.verifyLineage(); return this.read(); }
  preparedReader(id: string): PreparedLifecycleReader { this.requireKnownWriter(); this.verifyLineage(); return new PreparedLifecycleReader(this.file, this.lineage, id); }
  get isQuarantined(): boolean { return this.quarantined; }
  private requireKnownWriter(): void { if (this.quarantined) fail("writer_unknown"); }
  private transaction<T>(deadline: number, work: () => T, committed: (value: T) => boolean): T {
    if (this.quarantined) fail("writer_unknown");
    try { if (transactionState(this.writer)) fail("writer_unknown"); }
    catch { this.quarantined = true; fail("writer_unknown"); }
    if (performance.now() >= deadline) fail("budget");
    this.verifyLineage();
    try {
      this.writer.exec("BEGIN IMMEDIATE"); const value = work();
      if (performance.now() >= deadline) fail("budget");
      this.writer.exec("COMMIT");
      if (transactionState(this.writer) || performance.now() >= deadline || !committed(value)) fail("writer_unknown");
      return value;
    } catch (error) {
      // Latch before any further observer/effect. COMMIT throw does not imply rollback.
      this.quarantined = true;
      let settled = false;
      try {
        if (performance.now() < deadline) {
          if (transactionState(this.writer)) this.writer.exec("ROLLBACK");
          if (!transactionState(this.writer) && performance.now() < deadline) { this.verifyLineage(); this.read(); settled = true; }
        }
      } catch { /* unresolved locks/visibility stay quarantined, without another BEGIN/COMMIT */ }
      // Only definitely local pre-COMMIT conflicts can resume. Commit/observation failures stay latched.
      if (settled && error instanceof LifecycleUnavailable && ["revision_conflict", "receipt_conflict"].includes(error.reason)) this.quarantined = false;
      throw error instanceof LifecycleUnavailable ? error : new LifecycleUnavailable("writer_unknown");
    }
  }
  admit(request: LifecycleRequest, deadline: number): LifecycleReceipt {
    const parsed = z.object({ restartId: z.string().uuid(), operation: z.enum(["restart", "stop"]), oldInstance: instanceSchema, target: targetSchema }).strict().parse(request);
    if (digest(parsed.oldInstance) !== digest(this.owner)) fail("writer_unknown");
    const requestDigest = digest(parsed), existing = this.lookup(parsed.restartId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        const json = JSON.stringify(parsed); if (Buffer.byteLength(json) > LIFECYCLE_METADATA_BYTES) fail("metadata_bound");
        this.transaction(deadline, () => {
          this.writer.prepare("INSERT INTO receipt_conflicts(restart_id,observed_digest,json) VALUES (?,?,?)").run(parsed.restartId, requestDigest, json);
          return requestDigest;
        }, value => {
          const reader = readConnection(this.file);
          try { return !!reader.prepare("SELECT 1 FROM receipt_conflicts WHERE restart_id=? AND observed_digest=? AND json=?").get(parsed.restartId, value, json); }
          finally { reader.close(); }
        });
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
      this.writer.prepare("INSERT INTO receipt_revisions VALUES (?,?,?,?)").run(receipt.restartId, 1, requestDigest, json);
      this.writer.prepare("INSERT INTO selected_receipt VALUES (1,?,1) ON CONFLICT(singleton) DO UPDATE SET restart_id=excluded.restart_id,revision=excluded.revision").run(receipt.restartId);
      return receipt;
    }, value => this.lookup(value.restartId)?.requestDigest === requestDigest && this.selected()?.revision === 1);
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
      this.writer.prepare("INSERT INTO receipt_revisions VALUES (?,?,?,?)").run(id, next.revision, next.requestDigest, json);
      const changed = this.writer.prepare("UPDATE selected_receipt SET revision=? WHERE singleton=1 AND restart_id=? AND revision=?").run(next.revision, id, expectedRevision);
      if (changed.changes !== 1) fail("revision_conflict");
      return next;
    }, value => this.lookup(id)?.revision === value.revision && digest(this.selected()) === digest(value));
  }
  close(): boolean {
    if (this.quarantined) return false;
    // No forced close of an unresolved local transaction/lock.
    try { if (transactionState(this.writer)) return false; }
    catch { this.quarantined = true; return false; }
    this.writer.close(); return true;
  }
}
