import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DB_FILE_NAME } from "./constants.js";
import { physicalPath } from "./project-identity.js";
import { isDeepStrictEqual } from "node:util";

// This module is reachable from the standalone low-level lease helpers. Keep
// validation bounded and dependency-free; do not import runtime schema packages.
const CONTRACT = "protocol10-metadata5-schema14-anchor-v1";
type Identity = { dev: string; ino: string };
type Signature = Identity & { size: string; mtime: string; ctime: string };
export type BootstrapRecord = { version: 1; contract: typeof CONTRACT; attempt: string; state: "preparing" | "prepared" | "exited";
  home: string; homeIdentity: Identity; file: string; original: Record<string, Identity | null>; files?: Record<string, Identity>;
  pid: number; processIdentity: string; workerThread?: number; namespace?: string; preparedDigest?: string;
  preparingDigest?: string; preparingSignature?: Signature; anchorDigest?: string; anchorSignature?: Signature; journalIdentity?: Identity };
export type BootstrapEvidence = { record: BootstrapRecord; digest: string; signature: Signature };
type Anchor = { version: 1; contract: typeof CONTRACT; attempt: string; home: string; homeIdentity: Identity; file: string;
  original: Record<string, Identity | null>; journalIdentity: Identity };
type AnchorEvidence = { record: Anchor; digest: string; signature: Signature };
type Provenance = { version: 1; contract: typeof CONTRACT; homeIdentity: Identity; metadataIdentity: Identity; generation: string } &
  ({ kind: "ordinary" } | { kind: "cold"; anchorDigest: string; anchorSignature: Signature; journalIdentity: Identity; attempt: string });
export type BootstrapWitness = { home: string; anchor: AnchorEvidence; records: BootstrapEvidence[] };
const object = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const strict = (v: Record<string, any>, keys: string[]) => Object.keys(v).every(key => keys.includes(key));
const text = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const uuid = (v: unknown) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const digest = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const identity = (v: unknown): v is Identity => object(v) && strict(v, ["dev", "ino"]) && text(v.dev, 64) && /^\d+$/.test(v.dev) && text(v.ino, 64) && /^[1-9]\d*$/.test(v.ino);
const validSignature = (v: unknown): v is Signature => object(v) && strict(v, ["dev", "ino", "size", "mtime", "ctime"]) && identity({ dev: v.dev, ino: v.ino }) && [v.size, v.mtime, v.ctime].every(n => text(n, 64) && /^-?\d+$/.test(n));
const identities = (v: unknown, nullable: boolean) => object(v) && Object.keys(v).length <= 4 && Object.entries(v).every(([path, id]) => text(path) && (nullable && id === null || identity(id)));
function parseRecord(v: unknown): BootstrapRecord {
  if (!object(v) || !strict(v, ["version", "contract", "attempt", "state", "home", "homeIdentity", "file", "original", "files", "pid", "processIdentity", "workerThread", "namespace", "preparedDigest", "preparingDigest", "preparingSignature", "anchorDigest", "anchorSignature", "journalIdentity"]) ||
    v.version !== 1 || v.contract !== CONTRACT || !uuid(v.attempt) || !["preparing", "prepared", "exited"].includes(v.state) || !text(v.home) || !text(v.file) || !identity(v.homeIdentity) || !identities(v.original, true) ||
    !Number.isSafeInteger(v.pid) || v.pid <= 0 || !text(v.processIdentity, 256) || (v.workerThread !== undefined && (!Number.isSafeInteger(v.workerThread) || v.workerThread <= 0)) ||
    (v.files !== undefined && !identities(v.files, false)) || [v.namespace, v.preparedDigest, v.preparingDigest, v.anchorDigest].some(d => d !== undefined && !digest(d)) ||
    [v.preparingSignature, v.anchorSignature].some(s => s !== undefined && !validSignature(s)) || v.journalIdentity !== undefined && !identity(v.journalIdentity)) throw bootstrapUnknown();
  return v as BootstrapRecord;
}
let initializer: { home: string; evidence: BootstrapEvidence; check: () => void } | undefined;
export const bootstrapUnknown = () => Object.assign(new Error("Cold-store preparation is incomplete or unproven; original records are retained. Owner-coordinated isolated recovery is required; no automatic reexecution."), { code: "STORE_BOOTSTRAP_UNSETTLED" });
/** Diagnostic only. Do not expose a native import error's message, paths, stack
 * or cause, and never turn an error classification into permission to retry. */
