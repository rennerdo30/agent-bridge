import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE_NAME } from "./constants.js";
import { extractBundle, readBundleManifest } from "./archive-bundle.js";
import { historyDbPath, historyReady, openHistoryReader, openHistoryStore, HISTORY_STORE_VERSION } from "./history-store.js";
import { decodeHistoryRow, HISTORY_V1_PREFIX } from "./history-migration.js";
import { jobArchivePath, openJobArchive } from "./job-archive-index.js";
import { maintenanceLock } from "./storage-lock.js";
import { ARCHIVE_DB_NAME } from "./sqlite-maintenance.js";
import { derivedTables, logicalTable, proveFile, proveTable, sidecars, type LiveDb } from "./finalize-proof.js";

/** Owner decision 2026-10-09: superseded data is removed only after the new format is migrated, verified
 * (counts + hashes) and healthy, and only by this explicit, confirmed command. Every item is proven redundant row by
 * row (finalize-proof.ts) immediately before its removal; anything that cannot be proven is kept and reported. */
export interface FinalizeItem { kind: "table" | "file" | "directory"; path: string; bytes: number; reason: string }
export interface FinalizePlan { ready: boolean; blockers: string[]; items: FinalizeItem[]; bytes: number; kept: FinalizeItem[] }

/** Legacy history tables in bridge.db that history store v2 replaces. messages, decisions, history_pending
 * and conversation_envelopes stay: the history worker still reads them. */
export const LEGACY_BRIDGE_TABLES = ["history_fts", "history_documents", "history_tags", "history_files", "history_sessions", "conversation_records", "conversation_sources", "conversation_parts", "conversations", "conversation_projects", "conversation_memberships"];
const COLD_JOBS = ["cold-storage", "jobs-v1"];

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

export function historyIsVerified(home: string): boolean {
  const history = historyDbPath(join(home, DB_FILE_NAME));
  if (!existsSync(history)) return false;
  const db = new DatabaseSync(history, { readOnly: true, timeout: 1000 });
  try { return historyReady(db); } finally { db.close(); }
}

/** The live databases a proof may rely on. Legacy bridge.db history tables never count: finalize removes them. */
export function openLive(home: string): { live: LiveDb[]; close: () => void } {
  const live: LiveDb[] = [];
  const bridge = join(home, DB_FILE_NAME), archive = join(home, ARCHIVE_DB_NAME), history = historyDbPath(bridge);
  try {
    if (existsSync(bridge)) live.push({ label: "bridge.db", db: new DatabaseSync(bridge, { readOnly: true, timeout: 5000 }), exclude: new Set(LEGACY_BRIDGE_TABLES) });
    if (existsSync(archive)) live.push({ label: "archive.db", db: new DatabaseSync(archive, { readOnly: true, timeout: 5000 }) });
    if (existsSync(history)) live.push({ label: "history.db", db: new DatabaseSync(history, { readOnly: true, timeout: 5000 }) });
  } catch (err) { for (const l of live) l.db.close(); throw err; }
  return { live, close: () => { for (const l of live) l.db.close(); } };
}

/** Old-format history tables kept inside history.db (v1_* from the v1→v2 upgrade, retained_* from failed attempts). */
function historyCandidates(db: DatabaseSync): { name: string; derived: boolean }[] {
  const derived = derivedTables(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE ? OR name LIKE 'retained\\_%' ESCAPE '\\') ORDER BY name").all(`${HISTORY_V1_PREFIX}%`).map(row => String(row.name));
  const virtual = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'").all().map(row => String(row.name)));
  // Shadow tables of a search index go with their virtual table.
  return names.filter(name => !derived.has(name) || virtual.has(name)).map(name => ({ name, derived: derived.has(name) }));
}

/** Proves each v1_* and retained_* table against the live v2 tables in the same file. A derived search index is listed
 * only once the table it indexes is proven. */
function proveHistoryTables(db: DatabaseSync): { name: string; reason: string | null }[] {
  const candidates = historyCandidates(db);
  const v2: LiveDb[] = [{ label: "history.db v2", db, exclude: new Set(candidates.map(c => c.name)) }];
  const results = candidates.filter(c => !c.derived).map(c => ({ name: c.name, reason: proveTable(db, c.name, v2) }));
  for (const c of candidates.filter(c => c.derived)) {
    const base = `${c.name.slice(0, c.name.length - logicalTable(c.name).length)}history_documents`;
    const unproven = results.find(r => r.name === base && r.reason !== null);
    results.push({ name: c.name, reason: unproven ? `search index of ${base}, which is kept` : null });
  }
  return results;
}

