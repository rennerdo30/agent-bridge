import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { metadataFileLease } from "./metadata-file-lease.js";
import { liveStorePeers, metadataRelease } from "./store-compatibility.js";
import { storageLease } from "./storage-lock.js";
import { snapshotMetadataTables } from "./metadata-snapshot.js";

const VERSION = 1;
const connections = new Map<string, DatabaseSync>();
type MetadataAdmissionIdentity = { home: string; file: string };
const lifecycleAdmissions = new WeakMap<DatabaseSync, MetadataAdmissionIdentity | null>();
const readers = new Map<string,number>();
let lifecycleRegistryGeneration = 0;
let lifecycleRegistryUnknown = false;
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
INSERT INTO bridge_components(name,version) VALUES ('metadata',1)
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
 const file = join(resolve(home),"bridge.db"), cached = connections.get(handleKey(file));
 if (cached) return cached;
 if (!existsSync(file)) return undefined;
 physicalMetadataPath(file);
 const admission = observeExistingMetadataAdmission(file);
 const db = new DatabaseSync(file,{timeout:5_000});
 recordMetadataAdmission(db, file, admission);
 try {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get() ||
    Number(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) !== VERSION) { db.close(); return undefined; }
  db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;"); connections.set(handleKey(file),db); changeLifecycleRegistry(); return db;
 } catch (error) { db.close(); throw error; }
}

/** Old readers must finish naturally before their file-backed domains change authority. */
export function assertMetadataAdmission(home: string): void {
 const blockers = liveStorePeers(home).filter(peer => !metadataRelease(peer.version));
 if (blockers.length) throw Object.assign(new Error(`Waiting for metadata upgrade: ${blockers.map(p => `${p.name} (v${p.version}, pid ${p.pid})`).join(", ")}. Existing readers keep their files.`), { code: "STORE_UPGRADE_DEFERRED" });
}

/** Additive component versioning leaves AB-206's global user_version untouched. */
export function metadataDb(home: string): DatabaseSync {
 const file = join(resolve(home), "bridge.db");
 const cached = connections.get(handleKey(file));
 if (cached) return cached;
 physicalMetadataPath(file);
 mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
 const existed = existsSync(file);
 const admission = observeExistingMetadataAdmission(file);
 const db = new DatabaseSync(file, { timeout: 5_000 });
 recordMetadataAdmission(db, file, admission);
 try {
  db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
  const version = () => db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get()
   ? Number(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) : 0;
  if (version() > VERSION) throw new Error("Metadata store is newer than this reader; retained unchanged.");
  if (version() < VERSION) {
   assertMetadataAdmission(home);
   const release = metadataFileLease(`${file}.metadata-migration`, 5_000);
   try {
    if (version() < VERSION) {
     if (existed) {
      const dir = join(home, ".migration-snapshots");
      physicalMetadataPath(dir);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const backup = join(dir, `metadata-v${VERSION}-${randomUUID()}.db`);
      snapshotMetadataTables(db,backup,["bridge_components","worktree_leases","worktree_lease_archive","bridge_metadata","bridge_read_receipts","bridge_imports"],"metadata",VERSION);
     }
     db.exec("BEGIN IMMEDIATE");
     try { db.exec(SCHEMA); db.exec("COMMIT"); }
     catch (error) { db.exec("ROLLBACK"); throw error; }
    }
   } finally { release(); }
  }
  connections.set(handleKey(file), db);
  changeLifecycleRegistry();
  return db;
 } catch (error) { db.close(); throw error; }
}

export function closeMetadataDb(home: string): void {
 const file = join(resolve(home), "bridge.db"), db = connections.get(handleKey(file));
 if (db) { changeLifecycleRegistry(); db.close(); connections.delete(handleKey(file)); }
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
 for (const db of connections.values()) db.close();
 connections.clear();
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
 const release = storageLease(home);
 try {
  metadataDb(home).prepare(`INSERT INTO bridge_metadata VALUES (?,?,?,?)
   ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(domain,key,JSON.stringify(value),Date.now());
 } finally { release(); }
}