export function bootstrapWorkerFailure(error: unknown): Error {
  let code: unknown;
  try { if (typeof error === "object" && error !== null) code = Object.getOwnPropertyDescriptor(error, "code")?.value; } catch { /* Unknown/proxy evidence remains unknown. */ }
  const categories: Record<string, string> = {
    ERR_MODULE_NOT_FOUND: "module-not-found", MODULE_NOT_FOUND: "module-not-found",
    ERR_UNKNOWN_FILE_EXTENSION: "module-format", ERR_WORKER_PATH: "worker-entry-path",
    ERR_WORKER_INVALID_EXEC_ARGV: "worker-arguments", ERR_WORKER_OUT_OF_MEMORY: "worker-memory",
  };
  const failure = typeof code === "string" && code.length <= 64 && Object.hasOwn(categories, code) ? categories[code]! : "unclassified";
  return Object.assign(bootstrapUnknown(), { bootstrapStage: "worker-start-or-module-error", bootstrapFailure: failure });
}
const KERNEL_STAGES = ["reader-admission", "anchor-publication", "preparing-publication", "metadata-initialization", "store-initialization", "owned-close", "prepared-publication", "directory-publication"];
const KERNEL_FAILURES = ["unsupported", "unsupported-or-unproven", "revoked", "sqlite-busy", "io-denied", "unsettled", "unclassified"];
/** Both IPC fields are fixed allowlists. Never forward native text/cause/paths. */
export function bootstrapKernelFailure(error: unknown, stage: string): Error {
  const own = (key: string) => { try { return typeof error === "object" && error !== null ? Object.getOwnPropertyDescriptor(error, key)?.value : undefined; } catch { return undefined; } };
  const suppliedStage = own("bootstrapStage"), suppliedReason = own("bootstrapFailure"), code = own("code");
  const phase = typeof suppliedStage === "string" && KERNEL_STAGES.includes(suppliedStage) ? suppliedStage : KERNEL_STAGES.includes(stage) ? stage : "reader-admission";
  const reason = typeof suppliedReason === "string" && KERNEL_FAILURES.includes(suppliedReason) ? suppliedReason :
    code === "ABORT_ERR" ? "revoked" : code === "SQLITE_BUSY" || code === "SQLITE_LOCKED" ? "sqlite-busy" :
    code === "EACCES" || code === "EPERM" ? "io-denied" : code === "STORE_BOOTSTRAP_UNSETTLED" ? "unsettled" : "unclassified";
  return Object.assign(bootstrapUnknown(), { bootstrapStage: phase, bootstrapFailure: reason });
}
export function bootstrapFileIdentity(file: string) {
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.ino <= 0n) throw bootstrapUnknown();
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
export function bootstrapHomeIdentity(home: string) {
  let current = resolve(home);
  for (;;) {
    const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino <= 0n) throw bootstrapUnknown();
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  const stat = lstatSync(home, { bigint: true }); return { dev: String(stat.dev), ino: String(stat.ino) };
}
export const sameBootstrapIdentity = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
export const bootstrapDigest = (record: BootstrapRecord) => createHash("sha256").update(JSON.stringify(record)).digest("hex");
const signature = (stat: BigIntStats) => ({ dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) });
function readRawEvidence(path: string): { bytes: Buffer; digest: string; signature: Signature } {
  let fd: number | undefined;
  try {
    const before = bootstrapFileIdentity(path); fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > 16384n || stat.size < 2n || String(stat.dev) !== before.dev || String(stat.ino) !== before.ino) throw bootstrapUnknown();
    const initial = signature(stat);
    if (!sameBootstrapIdentity(initial, signature(lstatSync(path, { bigint: true })))) throw bootstrapUnknown();
    const bytes = Buffer.alloc(Number(stat.size)); if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw bootstrapUnknown();
    if (!sameBootstrapIdentity(initial, signature(fstatSync(fd, { bigint: true }))) ||
        !sameBootstrapIdentity(initial, signature(lstatSync(path, { bigint: true })))) throw bootstrapUnknown();
    return { bytes, signature: initial, digest: createHash("sha256").update(bytes).digest("hex") };
  } catch { throw bootstrapUnknown(); } finally { if (fd !== undefined) closeSync(fd); }
}
export function readBootstrapEvidence(path: string): BootstrapEvidence {
  try { const { bytes, ...proof } = readRawEvidence(path), record = parseRecord(JSON.parse(bytes.toString("utf8"))); if (!record.workerThread) throw bootstrapUnknown(); return { record, ...proof }; }
  catch { throw bootstrapUnknown(); }
}
export const readBootstrapRecord = (path: string) => readBootstrapEvidence(path).record;
export function syncBootstrapDirectory(path: string): void {
  // O_DIRECTORY and an actual directory fsync are mandatory, not a file-flush
  // fallback. Unsupported Windows/filesystem behavior remains unavailable.
  if (!constants.O_DIRECTORY) throw Object.assign(bootstrapUnknown(), { bootstrapStage: "directory-publication", bootstrapFailure: "unsupported" });
  let fd: number | undefined;
  try {
    const before = bootstrapHomeIdentity(path);
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isDirectory() || String(stat.dev) !== before.dev || String(stat.ino) !== before.ino) throw bootstrapUnknown();
    fsyncSync(fd);
    if (!sameBootstrapIdentity(before, bootstrapHomeIdentity(path))) throw bootstrapUnknown();
  } catch { throw Object.assign(bootstrapUnknown(), { bootstrapStage: "directory-publication", bootstrapFailure: "unsupported-or-unproven" }); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function appendBootstrapRecord(record: BootstrapRecord, check: () => void): void {
  check();
  parseRecord(record); assertRecordAnchor(record);
  const contents = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(contents) > 16384) throw bootstrapUnknown();
  if (physicalPath(resolve(record.home)) !== record.home || dirname(record.file) !== record.home ||
      !sameBootstrapIdentity(bootstrapHomeIdentity(record.home), record.homeIdentity)) throw bootstrapUnknown();
  syncBootstrapDirectory(record.home); check(); // Probe before creating even the journal directory.
  const dir = join(record.home, ".store-bootstrap"); mkdirSync(dir, { recursive: true, mode: 0o700 }); bootstrapHomeIdentity(dir);
  check(); syncBootstrapDirectory(dir); check(); syncBootstrapDirectory(record.home); check();
  const path = join(dir, `${record.attempt}.${record.state}.json`), fd = openSync(path, "wx", 0o600);
  try { check(); writeFileSync(fd, contents); check(); fsyncSync(fd); } finally { closeSync(fd); }
  check(); syncBootstrapDirectory(dir); check(); syncBootstrapDirectory(record.home); check();
}
export function readBootstrapPair(home: string, attempt: string): { initial: BootstrapEvidence; prepared: BootstrapEvidence } {
  const dir = join(home, ".store-bootstrap"), initial = readBootstrapEvidence(join(dir, `${attempt}.preparing.json`)), prepared = readBootstrapEvidence(join(dir, `${attempt}.prepared.json`));
  const a = initial.record, b = prepared.record;
  assertRecordAnchor(a); assertRecordAnchor(b);
  if (a.home !== home || b.home !== home || a.attempt !== attempt || b.attempt !== attempt || a.state !== "preparing" || b.state !== "prepared" ||
      a.files || a.namespace || a.preparedDigest || a.preparingDigest || a.preparingSignature || !b.files || !b.namespace || b.preparedDigest ||
      b.preparingDigest !== initial.digest || !sameBootstrapIdentity(b.preparingSignature, initial.signature) ||
      b.file !== a.file || b.pid !== a.pid || b.workerThread !== a.workerThread || b.processIdentity !== a.processIdentity ||
      !sameBootstrapIdentity(a.homeIdentity, bootstrapHomeIdentity(home)) || !sameBootstrapIdentity(b.homeIdentity, a.homeIdentity) || !sameBootstrapIdentity(b.original, a.original)) throw bootstrapUnknown();
  const expected = bootstrapFiles(a.file).sort();
  if (dirname(a.file) !== home || JSON.stringify(Object.keys(a.original).sort()) !== JSON.stringify(expected) || JSON.stringify(Object.keys(b.files).sort()) !== JSON.stringify(expected)) throw bootstrapUnknown();
  for (const [file, original] of Object.entries(a.original)) if (original && !sameBootstrapIdentity(original, b.files[file])) throw bootstrapUnknown();
  return { initial, prepared };
}
/** Sole initializer exception, synchronous and exact to already durable bytes.
 * No cached home permission escapes; normal openers always inspect the ledger. */
