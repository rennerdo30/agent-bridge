import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger } from "./logger.js";
import { migrateSqlite } from "./sqlite-migrations.js";
import { configureSqlite } from "./sqlite-policy.js";
import { storageAdmissionRemaining, storageAdmissionTimeout } from "./storage-admission.js";
import { inspectMailbox } from "./mailbox-layout.js";

const TABLES = ["session_bindings", "peer_names", "peer_name_owners", "job_delivery_routes", "peer_last_seen"] as const;
const SCHEMA = `
CREATE TABLE session_bindings(identity TEXT NOT NULL, session_id TEXT NOT NULL, learned_at INTEGER NOT NULL, PRIMARY KEY(identity,session_id));
CREATE TABLE peer_names(identity TEXT NOT NULL, name TEXT NOT NULL, session_id TEXT, agent TEXT NOT NULL, learned_at INTEGER NOT NULL, PRIMARY KEY(identity,name));
CREATE TABLE peer_name_owners(name TEXT PRIMARY KEY, identity TEXT NOT NULL);
CREATE TABLE job_delivery_routes(id TEXT PRIMARY KEY, recipient TEXT NOT NULL, consumed_at INTEGER);
CREATE TABLE peer_last_seen(name TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
PRAGMA user_version=1;`;

type OverlayOutcome = "not_attempted" | "attempted" | "returned" | "unknown";
type OverlayCapture = {
  readonly identity: symbol; readonly main: DatabaseSync; readonly file: string;
  overlay?: DatabaseSync; open: OverlayOutcome; initialize: OverlayOutcome;
  close: OverlayOutcome; attach: OverlayOutcome; merge: OverlayOutcome;
};
const overlayCaptures = new WeakMap<DatabaseSync, OverlayCapture[]>();
const retainedOverlayCaptures = new Set<OverlayCapture>();
/** Historical actual-source admission only. No SQL, main-only inference, native
 * handle export, owner/borrower completeness or checkpoint/retirement grant.
 */
export function storeCompatibilityObservation(db: DatabaseSync) {
  const captures = overlayCaptures.get(db) ?? [];
  return Object.freeze({ captures: captures.length,
    pending: captures.filter(record => [record.open, record.initialize, record.close, record.attach, record.merge].includes("attempted")).length,
    unknown: captures.some(record => [record.open, record.initialize, record.close, record.attach, record.merge].includes("unknown")),
    attached: captures.filter(record => record.attach === "returned").length,
    initializedHandlesClosed: captures.filter(record => record.close === "returned").length,
    retained: captures.filter(record => retainedOverlayCaptures.has(record)).length, overflow: captures.length > 128,
    ownerBound: false as const, settled: false as const, ownershipReleased: false as const });
}

/** Durable additive metadata while legacy readers hold the primary schema back.
 * Missing tables resolve to this attached database; existing primary tables always win.
 * Neither database nor its original records are removed after a later upgrade.
 */
export function attachStoreCompatibility(db: DatabaseSync, file: string, log: Logger, create: boolean, transactionOwner?:'caller'): void {
  const admitted=storageAdmissionRemaining()!==undefined;
  const callerOwned=transactionOwner==='caller';
  if(callerOwned&&(create||!db.isTransaction))throw new Error('Overlay merge requires the caller-owned current primary transaction');
  if(callerOwned)for(const table of TABLES){storageAdmissionRemaining();if(!db.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name=?").get(table))throw new Error('Outer-owned merge refuses missing primary tables; supplemental originals retained');}
  const path = join(dirname(file), "store-compatibility.db");
  const existed = existsSync(path);
  if (!create && !existed) return;
  const capture: OverlayCapture = { identity: Symbol("compatibility overlay admission"), main: db, file: path,
    open: "attempted", initialize: "not_attempted", close: "not_attempted", attach: "not_attempted", merge: "not_attempted" };
  const captures = overlayCaptures.get(db) ?? []; captures.push(capture); overlayCaptures.set(db, captures);
  retainedOverlayCaptures.add(capture);
  if(callerOwned){
    // Independent guarded read-only inspection/closure, then attachment. No
    // overlay initialization writes occur inside the caller's transaction.
    try{
      const present=inspectMailbox(path,overlay=>{capture.overlay=overlay;capture.open='returned';capture.initialize='attempted';storageAdmissionRemaining();if(Number(overlay.prepare('PRAGMA user_version').get()!.user_version)!==1)throw new Error('Supplemental schema requires separate initialization');for(const table of TABLES){storageAdmissionRemaining();if(!overlay.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new Error('Supplemental layout incomplete; originals retained');}capture.initialize='returned';return true;});
      if(!present)throw new Error('Supplemental database disappeared');capture.close='returned';
    }catch(error){capture.initialize='unknown';capture.close=capture.overlay?.isOpen===false?'returned':'unknown';throw error;}
  }else{
  let overlay: DatabaseSync;
  try { storageAdmissionRemaining(); overlay = new DatabaseSync(path,{timeout:storageAdmissionTimeout(3000)}); capture.overlay = overlay; capture.open = "returned"; }
  catch (error) { capture.open = "unknown"; throw error; }
  capture.initialize = "attempted";
  try { configureSqlite(overlay); migrateSqlite(overlay, path, existed, 1, [{ version: 1, sql: SCHEMA }], log); capture.initialize = "returned"; }
  catch (error) { capture.initialize = "unknown"; throw error; }
  finally {
    capture.close = "attempted";
    try { overlay.close(); capture.close = "returned"; }
    catch (error) { capture.close = "unknown"; throw error; }
  }
  }
  capture.attach = "attempted";
  try { const attach=db.prepare("ATTACH DATABASE ? AS store_compatibility");storageAdmissionRemaining();attach.run(path);storageAdmissionRemaining();capture.attach = "returned"; }
  catch (error) { capture.attach = "unknown"; throw error; }
  // A subsequent backup-first primary upgrade adopts supplemental rows while
  // retaining the sidecar as its original recovery source.
  capture.merge = "attempted";
  try { storageAdmissionRemaining();if(!callerOwned)db.exec("BEGIN IMMEDIATE"); }
  catch (error) { capture.merge = "unknown"; throw error; }
  try {
    for (const table of TABLES) {
      if (!db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const merge = table === "peer_last_seen"
        ? "ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)"
        : table === "session_bindings"
          ? "ON CONFLICT(identity,session_id) DO UPDATE SET learned_at=MAX(session_bindings.learned_at,excluded.learned_at)"
          : "ON CONFLICT DO NOTHING";
      const columns = table==='job_delivery_routes' ? '(id,recipient,consumed_at)' : '';
      const selected = table==='job_delivery_routes' ? 'id,recipient,consumed_at' : '*';
      storageAdmissionRemaining();db.exec(`INSERT INTO main.${table} ${columns} SELECT ${selected} FROM store_compatibility.${table} WHERE 1 ${merge}`);
    }
    if (!db.prepare("SELECT name FROM main.sqlite_master WHERE name='peer_last_seen'").get()) {
      if(callerOwned)throw new Error('Outer-owned merge cannot write supplemental fallback state');
      storageAdmissionRemaining();db.exec(`INSERT INTO store_compatibility.peer_last_seen SELECT name, MAX(learned_at) FROM peer_names GROUP BY name
        ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)`);
    }
    storageAdmissionRemaining();if(!callerOwned)db.exec("COMMIT");storageAdmissionRemaining();
    capture.merge = "returned"; retainedOverlayCaptures.delete(capture);
  } catch (error) { capture.merge = "unknown";if(!callerOwned&&(!admitted||db.isTransaction))db.exec("ROLLBACK");throw error; }
}
