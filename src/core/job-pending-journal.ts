import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord, mergeStoreFields } from "./json-store.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_RECEIPT_BYTES = 32 * 1024 * 1024;
const writerSequences = new Map<string, number>();
export interface PendingJobReceipt {
  path: string;
  digest: string;
  signature: string;
  value: { schemaVersion: 1; writer: { name: string; session: string | null; nonce: string }; sequence: number; recordedAt: number; job: Record<string, unknown>; baseJob?: Record<string, unknown> };
}
const parsed = new Map<string, { signature: string; receipt: PendingJobReceipt | null; bytes: number }>();
const indexes = new Map<string, { signature: string; value: Record<string, unknown> }>();
let cachedBytes = 0;
function cache(path: string, statSignature: string, receipt: PendingJobReceipt | null): void {
  const bytes = receipt ? Buffer.byteLength(JSON.stringify(receipt.value)) : 0;
  cachedBytes -= parsed.get(path)?.bytes ?? 0;
  if (bytes > MAX_RECEIPT_BYTES) { parsed.delete(path); return; }
  parsed.delete(path); parsed.set(path, { signature: statSignature, receipt, bytes }); cachedBytes += bytes;
  while (parsed.size > 512 || cachedBytes > 64 * 1024 * 1024) {
    const first = parsed.keys().next().value!; cachedBytes -= parsed.get(first)!.bytes; parsed.delete(first);
  }
}
const failure = (message: string) => Object.assign(new Error(message), { code: "EJOBRECEIPT" });

/** Include dangling links: existsSync would incorrectly skip those. */
function physical(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw failure("pending job receipt path is not physical");
}
function ancestors(path: string): void {
  for (let at = resolve(path);;) {
    try { physical(at, true); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(at); if (parent === at) return; at = parent;
  }
}
export function pendingJobRoot(store: string): string { return join(dirname(store), "pending-job-writes", "v1"); }
function digest(bytes: string): string { return createHash("sha256").update(bytes).digest("hex"); }
function immutable<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function detached<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function signature(path: string): string {
  physical(path, false); const stat = lstatSync(path);
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`;
}
/** Bind the descriptor to the witnessed physical file before reading any bytes. */
function readPhysical(path: string, witnessed: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd), bound = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`;
    if (!stat.isFile() || bound !== witnessed || stat.size > MAX_RECEIPT_BYTES) throw failure("pending job receipt physical identity changed");
    const bytes = readFileSync(fd, "utf8");
    ancestors(dirname(path)); if (signature(path) !== witnessed) throw failure("pending job receipt changed during read");
    return bytes;
  } finally { closeSync(fd); }
}

/** Independent versioned namespace: old readers' shared JSON bytes stay untouched. */
export function retainPendingJob(store: string, writer: PendingJobReceipt["value"]["writer"], job: Record<string, unknown>, baseJob?: Record<string, unknown>): PendingJobReceipt {
  const root = pendingJobRoot(store); ancestors(root); mkdirSync(root, { recursive: true }); physical(root, true);
  const dir = join(root, randomUUID()); mkdirSync(dir); physical(dir, true);
  const sequence = (writerSequences.get(writer.nonce) ?? 0) + 1; writerSequences.set(writer.nonce, sequence);
  const value: PendingJobReceipt["value"] = { schemaVersion: 1, writer, sequence, recordedAt: Date.now(), job, baseJob };
  // Retention is never size-limited: oversized accepted context is still
  // durable, even when bounded automatic recovery must leave it for inspection.
  const bytes = JSON.stringify(value);
  const partial = join(dir, "receipt.partial"), path = join(dir, "receipt.json");
  const index = { schemaVersion: 1, writerName: writer.name, owner: job.owner, parentJob: job.parentJob,
    handoff: Array.isArray(job.ownershipHistory) ? job.ownershipHistory.at(-1) : undefined };
  const indexFd = openSync(join(dir, "writer.json"), "wx");
  try { writeFileSync(indexFd, JSON.stringify(index)); fsyncSync(indexFd); } finally { closeSync(indexFd); }
  const fd = openSync(partial, "wx");
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  // Exclusive hard-link publication cannot overwrite a raced destination.
  // The complete partial is retained, and archived with the original receipt.
  physical(dir, true); physical(partial, false); linkSync(partial, path);
  const receipt = immutable({ path, signature: signature(path), digest: digest(bytes), value: JSON.parse(bytes) as PendingJobReceipt["value"] });
  cache(path, receipt.signature, receipt); return receipt;
}