export function withBootstrapInitializer<T>(record: BootstrapRecord, check: () => void, effect: () => T): T {
  const evidence = readBootstrapEvidence(join(record.home, ".store-bootstrap", `${record.attempt}.preparing.json`));
  if (!sameBootstrapIdentity(evidence.record, record)) throw bootstrapUnknown();
  const previous = initializer; initializer = { home: record.home, evidence, check };
  try { assertBootstrapAccess(record.home); const value = effect(); if (value && typeof (value as any).then === "function") throw bootstrapUnknown(); check(); return value; }
  finally { initializer = previous; }
}
export function assertBootstrapAccess(home: string): void {
  home = physicalPath(resolve(home));
  if (initializer?.home === home) {
    initializer.check(); const record = initializer.evidence.record;
    const current = readBootstrapEvidence(join(home, ".store-bootstrap", `${record.attempt}.preparing.json`));
    if (!sameBootstrapIdentity(current, initializer.evidence)) throw bootstrapUnknown();
    assertRecordAnchor(current.record);
    const names = readdirSync(join(home, ".store-bootstrap"));
    if (names.length !== 1 || names[0] !== `${record.attempt}.preparing.json`) throw bootstrapUnknown();
    return;
  }
  inspectBootstrapJournal(home);
}
/** The ledger is authoritative evidence, never an absence cache. Incomplete,
 * changed or oversized ledgers block. No original is deleted/reclassified. */
