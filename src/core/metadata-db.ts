import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { metadataFileLease } from "./metadata-file-lease.js";
import { liveStorePeers, metadataRelease } from "./store-compatibility.js";
import { assertCompatibleMailboxReaders, hasMaintenanceExclusion, maintenanceLock, storageLease, withMaintenanceExclusion } from "./storage-lock.js";
import { snapshotMetadataTables } from "./metadata-snapshot.js";
import { METADATA_COMPONENT_VERSION } from "./store-version.js";
import { assertCurrentMailboxEnvelope, preflightMessagingHome, offlineMetadataAdmitted, withOfflineMetadataAdmission, inspectMailbox, assertMessagingLayout, assertSqliteFamily } from "./mailbox-layout.js";
import { admissionSqliteBusy, storageAdmissionRemaining, storageAdmissionTimeout, withStorageAdmission } from "./storage-admission.js";
import { assertSqliteAuthority, configureSqlite } from "./sqlite-policy.js";
import { attachStoreCompatibility } from "./store-compatibility-overlay.js";
import { snapshotDatabase, ensureMessageQuarantine } from "./sqlite-maintenance.js";
import { ownProcessIdentity } from "./process-identity.js";
import { nullLogger } from "./logger.js";
export { withOfflineMetadataAdmission, type OfflineMetadataAdmission } from "./mailbox-layout.js";

const VERSION = METADATA_COMPONENT_VERSION;
const connections = new Map<string, DatabaseSync>();
type MetadataAdmissionIdentity = { home: string; file: string };
const lifecycleAdmissions = new WeakMap<DatabaseSync, MetadataAdmissionIdentity | null>();
const readers = new Map<string,number>();
let lifecycleRegistryGeneration = 0;
let lifecycleRegistryUnknown = false;
// Shadow bookkeeping only. It never gates ordinary admission, SQL or teardown.
// Successful legacy closes remain in the WeakMap; failed/unknown references stay
// strongly retained, INCLUDING overflow. Manifest bounds limit observation,
// never registration/retention of actual native references or failed attempts.
const CLOSE_MEMBERS = 128, CLOSE_BYTES = 64 * 1024;
type HandleOutcome = "unattempted" | "attempted" | "closed" | "failed" | "unknown";
type ShadowHandle = {
 db: DatabaseSync; file: string; id: bigint; admission: MetadataAdmissionIdentity | null;
 admissionGeneration: number; escaped: boolean; outcome: HandleOutcome;
 schemaGeneration: null; // Unproved without separately reviewed non-recovering schema coverage.
};
type ShadowLease = { id: bigint; target: string; kind: "migration" | "write"; acquiredGeneration: number;
 acquire: () => () => void; release?: () => void; outcome: "acquiring" | "held" | "returned" | "threw" };
const shadowHandles = new WeakMap<DatabaseSync, ShadowHandle>();
const retainedHandles = new Map<bigint, ShadowHandle>();
const shadowLeases = new Set<ShadowLease>();
let nextHandleId = 0n, nextLeaseId = 0n, admissionGeneration = 0, consumerGeneration = 0, leaseGeneration = 0;
let shadowUnknown = false, leaseReturns = 0, legacyCloseReturns = 0;
let retainedHandleFailures = 0, retainedLeaseFailures = 0;
function bump(value: number): number {
 if (value >= Number.MAX_SAFE_INTEGER) { shadowUnknown = true; return value; }
 return value + 1;
}
function shadowAdmission(db: DatabaseSync, file: string): void {
 admissionGeneration = bump(admissionGeneration);
 const record: ShadowHandle = { db, file, id: ++nextHandleId, admission: lifecycleAdmissions.get(db) ?? null,
  admissionGeneration, escaped: false, outcome: "unattempted", schemaGeneration: null };
 shadowHandles.set(db, record); retainedHandles.set(record.id, record);
}
function escapeMetadataReference(db: DatabaseSync): DatabaseSync {
 const record = shadowHandles.get(db);
 if (!record) shadowUnknown = true;
 else if (!record.escaped) { record.escaped = true; consumerGeneration = bump(consumerGeneration); }
 return db;
}
function legacyMetadataClose(db: DatabaseSync): void {
 const record = shadowHandles.get(db);
 const wasFailed = record?.outcome === "failed";
 if (record) record.outcome = "attempted";
 try {
  db.close();
  if (record) { record.outcome = "closed"; retainedHandles.delete(record.id); if (wasFailed) retainedHandleFailures--; }
  legacyCloseReturns = bump(legacyCloseReturns);
 } catch (error) {
  if (record) { record.outcome = "failed"; if (!wasFailed) retainedHandleFailures = bump(retainedHandleFailures); }
  throw error;
 }
 // Return from legacy close is NOT source-owned consumer invalidation or a
 // lifecycle retirement proof. No ordinary behavior is changed by this ledger.
}
function observedMetadataLease(target: string, kind: ShadowLease["kind"], acquire: () => () => void): () => void {
 leaseGeneration = bump(leaseGeneration);
 const record: ShadowLease = { id: ++nextLeaseId, target, kind, acquiredGeneration: leaseGeneration, acquire, outcome: "acquiring" };
 shadowLeases.add(record);
 let release: () => void;
 try { release = acquire(); record.release = release; record.outcome = "held"; }
 catch (error) { record.outcome = "threw"; retainedLeaseFailures = bump(retainedLeaseFailures); leaseGeneration = bump(leaseGeneration); throw error; }
 return () => {
  const wasFailed = record.outcome === "threw";
  try { release(); record.outcome = "returned"; leaseReturns = bump(leaseReturns); shadowLeases.delete(record); if (wasFailed) retainedLeaseFailures--; }
  catch (error) { record.outcome = "threw"; if (!wasFailed) retainedLeaseFailures = bump(retainedLeaseFailures); throw error; }
  finally { leaseGeneration = bump(leaseGeneration); }
 };
 // The callback API supplies no exact nonce/boot/thread release acknowledgement.
 // Returned is an actual call outcome, never self-certified ownership release.
}
function changeLifecycleRegistry(): void {
 if (lifecycleRegistryGeneration >= Number.MAX_SAFE_INTEGER) lifecycleRegistryUnknown = true;
 else lifecycleRegistryGeneration++;
}
function observeExistingMetadataAdmission(file: string): MetadataAdmissionIdentity | null {
 try {
  physicalMetadataPath(file);
  const stat = lstatSync(file, { bigint: true }), home = lstatSync(dirname(file), { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || !home.isDirectory() || home.isSymbolicLink() ||
    stat.ino <= 0n || home.ino <= 0n || stat.dev < 0n || home.dev < 0n || process.platform === "win32" && (stat.dev === 0n || home.dev === 0n)) return null;
  return { home: `${home.dev}:${home.ino}:${home.birthtimeNs}`, file: `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` };
 } catch { return null; }
}
function recordMetadataAdmission(db: DatabaseSync, file: string, before: MetadataAdmissionIdentity | null): void {
 const after = observeExistingMetadataAdmission(file);
 // Consistent observation around an EXISTING open is not native fstat of SQLite's
 // handle. Absent/changed/unprovable initial bindings stay unknown; never backfill.
 lifecycleAdmissions.set(db, before && after && before.home === after.home && before.file === after.file ? before : null);
 shadowAdmission(db, file);
}
// Windows paths are case-insensitive: one handle per physical file, whatever spelling of home a caller passes.
const handleKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS bridge_components (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS worktree_leases (
 key TEXT PRIMARY KEY, path TEXT, pid INTEGER, identity TEXT, job_id TEXT,
 nonce TEXT NOT NULL, acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL,
 archived_at INTEGER, archive_reason TEXT, legacy_path TEXT
);
CREATE TABLE IF NOT EXISTS worktree_lease_archive (
 nonce TEXT PRIMARY KEY, key TEXT NOT NULL, path TEXT, pid INTEGER, identity TEXT, job_id TEXT,
 acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL,
 archived_at INTEGER NOT NULL, archive_reason TEXT NOT NULL, legacy_path TEXT
);
CREATE TABLE IF NOT EXISTS bridge_metadata (
 domain TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(domain,key)
);
CREATE TABLE IF NOT EXISTS bridge_read_receipts (
 identity TEXT NOT NULL, message_id TEXT NOT NULL, read_at INTEGER,
 PRIMARY KEY(identity,message_id)
);
CREATE TABLE IF NOT EXISTS bridge_imports (
 path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
 bundle TEXT NOT NULL, cold_path TEXT NOT NULL, imported_at INTEGER NOT NULL
);
INSERT INTO bridge_components(name,version) VALUES ('metadata',7)
 ON CONFLICT(name) DO UPDATE SET version=excluded.version;
`;

/** Refuse every link in the path, including a linked database leaf. */
export function physicalMetadataPath(path: string): void {
 let current = resolve(path);
 for (;;) {
  try { if (lstatSync(current).isSymbolicLink()) throw new Error(`Linked storage path retained: ${current}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const parent = dirname(current);
  if (parent === current) return;
  current = parent;
 }
}

