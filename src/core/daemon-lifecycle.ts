import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { readProcessIdentity } from "./process-identity.js";

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
const instanceSchema = z.object({ nonce: z.string().uuid(), pid: z.number().int().positive(), creationIdentity: z.string().min(1).max(256) }).strict();
const targetSchema = z.object({ immutableRuntimePath: z.string().min(1).max(4096), version: z.string().min(1).max(128),
  protocol: z.number().int().positive(), fileManifestDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const states = ["accepted", "preparing", "draining", "prepared", "release_committed", "binding", "done", "failed_serving", "unavailable", "unknown", "stop_committed", "stopped"] as const;
const receiptSchema = z.object({ schema: z.literal(1), restartId: z.string().uuid(), operation: z.enum(["restart", "stop"]),
  homeIdentity: z.string().regex(/^[a-f0-9]{64}$/), oldInstance: instanceSchema, target: targetSchema,
  state: z.enum(states), revision: z.number().int().positive(), requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  acceptedAt: z.number().int().nonnegative(), replacementInstance: instanceSchema.optional(),
  checkpointManifest: z.object({ closureDigest: z.string().regex(/^[a-f0-9]{64}$/),
    owners: z.array(z.object({ ownerId: z.string().min(1).max(128), checkpointRevision: z.string().min(1).max(128),
      durabilityEvidence: z.string().min(1).max(1024), ownershipReleaseEvidence: z.string().min(1).max(1024) }).strict()).max(128) }).strict().optional(),
  failureCode: z.string().regex(/^[a-z_]+(?::[a-z_]+)?$/).max(128).optional(),
}).strict();
export type LifecycleInstance = z.infer<typeof instanceSchema>;
export type LifecycleReceipt = z.infer<typeof receiptSchema>;
export type LifecycleRequest = Pick<LifecycleReceipt, "restartId" | "operation" | "oldInstance" | "target">;
export class LifecycleUnavailable extends Error {
  constructor(readonly reason: "private_path" | "publication_unproved" | "lineage_unknown" | "writer_unknown" | "revision_conflict" | "receipt_conflict" | "budget" | "metadata_bound") { super(`Core lifecycle unavailable: ${reason}.`); }
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
interface FileIdentity { dev: number; ino: number }
interface Lineage { schema: 1; lineage: string; homeIdentity: string; directory: FileIdentity; file: FileIdentity; journal: FileIdentity }
function identity(path: string): FileIdentity { const stat = lstatSync(path); return { dev: stat.dev, ino: stat.ino }; }
function same(a: FileIdentity, b: FileIdentity): boolean { return a.dev === b.dev && a.ino === b.ino; }
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
function configureWriter(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout=${BUSY_MS}; PRAGMA journal_mode=PERSIST; PRAGMA journal_size_limit=-1; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;`);
  if (process.platform === "darwin") db.exec("PRAGMA fullfsync=ON");
  if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "persist" || db.prepare("PRAGMA synchronous").get()?.synchronous !== 2 ||
      db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1 || db.prepare("PRAGMA trusted_schema").get()?.trusted_schema !== 0 ||
      (process.platform === "darwin" && db.prepare("PRAGMA fullfsync").get()?.fullfsync !== 1)) fail("publication_unproved");
}
function readConnection(file: string): DatabaseSync {
  try { privatePath(dirname(file), true); privatePath(file, false); privatePath(file + "-journal", false); }
  catch { fail("lineage_unknown"); }
  const before = identity(file);
  const db = new DatabaseSync(file, { readOnly: true, timeout: BUSY_MS });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
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
const NEXT: Record<LifecycleReceipt["state"], readonly LifecycleReceipt["state"][]> = {
  accepted: ["preparing", "draining", "failed_serving", "unknown"], preparing: ["draining", "failed_serving", "unknown"],
  draining: ["prepared", "failed_serving", "unknown"], prepared: ["release_committed", "stop_committed", "failed_serving", "unknown"],
  release_committed: ["binding", "unavailable", "unknown"], binding: ["done", "unavailable", "unknown"],
  stop_committed: ["stopped", "unknown"], done: [], failed_serving: [], unavailable: [], unknown: [], stopped: [],
};

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

/** Storage only. Dispatch/producer closure and pre-writable ownership guards belong to the coordinator; not yet wired. */
export class LifecycleJournal {
  private quarantined = false;
  private constructor(private readonly file: string, private readonly lineage: Lineage, private readonly owner: LifecycleInstance, private readonly writer: DatabaseSync) {}

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
  lookup(id: string): LifecycleReceipt | null { z.string().uuid().parse(id); this.verifyLineage(); return this.read(id); }
  selected(): LifecycleReceipt | null { this.verifyLineage(); return this.read(); }
  preparedReader(id: string): PreparedLifecycleReader { this.verifyLineage(); return new PreparedLifecycleReader(this.file, this.lineage, id); }
  get isQuarantined(): boolean { return this.quarantined; }
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
    const receipt: LifecycleReceipt = { ...parsed, schema: 1, homeIdentity: this.lineage.homeIdentity, state: "accepted", revision: 1, requestDigest, acceptedAt: Date.now() };
    const json = bytes(receipt);
    return this.transaction(deadline, () => {
      this.writer.prepare("INSERT INTO receipt_revisions VALUES (?,?,?,?)").run(receipt.restartId, 1, requestDigest, json);
      this.writer.prepare("INSERT INTO selected_receipt VALUES (1,?,1) ON CONFLICT(singleton) DO UPDATE SET restart_id=excluded.restart_id,revision=excluded.revision").run(receipt.restartId);
      return receipt;
    }, value => this.lookup(value.restartId)?.requestDigest === requestDigest && this.selected()?.revision === 1);
  }
  advance(id: string, expectedRevision: number, state: LifecycleReceipt["state"], fields: Pick<LifecycleReceipt, "replacementInstance" | "checkpointManifest" | "failureCode">, deadline: number): LifecycleReceipt {
    const previous = this.lookup(id);
    if (!previous || previous.revision !== expectedRevision || digest(previous.oldInstance) !== digest(this.owner) || !NEXT[previous.state].includes(state)) fail("revision_conflict");
    if (["release_committed", "stop_committed", "binding", "done", "stopped"].includes(state) && !previous.checkpointManifest && !fields.checkpointManifest) fail("writer_unknown");
    const next = receiptSchema.parse({ ...previous, ...fields, state, revision: expectedRevision + 1 }), json = bytes(next);
    return this.transaction(deadline, () => {
      this.writer.prepare("INSERT INTO receipt_revisions VALUES (?,?,?,?)").run(id, next.revision, next.requestDigest, json);
      const changed = this.writer.prepare("UPDATE selected_receipt SET revision=? WHERE singleton=1 AND restart_id=? AND revision=?").run(next.revision, id, expectedRevision);
      if (changed.changes !== 1) fail("revision_conflict");
      return next;
    }, value => this.lookup(id)?.revision === value.revision && digest(this.selected()) === digest(value));
  }
  close(): boolean {
    // No forced close of an unresolved local transaction/lock.
    try { if (transactionState(this.writer)) return false; }
    catch { this.quarantined = true; return false; }
    this.writer.close(); return true;
  }
}