export function inspectBootstrapJournal(home: string): void {
  const dir = join(home, ".store-bootstrap"); let names: string[];
  const stored = storedProvenance(home), anchor = optionalAnchor(home);
  if (!anchor) {
    if (!exists(join(home, DB_FILE_NAME)) && (exists(join(home, "archive.db")) || exists(join(home, "history.db")))) throw bootstrapUnknown();
    if (stored.value?.kind === "cold" || exists(dir) || stored.version >= 5 && !stored.value) throw bootstrapUnknown();
    if (stored.value) validateProvenanceIdentity(home, stored.value);
    return;
  }
  if (stored.value?.kind !== "cold") throw bootstrapUnknown();
  validateProvenanceIdentity(home, stored.value);
  if (!sameBootstrapIdentity(coldProof(anchor), coldProof(stored.value))) throw bootstrapUnknown();
  try { if (!sameBootstrapIdentity(bootstrapHomeIdentity(dir), anchor.record.journalIdentity)) throw bootstrapUnknown(); names = readdirSync(dir); }
  catch { throw bootstrapUnknown(); }
  if (!names.length || names.length > 48 || names.length % 3) throw bootstrapUnknown();
  const groups = new Map<string, Map<string, BootstrapRecord>>();
  for (const name of names) {
    const match = /^([a-f0-9-]{36})\.(preparing|prepared|exited)\.json$/.exec(name); if (!match) throw bootstrapUnknown();
    const record = readBootstrapRecord(join(dir, name));
    if (record.attempt !== match[1] || record.state !== match[2] || record.home !== home ||
        !sameBootstrapIdentity(record.homeIdentity, bootstrapHomeIdentity(home))) throw bootstrapUnknown();
    const group = groups.get(record.attempt) ?? new Map(); group.set(record.state, record); groups.set(record.attempt, group);
  }
  for (const group of groups.values()) {
    const initial = group.get("preparing"), prepared = group.get("prepared"), exited = group.get("exited");
    if (!initial || !prepared || !prepared.files || !exited) throw bootstrapUnknown();
    const pair = readBootstrapPair(home, initial.attempt);
    if (exited.preparedDigest !== pair.prepared.digest || exited.preparingDigest !== prepared.preparingDigest || !sameBootstrapIdentity(exited.preparingSignature, prepared.preparingSignature) ||
        !sameBootstrapIdentity(exited.files, prepared.files) || exited.namespace !== prepared.namespace ||
        [prepared, exited].some(item => item.file !== initial.file || item.pid !== initial.pid || item.workerThread !== initial.workerThread || item.processIdentity !== initial.processIdentity || !sameBootstrapIdentity(item.original, initial.original))) throw bootstrapUnknown();
    if (initial.attempt !== anchor.record.attempt) throw bootstrapUnknown();
    const expected = bootstrapFiles(initial.file).sort();
    if (JSON.stringify(Object.keys(initial.original).sort()) !== JSON.stringify(expected) || JSON.stringify(Object.keys(prepared.files).sort()) !== JSON.stringify(expected)) throw bootstrapUnknown();
    for (const [file, identity] of Object.entries(prepared.files)) if (dirname(file) !== home || !sameBootstrapIdentity(identity, bootstrapFileIdentity(file))) throw bootstrapUnknown();
  }
}