/** Whole-database backups, migration snapshots and unpublished backup folders. Their contents are proven later. */
export function fileCandidates(home: string): { item: FinalizeItem; copies: string[] }[] {
  const out: { item: FinalizeItem; copies: string[] }[] = [];
  const add = (path: string, reason: string, copies: string[] = []) => {
    const kind = lstatSync(path).isDirectory() ? "directory" : "file";
    out.push({ item: { kind, path, bytes: size(path) + sidecars(path).reduce((n, s) => n + size(s), 0), reason }, copies });
  };
  const listed = (dir: string) => existsSync(dir) ? readdirSync(dir) : [];
  const notSidecar = (dir: string, name: string, names: string[]) => !(/-(wal|shm|journal)$/.test(name) && names.includes(name.replace(/-(wal|shm|journal)$/, "")));
  const snapshots = join(home, ".migration-snapshots"), snapshotNames = listed(snapshots);
  for (const name of snapshotNames) if (notSidecar(snapshots, name, snapshotNames)) add(join(snapshots, name), "pre-migration snapshot; every row it holds exists in the live databases");
  const homeNames = listed(home);
  for (const name of homeNames) if (/^bridge\.db\.backup-/.test(name) && notSidecar(home, name, homeNames)) add(join(home, name), "old whole-database backup; every row it holds exists in the live databases");
  const archive = join(home, "archive"), archiveNames = listed(archive);
  for (const name of archiveNames) if (/^bridge\.db\.backup/.test(name) && notSidecar(archive, name, archiveNames)) add(join(archive, name), "old whole-database backup; every row it holds exists in the live databases");
  const backups = join(home, "backups");
  const published = [...listed(backups).filter(n => !n.startsWith(".")).map(n => join(backups, n)), ...listed(join(backups, "archive")).map(n => join(backups, "archive", n))];
  for (const name of listed(backups)) if (name.startsWith(".pending-"))
    add(join(backups, name), "incomplete automatic backup; every file in it exists elsewhere", [home, ...published]);
  return out;
}

/** Bundles verify one at a time (bounded memory); the result names every original a verified bundle restores. */
function verifiedBundleEntries(dir: string): { entries: Map<string, Set<string>>; failures: string[] } {
  const entries = new Map<string, Set<string>>(), failures: string[] = [];
  for (const manifest of existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".manifest.json")) : []) {
    try {
      extractBundle(join(dir, manifest));
      for (const entry of readBundleManifest(join(dir, manifest)).entries) {
        const set = entries.get(entry.name) ?? new Set<string>();
        set.add(`${entry.bytes}:${entry.sha256}`);
        entries.set(entry.name, set);
      }
    } catch (err) { failures.push(`${manifest} does not verify (${(err as Error).message})`); }
  }
  return { entries, failures };
}

function fileDigest(path: string): string {
  const hash = createHash("sha256"), fd = openSync(path, "r"), buffer = Buffer.alloc(1024 * 1024);
  try { for (let n; (n = readSync(fd, buffer, 0, buffer.length, null));) hash.update(buffer.subarray(0, n)); }
  finally { closeSync(fd); }
  return hash.digest("hex");
}

/** Originals restored byte-exact by a verified bundle; every other file in the folder stays. */
function bundledOriginals(home: string): { dir: string; files: string[]; bytes: number; unlisted: string[]; failures: string[] }[] {
  const cold = join(home, ...COLD_JOBS);
  const dirs = ["archive-originals", "root-originals"].map(name => join(cold, name)).filter(existsSync);
  if (!dirs.length) return [];
  const { entries, failures } = verifiedBundleEntries(cold);
  return dirs.map(dir => {
    const files: string[] = [], unlisted: string[] = [];
    let bytes = 0;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), st = lstatSync(path);
      if (st.isFile() && entries.get(name)?.has(`${st.size}:${fileDigest(path)}`)) { files.push(path); bytes += st.size; }
      else unlisted.push(name);
    }
    return { dir, files, bytes, unlisted, failures };
  });
}