/** Unknown versions, partial writes and damaged records remain untouched. */
export function readPendingJobs(store: string, warn?: (error: unknown) => void, accept?: (index: Record<string, unknown>) => boolean, readBudget = MAX_RECEIPT_BYTES): PendingJobReceipt[] {
  const root = pendingJobRoot(store), result: PendingJobReceipt[] = [];
  try { ancestors(root); physical(root, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn?.(error); return result; }
  for (const name of readdirSync(root)) {
    if (!UUID.test(name)) continue;
    const path = join(root, name, "receipt.json");
    try {
      physical(dirname(path), true); physical(path, false);
      if (accept) {
        const indexPath = join(dirname(path), "writer.json"), indexSignature = signature(indexPath);
        let indexed = indexes.get(indexPath);
        if (indexed?.signature !== indexSignature) {
          if (lstatSync(indexPath).size > 4096) throw failure("pending job receipt index exceeds supported size");
          const value: unknown = JSON.parse(readPhysical(indexPath, indexSignature));
          if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.writerName !== "string") continue;
          indexed = { signature: indexSignature, value }; indexes.set(indexPath, indexed);
          if (indexes.size > 4096) indexes.delete(indexes.keys().next().value!);
        }
        if (!accept(indexed.value)) continue;
      }
      const statSignature = signature(path), cached = parsed.get(path);
      if (lstatSync(path).size > readBudget) throw failure("pending job receipt exceeds automatic recovery budget; bytes retained for manual recovery");
      if (cached?.signature === statSignature) { if (cached.receipt) result.push(cached.receipt); continue; }
      const bytes = readPhysical(path, statSignature), value: unknown = JSON.parse(bytes);
      if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.writer) || typeof value.writer.name !== "string" ||
          typeof value.writer.nonce !== "string" || !UUID.test(value.writer.nonce) || typeof value.recordedAt !== "number" ||
          !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 ||
          !isRecord(value.job) || typeof value.job.id !== "string" || typeof value.job.name !== "string" ||
          value.baseJob !== undefined && !isRecord(value.baseJob)) { cache(path, statSignature, null); continue; }
      const receipt = immutable({ path, signature: statSignature, digest: digest(bytes), value: value as unknown as PendingJobReceipt["value"] });
      cache(path, statSignature, receipt); result.push(receipt);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn?.(error); }
  }
  return result.sort((a, b) => a.value.writer.nonce === b.value.writer.nonce
    ? a.value.sequence - b.value.sequence
    : a.value.recordedAt - b.value.recordedAt || a.path.localeCompare(b.path));
}

const AUTHORITY = ["owner", "supervisor", "rootSession", "rootName", "parentJob", "ownershipHistory", "executionOwner"];
const final = (job: Record<string, unknown>) => job.status === "done" || job.status === "failed" || job.status === "cancelled";
/** Refuse stale authority/turn/metadata. Final durable state wins over running receipts. */
export function mergePendingJob(current: Record<string, unknown> | undefined, receipt: Record<string, unknown>, base?: Record<string, unknown>): Record<string, unknown> | null {
  if (!current) return detached(receipt);
  if (AUTHORITY.some(key => !isDeepStrictEqual(current[key], receipt[key])) ||
      Number(current.startedAt ?? 0) > Number(receipt.startedAt ?? 0) ||
      Number(current.metadataVersion ?? 0) > Number(receipt.metadataVersion ?? 0) ||
      current.startedAt === receipt.startedAt && final(current) && !final(receipt)) return null;
  if (Number(receipt.startedAt ?? 0) > Number(current.startedAt ?? 0)) return detached(mergeStoreFields(current, receipt));
  // Same-turn receipts are a three-way patch, never a replacement of later
  // durable settings, queues, forwarded messages or terminal status.
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(receipt)) {
    if (key === "deliveryHistory") {
      const envelopes = Array.isArray(current[key]) ? [...current[key]] : [];
      for (const message of Array.isArray(value) ? value : []) if (!envelopes.some(old => isDeepStrictEqual(old, message))) envelopes.push(message);
      merged[key] = envelopes; continue;
    }
    if (final(current) && ["status", "finishedAt", "sessionId", "host"].includes(key)) continue;
    if (base && isDeepStrictEqual(current[key], base[key])) merged[key] = value;
    else if (!(key in current)) merged[key] = value;
  }
  return detached(merged);
}

function contains(current: unknown, expected: unknown): boolean {
  if (isRecord(expected) && isRecord(current)) return Object.entries(expected).every(([key, value]) => contains(current[key], value));
  return isDeepStrictEqual(current, expected);
}
/** Archive only after the exact retained bytes are represented by verified durable state. */
export function archivePendingJob(receipt: PendingJobReceipt, durable: Record<string, unknown>): boolean {
  const original = receipt.value.job;
  const incorporated = contains(durable, original);
  const superseded = durable.id === original.id && !AUTHORITY.some(key => !isDeepStrictEqual(durable[key], original[key])) &&
    Number(durable.startedAt ?? 0) >= Number(original.startedAt ?? 0) && Number(durable.metadataVersion ?? 0) >= Number(original.metadataVersion ?? 0) &&
    (Number(durable.startedAt ?? 0) > Number(original.startedAt ?? 0) || final(durable)) &&
    (Array.isArray(original.deliveryHistory) ? original.deliveryHistory : []).every(message =>
      Array.isArray(durable.deliveryHistory) && durable.deliveryHistory.some(saved => isDeepStrictEqual(saved, message)));
  if (!incorporated && !superseded) return false;
  ancestors(dirname(receipt.path)); physical(receipt.path, false);
  // Published bytes were fsynced and hashed once. Never reread complete receipt
  // payloads on job request/timer paths; a changed physical signature fails closed.
  if (signature(receipt.path) !== receipt.signature) throw failure("pending job receipt verification failed; retained");
  const archive = join(dirname(dirname(receipt.path)), "archive"); ancestors(archive); mkdirSync(archive, { recursive: true }); physical(archive, true);
  const source = dirname(receipt.path), target = join(archive, randomUUID());
  const fd = openSync(join(source, "verification.json"), "wx");
  try {
    writeFileSync(fd, JSON.stringify({ schemaVersion: 1, kind: incorporated ? "incorporated" : "superseded", receiptSha256: receipt.digest,
      durableJobSha256: digest(JSON.stringify(durable)), jobId: durable.id, startedAt: durable.startedAt, status: durable.status, verifiedAt: Date.now(),
      retainedOnlyFields: Object.keys(original).filter(key => !contains(durable[key], original[key])),
      retainedOnlyDataExecuted: false })); fsyncSync(fd);
  } finally { closeSync(fd); }
  // Renaming the complete nonempty directory preserves original/partial bytes;
  // an occupied nonempty target cannot be replaced by directory rename.
  renameSync(source, target); cache(receipt.path, receipt.signature, null); return true;
}
