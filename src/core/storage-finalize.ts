import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE_NAME } from "./constants.js";
import { extractBundle, readBundleManifest } from "./archive-bundle.js";
import { historyDbPath, historyReady, legacyTailConflicts, openHistoryReader, openHistoryStore, HISTORY_STORE_VERSION } from "./history-store.js";
import { HISTORY_V1_PREFIX } from "./history-migration.js";
import { jobArchivePath, openJobArchive } from "./job-archive-index.js";
import { maintenanceLock } from "./storage-lock.js";
import { ARCHIVE_DB_NAME } from "./sqlite-maintenance.js";
import { alignedTarget, derivedTables, estimateRows, logicalTable, proofProgress, proveFile, proveTable, sidecars, tableProof, type LiveDb, type ProofContext, type ProofProgress, type ReferenceSnapshot } from "./finalize-proof.js";

/** Owner decision 2026-10-09: superseded data is removed only after the new format is migrated, verified
 * (counts + hashes) and healthy, and only by this explicit, confirmed command. Every item is proven redundant row by
 * row (finalize-proof.ts) immediately before its removal; anything that cannot be proven is kept and reported.
 * The plan without --yes only lists candidates and runs cheap checks (seconds); the proof runs with --yes, or with
 * --check, which proves everything and removes nothing. */
export interface FinalizeItem { kind: "table" | "file" | "directory"; path: string; bytes: number; reason: string }
export interface FinalizePlan { ready: boolean; blockers: string[]; items: FinalizeItem[]; bytes: number; kept: FinalizeItem[]; proven: boolean }
export interface FinalizeOptions {
  /** Prove everything, remove nothing. */
  dryRun?: boolean;
  /** Measurement hook, honoured only with dryRun: prove the history data even while the job archive import is
   * incomplete (job copies are then left out of the proof). */
  ignoreJobArchive?: boolean;
}

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

/* Table sizes are not measured: dbstat walks every page of a table (minutes on a 20 GB store). The space a run
 * frees shows in the database file sizes after its compaction. */

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

/** The snapshot the verified v2 migration copied from, with its manifest (per-table row count and chained sha256). */
export function referenceSnapshot(history: DatabaseSync): ReferenceSnapshot | undefined {
  try {
    const state = history.prepare("SELECT snapshot,status,manifest,source FROM history_migration WHERE version=?").get(HISTORY_STORE_VERSION);
    if (state?.status !== "verified" || !state.snapshot || !state.manifest) return undefined;
    const manifest = JSON.parse(String(state.manifest)) as ReferenceSnapshot["manifest"];
    if (!manifest || typeof manifest !== "object" || !Object.values(manifest).every(v => Number.isInteger(v?.rows) && typeof v?.sha256 === "string")) return undefined;
    return { path: String(state.snapshot), prefix: state.source === "history-v1" ? HISTORY_V1_PREFIX : "", manifest };
  } catch { return undefined; }
}

/** The live databases a proof may rely on. Legacy bridge.db history tables never count: finalize removes them. */
export function openLive(home: string): { live: LiveDb[]; history?: DatabaseSync; close: () => void } {
  const live: LiveDb[] = [];
  const bridge = join(home, DB_FILE_NAME), archive = join(home, ARCHIVE_DB_NAME), history = historyDbPath(bridge);
  let historyDb: DatabaseSync | undefined;
  try {
    if (existsSync(bridge)) live.push({ label: "bridge.db", db: new DatabaseSync(bridge, { readOnly: true, timeout: 5000 }), exclude: new Set(LEGACY_BRIDGE_TABLES) });
    if (existsSync(archive)) live.push({ label: "archive.db", db: new DatabaseSync(archive, { readOnly: true, timeout: 5000 }) });
    if (existsSync(history)) { historyDb = openHistoryReader(history, 5000); live.push({ label: "history.db", db: historyDb }); }
  } catch (err) { for (const l of live) l.db.close(); throw err; }
  return { live, history: historyDb, close: () => { for (const l of live) l.db.close(); } };
}

