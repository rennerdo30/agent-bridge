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

/** Durable additive metadata while legacy readers hold the primary schema back.
 * Missing tables resolve to this attached database; existing primary tables always win.
 * Neither database nor its original records are removed after a later upgrade.
 */
export function attachStoreCompatibility(db: DatabaseSync, file: string, log: Logger, create: boolean): void {
  const path = join(dirname(file), "store-compatibility.db");
  const existed = existsSync(path);
  if (!create && !existed) return;
  const overlay = new DatabaseSync(path);
  try { migrateSqlite(overlay, path, existed, 1, [{ version: 1, sql: SCHEMA }], log); }
  finally { overlay.close(); }
  db.prepare("ATTACH DATABASE ? AS store_compatibility").run(path);
  // A subsequent backup-first primary upgrade adopts supplemental rows while
  // retaining the sidecar as its original recovery source.
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of TABLES) {
      if (!db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const merge = table === "peer_last_seen"
        ? "ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)"
        : table === "session_bindings"
          ? "ON CONFLICT(identity,session_id) DO UPDATE SET learned_at=MAX(session_bindings.learned_at,excluded.learned_at)"
          : "ON CONFLICT DO NOTHING";
      db.exec(`INSERT INTO main.${table} SELECT * FROM store_compatibility.${table} WHERE 1 ${merge}`);
    }
    if (!db.prepare("SELECT name FROM main.sqlite_master WHERE name='peer_last_seen'").get()) {
      db.exec(`INSERT INTO store_compatibility.peer_last_seen SELECT name, MAX(learned_at) FROM peer_names GROUP BY name
        ON CONFLICT(name) DO UPDATE SET seen_at=MAX(peer_last_seen.seen_at,excluded.seen_at)`);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
