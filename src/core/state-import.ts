import { lstatSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BigIntStats } from "node:fs";
import { bytesDigest, counter, object, parseExactJson } from "./state-jobs.js";

/** Retention-only synthetic cold-copy importer. No live source SQLite handle is
 * opened, even read-only. Production admission is deliberately unavailable:
 * a real source needs a trusted consistent-capture/immutable-source adapter.
 * Missing sidecars alone are NOT proof that an owner database is cold.
 */
export function productionLegacyImport(_request: unknown): { status: "authority_unavailable" } {
  return { status: "authority_unavailable" };
}
export const SHADOW_IMPORT_SCHEMA = `
CREATE TABLE retained_sources (
 source_id TEXT NOT NULL, generation TEXT NOT NULL, digest TEXT NOT NULL,
 snapshot_identity TEXT NOT NULL, manifest BLOB NOT NULL, raw BLOB NOT NULL,
 format TEXT NOT NULL, parse_state TEXT NOT NULL, generation_conflict INTEGER NOT NULL,
 PRIMARY KEY(source_id,generation,digest)
);
CREATE TABLE retained_occurrences (
 source_id TEXT NOT NULL, generation TEXT NOT NULL, digest TEXT NOT NULL,
 occurrence INTEGER NOT NULL, locator TEXT NOT NULL, job_key TEXT,
 legacy_turn_key TEXT, execution_evidence TEXT NOT NULL CHECK(execution_evidence='unknown'),
 raw BLOB NOT NULL, projection TEXT NOT NULL,
 PRIMARY KEY(source_id,generation,digest,occurrence),
 FOREIGN KEY(source_id,generation,digest) REFERENCES retained_sources(source_id,generation,digest)
);
CREATE TABLE retained_conflicts (
 job_key TEXT NOT NULL, left_source TEXT NOT NULL, left_generation TEXT NOT NULL,
 left_digest TEXT NOT NULL, left_occurrence INTEGER NOT NULL,
 right_source TEXT NOT NULL, right_generation TEXT NOT NULL,
 right_digest TEXT NOT NULL, right_occurrence INTEGER NOT NULL,
 PRIMARY KEY(job_key,left_source,left_generation,left_digest,left_occurrence,
 right_source,right_generation,right_digest,right_occurrence)
);`;

export interface SyntheticColdSpec {
  /** Explicit fixture capture only. No autodetection, home or runtime lookup. */
  sourcePath: string;
  manifestPath: string;
  expectedManifestDigest: string;
  /** Directory prepared by the synthetic fixture, never an owner/runtime home. */
  retainedCopyDirectory: string;
}
interface ColdManifest {
  kind: "synthetic-consistent-cold-copy";
  sourceId: string; generation: string; format: "json" | "jsonl" | "sqlite";
  snapshotIdentity: string; digest: string; bytes: number;
  consistency: "closed-fixture-writers"; provenance: string;
}
export interface VerifiedSyntheticColdSource {
  readonly kind: "verified-synthetic-cold-source";
  readonly sourceId: string;
  readonly generation: string;
  readonly digest: string;
}
interface Witness { spec: SyntheticColdSpec; manifest: ColdManifest; manifestBytes: Buffer; raw: Buffer }
const witnesses = new WeakMap<VerifiedSyntheticColdSource, Witness>();

