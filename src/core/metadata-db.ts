import { admissionSqliteBusy, storageAdmissionRemaining, storageAdmissionTimeout } from "./storage-admission.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { metadataFileLease } from "./metadata-file-lease.js";
import { assertStoreUpgrade, liveStorePeers, metadataRelease } from "./store-compatibility.js";
import { maintenanceLock, storageLease } from "./storage-lock.js";
import { physicalPath } from "./project-identity.js";
import { assertBootstrapAccess, initializeBootstrapProvenance, syncBootstrapHomeChain } from "./store-bootstrap-journal.js";
import { snapshotMetadataTables } from "./metadata-snapshot.js";

export const METADATA_STORE_VERSION = 5;
const VERSION = METADATA_STORE_VERSION;
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
INSERT INTO bridge_components(name,version) VALUES ('metadata',${VERSION})
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
 assertBootstrapAccess(home);
 // A legacy component is observable by the capability census through its old
 // read-only path, never exported as an admitted writable handle. Explicit
 // offline migration must still be able to run that census before upgrading.
 try { if (assertMetadataUpgradeBoundary(home) !== VERSION) return undefined; }
 catch (error) { if ((error as NodeJS.ErrnoException).code === "STORE_OFFLINE_REQUIRED") return undefined; throw error; }
 const file = join(resolve(home),"bridge.db"), cached = connections.get(handleKey(file));
 if (cached) { admissionSqliteBusy(cached); return escapeMetadataReference(cached); }
 if (!existsSync(file)) return undefined;
 physicalMetadataPath(file);
 const admission = observeExistingMetadataAdmission(file);
 const db = new DatabaseSync(file,{timeout:storageAdmissionTimeout(5_000)});
 recordMetadataAdmission(db, file, admission);
 try {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get() ||
    Number(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) !== VERSION) { legacyMetadataClose(db); return undefined; }
  admissionSqliteBusy(db,5000,true); db.exec("PRAGMA synchronous=FULL;"); connections.set(handleKey(file),db); changeLifecycleRegistry(); return escapeMetadataReference(db);
 } catch (error) { legacyMetadataClose(db); throw error; }
}

/** Read old component presence without granting its handle to a writer. The
 * capability census must not disappear merely because this reader is newer. */
export function metadataPresenceRows(home: string): Record<string, unknown>[] | undefined {
 assertBootstrapAccess(home);
 const file = join(resolve(home), "bridge.db");
 if (!existsSync(file)) return undefined;
 physicalMetadataPath(file);
 const db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
 try {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get() ||
      !db.prepare("SELECT 1 FROM bridge_components WHERE name='import:storage-capabilities'").get()) return undefined;
  return db.prepare("SELECT key,value,updated_at FROM bridge_metadata WHERE domain='storage-capabilities'").all();
 } finally { db.close(); }
}

/** Old readers must finish naturally before their file-backed domains change authority. */
export function assertMetadataAdmission(home: string): void {
 const blockers = liveStorePeers(home).filter(peer => !metadataRelease(peer.version));
 if (blockers.length) throw Object.assign(new Error(`Waiting for metadata upgrade: ${blockers.map(p => `${p.name} (v${p.version}, pid ${p.pid})`).join(", ")}. Existing readers keep their files.`), { code: "STORE_UPGRADE_DEFERRED" });
 assertStoreUpgrade(home, "metadata", 0, VERSION);
}

/** Additive component versioning leaves AB-206's global user_version untouched. */
/** An operator attestation, never inferred from endpoints or an environment flag.
 * All readers stopped; the named home is explicitly isolated from old releases. */