/** Observe an already admitted component without starting a competing migration. */
export function existingMetadataDb(home: string): DatabaseSync | undefined {
 storageAdmissionRemaining();
 preflightMessagingHome(home);
 const file = join(resolve(home),"bridge.db"), cached = connections.get(handleKey(file));
 const present=assertSqliteFamily(file);
 if (cached) { if(!present)throw Object.assign(new Error('Cached metadata family is absent; retained handle unavailable'),{code:'STORE_LAYOUT_UNSUPPORTED'});admissionSqliteBusy(cached);assertSqliteAuthority(cached);storageAdmissionRemaining();return escapeMetadataReference(cached); }
 if (!existsSync(file)) return undefined;
 physicalMetadataPath(file);
 const admission = observeExistingMetadataAdmission(file);
 const db = new DatabaseSync(file,{timeout:storageAdmissionTimeout(5_000)});
 recordMetadataAdmission(db, file, admission);
 try {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get() ||
    Number(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) !== VERSION) { legacyMetadataClose(db); return undefined; }
  configureSqlite(db,5_000); connections.set(handleKey(file),db); changeLifecycleRegistry(); return escapeMetadataReference(db);
 } catch (error) { legacyMetadataClose(db); throw error; }
}

/** Old readers must finish naturally before their file-backed domains change authority. */
export function assertMetadataAdmission(home: string): void {
 assertCompatibleMailboxReaders(home);
 if (offlineMetadataAdmitted(home)) return;
 const blockers = liveStorePeers(home).filter(peer => !metadataRelease(peer.version));
 if (blockers.length) throw Object.assign(new Error(`Waiting for metadata upgrade: ${blockers.map(p => `${p.name} (v${p.version}, pid ${p.pid})`).join(", ")}. Existing readers keep their files.`), { code: "STORE_UPGRADE_DEFERRED" });
}

