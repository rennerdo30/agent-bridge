import { existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE_NAME } from "./constants.js";
import { extractBundle } from "./archive-bundle.js";
import { historyDbPath, historyReady, openHistoryStore } from "./history-store.js";
import { HISTORY_V1_PREFIX } from "./history-migration.js";
import { jobArchivePath, openJobArchive } from "./job-archive-index.js";
import { maintenanceLock } from "./storage-lock.js";

/** Owner decision 2026-10-09: superseded data is removed only after the new format is migrated, verified
 * (counts + hashes) and healthy, and only by this explicit, confirmed command. Every check runs again
 * immediately before each removal; anything that cannot be proven redundant is kept. */
export interface FinalizeItem { kind: "table" | "file" | "directory"; path: string; bytes: number; reason: string }
export interface FinalizePlan { ready: boolean; blockers: string[]; items: FinalizeItem[]; bytes: number }

/** Legacy history tables in bridge.db that history store v2 replaces. messages, decisions, history_pending
 * and conversation_envelopes stay: the history worker still reads them. */
const LEGACY_BRIDGE_TABLES = ["history_fts", "history_documents", "history_tags", "history_files", "history_sessions", "conversation_records", "conversation_sources", "conversation_parts", "conversations", "conversation_projects", "conversation_memberships"];

function size(path: string): number {
  if (!existsSync(path)) return 0;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((n, name) => n + size(join(path, name)), 0);
}

function tableBytes(db: DatabaseSync, name: string): number {
  // dbstat is optional in SQLite builds; the plan still lists the table without a size.
  try { return Number(db.prepare("SELECT coalesce(sum(pgsize),0) n FROM dbstat WHERE name=? OR name LIKE ?").get(name, `${name}_%`)!.n); }
  catch { return 0; }
}

function jobArchiveComplete(home: string): boolean {
  if (!existsSync(jobArchivePath(join(home, "jobs.json")))) return false;
  const db = openJobArchive(join(home, "jobs.json"));
  try { return db?.prepare("SELECT state FROM archive_migrations WHERE version=1").get()?.state === "complete"; }
  catch { return false; }
  finally { db?.close(); }
}

/** Bundles must still restore byte-exact before their originals may go. */
function verifiedBundleOriginals(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const manifests = readdirSync(dir).filter(name => name.endsWith(".manifest.json"));
  if (!manifests.length) return [];
  for (const manifest of manifests) extractBundle(join(dir, manifest));
  return ["archive-originals", "root-originals"].map(name => join(dir, name)).filter(existsSync);
}

export function planFinalize(home: string): FinalizePlan {
  const blockers: string[] = [], items: FinalizeItem[] = [];
  const bridge = join(home, DB_FILE_NAME), history = historyDbPath(bridge);
  let historyVerified = false;
  if (existsSync(history)) {
    const db = new DatabaseSync(history, { readOnly: true, timeout: 1000 });
    try {
      historyVerified = historyReady(db);
      if (historyVerified) {
        for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE ? OR name LIKE 'retained\\_%' ESCAPE '\\')").all(`${HISTORY_V1_PREFIX}%`)) {
          const name = String(row.name);
          if (/_(data|idx|docsize|config|content)$/.test(name) && !name.startsWith("retained_")) continue;
          items.push({ kind: "table", path: `history.db:${name}`, bytes: tableBytes(db, name), reason: "earlier history format or failed attempt, superseded by the verified v2 copy" });
        }
      }
    } finally { db.close(); }
  }
  if (!historyVerified) blockers.push("History store v2 is not verified yet; nothing in the old format may be removed.");
  if (!jobArchiveComplete(home)) blockers.push("Job archive import is not complete yet; job copies stay.");
  if (historyVerified && existsSync(bridge)) {
    const db = new DatabaseSync(bridge, { readOnly: true, timeout: 1000 });
    try {
      for (const name of LEGACY_BRIDGE_TABLES) if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name))
        items.push({ kind: "table", path: `bridge.db:${name}`, bytes: tableBytes(db, name), reason: "legacy history, copied into history.db and verified" });
    } finally { db.close(); }
  }
  if (historyVerified) {
    const snapshots = join(home, ".migration-snapshots");
    if (existsSync(snapshots)) for (const name of readdirSync(snapshots))
      items.push({ kind: statSync(join(snapshots, name)).isDirectory() ? "directory" : "file", path: join(snapshots, name), bytes: size(join(snapshots, name)), reason: "pre-migration snapshot; the migrations it protected are verified" });
    for (const name of existsSync(home) ? readdirSync(home) : []) if (/^bridge\.db\.backup-/.test(name))
      items.push({ kind: "file", path: join(home, name), bytes: size(join(home, name)), reason: "old whole-database backup from earlier migrations" });
    const archive = join(home, "archive");
    if (existsSync(archive)) for (const name of readdirSync(archive)) if (/^bridge\.db\.backup/.test(name))
      items.push({ kind: "file", path: join(archive, name), bytes: size(join(archive, name)), reason: "old whole-database backup from earlier migrations" });
    const backups = join(home, "backups");
    if (existsSync(backups)) for (const name of readdirSync(backups)) if (name.startsWith(".pending-"))
      items.push({ kind: "directory", path: join(backups, name), bytes: size(join(backups, name)), reason: "incomplete automatic backup (never published)" });
  }
  if (!blockers.length) {
    try {
      for (const dir of verifiedBundleOriginals(join(home, "cold-storage", "jobs-v1")))
        items.push({ kind: "directory", path: dir, bytes: size(dir), reason: "job copy originals; their bundle restores byte-exact" });
    } catch (err) { blockers.push(`A job copy bundle no longer verifies (${(err as Error).message}); its originals stay.`); }
  }
  return { ready: blockers.length === 0, blockers, items, bytes: items.reduce((n, i) => n + i.bytes, 0) };
}

/** Removes exactly the planned items after re-planning under the maintenance lock, then compacts bridge.db. */
export function runFinalize(home: string, report: (line: string) => void): FinalizePlan {
  const release = maintenanceLock(home);
  try {
    const plan = planFinalize(home);
    if (!plan.ready) return plan;
    const bridgeTables = plan.items.filter(i => i.kind === "table" && i.path.startsWith("bridge.db:")).map(i => i.path.slice("bridge.db:".length));
    const historyTables = plan.items.filter(i => i.kind === "table" && i.path.startsWith("history.db:")).map(i => i.path.slice("history.db:".length));
    if (bridgeTables.length) {
      const db = new DatabaseSync(join(home, DB_FILE_NAME), { timeout: 30_000 });
      try {
        // Each drop is its own short transaction so the broker can keep writing between them.
        for (const name of bridgeTables) {
          db.exec("BEGIN IMMEDIATE");
          try { db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`); db.exec("COMMIT"); }
          catch (err) { db.exec("ROLLBACK"); throw err; }
          report(`removed bridge.db table ${name}`);
        }
        report("compacting bridge.db (only the remaining core data is rewritten)…");
        db.exec("VACUUM");
      } finally { db.close(); }
    }
    if (historyTables.length) {
      const db = openHistoryStore(historyDbPath(join(home, DB_FILE_NAME)));
      try {
        for (const name of historyTables) { db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`); report(`removed history.db table ${name}`); }
        db.exec("VACUUM");
      } finally { db.close(); }
    }
    for (const item of plan.items.filter(i => i.kind !== "table")) {
      rmSync(item.path, { recursive: true, force: true });
      report(`removed ${item.path}`);
    }
    return plan;
  } finally { release(); }
}
