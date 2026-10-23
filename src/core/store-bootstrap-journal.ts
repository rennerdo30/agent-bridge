import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { physicalPath } from "./project-identity.js";

const identitySchema = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^[1-9]\d*$/) }).strict();
const recordSchema = z.object({ version: z.literal(1), attempt: z.uuid(), state: z.enum(["preparing", "prepared", "exited"]),
  contract: z.literal("protocol8-metadata3-schema14-cold-v1"),
  home: z.string().min(1).max(4096), homeIdentity: identitySchema, file: z.string().min(1).max(4096),
  original: z.record(z.string(), identitySchema.nullable()), files: z.record(z.string(), identitySchema).optional(),
  pid: z.number().int().positive(), processIdentity: z.string().min(1).max(256), preparedDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  workerThread: z.number().int().positive().optional(),
  namespace: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export type BootstrapRecord = z.infer<typeof recordSchema>;
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
export const sameBootstrapIdentity = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const bootstrapDigest = (record: BootstrapRecord) => createHash("sha256").update(JSON.stringify(record)).digest("hex");
export function readBootstrapRecord(path: string): BootstrapRecord {
  const before = bootstrapFileIdentity(path), fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > 16384n || stat.size < 2n || String(stat.dev) !== before.dev || String(stat.ino) !== before.ino) throw bootstrapUnknown();
    const bytes = Buffer.alloc(Number(stat.size)); if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw bootstrapUnknown();
    const parsed = recordSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success || !parsed.data.workerThread || !sameBootstrapIdentity(before, bootstrapFileIdentity(path))) throw bootstrapUnknown();
    return parsed.data;
  } catch { throw bootstrapUnknown(); } finally { closeSync(fd); }
}
export function appendBootstrapRecord(record: BootstrapRecord): void {
  recordSchema.parse(record);
  const contents = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(contents) > 16384) throw bootstrapUnknown();
  if (physicalPath(resolve(record.home)) !== record.home || dirname(record.file) !== record.home ||
      !sameBootstrapIdentity(bootstrapHomeIdentity(record.home), record.homeIdentity)) throw bootstrapUnknown();
  const dir = join(record.home, ".store-bootstrap"); mkdirSync(dir, { recursive: true, mode: 0o700 }); bootstrapHomeIdentity(dir);
  const path = join(dir, `${record.attempt}.${record.state}.json`), fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
}
/** The ledger is authoritative evidence, never an absence cache. Incomplete,
 * changed or oversized ledgers block. No original is deleted/reclassified. */
export function inspectBootstrapJournal(home: string): void {
  const dir = join(home, ".store-bootstrap"); let names: string[];
  try { bootstrapHomeIdentity(dir); names = readdirSync(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (names.length > 48 || names.length % 3) throw bootstrapUnknown();
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
    if (!initial || !prepared || !exited || initial.files || initial.namespace || initial.preparedDigest || !prepared.files || !prepared.namespace || prepared.preparedDigest ||
        exited.preparedDigest !== bootstrapDigest(prepared) ||
        !sameBootstrapIdentity(exited.files, prepared.files) || exited.namespace !== prepared.namespace ||
        [prepared, exited].some(item => item.file !== initial.file || item.pid !== initial.pid || item.workerThread !== initial.workerThread || item.processIdentity !== initial.processIdentity || !sameBootstrapIdentity(item.original, initial.original))) throw bootstrapUnknown();
    const expected = [initial.file, join(home, "archive.db"), join(home, "history.db")].sort();
    if (JSON.stringify(Object.keys(initial.original).sort()) !== JSON.stringify(expected) || JSON.stringify(Object.keys(prepared.files).sort()) !== JSON.stringify(expected)) throw bootstrapUnknown();
    for (const [file, identity] of Object.entries(prepared.files)) if (dirname(file) !== home || !sameBootstrapIdentity(identity, bootstrapFileIdentity(file))) throw bootstrapUnknown();
  }
}