export const bootstrapFiles = (file: string) => [...new Set([file, join(dirname(file), DB_FILE_NAME), join(dirname(file), "archive.db"), join(dirname(file), "history.db")])];
const anchorPath = (home: string) => join(home, ".store-bootstrap.expected.json");
const exists = (path: string) => { try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw bootstrapUnknown(); } };
function optionalAnchor(home: string): AnchorEvidence | undefined {
  try {
  if (!exists(anchorPath(home))) return;
  const { bytes, ...proof } = readRawEvidence(anchorPath(home)), v = JSON.parse(bytes.toString("utf8"));
  if (!object(v) || !strict(v, ["version", "contract", "attempt", "home", "homeIdentity", "file", "original", "journalIdentity"]) ||
    v.version !== 1 || v.contract !== CONTRACT || !uuid(v.attempt) || v.home !== home || !text(v.file) || dirname(v.file) !== home || !identity(v.homeIdentity) || !identity(v.journalIdentity) || !identities(v.original, true)) throw bootstrapUnknown();
  if (!sameBootstrapIdentity(bootstrapHomeIdentity(home), v.homeIdentity) || !sameBootstrapIdentity(bootstrapHomeIdentity(join(home, ".store-bootstrap")), v.journalIdentity)) throw bootstrapUnknown();
  return { record: v as Anchor, ...proof };
  } catch { throw bootstrapUnknown(); }
}
function coldProof(value: AnchorEvidence | Extract<Provenance, { kind: "cold" }>) {
  return "record" in value ? { attempt: value.record.attempt, anchorDigest: value.digest, anchorSignature: value.signature, journalIdentity: value.record.journalIdentity } :
    { attempt: value.attempt, anchorDigest: value.anchorDigest, anchorSignature: value.anchorSignature, journalIdentity: value.journalIdentity };
}
function assertRecordAnchor(record: BootstrapRecord): AnchorEvidence {
  const anchor = optionalAnchor(record.home);
  if (!anchor || record.attempt !== anchor.record.attempt || record.file !== anchor.record.file || !sameBootstrapIdentity(record.original, anchor.record.original) ||
    record.anchorDigest !== anchor.digest || !sameBootstrapIdentity(record.anchorSignature, anchor.signature) || !sameBootstrapIdentity(record.journalIdentity, anchor.record.journalIdentity)) throw bootstrapUnknown();
  return anchor;
}
export function syncBootstrapHomeChain(home: string, check: () => void): void {
  const chain: { path: string; identity: Identity }[] = [];
  for (let path = resolve(home);;) {
    check(); if (chain.length >= 64) throw bootstrapUnknown(); chain.push({ path, identity: bootstrapHomeIdentity(path) });
    const parent = dirname(path); if (parent === path) break; path = parent;
  }
  for (const entry of chain.reverse()) {
    check(); if (!sameBootstrapIdentity(entry.identity, bootstrapHomeIdentity(entry.path))) throw bootstrapUnknown();
    syncBootstrapDirectory(entry.path); check();
  }
  for (const entry of chain) if (!sameBootstrapIdentity(entry.identity, bootstrapHomeIdentity(entry.path))) throw bootstrapUnknown();
}
export function publishBootstrapAnchor(record: BootstrapRecord, check: () => void): BootstrapRecord {
  check(); if (exists(anchorPath(record.home)) || exists(join(record.home, ".store-bootstrap"))) throw bootstrapUnknown();
  syncBootstrapHomeChain(record.home, check); check();
  const dir = join(record.home, ".store-bootstrap"); mkdirSync(dir, { mode: 0o700 }); check(); syncBootstrapDirectory(record.home); check(); syncBootstrapDirectory(dir); check();
  const anchor: Anchor = { version: 1, contract: CONTRACT, attempt: record.attempt, home: record.home, homeIdentity: record.homeIdentity, file: record.file,
    original: record.original, journalIdentity: bootstrapHomeIdentity(dir) };
  const fd = openSync(anchorPath(record.home), "wx", 0o600);
  try { check(); writeFileSync(fd, JSON.stringify(anchor) + "\n"); check(); fsyncSync(fd); } finally { closeSync(fd); }
  check(); syncBootstrapDirectory(record.home); check();
  const evidence = optionalAnchor(record.home)!;
  return { ...record, anchorDigest: evidence.digest, anchorSignature: evidence.signature, journalIdentity: evidence.record.journalIdentity };
}
function parseProvenance(value: unknown): Provenance {
  const v = value;
  if (!object(v) || v.version !== 1 || v.contract !== CONTRACT || !identity(v.homeIdentity) || !identity(v.metadataIdentity) || !uuid(v.generation) ||
    (v.kind !== "ordinary" && v.kind !== "cold") || !strict(v, v.kind === "ordinary" ? ["version", "contract", "homeIdentity", "metadataIdentity", "generation", "kind"] :
    ["version", "contract", "homeIdentity", "metadataIdentity", "generation", "kind", "attempt", "anchorDigest", "anchorSignature", "journalIdentity"]) ||
    v.kind === "cold" && (!uuid(v.attempt) || v.generation !== v.attempt || !digest(v.anchorDigest) || !validSignature(v.anchorSignature) || !identity(v.journalIdentity))) throw bootstrapUnknown();
  return v as Provenance;
}
function storedProvenance(home: string): { version: number; value?: Provenance } {
  const file = join(home, DB_FILE_NAME); if (!exists(file)) return { version: 0 };
  const before = bootstrapFileIdentity(file), db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
  try {
    const version = db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_components'").get() ? Number(db.prepare("SELECT version FROM bridge_components WHERE name='metadata'").get()?.version ?? 0) : 0;
    const raw = db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_metadata'").get() ? db.prepare("SELECT value FROM bridge_metadata WHERE domain='store-bootstrap' AND key='provenance'").get()?.value : undefined;
    if (!sameBootstrapIdentity(before, bootstrapFileIdentity(file))) throw bootstrapUnknown();
    if (raw === undefined) return { version };
    if (!text(raw, 16384)) throw bootstrapUnknown(); return { version, value: parseProvenance(JSON.parse(raw)) };
  } finally { db.close(); }
}
function validateProvenanceIdentity(home: string, value: Provenance) {
  if (!sameBootstrapIdentity(value.homeIdentity, bootstrapHomeIdentity(home)) || !sameBootstrapIdentity(value.metadataIdentity, bootstrapFileIdentity(join(home, DB_FILE_NAME)))) throw bootstrapUnknown();
}
function currentProvenance(home: string): Provenance {
  const base = { version: 1 as const, contract: CONTRACT as typeof CONTRACT, homeIdentity: bootstrapHomeIdentity(home), metadataIdentity: bootstrapFileIdentity(join(home, DB_FILE_NAME)) };
  if (initializer?.home === home) {
    assertBootstrapAccess(home); const anchor = assertRecordAnchor(initializer.evidence.record);
    return { ...base, generation: anchor.record.attempt, kind: "cold", ...coldProof(anchor) };
  }
  if (exists(anchorPath(home)) || exists(join(home, ".store-bootstrap"))) throw bootstrapUnknown();
  return { ...base, generation: randomUUID(), kind: "ordinary" };
}
/** Called only inside the canonical pre-current metadata schema transaction.
 * Normal current-component missing-provenance access refuses before reaching it. */
