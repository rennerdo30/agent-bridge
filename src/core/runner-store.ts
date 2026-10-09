import { randomUUID, createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as yieldWriters } from "node:timers/promises";
import { archiveFile, assertWritableStore, isRecord, JSON_STORE_VERSION, mergeStoreFields, readJsonStore, writeJsonStore } from "./json-store.js";
import { existingMetadataDb, metadataDb, physicalMetadataPath } from "./metadata-db.js";
import { retainMetadataFiles } from "./metadata-import.js";
import { readHistoryJson } from "./run-history.js";
import { storageLease } from "./storage-lock.js";
import { legacyStorePeers, refreshStorePeerIdentities } from "./store-compatibility.js";

/**
 * Job runner specs and states (AB-208). They used to be one `jobs/<id>.json` and `jobs/<id>.spec.json` per job,
 * read on every 2 s poll. They are now rows in bridge.db (`bridge_metadata`):
 * - `job-state/<id>`: the runner's current state. A new turn archives it to `job-state-archive` and leaves a
 *   reset marker (no pid), so a previous turn's final state never counts for the next one.
 * - `job-spec/<id>`: the current turn's launch spec; the runner marks it consumed (`consumedAt`) when it takes it.
 *   The previous turn's spec moves to `job-spec-archive`.
 * Nothing is deleted: rows are archived by key, imported files stay in a verified bundle and in cold storage.
 *
 * Mixed versions: while a 0.30.3-or-older process is alive (store capability gate), writers also keep the
 * compatible file projection, and readers also read the file and merge a newer state written by an old runner
 * into the row. Until the one-time import has run (after the gate passes), readers keep that per-job file check;
 * after it, polls read rows only.
 */
export const RUNNER_DIR = "jobs";
const STATE = "job-state", STATE_ARCHIVE = "job-state-archive", SPEC = "job-spec", SPEC_ARCHIVE = "job-spec-archive";
const MARKER_DOMAIN = "runner-store", MARKER_KEY = "import";
const LEGACY_CACHE_MS = 5_000;
const IMPORT_BATCH = 200;

/** Test hook: per-job file reads on the poll paths. Steady state with imported rows keeps them at zero. */
export const runnerStoreStats = { fileReads: 0, rowReads: 0, rowWrites: 0, projections: 0, merges: 0 };

const legacyCache = new Map<string, { at: number; value: boolean }>();

export function runnerStatePath(home: string, id: string): string { return join(home, RUNNER_DIR, `${id}.json`); }
export function runnerSpecPath(home: string, id: string): string { return join(home, RUNNER_DIR, `${id}.spec.json`); }

const validId = (id: string) => /^[\w.-]+$/.test(id) && !id.startsWith(".");

/** The metadata rows, or undefined while an older reader still blocks their creation (files stay authoritative). */
function rows(home: string): DatabaseSync | undefined {
  try { return existingMetadataDb(home) ?? metadataDb(home); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "STORE_UPGRADE_DEFERRED") return undefined;
    throw error;
  }
}

function row(db: DatabaseSync, domain: string, key: string): Record<string, unknown> | null {
  runnerStoreStats.rowReads++;
  const found = db.prepare("SELECT value FROM bridge_metadata WHERE domain=? AND key=?").get(domain, key);
  if (!found) return null;
  try { const value: unknown = JSON.parse(String(found.value)); return isRecord(value) ? value : null; } catch { return null; }
}