/** Old-format history tables kept inside history.db (v1_* from the v1→v2 upgrade, retained_* from failed attempts). */
function historyCandidates(db: DatabaseSync): { name: string; derived: boolean }[] {
  const derived = derivedTables(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE ? OR name LIKE 'retained\\_%' ESCAPE '\\') ORDER BY name").all(`${HISTORY_V1_PREFIX}%`).map(row => String(row.name));
  const virtual = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'").all().map(row => String(row.name)));
  // Shadow tables of a search index go with their virtual table.
  return names.filter(name => !derived.has(name) || virtual.has(name)).map(name => ({ name, derived: derived.has(name) }));
}

/** Proves each v1_* and retained_* table against the live v2 tables in the same file, in rowid order. A derived
 * search index is listed only once the table it indexes is proven. */
function proveHistoryTables(db: DatabaseSync, progress?: ProofProgress): { name: string; reason: string | null }[] {
  const candidates = historyCandidates(db);
  const ctx: ProofContext = { live: [{ label: "history.db v2", db, exclude: new Set(candidates.map(c => c.name)) }], history: db, progress };
  const results = candidates.filter(c => !c.derived).map(c => {
    progress?.note(`checking history.db:${c.name}…`);
    return { name: c.name, reason: proveTable(db, c.name, ctx, alignedTarget(c.name, ctx, true)) };
  });
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

/** Bundle manifests by original name. With `verify`, a bundle counts only after it restores byte-exact (one at a time,
 * bounded memory); without, the manifests are only read (cheap, for the plan). */
function bundleEntries(dir: string, verify: boolean): { entries: Map<string, Set<string>>; failures: string[] } {
  const entries = new Map<string, Set<string>>(), failures: string[] = [];
  for (const manifest of existsSync(dir) ? readdirSync(dir).filter(name => name.endsWith(".manifest.json")) : []) {
    try {
      if (verify) extractBundle(join(dir, manifest));
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

/** Originals restored byte-exact by a verified bundle; every other file in the folder stays. Without `verify` only
 * names and sizes are compared with the manifests (plan). */
function bundledOriginals(home: string, verify: boolean): { dir: string; files: string[]; bytes: number; unlisted: string[]; failures: string[] }[] {
  const cold = join(home, ...COLD_JOBS);
  const dirs = ["archive-originals", "root-originals"].map(name => join(cold, name)).filter(existsSync);
  if (!dirs.length) return [];
  const { entries, failures } = bundleEntries(cold, verify);
  return dirs.map(dir => {
    const files: string[] = [], unlisted: string[] = [];
    let bytes = 0;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name), st = lstatSync(path);
      const listed = st.isFile() && [...(entries.get(name) ?? [])].some(e => e.startsWith(`${st.size}:`));
      if (listed && (!verify || entries.get(name)!.has(`${st.size}:${fileDigest(path)}`))) { files.push(path); bytes += st.size; }
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
        bridgeTables.push({ kind: "table", path: `bridge.db:${name}`, bytes: 0, reason: "legacy history, copied into history.db and verified" });
    } finally { db.close(); }
  }
  return { blockers, bridgeTables, history: historyVerified, files: historyVerified ? fileCandidates(home) : [] };
}

function plan(blockers: string[], items: FinalizeItem[], kept: FinalizeItem[], proven: boolean): FinalizePlan {
  return { ready: blockers.length === 0, blockers, items, bytes: items.reduce((n, i) => n + i.bytes, 0), kept, proven };
}

const samePath = (a: string, b: string) => process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);

/** The plan: candidates, sizes and reasons, plus cheap checks only (migration states, manifests). It reads no table.
 * Every listed item is proven row by row when `--yes` (or `--check`) runs; `prove: true` runs that proof now. */
export function planFinalize(home: string, options: { prove?: boolean; report?: (line: string) => void } = {}): FinalizePlan {
  if (options.prove) return runFinalize(home, options.report ?? (() => {}), { dryRun: true });
  const found = candidates(home);
  const items: FinalizeItem[] = found.bridgeTables.map(i => ({ ...i, reason: `${i.reason}; proven against history.db v2 at removal` })), kept: FinalizeItem[] = [];
  if (found.history) {
    const db = openHistoryReader(historyDbPath(join(home, DB_FILE_NAME)), 1000);
    let reference: ReferenceSnapshot | undefined;
    try {
      reference = referenceSnapshot(db);
      for (const { name } of historyCandidates(db))
        items.push({ kind: "table", path: `history.db:${name}`, bytes: 0, reason: "earlier history format or failed attempt; proven against the v2 tables row by row at removal" });
    } finally { db.close(); }
    for (const { item } of found.files) {
      const isReference = reference && samePath(reference.path, item.path);
      items.push({ ...item, reason: isReference
        ? "source snapshot of the verified history migration; its history tables are proven by the migration manifest, every other row against the live databases at removal"
        : `${item.reason}; proven row by row at removal` });
    }
  }
  if (!found.blockers.length) for (const group of bundledOriginals(home, false)) {
    if (group.files.length) items.push({ kind: "directory", path: group.dir, bytes: group.bytes, reason: `${group.files.length} job copy originals listed in bundle manifests; their bytes are verified against the bundles at removal` });
    if (group.unlisted.length || group.failures.length) kept.push({ kind: "directory", path: group.dir, bytes: size(group.dir) - group.bytes, reason: summarize([...group.failures, ...group.unlisted.map(name => `${name} is in no bundle manifest`)]) });
  }
  return plan(found.blockers, items, kept, false);
}

const summarize = (reasons: string[]) => reasons.length > 3 ? `${reasons.slice(0, 3).join("; ")}; and ${reasons.length - 3} more` : reasons.join("; ");
/** Rows or files that exist nowhere else can be imported losslessly first; conflicts never can. */
const withAbsorbHint = (reason: string) => /rows are not in|rows, and no live|no identical copy exists/.test(reason) ? `${reason} (run agent-bridge storage absorb to import what exists only here)` : reason;

/** Proof that nothing of the legacy bridge.db history exists only in bridge.db, comparing each legacy table with its
 * v2 copy in rowid order (the copy kept every rowid); rows that moved (the legacy tail) are found by natural key:
 * - every legacy transcript record exists in v2 with byte-identical raw bytes;
 * - every row of every other legacy table exists in v2 by its key. */
function verifyLegacyBridge(bridge: DatabaseSync, history: DatabaseSync, report: (line: string) => void, progress?: ProofProgress): string[] {
  const blockers: string[] = [];
  const has = (db: DatabaseSync, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const ctx: ProofContext = { live: [{ label: "history.db", db: history }], history, progress };
  for (const table of LEGACY_BRIDGE_TABLES) {
    if (table === "history_fts" || !has(bridge, table)) continue;
    if (!has(history, table)) { blockers.push(`history.db has no ${table} table.`); continue; }
    report(table === "conversation_records" ? "comparing every legacy transcript record byte-for-byte…" : `checking that every ${table} row exists in history.db…`);
    const proof = tableProof(bridge, table, ctx, { db: history, table });
    let missing = 0, different = 0;
    for (const chunk of proof.chunks()) for (const { status } of chunk.rows) status === "missing" ? missing++ : different++;
    if (table === "conversation_records") {
      if (missing) blockers.push(`${missing} legacy transcript records are not in history.db yet (the legacy tail has not caught up).`);
      if (different) blockers.push(`${different} legacy transcript records differ from their copy in history.db.`);
      report(`  ${proof.total.toLocaleString("en")} records checked, ${missing} missing, ${different} different`);
    } else if (table === "history_documents") {
      // Derived search documents are rebuilt from records; a reindex may legitimately replace them.
      if (missing + different) report(`  ${missing + different} legacy search documents were re-derived after a reindex; their source records are verified above.`);
    } else if (missing + different) blockers.push(`${missing + different} ${table} rows exist only in bridge.db.`);
  }
  return blockers;
}

/** Independent checks before anything is removed: v2 is verified and complete, and no
 * legacy tail conflict is open. The legacy bridge.db history is proven inside the transaction that drops it. */
export function verifyBeforeFinalize(home: string, report: (line: string) => void = () => {}): string[] {
  const blockers: string[] = [];
  const bridgeFile = join(home, DB_FILE_NAME), historyFile = historyDbPath(bridgeFile);
  if (!existsSync(historyFile)) return ["history.db does not exist."];
  const history = openHistoryReader(historyFile, 5000);
  try {
    if (!historyReady(history)) return ["History store v2 is not verified."];
    // No whole-file quick_check (5 minutes on a 10 GB store): every page a proof relies on is read and checked by
    // SQLite while proving, and a read error keeps the data (it is a blocker or a kept item, never a removal).
    const conflicts = legacyTailConflicts(history);
    if (conflicts) blockers.push(`${conflicts} legacy tail conflict(s): bridge.db rows whose bytes differ from history.db or lack a conversation; both copies are retained in history_legacy_conflicts. Resolve them before finalize.`);
    const unfinished = history.prepare("SELECT count(*) n FROM history_copy_state WHERE verified=0").get()!.n;
    if (Number(unfinished)) blockers.push("The history copy has unverified tables.");
  } finally { history.close(); }
  return blockers;
}

/** Rows the proof will read, from max(rowid) estimates (no scans), for the progress ETA. */
function proofWork(home: string, found: Candidates): number {
  let rows = 0;
  const add = (db: DatabaseSync, tables: string[]) => { for (const t of tables) { try { rows += Number(db.prepare(`SELECT coalesce(max(rowid),0) n FROM "${t.replaceAll('"', '""')}"`).get()!.n); } catch { /* none */ } } };
  const bridge = join(home, DB_FILE_NAME);
  if (found.bridgeTables.length) {
    const db = new DatabaseSync(bridge, { readOnly: true, timeout: 5000 });
    try { add(db, found.bridgeTables.map(i => i.path.slice("bridge.db:".length)).filter(t => t !== "history_fts")); } finally { db.close(); }
  }
  const history = new DatabaseSync(historyDbPath(bridge), { readOnly: true, timeout: 5000 });
  try { add(history, historyCandidates(history).filter(c => !c.derived).map(c => c.name)); } finally { history.close(); }
  for (const { item } of found.files) for (const file of item.kind === "directory" ? [] : [item.path]) rows += estimateRows(file);
  return rows;
}

/** Removes only what is proven redundant at the moment of removal, under the maintenance lock, then compacts.
 * - bridge.db: the legacy proof and every DROP run in one write transaction, so no writer can slip in between;
 * - history.db: each v1_* and retained_* table is proven against v2 inside the transaction that drops it;
 * - files: each is proven row by row (or byte by byte) right before it is removed; the verified migration's source
 *   snapshot is proven by its manifest and removed last, after every other copy.
 * With `dryRun` everything is proven exactly the same way and nothing is removed or locked. */
export function runFinalize(home: string, report: (line: string) => void, options: FinalizeOptions = {}): FinalizePlan {
  const dry = options.dryRun === true;
  const release = dry ? () => {} : maintenanceLock(home);
  try {
    const found = candidates(home);
    const jobArchiveOnly = dry && options.ignoreJobArchive === true && found.history && found.blockers.every(b => b.startsWith("Job archive"));
    if (found.blockers.length && !jobArchiveOnly) return plan(found.blockers, [], [], true);
    const verification = verifyBeforeFinalize(home, report);
    if (verification.length) return plan(verification, [], [], true);
    const started = Date.now();
    const progress = proofProgress(proofWork(home, found), report);
    report(dry ? "verification passed; proving every listed item (nothing is removed)…" : "verification passed; removing the old-format data that is proven redundant…");
    const removed: FinalizeItem[] = [], kept: FinalizeItem[] = [];
    if (found.bridgeTables.length) {
      const db = new DatabaseSync(join(home, DB_FILE_NAME), { timeout: 30_000, readOnly: dry });
      try {
        if (!dry) db.exec("BEGIN IMMEDIATE");
        try {
          const history = openHistoryReader(historyDbPath(join(home, DB_FILE_NAME)), 5000);
          let blockers: string[];
          try { blockers = verifyLegacyBridge(db, history, report, progress); } finally { history.close(); }
          if (blockers.length) { if (!dry) db.exec("ROLLBACK"); return plan(blockers, [], [], true); }
          for (const item of found.bridgeTables) {
            const name = item.path.slice("bridge.db:".length);
            const sized = { ...item, bytes: 0 };
            if (!dry) { db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`); report(`removed ${item.path}`); }
            removed.push(sized);
          }
          if (!dry) db.exec("COMMIT");
        } catch (err) { if (db.isTransaction) db.exec("ROLLBACK"); throw err; }
        if (!dry) { report("compacting bridge.db (only the remaining core data is rewritten)…"); db.exec("VACUUM"); }
      } finally { db.close(); }
    }
    {
      const file = historyDbPath(join(home, DB_FILE_NAME));
      const db = dry ? openHistoryReader(file, 5000) : openHistoryStore(file);
      try {
        let dropped = 0;
        if (!dry) db.exec("BEGIN IMMEDIATE");
        try {
          for (const { name, reason } of proveHistoryTables(db, progress)) {
            const item: FinalizeItem = { kind: "table", path: `history.db:${name}`, bytes: 0, reason: "earlier history format or failed attempt; every row exists in the verified v2 tables" };
            if (reason !== null) { kept.push({ ...item, reason }); report(`kept ${item.path}: ${reason}`); continue; }
            if (!dry) { db.exec(`DROP TABLE IF EXISTS "${name.replaceAll('"', '""')}"`); report(`removed ${item.path}`); dropped++; }
            removed.push(item);
          }
          if (!dry) db.exec("COMMIT");
        } catch (err) { if (db.isTransaction) db.exec("ROLLBACK"); throw err; }
        if (dropped) db.exec("VACUUM");
      } finally { db.close(); }
    }
    const { live, history, close } = openLive(home);
    try {
      const reference = history ? referenceSnapshot(history) : undefined;
      const ctx: ProofContext = { live, history, reference, progress };
      // Other copies may be compared with the reference snapshot's rows indirectly (through v2); it goes last anyway.
      const files = [...found.files].sort((a, b) => Number(!!reference && samePath(reference.path, a.item.path)) - Number(!!reference && samePath(reference.path, b.item.path)));
      for (const { item, copies } of files) {
        report(`checking ${item.path}…`);
        const reasons = proveFile(item.path, ctx, copies);
        if (reasons.length) { const reason = withAbsorbHint(summarize(reasons)); kept.push({ ...item, reason }); report(`kept ${item.path}: ${reason}`); continue; }
        if (!dry) { for (const path of [...sidecars(item.path), item.path]) rmSync(path, { recursive: true, force: true }); report(`removed ${item.path}`); }
        removed.push(item);
      }
    } finally { close(); }
    for (const group of jobArchiveOnly ? [] : bundledOriginals(home, true)) {
      // Each original is checked against a verified bundle again right here; anything else in the folder stays.
      if (!dry) for (const path of group.files) rmSync(path, { force: true });
      if (group.files.length) { removed.push({ kind: "directory", path: group.dir, bytes: group.bytes, reason: `${group.files.length} job copy originals that a verified bundle restores byte-exact` }); if (!dry) report(`removed ${group.files.length} bundled originals from ${group.dir}`); }
      if (group.unlisted.length || group.failures.length) kept.push({ kind: "directory", path: group.dir, bytes: size(group.dir), reason: summarize([...group.failures, ...group.unlisted.map(name => `${name} is in no verified bundle`)]) });
      else if (!dry) try { rmdirSync(group.dir); } catch { /* not empty: something appeared meanwhile; it stays */ }
    }
    report(`proof finished in ${Math.round((Date.now() - started) / 1000)} s (${progress.done().toLocaleString("en")} rows read)`);
    return plan([], removed, kept, true);
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