export function initializeBootstrapProvenance(db: DatabaseSync, home: string, previousVersion: number): void {
  home = physicalPath(resolve(home));
  if (!db.isTransaction || !Number.isSafeInteger(previousVersion) || previousVersion < 0 || previousVersion >= 5 || physicalPath(resolve(db.location("main")!)) !== physicalPath(resolve(join(home, DB_FILE_NAME)))) throw bootstrapUnknown();
  const value = currentProvenance(home);
  db.prepare("INSERT INTO bridge_metadata(domain,key,value,updated_at) VALUES('store-bootstrap','provenance',?,?)").run(JSON.stringify(value), Date.now());
}
export function bindColdBootstrapMetadata(db: DatabaseSync, home: string, check: () => void): void {
  home = physicalPath(resolve(home)); if (initializer?.home !== home) throw bootstrapUnknown();
  check(); const expected = currentProvenance(home), stored = storedProvenance(home); if (stored.version !== 5 || !stored.value) throw bootstrapUnknown();
  validateProvenanceIdentity(home, stored.value);
  if (stored.value.kind === "cold") { if (!sameBootstrapIdentity(expected, stored.value)) throw bootstrapUnknown(); return; }
  db.exec("BEGIN IMMEDIATE");
  try { check(); db.prepare("UPDATE bridge_metadata SET value=?,updated_at=? WHERE domain='store-bootstrap' AND key='provenance'").run(JSON.stringify(expected), Date.now()); check(); db.exec("COMMIT"); }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}