function put(db: DatabaseSync, domain: string, key: string, value: unknown): void {
  runnerStoreStats.rowWrites++;
  db.prepare(`INSERT INTO bridge_metadata VALUES (?,?,?,?)
   ON CONFLICT(domain,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(domain, key, JSON.stringify(value), Date.now());
}

function archive(db: DatabaseSync, domain: string, id: string, value: unknown): void {
  db.prepare("INSERT INTO bridge_metadata VALUES (?,?,?,?) ON CONFLICT(domain,key) DO NOTHING")
    .run(domain, `${id}/${Date.now()}-${randomUUID()}`, JSON.stringify(value), Date.now());
}

function transaction<T>(home: string, db: DatabaseSync, work: () => T): T {
  const release = storageLease(home);
  try {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  } finally { release(); }
}

function imported(db: DatabaseSync): boolean {
  return row(db, MARKER_DOMAIN, MARKER_KEY)?.complete === true;
}

/** Whether an older release is alive; cached briefly so polls do not query processes each time. */
export function legacyRunnerPeers(home: string): boolean {
  const key = resolve(home), cached = legacyCache.get(key);
  if (cached && Date.now() - cached.at < LEGACY_CACHE_MS) return cached.value;
  let value: boolean;
  try { value = legacyStorePeers(home).length > 0; } catch { value = true; }
  legacyCache.set(key, { at: Date.now(), value });
  if (value) {
    // Files an old runner writes from now on must be imported again once it is gone.
    try {
      const db = existingMetadataDb(home);
      if (db && imported(db)) transaction(home, db, () => put(db, MARKER_DOMAIN, MARKER_KEY, { complete: false, reopenedAt: Date.now() }));
    } catch { /* The per-job file check follows the gate itself. */ }
  }
  return value;
}

/** Test and upgrade hook: forget the cached gate result. */
export function resetRunnerStoreCache(): void { legacyCache.clear(); }

/** Readers also look at the per-job file while an old process lives or its files are not imported yet. */
function fileMode(home: string, db: DatabaseSync): boolean {
  return legacyRunnerPeers(home) || !imported(db);
}

/** As the per-file store always did: a corrupt file is preserved under a `.corrupt-` name, a newer format is returned. */
function readStateFileRaw(home: string, id: string): unknown {
  runnerStoreStats.fileReads++;
  const path = runnerStatePath(home, id);
  try { if (lstatSync(path).isSymbolicLink()) return null; }
  catch { return null; }
  return readJsonStore(path, undefined, (v) => isRecord(v) && typeof v.pid === "number" && typeof v.status === "string");
}

function readStateFile(home: string, id: string): Record<string, unknown> | null {
  const value = readStateFileRaw(home, id);
  return isRecord(value) && typeof value.pid === "number" && typeof value.status === "string" && !(Number(value.version) > JSON_STORE_VERSION) ? value : null;
}

/** Read-only and cached by file signature; a linked entry is never followed out of the bridge home. */
function readLegacyFile(path: string): unknown {
  try { if (lstatSync(path).isSymbolicLink()) return null; }
  catch { return null; }
  return readHistoryJson(path);
}

/** A state's heartbeat; a turn reset marker counts from the reset, so an earlier turn's file never wins. */
const stamp = (value: Record<string, unknown> | null) => typeof value?.updatedAt === "number" ? value.updatedAt : typeof value?.turnResetAt === "number" ? value.turnResetAt : -Infinity;
const hasState = (value: Record<string, unknown> | null) => Boolean(value && typeof value.pid === "number" && typeof value.status === "string");
const stateBase = (value: Record<string, unknown> | null) => hasState(value) ? value! : {};

/**
 * An older runner rewrites its whole state file, so a newer file replaces the row. A row of another runner
 * (an earlier turn) is archived first: its fields must not leak into this turn, and must not be lost.
 */
function adoptFileState(db: DatabaseSync, id: string, stored: Record<string, unknown> | null, file: Record<string, unknown>): Record<string, unknown> {
  runnerStoreStats.merges++;
  if (hasState(stored) && stored!.pid !== file.pid) archive(db, STATE_ARCHIVE, id, stored);
  put(db, STATE, id, file);
  return file;
}

/** The newer of row and file state; a newer file (an old runner) is taken into the row so it is never lost. */
function currentState(home: string, db: DatabaseSync, id: string, write: boolean): Record<string, unknown> | null {
  const stored = row(db, STATE, id);
  if (!fileMode(home, db)) return stored;
  const file = readStateFile(home, id);
  if (!file || stamp(stored) >= stamp(file)) return stored;
  return write ? adoptFileState(db, id, stored, file) : file;
}

/** A runner's raw state record (validated by the caller), or null. */
export function readRunnerStateRecord(home: string, id: string): Record<string, unknown> | null {
  if (!validId(id)) return null;
  const db = rows(home);
  if (!db) return readStateFile(home, id);
  const stored = row(db, STATE, id);
  if (!fileMode(home, db)) return hasState(stored) ? stored : null;
  const file = readStateFile(home, id);
  if (!file || stamp(stored) >= stamp(file)) return hasState(stored) ? stored : null;
  // An older runner wrote a newer state: take it into the row now.
  let merged: Record<string, unknown> | null;
  try { merged = transaction(home, db, () => currentState(home, db, id, true)); }
  catch { merged = file; }
  return hasState(merged) ? merged : null;
}

/** Atomic merge of the runner's state; old readers also get the file while they live. */
export function writeRunnerStateRecord(home: string, id: string, state: Record<string, unknown>): void {
  if (!validId(id)) throw new Error(`Invalid job id: ${id}`);
  const path = runnerStatePath(home, id);
  const db = rows(home);
  if (!db) {
    const previous = readJsonStore(path);
    writeJsonStore(path, mergeStoreFields(isRecord(previous) ? previous : {}, { ...state }), previous);
    return;
  }
  const legacy = legacyRunnerPeers(home);
  // A file of a newer format is never overwritten, nor shadowed by a row.
  if (!legacy && fileMode(home, db)) assertWritableStore(readStateFileRaw(home, id));
  let next: Record<string, unknown> = {};
  if (legacy) {
    // File first: a deferred store upgrade leaves both copies unchanged, as before.
    const previous = readJsonStore(path);
    const file = isRecord(previous) ? previous : null, stored = row(db, STATE, id);
    next = mergeStoreFields(stateBase(stamp(stored) > stamp(file) ? stored : file), { ...state, version: JSON_STORE_VERSION });
    writeJsonStore(path, next, previous);
    runnerStoreStats.projections++;
  }
  transaction(home, db, () => {
    const previous = currentState(home, db, id, true);
    assertWritableStore(previous);
    put(db, STATE, id, mergeStoreFields(stateBase(previous), legacy ? next : { ...state, version: JSON_STORE_VERSION }));
  });
}

/** The current turn's launch spec, while no runner has taken it (as the file used to exist only until then). */
export function readPendingRunnerSpec(home: string, id: string): Record<string, unknown> | null {
  if (!validId(id)) return null;
  const db = rows(home);
  if (db) {
    const spec = row(db, SPEC, id);
    if (spec && spec.consumedAt === undefined) return spec;
    if (!fileMode(home, db)) return null;
  }
  runnerStoreStats.fileReads++;
  const value = readLegacyFile(runnerSpecPath(home, id));
  return isRecord(value) ? value : null;
}

/**
 * The server's side of a new turn: archive the previous turn's state and spec, then publish the new spec.
 * Returns the path handed to the runner (its file exists only for older readers).
 */
export function publishRunnerSpec(home: string, id: string, spec: Record<string, unknown>): string {
  if (!validId(id)) throw new Error(`Invalid job id: ${id}`);
  const statePath = runnerStatePath(home, id), specPath = runnerSpecPath(home, id);
  const db = rows(home);
  if (!db || fileMode(home, db)) {
    // Files of an earlier turn must not count for this one (and stay retained in the archive).
    archiveFile(statePath);
    archiveFile(specPath);
  }
  if (!db) { writeJsonStore(specPath, { ...spec }, null); return specPath; }
  transaction(home, db, () => {
    const state = row(db, STATE, id), previous = row(db, SPEC, id);
    if (hasState(state)) archive(db, STATE_ARCHIVE, id, state);
    put(db, STATE, id, { version: JSON_STORE_VERSION, turnResetAt: Date.now() });
    if (previous) archive(db, SPEC_ARCHIVE, id, previous);
    put(db, SPEC, id, { ...spec, version: JSON_STORE_VERSION });
  });
  if (legacyRunnerPeers(home)) { writeJsonStore(specPath, { ...spec }, null); runnerStoreStats.projections++; }
  return specPath;
}

/** The runner's side: take the spec once. A spec only in a file (older server, test fixtures) is still read. */
export function takeRunnerSpec(specFile: string): Record<string, unknown> | null {
  const name = basename(specFile), dir = dirname(specFile);
  const match = /^(.+)\.spec\.json$/.exec(name);
  if (match && basename(dir) === RUNNER_DIR && validId(match[1]!)) {
    const home = dirname(dir), id = match[1]!;
    const db = rows(home);
    if (db) {
      const taken = transaction(home, db, () => {
        const spec = row(db, SPEC, id);
        if (!spec || spec.consumedAt !== undefined) return null;
        assertWritableStore(spec);
        put(db, SPEC, id, { ...spec, consumedAt: Date.now(), consumedBy: process.pid });
        return spec;
      });
      if (taken) {
        archiveFile(specFile);
        const { consumedAt: _consumed, consumedBy: _by, ...spec } = taken;
        return spec;
      }
    }
  }
  const data = readJsonStore(specFile);
  assertWritableStore(data);
  if (!isRecord(data)) return null;
  archiveFile(specFile);
  return data;
}

/** Ids with a runner state row (diagnostics and test teardown). */
export function runnerStateIds(home: string): string[] {
  const db = rows(home);
  const ids = db ? db.prepare("SELECT key FROM bridge_metadata WHERE domain=?").all(STATE).map(r => String(r.key)) : [];
  const dir = join(home, RUNNER_DIR);
  if (existsSync(dir)) for (const file of readdirSync(dir)) if (file.endsWith(".json") && !file.endsWith(".spec.json")) ids.push(file.slice(0, -5));
  return [...new Set(ids)];
}

export interface RunnerImportResult { imported: number; deferred: boolean; remaining: number; bundles: string[] }

function legacyFiles(home: string): string[] {
  const root = join(home, RUNNER_DIR), files: string[] = [];
  for (const dir of [root, join(root, "archive"), join(root, ".import")]) {
    if (!existsSync(dir)) continue;
    physicalMetadataPath(dir);
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      physicalMetadataPath(path);
      // A temp file belongs to a writer that may still rename it; it stays where it is.
      if (name.endsWith(".tmp") || !lstatSync(path).isFile()) continue;
      files.push(path);
    }
  }
  return files;
}

/** A path imported before (an old runner rewrote it later) is staged under a unique name first. */
function staged(home: string, db: DatabaseSync, file: string, raw: () => Buffer): string {
  const rel = file.slice(resolve(home).length + 1).replace(/\\/g, "/");
  const prior = db.prepare("SELECT sha256,cold_path FROM bridge_imports WHERE path=?").get(rel);
  if (!prior) return file;
  // Crash between the import transaction and the move: the same bytes are just moved to cold storage.
  if (prior.sha256 === createHash("sha256").update(raw()).digest("hex") && !existsSync(String(prior.cold_path))) return file;
  const dir = join(home, RUNNER_DIR, ".import");
  physicalMetadataPath(dir); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, `${basename(file)}~${Date.now()}-${randomUUID()}`);
  renameSync(file, target);
  return target;
}

function projectFile(store: DatabaseSync, path: string, raw: Buffer): void {
  let value: unknown;
  try { value = JSON.parse(raw.toString("utf8")); } catch { return; }
  if (!isRecord(value)) return;
  const parts = path.split("/"), name = parts.at(-1)!;
  const live = /^(.+?)(\.spec)?\.json(?:~\d+-[\w-]+)?$/.exec(name);
  const old = /^(.+?)(\.spec)?\.json-\d+-[\w-]+$/.exec(name);
  if (parts[1] !== "archive" && live && validId(live[1]!)) {
    const id = live[1]!;
    if (live[2]) {
      const current = row(store, SPEC, id);
      if (!current) put(store, SPEC, id, value);
      else if (JSON.stringify(current) !== JSON.stringify(value)) archive(store, SPEC_ARCHIVE, id, value);
      return;
    }
    const current = row(store, STATE, id);
    if (hasState(value) && stamp(value) > stamp(current)) adoptFileState(store, id, current, value);
    else if (JSON.stringify(current) !== JSON.stringify(value)) archive(store, STATE_ARCHIVE, id, value);
    return;
  }
  if (parts[1] === "archive" && old && validId(old[1]!)) archive(store, old[2] ? SPEC_ARCHIVE : STATE_ARCHIVE, old[1]!, value);
}

/**
 * One-time lossless import of `jobs/` (live, staged and archived runner files): every file goes byte-exact
 * into a verified bundle, is projected into rows, then moves to cold storage. Runs only after the store
 * capability gate shows no older process (they still write these files). Resumable: a crash before the
 * transaction leaves the files in place; one after it moves the same bytes on the next run.
 */
export async function importRunnerFiles(home: string, opts: { signal?: AbortSignal; batch?: number; afterBatch?: (n: number) => void } = {}): Promise<RunnerImportResult> {
  const result: RunnerImportResult = { imported: 0, deferred: false, remaining: 0, bundles: [] };
  await refreshStorePeerIdentities(home, opts.signal).catch(() => {});
  legacyCache.delete(resolve(home));
  let files = legacyFiles(home);
  // Nothing to import and no store yet: the first runner creates it; do not migrate an idle home.
  if (!files.length && !existingMetadataDb(home)) return result;
  const db = rows(home);
  if (!db || legacyRunnerPeers(home)) { result.deferred = true; result.remaining = files.length; return result; }
  let batches = 0;
  for (let offset = 0; offset < files.length; offset += opts.batch ?? IMPORT_BATCH) {
    opts.signal?.throwIfAborted();
    const batch = files.slice(offset, offset + (opts.batch ?? IMPORT_BATCH)).map(file => staged(home, db, file, () => readFileSync(file)));
    try { result.bundles.push(...retainMetadataFiles(home, batch, projectFile)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "STORE_UPGRADE_DEFERRED") { result.deferred = true; break; }
      throw error;
    }
    result.imported += batch.length;
    opts.afterBatch?.(++batches);
    // Give runners and the broker a real window for their own writes between bounded batches.
    await yieldWriters(5);
    legacyCache.delete(resolve(home));
    if (legacyRunnerPeers(home)) { result.deferred = true; break; }
  }
  files = legacyFiles(home);
  result.remaining = files.length;
  if (!result.deferred && !files.length) {
    legacyCache.delete(resolve(home));
    if (!legacyRunnerPeers(home)) transaction(home, db, () => put(db, MARKER_DOMAIN, MARKER_KEY, { complete: true, importedAt: Date.now() }));
  }
  return result;
}

/** Whether the import has completed and no older process reopened the file paths. */
export function runnerFilesImported(home: string): boolean {
  const db = existingMetadataDb(home);
  return Boolean(db && imported(db));
}
