import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { metadataDb, physicalMetadataPath } from "./metadata-db.js";
import { isProcessIdentityAlive, processIdentity } from "./process-identity.js";
import { readMetadataLeaseOwner } from "./metadata-file-lease.js";

interface LeaseRow {
 key: string; path: string | null; pid: number | null; identity: string | null;
 job_id: string | null; nonce: string; acquired_at: number; heartbeat_at: number;
 archived_at: number | null; legacy_path: string | null;
}
const PREFIX = "Worktree is running, closing, or has an unreconciled lease; kept unchanged.";

function importLegacy(home: string): void {
 const db = metadataDb(home);
 if (db.prepare("SELECT 1 FROM bridge_components WHERE name='legacy-worktree-leases'").get()) return;
 const dir = join(home,"worktree-leases");
 physicalMetadataPath(dir);
 // Pre-versioned empty directories have no provable owner. Preserve them in place.
 const entries = existsSync(dir) ? readdirSync(dir).filter(name => /^[a-f0-9]{64}$/.test(name)) : [];
 db.exec("BEGIN IMMEDIATE");
 try {
  for (const key of entries) {
   const path = join(dir,key);
   physicalMetadataPath(path);
   const stat = lstatSync(path);
   const owner = stat.isFile() ? readMetadataLeaseOwner(path) : null;
   db.prepare(`INSERT INTO worktree_leases(key,pid,identity,nonce,acquired_at,heartbeat_at,legacy_path)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(key) DO NOTHING`).run(key,owner?.pid ?? null,owner?.identity ?? null,randomUUID(),stat.birthtimeMs,stat.mtimeMs,path);
  }
  db.prepare("INSERT INTO bridge_components VALUES ('legacy-worktree-leases',1) ON CONFLICT(name) DO NOTHING").run();
  db.exec("COMMIT");
 } catch (error) { db.exec("ROLLBACK"); throw error; }
}

/** Archive ownership in the same transaction as replacement; no lease row is deleted. */
function archive(db: ReturnType<typeof metadataDb>, row: LeaseRow, reason: string): void {
 db.prepare(`INSERT INTO worktree_lease_archive
  SELECT nonce,key,path,pid,identity,job_id,acquired_at,heartbeat_at,?,?,legacy_path
  FROM worktree_leases WHERE key=? AND nonce=? ON CONFLICT(nonce) DO NOTHING`).run(Date.now(),reason,row.key,row.nonce);
}

export function worktreeRowLease(home: string, key: string, path: string, jobId: string | null = null): () => void {
 importLegacy(home);
 const db = metadataDb(home), identity = processIdentity(process.pid);
 if (!identity) throw new Error(`${PREFIX} Cannot verify acquiring process ${process.pid}.`);
 const nonce = randomUUID(), now = Date.now();
 db.exec("BEGIN IMMEDIATE");
 try {
  const row = db.prepare("SELECT * FROM worktree_leases WHERE key=?").get(key) as unknown as LeaseRow | undefined;
  if (row && row.archived_at === null) {
   const alive = row.pid && row.identity ? isProcessIdentityAlive(row.pid,row.identity) : undefined;
   if (alive !== false) throw new Error(`${PREFIX} Holder: ${row.pid ? `pid ${row.pid}` : "unknown legacy owner"}, job ${row.job_id ?? "unknown"}; identity ${alive === true ? "live" : "unverifiable"}.`);
   archive(db,row,"owner identity proved gone");
  }
  db.prepare(`INSERT INTO worktree_leases(key,path,pid,identity,job_id,nonce,acquired_at,heartbeat_at)
   VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
   path=excluded.path,pid=excluded.pid,identity=excluded.identity,job_id=excluded.job_id,
   nonce=excluded.nonce,acquired_at=excluded.acquired_at,heartbeat_at=excluded.heartbeat_at,
   archived_at=NULL,archive_reason=NULL,legacy_path=NULL`).run(key,path,process.pid,identity,jobId,nonce,now,now);
  db.exec("COMMIT");
 } catch (error) { db.exec("ROLLBACK"); throw error; }
 let released = false;
 const timer = setInterval(() => {
  try { metadataDb(home).prepare("UPDATE worktree_leases SET heartbeat_at=? WHERE key=? AND nonce=? AND archived_at IS NULL").run(Date.now(),key,nonce); }
  catch { /* Heartbeat failure cannot authorize another owner to reclaim this row. */ }
 },10_000);
 timer.unref();
 return () => {
  if (released) return;
  clearInterval(timer);
  // The shared per-home connection may have been closed meanwhile (the last bridge node of
  // this process stopped); a fresh handle still releases exactly this nonce.
  const db = metadataDb(home);
  db.exec("BEGIN IMMEDIATE");
  try {
   const row = db.prepare("SELECT * FROM worktree_leases WHERE key=? AND nonce=? AND archived_at IS NULL").get(key,nonce) as unknown as LeaseRow | undefined;
   if (row) {
    archive(db,row,"owner released");
    db.prepare("UPDATE worktree_leases SET archived_at=?,archive_reason='owner released' WHERE key=? AND nonce=?").run(Date.now(),key,nonce);
   }
   db.exec("COMMIT"); released = true;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
 };
}