interface Candidates { blockers: string[]; bridgeTables: FinalizeItem[]; history: boolean; files: { item: FinalizeItem; copies: string[] }[] }
function candidates(home: string): Candidates {
  const blockers: string[] = [];
  const historyVerified = historyIsVerified(home);
  if (!historyVerified) blockers.push("History store v2 is not verified yet; nothing in the old format may be removed.");
  if (!jobArchiveComplete(home)) blockers.push("Job archive import is not complete yet; job copies stay.");
  const bridgeTables: FinalizeItem[] = [];
  const bridge = join(home, DB_FILE_NAME);
  if (historyVerified && existsSync(bridge)) {
    const db = new DatabaseSync(bridge, { readOnly: true, timeout: 1000 });
    try {
      for (const name of LEGACY_BRIDGE_TABLES) if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name))
        bridgeTables.push({ kind: "table", path: `bridge.db:${name}`, bytes: tableBytes(db, name), reason: "legacy history, copied into history.db and verified" });
    } finally { db.close(); }
  }
  return { blockers, bridgeTables, history: historyVerified, files: historyVerified ? fileCandidates(home) : [] };
}

function plan(blockers: string[], items: FinalizeItem[], kept: FinalizeItem[]): FinalizePlan {
  return { ready: blockers.length === 0, blockers, items, bytes: items.reduce((n, i) => n + i.bytes, 0), kept };
}

/** Dry run: lists what `--yes` would remove (each item already proven now) and what stays, with the reason. */
export function planFinalize(home: string): FinalizePlan {
  const found = candidates(home);
  const items: FinalizeItem[] = [...found.bridgeTables], kept: FinalizeItem[] = [];
  if (found.history) {
    const db = openHistoryReader(historyDbPath(join(home, DB_FILE_NAME)), 1000);
    try {
      for (const { name, reason } of proveHistoryTables(db)) {
        const item: FinalizeItem = { kind: "table", path: `history.db:${name}`, bytes: tableBytes(db, name), reason: "earlier history format or failed attempt; every row exists in the verified v2 tables" };
        if (reason === null) items.push(item); else kept.push({ ...item, reason });
      }
    } finally { db.close(); }
    const { live, close } = openLive(home);
    try {
      for (const { item, copies } of found.files) {
        const reasons = proveFile(item.path, live, copies);
        if (!reasons.length) items.push(item); else kept.push({ ...item, reason: withAbsorbHint(summarize(reasons)) });
      }
    } finally { close(); }
  }
  if (!found.blockers.length) for (const group of bundledOriginals(home)) {
    if (group.files.length) items.push({ kind: "directory", path: group.dir, bytes: group.bytes, reason: `${group.files.length} job copy originals that a verified bundle restores byte-exact` });
    if (group.unlisted.length || group.failures.length) kept.push({ kind: "directory", path: group.dir, bytes: size(group.dir) - group.bytes, reason: summarize([...group.failures, ...group.unlisted.map(name => `${name} is in no verified bundle`)]) });
  }
  return plan(found.blockers, items, kept);
}

const summarize = (reasons: string[]) => reasons.length > 3 ? `${reasons.slice(0, 3).join("; ")}; and ${reasons.length - 3} more` : reasons.join("; ");
/** Rows or files that exist nowhere else can be imported losslessly first; conflicts never can. */
const withAbsorbHint = (reason: string) => /rows are not in|rows, and no live|no identical copy exists/.test(reason) ? `${reason} (run agent-bridge storage absorb to import what exists only here)` : reason;

/** Primary keys used to prove every legacy row of a mutable table still exists in history store v2. */
const PRESENCE_KEYS: Record<string, string[]> = {
  conversations: ["id"], conversation_sources: ["id"], conversation_parts: ["source", "part"], conversation_projects: ["project"],
  conversation_memberships: ["project", "conversation"], history_documents: ["id"], history_tags: ["id", "type", "value"],
  history_files: ["path"], history_sessions: ["alias"],
};

/** Proof that nothing of the legacy bridge.db history exists only in bridge.db:
 * - every legacy transcript record exists in v2 with byte-identical raw bytes (copied or via the legacy tail);
 * - every row of every other legacy table exists in v2 by its key. */
