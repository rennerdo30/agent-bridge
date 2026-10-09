import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { metadataFileLease } from "./metadata-file-lease.js";
import { liveStorePeers, metadataRelease } from "./store-compatibility.js";
import { storageLease } from "./storage-lock.js";
import { snapshotMetadataTables } from "./metadata-snapshot.js";

const VERSION = 1;
const connections = new Map<string, DatabaseSync>();
const readers = new Map<string,number>();
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
 const file = join(resolve(home),"bridge.db"), cached = connections.get(file);
 if (cached) return cached;
 if (!existsSync(file)) return undefined;
 physicalMetadataPath(file);
 const db = new DatabaseSync(file,{timeout:5_000});
 try {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get() ||
    Number(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) !== VERSION) { db.close(); return undefined; }
  db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;"); connections.set(file,db); return db;
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
 const cached = connections.get(file);
 if (cached) return cached;
 physicalMetadataPath(file);
 mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
 const existed = existsSync(file);
 const db = new DatabaseSync(file, { timeout: 5_000 });
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
  connections.set(file, db);
  return db;
 } catch (error) { db.close(); throw error; }
}

export function closeMetadataDb(home: string): void {
 const file = join(resolve(home), "bridge.db"), db = connections.get(file);
 if (db) { db.close(); connections.delete(file); }
}

/** Bridge nodes share one handle per home and close it when the last node stops. */
export function retainMetadataReader(home: string): () => void {
 const key = resolve(home); readers.set(key,(readers.get(key) ?? 0)+1);
 let released = false;
 return () => {
  if (released) return; released = true;
  const count = (readers.get(key) ?? 1)-1;
  if (count > 0) readers.set(key,count);
  else { readers.delete(key); closeMetadataDb(home); }
 };
}

export function metadataValue(home: string, domain: string, key: string): unknown {
 const row = metadataDb(home).prepare("SELECT value FROM bridge_metadata WHERE domain=? AND key=?").get(domain,key);
 return row ? JSON.parse(String(row.value)) : null;
}

/** Close this process's metadata readers during shutdown or fixture teardown. */
export function closeMetadataDbs(): void {
 for (const db of connections.values()) db.close();
 connections.clear();
}

export function saveMetadataValue(home: string, domain: string, key: string, value: unknown): void {
 const release = storageLease(home);
 try {
  metadataDb(home).prepare(`INSERT INTO bridge_metadata VALUES (?,?,?,?)
   ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(domain,key,JSON.stringify(value),Date.now());
 } finally { release(); }
}