/** Additive component versioning leaves AB-206's global user_version untouched. */
/** Same backup-first component initializer for an explicitly selected owned connection. */
function initializeMetadataComponent(db: DatabaseSync, home:string, file:string, existed:boolean, inMigrationTransaction=false):void {
  admissionSqliteBusy(db,5_000,true);
  const version = () => db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get()
   ? Number(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) : 0;
  if (version() > VERSION) throw new Error("Metadata store is newer than this reader; retained unchanged.");
  if (version() < VERSION) {
   assertMetadataAdmission(home);
   if (version() > 0 && !offlineMetadataAdmitted(home)) throw Object.assign(new Error('Explicit offline isolated metadata migration required'), {code:'STORE_OFFLINE_REQUIRED'});
   if(inMigrationTransaction){
    // The offline caller has already verified/retained its immutable full input
    // snapshot and owns this schema transaction under maintenance exclusion.
    // Use the SAME metadata DDL before ready/proof, without an intermediate m7
    // commit or attempting a nested backup/transaction.
    if(!offlineMetadataAdmitted(home)||!hasMaintenanceExclusion(home)||!db.isTransaction)throw migrationRefusal('Metadata migration transaction is not owned');
    storageAdmissionRemaining();db.exec(SCHEMA);storageAdmissionRemaining();return;
   }
   const exclusion = hasMaintenanceExclusion(home) ? undefined : maintenanceLock(home,true,true);
   let release: (() => void) | undefined;
   try {
    release = observedMetadataLease(`${file}.metadata-migration`, "migration", () => metadataFileLease(`${file}.metadata-migration`, storageAdmissionTimeout(5_000)));
    storageAdmissionRemaining(); preflightMessagingHome(home,file); assertMetadataAdmission(home);
    if (version() < VERSION) {
     if (existed) {
      const dir = join(home, ".migration-snapshots");
      physicalMetadataPath(dir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const backup = join(dir, `metadata-v${VERSION}-${randomUUID()}.db`);
      snapshotMetadataTables(db,backup,["bridge_components","worktree_leases","worktree_lease_archive","bridge_metadata","bridge_read_receipts","bridge_imports","job_checklist","project_checklist"],"metadata",VERSION);
     }
     storageAdmissionRemaining(); configureSqlite(db,5_000);
     db.exec("BEGIN IMMEDIATE");
     try { storageAdmissionRemaining(); db.exec(SCHEMA); }
     catch (error) { db.exec("ROLLBACK"); throw error; }
     // A COMMIT error is unknown. Close the owned handle, retain snapshots and
     // inspect the exact component/attempt on an explicit reopen; never retry an effect.
     storageAdmissionRemaining(); db.exec("COMMIT");
     storageAdmissionRemaining();
    }
   } finally { try { release?.(); } finally { exclusion?.(); } }
  }
  configureSqlite(db,5_000);
}

export function metadataDb(home: string): DatabaseSync {
 storageAdmissionRemaining();
 preflightMessagingHome(home);
 const file = join(resolve(home), "bridge.db");
 const present=assertSqliteFamily(file);
 const cached = connections.get(handleKey(file));
 if (cached) { if(!present)throw Object.assign(new Error('Cached metadata family is absent; retained handle unavailable'),{code:'STORE_LAYOUT_UNSUPPORTED'});admissionSqliteBusy(cached);assertSqliteAuthority(cached);storageAdmissionRemaining();return escapeMetadataReference(cached); }
 physicalMetadataPath(file);
 mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
 const existed = existsSync(file);
 const admission = observeExistingMetadataAdmission(file);
 const db = new DatabaseSync(file, { timeout: storageAdmissionTimeout(5_000) });
 recordMetadataAdmission(db, file, admission);
 try {
  initializeMetadataComponent(db,home,file,existed);
  connections.set(handleKey(file), db);
  changeLifecycleRegistry();
  return escapeMetadataReference(db);
 } catch (error) { legacyMetadataClose(db); throw error; }
}

export function closeMetadataDb(home: string): void {
 const file = join(resolve(home), "bridge.db"), db = connections.get(handleKey(file));
 if (db) { changeLifecycleRegistry(); legacyMetadataClose(db); connections.delete(handleKey(file)); }
}

/** Bridge nodes share one handle per home and close it when the last node stops. */
export function retainMetadataReader(home: string): () => void {
 const key = handleKey(resolve(home)); readers.set(key,(readers.get(key) ?? 0)+1); changeLifecycleRegistry();
 let released = false;
 return () => {
  if (released) return; released = true;
  changeLifecycleRegistry();
  const count = (readers.get(key) ?? 1)-1;
  if (count > 0) readers.set(key,count);
  else { readers.delete(key); closeMetadataDb(home); }
 };
}

/** Whether this process currently caches an open metadata handle for home. */
export function metadataDbOpen(home: string): boolean {
 return connections.has(handleKey(join(resolve(home), "bridge.db")));
}

/** Whether a live bridge node in this process still shares the metadata handle for home. */
export function metadataReaderRetained(home: string): boolean {
 return (readers.get(handleKey(resolve(home))) ?? 0) > 0;
}

export function metadataValue(home: string, domain: string, key: string): unknown {
 const row = metadataDb(home).prepare("SELECT value FROM bridge_metadata WHERE domain=? AND key=?").get(domain,key);
 return row ? JSON.parse(String(row.value)) : null;
}

/** Close this process's metadata readers during shutdown or fixture teardown. */
export function closeMetadataDbs(): void {
 changeLifecycleRegistry();
 for (const db of connections.values()) legacyMetadataClose(db);
 connections.clear();
}

export type MetadataCloseBlocker = "bound" | "budget" | "registry_changed" | "registry_unknown" |
 "identity_unknown" | "transaction_active" | "transaction_unknown" | "durability_unknown" | "schema_unknown" |
 "consumer_unknown" | "readers_retained" | "lease_active" | "lease_unknown" |
 "handle_unknown" | "wal_pressure_unproved" | "nonrecovering_read_unproved";
/** Nonsecret, immutable observation, never a seal/candidate/intent/retirement grant. */
export interface MetadataCloseObservation {
 readonly authority: false;
 readonly reason: "owner_unsupported";
 readonly handlesRetained: true;
 readonly ownershipReleased: false;
 readonly registryGeneration: number;
 readonly admissionGeneration: number;
 readonly consumerGeneration: number;
 readonly leaseGeneration: number;
 readonly blockers: readonly MetadataCloseBlocker[];
 readonly membershipDigest: string | null;
 readonly schemaDigest: null;
 /** Status counts cover observedHandles only. Reader counts saturate at129;
  * null means that census was not fully inspected. */
 readonly outcomes: Readonly<{ registeredHandles: number; observedHandles: number; retainedReaders: number | null; activeLeases: number | null;
  unattempted: number; attempted: number; failed: number; unknown: number;
  legacyCloseReturns: number; leaseCallbackReturns: number;
  /** Unresolved failure counts include ALL retained overflow records, without enumerating them. */
  retainedHandleFailures: number; retainedLeaseFailures: number }>;
}

/** Private bookkeeping and native in-memory autocommit observation ONLY.
 * The ORIGINAL shared write2s/aggregate10s deadline is never extended.
 * No independently proved non-recovering path covers every admitted schema and
 * sidecar. Thus even cached RW PRAGMA/prepare calls are prohibited: a page read
 * could roll back a hot journal. No SQL, new reader, filesystem probe, checkpoint,
 * policy change, close/release, seal, initializer, reopen or repair is issued.
 * Schema/policy/WAL/current physical binding remain explicitly unproved.
 * Membership digests describe private bookkeeping, never a complete owner census.
 */
export function observeMetadataClosePrerequisites(originalDeadline: number): MetadataCloseObservation {
 const started = performance.now(), deadline = Number.isFinite(originalDeadline) ? Math.min(originalDeadline, started + 2000) : NaN;
 const registry = lifecycleRegistryGeneration, admissions = admissionGeneration,
  consumers = consumerGeneration, leases = leaseGeneration;
 const blockers = new Set<MetadataCloseBlocker>();
 const outcomes: { registeredHandles: number; observedHandles: number; retainedReaders: number | null; activeLeases: number | null;
  unattempted: number; attempted: number; failed: number; unknown: number; legacyCloseReturns: number; leaseCallbackReturns: number;
  retainedHandleFailures: number; retainedLeaseFailures: number } = {
  registeredHandles: retainedHandles.size, observedHandles: 0, retainedReaders: null, activeLeases: null,
  unattempted: 0, attempted: 0, failed: 0, unknown: 0, legacyCloseReturns, leaseCallbackReturns: leaseReturns,
  retainedHandleFailures, retainedLeaseFailures };
 let membershipDigest: string | null = null;
 const current = () => {
  if (registry !== lifecycleRegistryGeneration || admissions !== admissionGeneration ||
   consumers !== consumerGeneration || leases !== leaseGeneration) { blockers.add("registry_changed"); return false; }
  return true;
 };
 const timely = () => {
  if (!Number.isFinite(originalDeadline) || performance.now() >= deadline) { blockers.add("budget"); return false; }
  return true;
 };
 const finish = (): MetadataCloseObservation => {
  current(); timely();
  if (shadowUnknown || lifecycleRegistryUnknown) blockers.add("registry_unknown");
  if (blockers.has("bound") || blockers.has("registry_unknown") || blockers.has("registry_changed") || blockers.has("budget")) {
   membershipDigest = null; outcomes.retainedReaders = null; outcomes.activeLeases = null;
  }
  return Object.freeze({ authority: false, reason: "owner_unsupported", handlesRetained: true, ownershipReleased: false,
   registryGeneration: registry, admissionGeneration: admissions, consumerGeneration: consumers, leaseGeneration: leases,
   blockers: Object.freeze([...blockers].sort()), membershipDigest, schemaDigest: null, outcomes: Object.freeze(outcomes) });
 };
 if (!timely()) return finish();
 if (retainedHandles.size || connections.size) {
  blockers.add("identity_unknown"); blockers.add("schema_unknown"); blockers.add("durability_unknown");
  blockers.add("wal_pressure_unproved"); blockers.add("nonrecovering_read_unproved");
 }
 if (shadowLeases.size || leaseReturns) blockers.add("lease_unknown");
 if (retainedHandles.size + readers.size + shadowLeases.size > CLOSE_MEMBERS || connections.size > CLOSE_MEMBERS) {
  blockers.add("bound"); return finish(); // Keep ALL private overflow references; do not enumerate/truncate them.
 }
 const membership: string[] = [];
 let bytes = 2;
 const bounded = (value: unknown): string | null => {
  if (!timely() || !current()) return null;
  const encoded = JSON.stringify(value); bytes += Buffer.byteLength(encoded, "utf8") + 1;
  if (bytes > CLOSE_BYTES) { blockers.add("bound"); return null; }
  return encoded;
 };
 outcomes.retainedReaders = 0; outcomes.activeLeases = 0;
 for (const [key, count] of readers) {
  outcomes.retainedReaders = Math.min(CLOSE_MEMBERS + 1, outcomes.retainedReaders + count);
  const member = bounded(["reader", key, count]); if (!member) return finish(); membership.push(member);
 }
 if (outcomes.retainedReaders) blockers.add("readers_retained");
 for (const lease of shadowLeases) {
  if (lease.outcome === "acquiring" || lease.outcome === "held") { outcomes.activeLeases++; blockers.add("lease_active"); }
  blockers.add("lease_unknown"); // Callback APIs provide no exact nonce/boot/thread release acknowledgement.
  const member = bounded(["lease", lease.id.toString(), lease.kind, lease.target, lease.acquiredGeneration, lease.outcome]);
  if (!member) return finish(); membership.push(member);
 }
 if (leaseReturns) blockers.add("lease_unknown");
 for (const db of connections.values()) if (!shadowHandles.has(db)) blockers.add("handle_unknown");
 for (const entry of retainedHandles.values()) {
  if (!timely() || !current()) break;
  outcomes.observedHandles++;
  if (entry.outcome !== "closed") outcomes[entry.outcome]++;
  if (entry.escaped) blockers.add("consumer_unknown");
  if (entry.outcome !== "unattempted" || connections.get(handleKey(entry.file)) !== entry.db) blockers.add("handle_unknown");
  let transaction: boolean | null = null;
  try {
   // Node22.16 IsTransactionGetter calls sqlite3_get_autocommit, not the pager.
   // A closed/unavailable native handle throws; that is UNKNOWN, never autocommit.
   const observed = entry.db.isTransaction;
   if (observed === true) { transaction = true; blockers.add("transaction_active"); }
   else if (observed === false) transaction = false;
   else blockers.add("transaction_unknown");
  } catch { blockers.add("transaction_unknown"); blockers.add("handle_unknown"); }
  if (!timely() || !current()) break;
  const member = bounded([entry.id.toString(), entry.admissionGeneration, entry.admission, entry.schemaGeneration,
   entry.outcome, entry.escaped, transaction]);
  if (!member) break;
  membership.push(member);
 }
 if (timely() && current() && !blockers.has("bound")) membershipDigest = createHash("sha256").update(`[${membership.join(",")}]`).digest("hex");
 return finish();
}

export interface MetadataCheckpointOwner {
 ownerInstance: string;
 generation: number;
 home: string;
 /** Trusted worker-local producer seal; never supplied by a protocol/config caller. */
 isCurrentSealed(): boolean;
}
export interface MetadataCheckpointObservation {
 ownerInstance: string;
 generation: number;
 ownedConnections: number;
 registryGeneration: number;
 physicalFiles: number;
 nonWalFiles: number;
 noWalFiles: number;
 completedCheckpoints: number;
 checkpointed: boolean;
 reason: "settled" | "not_sealed" | "bound" | "budget" | "transaction_unknown" | "durability_unknown" | "identity_unknown" | "busy" | "checkpoint_unknown";
 handlesRetained: true;
 ownershipReleased: false;
 fileIdentityDigest: string | null;
}
/** Worker-local checkpoint stage only, after the caller seals and settles every owned producer.
 * ALL handles are preflighted before the first checkpoint. No handle/statement is closed,
 * registry cleared, transaction rolled back, policy upgraded or queued operation replayed.
 * A bounded control observer must independently refuse late results; synchronous filesystem
 * latency is not cancellable. This proves neither external writer closure nor publication. */
export function checkpointOwnedMetadataConnections(owner: MetadataCheckpointOwner, deadline: number): MetadataCheckpointObservation {
 const result: MetadataCheckpointObservation = { ownerInstance: owner.ownerInstance, generation: owner.generation, ownedConnections: connections.size,
  registryGeneration: lifecycleRegistryGeneration, physicalFiles: 0, nonWalFiles: 0, noWalFiles: 0, completedCheckpoints: 0, checkpointed: false, reason: "not_sealed", handlesRetained: true, ownershipReleased: false, fileIdentityDigest: null };
 const refuse = (reason: MetadataCheckpointObservation["reason"]) => { result.reason = reason; return result; };
 const instance = owner.ownerInstance, generation = owner.generation;
 const current = () => !lifecycleRegistryUnknown && lifecycleRegistryGeneration === result.registryGeneration &&
  /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(instance) && Number.isSafeInteger(generation) && generation >= 0 &&
  owner.isCurrentSealed() === true && owner.ownerInstance === instance && owner.generation === generation && lifecycleRegistryGeneration === result.registryGeneration && !lifecycleRegistryUnknown;
 const timely = () => Number.isFinite(deadline) && performance.now() < deadline;
 type Entry = { key: string; file: string; db: DatabaseSync; identity: string; mode: string; timeout: number; noWal: boolean };
 const entries: Entry[] = [];
 const fileIdentity = (file: string, directory = false) => {
  physicalMetadataPath(file);
  const stat = lstatSync(file, { bigint: true });
  if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) || stat.isSymbolicLink()) throw Error("unknown metadata identity");
  if (stat.ino <= 0n || stat.dev < 0n || process.platform === "win32" && stat.dev === 0n) throw Error("unresolved metadata physical identity");
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
 };
 try {
  if (!current()) return refuse("not_sealed");
  if (!timely()) return refuse("budget");
  if (connections.size > 128 || readers.size) return refuse("bound");
  const homeIdentity = fileIdentity(owner.home, true);
  const physical = new Map<string, Entry[]>();
  for (const [key, db] of connections) {
   if (!timely()) return refuse("budget");
   if (db.isTransaction !== false) return refuse("transaction_unknown");
   const file = db.location("main");
   if (typeof file !== "string" || !file) return refuse("identity_unknown");
   const identity = fileIdentity(file);
   if (fileIdentity(dirname(file), true) !== homeIdentity) return refuse("identity_unknown");
   const admission = lifecycleAdmissions.get(db);
   if (!admission || admission.file !== identity || admission.home !== homeIdentity) return refuse("identity_unknown");
   if (!timely()) return refuse("budget");
   // Connection-local timeout observation precedes schema/page-reading PRAGMAs.
   const timeout = db.prepare("PRAGMA busy_timeout").get()?.timeout;
   if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 0) return refuse("durability_unknown");
   const entry: Entry = { key, file, db, identity, mode: "", timeout, noWal: false };
   entries.push(entry);
   db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.min(25, Math.floor(deadline - performance.now())))};`);
   const schemas = db.prepare("SELECT name,file FROM pragma_database_list LIMIT 3").all();
   if (schemas.length !== 1 || schemas[0]!.name !== "main" || typeof schemas[0]!.file !== "string" || fileIdentity(schemas[0]!.file as string) !== identity) return refuse("identity_unknown");
   if (db.prepare("PRAGMA synchronous").get()?.synchronous !== 2) return refuse("durability_unknown");
   const mode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
   if (typeof mode !== "string" || !["wal", "delete", "truncate", "persist"].includes(mode)) return refuse("durability_unknown");
   entry.mode = mode;
   const group = physical.get(identity) ?? []; group.push(entry); physical.set(identity, group);
  }
  if (!current()) return refuse("not_sealed");
  if (!timely()) return refuse("budget");
  result.physicalFiles = physical.size;
  for (const group of physical.values()) {
   // Group only AFTER every connection has its own transaction/FULL/identity preflight.
   const entry = group[0]!;
   if (!current()) return refuse("not_sealed");
   if (!timely()) return refuse("budget");
   if (group.some(member => connections.get(member.key) !== member.db || member.db.isTransaction !== false || fileIdentity(member.file) !== member.identity || member.mode !== entry.mode) || fileIdentity(owner.home, true) !== homeIdentity) return refuse("identity_unknown");
   if (entry.mode === "wal") {
     if (!timely()) return refuse("budget");
     entry.db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.min(25, Math.floor(deadline - performance.now())))};`);
     const ack = entry.db.prepare("PRAGMA main.wal_checkpoint(FULL)").get();
     if (!ack || typeof ack.busy !== "number" || typeof ack.log !== "number" || typeof ack.checkpointed !== "number" ||
       !Number.isSafeInteger(ack.busy) || !Number.isSafeInteger(ack.log) || !Number.isSafeInteger(ack.checkpointed)) return refuse("checkpoint_unknown");
     if (ack.busy !== 0) return refuse("busy");
     if (!((ack.log === -1 && ack.checkpointed === -1) || (ack.log >= 0 && ack.checkpointed === ack.log))) return refuse("checkpoint_unknown");
     entry.noWal = ack.log === -1 && ack.checkpointed === -1;
   }
   if (!timely()) return refuse("budget");
   if (!current()) return refuse("not_sealed");
   if (entry.db.isTransaction !== false || fileIdentity(entry.file) !== entry.identity) return refuse("transaction_unknown");
   if (entry.noWal) result.noWalFiles++;
   else if (entry.mode === "wal") result.completedCheckpoints++;
   else result.nonWalFiles++; // FULL/autocommit verified; WAL checkpoint is explicitly not applicable.
  }
  if (connections.size !== entries.length || entries.some(entry => connections.get(entry.key) !== entry.db)) return refuse("identity_unknown");
  if (!current()) return refuse("not_sealed");
  if (!timely()) return refuse("budget");
  result.fileIdentityDigest = createHash("sha256").update(JSON.stringify(entries.map(entry => entry.identity).sort())).digest("hex");
  result.reason = "settled"; result.checkpointed = true; return result;
 } catch (error) {
  return refuse([5, 6].includes((error as { errcode?: number }).errcode ?? 0) ? "busy" : "checkpoint_unknown");
 } finally {
  // All admitted handles and statements remain owned. Restore only the temporary
  // lock-wait cap; never modify FULL, journal mode, schema, transactions or data.
  for (const entry of entries) {
   try { entry.db.exec(`PRAGMA busy_timeout=${entry.timeout};`); }
   catch { result.checkpointed = false; result.reason = "checkpoint_unknown"; }
  }
  if (!timely()) { result.checkpointed = false; result.reason = "budget"; }
  try { if (!current()) { result.checkpointed = false; result.reason = "not_sealed"; } }
  catch { result.checkpointed = false; result.reason = "checkpoint_unknown"; }
 }
}