function verifyLegacyBridge(bridge: DatabaseSync, history: DatabaseSync, report: (line: string) => void): string[] {
  const blockers: string[] = [];
  const has = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (has(bridge, "conversation_records")) {
    report("comparing every legacy transcript record byte-for-byte…");
    const same = history.prepare("SELECT * FROM conversation_records WHERE id=?");
    const mapped = history.prepare("SELECT target_id FROM history_legacy_tail WHERE source_id=?");
    let checked = 0, missing = 0, different = 0;
    for (const row of bridge.prepare("SELECT * FROM conversation_records ORDER BY id").iterate()) {
      let target = same.get(row.id!);
      if (!target || target.source !== row.source || target.generation !== row.generation || target.offset !== row.offset) {
        const tail = mapped.get(row.id!);
        target = tail ? same.get(tail.target_id!) : undefined;
      }
      if (!target) missing++;
      else {
        const decoded = decodeHistoryRow("conversation_records", target);
        if (!(decoded.raw as Buffer).equals(Buffer.from(row.raw as Uint8Array)) || decoded.conversation !== row.conversation || decoded.source !== row.source) different++;
      }
      if (++checked % 50_000 === 0) report(`  ${checked.toLocaleString("en")} records checked`);
    }
    if (missing) blockers.push(`${missing} legacy transcript records are not in history.db yet (the legacy tail has not caught up).`);
    if (different) blockers.push(`${different} legacy transcript records differ from their copy in history.db.`);
    report(`  ${checked.toLocaleString("en")} records checked, ${missing} missing, ${different} different`);
  }
  for (const [table, keys] of Object.entries(PRESENCE_KEYS)) {
    if (!has(bridge, table)) continue;
    if (!has(history, table)) { blockers.push(`history.db has no ${table} table.`); continue; }
    report(`checking that every ${table} row exists in history.db…`);
    const where = keys.map(k => `"${k}"=?`).join(" AND ");
    const lookup = history.prepare(`SELECT 1 FROM "${table}" WHERE ${where}`);
    let missing = 0;
    for (const row of bridge.prepare(`SELECT ${keys.map(k => `"${k}"`).join(",")} FROM "${table}"`).iterate())
      if (!lookup.get(...keys.map(k => row[k]!))) missing++;
    // Derived search documents are rebuilt from records; a reindex may legitimately replace them.
    if (missing && table !== "history_documents") blockers.push(`${missing} ${table} rows exist only in bridge.db.`);
    else if (missing) report(`  ${missing} legacy search documents were re-derived after a reindex; their source records are verified above.`);
  }
  return blockers;
}

/** Independent checks before anything is removed: history.db passes quick_check, v2 is verified and complete,
 * and the legacy bridge.db history is fully contained in v2. It does not trust the migration's own verification.
 * Any doubt is a blocker. The legacy check runs again inside the transaction that drops the tables. */
export function verifyBeforeFinalize(home: string, report: (line: string) => void = () => {}): string[] {
  const blockers: string[] = [];
  const bridgeFile = join(home, DB_FILE_NAME), historyFile = historyDbPath(bridgeFile);
  if (!existsSync(historyFile)) return ["history.db does not exist."];
  const history = openHistoryReader(historyFile, 5000);
  const bridge = new DatabaseSync(bridgeFile, { readOnly: true, timeout: 5000 });
  try {
    if (!historyReady(history)) return ["History store v2 is not verified."];
    report("checking history.db integrity…");
    if (history.prepare("PRAGMA quick_check").all().some(row => row.quick_check !== "ok")) blockers.push("history.db failed quick_check.");
    blockers.push(...verifyLegacyBridge(bridge, history, report));
    const unfinished = history.prepare("SELECT count(*) n FROM history_copy_state WHERE verified=0").get()!.n;
    if (Number(unfinished)) blockers.push("The history copy has unverified tables.");
  } finally { history.close(); bridge.close(); }
  return blockers;
}

/** Removes only what is proven redundant at the moment of removal, under the maintenance lock, then compacts.
 * - bridge.db: the legacy check and every DROP run in one write transaction, so no writer can slip in between;
 * - history.db: each v1_* and retained_* table is proven against v2 inside the transaction that drops it;
 * - files: each is proven row by row (or byte by byte) right before it is removed. */