export interface OfflineMetadataAdmission { kind: "offline-isolated"; home: string }
/** Read-only preflight before any writable opener or schema/backup publication. */
export function assertMetadataUpgradeBoundary(home: string, offline?: OfflineMetadataAdmission): number {
 const file = join(resolve(home), "bridge.db"); if (!existsSync(file)) return 0;
 const inspection = new DatabaseSync(file, { readOnly: true, timeout: 0 });
 try {
  const version = inspection.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get()
   ? Number(inspection.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) : 0;
  if (version > 0 && version < VERSION && (!offline || offline.kind !== "offline-isolated" || handleKey(physicalPath(resolve(offline.home))) !== handleKey(physicalPath(resolve(home)))))
   throw Object.assign(new Error(`Metadata component${version} cached writers cannot be excluded automatically. Owner-coordinated offline migration into an explicitly isolated home is required; originals retained.`), { code: "STORE_OFFLINE_REQUIRED" });
  if (!Number.isSafeInteger(version) || version < 0 || version > VERSION) throw new Error("Metadata component is unproven or newer; originals retained.");
  return version;
 } finally { inspection.close(); }
}
export function metadataDb(home: string, offline?: OfflineMetadataAdmission): DatabaseSync {
 assertBootstrapAccess(home);
 storageAdmissionRemaining();
 assertMetadataUpgradeBoundary(home, offline);
 const file = join(resolve(home), "bridge.db");
 const cached = connections.get(handleKey(file));
 if (cached) { admissionSqliteBusy(cached); return escapeMetadataReference(cached); }
 physicalMetadataPath(file);
 mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
 const existed = existsSync(file);
 if (!existed) syncBootstrapHomeChain(home, () => { storageAdmissionRemaining(); });
 const admission = observeExistingMetadataAdmission(file);
 const db = new DatabaseSync(file, { timeout: storageAdmissionTimeout(5_000) });
 recordMetadataAdmission(db, file, admission);
 try {
  const version = () => db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get()
   ? Number(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) : 0;
  if (!Number.isSafeInteger(version()) || version() < 0) throw new Error("Metadata component version is unproven; originals retained for owner-coordinated offline recovery.");
  if (version() > 0 && version() < VERSION && (!offline || offline.kind !== "offline-isolated" || handleKey(physicalPath(resolve(offline.home))) !== handleKey(physicalPath(resolve(home)))))
    throw Object.assign(new Error(`Metadata component${version()} cached writers cannot be excluded automatically. Stop old readers through the owner and explicitly admit offline migration into an isolated home; originals remain unchanged.`), { code: "STORE_OFFLINE_REQUIRED" });
  admissionSqliteBusy(db,5000,true); db.exec("PRAGMA synchronous=FULL;");
  if (version() > VERSION) throw new Error("Metadata store is newer than this reader; retained unchanged.");
  if (version() < VERSION) {
   assertMetadataAdmission(home);
   const release = observedMetadataLease(`${file}.metadata-migration`, "migration", () => metadataFileLease(`${file}.metadata-migration`, 5_000));
   let exclusive: (() => void) | undefined;
   try {
    // Lease-aware old writers share this lock. Check capabilities again under
    // exclusion, before snapshot/schema effects. A cached old handle cannot be
    // made safe by changing a component number; live/unknown readers must exit.
    try { exclusive = maintenanceLock(home, true); }
    catch (error) { throw Object.assign(error as Error, { code: "STORE_UPGRADE_DEFERRED" }); }
    assertMetadataAdmission(home);
    if (version() < VERSION) {
     syncBootstrapHomeChain(home, () => { storageAdmissionRemaining(); });
     if (existed) {
      const dir = join(home, ".migration-snapshots");
      physicalMetadataPath(dir);
      storageAdmissionRemaining();
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const backup = join(dir, `metadata-v${VERSION}-${randomUUID()}.db`);
      snapshotMetadataTables(db,backup,["bridge_components","worktree_leases","worktree_lease_archive","bridge_metadata","bridge_read_receipts","bridge_imports","job_checklist","project_checklist"],"metadata",VERSION);
     }
     storageAdmissionRemaining();
     db.exec("BEGIN IMMEDIATE");
     try { storageAdmissionRemaining(); const previous = version(); db.exec(SCHEMA); storageAdmissionRemaining(); initializeBootstrapProvenance(db,home,previous); storageAdmissionRemaining(); db.exec("COMMIT"); }
     catch (error) { db.exec("ROLLBACK"); throw error; }
    }
   } finally { exclusive?.(); release(); }
  }
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
 const release = observedMetadataLease(home, "write", () => storageLease(home));
 try {
  metadataDb(home).prepare(`INSERT INTO bridge_metadata VALUES (?,?,?,?)
   ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(domain,key,JSON.stringify(value),Date.now());
 } finally { release(); }
}
