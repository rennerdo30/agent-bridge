import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
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
 * Keeps the full text in `<home>/quarantine/<id>.txt` and returns its path. Idempotent for the same id and size;
 * a different text under the same id gets its own content-addressed file, so nothing is ever overwritten.
 */
export function quarantineText(home: string, id: string, text: string): string {
  const bytes = Buffer.byteLength(text);
  let file = join(home, QUARANTINE_DIR, `${safeName(id)}.txt`);
  try {
    if (statSync(file).size === bytes) return file;
    file = join(home, QUARANTINE_DIR, `${safeName(id)}-${createHash("sha256").update(text).digest("hex").slice(0, 12)}.txt`);
    if (statSync(file).size === bytes) return file;
  } catch { /* Not written yet. */ }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
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
 * A transport-safe copy of a stored or queued envelope: the same id and routing, with an oversized body replaced by a
 * stub pointing at the full text. The stored original is never modified. Without a home (or if the file cannot be
 * written), the stub points at the record that still holds the full text.
 */
export function quarantineMessage<T extends { id: string; body: string }>(home: string | null | undefined, message: T, fallback = "the bridge store"): T {
  if (!isOversizedBody(message.body)) return message;
  const bytes = Buffer.byteLength(message.body);
  let where = `${fallback} (message ${message.id})`;
  if (home) {
    try { where = quarantineText(home, message.id, message.body); }
    catch { /* Keep the fallback reference: the original is still stored. */ }
  }
  return { ...message, body: oversizedStub(bytes, where) };
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