export function runFinalize(home: string, report: (line: string) => void): FinalizePlan {
  const release = maintenanceLock(home);
  try {
    const found = candidates(home);
    if (found.blockers.length) return plan(found.blockers, [], []);
    const verification = verifyBeforeFinalize(home, report);
    if (verification.length) return plan(verification, [], []);
    report("verification passed; removing the old-format data that is proven redundant…");
    const removed: FinalizeItem[] = [], kept: FinalizeItem[] = [];
    if (found.bridgeTables.length) {
      const db = new DatabaseSync(join(home, DB_FILE_NAME), { timeout: 30_000 });
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const history = openHistoryReader(historyDbPath(join(home, DB_FILE_NAME)), 5000);
          let blockers: string[];
          try { blockers = verifyLegacyBridge(db, history, report); } finally { history.close(); }
          if (blockers.length) { db.exec("ROLLBACK"); return plan(blockers, [], []); }
          for (const item of found.bridgeTables) {
            db.exec(`DROP TABLE IF EXISTS "${item.path.slice("bridge.db:".length).replaceAll('"', '""')}"`);
            removed.push(item);
            report(`removed ${item.path}`);
          }
          db.exec("COMMIT");
        } catch (err) { if (db.isTransaction) db.exec("ROLLBACK"); throw err; }
        report("compacting bridge.db (only the remaining core data is rewritten)…");
        db.exec("VACUUM");
      } finally { db.close(); }
    }
    {
      const db = openHistoryStore(historyDbPath(join(home, DB_FILE_NAME)));
      try {
        let dropped = 0;
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const { name, reason } of proveHistoryTables(db)) {
            const item: FinalizeItem = { kind: "table", path: `history.db:${name}`, bytes: tableBytes(db, name), reason: "earlier history format or failed attempt; every row exists in the verified v2 tables" };
            if (reason !== null) { kept.push({ ...item, reason }); report(`kept ${item.path}: ${reason}`); continue; }
            db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`);
            removed.push(item); dropped++;
            report(`removed ${item.path}`);
          }
          db.exec("COMMIT");
        } catch (err) { if (db.isTransaction) db.exec("ROLLBACK"); throw err; }
        if (dropped) db.exec("VACUUM");
      } finally { db.close(); }
    }
    const { live, close } = openLive(home);
    try {
      for (const { item, copies } of found.files) {
        const reasons = proveFile(item.path, live, copies);
        if (reasons.length) { const reason = withAbsorbHint(summarize(reasons)); kept.push({ ...item, reason }); report(`kept ${item.path}: ${reason}`); continue; }
        for (const path of [...sidecars(item.path), item.path]) rmSync(path, { recursive: true, force: true });
        removed.push(item);
        report(`removed ${item.path}`);
      }
    } finally { close(); }
    for (const group of bundledOriginals(home)) {
      // Each original is checked against a verified bundle again right here; anything else in the folder stays.
      for (const path of group.files) rmSync(path, { force: true });
      if (group.files.length) { removed.push({ kind: "directory", path: group.dir, bytes: group.bytes, reason: `${group.files.length} job copy originals that a verified bundle restores byte-exact` }); report(`removed ${group.files.length} bundled originals from ${group.dir}`); }
      if (group.unlisted.length || group.failures.length) kept.push({ kind: "directory", path: group.dir, bytes: size(group.dir), reason: summarize([...group.failures, ...group.unlisted.map(name => `${name} is in no verified bundle`)]) });
      else try { rmdirSync(group.dir); } catch { /* not empty: something appeared meanwhile; it stays */ }
    }
    return plan([], removed, kept);
  } finally { release(); }
}

/** Owner rollback before finalize: readers return to the legacy bridge.db history at once. The v2 copy is kept
 * and latched as failed, so nothing migrates again until an explicit `agent-bridge reindex` retries it. */
export function rollbackHistoryStore(home: string): string {
  const bridge = join(home, DB_FILE_NAME);
  const legacy = new DatabaseSync(bridge, { readOnly: true, timeout: 5000 });
  try {
    if (!legacy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_records'").get())
      throw new Error("The legacy history in bridge.db was already removed by storage finalize; rollback is no longer possible.");
  } finally { legacy.close(); }
  const db = openHistoryStore(historyDbPath(bridge));
  try {
    const state = db.prepare("SELECT status FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
    if (!state) return "No history migration has started; readers already use the legacy history.";
    db.prepare("UPDATE history_migration SET status='failed',manifest=? WHERE version=?")
      .run(JSON.stringify({ error: "History store rolled back by the owner; legacy history in bridge.db is in use. Run agent-bridge reindex to migrate again.", resumeStatus: "copying", rolledBackFrom: state.status }), HISTORY_STORE_VERSION);
    return "Rolled back: search and transcripts read the legacy history in bridge.db again. The new copy in history.db is kept.";
  } finally { db.close(); }
}
