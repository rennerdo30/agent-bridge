import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
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

/**
 * Keeps the full text in `<home>/quarantine/<id>-<content hash>.txt` (fsynced, then renamed into place) and returns
 * its path. The name carries the content hash, so an existing file is only reused for the same text, and a different
 * text under the same id never overwrites or aliases another one. Throws if the text could not be written.
 */
export function quarantineText(home: string, id: string, text: string): string {
  const data = Buffer.from(text, "utf8");
  const file = join(home, QUARANTINE_DIR, `${safeName(id)}-${createHash("sha256").update(data).digest("hex").slice(0, 16)}.txt`);
  try { if (statSync(file).size === data.length) return file; } catch { /* Not written yet. */ }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    for (let at = 0; at < data.length;) at += writeSync(fd, data, at);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(tmp, file);
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