export function saveMetadataValue(home: string, domain: string, key: string, value: unknown): void {
 storageAdmissionRemaining();
 const release = observedMetadataLease(home, "write", () => storageLease(home));
 try {
  const insert=metadataDb(home).prepare(`INSERT INTO bridge_metadata VALUES (?,?,?,?)
   ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);
  storageAdmissionRemaining();insert.run(domain,key,JSON.stringify(value),Date.now());storageAdmissionRemaining();
 } finally { release(); }
}

export interface MessagingMigrationOptions {
 source: string; destination: string; apply?: boolean; offlineIsolated?: boolean;
 /** Exact legal alternate mailbox basenames, supplied by the operator, never sniffed. */
 mailboxes?: string[]; signal?: AbortSignal;
}
type MigrationInput = { path: string; role: "sqlite" | "evidence" | "wal"; identity: string; bytes: number; sha256: string };
interface MigrationAttempt {
 id: string; inputId: string; source: string; destination: string;
 inputs: MigrationInput[]; snapshots: Record<string, string>; phase: "copying" | "imported" | "ready";
 alternates?: Record<string,{snapshot:string;namespace:string;digest:string}>;
}
const MIGRATION_DATABASES = ["bridge.db","archive.db","history.db","store-compatibility.db","owner-questions.db"];
const MIGRATION_DOMAIN = "messaging-migration", MIGRATION_KEY = "candidate-p12-m7-s15";
const migrationRefusal = (message: string) => Object.assign(new Error(message + "; all originals and interrupted destination retained"), { code: "STORE_MIGRATION_HELD" });
const privateMigrationName = (name: string) => /(?:^|[-_.])(token|secret|credential|key|cert|config|pairing)(?:$|[-_.])/i.test(name);
const quoteSql = (name: string) => '"' + name.replaceAll('"','""') + '"';
function migrationDbDigest(db: DatabaseSync): string {
 const hash = createHash('sha256');
 const encode = (value:unknown) => JSON.stringify(value,(_,item)=>typeof item==='bigint' ? {bigint:String(item)} : item);
  hash.update(encode(db.prepare('PRAGMA user_version').get()));
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name LIMIT 513").all();
  if (schema.length>512) throw migrationRefusal('SQLite schema census bound exceeded');
  hash.update(encode(schema));
  for (const table of db.prepare('PRAGMA table_list').all().filter(row=>row.schema==='main' && (row.type==='table' || row.type==='virtual') && !String(row.name).startsWith('sqlite_')).sort((a,b)=>String(a.name).localeCompare(String(b.name)))) {
   const q = quoteSql(String(table.name));
   const columns = db.prepare(`PRAGMA table_xinfo(${q})`).all().filter(row=>row.hidden===0).map(row=>String(row.name));
   const rowid = table.wr===0 ? ['rowid','_rowid_','oid'].find(name=>!columns.some(column=>column.toLowerCase()===name)) : undefined;
   const all = rowid ? [rowid,...columns] : columns;
   const read = db.prepare(`SELECT ${all.map((name,index)=>`${quoteSql(name)} AS ${quoteSql('__digest_'+index)}`).join(',')} FROM ${q} ORDER BY ${all.map(quoteSql).join(',')}`); read.setReadBigInts(true);
   hash.update(String(table.name)); for (const row of read.iterate()) hash.update(encode(row));
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()) {
   const sequence=db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name');sequence.setReadBigInts(true);hash.update(encode(sequence.all()));
  }
  return hash.digest('hex');
}
function migrationSqliteDigest(file: string): string {
 return inspectMailbox(file,db=>migrationDbDigest(db)) ?? (()=>{throw migrationRefusal('Missing protected SQLite view');})();
}

/** Resolve declared roles by platform comparison, never by content sniffing. */
function messagingMigrationMailboxes(home:string, requested:string[]):string[] {
 if(requested.length>64)throw migrationRefusal('Mailbox inventory bound exceeded');
 const fold=(name:string)=>process.platform==='win32'?name.toLowerCase():name;
 const names=readdirSync(home),roles=[...MIGRATION_DATABASES,'token','config.json','broker-tcp.json','.maintenance-lock','.storage-users'];
 if(process.platform==='win32')for(const name of names)if(roles.some(role=>fold(role)===fold(name)&&role!==name))throw migrationRefusal('Infrastructure case variant has no unique storage role');
 const result:string[]=[];
 for(const name of requested){
  if(!name||basename(name)!==name||/[/\\]/.test(name)||name==='.'||name==='..'||roles.some(role=>fold(role)===fold(name))||privateMigrationName(name)||/-(?:wal|shm|journal)$/i.test(name))throw migrationRefusal('Alternate mailbox collides with infrastructure/private role');
  const matches=names.filter(actual=>fold(actual)===fold(name));
  if(matches.length!==1||result.some(actual=>fold(actual)===fold(name)))throw migrationRefusal('Explicit mailbox missing, duplicated or ambiguous');
  result.push(matches[0]!);
 }
 if(process.platform==='win32')for(const name of names)for(const main of [...MIGRATION_DATABASES,...result])for(const suffix of ['-wal','-shm','-journal'])if(fold(name)===fold(main+suffix)&&name!==main+suffix)throw migrationRefusal('SQLite sidecar case variant has no unique storage role');
 return result;
}

/** Bounded descriptor hashing; a changed inode/name never supplies the old input's identity. */
function migrationInput(home: string, path: string, role: MigrationInput["role"]): MigrationInput {
 const file = join(home,path); physicalMetadataPath(file);
 const before = lstatSync(file,{bigint:true});
 const signature = (stat: typeof before) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
 if (!before.isFile() || before.nlink !== 1n) throw migrationRefusal("Nonregular migration input");
 const fd = openSync(file,fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)), hash = createHash('sha256'), buffer = Buffer.alloc(64*1024);
 try {
  if (signature(fstatSync(fd,{bigint:true})) !== signature(before)) throw migrationRefusal("Substituted migration input");
  for (let length; (length = readSync(fd,buffer,0,buffer.length,null)) > 0;) hash.update(buffer.subarray(0,length));
  if (signature(fstatSync(fd,{bigint:true})) !== signature(before) || signature(lstatSync(file,{bigint:true})) !== signature(before)) throw migrationRefusal("Changed migration input");
 } finally { closeSync(fd); }
 return { path,role,identity:signature(before),bytes:Number(before.size),sha256:hash.digest('hex') };
}
function messagingMigrationInventory(home: string, mailboxes: string[]) {
 physicalMetadataPath(home);
 const databases = new Set([...MIGRATION_DATABASES,...mailboxes]);
 if (mailboxes.length>64) throw migrationRefusal('Mailbox inventory bound exceeded');
 for (const name of mailboxes) if (!name || basename(name) !== name || /[/\\]/.test(name) || name === "." || name === ".." || ['token','config.json','broker-tcp.json','.maintenance-lock','.storage-users'].includes(name) || /-(?:wal|shm)$/.test(name)) throw migrationRefusal("Alternate mailbox name collides with another exact storage role");
 const paths: {path:string;role:MigrationInput['role']}[] = [], retainedUnknown: string[] = [];
 const roots = new Set(["jobs","runs","archive","read-state","job-outcomes","local-result-receipts","remote-job-states",".migration-snapshots"]);
 const walk = (dir: string, depth: number, dataRole: boolean) => {
  if (depth > 16) throw migrationRefusal("Migration path depth bound exceeded");
  const names = readdirSync(join(home,dir));
  if (paths.length + retainedUnknown.length + names.length > 10_000) throw migrationRefusal("Migration inventory bound exceeded");
  for (const name of names.sort()) {
   if (!dir && (name==='.maintenance-lock' || name==='.storage-users' || [...databases].some(database=>name===database+'-shm'))) continue;
   const path = dir ? join(dir,name) : name, stat = lstatSync(join(home,path));
   if (stat.isSymbolicLink()) throw migrationRefusal(`Linked input ${path}`);
   if (stat.isDirectory()) { if (dataRole || roots.has(name)) walk(path,depth+1,true); else retainedUnknown.push(path+sep); continue; }
   if (!stat.isFile()) { retainedUnknown.push(path); continue; }
   if (!dir && databases.has(name)) paths.push({path,role:'sqlite'});
   else if (!dir && [...databases].some(database=>name===database+'-wal')) paths.push({path,role:'wal'});
   else if (!privateMigrationName(name) && (dataRole || /^(?:jobs|decisions|handoffs|peer-names|session-bindings|project-groups|owner-questions|t3-wakes-[a-f0-9]+)\.json(?:l|[.-].*)?$/.test(name))) paths.push({path,role:'evidence'});
   else retainedUnknown.push(path); // Token/config/private/unknown bytes are never opened or guessed empty.
  }
 };
 walk('',0,false);
 // Normal read-only SQLite may create an empty exact WAL for coordination.
 // Validate it through the same stable descriptor/hash read, then exclude only
 // that zero-byte coordination file from durable identity. Never remove it.
 // Nonempty WAL and every other input keep their exact identity/size/hash.
 const inputs = paths.sort((a,b)=>a.path.localeCompare(b.path)).map(({path,role})=>migrationInput(home,path,role))
  .filter(input=>input.role!=='wal' || input.bytes!==0);
 return {inputs,retainedUnknown};
}

/** Import an immutable SQLite view into the new coordinator, preserving rowids,
 * schema, original ordinary rows and metadata. FTS is a derived search index;
 * its exact original pages remain in the protected input snapshot. */
function importMigrationSnapshot(target: DatabaseSync, snapshot: string, beforeCommit: () => void): void {
 assertSqliteFamily(snapshot);
 const source = new DatabaseSync(snapshot,{readOnly:true,timeout:0});
 try {
  const tables = source.prepare("PRAGMA table_list").all().filter(row=>row.schema==='main' && row.type==='table' && !String(row.name).startsWith('sqlite_'));
  const schema = source.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  target.exec('BEGIN IMMEDIATE');
  try {
   if(tables.some(table=>table.name==='bridge_metadata'&&table.wr===0)) {
    const owned=target.prepare('SELECT value FROM bridge_metadata WHERE domain=? AND key=?').get(MIGRATION_DOMAIN,MIGRATION_KEY);
    if(!owned||target.prepare('SELECT count(*) AS n FROM bridge_metadata').get()!.n!==1)throw migrationRefusal('Unproved coordinator metadata ownership');
    // SQLite computes a source-free signed integer exactly; no JS Number alias.
    const free=source.prepare(`SELECT -9223372036854775808 AS slot WHERE NOT EXISTS(SELECT 1 FROM bridge_metadata WHERE rowid=-9223372036854775808)
     UNION ALL SELECT a.rowid+1 AS slot FROM bridge_metadata a WHERE a.rowid<9223372036854775807 AND NOT EXISTS(SELECT 1 FROM bridge_metadata b WHERE b.rowid=a.rowid+1) LIMIT 1`);free.setReadBigInts(true);
    const slot=free.get()?.slot;if(typeof slot!=='bigint'||source.prepare('SELECT 1 FROM bridge_metadata WHERE rowid=?').get(slot))throw migrationRefusal('No exact metadata rowid allocation');
    if(target.prepare('UPDATE bridge_metadata SET rowid=? WHERE domain=? AND key=? AND value=?').run(slot,MIGRATION_DOMAIN,MIGRATION_KEY,owned.value!).changes!==1)throw migrationRefusal('Owned metadata relocation CAS failed');
   }
   for (const table of tables) {
    const name = String(table.name), q = quoteSql(name);
    if (!target.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name)) target.exec(String(schema.find(row=>row.name===name)!.sql));
    const columns = source.prepare(`PRAGMA table_xinfo(${q})`).all().filter(row=>row.hidden===0).map(row=>String(row.name));
    const rowid = table.wr===0 ? ['rowid','_rowid_','oid'].find(name=>!columns.some(column=>column.toLowerCase()===name)) : undefined;
    const all = rowid ? [rowid,...columns] : columns;
    // SQLite may name an implicit rowid result after its INTEGER PRIMARY KEY.
    // Alias every projection uniquely, including real columns named like aliases.
    const resultKeys = all.map((_,index)=>`__migration_column_${index}`);
    const read = source.prepare(`SELECT ${all.map((column,index)=>`${quoteSql(column)} AS ${quoteSql(resultKeys[index]!)}`).join(',')} FROM ${q}`); read.setReadBigInts(true);
    const insert = target.prepare(`INSERT INTO ${q} (${all.map(quoteSql).join(',')}) VALUES (${all.map(()=>'?').join(',')})`);
    for (const row of read.iterate()) insert.run(...resultKeys.map(key=>row[key]!));
   }
   for (const entry of schema) {
    if (entry.type==='table' && /^CREATE VIRTUAL TABLE/i.test(String(entry.sql))) {
     target.exec(String(entry.sql)); target.exec(`INSERT INTO ${quoteSql(String(entry.name))} (${quoteSql(String(entry.name))}) VALUES ('rebuild')`);
    } else if (entry.type!=='table') target.exec(String(entry.sql));
   }
   if (source.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").get()) {
    const sequence=source.prepare('SELECT name,seq FROM sqlite_sequence');sequence.setReadBigInts(true);
    for (const row of sequence.all()) {
     if (!target.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(row.seq!,row.name!).changes) target.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)').run(row.name!,row.seq!);
    }
   }
   target.exec(`PRAGMA user_version=${Number(source.prepare('PRAGMA user_version').get()!.user_version)}`);
   beforeCommit();
  } catch (error) { target.exec('ROLLBACK'); throw error; }
  // Never put an external effect or an unknown COMMIT inside retrySqlite.
  target.exec('COMMIT');
 } finally { source.close(); }
}

/** Finite shipping upgrade. --check is read-only. Apply is an operator attestation
 * of shutdown/isolation, never proof that a cached old handle has been revoked.
 * The source is retained. Only this API can resume an incomplete destination. */
export async function migrateMessagingHome(options: MessagingMigrationOptions) {
 if (!isAbsolute(options.source) || !isAbsolute(options.destination)) throw migrationRefusal('Exact absolute source and destination required');
 const source = resolve(options.source), destination = resolve(options.destination);
 const key = (home:string) => process.platform==='win32' ? home.replace(/^[de]:/i,'E:').toLowerCase() : home;
 if (key(source)===key(destination) || key(destination).startsWith(key(source)+sep) || key(source).startsWith(key(destination)+sep)) throw migrationRefusal('Source and destination must be distinct nonnested homes');
 physicalMetadataPath(source); physicalMetadataPath(destination);
 const mailboxes = messagingMigrationMailboxes(source,options.mailboxes??[]);
 const inventory = messagingMigrationInventory(source,mailboxes);
 const inputId = createHash('sha256').update(JSON.stringify({source:key(source),inputs:inventory.inputs,unknown:inventory.retainedUnknown})).digest('hex');
 // Every known selected family, including absent mains with retained sidecars,
 // is structurally inspected before any destination or snapshot construction.
 for(const name of MIGRATION_DATABASES.slice(1))inspectMailbox(join(source,name),db=>{
  db.prepare('PRAGMA user_version').get();db.prepare('SELECT type,name FROM sqlite_master LIMIT 513').all();
 });
 // The original shipping schema is inspected before destination/backup effects.
 withOfflineMetadataAdmission({kind:'offline-isolated',home:source},()=>preflightMessagingHome(source));
 for (const mailbox of mailboxes) withOfflineMetadataAdmission({kind:'offline-isolated',home:source},()=>preflightMessagingHome(source,join(source,mailbox)));
 const inputVersion=inspectMailbox(join(source,'bridge.db'),inputDb=> {
  withOfflineMetadataAdmission({kind:'offline-isolated',home:source},()=>assertMessagingLayout(inputDb,join(source,'bridge.db')));
  const version = Number(inputDb.prepare('PRAGMA user_version').get()!.user_version);
  if (version<1 || version>9) throw migrationRefusal('Only explicitly supported shipping schemas1..9 are admitted');
  return version;
 });
 if (inputVersion===undefined) throw migrationRefusal('Missing shipping input database');
 const plan = {source,destination,inputId,inputs:inventory.inputs,retainedUnknown:inventory.retainedUnknown,originalsRetained:true,applied:false};
 const guardSource = () => {
  options.signal?.throwIfAborted();
  if(JSON.stringify(messagingMigrationInventory(source,mailboxes))!==JSON.stringify(inventory))throw migrationRefusal('Source changed after planning');
  options.signal?.throwIfAborted();
 };
 const validateAlternateProofs = (attempt:MigrationAttempt) => {
  if(attempt.alternates && (typeof attempt.alternates!=='object'||Array.isArray(attempt.alternates)||Object.entries(attempt.alternates).some(([path,proof])=>!mailboxes.includes(path)||!proof||typeof proof!=='object'||proof.snapshot!==attempt.snapshots[path]||!/^[a-f0-9]{64}$/.test(proof.namespace)||!/^[a-f0-9]{64}$/.test(proof.digest))))throw migrationRefusal('Invalid alternate completion proof');
 };
 if (!options.apply) return plan;
 if (options.offlineIsolated!==true) throw migrationRefusal('Apply requires explicit coordinated shutdown and offline-isolated attestation');
 options.signal?.throwIfAborted();
 if (metadataDbOpen(source) || metadataDbOpen(destination) || metadataReaderRetained(source) || metadataReaderRetained(destination)) throw migrationRefusal('This process still owns metadata readers');
 const identityBudget = AbortSignal.timeout(10_000), signal = options.signal ? AbortSignal.any([options.signal,identityBudget]) : identityBudget;
 if (!await ownProcessIdentity(signal)) throw migrationRefusal('Own process identity unknown');
 const releases: (()=>void)[] = [];
 let coordinator: DatabaseSync | undefined;
 try {
  releases.push(maintenanceLock(source,false,true));
  guardSource();
  mkdirSync(destination,{recursive:true,mode:0o700});
  releases.push(maintenanceLock(destination,false,true));
  const {guardPriorEndpoints} = await import('./prior-endpoints.js');
  const {StartupBudget} = await import('./startup-budget.js');
  const checkEndpoints = async () => {
   const budget = new StartupBudget(Infinity,()=>!options.signal?.aborted);
   try { await guardPriorEndpoints(source,'',budget,true); await guardPriorEndpoints(destination,'',budget,true); }
   finally { budget.close(); }
  };
  await checkEndpoints();
  guardSource();
  const file = join(destination,'bridge.db'), existed = existsSync(file);
  if (!existed && readdirSync(destination).some(name=>name!=='.maintenance-lock' && name!=='.storage-users')) throw migrationRefusal('Destination is not isolated and empty');
  if (existed) {
   const inspected=inspectMailbox(file,inspect=> {
    const prior = inspect.prepare('SELECT value FROM bridge_metadata WHERE domain=? AND key=?').get(MIGRATION_DOMAIN,MIGRATION_KEY);
    const attempt = prior && JSON.parse(String(prior.value)) as MigrationAttempt | undefined;
    if (!attempt || attempt.inputId!==inputId || attempt.source!==source || attempt.destination!==destination || !/^[a-f0-9-]{36}$/.test(attempt.id) || !['copying','imported','ready'].includes(attempt.phase) || JSON.stringify(attempt.inputs)!==JSON.stringify(inventory.inputs) || !attempt.snapshots || typeof attempt.snapshots!=='object' || Array.isArray(attempt.snapshots) || Object.entries(attempt.snapshots).some(([path,hash])=>!inventory.inputs.some(input=>input.path===path && input.role!=='wal') || !/^[a-f0-9]{64}$/.test(hash))) throw migrationRefusal('Existing destination has no matching immutable attempt');
    validateAlternateProofs(attempt);
    withOfflineMetadataAdmission({kind:'offline-isolated',home:destination},()=>assertMessagingLayout(inspect,file));
    return true;
   });
   if (!inspected) throw migrationRefusal('Interrupted destination disappeared');
  }
  assertSqliteFamily(file);coordinator = new DatabaseSync(file,{timeout:0}); configureSqlite(coordinator);
  if (!existed) coordinator.exec("CREATE TABLE bridge_metadata(domain TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(domain,key))");
  let attempt: MigrationAttempt;
  const row = coordinator.prepare('SELECT value FROM bridge_metadata WHERE domain=? AND key=?').get(MIGRATION_DOMAIN,MIGRATION_KEY);
  if (row) {
   attempt = JSON.parse(String(row.value)) as MigrationAttempt;
   if (!attempt || attempt.inputId!==inputId || attempt.source!==source || attempt.destination!==destination || !/^[a-f0-9-]{36}$/.test(attempt.id) || !['copying','imported','ready'].includes(attempt.phase) || JSON.stringify(attempt.inputs)!==JSON.stringify(inventory.inputs)) throw migrationRefusal('Interrupted attempt/input identity mismatch');
  } else {
   if (existed) throw migrationRefusal('Existing destination has no immutable migration attempt');
   attempt = {id:randomUUID(),inputId,source,destination,inputs:inventory.inputs,snapshots:{},phase:'copying'};
   coordinator.prepare('INSERT INTO bridge_metadata VALUES (?,?,?,?)').run(MIGRATION_DOMAIN,MIGRATION_KEY,JSON.stringify(attempt),Date.now());
  }
  const save = (previous:string) => {
   guardSource();
   if (coordinator!.prepare('UPDATE bridge_metadata SET value=?,updated_at=? WHERE domain=? AND key=? AND value=?').run(JSON.stringify(attempt),Date.now(),MIGRATION_DOMAIN,MIGRATION_KEY,previous).changes!==1) throw migrationRefusal('Migration attempt CAS failed');
  };
  const snapshots = join(destination,'.migration-snapshots',`messaging-${attempt.id}`);
  mkdirSync(snapshots,{recursive:true,mode:0o700});
  for (const input of attempt.inputs.filter(input=>input.role!=='wal')) {
   guardSource();
   const snapshot = join(snapshots,input.path); physicalMetadataPath(snapshot); mkdirSync(dirname(snapshot),{recursive:true,mode:0o700});
   if (!existsSync(snapshot)) {
    if (input.role==='sqlite') inspectMailbox(join(source,input.path),()=>snapshotDatabase(join(source,input.path),snapshot));
    else copyFileSync(join(source,input.path),snapshot,fsConstants.COPYFILE_EXCL);
   }
   const captured = migrationInput(snapshots,input.path,'evidence');
   if (input.role==='evidence' && captured.sha256!==input.sha256 || attempt.snapshots[input.path] && attempt.snapshots[input.path]!==captured.sha256) throw migrationRefusal('Protected snapshot changed');
   if (input.role==='sqlite') {
    inspectMailbox(snapshot,check=>{if(check.prepare('PRAGMA quick_check').all().some(row=>row.quick_check!=='ok'))throw migrationRefusal('Incomplete protected snapshot');});
    if (!attempt.snapshots[input.path] && migrationSqliteDigest(join(source,input.path))!==migrationSqliteDigest(snapshot)) throw migrationRefusal('Snapshot does not preserve exact source view');
   }
   const previous = JSON.stringify(attempt); attempt.snapshots[input.path]=captured.sha256; save(previous);
  }
  const alternateCompleted = (path:string):boolean => {
   const target=join(destination,path),snapshot=join(snapshots,path),proof=attempt.alternates?.[path];
   const rawMatches=migrationInput(destination,path,'evidence').sha256===attempt.snapshots[path];
   const completed=inspectMailbox(target,db=>{
    // Raw main bytes can still be the shipping snapshot while all committed
    // candidate pages live in WAL. Classify and prove this one SQLite view.
    const version=Number(db.prepare('PRAGMA user_version').get()!.user_version);
    if(version===15){
     if(!proof||proof.snapshot!==attempt.snapshots[path])throw migrationRefusal('Alternate completion proof missing');
     assertCurrentMailboxEnvelope(db);
     const marker=db.prepare('SELECT state,attempt FROM messaging_candidate WHERE id=1').get();
     if(marker?.state!=='ready'||marker.attempt!==attempt.id||db.prepare('SELECT namespace FROM mailbox_store WHERE id=1').get()?.namespace!==proof.namespace||migrationDbDigest(db)!==proof.digest)throw migrationRefusal('Alternate completion proof does not match retained candidate');
     return true;
    }
    // An uncommitted alternate is reusable only as the exact original SQLite
    // snapshot view; WAL-only changes are not validated by its raw main hash.
    if(!rawMatches||migrationDbDigest(db)!==migrationSqliteDigest(snapshot))throw migrationRefusal('Destination copy does not match retained snapshot');
    return false;
   });
   if(completed===undefined)throw migrationRefusal('Alternate completion proof target missing');
   return completed;
  };
  if (attempt.phase==='ready') {
   preflightMessagingHome(destination);
   for (const mailbox of mailboxes) {
    preflightMessagingHome(destination,join(destination,mailbox));
    if(!alternateCompleted(mailbox))throw migrationRefusal('Alternate completion proof missing for ready attempt');
   }
   return {...plan,attemptId:attempt.id,applied:true};
  }
  if (attempt.phase==='copying') {
   // Coordinator owns only its migration row before import. Avoid replacing its
   // SQL authority or losing the immutable attempt at a filesystem rename.
   assertSqliteFamily(join(snapshots,'bridge.db'));const canonical = new DatabaseSync(join(snapshots,'bridge.db'),{readOnly:true,timeout:0});
   const reserved = canonical.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_metadata'").get() && canonical.prepare('SELECT 1 FROM bridge_metadata WHERE domain=? AND key=?').get(MIGRATION_DOMAIN,MIGRATION_KEY);
   canonical.close(); if (reserved) throw migrationRefusal('Source contains a conflicting candidate attempt');
   // Import + phase CAS are one SQLite transaction via a savepoint around the
   // imported rows. Existing coordinator metadata is merged without replacing it.
   importMigrationSnapshot(coordinator,join(snapshots,'bridge.db'),()=> {
    const previous = JSON.stringify(attempt); attempt.phase='imported'; save(previous);
   });
  }
  const completedAlternates = new Set<string>();
  for (const input of attempt.inputs.filter(input=>input.role!=='wal' && input.path!=='bridge.db')) {
   guardSource();
   const target = join(destination,input.path), snapshot = join(snapshots,input.path);
   mkdirSync(dirname(target),{recursive:true,mode:0o700}); physicalMetadataPath(target);
   if (!existsSync(target)) copyFileSync(snapshot,target,fsConstants.COPYFILE_EXCL);
   if(mailboxes.includes(input.path)) { if(alternateCompleted(input.path))completedAlternates.add(input.path); }
   else if(migrationInput(destination,input.path,'evidence').sha256!==attempt.snapshots[input.path])throw migrationRefusal('Destination copy does not match retained snapshot');
  }
  options.signal?.throwIfAborted();
  guardSource();
  await checkEndpoints();
  const {migrateMessageSchema} = await import('./store.js');
  // No await remains between this exact original-input recheck and activation.
  guardSource();
  withOfflineMetadataAdmission({kind:'offline-isolated',home:destination},()=>withMaintenanceExclusion(releases[1]!,guardSource,()=>withStorageAdmission(()=>{guardSource();return Infinity;},()=> {
   for (const input of attempt.inputs.filter(input=>input.role==='sqlite' && (input.path==='bridge.db' || mailboxes.includes(input.path)))) {
    guardSource();if(completedAlternates.has(input.path))continue;
    if(input.path!=='bridge.db')assertSqliteFamily(join(destination,input.path));
    const db = input.path==='bridge.db' ? coordinator! : new DatabaseSync(join(destination,input.path),{timeout:0});
    try {
     configureSqlite(db); migrateMessageSchema(db,join(destination,input.path),true,nullLogger,()=>{
      guardSource();
      if(db!==coordinator){
       initializeMetadataComponent(db,destination,join(destination,input.path),true,true);
       // Match the ordinary opener's durable schema before freezing completion.
       // TEMP views are connection-local and excluded from the main digest.
       ensureMessageQuarantine(db);
       attachStoreCompatibility(db,join(destination,input.path),nullLogger,false,'caller');
       assertCurrentMailboxEnvelope(db);
       if(db.prepare("UPDATE messaging_candidate SET state='ready',attempt=? WHERE id=1 AND contract='p12/m7/s15' AND attempt IN ('',?)").run(attempt.id,attempt.id).changes!==1)throw migrationRefusal('Alternate mailbox ready CAS failed');
       const namespace=db.prepare('SELECT namespace FROM mailbox_store WHERE id=1').get()!.namespace;
       if(typeof namespace!=='string'||!/^[a-f0-9]{64}$/.test(namespace))throw migrationRefusal('Alternate namespace missing');
       // Expected proof is committed first in the coordinator. The alternate
       // COMMIT is separate and may be unknown; resume must verify BOTH sides.
       const previous=JSON.stringify(attempt);(attempt.alternates??={})[input.path]={snapshot:attempt.snapshots[input.path]!,namespace,digest:migrationDbDigest(db)};save(previous);
      }
      guardSource();
     });
     guardSource();
     if(db!==coordinator && (!attempt.alternates?.[input.path]||db.prepare('SELECT attempt FROM messaging_candidate WHERE id=1').get()?.attempt!==attempt.id))throw migrationRefusal('Alternate did not produce a same-attempt completion');
    }
    finally { if (db!==coordinator) db.close(); }
   }
   // Reuse the ordinary metadata initializer and its backup-first component migration.
   guardSource();metadataDb(destination); closeMetadataDb(destination);guardSource();
  })));
  // Publish candidate-ready and migration completion together, never by a fence
  // row alone. Validate all layout/namespace evidence under the same exclusion.
  guardSource();coordinator.exec('BEGIN IMMEDIATE');
  try {
   withOfflineMetadataAdmission({kind:'offline-isolated',home:destination},()=>assertCurrentMailboxEnvelope(coordinator!));
   if (Number(coordinator.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version)!==7) throw migrationRefusal('Component verification failed');
   const previous = JSON.stringify(attempt); attempt.phase='ready';
   const changed = coordinator.prepare("UPDATE messaging_candidate SET state='ready',attempt=? WHERE id=1 AND contract='p12/m7/s15' AND state IN ('preparing','ready') AND attempt IN ('',?)").run(attempt.id,attempt.id).changes;
   if (changed!==1) throw migrationRefusal('Candidate-ready CAS failed'); save(previous);guardSource();
  } catch (error) { coordinator.exec('ROLLBACK'); throw error; }
  coordinator.exec('COMMIT'); // Unknown outcome is retained and reported; no external retry.
  options.signal?.throwIfAborted();
  return {...plan,attemptId:attempt.id,applied:true};
 } finally {
  try { coordinator?.close(); } finally { for (const release of releases.reverse()) release(); }
 }
}
