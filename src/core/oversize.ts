import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { open, link } from "node:fs/promises";
import { MAX_BODY_CHARS } from "./constants.js";

/** Directory under the bridge home holding full texts that were too large to send (AB-380). */
export const QUARANTINE_DIR = "quarantine";

/** Room kept below MAX_BODY_CHARS for notes appended after a report was capped. */
const REPORT_HEADROOM_CHARS = 4_096;

/** Longest report body: the rest goes to a file under the bridge home. */
export const MAX_REPORT_CHARS = MAX_BODY_CHARS - REPORT_HEADROOM_CHARS;

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "message";
}

/** Only private attempt files computed below, never a published evidence record. */
function discardTemporary(tmp: string, owned: Stats): void {
  try { const current = lstatSync(tmp); if (current.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(tmp); } catch { /* Changed or already gone: preserve. */ }
}

const unsafe = () => new Error("Quarantine evidence path/content ownership is unproven; original data preserved");
const identity = (s: Stats) => `${s.dev}:${s.ino}:${s.birthtimeMs}:${s.ctimeMs}:${s.mtimeMs}:${s.size}`;
function physicalDirectories(path: string): string[] {
  const observed: string[] = [];
  for (let at = resolve(path);;) {
    const s = lstatSync(at);
    if (!s.isDirectory() || s.isSymbolicLink()) throw unsafe();
    observed.push(`${at}:${s.dev}:${s.ino}:${s.birthtimeMs}`);
    const parent = dirname(at); if (parent === at) return observed;
    at = parent;
  }
}
function regular(path: string, bytes: number): Stats {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size !== bytes ||
    process.getuid && (s.uid !== process.getuid() || (s.mode & 0o077) !== 0)) throw unsafe();
  return s;
}
function verify(path: string, data: Buffer, admittedDirectories?: string[]): void {
  const dirs = physicalDirectories(dirname(path)), before = regular(path, data.length);
  if (admittedDirectories && JSON.stringify(dirs) !== JSON.stringify(admittedDirectories)) throw unsafe();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (identity(fstatSync(fd)) !== identity(before)) throw unsafe();
    const bytes = Buffer.alloc(data.length), tail = Buffer.alloc(1);
    for (let at = 0; at < bytes.length;) { const n = readSync(fd, bytes, at, bytes.length - at, at); if (!n) throw unsafe(); at += n; }
    if (readSync(fd, tail, 0, 1, data.length) || !bytes.equals(data) || identity(fstatSync(fd)) !== identity(before)) throw unsafe();
  } finally { closeSync(fd); }
  if (identity(regular(path, data.length)) !== identity(before) || JSON.stringify(physicalDirectories(dirname(path))) !== JSON.stringify(dirs)) throw unsafe();
}
function existsVerified(file: string, data: Buffer): boolean {
  try { lstatSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  verify(file, data); return true;
}
function prepareDirectory(home: string): string {
  physicalDirectories(home);
  const dir = join(home, QUARANTINE_DIR);
  try { physicalDirectories(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; mkdirSync(dir, { mode: 0o700 }); }
  physicalDirectories(dir); return dir;
}

/**
 * Keeps the full text in `<home>/quarantine/<id>-<content hash>.txt` (fsynced, then exclusively linked into place) and returns
 * its path. The name carries the content hash, so an existing file is only reused for the same text, and a different
 * text under the same id never overwrites or aliases another one. Throws if the text could not be written.
 */
export function quarantineText(home: string, id: string, text: string): string {
  const data = Buffer.from(text, "utf8");
  const file = join(prepareDirectory(home), `${safeName(id)}-${createHash("sha256").update(data).digest("hex").slice(0, 16)}.txt`);
  const admittedDirectories = physicalDirectories(dirname(file));
  if (existsVerified(file, data)) return file;
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  const owned = fstatSync(fd);
  try {
    try {
      for (let at = 0; at < data.length;) at += writeSync(fd, data, at);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    physicalDirectories(dirname(file));
    try { linkSync(tmp, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    discardTemporary(tmp, owned);
    verify(file, data, admittedDirectories);
  } catch (err) {
    // A failed attempt must not leave a partial copy behind: each retry uses a fresh temp name.
    discardTemporary(tmp, owned);
    throw err;
  }
  return file;
}

/** Awaited retention for runner queues. A failed/suspended fsync never confirms the item. */
export async function quarantineTextAsync(home: string, id: string, text: string, confirm?: () => void): Promise<string> {
  const data = Buffer.from(text, "utf8");
  const dir = prepareDirectory(home);
  const admittedDirectories = physicalDirectories(dir);
  const file = join(dir, `${safeName(id)}-${createHash("sha256").update(data).digest("hex").slice(0, 16)}.txt`);
  if (existsVerified(file, data)) { confirm?.(); return file; }
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  const owned = await handle.stat();
  try {
    try { await handle.writeFile(data); await handle.sync(); }
    finally { await handle.close(); }
    physicalDirectories(dir);
    try { await link(tmp, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    discardTemporary(tmp, owned);
    // No await between descriptor/content/path validation and confirmation.
    verify(file, data, admittedDirectories); confirm?.();
  } catch (error) {
    discardTemporary(tmp, owned);
    throw error;
  }
  return file;
}

/** Whether a message body is larger than any sender may send (and so can never be delivered as it is). */
export function isOversizedBody(body: unknown): body is string {
  return typeof body === "string" && body.length > MAX_BODY_CHARS;
}

/** The stub that replaces an oversized body in transit. */
export function oversizedStub(bytes: number, where: string): string {
  return `Report too large (${bytes} bytes); full text at ${where}`;
}

/**
 * A transport-safe copy of an envelope: the same id and routing, with an oversized body replaced by a stub pointing at
 * its full text. The original is never modified.
 *
 * `retainedAt` names where the caller still durably holds the original (e.g. "jobs.json"); only then may the stub point
 * there when the file cannot be written. Without it, the stub is used only once the full text is confirmed written to
 * a file; otherwise the original is returned unchanged, so a stub is never the only stored copy.
 */
export function quarantineMessage<T extends { id: string; body: string }>(home: string | null | undefined, message: T, retainedAt?: string): T {
  if (!isOversizedBody(message.body)) return message;
  const bytes = Buffer.byteLength(message.body);
  let where: string | undefined;
  if (home) {
    try { where = quarantineText(home, message.id, message.body); }
    catch { /* Fall back below. */ }
  }
  where ??= retainedAt ? `${retainedAt} (message ${message.id})` : undefined;
  return where ? { ...message, body: oversizedStub(bytes, where) } : message;
}

/** Caps a report at MAX_REPORT_CHARS; the full text is kept in a file under the bridge home and named in the body. */
export function capReport(home: string, text: string, max: number = MAX_REPORT_CHARS): string {
  if (text.length <= max) return text;
  let file: string;
  try { file = quarantineText(home, `report-${Date.now()}-${randomUUID()}`, text); }
  catch { return text; } // Never truncate without a copy; transport stubs it later if it must.
  const note = `\n\n[Report truncated: the full text is ${Buffer.byteLength(text)} bytes; full text at ${file}]`;
  let head = text.slice(0, Math.max(0, max - note.length));
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head + note;
}