export function captureBootstrapWitness(home: string): BootstrapWitness {
  inspectBootstrapJournal(home); const anchor = optionalAnchor(home); if (!anchor) throw bootstrapUnknown();
  const dir = join(home, ".store-bootstrap"), records = readdirSync(dir).sort().map(name => readBootstrapEvidence(join(dir, name)));
  return { home, anchor, records };
}
export function assertBootstrapWitness(expected: BootstrapWitness | undefined): void {
  if (expected && !sameBootstrapIdentity(captureBootstrapWitness(expected.home), expected)) throw bootstrapUnknown();
}

/** Preservation evidence is not a transferable opener/restore grant: copied
 * files have different identities. The original namespace and proof bytes are
 * retained for a separately admitted offline generation transition. */
export interface BootstrapPreservation {
  metadata: { version: number; value?: Provenance };
  namespace: unknown;
  evidence: { path: string; digest: string }[];
  databases: string[];
}
function preservationMetadata(home: string): Pick<BootstrapPreservation, "metadata" | "namespace"> {
  const metadata = storedProvenance(home), file = join(home, DB_FILE_NAME);
  if (!exists(file)) return { metadata, namespace: null };
  const db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
  try { return { metadata, namespace: db.prepare("SELECT 1 FROM sqlite_master WHERE name='mailbox_store'").get() ? db.prepare("SELECT namespace FROM mailbox_store WHERE id=1").get()?.namespace ?? null : null }; }
  finally { db.close(); }
}
export function captureBootstrapPreservation(home: string): BootstrapPreservation {
  home = physicalPath(resolve(home)); inspectBootstrapJournal(home);
  const metadata = preservationMetadata(home), anchor = optionalAnchor(home);
  const evidence: BootstrapPreservation["evidence"] = [], databases: string[] = [DB_FILE_NAME];
  if (anchor) {
    const witness = captureBootstrapWitness(home);
    const name = anchor.record.file.slice(home.length + 1);
    if (!/^[\w.-]+\.db$/.test(name)) throw bootstrapUnknown();
    if (!databases.includes(name)) databases.push(name);
    evidence.push({ path: ".store-bootstrap.expected.json", digest: witness.anchor.digest });
    for (const record of witness.records) evidence.push({ path: `.store-bootstrap/${record.record.attempt}.${record.record.state}.json`, digest: record.digest });
  }
  return { ...metadata, evidence, databases };
}
export function verifyBootstrapPreservationCopy(home: string, expected: BootstrapPreservation): void {
  // Do not compare the copy's inode to the original: that is precisely why this
  // is preservation verification and full restoration is currently refused.
  if (!sameBootstrapIdentity(preservationMetadata(home), { metadata: expected.metadata, namespace: expected.namespace })) throw bootstrapUnknown();
  for (const file of expected.evidence) if (readRawEvidence(join(home, file.path)).digest !== file.digest) throw bootstrapUnknown();
  for (const name of expected.databases) {
    if (name !== DB_FILE_NAME || expected.metadata.version > 0 || expected.namespace !== null) if (!exists(join(home, name))) throw bootstrapUnknown();
  }
  if (expected.metadata.value?.kind === "cold") {
    const attempt = expected.metadata.value.attempt;
    const paths = [".store-bootstrap.expected.json", ...["preparing", "prepared", "exited"].map(state => `.store-bootstrap/${attempt}.${state}.json`)];
    if (!sameBootstrapIdentity(expected.evidence.map(item => item.path).sort(), paths.sort())) throw bootstrapUnknown();
  } else if (expected.evidence.length) throw bootstrapUnknown();
}
export function assertUnboundFullRestore(home: string): void {
  const refusal = () => Object.assign(new Error("Full restore of provenance-bound or ambiguous storage is unavailable. No files were displaced. Preserve the backup and originals; owner-coordinated isolated offline restore-generation recovery is required."), { code: "STORE_RESTORE_GENERATION_REQUIRED" });
  if (exists(anchorPath(home)) || exists(join(home, ".store-bootstrap"))) throw refusal();
  const file = join(home, DB_FILE_NAME);
  if (!exists(file)) { if (exists(join(home, "archive.db")) || exists(join(home, "history.db"))) throw refusal(); return; }
  // Old or missing provenance does not prove unbound ownership. Only a database
  // with no bridge/mailbox authority at all retains the legacy raw restore path.
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true, timeout: 0 });
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('bridge_components','bridge_metadata','messages','mailbox_store') LIMIT 1").get()) throw refusal();
  } catch { throw refusal(); } finally { db?.close(); }
}