function physical(path: string): void {
  if (!isAbsolute(path)) throw new Error("source_path_not_explicit");
  // Check every storage ancestor without resolving/traversing a symbolic link.
  // A Windows drive alias remains a volume spelling, not a directory link.
  for (let at = resolve(path);;) {
    const st = lstatSync(at, { bigint: true });
    if (st.isSymbolicLink()) throw new Error("linked_source");
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
  }
}
function noSidecars(path: string): void {
  const names = new Set(readdirSync(dirname(path)));
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const base = path.slice(dirname(path).length + 1) + suffix;
    if ([...names].some(n => n.toLowerCase() === base.toLowerCase())) throw new Error("hot_or_unknown_source");
  }
}
function fingerprint(st: BigIntStats): string {
  if (!st.isFile() || st.nlink !== 1n || st.ino <= 0n || st.dev < 0n || st.birthtimeNs < 0n)
    throw new Error("unknown_source_identity");
  return `${st.dev}:${st.ino}:${st.birthtimeNs}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}
/** FS precheck is before any page SQL. Even a malformed/hot fixture is refused
 * without opening it through SQLite. This is synthetic evidence, not a native
 * no-writer/immutable-handle proof suitable for production admission.
 */
export function syntheticSourceIdentity(path: string): string {
  physical(path); noSidecars(path);
  const st = lstatSync(path, { bigint: true });
  return fingerprint(st);
}
function readPhysical(path: string): { identity: string; raw: Buffer } {
  const before = syntheticSourceIdentity(path);
  // Synthetic preparation envelope only; refuse before allocating raw bytes.
  if (lstatSync(path, { bigint: true }).size > 64n * 1024n * 1024n) throw new Error("source_too_large");
  const fd = openSync(path, "r");
  try {
    if (fingerprint(fstatSync(fd, { bigint: true })) !== before) throw new Error("changed_source_identity");
    const raw = readFileSync(fd);
    if (fingerprint(fstatSync(fd, { bigint: true })) !== before || syntheticSourceIdentity(path) !== before)
      throw new Error("changed_source_identity");
    return { identity: before, raw };
  } finally { closeSync(fd); }
}
function manifest(raw: Buffer): ColdManifest {
  const m = parseExactJson(raw);
  if (!object(m) || m.kind !== "synthetic-consistent-cold-copy" || m.consistency !== "closed-fixture-writers" ||
      typeof m.sourceId !== "string" || !m.sourceId || typeof m.provenance !== "string" || !m.provenance ||
      typeof m.snapshotIdentity !== "string" || !m.snapshotIdentity ||
      typeof m.digest !== "string" || !/^[a-f0-9]{64}$/.test(m.digest) ||
      !Number.isSafeInteger(m.bytes) || Number(m.bytes) < 0 ||
      !["json", "jsonl", "sqlite"].includes(String(m.format))) throw new Error("unknown_source_manifest");
  counter(m.generation);
  return m as unknown as ColdManifest;
}
function safeSource(spec: SyntheticColdSpec): Witness {
  physical(spec.retainedCopyDirectory);
  if (!lstatSync(spec.retainedCopyDirectory).isDirectory()) throw new Error("unknown_retention_directory");
  const captured = readPhysical(spec.manifestPath);
  if (bytesDigest(captured.raw) !== spec.expectedManifestDigest) throw new Error("changed_source_manifest");
  const m = manifest(captured.raw), source = readPhysical(spec.sourcePath);
  if (source.identity !== m.snapshotIdentity || source.raw.length !== m.bytes || bytesDigest(source.raw) !== m.digest)
    throw new Error("changed_source_generation_or_digest");
  if (m.format === "sqlite") {
    if (source.raw.length < 100 || source.raw.subarray(0, 16).toString("binary") !== "SQLite format 3\0")
      throw new Error("malformed_sqlite_source");
    // WAL-format files cannot be declared consistent merely by absent WAL.
    if (source.raw[18] !== 1 || source.raw[19] !== 1) throw new Error("hot_or_unknown_source");
  }
  return { spec: { ...spec }, manifest: m, manifestBytes: captured.raw, raw: source.raw };
}

/** A JSON DTO/Boolean cannot impersonate this in-process synthetic witness.
 * This export admits ONLY synthetic capture manifests; never a real issuer.
 */
export function verifySyntheticColdSource(spec: SyntheticColdSpec): VerifiedSyntheticColdSource {
  const w = safeSource(spec);
  const token: VerifiedSyntheticColdSource = Object.freeze({ kind: "verified-synthetic-cold-source",
    sourceId: w.manifest.sourceId, generation: w.manifest.generation, digest: w.manifest.digest });
  witnesses.set(token, w); return token;
}

interface Occurrence { locator: string; jobKey: string | null; turnKey: string | null; raw: Buffer; projection: string }
function projected(raw: Buffer, locator: string): Occurrence {
  try {
    const v = parseExactJson(raw), job = object(v) && typeof v.id === "string" ? v.id : null;
    const turn = object(v) && Object.hasOwn(v, "startedAt") ? `legacy-startedAt:${JSON.stringify(v.startedAt)}` : null;
    return { locator, jobKey: job, turnKey: turn, raw, projection: JSON.stringify({ state: "retained", value: v }) };
  } catch (error) {
    return { locator, jobKey: null, turnKey: null, raw,
      projection: JSON.stringify({ state: "unknown", reason: error instanceof Error ? error.message : "malformed_bytes" }) };
  }
}
function sqlName(name: string): string { return '"' + name.replaceAll('"', '""') + '"'; }
function sqlValue(v: unknown): unknown {
  if (typeof v === "bigint") return { sqliteType: "integer", decimal: String(v) };
  if (v instanceof Uint8Array) return { sqliteType: "blob", base64: Buffer.from(v).toString("base64") };
  if (v === null || typeof v === "number" || typeof v === "string") return v;
  throw new Error("unknown_sqlite_value");
}
function occurrences(w: Witness): { rows: Occurrence[]; state: string } {
  const m = w.manifest;
  if (m.format === "jsonl") {
    // Keep each original line INCLUDING terminators and malformed/empty lines.
    const rows: Occurrence[] = [];
    let start = 0;
    for (let i = 0; i < w.raw.length; i++) if (w.raw[i] === 10) {
      rows.push(projected(w.raw.subarray(start, i + 1), `line:${rows.length}`)); start = i + 1;
    }
    if (start < w.raw.length) rows.push(projected(w.raw.subarray(start), `line:${rows.length}`));
    return { rows, state: rows.some(r => JSON.parse(r.projection).state === "unknown") ? "unknown" : "retained" };
  }
  if (m.format === "json") {
    const whole = projected(w.raw, "document");
    const rows = [whole];
    try {
      const v = parseExactJson(w.raw);
      // Full original document retains raw key occurrences/spacing. These
      // indexed candidates are explicitly derived, never raw-original claims.
      if (Array.isArray(v)) v.forEach((entry, i) => rows.push(projected(Buffer.from(JSON.stringify(entry)), `derived-array:${i}`)));
    } catch { /* malformed/ambiguous original retained as unknown */ }
    return { rows, state: JSON.parse(whole.projection).state };
  }
  // Copy bytes to an EXCLUSIVE private retained artifact. Only that detached
  // synthetic artifact is opened for page SQL, never the source owner path.
  const copy = join(w.spec.retainedCopyDirectory, `${m.digest}.db`);
  try { writeFileSync(copy, w.raw, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const copyBytes = readPhysical(copy);
  if (bytesDigest(copyBytes.raw) !== m.digest || !copyBytes.raw.equals(w.raw)) throw new Error("changed_retained_copy");
  if (copyBytes.identity === m.snapshotIdentity) throw new Error("source_copy_alias");
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") throw new Error("malformed_sqlite_source");
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const rows: Occurrence[] = [{ locator: "sqlite-schema", jobKey: null, turnKey: null,
      raw: Buffer.from(JSON.stringify(schema)), projection: JSON.stringify({ state: "retained", schema }) }];
    for (const entry of schema) if (entry.type === "table") {
      if (typeof entry.sql !== "string" || /CREATE\s+VIRTUAL\s+TABLE/i.test(entry.sql)) throw new Error("unknown_sqlite_table");
      const table = String(entry.name), statement = db.prepare(`SELECT * FROM ${sqlName(table)}`);
      statement.setReadBigInts(true);
      let i = 0;
      for (const row of statement.iterate()) {
        const converted = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, sqlValue(v)]));
        const bytes = Buffer.from(JSON.stringify(converted));
        rows.push(projected(bytes, `sqlite:${table}:${i++}`));
        // Keep EVERY column/table row; payload projections are extra occurrences
        // and do not replace the raw DB bytes or the full typed SQLite row.
        for (const column of ["value", "payload", "metadata", "history_json"]) {
          const v = row[column];
          if (typeof v === "string" || v instanceof Uint8Array)
            rows.push(projected(typeof v === "string" ? Buffer.from(v) : Buffer.from(v), `sqlite:${table}:${i - 1}:${column}`));
        }
      }
    }
    if (syntheticSourceIdentity(copy) !== copyBytes.identity) throw new Error("changed_retained_copy");
    return { rows, state: "retained" };
  } finally { db.close(); }
}

export interface RetainedImportResult { status: "retained" | "already_retained"; sourceId: string; generation: string; digest: string; occurrences: number }
export function importSyntheticColdSource(target: DatabaseSync, token: VerifiedSyntheticColdSource): RetainedImportResult {
  const recorded = witnesses.get(token);
  if (!recorded) throw new Error("unknown_source_witness");
  if (target.prepare("SELECT mode FROM shadow_scope WHERE singleton=1").get()?.mode !== "shadow" ||
      target.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal" ||
      target.prepare("PRAGMA synchronous").get()?.synchronous !== 2 ||
      target.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1) throw new Error("shadow_target_unavailable");
  const w = safeSource(recorded.spec);
  if (!w.raw.equals(recorded.raw) || !w.manifestBytes.equals(recorded.manifestBytes)) throw new Error("changed_source_witness");
  const candidates = occurrences(w); // outside the target write transaction
  const m = w.manifest, key = [m.sourceId, m.generation, m.digest];
  target.exec("BEGIN IMMEDIATE");
  try {
    const previous = target.prepare("SELECT * FROM retained_sources WHERE source_id=? AND generation=? AND digest=?").get(...key);
    if (previous) {
      if (!Buffer.from(previous.raw as Uint8Array).equals(w.raw) ||
          !Buffer.from(previous.manifest as Uint8Array).equals(w.manifestBytes)) throw new Error("retained_identity_conflict");
      const count = target.prepare("SELECT count(*) AS n FROM retained_occurrences WHERE source_id=? AND generation=? AND digest=?").get(...key)!;
      target.exec("COMMIT");
      return { status: "already_retained", sourceId: m.sourceId, generation: m.generation, digest: m.digest, occurrences: Number(count.n) };
    }
    const conflict = target.prepare("SELECT 1 FROM retained_sources WHERE source_id=? AND generation=?").get(m.sourceId, m.generation);
    target.prepare("INSERT INTO retained_sources VALUES (?,?,?,?,?,?,?,?,?)")
      .run(...key, m.snapshotIdentity, w.manifestBytes, w.raw, m.format, candidates.state, conflict ? 1 : 0);
    candidates.rows.forEach((row, i) => {
      target.prepare("INSERT INTO retained_occurrences VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(...key, i, row.locator, row.jobKey, row.turnKey, "unknown", row.raw, row.projection);
      if (row.jobKey) {
        const others = target.prepare(`SELECT source_id,generation,digest,occurrence,raw FROM retained_occurrences
          WHERE job_key=? AND NOT(source_id=? AND generation=? AND digest=? AND occurrence=?)`)
          .all(row.jobKey, ...key, i);
        for (const other of others) if (!Buffer.from(other.raw as Uint8Array).equals(row.raw))
          target.prepare("INSERT OR IGNORE INTO retained_conflicts VALUES (?,?,?,?,?,?,?,?,?)")
            .run(row.jobKey, String(other.source_id), String(other.generation), String(other.digest), Number(other.occurrence), ...key, i);
      }
    });
    // Verify source AGAIN before committing. Failed/changed witness rolls back
    // all target rows; detached copy and every original remain untouched.
    const final = safeSource(recorded.spec);
    if (!final.raw.equals(w.raw) || !final.manifestBytes.equals(w.manifestBytes)) throw new Error("changed_source_witness");
    target.exec("COMMIT");
    return { status: "retained", sourceId: m.sourceId, generation: m.generation, digest: m.digest, occurrences: candidates.rows.length };
  } catch (error) { if (target.isTransaction) target.exec("ROLLBACK"); throw error; }
}
