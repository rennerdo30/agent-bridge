import { admissionSqliteBusy } from "./storage-admission.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Logger } from "./logger.js";
import { migrateSqlite } from "./sqlite-migrations.js";

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
export function attachStoreCompatibility(db: DatabaseSync, file: string, log: Logger, create: boolean): void {
  const path = join(dirname(file), "store-compatibility.db");
  const existed = existsSync(path);
  if (!create && !existed) return;
  const capture: OverlayCapture = { identity: Symbol("compatibility overlay admission"), main: db, file: path,
    open: "attempted", initialize: "not_attempted", close: "not_attempted", attach: "not_attempted", merge: "not_attempted" };
  const captures = overlayCaptures.get(db) ?? []; captures.push(capture); overlayCaptures.set(db, captures);
  retainedOverlayCaptures.add(capture);
  let overlay: DatabaseSync;
  try { overlay = new DatabaseSync(path); capture.overlay = overlay; capture.open = "returned"; }
  catch (error) { capture.open = "unknown"; throw error; }
  capture.initialize = "attempted";
  try { admissionSqliteBusy(overlay,3000,true); migrateSqlite(overlay, path, existed, 1, [{ version: 1, sql: SCHEMA }], log); capture.initialize = "returned"; }
  catch (error) { capture.initialize = "unknown"; throw error; }
  finally {
    capture.close = "attempted";
    try { overlay.close(); capture.close = "returned"; }
    catch (error) { capture.close = "unknown"; throw error; }
  }
  capture.attach = "attempted";
  try { db.prepare("ATTACH DATABASE ? AS store_compatibility").run(path); capture.attach = "returned"; }
  catch (error) { capture.attach = "unknown"; throw error; }
  // A subsequent backup-first primary upgrade adopts supplemental rows while
  // retaining the sidecar as its original recovery source.
  capture.merge = "attempted";
  try { db.exec("BEGIN IMMEDIATE"); }
  catch (error) { capture.merge = "unknown"; throw error; }
  try {
    for (const table of TABLES) {
      if (!db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const merge = table === "peer_last_seen"
        ? "ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)"
        : table === "session_bindings"
          ? "ON CONFLICT(identity,session_id) DO UPDATE SET learned_at=MAX(session_bindings.learned_at,excluded.learned_at)"
          : "ON CONFLICT DO NOTHING";
      // Schema13 adds namespace evidence. Legacy supplemental route rows retain
      // their original values and the empty default, never fabricated authority.
      const columns = table === "job_delivery_routes" ? "(id,recipient,consumed_at)" : "";
      const selected = table === "job_delivery_routes" ? "id,recipient,consumed_at" : "*";
      db.exec(`INSERT INTO main.${table}${columns} SELECT ${selected} FROM store_compatibility.${table} WHERE 1 ${merge}`);
    }
    if (!db.prepare("SELECT name FROM main.sqlite_master WHERE name='peer_last_seen'").get()) {
      db.exec(`INSERT INTO store_compatibility.peer_last_seen SELECT name, MAX(learned_at) FROM peer_names GROUP BY name
        ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)`);
    }
    db.exec("COMMIT");
    capture.merge = "returned"; retainedOverlayCaptures.delete(capture);
  } catch (error) { capture.merge = "unknown"; db.exec("ROLLBACK"); throw error; }
}
