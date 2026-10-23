import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { physicalPath } from "./project-identity.js";
import { isDeepStrictEqual } from "node:util";

const identitySchema = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^[1-9]\d*$/) }).strict();
const signatureSchema = z.object({ dev: z.string(), ino: z.string(), size: z.string(), mtime: z.string(), ctime: z.string() }).strict();
const recordSchema = z.object({ version: z.literal(1), attempt: z.uuid(), state: z.enum(["preparing", "prepared", "exited"]),
  contract: z.literal("protocol9-metadata4-schema14-cold-v2"),
  home: z.string().min(1).max(4096), homeIdentity: identitySchema, file: z.string().min(1).max(4096),
  original: z.record(z.string(), identitySchema.nullable()), files: z.record(z.string(), identitySchema).optional(),
  pid: z.number().int().positive(), processIdentity: z.string().min(1).max(256), preparedDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  workerThread: z.number().int().positive().optional(),
  preparingDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), preparingSignature: signatureSchema.optional(),
  namespace: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export type BootstrapRecord = z.infer<typeof recordSchema>;
export type BootstrapEvidence = { record: BootstrapRecord; digest: string; signature: z.infer<typeof signatureSchema> };
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
export function readBootstrapEvidence(path: string): BootstrapEvidence {
  const before = bootstrapFileIdentity(path), fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > 16384n || stat.size < 2n || String(stat.dev) !== before.dev || String(stat.ino) !== before.ino) throw bootstrapUnknown();
    const initial = signature(stat);
    if (!sameBootstrapIdentity(initial, signature(lstatSync(path, { bigint: true })))) throw bootstrapUnknown();
    const bytes = Buffer.alloc(Number(stat.size)); if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw bootstrapUnknown();
    const parsed = recordSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success || !parsed.data.workerThread || !sameBootstrapIdentity(initial, signature(fstatSync(fd, { bigint: true }))) ||
        !sameBootstrapIdentity(initial, signature(lstatSync(path, { bigint: true })))) throw bootstrapUnknown();
    return { record: parsed.data, signature: initial, digest: createHash("sha256").update(bytes).digest("hex") };
  } catch { throw bootstrapUnknown(); } finally { closeSync(fd); }
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
export function appendBootstrapRecord(record: BootstrapRecord): void {
  recordSchema.parse(record);
  const contents = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(contents) > 16384) throw bootstrapUnknown();
  if (physicalPath(resolve(record.home)) !== record.home || dirname(record.file) !== record.home ||
      !sameBootstrapIdentity(bootstrapHomeIdentity(record.home), record.homeIdentity)) throw bootstrapUnknown();
  syncBootstrapDirectory(record.home); // Probe before creating even the journal directory.
  const dir = join(record.home, ".store-bootstrap"); mkdirSync(dir, { recursive: true, mode: 0o700 }); bootstrapHomeIdentity(dir);
  syncBootstrapDirectory(dir); syncBootstrapDirectory(record.home);
  const path = join(dir, `${record.attempt}.${record.state}.json`), fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
  syncBootstrapDirectory(dir); syncBootstrapDirectory(record.home);
}
export function readBootstrapPair(home: string, attempt: string): { initial: BootstrapEvidence; prepared: BootstrapEvidence } {
  const dir = join(home, ".store-bootstrap"), initial = readBootstrapEvidence(join(dir, `${attempt}.preparing.json`)), prepared = readBootstrapEvidence(join(dir, `${attempt}.prepared.json`));
  const a = initial.record, b = prepared.record;
  if (a.home !== home || b.home !== home || a.attempt !== attempt || b.attempt !== attempt || a.state !== "preparing" || b.state !== "prepared" ||
      a.files || a.namespace || a.preparedDigest || a.preparingDigest || a.preparingSignature || !b.files || !b.namespace || b.preparedDigest ||
      b.preparingDigest !== initial.digest || !sameBootstrapIdentity(b.preparingSignature, initial.signature) ||
      b.file !== a.file || b.pid !== a.pid || b.workerThread !== a.workerThread || b.processIdentity !== a.processIdentity ||
      !sameBootstrapIdentity(a.homeIdentity, bootstrapHomeIdentity(home)) || !sameBootstrapIdentity(b.homeIdentity, a.homeIdentity) || !sameBootstrapIdentity(b.original, a.original)) throw bootstrapUnknown();
  const expected = [a.file, join(home, "archive.db"), join(home, "history.db")].sort();
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
  try { bootstrapHomeIdentity(dir); names = readdirSync(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
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
    if (!initial || !prepared || !exited) throw bootstrapUnknown();
    const pair = readBootstrapPair(home, initial.attempt);
    if (exited.preparedDigest !== pair.prepared.digest || exited.preparingDigest !== prepared.preparingDigest || !sameBootstrapIdentity(exited.preparingSignature, prepared.preparingSignature) ||
        !sameBootstrapIdentity(exited.files, prepared.files) || exited.namespace !== prepared.namespace ||
        [prepared, exited].some(item => item.file !== initial.file || item.pid !== initial.pid || item.workerThread !== initial.workerThread || item.processIdentity !== initial.processIdentity || !sameBootstrapIdentity(item.original, initial.original))) throw bootstrapUnknown();
    const expected = [initial.file, join(home, "archive.db"), join(home, "history.db")].sort();
    if (JSON.stringify(Object.keys(initial.original).sort()) !== JSON.stringify(expected) || JSON.stringify(Object.keys(prepared.files).sort()) !== JSON.stringify(expected)) throw bootstrapUnknown();
    for (const [file, identity] of Object.entries(prepared.files)) if (dirname(file) !== home || !sameBootstrapIdentity(identity, bootstrapFileIdentity(file))) throw bootstrapUnknown();
  }
}
